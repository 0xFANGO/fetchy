import CryptoKit
import Foundation

/// Both regional sites give anonymous visitors a web_session. Only their own top-level page
/// can confirm that the current session is a member; CLI account checks reuse that observation.
struct XiaohongshuLogin {
  let defaults: UserDefaults
  static let shared = Self(
    defaults: UserDefaults(suiteName: "app.fetchy.desktop.sign-in") ?? .standard)
  static let pageState = """
    (() => {
      const app = document.querySelector('[data-v-app]')?.__vue_app__ ??
        document.querySelector('#app')?.__vue_app__;
      const live = app?.config?.globalProperties?.$pinia?.state?.value?.user;
      const unwrap = value => value?.__v_isRef === true ? value.value : value;
      const user = unwrap(live ?? window.__INITIAL_STATE__?.user);
      const info = unwrap(user?.userInfo);
      if (info?.guest === true) return 'guest';
      if (unwrap(user?.loggedIn) === true &&
          (info?.guest === false || (typeof info?.userId === 'string' && info.userId.length > 0)))
        return 'member';
      return 'unknown';
    })()
    """

  static func region(_ host: String) -> String? {
    switch host.lowercased() {
    case "xiaohongshu.com", "www.xiaohongshu.com": return "xiaohongshu.com"
    case "rednote.com", "www.rednote.com": return "rednote.com"
    default: return nil
    }
  }

  static func pageHost(_ url: URL?) -> String? {
    guard let url, url.scheme == "https", url.port == nil || url.port == 443,
      url.user == nil, url.password == nil, let host = url.host?.lowercased(), region(host) != nil
    else { return nil }
    return host
  }

  private func key(_ profile: UUID, _ region: String) -> String {
    "verified-web-session.\(profile.uuidString).\(region)"
  }

  private func fingerprint(_ cookie: HTTPCookie) -> String {
    let bytes = Data([cookie.domain, cookie.path, cookie.value].joined(separator: "\u{0}").utf8)
    return Data(SHA256.hash(data: bytes)).base64EncodedString()
  }

  func forget(_ profile: UUID) {
    for region in ["xiaohongshu.com", "rednote.com"] {
      defaults.removeObject(forKey: key(profile, region))
    }
  }

  /// Mark only live cookies applicable to the observed page. Never store cookie values or user IDs.
  func observe(_ state: String, cookies: [HTTPCookie], host: String, profile: UUID) {
    guard let region = Self.region(host) else { return }
    let name = key(profile, region)
    if state == "guest" {
      if defaults.object(forKey: name) != nil { defaults.removeObject(forKey: name) }
    } else if state == "member" {
      let fingerprints = cookies.filter {
        $0.name == "web_session" && $0.matches(host: host)
          && ($0.expiresDate.map { $0 > Date() } ?? true)
      }.map(fingerprint)
      if !fingerprints.isEmpty { defaults.set(fingerprints, forKey: name) }
    }
  }

  /// Other sites keep their own sign-in rules. An unverified regional web_session never leaves WebKit.
  func mayUse(_ cookie: HTTPCookie, profile: UUID) -> Bool {
    let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
    guard cookie.name == "web_session", let region = Self.region(domain) else { return true }
    let known = defaults.stringArray(forKey: key(profile, region)) ?? []
    return (cookie.expiresDate.map { $0 > Date() } ?? true) && known.contains(fingerprint(cookie))
  }
}

extension HTTPCookie {
  func matches(host: String) -> Bool {
    if domain.hasPrefix(".") { return host == String(domain.dropFirst()) || host.hasSuffix(domain) }
    return host == domain
  }
}
