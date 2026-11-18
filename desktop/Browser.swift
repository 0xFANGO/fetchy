import AppKit
import SwiftUI
import WebKit

enum Pane: String, CaseIterable, Identifiable {
  case library = "资料库"
  case browser = "浏览器"
  case accounts = "账号"
  var id: String { rawValue }
  var symbol: String {
    switch self {
    case .library: return "square.grid.2x2"
    case .browser: return "globe"
    case .accounts: return "person.crop.circle"
    }
  }
}

/// What Node knows about a site: its WebKit store and which cookies mean "signed in".
struct SiteInfo: Equatable {
  let site: String
  let label: String
  let url: String
  let profile: UUID
  let hosts: [String]
  let session: [String]
}

@MainActor final class AppState: ObservableObject {
  @Published var pane: Pane = .library
  /// The accounts row to show, for example after a download found a sign-in expired.
  @Published var focusedSite: String?
  let browser = BrowserModel()

  /// Open a link in the built-in browser with its site's store; sign-in also marks the accounts row.
  func open(_ url: String, signingIn: Bool = false) {
    pane = .browser
    browser.go(url)
    if signingIn {
      Task {
        if let info = try? await browser.siteInfo(url) { focusedSite = info.site }
      }
    }
  }
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
  @Published private(set) var webView: WKWebView?
  let panel = SitePanelModel()
  let commands = LocalCommands()
  private var observations: [NSKeyValueObservation] = []

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
  func go(_ text: String) {
    var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return }
    if !raw.contains("://") { raw = "https://" + raw }
    guard let url = URL(string: raw), let host = url.host,
      url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
    else {
      notice = "请输入 HTTPS 网址。"
      return
    }
    notice = ""
    Task {
      do {
        let info = try await siteInfo(url.absoluteString)
        if site?.profile != info.profile || webView == nil { makeView(info) }
        site = info
        webView?.load(URLRequest(url: url))
      } catch { notice = error.localizedDescription }
    }
  }

  private func makeView(_ info: SiteInfo) {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: info.profile)
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    view.allowsBackForwardNavigationGestures = true
    observations = [
      view.observe(\.url, options: [.initial, .new]) { [weak self] view, _ in
        let value = view.url?.absoluteString ?? ""
        DispatchQueue.main.async { self?.address = value }
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
    webView = view
    signedIn = nil
    panel.reset()
  }

  func back() { webView?.goBack() }
  func forward() { webView?.goForward() }
  func reload() { webView?.reload() }

  /// Signed in means one of the site's session cookies is in its store and not expired.
  func refreshSignIn() {
    guard let site, let store = webView?.configuration.websiteDataStore else { return }
    store.httpCookieStore.getAllCookies { [weak self] cookies in
      let now = Date()
      let live = cookies.filter { cookie in
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        return (cookie.expiresDate.map { $0 > now } ?? true)
          && site.hosts.contains { $0 == domain || $0.hasSuffix("." + domain) }
      }
      let ok =
        site.session.isEmpty ? !live.isEmpty : live.contains { site.session.contains($0.name) }
      DispatchQueue.main.async { self?.signedIn = ok }
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

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    refreshSignIn()
    panel.pageChanged()
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

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Button(action: browser.back) { Image(systemName: "chevron.left") }
          .disabled(!browser.canGoBack).help("后退")
        Button(action: browser.forward) { Image(systemName: "chevron.right") }
          .disabled(!browser.canGoForward).help("前进")
        Button(action: browser.reload) {
          Image(systemName: browser.isLoading ? "xmark" : "arrow.clockwise")
        }.disabled(browser.webView == nil).help("刷新")
        TextField("输入网址，例如 www.xiaohongshu.com", text: $typed)
          .textFieldStyle(.roundedBorder).focused($editing)
          .onSubmit { browser.go(typed) }
        signInBadge
      }
      .buttonStyle(.borderless).padding(10)
      .onChange(of: browser.address) { _, value in if !editing { typed = value } }
      if !browser.notice.isEmpty {
        Text(browser.notice).font(.callout).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12)
      }
      Divider()
      HStack(spacing: 0) {
        if let view = browser.webView {
          WebViewHost(view: view)
        } else {
          VStack(spacing: 10) {
            Text("在地址栏输入网址，或在「账号」里选一个网站登录。").foregroundStyle(.secondary)
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        Divider()
        SitePanel(panel: browser.panel).frame(width: 320)
      }
    }
  }

  @ViewBuilder var signInBadge: some View {
    if let site = browser.site {
      let text =
        browser.signedIn == true ? "已登录" : browser.signedIn == false ? "未登录" : "检查中"
      Label(site.label + " · " + text, systemImage: browser.signedIn == true ? "checkmark.seal" : "person")
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

struct PanelItem: Identifiable {
  let id: String
  let title: String
  let isVideo: Bool
  let raw: [String: Any]
}

/// The same column as the extension's side panel, for the page open in the built-in browser.
@MainActor final class SitePanelModel: ObservableObject {
  weak var browser: BrowserModel?
  @Published var kind = "none"
  @Published var postTitle = ""
  @Published var postMeta = ""
  @Published var postPreview = ""
  @Published var folderName = ""
  @Published var items: [PanelItem] = []
  @Published var selected: Set<String> = []
  @Published var total: Int?
  @Published var complete = false
  @Published var reason: String?
  @Published var reading = false
  @Published var autoReading = false
  @Published var folders: [LinkRow] = []
  @Published var media: [LinkRow] = []
  @Published var notice = ""
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
  private var generation = 0
  private var commands: LocalCommands { browser?.commands ?? LocalCommands() }

  func reset() {
    generation += 1
    sync?.cancel()
    kind = "none"
    items = []
    selected = []
    pages = []
    post = nil
    media = []
    folders = []
    reason = nil
    complete = false
    total = nil
    stalled = 0
    notice = ""
  }

  func pageChanged() {
    // Reading the next page of a collection navigates; that is part of the read, not a new page.
    if reading { return }
    reset()
    let mine = generation
    Task { await inspect(mine) }
  }

  private func inspect(_ mine: Int) async {
    guard let browser, let url = browser.webView?.url, url.scheme == "https" else { return }
    origin = (url.scheme ?? "") + "://" + (url.host ?? "")
    guard let snap = try? await browser.runTool("capture") as? [String: Any], mine == generation
    else { return }
    switch snap["type"] as? String {
    case "post":
      guard let entry = snap["entry"] as? [String: Any] else { return }
      post = entry
      kind = "post"
      let attachments = entry["attachments"] as? [[String: Any]] ?? []
      let images = attachments.filter { $0["kind"] as? String == "image" }.count
      let videos = attachments.filter { $0["kind"] as? String == "video" }.count
      postTitle = (entry["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (entry["id"] as? String ?? "")
      postMeta = [
        entry["author"] as? String ?? "",
        entry["bodyComplete"] as? Bool == true ? "正文完整" : "正文可能不完整",
        "\(images) 张图片", "\(videos) 个视频",
      ].filter { !$0.isEmpty }.joined(separator: " · ")
      postPreview = String((entry["body"] as? String ?? "").prefix(280))
    case "collection":
      folder = snap["folder"] as? [String: Any] ?? [:]
      folderName = folder["name"] as? String ?? folder["id"] as? String ?? ""
      provider = snap["provider"] as? String
      kind = "collection"
      _ = merge(snap)
      selected = Set(items.map(\.id))
      startSync(mine)
    case "folders":
      kind = "folders"
      folders = (snap["folders"] as? [[String: Any]] ?? []).compactMap { row in
        guard let url = row["url"] as? String else { return nil }
        return LinkRow(label: row["name"] as? String ?? url, url: url)
      }
    default:
      kind = "none"
    }
    if kind != "collection", let found = try? await browser.runTool("media") as? [String: Any],
      mine == generation
    {
      media = (found["items"] as? [[String: Any]] ?? []).compactMap { row in
        guard let url = row["url"] as? String else { return nil }
        let label = (row["type"] as? String ?? "") + " · " + (row["host"] as? String ?? "")
        return LinkRow(label: label, url: url)
      }
    }
  }

  private func key(_ row: [String: Any]) -> String? {
    guard let platform = row["platform"] as? String, let id = row["id"] as? String else { return nil }
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
      items.append(
        PanelItem(
          id: k, title: (row["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? k,
          isVideo: row["kind"] as? String == "video", raw: row))
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

  private func startSync(_ mine: Int) {
    sync?.cancel()
    sync = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard let self, mine == self.generation, !self.reading,
          let page = try? await self.browser?.runTool("capture") as? [String: Any]
        else { continue }
        let before = self.items.count
        if self.merge(page) > 0 { for item in self.items[before...] { self.selected.insert(item.id) } }
      }
    }
  }

  /// One more screen: scroll the page, load the site's next page, or ask Bilibili for the next page.
  func readMore(fromTop: Bool = false) async {
    guard let browser else { return }
    reading = true
    defer { reading = false }
    let before = items.count
    do {
      if provider == "bilibili" {
        guard let page = nextPage else {
          reason = "count_mismatch"
          return
        }
        let result =
          try await browser.runTool("bilibili", ["folderId": folder["id"] as? String ?? "", "page": page])
          as? [String: Any] ?? [:]
        if let error = result["error"] as? String {
          reason = error
          return
        }
        var page = result
        page["provider"] = "bilibili"
        _ = merge(page)
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
        if let page = try await browser.runTool("capture") as? [String: Any] { _ = merge(page) }
      } else {
        let scroll = try await browser.runTool("advance", ["fromTop": fromTop]) as? [String: Any] ?? [:]
        try await Task.sleep(nanoseconds: 850_000_000)
        var added = 0
        if let page = try await browser.runTool("capture") as? [String: Any] { added = merge(page) }
        let moved =
          fromTop
          || ((scroll["position"] as? Double ?? 0) > (scroll["before"] as? Double ?? 0) + 1)
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
    defer { autoReading = false }
    if nextUrl == nil && provider != "bilibili" { await readMore(fromTop: true) }
    while !stopRequested && !atEnd && kind == "collection" { await readMore() }
  }

  func stop() { stopRequested = true }

  private func run(_ args: [String], payload: Any? = nil) async throws -> Any {
    try await commands.run(args, bridge: true, payload: payload.flatMap(json))
  }

  func savePost() async {
    guard let browser, let snap = try? await browser.runTool("capture") as? [String: Any],
      let entry = snap["entry"] as? [String: Any], key(entry) == post.flatMap(key)
    else {
      notice = "页面已切换，请重新打开帖子。"
      return
    }
    do {
      let task = try await run(["start"], payload: ["manifest": ["version": 1, "items": [entry]]])
      notice = "已交给本机保存。进度在「资料库 · 进行中与失败」。"
      _ = task
    } catch { notice = error.localizedDescription }
  }

  /// The task exists before any post is read; this column then reads each post page with a
  /// same-site request from the open page and hands it to the native worker.
  func saveSelected() async {
    guard let browser else { return }
    let keys = items.map(\.id).filter { selected.contains($0) }
    guard !keys.isEmpty else { return }
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
        "cursor": cursor, "nextCursor": next, "items": list.compactMap { byKey[$0]?.raw },
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
          payload: ["manifest": ["version": 1, "folders": [manifestFolder]], "selected": keys, "feed": true])
          as? [String: Any], started["id"] is String
      else { throw FetchyFailure(text: "本机没有建立任务。") }
      task = started
    } catch {
      notice = error.localizedDescription
      return
    }
    let id = task["id"] as! String
    notice = "已建立任务，正在读取原帖 0 / \(keys.count)…"
    for (index, k) in keys.enumerated() {
      // Only rows without text or files are read from their post page (see needsDetails).
      guard let item = byKey[k], !item.isVideo, (item.raw["body"] as? String ?? "").isEmpty,
        (item.raw["attachments"] as? [Any] ?? []).isEmpty
      else { continue }
      let url = item.raw["visitUrl"] as? String ?? item.raw["sourceUrl"] as? String ?? ""
      var page: [String: Any] = ["id": id, "key": k, "skip": true]
      let current = browser.webView?.url.map { ($0.scheme ?? "") + "://" + ($0.host ?? "") }
      if current == origin, let target = URL(string: url),
        (target.scheme ?? "") + "://" + (target.host ?? "") == origin,
        let read = try? await browser.runTool("readPost", ["url": url, "maxBytes": 450_000])
          as? [String: Any], let html = read["html"] as? String
      {
        page = [
          "id": id, "key": k, "url": read["url"] as? String ?? url, "html": html,
          "userAgent": read["userAgent"] as? String ?? "",
        ]
      }
      for attempt in 0..<3 {
        if (try? await run(["page"], payload: page)) != nil { break }
        if attempt < 2 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
      }
      notice = "已建立任务，正在读取原帖 \(index + 1) / \(keys.count)…"
    }
    _ = try? await run(["feed-end", id])
    notice = "原帖已读完，本机正在下载。进度在「资料库 · 进行中与失败」。"
  }

  func saveMedia(_ url: String) async {
    notice = "正在交给本机保存…"
    do {
      _ = try await run(["web-save", url])
      notice = "已保存到资料库。"
    } catch { notice = error.localizedDescription }
  }

  func openFolder(_ url: String) {
    guard let view = browser?.webView, let target = URL(string: url) else { return }
    view.load(URLRequest(url: target))
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
          Text("打开一篇帖子或一个收藏夹，这里会列出可以保存的内容。").foregroundStyle(.secondary)
        }
        if !panel.notice.isEmpty {
          Text(panel.notice).font(.callout).fixedSize(horizontal: false, vertical: true)
        }
        if !panel.media.isEmpty {
          Divider()
          Text("页面上播放过的媒体").font(.headline)
          ForEach(panel.media) { media in
            HStack {
              Text(media.label).font(.caption).lineLimit(1)
              Spacer()
              Button("下载") { Task { await panel.saveMedia(media.url) } }
            }
          }
        }
      }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  var postSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(panel.postTitle).font(.headline).lineLimit(3)
      Text(panel.postMeta).font(.caption).foregroundStyle(.secondary)
      Text(panel.postPreview).font(.callout).lineLimit(5).foregroundStyle(.secondary)
      Button("保存这篇帖子") { Task { await panel.savePost() } }.buttonStyle(.borderedProminent)
    }
  }

  var collectionSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(panel.folderName).font(.headline).lineLimit(2)
      Text(
        "已读到 \(panel.items.count) 条 · 网站显示 \(panel.total.map(String.init) ?? "未知") 条 · "
          + (panel.complete ? "已读到末尾" : panel.reason.flatMap { reasons[$0] } ?? "还可以继续读")
      ).font(.caption).foregroundStyle(.secondary)
      HStack {
        Button("再读一屏") { Task { await panel.readMore() } }
          .disabled(panel.reading || panel.atEnd)
        if panel.autoReading {
          Button("停止") { panel.stop() }
        } else {
          Button("自动读到底") { Task { await panel.readAll() } }
            .disabled(panel.reading || panel.atEnd)
        }
      }
      Text("也可以直接在页面上往下翻，列表会同步增加。").font(.caption).foregroundStyle(.secondary)
      Toggle(
        "全选已读到的",
        isOn: Binding(
          get: { !panel.items.isEmpty && panel.selected.count == panel.items.count },
          set: { panel.selected = $0 ? Set(panel.items.map(\.id)) : [] })
      ).toggleStyle(.checkbox)
      LazyVStack(alignment: .leading, spacing: 4) {
        ForEach(panel.items) { item in
          Toggle(
            isOn: Binding(
              get: { panel.selected.contains(item.id) },
              set: { checked in
                if checked { panel.selected.insert(item.id) } else { panel.selected.remove(item.id) }
              })
          ) {
            Text(item.title + (item.isVideo ? " · 视频" : "")).lineLimit(2)
          }.toggleStyle(.checkbox)
        }
      }
      Button(panel.selected.isEmpty ? "保存所选" : "保存所选 \(panel.selected.count) 条") {
        Task { await panel.saveSelected() }
      }.buttonStyle(.borderedProminent).disabled(panel.selected.isEmpty)
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
}
