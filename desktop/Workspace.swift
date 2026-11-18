import AVKit
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
      guard let node = config["node"] else { throw FetchyFailure(text: "请重新构建 Fetchy 桌面应用。") }
      let script = resources.appendingPathComponent(
        bridge ? "app/desktop/bridge.mjs" : "app/bin/fetchy.mjs")
      let process = Process()
      process.executableURL = URL(fileURLWithPath: node)
      process.arguments = [script.path] + arguments
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = config["path"]
      env["FETCHY_DESKTOP_APP"] = Bundle.main.bundleURL.path
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

private struct LibraryItem: Identifiable {
  let id: String, title: String, detail: String, file: URL?
  init?(_ row: [String: Any]) {
    guard let key = row["key"] as? String else { return nil }
    id = key
    title = row["title"] as? String ?? key
    detail = [row["platform"] as? String, row["author"] as? String, row["status"] as? String]
      .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    file = (row["filepath"] as? String).map { URL(fileURLWithPath: $0) }
  }
}

private struct CollectionTask: Identifiable {
  let id: String, status: String, counts: [String: Int]
  init?(_ row: [String: Any]) {
    guard let value = row["id"] as? String else { return nil }
    id = value
    status = row["status"] as? String ?? ""
    counts = row["counts"] as? [String: Int] ?? [:]
  }
  var summary: String {
    [("added", "新增"), ("skipped", "跳过"), ("partial", "部分"), ("failed", "失败"), ("pending", "待处理")]
      .map { "\($0.1) \(counts[$0.0] ?? 0)" }.joined(separator: "  ·  ")
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

private struct MoviePreview: Identifiable {
  let id = UUID()
  let url: URL
  let player: AVPlayer
  init(_ url: URL) {
    self.url = url
    player = AVPlayer(url: url)
  }
}
private struct LocalVideoPlayer: NSViewRepresentable {
  let player: AVPlayer
  func makeNSView(context: Context) -> AVPlayerView {
    let view = AVPlayerView()
    view.controlsStyle = .inline
    view.player = player
    return view
  }
  func updateNSView(_ view: AVPlayerView, context: Context) {
    if view.player !== player { view.player = player }
  }
}

struct Workspace: View {
  private let commands = LocalCommands()
  @State private var section = "保存"
  @State private var link = ""
  @AppStorage("outputDirectory") private var output = FileManager.default
    .homeDirectoryForCurrentUser.appendingPathComponent("Downloads/Fetchy").path
  @State private var running = false
  @State private var notice = ""
  @State private var saved: URL?
  @State private var movie: MoviePreview?
  @State private var query = ""
  @State private var platform = ""
  @State private var folder = ""
  @State private var topic = ""
  @State private var items: [LibraryItem] = []
  @State private var jobs: [CollectionTask] = []
  @State private var history: [Int] = [0]
  @State private var nextPage: Int?
  @State private var serviceNotice = ""
  @State private var updating = false
  @State private var preview: ManifestPreview?
  var filters: [String] { [query, platform, folder, topic] }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 30, height: 30)
        Text("Fetchy").font(.title2.bold())
        Spacer()
        Picker("工作区", selection: $section) {
          ForEach(["保存", "收藏库", "任务"], id: \.self) { Text($0) }
        }.pickerStyle(.segmented).labelsHidden().frame(width: 226)
      }
      Divider()
      if section == "保存" { downloadView }
      if section == "收藏库" { libraryView }
      if section == "任务" { taskView }
      if section != "保存" && (history.count > 1 || nextPage != nil) {
        HStack {
          Button("上一页") { if history.count > 1 { history.removeLast(); Task { await refresh() } } }
            .disabled(history.count <= 1)
          Button("下一页") { if let nextPage { history.append(nextPage); Task { await refresh() } } }
            .disabled(nextPage == nil)
        }
      }
      if section != "保存", !serviceNotice.isEmpty {
        Text(serviceNotice).foregroundStyle(.secondary).textSelection(.enabled)
      }
      Spacer(minLength: 0)
    }
    .padding(26).frame(minWidth: 650, minHeight: 420, alignment: .topLeading)
    .tint(Color(red: 0.76, green: 0.24, blue: 0.14))
    .sheet(item: $movie) { item in
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text(item.url.lastPathComponent).font(.headline).lineLimit(2)
          Spacer()
          Button("关闭") { movie = nil }
        }
        LocalVideoPlayer(player: item.player).frame(minWidth: 600, minHeight: 340)
          .onAppear { item.player.play() }
          .onDisappear { item.player.pause() }
      }.padding()
    }
    .sheet(item: $preview) { selection in
      SelectionSheet(selection) { keys in
        let data = try? JSONSerialization.data(withJSONObject: keys)
        perform(["import", selection.source.path], payload: data)
      }
    }
    .task(id: section + "\u{1f}" + filters.joined(separator: "\u{1e}")) {
      history = [0]
      nextPage = nil
      guard section != "保存" else { return }
      try? await Task.sleep(nanoseconds: 220_000_000)
      guard !Task.isCancelled else { return }
      await refresh()
      while section == "任务" && !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        guard !Task.isCancelled else { return }
        await refresh()
      }
    }
  }

  var downloadView: some View {
    VStack(alignment: .leading, spacing: 15) {
      Text("保存链接").font(.title.bold())
      TextField("粘贴作品或媒体链接", text: $link).textFieldStyle(.roundedBorder)
        .controlSize(.large).accessibilityLabel("视频链接").onSubmit { save() }
      HStack {
        Button("下载", action: save).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
          .disabled(running || link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Button("在专属浏览器打开") {
          Task {
            do {
              _ = try await commands.run(["browse", link])
              notice = "已打开专属浏览器。登录后可在此下载。"
            } catch { notice = error.localizedDescription }
          }
        }
        .disabled(link.isEmpty || running)
        if running {
          ProgressView().controlSize(.small)
          Text("正在保存…").foregroundStyle(.secondary)
        }
      }
      HStack {
        Image(systemName: "folder")
        Text(output).lineLimit(1).truncationMode(.middle).help(output)
        Spacer()
        Button("更改目录") {
          let panel = NSOpenPanel()
          panel.canChooseDirectories = true
          panel.canChooseFiles = false
          panel.canCreateDirectories = true
          if panel.runModal() == .OK, let url = panel.url { output = url.path }
        }.disabled(running)
      }.font(.callout)
      if !notice.isEmpty {
        Text(notice).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      }
      if let saved {
        HStack {
          Button("打开文件") {
            if saved.pathExtension.lowercased() == "mp4" {
              movie = MoviePreview(saved)
            } else {
              NSWorkspace.shared.open(saved)
            }
          }
          Text(saved.lastPathComponent).lineLimit(2).textSelection(.enabled)
        }
      }
    }
  }

  private func save() {
    let url = link.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !running, !url.isEmpty else { return }
    running = true
    saved = nil
    notice = ""
    Task {
      defer { running = false }
      do {
        guard
          let result = try await commands.run(["get", url, "--output", output]) as? [String: Any],
          let file = result["filepath"] as? String, FileManager.default.fileExists(atPath: file)
        else { throw FetchyFailure(text: "没有收到可打开的文件。") }
        saved = URL(fileURLWithPath: file)
        notice = "已保存"
      } catch { notice = error.localizedDescription }
    }
  }

  var libraryView: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("收藏库").font(.title.bold())
      TextField("搜索原文、标题或作者", text: $query).textFieldStyle(.roundedBorder)
      HStack {
        TextField("平台", text: $platform)
        TextField("原收藏夹", text: $folder)
        TextField("主题", text: $topic)
      }.textFieldStyle(.roundedBorder)
      if items.isEmpty && serviceNotice.isEmpty { Text("没有匹配的作品。").foregroundStyle(.secondary) }
      List(items) { item in
        HStack {
          VStack(alignment: .leading) {
            Text(item.title).font(.headline)
            Text(item.detail).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          if let file = item.file { Button("离线打开") { NSWorkspace.shared.open(file) } }
        }.padding(.vertical, 4)
      }
    }
  }

  var taskView: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("收藏任务").font(.title.bold())
        Spacer()
        Button("导入收藏清单…", action: selectManifest).disabled(updating)
      }
      if jobs.isEmpty && serviceNotice.isEmpty { Text("暂无收藏任务。").foregroundStyle(.secondary) }
      List(jobs) { job in
        HStack {
          VStack(alignment: .leading, spacing: 3) {
            Text(
              [
                "queued": "排队中", "running": "进行中", "completed": "已完成", "partial": "部分保存",
                "failed": "失败", "interrupted": "已中断",
              ][job.status] ?? job.status
            ).font(.headline)
            Text(job.summary).font(.callout)
            Text(job.id).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(
              .enabled)
          }
          Spacer()
          if ["interrupted", "queued"].contains(job.status) {
            Button("继续") { perform(["resume", job.id]) }.disabled(updating)
          }
          if (job.counts["failed"] ?? 0) > 0 {
            Button("重试失败项") { perform(["retry", job.id]) }.disabled(updating)
          }
        }.padding(.vertical, 4)
      }
    }
  }
  private func selectManifest() {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.json]
    panel.canChooseDirectories = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    updating = true
    Task {
      defer { updating = false }
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
      } catch { serviceNotice = error.localizedDescription }
    }
  }
  private func perform(_ args: [String], payload: Data? = nil) {
    updating = true
    Task {
      defer { updating = false }
      do {
        _ = try await commands.run(args, bridge: true, payload: payload)
        await refresh()
      } catch { serviceNotice = error.localizedDescription }
    }
  }
  private func refresh() async {
    let selected = section
    let requested = filters
    let offset = history.last ?? 0
    do {
      let args = (selected == "收藏库" ? ["search"] + requested : ["tasks"]) + [String(offset)]
      let result = try await commands.run(args, bridge: true)
      guard !Task.isCancelled, selected == section, requested == filters, offset == history.last else { return }
      guard let rows = result as? [[String: Any]] else {
        throw FetchyFailure(text: "收藏服务返回了无法读取的结果。")
      }
      let argument = selected == "收藏库" ? ["search"] + requested : ["tasks"]
      let count = rows.count
      let probe = count > 0 ? try await commands.run(argument + [String(offset + count)], bridge: true) as? [[String: Any]] : nil
      guard !Task.isCancelled, selected == section, requested == filters, offset == history.last else { return }
      nextPage = probe?.isEmpty == false ? offset + count : nil
      if selected == "收藏库" {
        items = rows.compactMap(LibraryItem.init)
      } else {
        jobs = rows.compactMap(CollectionTask.init)
      }
      serviceNotice = ""
    } catch {
      if !Task.isCancelled, selected == section { serviceNotice = error.localizedDescription }
    }
  }
}
