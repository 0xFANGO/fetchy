import {randomUUID} from 'node:crypto';
import {EngineError} from '../src/process.mjs';

const limit = 48 * 1024 ** 2,
	chunkLimit = 192 * 1024,
	ttl = 5 * 60_000;
const invalid = () => {
	throw new EngineError('invalid_request', '上传无效、已过期或已超过限制。');
};

// Chunks may contain short-lived attachment URLs. Discard abandoned sessions from memory.
export class LibraryUploads {
	sessions = new Map();
	start() {
		if (this.sessions.size >= 2) invalid();
		const uploadId = randomUUID();
		const session = {
			parts: [],
			bytes: 0,
			timer: setTimeout(() => this.sessions.delete(uploadId), ttl),
		};
		session.timer.unref();
		this.sessions.set(uploadId, session);
		return {uploadId};
	}
	part({uploadId, index, data}) {
		const session = this.sessions.get(uploadId);
		if (
			!session ||
			session.parts.length !== index ||
			typeof data !== 'string' ||
			data.length === 0 ||
			data.length > (4 * chunkLimit) / 3 ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(data)
		)
			invalid();
		const chunk = Buffer.from(data, 'base64');
		if (
			!chunk.length ||
			chunk.toString('base64') !== data ||
			chunk.length + session.bytes > limit ||
			index >= 512
		)
			invalid();
		session.parts.push(chunk);
		session.bytes += chunk.length;
		session.timer.refresh();
		return {index};
	}
	finish({uploadId, count}) {
		const session = this.sessions.get(uploadId);
		if (!session || !count || count !== session.parts.length) invalid();
		clearTimeout(session.timer);
		this.sessions.delete(uploadId);
		try {
			return JSON.parse(Buffer.concat(session.parts, session.bytes).toString('utf8'));
		} catch {
			invalid();
		}
	}
}
