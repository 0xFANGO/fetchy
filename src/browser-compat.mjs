/**
 * Self-contained compatibility script injected at document_start across all frames
 * in Fetchy's built-in macOS WKWebView browser.
 *
 * macOS 13.3+ requires the restricted `com.apple.developer.web-browser.public-key-credential`
 * entitlement for embedded WKWebViews to use native Passkeys on third-party domains.
 * Without it, keeping `PublicKeyCredential` exposed causes Google/X sign-in flows to
 * still pick the Passkey challenge (and fall back to Bluetooth CTAP2 errors).
 * Removing WebAuthn globals and rejecting `publicKey` requests with `NotSupportedError`
 * lets sites detect that WebAuthn is unavailable and go straight to password / 2FA / QR.
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

	const unsupportedPasskey = () => {
		const message = 'WebAuthn passkeys are not supported in this embedded browser.';
		if (typeof DOMException === 'function') {
			return Promise.reject(new DOMException(message, 'NotSupportedError'));
		}
		const err = new Error(message);
		err.name = 'NotSupportedError';
		return Promise.reject(err);
	};

	const removeGlobal = (name) => {
		for (const target of [window, typeof globalThis === 'object' ? globalThis : null]) {
			if (!target || !(name in target)) continue;
			let deleted = false;
			try {
				deleted = delete target[name];
			} catch {}
			if (!deleted || name in target) {
				try {
					Object.defineProperty(target, name, {
						value: undefined,
						configurable: true,
						writable: true,
					});
				} catch {}
			}
		}
	};

	for (const name of [
		'PublicKeyCredential',
		'AuthenticatorResponse',
		'AuthenticatorAttestationResponse',
		'AuthenticatorAssertionResponse',
	]) {
		removeGlobal(name);
	}

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
						return unsupportedPasskey();
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
						return unsupportedPasskey();
					}
					return origCreate(options);
				});
			}
		}
	} catch {}
}
