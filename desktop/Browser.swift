import AppKit
import SwiftUI
import WebKit

/// WebKit's default user agent names no browser, and some sites (Bilibili among them) answer
/// it with an "upgrade your browser" page. Every Fetchy web view presents as this Mac's Safari.
let safariUserAgent: String = {
  let plist = URL(fileURLWithPath: "/Applications/Safari.app/Contents/Info.plist")
  let major = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
  // Safari 17 shipped with macOS 14 and 18 with 15; from macOS 26 the numbers match.
  let fallback = major >= 26 ? "\(major).0" : "\(major + 3).0"
  let version = NSDictionary(contentsOf: plist)?["CFBundleShortVersionString"] as? String ?? fallback
  return "Version/\(version) Safari/605.1.15"
}()

/// What Node knows about a site: its WebKit store and which cookies mean "signed in".
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

@MainActor final class BrowserModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
  @Published var address = ""
  @Published var canGoBack = false
  @Published var canGoForward = false
  @Published var isLoading = false
  @Published var site: SiteInfo?
  @Published var signedIn: Bool?
  @Published var notice = ""
  @Published var showOpenDownloads = false
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
  private var regionalSessionBound = false

  override init() {
    super.init()
    panel.browser = self
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

  /// Typed in the address bar or chosen elsewhere. In-page links keep the current store,
  /// so a sign-in that passes through another site stays with the site being signed in to.
  func go(_ text: String, keepPendingFavorites: Bool = false) {
    var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return }
    if !raw.contains("://") { raw = "https://" + raw }
    guard let url = URL(string: raw), let host = url.host,
      url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
    else {
      notice = "请输入 HTTPS 网址。"
      showOpenDownloads = false
      return
    }
    if !keepPendingFavorites {
      pendingFavoritesShortcut = nil
      favoritesResolveTask?.cancel()
      favoritesResolveTask = nil
    }
    notice = ""
    showOpenDownloads = false
    Task {
      do {
        let info = try await siteInfo(url.absoluteString)
        if site?.profile != info.profile || webView == nil { makeView(info) }
        site = info
        webView?.load(URLRequest(url: url))
      } catch { notice = error.localizedDescription }
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
    guard let url = webView?.url?.absoluteString, url.hasPrefix("https://") else {
      notice = "请先打开一个 HTTPS 网页。"
      showOpenDownloads = false
      return
    }
    guard let downloads else { return }
    let title = webView?.title
    let ok = await downloads.startUrlDownload(url, title: title, referer: url, pageUrl: url)
    if ok {
      notice = "已加入下载队列，文件将直接保存到下载文件夹。"
      showOpenDownloads = true
    } else if !downloads.notice.isEmpty {
      notice = downloads.notice
      showOpenDownloads = false
    }
  }

  private func makeView(_ info: SiteInfo) {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: info.profile)
    configuration.applicationNameForUserAgent = safariUserAgent
    if let snifferUrl = Bundle.main.url(forResource: "media-sniffer", withExtension: "js"),
      let snifferSource = try? String(contentsOf: snifferUrl, encoding: .utf8)
    {
      configuration.userContentController.addUserScript(
        WKUserScript(
          source: snifferSource, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    }
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    view.allowsBackForwardNavigationGestures = true
    observations = [
      view.observe(\.url, options: [.initial, .new]) { [weak self] view, _ in
        let value = view.url?.absoluteString ?? ""
        DispatchQueue.main.async {
          guard let self else { return }
          self.address = value
          // Re-inspect whenever the URL changes (including SPA routes or pages whose background
          // telemetry keeps isLoading true long after the feed is interactive).
          if !value.isEmpty && value != self.panelAddress {
            self.panelAddress = value
            self.panel.pageChanged()
          }
        }
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
    ]
    regionalCheck?.cancel()
    regionalCheck = nil
    regionalMonitor?.cancel()
    regionalSessionBound = false
    webView = view
    if info.site == "xiaohongshu" {
      // A login modal can complete without loading a new page or changing the URL.
      regionalMonitor = Task { [weak self, weak view] in
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 2_000_000_000)
          guard !Task.isCancelled, let self, let view, self.webView === view else { return }
          if NSApp.isActive, view.window?.isVisible == true, !view.isLoading {
            self.refreshSignIn()
          }
        }
      }
    }
    signedIn = nil
    panelAddress = ""
    panel.reset()
  }

  func stop() { webView?.stopLoading() }
  func back() { webView?.goBack() }
  func forward() { webView?.goForward() }
  func reload() { webView?.reload() }

  /// Signed in means one of the site's session cookies is in its store and not expired.
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
        if self?.webView === webView {
          self?.signedIn = ok
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
      if self.signedIn != status { self.signedIn = status }
    }
  }

  private func resolvePendingFavorites(_ view: WKWebView) {
    guard let shortcut = pendingFavoritesShortcut else { return }
    favoritesResolveTask?.cancel()
    favoritesResolveTask = Task { [weak self, weak view] in
      for _ in 0..<6 {
        guard !Task.isCancelled, let self, let view, self.webView === view,
          self.pendingFavoritesShortcut?.site == shortcut.site
        else { return }
        if let result = try? await self.runTool("findFavorites") as? [String: Any],
          let rawUrl = result["url"] as? String, !rawUrl.isEmpty,
          let target = URL(string: rawUrl), target.scheme == "https"
        {
          self.pendingFavoritesShortcut = nil
          if view.url?.absoluteString != target.absoluteString {
            view.load(URLRequest(url: target))
          }
          return
        }
        try? await Task.sleep(nanoseconds: 600_000_000)
      }
      guard !Task.isCancelled, let self, self.pendingFavoritesShortcut?.site == shortcut.site else {
        return
      }
      self.pendingFavoritesShortcut = nil
      self.notice = "未能自动定位「\(shortcut.label) · \(shortcut.favoritesLabel)」，请先登录后再点一次上方「收藏夹」。"
      self.showOpenDownloads = false
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
    if url.scheme == "http" && !["localhost", "127.0.0.1"].contains(url.host ?? "") {
      decisionHandler(.cancel)
      notice = "已阻止不加密的 HTTP 页面。"
      showOpenDownloads = false
      return
    }
    decisionHandler(.allow)
  }

  // Pages that open a new window (often sign-in) continue in this view and this store.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
    return nil
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    regionalCheck?.cancel()
    regionalCheck = nil
    regionalSessionBound = false
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
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
  @State private var typed = ""
  @FocusState private var editing: Bool

  private let columns = [GridItem(.adaptive(minimum: 168, maximum: 240), spacing: 12)]

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Button(action: browser.back) { Image(systemName: "chevron.left") }
          .disabled(!browser.canGoBack).help("后退")
        Button(action: browser.forward) { Image(systemName: "chevron.right") }
          .disabled(!browser.canGoForward).help("前进")
        Button(action: { browser.isLoading ? browser.stop() : browser.reload() }) {
          Image(systemName: browser.isLoading ? "xmark" : "arrow.clockwise")
        }.disabled(browser.webView == nil).help(browser.isLoading ? "停止" : "刷新")
        TextField("输入网址，例如 www.xiaohongshu.com", text: $typed)
          .textFieldStyle(.roundedBorder).focused($editing)
          .onSubmit { browser.go(typed) }
        Menu {
          ForEach(platformShortcuts) { shortcut in
            Button {
              browser.openFavorites(shortcut)
            } label: {
              Label("\(shortcut.label) · \(shortcut.favoritesLabel)", systemImage: shortcut.symbol)
            }
          }
        } label: {
          Label("收藏夹", systemImage: "star.square.on.square")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("快捷跳转到各平台收藏夹 / 书签")
        Button {
          Task { await browser.downloadCurrentPage() }
        } label: {
          Label("下载此页", systemImage: "arrow.down.circle")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(browser.webView?.url?.scheme != "https")
        .help("直接下载当前页面对应的视频或图文")
        signInBadge
      }
      .buttonStyle(.borderless).padding(.horizontal, 12).padding(.vertical, 8)
      .onChange(of: browser.address, initial: true) { _, value in if !editing { typed = value } }
      if !browser.notice.isEmpty {
        HStack(spacing: 10) {
          Text(browser.notice).font(.callout).foregroundStyle(.secondary)
          Spacer()
          if browser.showOpenDownloads {
            Button("查看下载") { browser.onOpenDownloads?() }
              .buttonStyle(.link).controlSize(.small)
          }
          Button {
            browser.notice = ""
            browser.showOpenDownloads = false
          } label: {
            Image(systemName: "xmark")
          }
          .buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12).padding(.bottom, 6)
      }
      Divider()
      HStack(spacing: 0) {
        if let view = browser.webView {
          WebViewHost(view: view)
        } else {
          startPage
        }
        Divider()
        SitePanel(panel: browser.panel).frame(width: 360)
      }
    }
    .navigationTitle(browser.site?.label ?? "浏览器")
  }

  var startPage: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 6) {
          Text("快捷打开收藏夹").font(.title2.bold())
          Text("点击任意平台直接进入收藏夹/书签；也可以在上方地址栏打开任意网页，播放视频时右侧会自动嗅探媒体。")
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
          }
        }
      }
      .padding(28)
      .frame(maxWidth: 780, alignment: .leading)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder var signInBadge: some View {
    if let site = browser.site {
      let text =
        browser.signedIn == true ? "已登录" : browser.signedIn == false ? "未登录" : "检查中"
      Label(
        site.label + " · " + text,
        systemImage: browser.signedIn == true ? "checkmark.seal" : "person"
      )
      .font(.callout).foregroundStyle(browser.signedIn == true ? Color.green : Color.secondary)
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
    guard let browser, let url = browser.webView?.url, url.scheme == "https" else { return }
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
