import {accessSync, constants, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function executable(candidate) {
	try {
		if (!statSync(candidate).isFile()) return null;
		accessSync(candidate, constants.X_OK);
		return path.resolve(candidate);
	} catch {
		return null;
	}
}

export function findExecutable(
	name,
	{envPath = process.env.PATH ?? '', platform = process.platform} = {},
) {
	if (path.isAbsolute(name) || /[\\/]/.test(name)) return executable(name);
	const names = platform === 'win32' && !name.endsWith('.exe') ? [`${name}.exe`, name] : [name];
	for (const directory of envPath.split(platform === 'win32' ? ';' : ':')) {
		if (!directory) continue;
		for (const file of names) {
			const found = executable(path.join(directory, file));
			if (found) return found;
		}
	}
	return null;
}

export function ytDlpCommand({
	ytDlpPath,
	root = projectRoot,
	envPath,
	platform = process.platform,
} = {}) {
	if (ytDlpPath !== undefined && ytDlpPath !== null) return ytDlpPath;
	const local = path.join(
		root,
		'.venv',
		platform === 'win32' ? 'Scripts' : 'bin',
		platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
	);
	return executable(local) ?? findExecutable('yt-dlp', {envPath, platform}) ?? 'yt-dlp';
}
