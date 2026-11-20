import AppKit
import SwiftUI

struct FetchyFailure: LocalizedError {
  let text: String
  var errorDescription: String? { text }
}

private final class OutputBuffer: @unchecked Sendable {
  let lock = NSLock()
  private var data = Data()
  var overflow = false
  func append(_ value: Data) {
    lock.lock()
    defer { lock.unlock() }
    if data.count + value.count <= 8 * 1024 * 1024 { data.append(value) } else { overflow = true }
  }
  func contents() -> Data {
    lock.lock()
    defer { lock.unlock() }
    return data
  }
}

struct LocalCommands {
  let resources = Bundle.main.resourceURL!
  func run(_ arguments: [String], bridge: Bool = false, payload: Data? = nil) async throws -> Any {
    try await Task.detached(priority: .userInitiated) {
      let config = try JSONDecoder().decode(
        [String: String].self,
        from: Data(contentsOf: resources.appendingPathComponent("tools.json")))
      let toolDirectories = (config["path"] ?? "").split(separator: ":")
      let candidates = [config["node"]].compactMap { $0 } + toolDirectories.map { "\($0)/node" }
      guard let node = candidates.first(where: FileManager.default.isExecutableFile(atPath:))
      else { throw FetchyFailure(text: "找不到 Node.js 22+。安装后重试（brew install node）。") }
      let script = resources.appendingPathComponent(
        bridge ? "app/desktop/bridge.mjs" : "app/bin/fetchy.mjs")
      let process = Process()
      process.executableURL = URL(fileURLWithPath: node)
      process.arguments = [script.path] + arguments
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = config["path"]
      env["FETCHY_DESKTOP_APP"] = Bundle.main.bundleURL.path
      if let directory = dataDirectoryOverride { env["FETCHY_DATA_DIR"] = directory }
      process.environment = env
      let out = Pipe()
      let err = Pipe()
      let stdout = OutputBuffer()
      let stderr = OutputBuffer()
      process.standardOutput = out
      process.standardError = err
      let group = DispatchGroup()
      let input = Pipe()
      process.standardInput = input
      try process.run()
      DispatchQueue.global().async {
        if let payload { try? input.fileHandleForWriting.write(contentsOf: payload) }
        try? input.fileHandleForWriting.close()
      }
      for (pipe, buffer) in [(out, stdout), (err, stderr)] {
        group.enter()
        DispatchQueue.global().async {
          while let chunk = try? pipe.fileHandleForReading.read(upToCount: 64 * 1024),
            !chunk.isEmpty
          { buffer.append(chunk) }
          group.leave()
        }
      }
      let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
      DispatchQueue.global().asyncAfter(deadline: .now() + 31 * 60, execute: watchdog)
      process.waitUntilExit()
      watchdog.cancel()
      group.wait()
      if process.terminationStatus != 0 {
        if arguments.first == "get", !stdout.overflow,
          let result = try? JSONSerialization.jsonObject(with: stdout.contents()) as? [String: Any],
          result["status"] as? String == "partial", result["filepath"] is String
        { return result }
        let errorData = stderr.contents()
        if let obj = try? JSONSerialization.jsonObject(with: errorData) as? [String: Any],
          let error = obj["error"] as? [String: Any], let message = error["message"] as? String
        { throw FetchyFailure(text: String(message.prefix(800))) }
        let lines = String(decoding: errorData, as: UTF8.self).split(separator: "\n")
          .reversed()
        for line in lines {
          if let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
            let e = obj["error"] as? [String: Any], let msg = e["message"] as? String
          {
            throw FetchyFailure(text: String(msg.prefix(800)))
          }
        }
        throw FetchyFailure(text: "未能完成操作，请检查本机依赖后重试。")
      }
      guard !stdout.overflow else { throw FetchyFailure(text: "结果过多，请缩小检索范围。") }
      return try JSONSerialization.jsonObject(with: stdout.contents())
    }.value
  }
}

struct ManifestItem: Identifiable {
  let id: String, title: String, platform: String
}
struct ManifestPreview: Identifiable {
  let id = UUID()
  let source: URL
  let items: [ManifestItem]
}
struct SelectionSheet: View {
  let preview: ManifestPreview
  let start: ([String]) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var selected: Set<String>
  init(_ preview: ManifestPreview, start: @escaping ([String]) -> Void) {
    self.preview = preview
    self.start = start
    _selected = State(initialValue: Set(preview.items.map(\.id)))
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(preview.source.lastPathComponent).font(.title2.bold()).lineLimit(1)
      HStack {
        Text("已选 \(selected.count) / \(preview.items.count) 项")
        Spacer()
        Button("全选") { selected = Set(preview.items.map(\.id)) }
        Button("清空选择") { selected.removeAll() }
      }
      List(preview.items) { item in
        Toggle(
          isOn: Binding(
            get: { selected.contains(item.id) },
            set: { checked in
              if checked { selected.insert(item.id) } else { selected.remove(item.id) }
            })
        ) {
          VStack(alignment: .leading) {
            Text(item.title).lineLimit(2)
            Text(item.platform).foregroundStyle(.secondary).font(.caption)
          }
        }.toggleStyle(.checkbox)
      }
      HStack {
        Spacer()
        Button("取消") { dismiss() }
        Button("开始下载") {
          start(Array(selected))
          dismiss()
        }.buttonStyle(.borderedProminent).disabled(selected.isEmpty)
      }
    }.padding(20).frame(width: 540, height: 440)
  }
}

let fetchyAccent = Color(red: 0.76, green: 0.24, blue: 0.14)

enum Pane: Hashable {
  case downloads, browser, accounts
}

/// Supported platform quick-jump shortcuts to each platform's favorites/bookmarks page.
struct PlatformShortcut: Identifiable, Hashable {
  let site: String
  let label: String
  let favoritesLabel: String
  let homeUrl: String
  let url: String
  let symbol: String
  let needsResolve: Bool
  var id: String { site }
}

let platformShortcuts: [PlatformShortcut] = [
  PlatformShortcut(
    site: "xiaohongshu", label: "小红书", favoritesLabel: "收藏笔记",
    homeUrl: "https://www.xiaohongshu.com/explore",
    url: "https://www.xiaohongshu.com/explore", symbol: "bookmark.fill", needsResolve: true),
  PlatformShortcut(
    site: "bilibili", label: "B站", favoritesLabel: "收藏夹",
    homeUrl: "https://www.bilibili.com/",
    url: "https://space.bilibili.com/", symbol: "star.fill", needsResolve: true),
  PlatformShortcut(
    site: "douyin", label: "抖音", favoritesLabel: "收藏",
    homeUrl: "https://www.douyin.com/",
    url: "https://www.douyin.com/user/self?showTab=favorite_collection",
    symbol: "music.note", needsResolve: false),
  PlatformShortcut(
    site: "x", label: "X", favoritesLabel: "书签",
    homeUrl: "https://x.com/",
    url: "https://x.com/i/bookmarks", symbol: "bookmark", needsResolve: false),
  PlatformShortcut(
    site: "youtube", label: "YouTube", favoritesLabel: "播放列表",
    homeUrl: "https://www.youtube.com/",
    url: "https://www.youtube.com/feed/playlists", symbol: "play.square.stack", needsResolve: false),
  PlatformShortcut(
    site: "zhihu", label: "知乎", favoritesLabel: "收藏夹",
    homeUrl: "https://www.zhihu.com/",
    url: "https://www.zhihu.com/collections/mine", symbol: "text.book.closed", needsResolve: false),
  PlatformShortcut(
    site: "instagram", label: "Instagram", favoritesLabel: "收藏",
    homeUrl: "https://www.instagram.com/",
    url: "https://www.instagram.com/", symbol: "camera", needsResolve: true),
  PlatformShortcut(
    site: "threads", label: "Threads", favoritesLabel: "已保存",
    homeUrl: "https://www.threads.com/",
    url: "https://www.threads.com/saved", symbol: "at", needsResolve: false),
  PlatformShortcut(
    site: "tiktok", label: "TikTok", favoritesLabel: "收藏",
    homeUrl: "https://www.tiktok.com/",
    url: "https://www.tiktok.com/", symbol: "film", needsResolve: true),
]

func shortcutFor(site: String) -> PlatformShortcut? {
  platformShortcuts.first { $0.site == site }
}

let platformNames: [String: String] = [
  "xiaohongshu": "小红书", "bilibili": "B站", "douyin": "抖音", "zhihu": "知乎", "weibo": "微博",
  "kuaishou": "快手", "x": "X", "youtube": "YouTube", "instagram": "Instagram", "threads": "Threads",
  "tiktok": "TikTok", "web": "网页",
]
func platformName(_ id: String) -> String { platformNames[id] ?? id }

let failureReasons: [String: String] = [
  "login_required": "需要登录", "login_expired": "登录已过期", "auth_required": "媒体拒绝访问",
  "verification_required": "网站要求验证", "source_unavailable": "原帖读取失败",
  "unavailable": "原帖不可用或已删除", "network_error": "网络中断", "timeout": "读取超时",
  "size_limit": "文件超过上限", "invalid_attachment": "文件格式无法识别",
  "invalid_url": "媒体地址无法访问", "full_text": "正文不完整", "attachments": "部分媒体缺失",
  "selection_missing": "收藏夹里已找不到这条", "wrong_video": "视频与原帖不符",
  "no_formats": "未找到可下载的视频", "save_failed": "下载失败", "partial": "部分媒体缺失",
]
let nextSteps: [String: String] = [
  "login_required": "登录该网站后重试。",
  "login_expired": "登录已过期，重新登录后重试。",
  "auth_required": "网站仅允许登录用户访问，登录后重试。",
  "verification_required": "在浏览器打开原帖完成人机验证，回来重试。",
  "source_unavailable": "原帖未读出，可能是需要登录、限流或超时。可先重试，或打开原帖确认。",
  "unavailable": "原帖可能已删除或设为私密。",
  "network_error": "网络波动，点击重试即可。",
  "timeout": "网站响应超时，点击重试。",
  "size_limit": "文件超过大小上限。",
  "invalid_attachment": "返回的不是有效图片或视频。",
  "invalid_url": "媒体链接已过期，重试会重新获取。",
  "full_text": "登录后重试可获取完整内容。",
  "attachments": "重试可补下缺失的图片或视频。",
  "selection_missing": "可能已取消收藏。",
  "wrong_video": "下载到的视频与原帖不一致，已丢弃，可重试。",
  "no_formats": "该页面没有可直接下载的视频，可在浏览器播放后嗅探。",
  "save_failed": "检查网络或磁盘空间后重试。",
]
let loginReasons: Set<String> = [
  "login_required", "login_expired", "auth_required",
]

struct LibraryEntry: Identifiable, Equatable {
  let id: String
  let title: String
  let platform: String
  let author: String
  let status: String
  let kind: String
  let folders: [String]
  let file: URL?
  let primaryFile: URL?
  let savedDir: URL?
  let cover: URL?
  let coverKind: String?
  let sourceUrl: String?
  let files: [URL]
  let mediaCount: Int

  init?(_ row: [String: Any]) {
    guard let key = row["key"] as? String else { return nil }
    id = key
    title = (row["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? key
    platform = row["platform"] as? String ?? ""
    author = row["author"] as? String ?? ""
    status = row["status"] as? String ?? ""
    kind = row["kind"] as? String ?? "post"
    folders = (row["folders"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
    file = (row["filepath"] as? String).map { URL(fileURLWithPath: $0) }
    primaryFile = (row["primaryFile"] as? String).map { URL(fileURLWithPath: $0) }
    savedDir = (row["savedDir"] as? String).map { URL(fileURLWithPath: $0, isDirectory: true) }
    cover = (row["cover"] as? String).map { URL(fileURLWithPath: $0) }
    coverKind = row["coverKind"] as? String
    sourceUrl = row["sourceUrl"] as? String
    files = (row["files"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }
    mediaCount = row["mediaCount"] as? Int ?? files.count
  }

  /// Prefer opening the real downloaded file/folder in ~/Downloads/Fetchy.
  var openTarget: URL? {
    if let primaryFile, FileManager.default.fileExists(atPath: primaryFile.path) { return primaryFile }
    if let first = files.first(where: { FileManager.default.fileExists(atPath: $0.path) }) {
      return first
    }
    return file
  }

  var revealTargets: [URL] {
    if let savedDir, FileManager.default.fileExists(atPath: savedDir.path) { return [savedDir] }
    let existing = files.filter { FileManager.default.fileExists(atPath: $0.path) }
    if !existing.isEmpty { return existing }
    return [openTarget].compactMap { $0 }
  }

  var kindName: String {
    switch kind {
    case "video": return "视频"
    case "audio": return "音频"
    case "article": return "文章"
    default: return "图文"
    }
  }

  var meta: String {
    [platformName(platform), author].filter { !$0.isEmpty }.joined(separator: " · ")
  }
}

struct ActiveDownloadItem: Identifiable, Equatable {
  let id: String
  let taskId: String
  let key: String
  let title: String
  let platform: String
  let kind: String
  let folder: String
  let sourceUrl: String?
  let status: String
  let stage: String
  let downloadedBytes: Int64
  let totalBytes: Int64
  let speedBytesPerSec: Int64
  let attachmentIndex: Int
  let attachmentTotal: Int

  init?(_ row: [String: Any]) {
    guard let id = row["id"] as? String, let taskId = row["taskId"] as? String,
      let key = row["key"] as? String
    else { return nil }
    self.id = id
    self.taskId = taskId
    self.key = key
    title = (row["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? key
    platform = row["platform"] as? String ?? ""
    kind = row["kind"] as? String ?? "post"
    folder = row["folder"] as? String ?? ""
    sourceUrl = row["sourceUrl"] as? String
    status = row["status"] as? String ?? "queued"
    stage = row["stage"] as? String ?? "waiting"
    downloadedBytes = (row["downloadedBytes"] as? NSNumber)?.int64Value ?? 0
    totalBytes = (row["totalBytes"] as? NSNumber)?.int64Value ?? 0
    speedBytesPerSec = (row["speedBytesPerSec"] as? NSNumber)?.int64Value ?? 0
    attachmentIndex = row["attachmentIndex"] as? Int ?? 0
    attachmentTotal = row["attachmentTotal"] as? Int ?? 0
  }

  var isRunning: Bool { status == "running" }
  var isInterrupted: Bool { status == "interrupted" }

  var fraction: Double? {
    guard totalBytes > 0 else { return nil }
    return min(1.0, max(0.0, Double(downloadedBytes) / Double(totalBytes)))
  }

  var stageText: String {
    switch stage {
    case "resolving": return "正在解析链接…"
    case "reading_post": return "正在读取原帖…"
    case "downloading":
      if attachmentTotal > 1 && attachmentIndex > 0 {
        return "正在下载 (\(attachmentIndex)/\(attachmentTotal))"
      }
      return "正在下载"
    case "merging": return "正在合并音视频…"
    case "verifying": return "正在校验文件…"
    case "interrupted": return "已中断"
    default: return "等待中"
    }
  }
}

struct FailedDownloadItem: Identifiable, Equatable {
  let id: String
  let taskId: String
  let key: String
  let title: String
  let author: String
  let platform: String
  let status: String
  let reason: String
  let sourceUrl: String?

  init?(_ row: [String: Any]) {
    guard let id = row["id"] as? String, let taskId = row["taskId"] as? String,
      let key = row["key"] as? String
    else { return nil }
    self.id = id
    self.taskId = taskId
    self.key = key
    title = (row["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? key
    author = row["author"] as? String ?? ""
    platform = row["platform"] as? String ?? ""
    status = row["status"] as? String ?? "failed"
    reason = row["reason"] as? String ?? "save_failed"
    sourceUrl = row["sourceUrl"] as? String
  }

  var reasonLabel: String { failureReasons[reason] ?? "下载失败" }
  var stepHint: String { nextSteps[reason] ?? "点击重试，或打开原帖确认。" }
  var needsLogin: Bool { loginReasons.contains(reason) }
  var needsVerification: Bool { reason == "verification_required" }
}

@MainActor final class DownloadsModel: ObservableObject {
  struct Stats: Equatable {
    var total = 0
    var activeCount = 0
    var failedCount = 0
    var kinds: [String: Int] = [:]
    var platforms: [String: Int] = [:]
  }

  @Published var stats = Stats()
  @Published var downloadsDir: URL?
  @Published var active: [ActiveDownloadItem] = []
  @Published var failed: [FailedDownloadItem] = []
  @Published var revision = 0
  @Published var notice = ""
  let commands = LocalCommands()

  var hasInterrupted: Bool { active.contains(where: \.isInterrupted) }

  func refresh() async {
    guard let res = try? await commands.run(["downloads"], bridge: true) as? [String: Any] else {
      return
    }
    let nextActive = (res["active"] as? [[String: Any]] ?? []).compactMap(ActiveDownloadItem.init)
    let nextFailed = (res["failed"] as? [[String: Any]] ?? []).compactMap(FailedDownloadItem.init)
    let rawStats = res["stats"] as? [String: Any] ?? [:]
    let nextStats = Stats(
      total: rawStats["total"] as? Int ?? 0,
      activeCount: rawStats["activeCount"] as? Int ?? nextActive.count,
      failedCount: rawStats["failedCount"] as? Int ?? nextFailed.count,
      kinds: rawStats["kinds"] as? [String: Int] ?? [:],
      platforms: rawStats["platforms"] as? [String: Int] ?? [:])
    let worksChanged =
      nextStats.total != stats.total || nextStats.kinds != stats.kinds
      || (active.count > nextActive.count)
    if worksChanged { revision += 1 }
    active = nextActive
    failed = nextFailed
    stats = nextStats
    if let dir = res["downloadsDir"] as? String, !dir.isEmpty {
      downloadsDir = URL(fileURLWithPath: dir, isDirectory: true)
    }
  }

  func watch() async {
    while !Task.isCancelled {
      await refresh()
      try? await Task.sleep(nanoseconds: active.isEmpty ? 6_000_000_000 : 1_000_000_000)
    }
  }

  func startUrlDownload(
    _ url: String, title: String? = nil, referer: String? = nil, pageUrl: String? = nil
  ) async -> Bool {
    var body: [String: Any] = ["url": url]
    if let title, !title.isEmpty { body["title"] = title }
    if let referer, !referer.isEmpty { body["referer"] = referer }
    if let pageUrl, !pageUrl.isEmpty { body["pageUrl"] = pageUrl }
    guard let data = try? JSONSerialization.data(withJSONObject: body) else { return false }
    do {
      _ = try await commands.run(["download-url"], bridge: true, payload: data)
      notice = ""
      await refresh()
      return true
    } catch {
      notice = error.localizedDescription
      return false
    }
  }

  func cancelItem(_ item: ActiveDownloadItem) async {
    do {
      _ = try await commands.run(["cancel-item", item.id, item.taskId, item.key], bridge: true)
      await refresh()
    } catch {
      notice = error.localizedDescription
    }
  }

  func cancelAllActive() async {
    for item in active {
      _ = try? await commands.run(["cancel-item", item.id, item.taskId, item.key], bridge: true)
    }
    await refresh()
  }

  func resumeInterrupted() async {
    let taskIds = Set(active.filter(\.isInterrupted).map(\.taskId))
    for taskId in taskIds {
      _ = try? await commands.run(["resume", taskId], bridge: true)
    }
    await refresh()
  }

  func retryItem(_ item: FailedDownloadItem) async {
    do {
      _ = try await commands.run(["retry", item.taskId, item.key], bridge: true)
      notice = ""
      await refresh()
    } catch {
      notice = error.localizedDescription
    }
  }

  func retryAllFailed() async {
    let grouped = Dictionary(grouping: failed, by: \.taskId)
    for (taskId, items) in grouped {
      if taskId == "url" {
        for item in items {
          _ = try? await commands.run(["retry", "url", item.key], bridge: true)
        }
      } else {
        _ = try? await commands.run(["retry", taskId] + items.map(\.key), bridge: true)
      }
    }
    await refresh()
  }

  func dismissFailed(_ keys: [String] = []) async {
    let data = try? JSONSerialization.data(withJSONObject: keys)
    _ = try? await commands.run(["dismiss-failed"], bridge: true, payload: data)
    await refresh()
  }

  func openDownloadsFolder() {
    let target =
      downloadsDir
      ?? FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Downloads/Fetchy", isDirectory: true)
    try? FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
    NSWorkspace.shared.open(target)
  }
}

@MainActor final class AppState: ObservableObject {
  @Published var pane: Pane = .downloads
  @Published var focusedSite: String?
  let browser = BrowserModel()
  let downloads = DownloadsModel()

  init() {
    browser.downloads = downloads
    browser.onOpenDownloads = { [weak self] in self?.pane = .downloads }
  }

  func open(_ url: String, signingIn: Bool = false) {
    pane = .browser
    browser.go(url)
    if signingIn {
      Task {
        if let info = try? await browser.siteInfo(url) { focusedSite = info.site }
      }
    }
  }

  func openFavorites(_ shortcut: PlatformShortcut) {
    pane = .browser
    browser.openFavorites(shortcut)
  }
}

struct MainView: View {
  @EnvironmentObject var app: AppState

  var body: some View {
    Group {
      switch app.pane {
      case .downloads:
        DownloadsHomePane(downloads: app.downloads)
      case .browser:
        BrowserPane(browser: app.browser)
      case .accounts:
        AccountsPane()
      }
    }
    .frame(minWidth: 960, minHeight: 620)
    .tint(fetchyAccent)
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        navButton(
          title: app.downloads.active.isEmpty ? "下载" : "下载 (\(app.downloads.active.count))",
          symbol: "arrow.down.circle",
          active: app.pane == .downloads,
          shortcut: "1"
        ) { app.pane = .downloads }
        navButton(
          title: "浏览器",
          symbol: "safari",
          active: app.pane == .browser,
          shortcut: "2"
        ) { app.pane = .browser }
        navButton(
          title: "账号",
          symbol: "person.crop.circle",
          active: app.pane == .accounts,
          shortcut: "3"
        ) { app.pane = .accounts }
        Button {
          app.downloads.openDownloadsFolder()
        } label: {
          Label("下载文件夹", systemImage: "folder")
        }
        .help("在访达中打开下载文件夹")
      }
    }
    .task { await app.downloads.watch() }
  }

  @ViewBuilder private func navButton(
    title: String, symbol: String, active: Bool, shortcut: KeyEquivalent,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Label(title, systemImage: symbol)
        .foregroundStyle(active ? fetchyAccent : .primary)
    }
    .keyboardShortcut(shortcut, modifiers: .command)
    .help("\(title) (⌘\(String(shortcut.character)))")
  }
}
