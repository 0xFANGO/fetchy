export function invalidUrl(message) {
	throw Object.assign(new Error(message), {code: 'invalid_url'});
}

export function startTime(value) {
	if (!value) return null;
	if (/^\d+(?:\.\d+)?s?$/.test(value)) return Number(value.replace(/s$/, ''));
	const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
	return m && m[0] ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : null;
}
