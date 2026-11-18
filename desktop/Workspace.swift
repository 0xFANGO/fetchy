import AVFoundation
import AppKit
import SwiftUI
import UniformTypeIdentifiers

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

private struct ManifestItem: Identifiable {
  let id: String, title: String, platform: String
}
private struct ManifestPreview: Identifiable {
  let id = UUID()
  let source: URL
  let items: [ManifestItem]
}
private struct SelectionSheet: View {
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

struct LibraryEntry: Identifiable {
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
  }
}

struct FailureRow: Identifiable {
  let task: String
  let key: String
  let status: String
  let reason: String?
  var id: String { task + "\n" + key }
  var platform: String { String(key.split(separator: ":").first ?? "") }
}

struct TaskSummary: Identifiable {
  let id: String
  let status: String
  let counts: [String: Int]
  init?(_ row: [String: Any]) {
    guard let value = row["id"] as? String else { return nil }
    id = value
    status = row["status"] as? String ?? ""
    counts = row["counts"] as? [String: Int] ?? [:]
  }
  var open: Bool {
    ["queued", "running", "interrupted"].contains(status) || (counts["failed"] ?? 0) > 0
      || (counts["partial"] ?? 0) > 0 || (counts["pending"] ?? 0) > 0
  }
  var summary: String {
    let names = [
      ("added", "已保存"), ("skipped", "已有"), ("partial", "部分"), ("failed", "失败"), ("pending", "等待"),
    ]
    return names.compactMap { (name, label) -> String? in
      guard let count = counts[name], count > 0 else { return nil }
      return label + " \(count)"
    }.joined(separator: " · ")
  }
}

/// The same reasons and next steps as the extension's side panel.
let failureReasons: [String: String] = [
  "login_required": "需要登录", "login_expired": "登录已过期", "auth_required": "媒体拒绝访问",
  "verification_required": "网站要求验证：在浏览器打开原帖完成验证后重试",
  "source_unavailable": "原帖不可用或已删除", "unavailable": "原帖不可用或已删除",
  "network_error": "网络中断", "timeout": "读取超时", "size_limit": "文件超过单个文件上限",
  "invalid_attachment": "下载到的文件无法识别", "invalid_url": "媒体地址无法访问",
  "full_text": "正文可能不完整", "attachments": "部分图片或视频缺失",
  "selection_missing": "收藏夹里已找不到这条", "wrong_video": "下载到的视频与原帖不一致",
  "no_formats": "没有可下载的视频格式", "save_failed": "保存失败",
]
let loginReasons: Set<String> = ["login_required", "login_expired", "auth_required"]
let statusNames: [String: String] = [
  "queued": "等待中", "pending": "等待中", "running": "保存中", "completed": "已完成", "partial": "部分完成",
  "failed": "失败", "interrupted": "已中断", "added": "已保存", "skipped": "已有",
]

struct MainView: View {
  @EnvironmentObject var app: AppState
  var body: some View {
    NavigationSplitView {
      List(
        Pane.allCases,
        selection: Binding(get: { Optional(app.pane) }, set: { if let pane = $0 { app.pane = pane } })
      ) { pane in
        Label(pane.rawValue, systemImage: pane.symbol).tag(pane)
      }
      .navigationSplitViewColumnWidth(min: 140, ideal: 160, max: 220)
    } detail: {
      switch app.pane {
      case .library: LibraryPane()
      case .browser: BrowserPane(browser: app.browser)
      case .accounts: AccountsPane()
      }
    }
    .frame(minWidth: 900, minHeight: 560)
    .tint(Color(red: 0.76, green: 0.24, blue: 0.14))
  }
}

struct CoverImage: View {
  let url: URL?
  let kind: String?
  @State private var image: NSImage?
  var body: some View {
    ZStack {
      Rectangle().fill(Color.secondary.opacity(0.12))
      if let image {
        Image(nsImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: kind == "video" ? "play.rectangle" : "doc.richtext")
          .font(.largeTitle).foregroundStyle(.secondary)
      }
    }
    .frame(height: 150).clipped()
    .task(id: url) { image = await load() }
  }
  private func load() async -> NSImage? {
    guard let url else { return nil }
    if kind == "video" {
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: 480, height: 480)
      guard let frame = try? await generator.image(at: .zero).image else { return nil }
      return NSImage(cgImage: frame, size: .zero)
    }
    return NSImage(contentsOf: url)
  }
}

struct EntryCard: View {
  let entry: LibraryEntry
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      CoverImage(url: entry.cover, kind: entry.coverKind ?? (entry.kind == "video" ? "video" : nil))
        .clipShape(RoundedRectangle(cornerRadius: 8))
      Text(entry.title).font(.headline).lineLimit(2)
      Text([entry.platform, entry.author].filter { !$0.isEmpty }.joined(separator: " · "))
        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
      if entry.status == "partial" {
        Text("部分保存").font(.caption).foregroundStyle(.orange)
      }
    }
    .contentShape(Rectangle())
  }
}

struct LibraryPane: View {
  @EnvironmentObject var app: AppState
  private let commands = LocalCommands()
  private let filters = ["全部", "视频", "图文", "文章", "进行中与失败"]
  @State private var text = ""
  @State private var filter = "全部"
  @State private var platform = ""
  @State private var folder = ""
  @State private var entries: [LibraryEntry] = []
  @State private var platforms: Set<String> = []
  @State private var folderNames: Set<String> = []
  @State private var tasks: [TaskSummary] = []
  @State private var failures: [String: [FailureRow]] = [:]
  @State private var more = false
  @State private var notice = ""
  @State private var saving = false
  @State private var preview: ManifestPreview?

  private var isLink: Bool {
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.contains("://") || value.range(of: #"^[\w-]+(\.[\w-]+)+/"#, options: .regularExpression) != nil
  }
  private var query: String { isLink ? "" : text.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var visible: [LibraryEntry] {
    entries.filter { entry in
      switch filter {
      case "视频": return entry.kind == "video" || entry.kind == "audio"
      case "图文": return entry.kind == "post"
      case "文章": return entry.kind == "article"
      default: return true
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        TextField("粘贴链接保存，或输入关键词搜索", text: $text)
          .textFieldStyle(.roundedBorder).controlSize(.large).onSubmit(submit)
        if isLink {
          Button("保存", action: submit).buttonStyle(.borderedProminent).disabled(saving)
        }
        Menu("更多") { Button("导入收藏清单…", action: selectManifest) }.fixedSize()
      }
      HStack {
        Picker("筛选", selection: $filter) { ForEach(filters, id: \.self) { Text($0) } }
          .pickerStyle(.segmented).labelsHidden().frame(maxWidth: 440)
        Spacer()
        Picker("平台", selection: $platform) {
          Text("全部平台").tag("")
          ForEach(platforms.sorted(), id: \.self) { Text($0).tag($0) }
        }.frame(width: 170)
        Picker("收藏夹", selection: $folder) {
          Text("全部收藏夹").tag("")
          ForEach(folderNames.sorted(), id: \.self) { Text($0).tag($0) }
        }.frame(width: 190)
      }
      if saving {
        HStack {
          ProgressView().controlSize(.small)
          Text("正在保存…").foregroundStyle(.secondary)
        }
      }
      if !notice.isEmpty {
        Text(notice).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      }
      if filter == "进行中与失败" { failureList } else { grid }
    }
    .padding(22)
    .task(id: [query, platform, folder, filter].joined(separator: "\u{1f}")) {
      try? await Task.sleep(nanoseconds: 200_000_000)
      guard !Task.isCancelled else { return }
      await refresh()
      while filter == "进行中与失败" && !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        guard !Task.isCancelled else { return }
        await refresh()
      }
    }
    .onChange(of: app.pane) { _, pane in if pane == .library { Task { await refresh() } } }
    .sheet(item: $preview) { selection in
      SelectionSheet(selection) { keys in
        let data = try? JSONSerialization.data(withJSONObject: keys)
        Task {
          do {
            _ = try await commands.run(["import", selection.source.path], bridge: true, payload: data)
            filter = "进行中与失败"
          } catch { notice = error.localizedDescription }
        }
      }
    }
  }

  var grid: some View {
    ScrollView {
      if visible.isEmpty {
        Text(entries.isEmpty ? "资料库还是空的。粘贴一个链接，或在浏览器里打开收藏夹保存。" : "没有符合筛选的作品。")
          .foregroundStyle(.secondary).padding(.top, 40)
      }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 16)], spacing: 18) {
        ForEach(visible) { entry in
          EntryCard(entry: entry)
            .onTapGesture { if let file = entry.file { NSWorkspace.shared.open(file) } }
            .contextMenu {
              if let file = entry.file {
                Button("打开离线页") { NSWorkspace.shared.open(file) }
                Button("在访达中显示") { NSWorkspace.shared.activateFileViewerSelecting([file]) }
              }
              if let source = entry.sourceUrl {
                Button("在内置浏览器打开原帖") { app.open(source) }
              }
            }
        }
      }
      if more {
        Button("加载更多") { Task { await refresh(offset: entries.count) } }.padding()
      }
    }
  }

  var failureList: some View {
    List {
      if tasks.isEmpty { Text("没有进行中或失败的保存。").foregroundStyle(.secondary) }
      ForEach(tasks) { task in
        Section {
          ForEach(failures[task.id] ?? []) { row in failureRow(row) }
        } header: {
          HStack {
            Text((statusNames[task.status] ?? task.status) + " · " + task.summary)
            Spacer()
            if !["running", "queued"].contains(task.status),
              (task.counts["failed"] ?? 0) + (task.counts["partial"] ?? 0) > 0
            {
              Button("重试失败项") { run(["retry", task.id]) }
            }
            if task.status == "interrupted" { Button("继续") { run(["resume", task.id]) } }
          }
        }
      }
    }
  }

  @ViewBuilder func failureRow(_ row: FailureRow) -> some View {
    let title = entries.first { $0.id == row.key }?.title ?? row.key
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).lineLimit(1)
        Text(
          (statusNames[row.status] ?? row.status)
            + (row.reason.map { " · " + (failureReasons[$0] ?? $0) } ?? "")
        ).font(.caption).foregroundStyle(row.status == "failed" ? Color.red : Color.secondary)
      }
      Spacer()
      if let reason = row.reason, loginReasons.contains(reason) {
        Button("去登录后重试") {
          app.focusedSite = row.platform
          app.pane = .accounts
        }
      }
      if ["failed", "partial"].contains(row.status) {
        Button("重试") { run(["retry", row.task, row.key]) }
      }
    }
  }

  private func submit() {
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard isLink, !saving else { return }
    saving = true
    notice = ""
    Task {
      defer { saving = false }
      do {
        let result = try await commands.run(["get", value]) as? [String: Any]
        notice = result?["status"] as? String == "partial" ? "部分保存，缺少的内容见离线页。" : "已保存到资料库。"
        text = ""
        await refresh()
      } catch { notice = error.localizedDescription }
    }
  }

  private func run(_ args: [String]) {
    Task {
      do {
        _ = try await commands.run(args, bridge: true)
        await refresh()
      } catch { notice = error.localizedDescription }
    }
  }

  private func refresh(offset: Int = 0) async {
    do {
      if filter == "进行中与失败" {
        let rows = try await commands.run(["tasks", "0"], bridge: true) as? [[String: Any]] ?? []
        let open = rows.compactMap(TaskSummary.init).filter(\.open)
        var details: [String: [FailureRow]] = [:]
        for task in open.prefix(20) {
          // Only problem entries, every page of them, so a failure at entry 300 still shows.
          var rows: [[String: Any]] = []
          while true {
            let detail =
              try await commands.run(["task", task.id, String(rows.count), "failed"], bridge: true)
              as? [String: Any]
            let page = detail?["items"] as? [[String: Any]] ?? []
            rows += page
            if page.isEmpty || rows.count >= (detail?["totalItems"] as? Int ?? 0) { break }
          }
          details[task.id] = rows.compactMap { item in
            // Pending entries are counted in the header; rows list failed and partial ones.
            guard let key = item["key"] as? String, let status = item["status"] as? String,
              ["failed", "partial"].contains(status)
            else { return nil }
            return FailureRow(task: task.id, key: key, status: status, reason: item["reason"] as? String)
          }
        }
        tasks = Array(open.prefix(20))
        failures = details
      }
      let rows =
        try await commands.run(["search", query, platform, folder, "", String(offset)], bridge: true)
        as? [[String: Any]] ?? []
      let found = rows.compactMap(LibraryEntry.init)
      entries = offset == 0 ? found : entries + found
      more = rows.count >= 100
      for entry in found {
        if !entry.platform.isEmpty { platforms.insert(entry.platform) }
        folderNames.formUnion(entry.folders)
      }
    } catch { notice = error.localizedDescription }
  }

  private func selectManifest() {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.json]
    panel.canChooseDirectories = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task {
      do {
        let rows =
          try await commands.run(["preview", url.path], bridge: true) as? [[String: String]] ?? []
        let options = rows.compactMap { row -> ManifestItem? in
          guard let key = row["key"], let title = row["title"], let platform = row["platform"]
          else { return nil }
          return ManifestItem(id: key, title: title, platform: platform)
        }
        guard !options.isEmpty else { throw FetchyFailure(text: "清单没有可保存的条目。") }
        preview = ManifestPreview(source: url, items: options)
      } catch { notice = error.localizedDescription }
    }
  }
}
