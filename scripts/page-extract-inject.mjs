/**
 * Source of the script the extension injects into a video page's main world.
 * chrome.scripting returns the completion value of a file injection, so the
 * script evaluates to a plain {ok, media, userAgent} or {ok: false, code}
 * object. Errors are encoded as data: no page exception can escape with a
 * signed URL in its message.
 */
export function pageExtractInjection(extractPageMedia) {
	return `(() => {
	const args = globalThis.__fetchyPageExtractArgs;
	delete globalThis.__fetchyPageExtractArgs;
	if (![...document.querySelectorAll('video')].some((video) => video.readyState >= 1))
		return {ok: false, code: 'browser_state_missing'};
	try {
		return {ok: true, media: (${extractPageMedia.toString()})(args), userAgent: navigator.userAgent};
	} catch (error) {
		return {ok: false, code: typeof error?.code === 'string' ? error.code : 'browser_state_missing'};
	}
})();
`;
}
