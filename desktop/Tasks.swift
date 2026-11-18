import AppKit
import SwiftUI

struct TaskItem: Identifiable {
  let task: String
  let key: String
  let status: String
  let reason: String
  let title: String
  let author: String
  let platform: String
  let sourceUrl: String?
  let file: URL?
  var id: String { task + "\n" + key }

  init?(task: String, _ row: [String: Any]) {
    guard let key = row["key"] as? String, let status = row["status"] as? String,
      ["failed", "partial"].contains(status)
    else { return nil }
    self.task = task
    self.key = key
    self.status = status
    reason = row["reason"] as? String ?? (status == "partial" ? "partial" : "save_failed")
    title = row["title"] as? String ?? ""
    author = row["author"] as? String ?? ""
    platform = row["platform"] as? String ?? String(key.split(separator: ":").first ?? "")
    sourceUrl = row["sourceUrl"] as? String
    file = (row["filepath"] as? String).map { URL(fileURLWithPath: $0) }
  }
}

/// Entries of one task that failed for the same reason, so one next step covers them all.
struct ReasonGroup: Identifiable {
  let task: TaskSummary
  let reason: String
  let items: [TaskItem]
  var id: String { task.id + "\n" + reason }
  var label: String { failureReasons[reason] ?? reason }
  var step: String? { nextSteps[reason] }
  var partial: Bool { items.allSatisfy { $0.status == "partial" } }
}

/// Counts of one task in one line: what is saved, what is missing, what is left.
struct TaskCounts: View {
  let task: TaskSummary
  var body: some View {
    HStack(spacing: 14) {
      ForEach(
        [
          ("已保存", "added", Color.secondary), ("已有", "skipped", Color.secondary),
          ("部分", "partial", Color.orange), ("失败", "failed", Color.red), ("等待", "pending", Color.secondary),
        ], id: \.1
      ) { entry in
        if task.count(entry.1) > 0 {
          Text("\(entry.0) \(task.count(entry.1))").foregroundStyle(entry.2)
        }
      }
    }
    .font(.caption).monospacedDigit()
  }
}

struct TaskHeader: View {
  let task: TaskSummary
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(task.title).font(.headline).lineLimit(1)
        Text(statusNames[task.status] ?? task.status)
          .font(.caption.weight(.medium))
          .foregroundStyle(task.status == "running" ? fetchyAccent : Color.secondary)
      }
      HStack(spacing: 14) {
        if !task.subtitle.isEmpty {
          Text(task.subtitle).font(.caption).foregroundStyle(.secondary)
        }
        TaskCounts(task: task)
      }
    }
  }
}

let statusNames: [String: String] = [
  "queued": "等待开始", "running": "保存中", "completed": "已完成", "partial": "部分完成", "failed": "失败",
  "interrupted": "已中断",
]

struct TasksPane: View {
  @EnvironmentObject var app: AppState
  @ObservedObject var library: LibraryModel
  @State private var problems: [String: [TaskItem]] = [:]
  @State private var loaded = false
  @State private var expanded: Set<String> = []
  @State private var seen: Set<String> = []
  @State private var notice = ""
  private var commands: LocalCommands { library.commands }
  private var attention: Bool { app.sidebar == .attention }
  private var active: [TaskSummary] { library.tasks.filter(\.isActive) }
  private var troubled: [TaskSummary] { library.tasks.filter { $0.problems > 0 } }
  private var recent: [TaskSummary] { Array(library.tasks.filter { !$0.isActive }.prefix(8)) }

  var body: some View {
    Group {
      if attention { attentionView } else { activeView }
    }
    .navigationTitle(app.sidebar.title)
    .navigationSubtitle(
      attention ? "\(library.problemCount) 条" : active.isEmpty ? "" : "\(active.count) 个任务"
    )
    .safeAreaInset(edge: .top, spacing: 0) {
      if !notice.isEmpty {
        VStack(spacing: 0) {
          HStack {
            Text(notice).font(.callout)
            Spacer()
            Button {
              notice = ""
            } label: {
              Image(systemName: "xmark")
            }
            .buttonStyle(.borderless).help("关闭")
          }
          .padding(.horizontal, 20).padding(.vertical, 8)
          Divider()
        }
        .background(.bar)
      }
    }
    .task(id: attention ? library.revision : -1) {
      if attention { await loadProblems() }
    }
  }

  // MARK: In progress

  @ViewBuilder var activeView: some View {
    if active.isEmpty && recent.isEmpty {
      ContentUnavailableView {
        Label("没有正在保存的任务", systemImage: "arrow.down.circle")
      } description: {
        Text("在「浏览器」里打开收藏夹勾选保存，或在资料库的搜索框粘贴链接。保存在后台进行，可以关掉窗口。")
      }
    } else {
      List {
        Section("正在保存") {
          if active.isEmpty {
            Text("没有正在保存的任务。").foregroundStyle(.secondary)
          }
          ForEach(active) { task in
            VStack(alignment: .leading, spacing: 8) {
              HStack(alignment: .top) {
                TaskHeader(task: task)
                Spacer()
                if task.status == "interrupted" {
                  Button("继续") { run(["resume", task.id]) }
                }
              }
              HStack(spacing: 10) {
                ProgressView(value: Double(task.done), total: Double(max(task.total, 1)))
                Text("\(task.done) / \(task.total)").font(.caption).monospacedDigit()
                  .foregroundStyle(.secondary)
              }
            }
            .padding(.vertical, 6)
          }
        }
        if !recent.isEmpty {
          Section("最近完成") {
            ForEach(recent) { task in
              HStack(alignment: .top) {
                TaskHeader(task: task)
                Spacer()
                if task.problems > 0 {
                  Button("查看 \(task.problems) 条问题") { app.sidebar = .attention }
                    .buttonStyle(.link)
                }
              }
              .padding(.vertical, 4)
            }
          }
        }
      }
      .listStyle(.inset)
    }
  }

  // MARK: Needs attention

  @ViewBuilder var attentionView: some View {
    if troubled.isEmpty {
      ContentUnavailableView {
        Label("没有需要处理的条目", systemImage: "checkmark.circle")
      } description: {
        Text("保存失败或只存下一部分的条目会出现在这里，并说明原因和下一步。")
      }
    } else if !loaded {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      List {
        ForEach(troubled.prefix(20)) { task in
          Section {
            ForEach(groups(task)) { group in
              DisclosureGroup(isExpanded: binding(group.id)) {
                ForEach(group.items) { item in itemRow(item, task: task) }
              } label: {
                groupLabel(group)
              }
            }
          } header: {
            HStack(alignment: .top) {
              TaskHeader(task: task)
              Spacer()
              Button("重试全部 \(task.problems) 条") { run(["retry", task.id]) }
                .disabled(task.isActive)
            }
            .padding(.vertical, 6)
          }
        }
      }
      .listStyle(.inset)
    }
  }

  private func groups(_ task: TaskSummary) -> [ReasonGroup] {
    let rows = problems[task.id] ?? []
    var order: [String] = []
    var byReason: [String: [TaskItem]] = [:]
    for item in rows {
      if byReason[item.reason] == nil { order.append(item.reason) }
      byReason[item.reason, default: []].append(item)
    }
    return order.map { ReasonGroup(task: task, reason: $0, items: byReason[$0]!) }
      .sorted { $0.items.count > $1.items.count }
  }

  private func binding(_ id: String) -> Binding<Bool> {
    Binding(
      get: { expanded.contains(id) },
      set: { open in if open { expanded.insert(id) } else { expanded.remove(id) } })
  }

  @ViewBuilder private func groupLabel(_ group: ReasonGroup) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: group.partial ? "exclamationmark.circle.fill" : "xmark.octagon.fill")
        .foregroundStyle(group.partial ? Color.orange : Color.red)
      VStack(alignment: .leading, spacing: 2) {
        Text("\(group.label) · \(group.items.count) 条").font(.body.weight(.medium))
        if let step = group.step {
          Text(step).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 12)
      if loginReasons.contains(group.reason) {
        Button("去登录") { signIn(group.items[0].platform) }
      }
      Button("重试这 \(group.items.count) 条") { run(["retry", group.task.id] + group.items.map(\.key)) }
        .disabled(group.task.isActive || ["selection_missing", "no_formats"].contains(group.reason))
    }
    .padding(.vertical, 4)
  }

  @ViewBuilder private func itemRow(_ item: TaskItem, task: TaskSummary) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(item.title.isEmpty ? "未读到标题" : item.title).lineLimit(1)
          .foregroundStyle(item.title.isEmpty ? Color.secondary : Color.primary)
        Text(
          [platformName(item.platform), item.author, item.status == "partial" ? "部分保存" : "未保存"]
            .filter { !$0.isEmpty }.joined(separator: " · ")
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      Spacer(minLength: 12)
      if let file = item.file {
        Button("离线页") { NSWorkspace.shared.open(file) }
      }
      if let source = item.sourceUrl {
        Button("打开原帖") { app.open(source) }
      }
      Button("重试") { run(["retry", task.id, item.key]) }.disabled(task.isActive)
    }
    .buttonStyle(.borderless)
    .padding(.vertical, 2)
  }

  private func signIn(_ platform: String) {
    app.focusedSite = platform
    app.sidebar = .accounts
  }

  private func run(_ args: [String]) {
    Task {
      do {
        _ = try await commands.run(args, bridge: true)
        notice = args[0] == "resume" ? "已继续保存。" : "已开始重试，进度在「进行中」。"
        await library.refresh()
      } catch { notice = error.localizedDescription }
    }
  }

  /// Every failed and partial entry of the tasks shown, page by page, so entry 300 still shows.
  private func loadProblems() async {
    var details: [String: [TaskItem]] = [:]
    do {
      for task in troubled.prefix(20) {
        var rows: [[String: Any]] = []
        while true {
          let detail =
            try await commands.run(["task", task.id, String(rows.count), "failed"], bridge: true)
            as? [String: Any]
          let page = detail?["items"] as? [[String: Any]] ?? []
          rows += page
          if page.isEmpty || rows.count >= (detail?["totalItems"] as? Int ?? 0) { break }
        }
        details[task.id] = rows.compactMap { TaskItem(task: task.id, $0) }
      }
    } catch {
      notice = error.localizedDescription
    }
    problems = details
    loaded = true
    // Small groups open on first sight; large ones stay folded until asked.
    for task in troubled.prefix(20) {
      for group in groups(task) where !seen.contains(group.id) {
        seen.insert(group.id)
        if group.items.count <= 6 { expanded.insert(group.id) }
      }
    }
  }
}
