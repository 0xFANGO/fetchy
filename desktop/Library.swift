import AVFoundation
import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// Decoded covers, shared by the grid and the list so scrolling does not decode again.
let coverCache = NSCache<NSURL, NSImage>()

struct CoverImage: View {
  let url: URL?
  let kind: String?
  var symbol: Font = .largeTitle
  @State private var image: NSImage?

  var body: some View {
    ZStack {
      Rectangle().fill(Color.primary.opacity(0.06))
      if let image {
        Image(nsImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: kind == "video" ? "play.rectangle" : "doc.richtext")
          .font(symbol).foregroundStyle(.tertiary)
      }
    }
    .clipped()
    .task(id: url) { image = await load() }
  }

  private func load() async -> NSImage? {
    guard let url else { return nil }
    if let hit = coverCache.object(forKey: url as NSURL) { return hit }
    let frame: CGImage?
    if kind == "video" {
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: 480, height: 480)
      frame = try? await generator.image(at: .zero).image
    } else {
      // A downsampled thumbnail: full-size photos would hold hundreds of megabytes in a long grid.
      frame = await Task.detached(priority: .utility) { () -> CGImage? in
        let options =
          [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 480,
          ] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
      }.value
    }
    guard let frame else { return nil }
    let image = NSImage(cgImage: frame, size: .zero)
    coverCache.setObject(image, forKey: url as NSURL)
    return image
  }
}

struct EntryCard: View {
  let entry: LibraryEntry
  let selected: Bool
  @State private var hovering = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Color.clear
        .aspectRatio(4 / 3, contentMode: .fit)
        .overlay {
          CoverImage(url: entry.cover, kind: entry.coverKind ?? (entry.kind == "video" ? "video" : nil))
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(selected ? fetchyAccent : Color.primary.opacity(0.08), lineWidth: selected ? 2.5 : 1)
        }
        .overlay(alignment: .topLeading) { kindBadge }
        .overlay(alignment: .topTrailing) {
          if selected {
            Image(systemName: "checkmark.circle.fill")
              .symbolRenderingMode(.palette)
              .foregroundStyle(.white, fetchyAccent)
              .font(.title2).padding(6)
          }
        }
        .overlay(alignment: .bottomLeading) {
          if entry.status == "partial" {
            Label("部分保存", systemImage: "exclamationmark.circle.fill")
              .font(.caption2.weight(.semibold)).foregroundStyle(.white)
              .padding(.horizontal, 6).padding(.vertical, 3)
              .background(Capsule().fill(Color.orange))
              .padding(6)
          }
        }
      VStack(alignment: .leading, spacing: 3) {
        Text(entry.title).font(.callout.weight(.medium)).lineLimit(2, reservesSpace: true)
        Text(entry.meta).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
      .padding(.horizontal, 2)
    }
    .padding(6)
    .background {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(
          selected
            ? fetchyAccent.opacity(0.12) : hovering ? Color.primary.opacity(0.05) : Color.clear)
    }
    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .onHover { hovering = $0 }
    .help(entry.title)
  }

  @ViewBuilder var kindBadge: some View {
    if entry.kind == "video" || entry.kind == "audio" {
      Image(systemName: entry.kind == "video" ? "play.fill" : "waveform")
        .font(.caption2.weight(.bold)).foregroundStyle(.white)
        .padding(5)
        .background(Circle().fill(Color.black.opacity(0.55)))
        .padding(6)
    }
  }
}

struct LibraryPane: View {
  @EnvironmentObject var app: AppState
  @ObservedObject var library: LibraryModel
  @AppStorage("library.view") private var viewMode = "grid"
  @State private var text = ""
  @State private var entries: [LibraryEntry] = []
  @State private var loaded = false
  @State private var more = false
  @State private var scopeKey = ""
  @State private var selection = Set<String>()
  @State private var anchor: String?
  @State private var notice = ""
  @State private var saving = false
  @State private var preview: ManifestPreview?
  @State private var renaming: LibraryEntry?
  @State private var newTitle = ""
  @State private var deleting: [LibraryEntry] = []
  @FocusState private var gridFocused: Bool
  private var commands: LocalCommands { library.commands }

  private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var link: String? {
    let value = trimmed
    let looksLikeLink =
      value.contains("://") || value.range(of: #"^[\w-]+(\.[\w-]+)+/"#, options: .regularExpression) != nil
    return looksLikeLink && !value.contains(" ") ? value : nil
  }
  private var query: String { link == nil ? trimmed : "" }
  /// platform, folder and kind for the native search, from the sidebar.
  private var scope: [String] {
    switch app.sidebar {
    case .video: return ["", "", "video"]
    case .post: return ["", "", "post"]
    case .article: return ["", "", "article"]
    case .platform(let id): return [id, "", ""]
    case .folder(let name): return ["", name, ""]
    default: return ["", "", ""]
    }
  }
  private var selected: [LibraryEntry] { entries.filter { selection.contains($0.id) } }
  private var scopeTotal: Int? {
    let stats = library.stats
    switch app.sidebar {
    case .all: return stats.total
    case .video: return (stats.kinds["video"] ?? 0) + (stats.kinds["audio"] ?? 0)
    case .post: return stats.kinds["post"] ?? 0
    case .article: return stats.kinds["article"] ?? 0
    case .platform(let id): return stats.platforms[id] ?? 0
    case .folder(let name): return stats.folders[name] ?? 0
    default: return nil
    }
  }
  private var subtitle: String {
    if !query.isEmpty { return "找到 \(entries.count)\(more ? "+" : "") 项" }
    return scopeTotal.map { "\($0) 项" } ?? ""
  }

  var body: some View {
    content
      .navigationTitle(app.sidebar.title)
      .navigationSubtitle(subtitle)
      .searchable(text: $text, placement: .toolbar, prompt: "搜索，或粘贴链接保存")
      .onSubmit(of: .search) { if link != nil { save() } }
      .toolbar { toolbar }
      .safeAreaInset(edge: .top, spacing: 0) { banners }
      .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
      .task(id: [query, scope.joined(separator: "\u{1f}"), String(library.revision)].joined(separator: "\u{1e}")) {
        try? await Task.sleep(nanoseconds: 200_000_000)
        guard !Task.isCancelled else { return }
        await reload()
      }
      .onChange(of: app.sidebar) { _, _ in selection.removeAll() }
      .sheet(item: $preview) { manifest in
        SelectionSheet(manifest) { keys in
          let data = try? JSONSerialization.data(withJSONObject: keys)
          Task {
            do {
              _ = try await commands.run(["import", manifest.source.path], bridge: true, payload: data)
              await library.refresh()
              app.sidebar = .active
            } catch { notice = error.localizedDescription }
          }
        }
      }
      .alert(
        "重命名", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
        presenting: renaming
      ) { entry in
        TextField("标题", text: $newTitle)
        Button("取消", role: .cancel) {}
        Button("重命名") { rename(entry) }
      } message: { _ in
        Text("只改资料库里显示的标题。留空则恢复网站上的标题。")
      }
      .confirmationDialog(
        deleting.count == 1 ? "删除「\(deleting[0].title)」？" : "删除 \(deleting.count) 项？",
        isPresented: Binding(get: { !deleting.isEmpty }, set: { if !$0 { deleting = [] } }),
        titleVisibility: .visible
      ) {
        Button("移到废纸篓", role: .destructive) { remove(deleting) }
        Button("取消", role: .cancel) {}
      } message: {
        Text("离线页和只属于这些作品的图片、视频会移到废纸篓。保存任务的记录会保留，以后可以重新保存。")
      }
  }

  @ViewBuilder var content: some View {
    if loaded && entries.isEmpty {
      emptyState
    } else if viewMode == "list" {
      table
    } else {
      grid
    }
  }

  @ViewBuilder var emptyState: some View {
    if !query.isEmpty {
      ContentUnavailableView.search(text: query)
    } else if library.stats.total == 0 {
      ContentUnavailableView {
        Label("资料库还是空的", systemImage: "tray")
      } description: {
        Text("在右上角的搜索框粘贴一个链接保存，或在「浏览器」里打开收藏夹，勾选后批量保存。")
      } actions: {
        Button("打开浏览器") { app.sidebar = .browser }
      }
    } else {
      ContentUnavailableView(
        "这里还没有作品", systemImage: "square.grid.2x2", description: Text("换一个分类或来源看看。"))
    }
  }

  @ToolbarContentBuilder var toolbar: some ToolbarContent {
    ToolbarItem {
      Picker("显示方式", selection: $viewMode) {
        Label("封面", systemImage: "square.grid.2x2").tag("grid")
        Label("列表", systemImage: "list.bullet").tag("list")
      }
      .pickerStyle(.segmented).help("用封面或列表显示")
    }
    ToolbarItem {
      Menu {
        Button("全选") { selectAll() }.disabled(entries.isEmpty)
        Divider()
        Button("在访达中打开资料库文件夹") {
          if let root = library.root { NSWorkspace.shared.open(root) }
        }
        .disabled(library.root == nil)
        Button("导入收藏清单…", action: selectManifest)
      } label: {
        Label("更多", systemImage: "ellipsis.circle")
      }
      .help("更多操作")
    }
  }

  @ViewBuilder var banners: some View {
    VStack(spacing: 0) {
      if let link {
        HStack(spacing: 10) {
          Image(systemName: "link").foregroundStyle(.secondary)
          Text(link).lineLimit(1).truncationMode(.middle)
          Spacer(minLength: 12)
          if saving { ProgressView().controlSize(.small) }
          Button(saving ? "正在保存…" : "保存到资料库", action: save)
            .buttonStyle(.borderedProminent).disabled(saving)
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(.bar)
        Divider()
      }
      if !notice.isEmpty {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(notice).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 12)
          Button {
            notice = ""
          } label: {
            Image(systemName: "xmark")
          }
          .buttonStyle(.borderless).help("关闭")
        }
        .font(.callout)
        .padding(.horizontal, 20).padding(.vertical, 8)
        .background(.bar)
        Divider()
      }
    }
  }

  @ViewBuilder var bottomBar: some View {
    if !selection.isEmpty {
      VStack(spacing: 0) {
        Divider()
        HStack(spacing: 8) {
          Text("已选 \(selection.count) 项").font(.callout.weight(.medium)).monospacedDigit()
          Button("全选", action: selectAll).buttonStyle(.link)
            .disabled(selection.count == entries.count)
          Button("取消选择") { selection.removeAll() }.buttonStyle(.link)
          Spacer(minLength: 12)
          Button { open(selected) } label: { Label("打开", systemImage: "doc.text") }
          Button { reveal(selected) } label: { Label("在访达中显示", systemImage: "folder") }
          Button {
            if let entry = selected.first { startRename(entry) }
          } label: {
            Label("重命名", systemImage: "pencil")
          }
          .disabled(selection.count != 1)
          Button(role: .destructive) {
            deleting = selected
          } label: {
            Label("删除", systemImage: "trash")
          }
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
      }
      .background(.bar)
    } else if more {
      VStack(spacing: 0) {
        Divider()
        HStack {
          Text("已显示 \(entries.count) 项").font(.callout).foregroundStyle(.secondary).monospacedDigit()
          Spacer()
          Button("加载更多") { Task { await loadMore() } }
        }
        .padding(.horizontal, 20).padding(.vertical, 8)
      }
      .background(.bar)
    }
  }

  var grid: some View {
    ScrollView {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 176, maximum: 260), spacing: 12)], spacing: 14) {
        ForEach(entries) { entry in
          EntryCard(entry: entry, selected: selection.contains(entry.id))
            .onTapGesture {
              // One gesture for both, so a click selects at once and the second click of a
              // double-click opens, without waiting for the double-click interval.
              if NSApp.currentEvent?.clickCount == 2 { open([entry]) } else { click(entry.id) }
            }
            .contextMenu { menu(for: targets(entry)) }
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .top)
      .contentShape(Rectangle())
      .onTapGesture { selection.removeAll() }
    }
    .focusable()
    .focusEffectDisabled()
    .focused($gridFocused)
    .onCommand(#selector(NSText.selectAll(_:))) { selectAll() }
    .onDeleteCommand { if !selection.isEmpty { deleting = selected } }
  }

  var table: some View {
    Table(entries, selection: $selection) {
      TableColumn("标题") { entry in
        HStack(spacing: 10) {
          Color.clear.frame(width: 32, height: 24)
            .overlay {
              CoverImage(
                url: entry.cover, kind: entry.coverKind ?? (entry.kind == "video" ? "video" : nil),
                symbol: .caption)
            }
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
          Text(entry.title).lineLimit(1)
          if entry.status == "partial" {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange).help("部分保存")
          }
        }
      }
      TableColumn("类型") { entry in Text(entry.kindName).foregroundStyle(.secondary) }
        .width(min: 40, ideal: 52, max: 80)
      TableColumn("来源") { entry in Text(platformName(entry.platform)) }
        .width(min: 60, ideal: 84, max: 140)
      TableColumn("作者") { entry in Text(entry.author).lineLimit(1) }
        .width(min: 60, ideal: 120)
      TableColumn("收藏夹") { entry in
        Text(entry.folders.joined(separator: "、")).lineLimit(1).foregroundStyle(.secondary)
      }
      .width(min: 60, ideal: 140)
    }
    .contextMenu(forSelectionType: String.self) { ids in
      menu(for: entries.filter { ids.contains($0.id) })
    } primaryAction: { ids in
      open(entries.filter { ids.contains($0.id) })
    }
    .onDeleteCommand { if !selection.isEmpty { deleting = selected } }
  }

  @ViewBuilder func menu(for items: [LibraryEntry]) -> some View {
    if !items.isEmpty {
      Button(items.count == 1 ? "打开离线页" : "打开 \(items.count) 个离线页") { open(items) }
      Button("在访达中显示") { reveal(items) }
      if items.count == 1, let entry = items.first {
        if let source = entry.sourceUrl {
          Button("在内置浏览器打开原帖") { app.open(source) }
          Button("拷贝原帖链接") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(source, forType: .string)
          }
        }
        Button("重命名…") { startRename(entry) }
      }
      Divider()
      Button(items.count == 1 ? "删除…" : "删除 \(items.count) 项…", role: .destructive) {
        deleting = items
      }
    }
  }

  /// A right-click acts on the selection when it lands inside it, like Finder.
  private func targets(_ entry: LibraryEntry) -> [LibraryEntry] {
    selection.contains(entry.id) ? selected : [entry]
  }

  private func click(_ id: String) {
    gridFocused = true
    let flags = NSApp.currentEvent?.modifierFlags ?? NSEvent.modifierFlags
    if flags.contains(.command) {
      if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
      anchor = id
    } else if flags.contains(.shift), let anchor,
      let from = entries.firstIndex(where: { $0.id == anchor }),
      let to = entries.firstIndex(where: { $0.id == id })
    {
      selection.formUnion(entries[min(from, to)...max(from, to)].map(\.id))
    } else {
      selection = [id]
      anchor = id
    }
  }

  private func selectAll() { selection = Set(entries.map(\.id)) }

  private func open(_ items: [LibraryEntry]) {
    // Opening hundreds of pages at once is never what a click meant.
    for entry in items.prefix(20) { if let file = entry.file { NSWorkspace.shared.open(file) } }
  }

  /// Saved images and videos when there are any, otherwise the offline page.
  private func reveal(_ items: [LibraryEntry]) {
    let files = items.flatMap { entry in entry.files.isEmpty ? [entry.file].compactMap { $0 } : entry.files }
    if !files.isEmpty { NSWorkspace.shared.activateFileViewerSelecting(files) }
  }

  private func startRename(_ entry: LibraryEntry) {
    newTitle = entry.title
    renaming = entry
  }

  private func rename(_ entry: LibraryEntry) {
    let title = newTitle
    Task {
      do {
        _ = try await commands.run(["rename", entry.id], bridge: true, payload: Data(title.utf8))
        await reload()
      } catch { notice = error.localizedDescription }
    }
  }

  private func remove(_ items: [LibraryEntry]) {
    let keys = items.map(\.id)
    Task {
      do {
        let data = try JSONSerialization.data(withJSONObject: keys)
        let result = try await commands.run(["remove"], bridge: true, payload: data) as? [String: Any]
        let files = (result?["files"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }
        let count = (result?["removed"] as? [String])?.count ?? keys.count
        selection.subtract(keys)
        notice = "已删除 \(count) 项，文件已移到废纸篓。"
        if !files.isEmpty {
          NSWorkspace.shared.recycle(files) { _, error in
            guard error != nil else { return }
            DispatchQueue.main.async {
              notice = "已从资料库删除 \(count) 项，但有些文件没能移到废纸篓。可以在资料库文件夹里手动删除。"
            }
          }
        }
        await library.refresh()
        await reload()
      } catch { notice = error.localizedDescription }
    }
  }

  private func save() {
    guard let value = link, !saving else { return }
    saving = true
    notice = ""
    Task {
      defer { saving = false }
      do {
        let result = try await commands.run(["get", value]) as? [String: Any]
        notice = result?["status"] as? String == "partial" ? "部分保存，缺少的内容见离线页。" : "已保存到资料库。"
        text = ""
        await library.refresh()
      } catch { notice = error.localizedDescription }
    }
  }

  private func search(offset: Int) async throws -> [LibraryEntry] {
    let rows =
      try await commands.run(
        ["search", query, scope[0], scope[1], "", String(offset), scope[2]], bridge: true)
      as? [[String: Any]] ?? []
    more = rows.count >= 100
    return rows.compactMap(LibraryEntry.init)
  }

  /// Reload the current view. A refresh of the same view keeps the pages already loaded.
  private func reload() async {
    let key = ([query] + scope).joined(separator: "\u{1f}")
    let keep = key == scopeKey ? max(entries.count, 1) : 1
    do {
      var rows: [LibraryEntry] = []
      repeat {
        rows += try await search(offset: rows.count)
      } while more && rows.count < keep
      entries = rows
      scopeKey = key
      loaded = true
      selection.formIntersection(rows.map(\.id))
    } catch { notice = error.localizedDescription }
  }

  private func loadMore() async {
    do { entries += try await search(offset: entries.count) } catch {
      notice = error.localizedDescription
    }
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
