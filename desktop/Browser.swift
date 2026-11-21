import AppKit
import CryptoKit
import SwiftUI
import WebKit

/// Present as modern macOS Safari so sites like Bilibili and Google render normally.
let safariUserAgent = "Version/18.5 Safari/605.1.15"

private let signInDefaults =
  UserDefaults(suiteName: "app.fetchy.desktop.sign-in") ?? .standard

/// Single shared persistent WebKit store for Fetchy's built-in browser so cross-site logins
/// (e.g. Google OAuth on X / YouTube) share sessions naturally. Isolates by UUID when
/// `FETCHY_DATA_DIR` is overridden (such as in automated tests).
@MainActor func sharedBrowserStore() -> WKWebsiteDataStore {
  if let dir = dataDirectoryOverride ?? ProcessInfo.processInfo.environment["FETCHY_DATA_DIR"],
    !dir.isEmpty
  {
    let digest = SHA256.hash(data: Data((dir + "\0shared-browser").utf8))
    let b = Array(digest.prefix(16))
    let uuid = UUID(uuid: (
      b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
      b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    ))
    return WKWebsiteDataStore(forIdentifier: uuid)
  }
  return .default()
}

func recordMatchesHosts(_ displayName: String, hosts: Set<String>) -> Bool {
  let name = displayName.lowercased()
  guard !name.isEmpty else { return false }
  return hosts.contains { host in
    let h = host.lowercased()
    return h == name || h.hasSuffix("." + name)
  }
}

/// Remove cookies and storage for a single site's hosts without touching other signed-in sites.
@MainActor func clearSiteData(hosts: Set<String>, legacyProfile: UUID?) async {
  let store = sharedBrowserStore()
  if !hosts.isEmpty {
    let cookies = await store.httpCookieStore.allCookies()
    for cookie in cookies where hosts.contains(where: { cookie.matches(host: $0) }) {
      await store.httpCookieStore.deleteCookie(cookie)
    }
    let types = WKWebsiteDataStore.allWebsiteDataTypes()
    let records = await store.dataRecords(ofTypes: types)
    let matched = records.filter { recordMatchesHosts($0.displayName, hosts: hosts) }
    if !matched.isEmpty {
      await store.removeData(ofTypes: types, for: matched)
    }
  }
  if let legacyProfile {
    XiaohongshuLogin.shared.forget(legacyProfile)
    let existing = await WKWebsiteDataStore.allDataStoreIdentifiers
    if existing.contains(legacyProfile) {
      let legacy = WKWebsiteDataStore(forIdentifier: legacyProfile)
      await legacy.removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
      try? await WKWebsiteDataStore.remove(forIdentifier: legacyProfile)
    }
  }
}

/// One-time migration from earlier per-site UUID stores into the shared browser store.
@MainActor func migrateLegacyProfileIfNeeded(_ profile: UUID, hosts: Set<String>) async {
  guard !hosts.isEmpty else { return }
  let flagKey = "migrated-legacy-profile.\(profile.uuidString)"
  if signInDefaults.bool(forKey: flagKey) { return }
  // Initialize WebKit main RunLoop before calling class-level WKWebsiteDataStore APIs.
  let sharedStore = sharedBrowserStore()
  let existingIds = await WKWebsiteDataStore.allDataStoreIdentifiers
  guard existingIds.contains(profile) else {
    signInDefaults.set(true, forKey: flagKey)
    return
  }
  let legacyStore = WKWebsiteDataStore(forIdentifier: profile)
  let legacyCookies = await legacyStore.httpCookieStore.allCookies()
  let existingCookies = await sharedStore.httpCookieStore.allCookies()
  let existingKeys = Set(existingCookies.map { "\($0.name)\0\($0.domain)\0\($0.path)" })
  let now = Date()
  for cookie in legacyCookies {
    guard (cookie.expiresDate.map { $0 > now } ?? true),
      hosts.contains(where: { cookie.matches(host: $0) })
    else { continue }
    let key = "\(cookie.name)\0\(cookie.domain)\0\(cookie.path)"
    if !existingKeys.contains(key) {
      await sharedStore.httpCookieStore.setCookie(cookie)
    }
  }
  signInDefaults.set(true, forKey: flagKey)
}

/// Insert validated external-browser cookies for a single site into the shared WebKit store.
@MainActor func applyImportedCookies(
  _ rows: [[String: Any]], profile: UUID, hosts: Set<String>
) async -> Int {
  let store = sharedBrowserStore()
  let now = Date()
  var imported: [HTTPCookie] = []
  for row in rows {
    guard let name = row["name"] as? String, !name.isEmpty,
      let value = row["value"] as? String,
      let domain = row["domain"] as? String, !domain.isEmpty
    else { continue }
    let path = (row["path"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "/"
    let secure = row["secure"] as? Bool ?? false
    let expiresTs = (row["expires"] as? NSNumber)?.doubleValue ?? 0
    var props: [HTTPCookiePropertyKey: Any] = [
      .name: name,
      .value: value,
      .domain: domain,
      .path: path,
    ]
    if secure { props[.secure] = "TRUE" }
    if expiresTs > 0 {
      let date = Date(timeIntervalSince1970: expiresTs)
      if date <= now { continue }
      props[.expires] = date
    }
    guard let cookie = HTTPCookie(properties: props),
      hosts.contains(where: { cookie.matches(host: $0) })
    else { continue }
    await store.httpCookieStore.setCookie(cookie)
    imported.append(cookie)
  }
  // Explicitly imported Xiaohongshu/Rednote web_session cookies should be recognized immediately.
  for regionHost in ["www.xiaohongshu.com", "www.rednote.com"] {
    let regional = imported.filter { $0.name == "web_session" && $0.matches(host: regionHost) }
    if !regional.isEmpty {
      XiaohongshuLogin.shared.observe("member", cookies: regional, host: regionHost, profile: profile)
    }
  }
  return imported.count
}

/// What Node knows about a site: its identifier and which cookies mean "signed in".
struct SiteInfo: Equatable {
  let site: String
  let label: String
  let url: String
  let profile: UUID
  let hosts: [String]
  let session: [String]
}

private func json(_ value: Any) -> Data? {
  try? JSONSerialization.data(withJSONObject: value)
}

// MARK: - Shared WebKit Dialog & Download Helpers

@MainActor private func presentJSAlert(
  on window: NSWindow?, message: String, host: String, completion: @escaping () -> Void
) {
  let alert = NSAlert()
  alert.messageText = host.isEmpty ? "网页提示" : "来自 \(host) 的提示"
  alert.informativeText = message
  alert.addButton(withTitle: "确定")
  if let window {
    alert.beginSheetModal(for: window) { _ in completion() }
  } else {
    alert.runModal()
    completion()
  }
}

@MainActor private func presentJSConfirm(
  on window: NSWindow?, message: String, host: String, completion: @escaping (Bool) -> Void
) {
  let alert = NSAlert()
  alert.messageText = host.isEmpty ? "确认操作" : "来自 \(host) 的确认"
  alert.informativeText = message
  alert.addButton(withTitle: "确定")
  alert.addButton(withTitle: "取消")
  if let window {
    alert.beginSheetModal(for: window) { completion($0 == .alertFirstButtonReturn) }
  } else {
    completion(alert.runModal() == .alertFirstButtonReturn)
  }
}

@MainActor private func presentJSPrompt(
  on window: NSWindow?, prompt: String, defaultText: String?, host: String,
  completion: @escaping (String?) -> Void
) {
  let alert = NSAlert()
  alert.messageText = host.isEmpty ? "网页输入" : "来自 \(host) 的输入请求"
  alert.informativeText = prompt
  alert.addButton(withTitle: "确定")
  alert.addButton(withTitle: "取消")
  let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
  input.stringValue = defaultText ?? ""
  alert.accessoryView = input
  alert.window.initialFirstResponder = input
  if let window {
    alert.beginSheetModal(for: window) { response in
      completion(response == .alertFirstButtonReturn ? input.stringValue : nil)
    }
  } else {
    completion(alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil)
  }
}

@MainActor private func presentOpenPanel(
  on window: NSWindow?, parameters: WKOpenPanelParameters, completion: @escaping ([URL]?) -> Void
) {
  let panel = NSOpenPanel()
  panel.canChooseFiles = true
  panel.canChooseDirectories = parameters.allowsDirectories
  panel.allowsMultipleSelection = parameters.allowsMultipleSelection
  if let window {
    panel.beginSheetModal(for: window) { response in
      completion(response == .OK ? panel.urls : nil)
    }
  } else {
    completion(panel.runModal() == .OK ? panel.urls : nil)
  }
}

@MainActor private func presentHTTPAuth(
  on window: NSWindow?, challenge: URLAuthenticationChallenge,
  completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
) {
  let method = challenge.protectionSpace.authenticationMethod
  guard method == NSURLAuthenticationMethodHTTPBasic || method == NSURLAuthenticationMethodHTTPDigest
  else {
    completion(.performDefaultHandling, nil)
    return
  }
  let alert = NSAlert()
  alert.messageText = "需要身份验证"
  alert.informativeText = "\(challenge.protectionSpace.host) 要求输入用户名和密码。"
  alert.addButton(withTitle: "登录")
  alert.addButton(withTitle: "取消")
  let container = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 58))
  let userField = NSTextField(frame: NSRect(x: 0, y: 32, width: 300, height: 24))
  userField.placeholderString = "用户名"
  let passField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
  passField.placeholderString = "密码"
  container.addSubview(userField)
  container.addSubview(passField)
  alert.accessoryView = container
  alert.window.initialFirstResponder = userField
  let finish: (NSApplication.ModalResponse) -> Void = { response in
    if response == .alertFirstButtonReturn {
      let cred = URLCredential(
        user: userField.stringValue, password: passField.stringValue, persistence: .forSession)
      completion(.useCredential, cred)
    } else {
      completion(.cancelAuthenticationChallenge, nil)
    }
  }
  if let window {
    alert.beginSheetModal(for: window, completionHandler: finish)
  } else {
    finish(alert.runModal())
  }
}

private func shouldOpenAsPopup(_ action: WKNavigationAction, features: WKWindowFeatures) -> Bool {
  if features.width != nil || features.height != nil { return true }
  if action.navigationType == .other { return true }
  guard let url = action.request.url else { return true }
  if url.scheme == "about" { return true }
  let host = (url.host ?? "").lowercased()
  let path = url.path.lowercased()
  let authHosts = [
    "accounts.google.com", "appleid.apple.com", "login.microsoftonline.com",
    "login.live.com", "github.com", "passport.bilibili.com",
  ]
  if authHosts.contains(host) && (host != "github.com" || path.contains("login") || path.contains("oauth")) {
    return true
  }
  if path.contains("oauth") || path.contains("/authorize") || path.contains("signin") {
    return true
  }
  return false
}

private func isAttachmentResponse(_ response: WKNavigationResponse) -> Bool {
  if !response.canShowMIMEType { return true }
  if let http = response.response as? HTTPURLResponse,
    let disposition = http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased(),
    disposition.contains("attachment")
  {
    return true
  }
  return false
}

private func uniqueDownloadURL(in directory: URL, suggestedFilename: String) -> URL {
  let clean = (suggestedFilename as NSString).lastPathComponent
  let baseName = clean.isEmpty ? "download" : clean
  let fm = FileManager.default
  try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
  var candidate = directory.appendingPathComponent(baseName)
  if !fm.fileExists(atPath: candidate.path) { return candidate }
  let ext = candidate.pathExtension
  let stem = candidate.deletingPathExtension().lastPathComponent
  for index in 2...999 {
    let next = ext.isEmpty ? "\(stem) (\(index))" : "\(stem) (\(index)).\(ext)"
    candidate = directory.appendingPathComponent(next)
    if !fm.fileExists(atPath: candidate.path) { return candidate }
  }
  return directory.appendingPathComponent(UUID().uuidString + (ext.isEmpty ? "" : "." + ext))
}

@MainActor final class BrowserDownloadHandler: NSObject, WKDownloadDelegate {
  private let directory: URL
  private let onFinish: (URL) -> Void
  private let onFail: (String) -> Void
  private var destination: URL?

  init(directory: URL, onFinish: @escaping (URL) -> Void, onFail: @escaping (String) -> Void) {
    self.directory = directory
    self.onFinish = onFinish
    self.onFail = onFail
  }

  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse,
    suggestedFilename: String, completionHandler: @escaping (URL?) -> Void
  ) {
    let url = uniqueDownloadURL(in: directory, suggestedFilename: suggestedFilename)
    destination = url
    completionHandler(url)
  }

  func downloadDidFinish(_ download: WKDownload) {
    if let destination { onFinish(destination) }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    onFail(error.localizedDescription)
  }
}

/// Real auxiliary popup window for OAuth / window.open flows so `window.opener` stays intact.
@MainActor final class BrowserPopupController: NSObject, NSWindowDelegate, WKNavigationDelegate,
  WKUIDelegate
{
  let webView: WKWebView
  let window: NSWindow
  private weak var owner: BrowserModel?
  private var titleObs: NSKeyValueObservation?
  private var urlObs: NSKeyValueObservation?
  private var closed = false

  init(
    configuration: WKWebViewConfiguration, features: WKWindowFeatures,
    parentWindow: NSWindow?, owner: BrowserModel
  ) {
    self.owner = owner
    let width = min(max(CGFloat(features.width?.doubleValue ?? 560), 440), 980)
    let height = min(max(CGFloat(features.height?.doubleValue ?? 700), 500), 860)
    webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: configuration)
    webView.allowsBackForwardNavigationGestures = true
    webView.allowsMagnification = true
    webView.isInspectable = true
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: width, height: height),
      styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered, defer: false
    )
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    window.contentView = webView
    window.title = "验证与登录"
    window.isReleasedWhenClosed = false
    window.delegate = self
    titleObs = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
      let t = view.title ?? ""
      let host = view.url?.host ?? ""
      DispatchQueue.main.async {
        self?.window.title = t.isEmpty ? (host.isEmpty ? "验证与登录" : host) : t
      }
    }
    urlObs = webView.observe(\.url, options: [.new]) { [weak self] view, _ in
      let host = view.url?.host ?? ""
      DispatchQueue.main.async {
        guard let self, self.window.title == "验证与登录", !host.isEmpty else { return }
        self.window.title = host
      }
    }
    if let parent = parentWindow {
      let pf = parent.frame
      let origin = NSPoint(x: pf.midX - width / 2, y: pf.midY - height / 2)
      window.setFrameOrigin(origin)
    } else {
      window.center()
    }
    window.makeKeyAndOrderFront(nil)
  }

  func closePopup() {
    guard !closed else { return }
    closed = true
    window.delegate = nil
    window.close()
    owner?.popupDidClose(self)
  }

  func windowWillClose(_ notification: Notification) {
    guard !closed else { return }
    closed = true
    owner?.popupDidClose(self)
  }

  func webViewDidClose(_ webView: WKWebView) {
    closePopup()
  }

  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    owner?.openPopup(configuration: configuration, features: windowFeatures, parentWindow: window)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url,
      ["http", "https", "about", "blob", "data"].contains(url.scheme ?? "")
    else {
      decisionHandler(.cancel)
      return
    }
    if action.shouldPerformDownload {
      decisionHandler(.download)
      return
    }
    decisionHandler(.allow)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    decisionHandler(isAttachmentResponse(response) ? .download : .allow)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    owner?.attachWebDownload(download)
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    owner?.attachWebDownload(download)
  }

  func webView(
    _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    presentHTTPAuth(on: window, challenge: challenge, completion: completionHandler)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    presentJSAlert(on: window, message: message, host: frame.securityOrigin.host, completion: completionHandler)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    presentJSConfirm(on: window, message: message, host: frame.securityOrigin.host, completion: completionHandler)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (String?) -> Void
  ) {
    presentJSPrompt(
      on: window, prompt: prompt, defaultText: defaultText,
      host: frame.securityOrigin.host, completion: completionHandler)
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    presentOpenPanel(on: window, parameters: parameters, completion: completionHandler)
  }
}

// MARK: - Main Browser Model

@MainActor final class BrowserModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
  @Published var address = ""
  @Published var pageTitle = ""
  @Published var canGoBack = false
  @Published var canGoForward = false
  @Published var isLoading = false
  @Published var estimatedProgress: Double = 0
  @Published var showingStartPage = true
  @Published var site: SiteInfo?
  @Published var signedIn: Bool?
  @Published var notice = ""
  @Published var loadError: String?
  @Published var failedUrl: URL?
  @Published var showOpenDownloads = false
  @Published var showOpenDownloadsFolder = false
  @Published var copiedLink = false
  @Published var pageZoom: CGFloat = 1.0
  @Published var focusAddressToken = 0
  @Published var showSidePanel: Bool = {
    if UserDefaults.standard.object(forKey: "browser.panelOpen") == nil { return true }
    return UserDefaults.standard.bool(forKey: "browser.panelOpen")
  }()
  @Published private(set) var webView: WKWebView?
  @Published var pendingFavoritesShortcut: PlatformShortcut?
  weak var downloads: DownloadsModel?
  var onOpenDownloads: (() -> Void)?
  let panel = SitePanelModel()
  let commands = LocalCommands()
  private var observations: [NSKeyValueObservation] = []
  /// The address the side column last read; a stopped or failed load returns to it.
  private var panelAddress = ""
  private var regionalMonitor: Task<Void, Never>?
  private var regionalCheck: Task<Void, Never>?
  private var favoritesResolveTask: Task<Void, Never>?
  private var siteLookupTask: Task<Void, Never>?
  private var copiedResetTask: Task<Void, Never>?
  private var regionalSessionBound = false
  private var popups: [BrowserPopupController] = []
  private var downloadHandlers: [ObjectIdentifier: BrowserDownloadHandler] = [:]
  private var lastTerminateDates: [Date] = []
  private var lastResolvedHost = ""
  private var navigationGeneration = 0

  override init() {
    super.init()
    panel.browser = self
  }

  var currentUrl: URL? {
    guard !showingStartPage else { return nil }
    return webView?.url ?? failedUrl
  }

  func isViewing(hosts: Set<String>) -> Bool {
    guard let host = webView?.url?.host?.lowercased() else { return false }
    return hosts.contains { $0.lowercased() == host }
  }

  func siteInfo(_ input: String) async throws -> SiteInfo {
    guard let row = try await commands.run(["site", input], bridge: true) as? [String: Any],
      let site = row["site"] as? String, let label = row["label"] as? String,
      let url = row["url"] as? String, let raw = row["profile"] as? String,
      let profile = UUID(uuidString: raw)
    else { throw FetchyFailure(text: "无法识别这个网站。") }
    return SiteInfo(
      site: site, label: label, url: url, profile: profile,
      hosts: row["hosts"] as? [String] ?? [], session: row["session"] as? [String] ?? [])
  }

  /// Resolve user address bar input into a URL (supporting http/https, bare domains, or keyword search).
  private func resolveInputToURL(_ raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.hasPrefix("https://") || trimmed.hasPrefix("http://") {
      if let url = URL(string: trimmed), url.host != nil { return url }
    }
    let hasWhitespace = trimmed.contains(where: \.isWhitespace)
    if !hasWhitespace {
      let lower = trimmed.lowercased()
      if lower == "localhost" || lower.hasPrefix("localhost:") || lower.hasPrefix("localhost/")
        || lower.hasPrefix("127.0.0.1") || lower.hasPrefix("[::1]")
      {
        if let url = URL(string: "http://" + trimmed), url.host != nil { return url }
      }
      if trimmed.contains(".") && !trimmed.hasPrefix(".") && !trimmed.hasSuffix(".") {
        let hostPart = trimmed.split(separator: "/").first.map(String.init) ?? trimmed
        let bareHost = hostPart.split(separator: ":").first.map(String.init) ?? hostPart
        if bareHost.range(
          of: #"^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$"#, options: .regularExpression) != nil
        {
          if let url = URL(string: "https://" + trimmed), url.host != nil { return url }
        }
      }
    }
    var comps = URLComponents(string: "https://duckduckgo.com/")
    comps?.queryItems = [URLQueryItem(name: "q", value: trimmed)]
    return comps?.url
  }

  /// Navigate to a URL or search query; empty input returns to the start page.
  func go(_ text: String, keepPendingFavorites: Bool = false) {
    let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else {
      goHome()
      return
    }
    guard let url = resolveInputToURL(raw) else {
      notice = "无法解析输入内容。"
      showOpenDownloads = false
      showOpenDownloadsFolder = false
      return
    }
    if !keepPendingFavorites {
      cancelPendingFavorites(clearNotice: false)
    }
    showingStartPage = false
    loadError = nil
    failedUrl = nil
    notice = ""
    showOpenDownloads = false
    showOpenDownloadsFolder = false
    ensureWebView()
    navigationGeneration += 1
    let gen = navigationGeneration
    address = url.absoluteString
    Task { @MainActor [weak self] in
      guard let self, self.navigationGeneration == gen else { return }
      if let info = try? await self.siteInfo(url.absoluteString) {
        await migrateLegacyProfileIfNeeded(info.profile, hosts: Set(info.hosts))
        guard self.navigationGeneration == gen else { return }
        self.applySiteInfo(info)
      }
      guard self.navigationGeneration == gen else { return }
      self.webView?.load(URLRequest(url: url))
    }
  }

  func goHome() {
    navigationGeneration += 1
    cancelPendingFavorites(clearNotice: true)
    loadError = nil
    failedUrl = nil
    showOpenDownloads = false
    showOpenDownloadsFolder = false
    showingStartPage = true
  }

  func cancelPendingFavorites(clearNotice: Bool = true) {
    pendingFavoritesShortcut = nil
    favoritesResolveTask?.cancel()
    favoritesResolveTask = nil
    if clearNotice {
      notice = ""
      showOpenDownloads = false
      showOpenDownloadsFolder = false
    }
  }

  /// Jump directly to a platform's favorites/bookmarks page, resolving dynamic-UID routes after load.
  func openFavorites(_ shortcut: PlatformShortcut) {
    favoritesResolveTask?.cancel()
    favoritesResolveTask = nil
    pendingFavoritesShortcut = shortcut.needsResolve ? shortcut : nil
    go(shortcut.url, keepPendingFavorites: shortcut.needsResolve)
  }

  /// Download the current webpage directly through Fetchy's unified downloader.
  func downloadCurrentPage() async {
    guard let url = currentUrl?.absoluteString,
      url.hasPrefix("https://") || url.hasPrefix("http://")
    else {
      notice = "请先打开一个网页。"
      showOpenDownloads = false
      showOpenDownloadsFolder = false
      return
    }
    guard let downloads else { return }
    let title = webView?.title
    let ok = await downloads.startUrlDownload(url, title: title, referer: url, pageUrl: url)
    if ok {
      notice = "已加入下载队列，文件将直接保存到下载文件夹。"
      showOpenDownloads = true
      showOpenDownloadsFolder = false
    } else if !downloads.notice.isEmpty {
      notice = downloads.notice
      showOpenDownloads = false
      showOpenDownloadsFolder = false
    }
  }

  func copyCurrentLink() {
    guard let raw = currentUrl?.absoluteString, !raw.isEmpty else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(raw, forType: .string)
    copiedLink = true
    copiedResetTask?.cancel()
    copiedResetTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 1_800_000_000)
      guard !Task.isCancelled else { return }
      self?.copiedLink = false
    }
  }

  func openInDefaultBrowser() {
    guard let url = currentUrl else { return }
    NSWorkspace.shared.open(url)
  }

  func zoomIn() {
    guard let webView, !showingStartPage else { return }
    let next = min(3.0, ((webView.pageZoom + 0.1) * 10).rounded() / 10)
    webView.pageZoom = next
    pageZoom = next
  }

  func zoomOut() {
    guard let webView, !showingStartPage else { return }
    let next = max(0.5, ((webView.pageZoom - 0.1) * 10).rounded() / 10)
    webView.pageZoom = next
    pageZoom = next
  }

  func resetZoom() {
    guard let webView else { return }
    webView.pageZoom = 1.0
    pageZoom = 1.0
  }

  func toggleSidePanel() {
    showSidePanel.toggle()
    UserDefaults.standard.set(showSidePanel, forKey: "browser.panelOpen")
  }

  func requestFocusAddress() {
    focusAddressToken += 1
  }

  private func ensureWebView() {
    if webView != nil { return }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = sharedBrowserStore()
    configuration.applicationNameForUserAgent = safariUserAgent
    configuration.preferences.isElementFullscreenEnabled = true
    configuration.preferences.tabFocusesLinks = true
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
    configuration.allowsAirPlayForMediaPlayback = true
    for resource in ["browser-compat", "media-sniffer"] {
      if let url = Bundle.main.url(forResource: resource, withExtension: "js"),
        let source = try? String(contentsOf: url, encoding: .utf8)
      {
        configuration.userContentController.addUserScript(
          WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false))
      }
    }
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    view.allowsBackForwardNavigationGestures = true
    view.allowsMagnification = true
    view.isInspectable = true
    observations = [
      view.observe(\.url, options: [.initial, .new]) { [weak self] view, _ in
        let value = view.url?.absoluteString ?? ""
        DispatchQueue.main.async {
          guard let self else { return }
          self.address = value
          self.syncSiteForCurrentURL(view.url)
          if !value.isEmpty && value != self.panelAddress {
            self.panelAddress = value
            self.panel.pageChanged()
          }
        }
      },
      view.observe(\.title, options: [.initial, .new]) { [weak self] view, _ in
        let value = view.title ?? ""
        DispatchQueue.main.async { self?.pageTitle = value }
      },
      view.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in
        let value = view.canGoBack
        DispatchQueue.main.async { self?.canGoBack = value }
      },
      view.observe(\.canGoForward, options: [.initial, .new]) { [weak self] view, _ in
        let value = view.canGoForward
        DispatchQueue.main.async { self?.canGoForward = value }
      },
      view.observe(\.isLoading, options: [.initial, .new]) { [weak self] view, _ in
        let value = view.isLoading
        DispatchQueue.main.async { self?.isLoading = value }
      },
      view.observe(\.estimatedProgress, options: [.initial, .new]) { [weak self] view, _ in
        let value = view.estimatedProgress
        DispatchQueue.main.async { self?.estimatedProgress = value }
      },
    ]
    webView = view
    panelAddress = ""
    panel.reset()
  }

  private func syncSiteForCurrentURL(_ url: URL?) {
    guard let url, let host = url.host?.lowercased(), ["http", "https"].contains(url.scheme ?? "") else {
      return
    }
    // Cancel pending favorites auto-jump if the user navigated to a different platform.
    if let pending = pendingFavoritesShortcut, !hostBelongsToPlatform(host, site: pending.site) {
      cancelPendingFavorites(clearNotice: true)
    }
    if host == lastResolvedHost, let site, site.hosts.contains(where: { $0.lowercased() == host }) {
      return
    }
    lastResolvedHost = host
    siteLookupTask?.cancel()
    siteLookupTask = Task { @MainActor [weak self] in
      guard let self else { return }
      if let info = try? await self.siteInfo(url.absoluteString) {
        guard !Task.isCancelled else { return }
        self.applySiteInfo(info)
        self.refreshSignIn()
      }
    }
  }

  private func hostBelongsToPlatform(_ host: String, site: String) -> Bool {
    let h = host.lowercased()
    switch site {
    case "xiaohongshu":
      return h.hasSuffix("xiaohongshu.com") || h.hasSuffix("rednote.com")
    case "bilibili":
      return h.hasSuffix("bilibili.com") || h.hasSuffix("biligame.com") || h.hasSuffix("b23.tv")
    case "instagram":
      return h.hasSuffix("instagram.com") || h.hasSuffix("facebook.com") || h.hasSuffix("meta.com")
    case "tiktok":
      return h.hasSuffix("tiktok.com")
    default:
      return true
    }
  }

  private func applySiteInfo(_ info: SiteInfo) {
    let changed = site?.site != info.site
    site = info
    if changed {
      signedIn = nil
      regionalSessionBound = false
      regionalCheck?.cancel()
      regionalCheck = nil
    }
    if info.site == "xiaohongshu" {
      if regionalMonitor == nil, let view = webView {
        // A login modal can complete without loading a new page or changing the URL.
        regionalMonitor = Task { [weak self, weak view] in
          while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled, let self, let view, self.webView === view else { return }
            guard self.site?.site == "xiaohongshu" else {
              self.regionalMonitor = nil
              return
            }
            if NSApp.isActive, view.window?.isVisible == true, !view.isLoading {
              self.refreshSignIn()
            }
          }
        }
      }
    } else {
      regionalMonitor?.cancel()
      regionalMonitor = nil
    }
  }

  func stop() { webView?.stopLoading() }

  func back() {
    if showingStartPage, webView?.url != nil {
      showingStartPage = false
      return
    }
    webView?.goBack()
  }

  func forward() {
    guard !showingStartPage else { return }
    webView?.goForward()
  }

  func reload() {
    guard !showingStartPage else { return }
    loadError = nil
    if let failed = failedUrl, webView?.url == nil {
      failedUrl = nil
      webView?.load(URLRequest(url: failed))
    } else {
      failedUrl = nil
      webView?.reload()
    }
  }

  func openPopup(
    configuration: WKWebViewConfiguration, features: WKWindowFeatures, parentWindow: NSWindow?
  ) -> WKWebView {
    let controller = BrowserPopupController(
      configuration: configuration, features: features,
      parentWindow: parentWindow ?? webView?.window, owner: self)
    popups.append(controller)
    return controller.webView
  }

  func popupDidClose(_ popup: BrowserPopupController) {
    popups.removeAll { $0 === popup }
    webView?.window?.makeKeyAndOrderFront(nil)
    refreshSignIn()
  }

  func attachWebDownload(_ download: WKDownload) {
    let dir =
      downloads?.downloadsDir
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
        "Downloads/Fetchy", isDirectory: true)
    let id = ObjectIdentifier(download)
    let handler = BrowserDownloadHandler(
      directory: dir,
      onFinish: { [weak self] fileUrl in
        guard let self else { return }
        self.downloadHandlers.removeValue(forKey: id)
        self.notice = "已保存网页文件：\(fileUrl.lastPathComponent)"
        self.showOpenDownloads = false
        self.showOpenDownloadsFolder = true
      },
      onFail: { [weak self] message in
        guard let self else { return }
        self.downloadHandlers.removeValue(forKey: id)
        self.notice = "网页文件下载失败：\(message)"
        self.showOpenDownloads = false
        self.showOpenDownloadsFolder = false
      }
    )
    downloadHandlers[id] = handler
    download.delegate = handler
    notice = "正在下载网页文件…"
    showOpenDownloads = false
    showOpenDownloadsFolder = false
  }

  /// Signed in means one of the site's session cookies is in the shared store and not expired.
  func refreshSignIn() {
    guard let site, let webView else { return }
    if site.site == "xiaohongshu" {
      guard let host = XiaohongshuLogin.pageHost(webView.url) else {
        signedIn = nil
        return
      }
      refreshRegionalSignIn(webView, site: site, host: host)
      return
    }
    let hosts = site.hosts
    webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
      let now = Date()
      let live = cookies.filter { cookie in
        (cookie.expiresDate.map { $0 > now } ?? true) && hosts.contains { cookie.matches(host: $0) }
      }
      let ok =
        site.session.isEmpty ? !live.isEmpty : live.contains { site.session.contains($0.name) }
      DispatchQueue.main.async {
        guard let self, self.webView === webView, self.site?.site == site.site else { return }
        let becameSignedIn = self.signedIn != true && ok
        self.signedIn = ok
        if becameSignedIn, self.pendingFavoritesShortcut != nil {
          self.resolvePendingFavorites(webView)
        }
      }
    }
  }

  private func refreshRegionalSignIn(_ view: WKWebView, site: SiteInfo, host: String) {
    guard regionalCheck == nil else { return }
    regionalCheck = Task { [weak self] in
      let state = try? await view.evaluateJavaScript(XiaohongshuLogin.pageState) as? String
      let cookies = await view.configuration.websiteDataStore.httpCookieStore.allCookies()
      guard !Task.isCancelled, let self else { return }
      self.regionalCheck = nil
      guard self.webView === view, XiaohongshuLogin.pageHost(view.url) == host else { return }
      let login = XiaohongshuLogin.shared
      let sessions = cookies.filter { $0.name == "web_session" && $0.matches(host: host) }
      if state == "guest" {
        self.regionalSessionBound = false
        login.observe("guest", cookies: [], host: host, profile: site.profile)
      } else if state == "member" && !self.regionalSessionBound && !sessions.isEmpty {
        login.observe("member", cookies: sessions, host: host, profile: site.profile)
        self.regionalSessionBound = true
      }
      let verified = sessions.contains { login.mayUse($0, profile: site.profile) }
      let status: Bool? = verified ? true : (state == "guest" ? false : nil)
      let becameSignedIn = self.signedIn != true && status == true
      if self.signedIn != status { self.signedIn = status }
      if becameSignedIn, self.pendingFavoritesShortcut != nil {
        self.resolvePendingFavorites(view)
      }
    }
  }

  /// Resolve dynamic-UID favorites routes; stays active across login until resolved or user leaves the site.
  private func resolvePendingFavorites(_ view: WKWebView) {
    guard let shortcut = pendingFavoritesShortcut else { return }
    favoritesResolveTask?.cancel()
    favoritesResolveTask = Task { [weak self, weak view] in
      let startedAt = Date()
      var attempt = 0
      while !Task.isCancelled && Date().timeIntervalSince(startedAt) < 300 {
        guard let self, let view, self.webView === view,
          self.pendingFavoritesShortcut?.site == shortcut.site
        else { return }
        if let result = try? await self.runTool("findFavorites") as? [String: Any],
          let rawUrl = result["url"] as? String, !rawUrl.isEmpty,
          let target = URL(string: rawUrl), target.scheme == "https"
        {
          self.pendingFavoritesShortcut = nil
          self.notice = ""
          self.showOpenDownloads = false
          self.showOpenDownloadsFolder = false
          if view.url?.absoluteString != target.absoluteString {
            view.load(URLRequest(url: target))
          }
          return
        }
        attempt += 1
        if attempt == 5 {
          self.notice = "请先登录 \(shortcut.label)，登录完成后将自动跳转到「\(shortcut.favoritesLabel)」。"
          self.showOpenDownloads = false
          self.showOpenDownloadsFolder = false
        }
        let delayNs: UInt64 = attempt < 8 ? 650_000_000 : 2_000_000_000
        try? await Task.sleep(nanoseconds: delayNs)
      }
      guard !Task.isCancelled, let self, self.pendingFavoritesShortcut?.site == shortcut.site else {
        return
      }
      self.pendingFavoritesShortcut = nil
    }
  }

  /// Run one of the extension's page readers in the open page and return its JSON result.
  func runTool(_ action: String, _ input: [String: Any] = [:]) async throws -> Any {
    guard let webView,
      let file = Bundle.main.url(forResource: "page-tools", withExtension: "js"),
      let script = try? String(contentsOf: file, encoding: .utf8)
    else { throw FetchyFailure(text: "请重新构建 Fetchy 桌面应用。") }
    let value: Any? = try await withCheckedThrowingContinuation { continuation in
      webView.callAsyncJavaScript(
        script, arguments: ["action": action, "input": input], in: nil, in: .page
      ) { result in
        switch result {
        case .success(let value): continuation.resume(returning: value)
        case .failure(let error): continuation.resume(throwing: error)
        }
      }
    }
    guard let text = value as? String, let data = text.data(using: .utf8) else {
      throw FetchyFailure(text: "页面没有返回结果。")
    }
    return try JSONSerialization.jsonObject(with: data)
  }

  // MARK: - WKNavigationDelegate

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url,
      ["http", "https", "about", "blob", "data"].contains(url.scheme ?? "")
    else {
      decisionHandler(.cancel)
      return
    }
    if action.shouldPerformDownload {
      decisionHandler(.download)
      return
    }
    decisionHandler(.allow)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    decisionHandler(isAttachmentResponse(response) ? .download : .allow)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    attachWebDownload(download)
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    attachWebDownload(download)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    loadError = nil
    failedUrl = nil
    regionalCheck?.cancel()
    regionalCheck = nil
    regionalSessionBound = false
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    loadError = nil
    failedUrl = nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loadError = nil
    failedUrl = nil
    refreshSignIn()
    let current = webView.url?.absoluteString ?? ""
    if current != panelAddress || panel.kind == "none" {
      panelAddress = current
      panel.pageChanged()
    }
    if pendingFavoritesShortcut != nil {
      resolvePendingFavorites(webView)
    }
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    handleLoadFailure(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    handleLoadFailure(error)
  }

  private func handleLoadFailure(_ error: Error) {
    let nsError = error as NSError
    // Ignore user cancellations and WebKit frame-load-interrupted (normal for redirects/downloads).
    if nsError.code == NSURLErrorCancelled || (nsError.domain == "WebKitErrorDomain" && nsError.code == 102) {
      return
    }
    if let failing = nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL {
      failedUrl = failing
    }
    loadError = nsError.localizedDescription
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    let now = Date()
    lastTerminateDates = lastTerminateDates.filter { now.timeIntervalSince($0) < 10 }
    if lastTerminateDates.count < 2 {
      lastTerminateDates.append(now)
      webView.reload()
    } else {
      loadError = "网页渲染进程意外中断，请点击重试刷新页面。"
    }
  }

  func webView(
    _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    presentHTTPAuth(on: webView.window, challenge: challenge, completion: completionHandler)
  }

  // MARK: - WKUIDelegate

  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if shouldOpenAsPopup(navigationAction, features: windowFeatures) {
      return openPopup(
        configuration: configuration, features: windowFeatures, parentWindow: webView.window)
    }
    if navigationAction.targetFrame == nil, let url = navigationAction.request.url,
      ["http", "https"].contains(url.scheme ?? "")
    {
      webView.load(navigationAction.request)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    presentJSAlert(
      on: webView.window, message: message, host: frame.securityOrigin.host,
      completion: completionHandler)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    presentJSConfirm(
      on: webView.window, message: message, host: frame.securityOrigin.host,
      completion: completionHandler)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (String?) -> Void
  ) {
    presentJSPrompt(
      on: webView.window, prompt: prompt, defaultText: defaultText,
      host: frame.securityOrigin.host, completion: completionHandler)
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    presentOpenPanel(on: webView.window, parameters: parameters, completion: completionHandler)
  }
}

struct WebViewHost: NSViewRepresentable {
  let view: WKWebView
  func makeNSView(context: Context) -> NSView {
    let holder = NSView()
    attach(view, to: holder)
    return holder
  }
  func updateNSView(_ holder: NSView, context: Context) {
    if view.superview !== holder {
      holder.subviews.forEach { $0.removeFromSuperview() }
      attach(view, to: holder)
    }
  }
  private func attach(_ view: WKWebView, to holder: NSView) {
    view.translatesAutoresizingMaskIntoConstraints = false
    holder.addSubview(view)
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
      view.topAnchor.constraint(equalTo: holder.topAnchor),
      view.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
    ])
  }
}

struct BrowserPane: View {
  @ObservedObject var browser: BrowserModel
  @ObservedObject var panel: SitePanelModel
  @State private var typed = ""
  @FocusState private var editing: Bool

  init(browser: BrowserModel) {
    self.browser = browser
    self.panel = browser.panel
  }

  private let columns = [GridItem(.adaptive(minimum: 184, maximum: 250), spacing: 12)]

  private var detectedBadgeCount: Int {
    if !panel.media.isEmpty { return panel.media.count }
    if !panel.items.isEmpty { return panel.items.count }
    return 0
  }

  private var canGoBackNow: Bool {
    browser.canGoBack || (browser.showingStartPage && browser.webView?.url != nil)
  }

  private var windowTitle: String {
    if browser.showingStartPage { return "浏览器" }
    if !browser.pageTitle.isEmpty { return browser.pageTitle }
    return browser.site?.label ?? "浏览器"
  }

  var body: some View {
    VStack(spacing: 0) {
      toolbarRow
      progressBar
      bookmarksBar
      statusBanner
      Divider()
      HStack(spacing: 0) {
        if !browser.showingStartPage, let view = browser.webView {
          WebViewHost(view: view)
        } else {
          startPage
        }
        if browser.showSidePanel {
          Divider()
          SitePanel(panel: panel).frame(width: 344)
        }
      }
    }
    .navigationTitle(windowTitle)
    .onChange(of: browser.address, initial: true) { _, value in
      if !editing && !browser.showingStartPage { typed = value }
    }
    .onChange(of: browser.showingStartPage) { _, onStart in
      if onStart {
        editing = false
        typed = ""
      } else if !editing {
        typed = browser.address
      }
    }
    .onChange(of: editing) { _, isEditing in
      if !isEditing && !browser.showingStartPage && typed != browser.address {
        typed = browser.address
      }
    }
    .onChange(of: browser.focusAddressToken) { _, _ in
      editing = true
      DispatchQueue.main.async {
        NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
      }
    }
  }

  private var toolbarRow: some View {
    HStack(spacing: 8) {
      HStack(spacing: 4) {
        Button(action: browser.back) { Image(systemName: "chevron.left") }
          .foregroundStyle(canGoBackNow ? Color.primary : Color.secondary.opacity(0.45))
          .disabled(!canGoBackNow).help("后退 (⌘[)")
        Button(action: browser.forward) { Image(systemName: "chevron.right") }
          .foregroundStyle(
            (browser.canGoForward && !browser.showingStartPage)
              ? Color.primary : Color.secondary.opacity(0.45)
          )
          .disabled(!browser.canGoForward || browser.showingStartPage).help("前进 (⌘])")
        Button(action: { browser.isLoading ? browser.stop() : browser.reload() }) {
          Image(systemName: browser.isLoading ? "xmark" : "arrow.clockwise")
        }
        .foregroundStyle(
          (!browser.showingStartPage && browser.webView != nil)
            ? Color.primary : Color.secondary.opacity(0.45)
        )
        .disabled(browser.showingStartPage || browser.webView == nil)
        .help(browser.isLoading ? "停止加载" : "刷新 (⌘R)")
        Button(action: browser.goHome) { Image(systemName: "house") }
          .foregroundStyle(browser.showingStartPage ? fetchyAccent : Color.primary)
          .help("起始页 (⇧⌘H)")
      }
      .buttonStyle(.borderless)

      HStack(spacing: 6) {
        Image(systemName: addressLeadingSymbol)
          .font(.caption)
          .foregroundStyle(.secondary)
        TextField("输入网址或搜索关键词", text: $typed)
          .textFieldStyle(.plain)
          .focused($editing)
          .onSubmit {
            let value = typed
            browser.go(value)
            editing = false
          }
        if !typed.isEmpty {
          Button {
            typed = ""
            editing = true
          } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)
          .help("清空地址栏")
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 5)
      .background(
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(Color(nsColor: .textBackgroundColor))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .strokeBorder(
            editing ? fetchyAccent.opacity(0.75) : Color(nsColor: .separatorColor).opacity(0.65),
            lineWidth: editing ? 1.5 : 1)
      )

      if browser.pageZoom != 1.0 && !browser.showingStartPage {
        Button("\(Int((browser.pageZoom * 100).rounded()))%") {
          browser.resetZoom()
        }
        .buttonStyle(.bordered)
        .controlSize(.mini)
        .help("重置页面缩放 (⌘0)")
      }

      Button {
        Task { await browser.downloadCurrentPage() }
      } label: {
        Label("下载此页", systemImage: "arrow.down.circle")
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .disabled(browser.currentUrl == nil)
      .help("直接下载当前页面对应的视频或图文")

      HStack(spacing: 6) {
        Button(action: browser.copyCurrentLink) {
          Image(systemName: browser.copiedLink ? "checkmark" : "link")
            .foregroundStyle(browser.copiedLink ? Color.green : Color.primary)
        }
        .disabled(browser.currentUrl == nil)
        .help(browser.copiedLink ? "已复制链接" : "复制当前链接")

        Button(action: browser.openInDefaultBrowser) {
          Image(systemName: "arrow.up.forward.app")
            .foregroundStyle(browser.currentUrl == nil ? Color.secondary.opacity(0.45) : Color.primary)
        }
        .disabled(browser.currentUrl == nil)
        .help("在默认浏览器中打开")
      }
      .buttonStyle(.borderless)

      signInBadge

      Button(action: browser.toggleSidePanel) {
        HStack(spacing: 4) {
          Image(systemName: "sidebar.right")
          if detectedBadgeCount > 0 {
            Text("\(detectedBadgeCount)")
              .font(.caption2.weight(.semibold)).monospacedDigit()
              .foregroundStyle(.white)
              .padding(.horizontal, 5).padding(.vertical, 1)
              .background(Capsule().fill(fetchyAccent))
          }
        }
        .foregroundStyle(browser.showSidePanel ? fetchyAccent : .primary)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .help(browser.showSidePanel ? "收起右侧媒体栏 (⌘\\)" : "展开右侧媒体栏 (⌘\\)")
    }
    .padding(.horizontal, 12).padding(.vertical, 7)
  }

  private var addressLeadingSymbol: String {
    if browser.showingStartPage { return "magnifyingglass" }
    if browser.currentUrl?.scheme == "https" { return "lock.fill" }
    return "globe"
  }

  @ViewBuilder private var progressBar: some View {
    if browser.isLoading && !browser.showingStartPage {
      GeometryReader { geo in
        Rectangle()
          .fill(fetchyAccent)
          .frame(width: max(18, geo.size.width * min(1.0, max(0.06, browser.estimatedProgress))))
          .animation(.easeOut(duration: 0.18), value: browser.estimatedProgress)
      }
      .frame(height: 2)
    } else {
      Color.clear.frame(height: 0)
    }
  }

  private var bookmarksBar: some View {
    VStack(spacing: 0) {
      Divider().opacity(0.6)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(platformShortcuts) { shortcut in
            let active = !browser.showingStartPage && browser.site?.site == shortcut.site
            Button {
              browser.openFavorites(shortcut)
            } label: {
              HStack(spacing: 4) {
                Image(systemName: shortcut.symbol)
                  .font(.caption2)
                Text(shortcut.label)
                  .font(.caption.weight(active ? .semibold : .regular))
              }
              .foregroundStyle(active ? fetchyAccent : .primary)
              .padding(.horizontal, 8).padding(.vertical, 4)
              .background(
                Capsule().fill(
                  active ? fetchyAccent.opacity(0.14) : Color.primary.opacity(0.05))
              )
            }
            .buttonStyle(.plain)
            .help("打开 \(shortcut.label) · \(shortcut.favoritesLabel)")
            .contextMenu {
              Button("打开\(shortcut.favoritesLabel)") {
                browser.openFavorites(shortcut)
              }
              Button("打开\(shortcut.label)主页") {
                browser.go(shortcut.homeUrl)
              }
              Divider()
              Button("在默认浏览器打开") {
                if let url = URL(string: shortcut.url) { NSWorkspace.shared.open(url) }
              }
            }
          }
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
      }
      .background(.bar)
    }
  }

  @ViewBuilder private var statusBanner: some View {
    if let errorText = browser.loadError {
      HStack(spacing: 10) {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(.orange)
        Text("页面加载失败：\(errorText)")
          .font(.callout)
          .lineLimit(2)
        Spacer()
        Button("重试") { browser.reload() }
          .controlSize(.small)
        if browser.currentUrl != nil {
          Button("默认浏览器打开") { browser.openInDefaultBrowser() }
            .controlSize(.small)
        }
        Button {
          browser.loadError = nil
        } label: {
          Image(systemName: "xmark").font(.caption)
        }
        .buttonStyle(.plain).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 12).padding(.vertical, 7)
      .background(Color.orange.opacity(0.1))
    } else if !browser.notice.isEmpty {
      HStack(spacing: 10) {
        Text(browser.notice).font(.callout).foregroundStyle(.secondary)
        Spacer()
        if browser.showOpenDownloads {
          Button("查看下载") { browser.onOpenDownloads?() }
            .buttonStyle(.link).controlSize(.small)
        }
        if browser.showOpenDownloadsFolder {
          Button("打开下载文件夹") { browser.downloads?.openDownloadsFolder() }
            .buttonStyle(.link).controlSize(.small)
        }
        Button {
          if browser.pendingFavoritesShortcut != nil {
            browser.cancelPendingFavorites(clearNotice: true)
          } else {
            browser.notice = ""
            browser.showOpenDownloads = false
            browser.showOpenDownloadsFolder = false
          }
        } label: {
          Image(systemName: "xmark").font(.caption)
        }
        .buttonStyle(.plain).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 12).padding(.vertical, 6)
      .background(Color.primary.opacity(0.035))
    }
  }

  var startPage: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 6) {
          Text("快捷打开收藏夹").font(.title2.bold())
          Text("点击任意平台直接进入收藏夹/书签；也可以在上方地址栏输入网址或关键词，播放任意网页视频时右侧栏会自动嗅探媒体。")
            .font(.callout).foregroundStyle(.secondary)
        }
        LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
          ForEach(platformShortcuts) { shortcut in
            Button {
              browser.openFavorites(shortcut)
            } label: {
              HStack(spacing: 12) {
                Image(systemName: shortcut.symbol)
                  .font(.title3)
                  .foregroundStyle(fetchyAccent)
                  .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 2) {
                  Text(shortcut.label).font(.headline).foregroundStyle(.primary)
                  Text(shortcut.favoritesLabel).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
              }
              .padding(12)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(Color(nsColor: .controlBackgroundColor))
              )
              .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .stroke(Color(nsColor: .separatorColor).opacity(0.6), lineWidth: 1)
              )
            }
            .buttonStyle(.plain)
            .contextMenu {
              Button("打开\(shortcut.favoritesLabel)") { browser.openFavorites(shortcut) }
              Button("打开\(shortcut.label)主页") { browser.go(shortcut.homeUrl) }
            }
          }
        }
      }
      .padding(28)
      .frame(maxWidth: 820, alignment: .leading)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder var signInBadge: some View {
    if !browser.showingStartPage, let site = browser.site {
      let text =
        browser.signedIn == true ? "已登录" : browser.signedIn == false ? "未登录" : "检查中"
      Label(
        site.label + " · " + text,
        systemImage: browser.signedIn == true ? "checkmark.seal" : "person"
      )
      .font(.caption).foregroundStyle(browser.signedIn == true ? Color.green : Color.secondary)
      .lineLimit(1).help("登录状态按本站在 Fetchy 里的登录信息判断")
    }
  }
}

struct LinkRow: Identifiable {
  let label: String
  let url: String
  var id: String { url }
}

struct SniffedMedia: Identifiable, Equatable {
  let url: String
  let type: String
  let title: String
  let posterUrl: URL?
  let host: String
  let size: Int64
  let duration: Double
  let width: Int
  let height: Int

  var id: String { url }

  init?(_ row: [String: Any]) {
    guard let url = row["url"] as? String, !url.isEmpty else { return nil }
    self.url = url
    type = (row["type"] as? String ?? "video").lowercased()
    title = (row["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if let rawPoster = row["poster"] as? String, !rawPoster.isEmpty,
      let parsed = URL(string: rawPoster), parsed.scheme == "https"
    {
      posterUrl = parsed
    } else {
      posterUrl = nil
    }
    host = row["host"] as? String ?? (URL(string: url)?.host ?? "")
    size = (row["size"] as? NSNumber)?.int64Value ?? 0
    duration = (row["duration"] as? NSNumber)?.doubleValue ?? 0
    width = (row["width"] as? NSNumber)?.intValue ?? 0
    height = (row["height"] as? NSNumber)?.intValue ?? 0
  }

  var typeBadge: String {
    switch type {
    case "hls": return "HLS"
    case "dash": return "DASH"
    case "audio": return "音频"
    default: return "视频"
    }
  }

  var displayTitle: String {
    if !title.isEmpty { return title }
    if let name = URL(string: url)?.lastPathComponent, !name.isEmpty, name != "/" {
      return name
    }
    return host.isEmpty ? url : host
  }

  var metaText: String {
    var parts: [String] = []
    if width > 0 && height > 0 { parts.append("\(width)×\(height)") }
    if duration > 0 && duration.isFinite {
      let totalSeconds = Int(duration.rounded())
      parts.append(String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60))
    }
    if size > 0 {
      parts.append(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
    }
    if !host.isEmpty { parts.append(host) }
    return parts.joined(separator: " · ")
  }
}

struct PanelItem: Identifiable {
  let id: String
  let title: String
  let author: String
  let coverUrl: URL?
  let isVideo: Bool
  let raw: [String: Any]
}

private func cleanManifestRaw(_ raw: [String: Any]) -> [String: Any] {
  var copy = raw
  copy.removeValue(forKey: "cover")
  copy.removeValue(forKey: "mediaHint")
  return copy
}

private func normalizedPostReadUrl(_ raw: String) -> String {
  guard var comps = URLComponents(string: raw),
    let host = comps.host?.lowercased(),
    host == "www.xiaohongshu.com" || host == "xiaohongshu.com" || host == "www.rednote.com"
      || host == "rednote.com"
  else { return raw }
  let parts = comps.path.split(separator: "/").map(String.init)
  // Rewrite /user/profile/<uid>/<noteId>, /board/<bid>/<noteId>, or /discovery/item/<noteId> -> /explore/<noteId>
  if parts.count == 4 && parts[0] == "user" && parts[1] == "profile" && parts[3].count == 24 {
    comps.path = "/explore/\(parts[3])"
    return comps.string ?? raw
  }
  if parts.count == 3 && ((parts[0] == "board") || (parts[0] == "discovery" && parts[1] == "item"))
    && parts[2].count == 24
  {
    comps.path = "/explore/\(parts[2])"
    return comps.string ?? raw
  }
  return raw
}

/// Side column for the built-in browser: recognizes posts/collections/feeds and continuously sniffs media.
@MainActor final class SitePanelModel: ObservableObject {
  weak var browser: BrowserModel?
  @Published var kind = "none"
  @Published var postTitle = ""
  @Published var postMeta = ""
  @Published var postPreview = ""
  @Published var folderName = ""
  @Published var items: [PanelItem] = []
  @Published var selected: Set<String> = []
  @Published var queuedItemIds: Set<String> = []
  @Published var total: Int?
  @Published var complete = false
  @Published var reason: String?
  @Published var reading = false
  @Published var autoReading = false
  @Published var submitting = false
  @Published var folders: [LinkRow] = []
  @Published var media: [SniffedMedia] = []
  @Published var selectedMedia: Set<String> = []
  @Published var queuedMediaUrls: Set<String> = []
  @Published var notice = ""
  @Published var showOpenDownloads = false
  private var post: [String: Any]?
  private var folder: [String: Any] = [:]
  private var pages: [[String]] = []
  private var provider: String?
  private var nextUrl: String?
  private var nextPage: Int?
  private var stalled = 0
  private var origin: String?
  private var stopRequested = false
  private var sync: Task<Void, Never>?
  private var mediaTask: Task<Void, Never>?
  private var generation = 0
  private var commands: LocalCommands { browser?.commands ?? LocalCommands() }

  func reset() {
    generation += 1
    sync?.cancel()
    sync = nil
    mediaTask?.cancel()
    mediaTask = nil
    kind = "none"
    items = []
    selected = []
    queuedItemIds = []
    pages = []
    post = nil
    media = []
    selectedMedia = []
    queuedMediaUrls = []
    folders = []
    reason = nil
    complete = false
    total = nil
    stalled = 0
    submitting = false
    notice = ""
    showOpenDownloads = false
  }

  func pageChanged() {
    // Reading the next page of a collection navigates; that is part of the read, not a new page.
    if reading { return }
    reset()
    let mine = generation
    Task { await inspect(mine) }
  }

  private func applySnapshot(_ snap: [String: Any], mine: Int) {
    guard mine == generation else { return }
    switch snap["type"] as? String {
    case "post":
      guard let entry = snap["entry"] as? [String: Any] else { return }
      post = entry
      kind = "post"
      items = []
      selected = []
      pages = []
      folder = [:]
      folderName = ""
      provider = nil
      reason = nil
      complete = false
      total = nil
      stalled = 0
      let attachments = entry["attachments"] as? [[String: Any]] ?? []
      let images = attachments.filter { $0["kind"] as? String == "image" }.count
      let videos = attachments.filter { $0["kind"] as? String == "video" }.count
      postTitle =
        (entry["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        ?? (entry["id"] as? String ?? "")
      postMeta = [
        entry["author"] as? String ?? "",
        entry["bodyComplete"] as? Bool == true ? "正文完整" : "正文可能不完整",
        "\(images) 张图片", "\(videos) 个视频",
      ].filter { !$0.isEmpty }.joined(separator: " · ")
      postPreview = String((entry["body"] as? String ?? "").prefix(280))
    case "collection":
      items = []
      selected = []
      pages = []
      reason = nil
      complete = false
      total = nil
      stalled = 0
      nextUrl = nil
      nextPage = nil
      folder = snap["folder"] as? [String: Any] ?? [:]
      folderName = folder["name"] as? String ?? folder["id"] as? String ?? ""
      provider = snap["provider"] as? String
      kind = "collection"
      _ = merge(snap)
      selected = Set(items.map(\.id))
    case "folders":
      kind = "folders"
      items = []
      selected = []
      pages = []
      folder = [:]
      folderName = ""
      provider = snap["provider"] as? String
      reason = nil
      complete = false
      total = nil
      stalled = 0
      folders = (snap["folders"] as? [[String: Any]] ?? []).compactMap { row in
        guard let url = row["url"] as? String else { return nil }
        return LinkRow(label: row["name"] as? String ?? url, url: url)
      }
    default:
      kind = "none"
    }
  }

  private func inspect(_ mine: Int) async {
    guard let browser, let url = browser.webView?.url, ["https", "http"].contains(url.scheme ?? "") else { return }
    origin = (url.scheme ?? "") + "://" + (url.host ?? "")
    // Continuously sniff playable media on ANY page (never gated on collection/post detection).
    startMediaSniff(mine)
    // Like the extension, wait for pages that render their content after loading.
    var found: [String: Any]?
    for _ in 0..<15 {
      found = try? await browser.runTool("capture") as? [String: Any]
      guard mine == generation else { return }
      let reason = found?["reason"] as? String ?? ""
      guard found?["type"] as? String == "unsupported",
        ["source_not_ready", "page_access"].contains(reason)
      else { break }
      try? await Task.sleep(nanoseconds: 350_000_000)
    }
    guard mine == generation else { return }
    if let snap = found {
      applySnapshot(snap, mine: mine)
    }
    // Bilibili pages come from its API, not from the page; a sync would rewind them.
    if provider != "bilibili" { startSync(mine) }
  }

  private func startMediaSniff(_ mine: Int) {
    mediaTask?.cancel()
    mediaTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, mine == self.generation, let browser = self.browser else { return }
        if let found = try? await browser.runTool("media") as? [String: Any],
          mine == self.generation
        {
          let rows = found["items"] as? [[String: Any]] ?? []
          var seen = Set<String>()
          var next: [SniffedMedia] = []
          for row in rows {
            guard let item = SniffedMedia(row), seen.insert(item.url).inserted else { continue }
            next.append(item)
          }
          if next != self.media {
            let oldUrls = Set(self.media.map(\.url))
            self.media = next
            for item in next where !oldUrls.contains(item.url) {
              self.selectedMedia.insert(item.url)
            }
          }
        }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
      }
    }
  }

  private func key(_ row: [String: Any]) -> String? {
    guard let platform = row["platform"] as? String, let id = row["id"] as? String else {
      return nil
    }
    return platform + ":" + id
  }

  /// Mirrors mergePage in extension/archive-source.mjs.
  private func merge(_ page: [String: Any]) -> Int {
    guard page["type"] as? String == "collection",
      let pageFolder = page["folder"] as? [String: Any],
      pageFolder["id"] as? String == folder["id"] as? String
    else {
      reason = "identity_mismatch"
      return 0
    }
    var added: [String] = []
    let known = Set(items.map(\.id))
    for row in page["items"] as? [[String: Any]] ?? [] {
      guard let k = key(row), !known.contains(k), !added.contains(k) else { continue }
      added.append(k)
      let coverUrl: URL? = (row["cover"] as? String).flatMap { raw in
        guard !raw.isEmpty, let u = URL(string: raw), u.scheme == "https" else { return nil }
        return u
      }
      let isVideo =
        (row["kind"] as? String == "video") || (row["mediaHint"] as? String == "video")
      items.append(
        PanelItem(
          id: k,
          title: (row["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? k,
          author: row["author"] as? String ?? "",
          coverUrl: coverUrl,
          isVideo: isVideo,
          raw: row))
    }
    if !added.isEmpty {
      stalled = 0
      if reason == "end_unconfirmed" || reason == "network_error" { reason = nil }
    }
    if !added.isEmpty || pages.isEmpty { pages.append(added) }
    if let value = page["total"] as? Int { total = value }
    nextUrl = page["nextUrl"] as? String
    nextPage = page["nextPage"] as? Int
    if page["complete"] as? Bool == true && (total == nil || items.count == total) {
      complete = true
      reason = nil
    }
    if items.count >= 5000 && !complete { reason = "item_limit" }
    return added.count
  }

  var atEnd: Bool {
    complete
      || ["end_unconfirmed", "item_limit", "identity_mismatch", "repeated_cursor", "count_mismatch"]
        .contains(reason ?? "")
  }

  var canReadMore: Bool {
    !reading && !complete && reason != "item_limit"
  }

  private func startSync(_ mine: Int) {
    sync?.cancel()
    sync = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        guard let self, mine == self.generation, !self.reading,
          self.provider != "bilibili",
          let page = try? await self.browser?.runTool("capture") as? [String: Any],
          mine == self.generation
        else { continue }
        let snapType = page["type"] as? String ?? ""
        if snapType == "unsupported" {
          // Transient layout / modal / hydration states must never poison the active collection.
          continue
        }
        if snapType == "collection" {
          let pageFolderId = (page["folder"] as? [String: Any])?["id"] as? String
          let currentFolderId = self.folder["id"] as? String
          if self.kind == "collection" && pageFolderId == currentFolderId {
            let before = self.items.count
            if self.merge(page) > 0 {
              for item in self.items[before...] { self.selected.insert(item.id) }
            }
          } else {
            // In-page tab switch (e.g. XHS profile tabs or channel switch): smoothly adopt new collection.
            self.applySnapshot(page, mine: mine)
          }
        } else if snapType == "folders" && self.kind != "folders" {
          self.applySnapshot(page, mine: mine)
        } else if snapType == "post" && self.kind != "post" {
          self.applySnapshot(page, mine: mine)
        }
      }
    }
  }

  /// One more screen: scroll the page, load the site's next page, or ask Bilibili for the next page.
  func readMore(fromTop: Bool = false) async {
    guard let browser else { return }
    reading = true
    defer { reading = false }
    if !autoReading {
      stalled = 0
      if reason == "end_unconfirmed" || reason == "network_error" || reason == "identity_mismatch" {
        reason = nil
      }
    }
    let before = items.count
    do {
      if provider == "bilibili" {
        guard let pageNumber = nextPage else {
          reason = "count_mismatch"
          return
        }
        let result =
          try await browser.runTool(
            "bilibili", ["folderId": folder["id"] as? String ?? "", "page": pageNumber])
          as? [String: Any] ?? [:]
        if let error = result["error"] as? String {
          reason = error
          return
        }
        var loaded = result
        loaded["provider"] = "bilibili"
        _ = merge(loaded)
      } else if let next = nextUrl {
        guard let url = URL(string: next), url.scheme == "https",
          (url.scheme ?? "") + "://" + (url.host ?? "") == origin
        else {
          reason = "repeated_cursor"
          return
        }
        browser.webView?.load(URLRequest(url: url))
        for _ in 0..<80 {
          try await Task.sleep(nanoseconds: 250_000_000)
          if browser.webView?.url == url && browser.isLoading == false { break }
        }
        if let page = try? await browser.runTool("capture") as? [String: Any],
          page["type"] as? String == "collection"
        { _ = merge(page) }
      } else {
        let scroll =
          try await browser.runTool("advance", ["fromTop": fromTop]) as? [String: Any] ?? [:]
        try await Task.sleep(nanoseconds: 900_000_000)
        var added = 0
        if let page = try? await browser.runTool("capture") as? [String: Any],
          page["type"] as? String == "collection"
        { added = merge(page) }
        let moved =
          fromTop
          || ((scroll["position"] as? Double ?? 0) > (scroll["before"] as? Double ?? 0) + 1)
        if added == 0 {
          // Give slower pagination APIs (such as Xiaohongshu favorites) a second beat to render.
          try await Task.sleep(nanoseconds: 650_000_000)
          if let page = try? await browser.runTool("capture") as? [String: Any],
            page["type"] as? String == "collection"
          { added = merge(page) }
        }
        stalled = added > 0 || moved ? 0 : stalled + 1
        if stalled >= 3 && !complete {
          complete = total != nil && items.count == total
          reason = complete ? nil : "end_unconfirmed"
        }
      }
    } catch {
      reason = "network_error"
    }
    if items.count > before { for item in items[before...] { selected.insert(item.id) } }
  }

  func readAll() async {
    autoReading = true
    stopRequested = false
    stalled = 0
    if reason == "end_unconfirmed" || reason == "network_error" || reason == "identity_mismatch" {
      reason = nil
    }
    defer { autoReading = false }
    if nextUrl == nil && provider != "bilibili" && items.isEmpty { await readMore(fromTop: true) }
    while !stopRequested && !atEnd && kind == "collection" { await readMore() }
  }

  func stop() { stopRequested = true }

  private func run(_ args: [String], payload: Any? = nil) async throws -> Any {
    try await commands.run(args, bridge: true, payload: payload.flatMap(json))
  }

  private func feedItems(taskId: String, keys: [String], byKey: [String: PanelItem]) async {
    guard let browser else { return }
    let needsRead: [String] = keys.filter { k in
      guard let item = byKey[k] else { return false }
      let rawKind = item.raw["kind"] as? String ?? "post"
      let body = item.raw["body"] as? String ?? ""
      let attachments = item.raw["attachments"] as? [Any] ?? []
      return rawKind != "video" && body.isEmpty && attachments.isEmpty
    }
    for (index, k) in needsRead.enumerated() {
      guard let item = byKey[k] else { continue }
      let rawUrl = item.raw["visitUrl"] as? String ?? item.raw["sourceUrl"] as? String ?? ""
      let url = normalizedPostReadUrl(rawUrl)
      var page: [String: Any] = ["id": taskId, "key": k, "skip": true]
      let current = browser.webView?.url.map { ($0.scheme ?? "") + "://" + ($0.host ?? "") }
      if current == origin, let target = URL(string: url),
        (target.scheme ?? "") + "://" + (target.host ?? "") == origin,
        let read = try? await browser.runTool("readPost", ["url": url, "maxBytes": 2_000_000])
          as? [String: Any], read["error"] == nil, let html = read["html"] as? String, !html.isEmpty
      {
        page = [
          "id": taskId, "key": k, "url": read["url"] as? String ?? url, "html": html,
          "userAgent": read["userAgent"] as? String ?? "",
        ]
      }
      for attempt in 0..<30 {
        if (try? await run(["page"], payload: page)) != nil { break }
        if attempt < 29 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
      }
      if needsRead.count > 1 {
        notice = "正在读取原帖 \(index + 1) / \(needsRead.count)…"
        if index + 1 < needsRead.count {
          try? await Task.sleep(nanoseconds: 350_000_000)
        }
      }
    }
    _ = try? await run(["feed-end", taskId])
  }

  func savePost() async {
    guard !submitting else { return }
    submitting = true
    defer { submitting = false }
    guard let browser, let snap = try? await browser.runTool("capture") as? [String: Any],
      let entry = snap["entry"] as? [String: Any], key(entry) == post.flatMap(key)
    else {
      notice = "页面已切换，请重新打开帖子。"
      showOpenDownloads = false
      return
    }
    do {
      _ = try await run(
        ["start"], payload: ["manifest": ["version": 1, "items": [cleanManifestRaw(entry)]]])
      await browser.downloads?.refresh()
      notice = "已加入下载队列，文件将直接保存到下载文件夹。"
      showOpenDownloads = true
    } catch {
      notice = error.localizedDescription
      showOpenDownloads = false
    }
  }

  /// Download a single card directly from the feed / favorites preview panel.
  func saveSingleItem(_ item: PanelItem) async {
    guard let browser else { return }
    guard queuedItemIds.insert(item.id).inserted else { return }
    let entry = cleanManifestRaw(item.raw)
    let rawKind = entry["kind"] as? String ?? "post"
    let needsFeed =
      rawKind != "video" && (entry["body"] as? String ?? "").isEmpty
      && (entry["attachments"] as? [Any] ?? []).isEmpty
    let task: [String: Any]
    do {
      guard
        let started = try await run(
          ["start"],
          payload: [
            "manifest": ["version": 1, "items": [entry]],
            "selected": [item.id],
            "feed": needsFeed,
          ]) as? [String: Any], started["id"] is String
      else { throw FetchyFailure(text: "本机没有建立下载任务。") }
      task = started
    } catch {
      queuedItemIds.remove(item.id)
      notice = error.localizedDescription
      showOpenDownloads = false
      return
    }
    await browser.downloads?.refresh()
    if needsFeed, let id = task["id"] as? String {
      await feedItems(taskId: id, keys: [item.id], byKey: [item.id: item])
      await browser.downloads?.refresh()
    }
    notice = "已加入下载队列：\(item.title)"
    showOpenDownloads = true
  }

  /// The task exists before any post is read; this column then reads each post page with a
  /// same-site request from the open page and hands it to the native worker.
  func saveSelected() async {
    guard !submitting, let browser else { return }
    let keys = items.map(\.id).filter { selected.contains($0) }
    guard !keys.isEmpty else { return }
    submitting = true
    defer { submitting = false }
    let byKey = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
    // Mirrors manifestFolder in extension/archive-source.mjs.
    var manifestPages: [[String: Any]] = []
    for (index, list) in pages.enumerated() {
      let cursor: Any = index == 0 ? NSNull() : "page-\(index)"
      let next: Any
      if index + 1 < pages.count {
        next = "page-\(index + 1)"
      } else if complete {
        next = NSNull()
      } else {
        next = "unread"
      }
      manifestPages.append([
        "cursor": cursor, "nextCursor": next,
        "items": list.compactMap { byKey[$0].map { cleanManifestRaw($0.raw) } },
      ])
    }
    var manifestFolder = folder
    manifestFolder["total"] = total.map { $0 as Any } ?? NSNull()
    manifestFolder["pages"] = manifestPages
    let task: [String: Any]
    do {
      guard
        let started = try await run(
          ["start"],
          payload: [
            "manifest": ["version": 1, "folders": [manifestFolder]], "selected": keys, "feed": true,
          ])
          as? [String: Any], started["id"] is String
      else { throw FetchyFailure(text: "本机没有建立下载任务。") }
      task = started
    } catch {
      notice = error.localizedDescription
      showOpenDownloads = false
      return
    }
    for k in keys { queuedItemIds.insert(k) }
    await browser.downloads?.refresh()
    let id = task["id"] as! String
    notice = "已加入队列，正在读取原帖…"
    showOpenDownloads = true
    await feedItems(taskId: id, keys: keys, byKey: byKey)
    await browser.downloads?.refresh()
    notice = "已加入下载队列（\(keys.count) 条），进度可在「下载」页逐条查看。"
    showOpenDownloads = true
  }

  func saveMedia(_ item: SniffedMedia) async {
    guard let browser, let downloads = browser.downloads else { return }
    guard queuedMediaUrls.insert(item.url).inserted else { return }
    let pageUrl = browser.webView?.url?.absoluteString
    let title = item.title.isEmpty ? browser.webView?.title : item.title
    let ok = await downloads.startUrlDownload(
      item.url, title: title, referer: pageUrl, pageUrl: pageUrl)
    if ok {
      notice = "已加入下载队列：\(item.displayTitle)"
      showOpenDownloads = true
    } else {
      queuedMediaUrls.remove(item.url)
      notice = downloads.notice.isEmpty ? "下载失败，请重试。" : downloads.notice
      showOpenDownloads = false
    }
  }

  func saveSelectedMedia() async {
    for item in media
    where selectedMedia.contains(item.url) && !queuedMediaUrls.contains(item.url) {
      await saveMedia(item)
    }
  }

  func openFolder(_ url: String) {
    guard let view = browser?.webView, let target = URL(string: url) else { return }
    view.load(URLRequest(url: target))
  }
}

struct MediaThumbView: View {
  let url: URL?
  let isVideo: Bool
  let isAudio: Bool

  init(url: URL?, isVideo: Bool = false, isAudio: Bool = false) {
    self.url = url
    self.isVideo = isVideo
    self.isAudio = isAudio
  }

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      Group {
        if let url {
          AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
              image.resizable().scaledToFill()
            default:
              placeholder
            }
          }
        } else {
          placeholder
        }
      }
      .frame(width: 64, height: 46)
      .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 0.75)
      )

      if isVideo {
        Image(systemName: "play.fill")
          .font(.system(size: 8, weight: .bold))
          .foregroundStyle(.white)
          .padding(3.5)
          .background(Color.black.opacity(0.62), in: Circle())
          .padding(3)
      }
    }
  }

  private var placeholder: some View {
    ZStack {
      Color(nsColor: .quaternaryLabelColor).opacity(0.25)
      Image(systemName: isAudio ? "waveform" : (isVideo ? "film" : "photo"))
        .font(.callout)
        .foregroundStyle(.secondary)
    }
  }
}

struct SitePanel: View {
  @ObservedObject var panel: SitePanelModel
  private let reasons = [
    "end_unconfirmed": "没有更多了，但网站未显示末尾", "identity_mismatch": "页面已切换到别的收藏夹",
    "item_limit": "已读到 5000 条上限", "repeated_cursor": "分页链接异常，已停止",
    "count_mismatch": "读到的条数与网站总数不符", "network_error": "读取下一页失败",
  ]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        switch panel.kind {
        case "post": postSection
        case "collection": collectionSection
        case "folders": foldersSection
        default:
          if panel.media.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Label("正在监听当前网页", systemImage: "waveform.badge.magnifyingglass")
                .font(.headline)
              Text("打开支持平台的发现页、收藏夹或播放任意视频时，下方会自动出现带封面预览的可下载列表；也可以直接点工具栏「下载此页」。")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
        }
        if !panel.notice.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            Text(panel.notice).font(.callout).fixedSize(horizontal: false, vertical: true)
            if panel.showOpenDownloads {
              Button("查看下载进度") { panel.browser?.onOpenDownloads?() }
                .buttonStyle(.link).controlSize(.small)
            }
          }
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(fetchyAccent.opacity(0.08))
          )
        }
        if !panel.media.isEmpty {
          if panel.kind != "none" || !panel.notice.isEmpty { Divider() }
          sniffedMediaSection
        }
      }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  var postSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(panel.postTitle).font(.headline).lineLimit(3)
      Text(panel.postMeta).font(.caption).foregroundStyle(.secondary)
      if !panel.postPreview.isEmpty {
        Text(panel.postPreview).font(.callout).lineLimit(5).foregroundStyle(.secondary)
      }
      Button(panel.submitting ? "正在加入队列…" : "下载这篇帖子") {
        Task { await panel.savePost() }
      }
      .buttonStyle(.borderedProminent)
      .disabled(panel.submitting)
    }
  }

  var collectionSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text(panel.folderName).font(.headline).lineLimit(2)
        Text(
          "已识别 \(panel.items.count) 条"
            + (panel.total.map { " / 共 \($0) 条" } ?? "")
            + " · "
            + (panel.complete ? "已读到末尾" : panel.reason.flatMap { reasons[$0] } ?? "滚动页面可继续加载")
        ).font(.caption).foregroundStyle(.secondary)
      }

      HStack(spacing: 8) {
        Toggle(
          "全选 (\(panel.selected.count)/\(panel.items.count))",
          isOn: Binding(
            get: { !panel.items.isEmpty && panel.selected.count == panel.items.count },
            set: { panel.selected = $0 ? Set(panel.items.map(\.id)) : [] })
        )
        .toggleStyle(.checkbox)
        .font(.caption)
        Spacer()
        Button(
          panel.submitting
            ? "加入中…"
            : (panel.selected.isEmpty ? "下载所选" : "下载所选 (\(panel.selected.count))")
        ) {
          Task { await panel.saveSelected() }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(panel.selected.isEmpty || panel.submitting)
      }

      HStack(spacing: 6) {
        Button("再读一屏") { Task { await panel.readMore() } }
          .controlSize(.small)
          .disabled(!panel.canReadMore)
        if panel.autoReading {
          Button("停止读取") { panel.stop() }.controlSize(.small)
        } else {
          Button("自动读到底") { Task { await panel.readAll() } }
            .controlSize(.small)
            .disabled(!panel.canReadMore)
        }
      }

      LazyVStack(alignment: .leading, spacing: 8) {
        ForEach(panel.items) { item in
          HStack(alignment: .center, spacing: 8) {
            Toggle(
              isOn: Binding(
                get: { panel.selected.contains(item.id) },
                set: { checked in
                  if checked {
                    panel.selected.insert(item.id)
                  } else {
                    panel.selected.remove(item.id)
                  }
                })
            ) { EmptyView() }
              .labelsHidden()
              .toggleStyle(.checkbox)

            MediaThumbView(url: item.coverUrl, isVideo: item.isVideo)

            VStack(alignment: .leading, spacing: 3) {
              Text(item.title)
                .font(.callout.weight(.medium))
                .lineLimit(2)
              Text(
                [item.isVideo ? "视频" : "图文", item.author]
                  .filter { !$0.isEmpty }
                  .joined(separator: " · ")
              )
              .font(.caption2)
              .foregroundStyle(.secondary)
              .lineLimit(1)
            }

            Spacer(minLength: 4)

            if panel.queuedItemIds.contains(item.id) {
              Label("已加入", systemImage: "checkmark")
                .font(.caption2)
                .foregroundStyle(.secondary)
            } else {
              Button("下载") {
                Task { await panel.saveSingleItem(item) }
              }
              .controlSize(.small)
              .buttonStyle(.bordered)
            }
          }
          .padding(8)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(Color(nsColor: .controlBackgroundColor))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 0.75)
          )
        }
      }
    }
  }

  var foldersSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("选择一个收藏夹").font(.headline)
      ForEach(panel.folders) { folder in
        Button(folder.label) { panel.openFolder(folder.url) }.buttonStyle(.link)
      }
    }
  }

  var sniffedMediaSection: some View {
    let selectedCount = panel.media.filter { panel.selectedMedia.contains($0.url) }.count
    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text("找到的媒体 (\(panel.media.count))").font(.headline)
        Spacer()
        if panel.media.count > 1 {
          Toggle(
            "全选",
            isOn: Binding(
              get: { !panel.media.isEmpty && selectedCount == panel.media.count },
              set: { panel.selectedMedia = $0 ? Set(panel.media.map(\.url)) : [] })
          )
          .toggleStyle(.checkbox)
          .font(.caption)
        }
        Button(selectedCount > 0 ? "下载所选 (\(selectedCount))" : "下载所选") {
          Task { await panel.saveSelectedMedia() }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(
          selectedCount == 0
            || panel.media.filter { panel.selectedMedia.contains($0.url) }
              .allSatisfy { panel.queuedMediaUrls.contains($0.url) }
        )
      }

      LazyVStack(alignment: .leading, spacing: 8) {
        ForEach(panel.media) { item in
          HStack(alignment: .center, spacing: 8) {
            Toggle(
              isOn: Binding(
                get: { panel.selectedMedia.contains(item.url) },
                set: { checked in
                  if checked {
                    panel.selectedMedia.insert(item.url)
                  } else {
                    panel.selectedMedia.remove(item.url)
                  }
                })
            ) { EmptyView() }
              .labelsHidden()
              .toggleStyle(.checkbox)

            MediaThumbView(
              url: item.posterUrl,
              isVideo: item.type != "audio",
              isAudio: item.type == "audio")

            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 4) {
                Text(item.typeBadge)
                  .font(.caption2.bold())
                  .padding(.horizontal, 5).padding(.vertical, 1.5)
                  .background(fetchyAccent.opacity(0.14), in: Capsule())
                  .foregroundStyle(fetchyAccent)
                Text(item.displayTitle)
                  .font(.callout.weight(.medium))
                  .lineLimit(1)
              }
              if !item.metaText.isEmpty {
                Text(item.metaText).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
              }
            }

            Spacer(minLength: 4)

            if panel.queuedMediaUrls.contains(item.url) {
              Label("已加入", systemImage: "checkmark")
                .font(.caption2)
                .foregroundStyle(.secondary)
            } else {
              Button("下载") { Task { await panel.saveMedia(item) } }
                .controlSize(.small)
                .buttonStyle(.bordered)
            }
          }
          .padding(8)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(Color(nsColor: .controlBackgroundColor))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 0.75)
          )
        }
      }
    }
  }
}
