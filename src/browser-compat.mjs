/**
 * Self-contained compatibility script injected at document_start across all frames
 * in Fetchy's built-in macOS WKWebView browser.
 *
 * macOS 13.3+ requires the restricted `com.apple.developer.web-browser.public-key-credential`
 * entitlement for embedded WKWebViews to use native Passkeys on third-party domains.
 * Without it, WKWebView still advertises `PublicKeyCredential` as available, causing
 * Google/X sign-in flows to trigger Touch ID and then fail with a Bluetooth CTAP2 error.
 * Reporting platform passkeys as unavailable lets sites fall back cleanly to password,
 * 2FA, or QR login.
 */
export function installBrowserCompat() {
	if (typeof window === 'undefined' || window.__fetchyCompatInstalled) return;
	try {
		Object.defineProperty(window, '__fetchyCompatInstalled', {
			value: true,
			configurable: false,
			enumerable: false,
		});
	} catch {
		window.__fetchyCompatInstalled = true;
	}

	const denyPasskey = () => {
		const message = 'Platform passkeys are unavailable in this embedded browser.';
		if (typeof DOMException === 'function') {
			return Promise.reject(new DOMException(message, 'NotAllowedError'));
		}
		const err = new Error(message);
		err.name = 'NotAllowedError';
		return Promise.reject(err);
	};

	const defineMethod = (target, key, value) => {
		if (!target) return;
		try {
			Object.defineProperty(target, key, {
				value,
				configurable: true,
				writable: true,
			});
		} catch {
			try {
				target[key] = value;
			} catch {}
		}
	};

	try {
		const PKC = window.PublicKeyCredential;
		if (typeof PKC === 'function') {
			defineMethod(PKC, 'isUserVerifyingPlatformAuthenticatorAvailable', () =>
				Promise.resolve(false),
			);
			defineMethod(PKC, 'isConditionalMediationAvailable', () => Promise.resolve(false));
			defineMethod(PKC, 'getClientCapabilities', () =>
				Promise.resolve({
					conditionalCreate: false,
					conditionalGet: false,
					hybridTransport: false,
					passkeyPlatformAuthenticator: false,
					userVerifyingPlatformAuthenticator: false,
					relatedOrigins: false,
					signalAllAcceptedCredentials: false,
					signalCurrentUserDetails: false,
					signalUnknownCredential: false,
				}),
			);
		}
	} catch {}

	try {
		const creds = window.navigator?.credentials;
		if (creds) {
			if (typeof creds.get === 'function') {
				const origGet = creds.get.bind(creds);
				defineMethod(creds, 'get', (options) => {
					if (
						options &&
						typeof options === 'object' &&
						'publicKey' in options &&
						options.publicKey
					) {
						return denyPasskey();
					}
					return origGet(options);
				});
			}
			if (typeof creds.create === 'function') {
				const origCreate = creds.create.bind(creds);
				defineMethod(creds, 'create', (options) => {
					if (
						options &&
						typeof options === 'object' &&
						'publicKey' in options &&
						options.publicKey
					) {
						return denyPasskey();
					}
					return origCreate(options);
				});
			}
		}
	} catch {}
}
