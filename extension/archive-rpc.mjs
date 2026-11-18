let port;
const waiting = new Map();
export function libraryRpc(method, params = {}) {
	if (!port) {
		port = chrome.runtime.connect({name: 'archive'});
		port.onMessage.addListener((m) => {
			const job = waiting.get(m.id);
			if (!job) return;
			waiting.delete(m.id);
			if (m.ok) job.resolve(m.result);
			else job.reject(new Error(m.code || 'unavailable'));
		});
		port.onDisconnect.addListener(() => {
			void chrome.runtime.lastError;
			port = null;
			for (const job of waiting.values()) job.reject(new Error('unavailable'));
			waiting.clear();
		});
	}
	const id = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		waiting.set(id, {resolve, reject});
		try {
			port.postMessage({id, method, params});
		} catch {
			waiting.delete(id);
			reject(new Error('unavailable'));
		}
	});
}
export async function submitArchive(manifest, selected, onPart, rpc = libraryRpc) {
	const payload = {manifest, selected},
		encoded = new TextEncoder().encode(JSON.stringify(payload));
	if (encoded.length < 350 * 1024) return rpc('libraryStart', payload);
	if (encoded.length > 48 * 1024 * 1024) throw new Error('upload_limit');
	const {uploadId} = await rpc('libraryUploadStart');
	const size = 192 * 1024,
		count = Math.ceil(encoded.length / size);
	for (let index = 0; index < count; index++) {
		const slice = encoded.subarray(index * size, (index + 1) * size);
		let bytes = '';
		for (let off = 0; off < slice.length; off += 8192)
			bytes += String.fromCharCode(...slice.subarray(off, off + 8192));
		await rpc('libraryUploadPart', {uploadId, index, data: btoa(bytes)});
		onPart?.(index + 1, count);
	}
	return rpc('libraryUploadFinish', {uploadId, count});
}
