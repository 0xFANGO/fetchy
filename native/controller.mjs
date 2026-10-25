import {EventEmitter} from 'node:events';
import {realpath, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {downloadVideo, resolveVideo} from '../src/index.mjs';
import {runProcess} from '../src/process.mjs';
import {bridgeError, publicError} from './errors.mjs';
import {
	dataDirectory,
	defaultOutputDirectory,
	privateDirectory,
	readJson,
	validateDirectory,
	writeJson,
} from './settings.mjs';

const active = (task) => ['running', 'cancelling'].includes(task?.status);
const boundedString = (value, max = 4096) => (typeof value === 'string' ? value.slice(0, max) : '');
const finite = (value) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const clone = (value) => structuredClone(value);
export function publicMetadata(media) {
	let thumbnailUrl = null;
	try {
		const url = new URL(media?.thumbnailUrl);
		if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 8192)
			thumbnailUrl = url.href;
	} catch {}
	return {
		platform: boundedString(media?.platform, 32),
		id: boundedString(media?.id, 128),
		title: boundedString(media?.title, 1000) || '未命名视频',
		durationSeconds: finite(media?.durationSeconds),
		thumbnailUrl,
		engine: ['browser', 'yt-dlp'].includes(media?.engine) ? media.engine : null,
		availability: media?.availability === 'ready' ? 'ready' : undefined,
		formats: Array.isArray(media?.formats)
			? media.formats.slice(0, 128).map((format) => ({
					width: finite(format.width),
					height: finite(format.height),
					fps: finite(format.fps),
					hasVideo: format.hasVideo === true,
					hasAudio: format.hasAudio === true,
				}))
			: [],
	};
}
function persistedTask(task) {
	if (!task) return null;
	// Input and image URLs may carry access credentials. Only identity/numeric
	// display metadata survives restart; the successful filepath necessarily
	// includes the cleaned video title used by the core's filename publisher.
	const {input, metadata, ...safe} = task;
	return {
		...safe,
		metadata: metadata
			? {
					platform: metadata.platform,
					id: metadata.id,
					durationSeconds: metadata.durationSeconds,
					engine: metadata.engine,
					title: '未命名视频',
					thumbnailUrl: null,
				}
			: null,
	};
}
function checkedInput(input) {
	if (typeof input !== 'string' || !input.trim() || input.length > 16384 || input.includes('\0'))
		throw bridgeError('invalid_url');
	return input.trim();
}
function checkedPageMedia(value) {
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw bridgeError('invalid_request');
	if (!value.media || typeof value.media !== 'object' || Array.isArray(value.media))
		throw bridgeError('invalid_request');
	if (JSON.stringify(value).length > 256 * 1024) throw bridgeError('invalid_request');
	return value;
}
function checkedId(id) {
	if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) throw bridgeError('invalid_request');
	return id;
}
export class NativeController extends EventEmitter {
	constructor(options = {}) {
		super();
		this.directory = options.directory ?? dataDirectory();
		this.defaultDirectory = options.defaultDirectory ?? defaultOutputDirectory();
		this.core = options.core ?? {resolveVideo, downloadVideo};
		this.execute = options.runProcess ?? runProcess;
		this.engineOptions = options.engineOptions ?? {};
		this.settings = {outputDir: this.defaultDirectory};
		this.task = null;
		// Signed media URLs extracted by the extension live here only; they are
		// never part of a snapshot or the persisted state file.
		this.taskPageMedia = null;
		this.pendingDirectory = null;
		this.choosingDirectory = false;
		this.resolvers = new Map();
		this.resolved = new Map();
		this.recentTaskIds = [];
		this.persistence = Promise.resolve();
		this.downloadPromise = null;
		this.controller = null;
		this.pickerController = null;
		this.pickerPromise = null;
	}
	async initialize() {
		await privateDirectory(this.directory);
		const saved = await readJson(path.join(this.directory, 'state.json'), {});
		if (typeof saved.settings?.outputDir === 'string' && path.isAbsolute(saved.settings.outputDir))
			this.settings.outputDir = saved.settings.outputDir;
		if (typeof saved.pendingDirectory === 'string' && path.isAbsolute(saved.pendingDirectory))
			this.pendingDirectory = saved.pendingDirectory;
		this.recentTaskIds = Array.isArray(saved.recentTaskIds)
			? saved.recentTaskIds.filter((id) => typeof id === 'string').slice(-64)
			: [];
		if (
			saved.task?.id &&
			['running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
				saved.task.status,
			)
		) {
			this.task = saved.task;
			if (active(this.task)) {
				this.task.status = 'interrupted';
				this.task.error = publicError(bridgeError('interrupted'));
				this.task.unread = true;
				this.task.updatedAt = Date.now();
			}
		}
		await this.persist();
		return this;
	}
	snapshot() {
		return clone({
			task: this.task,
			settings: this.settings,
			pendingDirectory: this.pendingDirectory,
			choosingDirectory: this.choosingDirectory,
		});
	}
	persist() {
		const value = clone({
			settings: this.settings,
			pendingDirectory: this.pendingDirectory,
			task: persistedTask(this.task),
			recentTaskIds: this.recentTaskIds,
		});
		this.persistence = this.persistence
			.catch(() => {})
			.then(() => writeJson(path.join(this.directory, 'state.json'), value));
		return this.persistence;
	}
	broadcast() {
		this.emit('state', this.snapshot());
	}
	async changed() {
		await this.persist();
		this.broadcast();
	}
	async dependencies() {
		const localYtDlp = fileURLToPath(new URL('../.venv/bin/yt-dlp', import.meta.url));
		const commands = {
			ytDlp: [
				this.engineOptions.ytDlpPath ?? (existsSync(localYtDlp) ? localYtDlp : 'yt-dlp'),
				['--version'],
			],
			ffmpeg: [this.engineOptions.ffmpegLocation ?? 'ffmpeg', ['-version']],
			ffprobe: [this.engineOptions.ffprobePath ?? 'ffprobe', ['-version']],
		};
		const checks = await Promise.all(
			Object.entries(commands).map(async ([name, [command, args]]) => {
				try {
					const result = await this.execute(command, args, {
						timeoutMs: 4000,
						maxOutputBytes: 65536,
					});
					return [name, {available: result.code === 0}];
				} catch {
					return [name, {available: false}];
				}
			}),
		);
		return {
			node: {
				available: Number(process.versions.node.split('.')[0]) >= 22,
				version: process.versions.node,
			},
			...Object.fromEntries(checks),
		};
	}
	async request(method, params = {}) {
		if (!params || typeof params !== 'object' || Array.isArray(params))
			throw bridgeError('invalid_request');
		switch (method) {
			case 'hello':
				return {
					version: '0.1.0',
					protocolVersion: 1,
					dependencies: await this.dependencies(),
					state: this.snapshot(),
				};
			case 'getState':
				return this.snapshot();
			case 'getSettings':
				return clone(this.settings);
			case 'resolve':
				return this.resolve(params);
			case 'cancelResolve': {
				const id = checkedId(params.requestId);
				this.resolvers.get(id)?.abort();
				return {cancelled: true};
			}
			case 'start':
				return this.start(params);
			case 'cancel':
				return this.cancel(params);
			case 'chooseDirectory':
				return this.chooseDirectory();
			case 'saveSettings':
				return this.saveSettings(params);
			case 'reveal':
				return this.reveal(params);
			case 'acknowledge': {
				if (this.task?.id !== params.taskId) throw bridgeError('task_not_found');
				this.task.unread = false;
				await this.changed();
				return this.snapshot();
			}
			default:
				throw bridgeError('invalid_request');
		}
	}
	async resolve({input, requestId, pageMedia}) {
		input = checkedInput(input);
		requestId = checkedId(requestId);
		pageMedia = checkedPageMedia(pageMedia);
		this.resolvers.get(requestId)?.abort();
		const controller = new AbortController();
		this.resolvers.set(requestId, controller);
		try {
			const metadata = publicMetadata(
				await this.core.resolveVideo(input, {
					...this.engineOptions,
					pageMedia,
					signal: controller.signal,
				}),
			);
			if (controller.signal.aborted) throw bridgeError('cancelled');
			this.resolved.set(input, metadata);
			while (this.resolved.size > 1) this.resolved.delete(this.resolved.keys().next().value);
			return metadata;
		} finally {
			if (this.resolvers.get(requestId) === controller) this.resolvers.delete(requestId);
		}
	}
	async start({input, taskId, metadata, pageMedia}) {
		taskId = checkedId(taskId);
		input = checkedInput(input);
		pageMedia = checkedPageMedia(pageMedia);
		if (this.task?.id === taskId) return this.snapshot();
		if (this.recentTaskIds.includes(taskId)) throw bridgeError('task_already_finished');
		if (active(this.task)) throw bridgeError('task_busy');
		this.controller = new AbortController();
		const controller = this.controller;
		const task = (this.task = {
			id: taskId,
			input,
			metadata: this.resolved.get(input) ?? publicMetadata(metadata),
			status: 'running',
			stage: 'resolving',
			result: null,
			error: null,
			outputDir: this.settings.outputDir,
			unread: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		this.taskPageMedia = pageMedia ?? null;
		this.recentTaskIds = [...this.recentTaskIds, taskId].slice(-64);
		// Reserve before any await: concurrent start requests cannot launch two jobs.
		try {
			await this.changed();
			task.outputDir = await validateDirectory(task.outputDir, {
				createDefault: true,
				defaultDirectory: this.defaultDirectory,
			});
			if (controller.signal.aborted) throw bridgeError('cancelled');
		} catch (error) {
			task.status = controller.signal.aborted ? 'cancelled' : 'failed';
			task.error = publicError(error);
			task.updatedAt = Date.now();
			await this.changed();
			return this.snapshot();
		}
		this.downloadPromise = this.download(task, controller);
		return this.snapshot();
	}
	async download(task, controller) {
		try {
			const result = await this.core.downloadVideo(task.input, {
				...this.engineOptions,
				pageMedia: this.taskPageMedia ?? undefined,
				outputDir: task.outputDir,
				signal: controller.signal,
				onProgress: ({stage, bytes, totalBytes}) => {
					if (
						!active(task) ||
						!['resolving', 'downloading', 'postprocessing', 'validating', 'retrying'].includes(
							stage,
						)
					)
						return;
					task.stage = stage;
					task.updatedAt = Date.now();
					task.progress =
						Number.isFinite(bytes) &&
						bytes >= 0 &&
						Number.isFinite(totalBytes) &&
						totalBytes > 0 &&
						bytes <= totalBytes
							? {downloadedBytes: bytes, totalBytes}
							: null;
					this.broadcast();
				},
			});
			if (
				!result?.filepath ||
				!path.isAbsolute(result.filepath) ||
				!Number.isFinite(result.bytes) ||
				result.bytes <= 0 ||
				result.validation?.video !== true ||
				!(result.validation.durationSeconds > 0)
			)
				throw bridgeError('output_invalid');
			let root, filepath, info;
			try {
				root = await realpath(task.outputDir);
				filepath = await realpath(result.filepath);
				info = await stat(filepath);
			} catch {
				throw bridgeError('output_invalid');
			}
			const relative = path.relative(root, filepath);
			if (
				!relative ||
				relative.startsWith('..' + path.sep) ||
				relative === '..' ||
				path.isAbsolute(relative) ||
				!info.isFile() ||
				info.size !== result.bytes
			)
				throw bridgeError('output_invalid');
			task.result = {
				filepath,
				bytes: info.size,
				platform: boundedString(result.platform, 32),
				id: boundedString(result.id, 128),
				validation: {
					video: true,
					audio: result.validation.audio === true,
					durationSeconds: finite(result.validation.durationSeconds),
					width: finite(result.validation.width),
					height: finite(result.validation.height),
					method: result.validation.method === 'ffprobe' ? 'ffprobe' : 'core',
					fullDecode: result.validation.fullDecode === true,
				},
			};
			// A fully validated file returned by the core wins a late cancel request.
			// Never delete an already successful output merely because cancellation
			// arrived while the bridge was checking stat/realpath after core completion.
			task.status = 'completed';
			task.stage = 'complete';
			task.error = null;
		} catch (error) {
			task.status =
				controller.signal.aborted || error.code === 'cancelled' ? 'cancelled' : 'failed';
			task.error = publicError(task.status === 'cancelled' ? bridgeError('cancelled') : error);
		} finally {
			this.taskPageMedia = null;
			task.updatedAt = Date.now();
			task.unread = true;
			task.progress = null;
			await this.changed().catch(() => {
				this.broadcast();
			});
		}
	}
	async cancel({taskId}) {
		if (this.task?.id !== taskId) throw bridgeError('task_not_found');
		if (active(this.task)) {
			this.task.status = 'cancelling';
			this.task.updatedAt = Date.now();
			this.controller?.abort();
			await this.changed();
		}
		return this.snapshot();
	}
	chooseDirectory() {
		if (this.choosingDirectory) return Promise.resolve(this.snapshot());
		const controller = (this.pickerController = new AbortController());
		this.choosingDirectory = true;
		this.broadcast();
		this.pickerPromise = this.pickDirectory(controller);
		return this.pickerPromise;
	}
	async pickDirectory(controller) {
		try {
			// Script text is constant; no filename or page text becomes AppleScript.
			// A detached native daemon has no foreground app. Standard Additions'
			// activation makes its chooser visible without System Events automation.
			const result = await this.execute(
				'/usr/bin/osascript',
				[
					'-e',
					'activate\ntry\nset selectedFolder to choose folder with prompt "选择 Fetchy 视频保存文件夹"\nreturn POSIX path of selectedFolder\non error number -128\nreturn ""\nend try',
				],
				{signal: controller.signal, timeoutMs: 300000, maxOutputBytes: 16384},
			);
			if (controller.signal.aborted) throw bridgeError('cancelled');
			if (result.code !== 0) throw bridgeError('picker_failed');
			const selected = result.stdout.trim();
			if (selected) {
				this.pendingDirectory = await validateDirectory(selected);
				await this.persist();
			}
		} finally {
			this.choosingDirectory = false;
			if (this.pickerController === controller) this.pickerController = null;
			this.broadcast();
		}
		return this.snapshot();
	}
	async saveSettings({outputDir}) {
		// Only a picker-selected directory or the existing/default directory is accepted.
		if (
			![this.pendingDirectory, this.settings.outputDir, this.defaultDirectory].includes(outputDir)
		)
			throw bridgeError('directory_invalid');
		const directory = await validateDirectory(outputDir, {
			createDefault: true,
			defaultDirectory: this.defaultDirectory,
		});
		this.settings.outputDir = directory;
		this.pendingDirectory = null;
		await this.changed();
		return this.snapshot();
	}
	async reveal({taskId}) {
		if (this.task?.id !== taskId || this.task.status !== 'completed' || !this.task.result?.filepath)
			throw bridgeError('task_not_found');
		const filepath = this.task.result.filepath;
		try {
			if (!(await stat(filepath)).isFile()) throw new Error();
		} catch {
			throw bridgeError('file_missing');
		}
		const result = await this.execute('/usr/bin/open', ['-R', filepath], {
			timeoutMs: 10000,
			maxOutputBytes: 16384,
		});
		if (result.code !== 0) throw bridgeError('reveal_failed');
		return {revealed: true};
	}
	async close() {
		for (const controller of this.resolvers.values()) controller.abort();
		this.controller?.abort();
		this.pickerController?.abort();
		await Promise.allSettled([this.downloadPromise, this.pickerPromise]);
		await this.persistence;
	}
}
