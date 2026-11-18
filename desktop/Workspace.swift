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
        Button("保存所选") {
          start(Array(selected))
          dismiss()
        }.buttonStyle(.borderedProminent).disabled(selected.isEmpty)
      }
    }.padding(20).frame(width: 540, height: 440)
  }
}

let fetchyAccent = Color(red: 0.76, green: 0.24, blue: 0.14)

/// Sites' own names. Anything not listed shows its Fetchy ID.
let platformNames: [String: String] = [
  "xiaohongshu": "小红书", "bilibili": "哔哩哔哩", "douyin": "抖音", "zhihu": "知乎", "weibo": "微博",
  "kuaishou": "快手", "x": "X", "youtube": "YouTube", "instagram": "Instagram", "threads": "Threads",
  "tiktok": "TikTok", "web": "网页",
]
func platformName(_ id: String) -> String { platformNames[id] ?? id }

struct LibraryEntry: Identifiable, Equatable {
  let id: String
  let title: String
  let platform: String
  let author: String
  let status: String
  let kind: String
  let folders: [String]
  let file: URL?
  let cover: URL?
  let coverKind: String?
  let sourceUrl: String?
  /// Saved images and videos; the offline page links to them.
  let files: [URL]
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
    cover = (row["cover"] as? String).map { URL(fileURLWithPath: $0) }
    coverKind = row["coverKind"] as? String
    sourceUrl = row["sourceUrl"] as? String
    files = (row["files"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }
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

struct TaskSummary: Identifiable, Equatable {
  let id: String
  let status: String
  let counts: [String: Int]
  let created: Date?
  let folders: [String]
  let platforms: [String]
  init?(_ row: [String: Any]) {
    guard let value = row["id"] as? String else { return nil }
    id = value
    status = row["status"] as? String ?? ""
    counts = row["counts"] as? [String: Int] ?? [:]
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    created = (row["createdAt"] as? String).flatMap(parser.date(from:))
    let rows = row["folders"] as? [[String: Any]] ?? []
    folders = rows.compactMap { ($0["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
    platforms = Array(Set(rows.compactMap { $0["platform"] as? String })).sorted()
  }
  func count(_ name: String) -> Int { counts[name] ?? 0 }
  var total: Int { counts.values.reduce(0, +) }
  var done: Int { total - count("pending") }
  var problems: Int { count("failed") + count("partial") }
  var isActive: Bool { ["queued", "running", "interrupted"].contains(status) }
  var title: String {
    if folders.isEmpty { return total == 1 ? "单条保存" : "\(total) 条保存" }
    let names = folders.prefix(2).map { "「\($0)」" }.joined(separator: "、")
    return "收藏夹" + names + (folders.count > 2 ? " 等 \(folders.count) 个" : "")
  }
  var subtitle: String {
    var parts = platforms.map(platformName)
    if let created { parts.append(created.formatted(date: .abbreviated, time: .shortened)) }
    return parts.joined(separator: " · ")
  }
}

/// The same reasons as the extension's side panel, each with the step that fixes it.
let failureReasons: [String: String] = [
  "login_required": "需要登录", "login_expired": "登录已过期", "auth_required": "媒体拒绝访问",
  "verification_required": "网站要求验证", "source_unavailable": "原帖读取失败", "unavailable": "原帖不可用或已删除",
  "network_error": "网络中断", "timeout": "读取超时", "size_limit": "文件超过单个文件上限",
  "invalid_attachment": "下载到的文件无法识别", "invalid_url": "媒体地址无法访问",
  "full_text": "正文可能不完整", "attachments": "部分图片或视频缺失",
  "selection_missing": "收藏夹里已找不到这条", "wrong_video": "下载到的视频与原帖不一致",
  "no_formats": "没有可下载的视频格式", "save_failed": "保存失败", "partial": "部分内容缺失",
]
let nextSteps: [String: String] = [
  "login_required": "在「账号」登录这个网站，回来重试。",
  "login_expired": "在「账号」重新登录这个网站，回来重试。",
  "auth_required": "网站只给登录用户看。登录后重试。",
  "verification_required": "在浏览器打开原帖，完成网站的验证，回来重试。",
  "source_unavailable": "原帖没读出来，可能是加载超时或需要登录。先重试；仍失败就打开原帖确认能否看到。",
  "unavailable": "原帖可能已删除或仅作者可见。打开原帖确认。",
  "network_error": "网络不稳定，直接重试。",
  "timeout": "网站响应太慢，直接重试。",
  "size_limit": "文件超过上限，没有保存。",
  "invalid_attachment": "网站返回的不是图片或视频。打开原帖确认后重试。",
  "invalid_url": "媒体地址已失效。重试会重新读取原帖。",
  "full_text": "只存下了摘要。登录后重试可以读到全文。",
  "attachments": "正文已保存。重试会补下缺失的图片或视频。",
  "selection_missing": "可能已取消收藏，不需要处理。",
  "wrong_video": "下载到的视频与原帖不一致，已丢弃。重试一次。",
  "no_formats": "网站没有提供可下载的视频。",
  "save_failed": "写入资料库失败，检查磁盘空间后重试。",
]
let loginReasons: Set<String> = ["login_required", "login_expired", "auth_required", "full_text"]

enum SidebarItem: Hashable {
  case all, video, post, article
  case active, attention
  case platform(String), folder(String)
  case browser, accounts

  var title: String {
    switch self {
    case .all: return "全部作品"
    case .video: return "视频"
    case .post: return "图文"
    case .article: return "文章"
    case .active: return "进行中"
    case .attention: return "需要处理"
    case .platform(let id): return platformName(id)
    case .folder(let name): return name
    case .browser: return "浏览器"
    case .accounts: return "账号"
    }
  }
}

/// What the sidebar counts and the panes share: library totals and the save tasks.
@MainActor final class LibraryModel: ObservableObject {
  struct Stats: Equatable {
    var total = 0
    var kinds: [String: Int] = [:]
    var platforms: [String: Int] = [:]
    var folders: [String: Int] = [:]
  }
  @Published var stats = Stats()
  /// The library folder on disk, for showing it in Finder.
  @Published var root: URL?
  @Published var tasks: [TaskSummary] = []
  /// Bumped whenever saved works may have changed, so open lists reload.
  @Published var revision = 0
  let commands = LocalCommands()

  var activeCount: Int { tasks.filter(\.isActive).count }
  var problemCount: Int { tasks.reduce(0) { $0 + $1.problems } }

  func refresh() async {
    guard
      let tasksRows = try? await commands.run(["tasks", "0"], bridge: true) as? [[String: Any]],
      let stats = try? await commands.run(["stats"], bridge: true) as? [String: Any]
    else { return }
    let next = tasksRows.compactMap(TaskSummary.init)
    let counted = Stats(
      total: stats["total"] as? Int ?? 0, kinds: stats["kinds"] as? [String: Int] ?? [:],
      platforms: stats["platforms"] as? [String: Int] ?? [:],
      folders: stats["folders"] as? [String: Int] ?? [:])
    if next != tasks || counted != self.stats { revision += 1 }
    tasks = next
    self.stats = counted
    root = (stats["root"] as? String).map { URL(fileURLWithPath: $0, isDirectory: true) }
  }

  /// Poll quickly while something is saving, slowly otherwise.
  func watch() async {
    while !Task.isCancelled {
      await refresh()
      try? await Task.sleep(nanoseconds: activeCount > 0 ? 2_000_000_000 : 8_000_000_000)
    }
  }
}

struct MainView: View {
  @EnvironmentObject var app: AppState
  var body: some View {
    NavigationSplitView {
      Sidebar(library: app.library)
        .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 300)
    } detail: {
      switch app.sidebar {
      case .browser: BrowserPane(browser: app.browser)
      case .accounts: AccountsPane()
      case .active, .attention: TasksPane(library: app.library)
      default: LibraryPane(library: app.library)
      }
    }
    .frame(minWidth: 980, minHeight: 600)
    .tint(fetchyAccent)
    .task { await app.library.watch() }
  }
}

struct Sidebar: View {
  @EnvironmentObject var app: AppState
  @ObservedObject var library: LibraryModel
  @AppStorage("sidebar.platforms") private var showPlatforms = true
  @AppStorage("sidebar.folders") private var showFolders = true

  var body: some View {
    List(selection: Binding(get: { Optional(app.sidebar) }, set: { if let v = $0 { app.sidebar = v } })) {
      Section("资料库") {
        row(.all, "square.grid.2x2", library.stats.total)
        row(.video, "play.rectangle", kind("video") + kind("audio"))
        row(.post, "photo.on.rectangle", kind("post"))
        row(.article, "doc.plaintext", kind("article"))
      }
      Section("保存任务") {
        row(.active, "arrow.down.circle", library.activeCount)
        row(.attention, "exclamationmark.triangle", library.problemCount)
      }
      Section("网站") {
        row(.browser, "safari", 0)
        row(.accounts, "person.crop.circle", 0)
      }
      if !library.stats.platforms.isEmpty {
        Section("来源", isExpanded: $showPlatforms) {
          ForEach(library.stats.platforms.sorted { $0.value > $1.value }, id: \.key) { item in
            row(.platform(item.key), "globe", item.value)
          }
        }
      }
      if !library.stats.folders.isEmpty {
        Section("收藏夹", isExpanded: $showFolders) {
          ForEach(library.stats.folders.sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }, id: \.key) {
            item in
            row(.folder(item.key), "folder", item.value)
          }
        }
      }
    }
    .listStyle(.sidebar)
  }

  private func kind(_ name: String) -> Int { library.stats.kinds[name] ?? 0 }

  private func row(_ item: SidebarItem, _ symbol: String, _ count: Int) -> some View {
    Label(item.title, systemImage: symbol).lineLimit(1).badge(count).tag(item)
  }
}
