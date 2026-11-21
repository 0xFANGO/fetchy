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
        Image(systemName: kind == "video" ? "play.rectangle" : "photo.on.rectangle")
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
  let onReveal: () -> Void
  @State private var hovering = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Color.clear
        .aspectRatio(16 / 10, contentMode: .fit)
        .overlay {
          CoverImage(
            url: entry.cover,
            kind: entry.coverKind ?? (entry.kind == "video" ? "video" : nil))
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(
              selected ? fetchyAccent : Color.primary.opacity(0.08),
              lineWidth: selected ? 2.5 : 1)
        }
        .overlay(alignment: .topLeading) { kindBadge }
        .overlay(alignment: .topTrailing) {
          if selected {
            Image(systemName: "checkmark.circle.fill")
              .symbolRenderingMode(.palette)
              .foregroundStyle(.white, fetchyAccent)
              .font(.title2).padding(6)
          } else if hovering {
            Button(action: onReveal) {
              Image(systemName: "folder.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(6)
                .background(Circle().fill(Color.black.opacity(0.6)))
            }
            .buttonStyle(.plain)
            .padding(6)
            .help("在访达中显示文件")
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
        .background(Circle().fill(Color.black.opacity(0.58)))
        .padding(6)
    } else if entry.mediaCount > 1 {
      Text("\(entry.mediaCount) 张图")
        .font(.caption2.weight(.semibold)).monospacedDigit()
        .foregroundStyle(.white)
        .padding(.horizontal, 6).padding(.vertical, 3)
        .background(Capsule().fill(Color.black.opacity(0.58)))
        .padding(6)
    }
  }
}

enum LibraryFilter: String, CaseIterable, Identifiable {
  case all, video, post, failed
  var id: String { rawValue }
  var title: String {
    switch self {
    case .all: return "全部"
    case .video: return "视频"
    case .post: return "图文"
    case .failed: return "失败"
    }
  }
}

/// Flat single-page Downloads & Library workspace modeled after Downbit.
struct DownloadsHomePane: View {
  @EnvironmentObject var app: AppState
  @ObservedObject var downloads: DownloadsModel
  @AppStorage("library.view") private var viewMode = "grid"
  @State private var filter: LibraryFilter = .all
  @State private var platformFilter = ""
  @State private var text = ""
  @State private var entries: [LibraryEntry] = []
  @State private var loaded = false
  @State private var more = false
  @State private var scopeKey = ""
  @State private var selection: Set<String> = []
  @State private var anchor: String?
  @State private var renaming: LibraryEntry?
  @State private var newTitle = ""
  @State private var deleting: [LibraryEntry] = []
  @State private var notice = ""
  @State private var submittingUrl = false
  @State private var preview: ManifestPreview?
  @FocusState private var gridFocused: Bool
  private let commands = LocalCommands()

  /// Detect a pasted link (with or without https://) even when wrapped in share copy.
  private var detectedLink: String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if let range = trimmed.range(
      of: #"https?://[^\s<>'"\u3000\uFF0C\u3002\uFF01\uFF1F]+"#,
      options: .regularExpression
    ) {
      let candidate = String(trimmed[range])
      if let u = URL(string: candidate), u.host != nil { return candidate }
    }
    let knownPlatformPattern =
      #"(?:^|[\s\u3000\uFF0C\u3002\uFF01\uFF1F])((?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be|bilibili\.com|b23\.tv|xiaohongshu\.com|xhslink\.com|rednote\.com|douyin\.com|iesdouyin\.com|x\.com|twitter\.com|t\.co|instagram\.com|threads\.com|threads\.net|tiktok\.com|zhihu\.com|weibo\.com|kuaishou\.com|vimeo\.com|twitch\.tv|reddit\.com|dailymotion\.com)(?:/[^\s<>'"\u3000\uFF0C\u3002\uFF01\uFF1F]*)?)"#
    if let regex = try? NSRegularExpression(pattern: knownPlatformPattern, options: .caseInsensitive),
      let match = regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
      let range = Range(match.range(at: 1), in: trimmed)
    {
      let candidate = "https://" + String(trimmed[range])
      if let u = URL(string: candidate), u.host != nil { return candidate }
    }
    if !trimmed.contains(where: \.isWhitespace) {
      let bareUrlPattern = #"^(?:www\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/[^\s<>'"]+$"#
      if trimmed.range(of: bareUrlPattern, options: .regularExpression) != nil {
        let candidate = "https://" + trimmed
        if let u = URL(string: candidate), u.host != nil { return candidate }
      }
    }
    return nil
  }

  private var query: String { detectedLink == nil ? text.trimmingCharacters(in: .whitespaces) : "" }
  private var selected: [LibraryEntry] { entries.filter { selection.contains($0.id) } }

  private var kindParam: String {
    switch filter {
    case .video: return "video"
    case .post: return "post"
    default: return ""
    }
  }

  private var scope: [String] { [platformFilter, "", kindParam] }

  private var sortedPlatforms: [(key: String, value: Int)] {
    downloads.stats.platforms.sorted { $0.value > $1.value }
  }

  var body: some View {
    VStack(spacing: 0) {
      omniboxBar
      Divider()

      if !notice.isEmpty || !downloads.notice.isEmpty {
        HStack(spacing: 8) {
          Text(!notice.isEmpty ? notice : downloads.notice)
            .font(.callout).foregroundStyle(.secondary)
          Spacer()
          Button {
            notice = ""
            downloads.notice = ""
          } label: {
            Image(systemName: "xmark").font(.caption)
          }
          .buttonStyle(.borderless)
        }
        .padding(.horizontal, 20).padding(.vertical, 8)
        .background(.bar)
        Divider()
      }

      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if !downloads.active.isEmpty {
            ActiveDownloadsSection(downloads: downloads)
          }

          filterBar

          if filter == .failed {
            FailedDownloadsSection(downloads: downloads)
          } else if !loaded {
            ProgressView()
              .frame(maxWidth: .infinity, minHeight: 240)
          } else if entries.isEmpty {
            emptyState
          } else if viewMode == "list" {
            listView
          } else {
            gridView
          }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .top)
      }

      bottomBar
    }
    .navigationTitle("Fetchy")
    .task(id: ([query] + scope).joined(separator: "\u{1f}")) {
      if !query.isEmpty { try? await Task.sleep(nanoseconds: 180_000_000) }
      guard !Task.isCancelled else { return }
      await reload()
    }
    .onChange(of: downloads.revision) { _, _ in Task { await reload() } }
    .onChange(of: filter) { _, _ in selection.removeAll() }
    .sheet(item: $preview) { item in
      SelectionSheet(item) { selectedKeys in
        Task {
          do {
            let data = try JSONSerialization.data(withJSONObject: selectedKeys)
            _ = try await commands.run(["import", item.source.path], bridge: true, payload: data)
            notice = "已加入下载队列。"
            await downloads.refresh()
          } catch { notice = error.localizedDescription }
        }
      }
    }
    .sheet(item: $renaming) { entry in
      VStack(alignment: .leading, spacing: 12) {
        Text("重命名").font(.headline)
        TextField("标题", text: $newTitle)
          .textFieldStyle(.roundedBorder)
          .onSubmit {
            rename(entry)
            renaming = nil
          }
        Text("将同步更新已下载文件的文件名。留空则恢复原标题。")
          .font(.caption).foregroundStyle(.secondary)
        HStack {
          Spacer()
          Button("取消") { renaming = nil }
          Button("保存") {
            rename(entry)
            renaming = nil
          }
          .buttonStyle(.borderedProminent)
        }
      }
      .padding(20).frame(width: 420)
    }
    .confirmationDialog(
      deleting.count == 1 ? "将「\(deleting[0].title)」移到废纸篓？" : "将选中的 \(deleting.count) 项移到废纸篓？",
      isPresented: Binding(get: { !deleting.isEmpty }, set: { if !$0 { deleting = [] } }),
      titleVisibility: .visible
    ) {
      Button("移到废纸篓", role: .destructive) {
        let items = deleting
        deleting = []
        remove(items)
      }
      Button("取消", role: .cancel) { deleting = [] }
    } message: {
      Text("已下载的视频和图片原文件也会一并移到废纸篓，可从废纸篓恢复。")
    }
  }

  // MARK: - Top Omnibox

  var omniboxBar: some View {
    HStack(spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: detectedLink != nil ? "link" : "magnifyingglass")
          .foregroundStyle(detectedLink != nil ? fetchyAccent : .secondary)
        TextField("粘贴视频或帖子链接以下载，或搜索已下载内容", text: $text)
          .textFieldStyle(.plain)
          .onSubmit {
            if detectedLink != nil { startLinkDownload() }
          }
        if !text.isEmpty {
          Button {
            text = ""
          } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .background {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(Color(nsColor: .controlBackgroundColor))
          .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
              .strokeBorder(
                detectedLink != nil ? fetchyAccent.opacity(0.6) : Color.primary.opacity(0.1),
                lineWidth: 1)
          }
      }

      if detectedLink != nil {
        Button {
          startLinkDownload()
        } label: {
          Label(submittingUrl ? "正在加入…" : "下载", systemImage: "arrow.down.circle.fill")
        }
        .buttonStyle(.borderedProminent)
        .disabled(submittingUrl)
      }

      Button {
        selectManifest()
      } label: {
        Image(systemName: "square.and.arrow.down")
      }
      .buttonStyle(.bordered)
      .help("导入收藏清单 (JSON)…")
    }
    .padding(.horizontal, 20).padding(.vertical, 12)
  }

  // MARK: - Single Horizontal Filter Pill Bar

  var filterBar: some View {
    HStack(spacing: 8) {
      Text("已下载").font(.headline).padding(.trailing, 4)

      ForEach(LibraryFilter.allCases) { item in
        filterPill(item)
      }

      if sortedPlatforms.count > 1 && filter != .failed {
        Menu {
          Button("全部平台") { platformFilter = "" }
          Divider()
          ForEach(sortedPlatforms, id: \.key) { item in
            Button("\(platformName(item.key)) (\(item.value))") {
              platformFilter = item.key
            }
          }
        } label: {
          HStack(spacing: 4) {
            Text(platformFilter.isEmpty ? "全部平台" : platformName(platformFilter))
            Image(systemName: "chevron.down").font(.caption2)
          }
          .font(.callout)
          .padding(.horizontal, 10).padding(.vertical, 5)
          .background(Capsule().fill(Color.primary.opacity(0.06)))
        }
        .buttonStyle(.plain)
      }

      Spacer()

      if let dir = downloads.downloadsDir {
        Button {
          downloads.openDownloadsFolder()
        } label: {
          Label(abbreviateHome(dir.path), systemImage: "folder")
            .font(.caption).foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .buttonStyle(.plain)
        .help("在访达中打开下载文件夹")
      }

      if filter != .failed {
        Picker("视图", selection: $viewMode) {
          Image(systemName: "square.grid.2x2").tag("grid")
          Image(systemName: "list.bullet").tag("list")
        }
        .pickerStyle(.segmented).labelsHidden().frame(width: 68)
      }
    }
  }

  @ViewBuilder private func filterPill(_ item: LibraryFilter) -> some View {
    let active = filter == item
    let count = countFor(item)
    Button {
      filter = item
    } label: {
      HStack(spacing: 5) {
        Text(item.title)
        if count > 0 {
          Text("\(count)")
            .font(.caption2.weight(.semibold)).monospacedDigit()
            .foregroundStyle(
              active ? .white : (item == .failed ? .white : .secondary)
            )
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(
              Capsule().fill(
                active
                  ? Color.white.opacity(0.25)
                  : (item == .failed ? Color.red.opacity(0.85) : Color.primary.opacity(0.08))
              )
            )
        }
      }
      .font(.callout.weight(active ? .medium : .regular))
      .foregroundStyle(active ? .white : .primary)
      .padding(.horizontal, 11).padding(.vertical, 5)
      .background(
        Capsule().fill(active ? fetchyAccent : Color.primary.opacity(0.06))
      )
    }
    .buttonStyle(.plain)
  }

  private func countFor(_ item: LibraryFilter) -> Int {
    switch item {
    case .all: return downloads.stats.total
    case .video: return (downloads.stats.kinds["video"] ?? 0) + (downloads.stats.kinds["audio"] ?? 0)
    case .post: return (downloads.stats.kinds["post"] ?? 0) + (downloads.stats.kinds["article"] ?? 0)
    case .failed: return downloads.failed.count
    }
  }

  private func abbreviateHome(_ path: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
  }

  // MARK: - Downloaded Content (Grid / List / Empty)

  @ViewBuilder var emptyState: some View {
    ContentUnavailableView {
      Label(
        query.isEmpty ? "还没有已下载的内容" : "没有找到匹配项",
        systemImage: query.isEmpty ? "arrow.down.doc" : "magnifyingglass")
    } description: {
      Text(
        query.isEmpty
          ? "在上方粘贴视频或帖子链接直接下载，或打开内置浏览器直达各平台收藏夹一键批量下载。"
          : "试试其他关键词或切换筛选条件。")
    } actions: {
      if query.isEmpty {
        Button("打开浏览器") { app.pane = .browser }
          .buttonStyle(.borderedProminent)
        if !platformFilter.isEmpty || filter != .all {
          Button("查看全部") {
            platformFilter = ""
            filter = .all
          }
        }
      } else {
        Button("清空搜索") { text = "" }
      }
    }
    .frame(maxWidth: .infinity, minHeight: 280)
  }

  var gridView: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 196, maximum: 260), spacing: 14)], spacing: 16) {
      ForEach(entries) { entry in
        EntryCard(
          entry: entry,
          selected: selection.contains(entry.id),
          onReveal: { reveal([entry]) }
        )
        .onTapGesture {
          if NSApp.currentEvent?.clickCount == 2 { open([entry]) } else { click(entry.id) }
        }
        .contextMenu { menu(for: targets(entry)) }
      }
    }
    .frame(maxWidth: .infinity, alignment: .top)
    .contentShape(Rectangle())
    .onTapGesture { selection.removeAll() }
    .focusable()
    .focusEffectDisabled()
    .focused($gridFocused)
    .onCommand(#selector(NSText.selectAll(_:))) { selectAll() }
    .onDeleteCommand { if !selection.isEmpty { deleting = selected } }
  }

  var listView: some View {
    LazyVStack(spacing: 6) {
      ForEach(entries) { entry in
        let isSelected = selection.contains(entry.id)
        HStack(spacing: 12) {
          Image(systemName: entry.kind == "video" ? "film" : (entry.kind == "audio" ? "waveform" : "doc.richtext"))
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(width: 28, height: 28)
            .background(Color(nsColor: .quaternaryLabelColor).opacity(0.25), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
          VStack(alignment: .leading, spacing: 2) {
            Text(entry.title).font(.callout.weight(.medium)).lineLimit(1)
            Text(
              [platformName(entry.platform), entry.kindName, entry.author]
                .filter { !$0.isEmpty }.joined(separator: " · ")
            )
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
          Spacer()
          Button("打开") { open([entry]) }.controlSize(.small)
          Button {
            reveal([entry])
          } label: {
            Image(systemName: "folder")
          }
          .buttonStyle(.borderless).help("在访达中显示")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(isSelected ? fetchyAccent.opacity(0.12) : Color(nsColor: .controlBackgroundColor))
            .overlay {
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(isSelected ? fetchyAccent : Color.primary.opacity(0.06), lineWidth: 1)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
          if NSApp.currentEvent?.clickCount == 2 { open([entry]) } else { click(entry.id) }
        }
        .contextMenu { menu(for: targets(entry)) }
      }
    }
    .focusable()
    .focusEffectDisabled()
    .focused($gridFocused)
    .onCommand(#selector(NSText.selectAll(_:))) { selectAll() }
    .onDeleteCommand { if !selection.isEmpty { deleting = selected } }
  }

  @ViewBuilder var bottomBar: some View {
    if !selection.isEmpty {
      VStack(spacing: 0) {
        Divider()
        HStack(spacing: 10) {
          Text("已选 \(selection.count) 项").font(.callout.weight(.medium)).monospacedDigit()
          if selection.count < entries.count {
            Button("全选") { selectAll() }
          }
          Spacer()
          Button("打开") { open(selected) }
          Button("在访达中显示") { reveal(selected) }
          if selection.count == 1, let only = selected.first {
            Button("重命名…") { startRename(only) }
          }
          Button("移到废纸篓…", role: .destructive) { deleting = selected }
          Button("取消选择") { selection.removeAll() }
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
      }
      .background(.bar)
    } else if more && filter != .failed {
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

  @ViewBuilder func menu(for items: [LibraryEntry]) -> some View {
    if !items.isEmpty {
      Button(items.count == 1 ? "打开文件" : "打开 \(items.count) 个文件") { open(items) }
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
      Button(items.count == 1 ? "移到废纸篓…" : "将 \(items.count) 项移到废纸篓…", role: .destructive) {
        deleting = items
      }
    }
  }

  // MARK: - Actions

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
    for entry in items.prefix(20) {
      if let target = entry.openTarget { NSWorkspace.shared.open(target) }
    }
  }

  private func reveal(_ items: [LibraryEntry]) {
    let urls = items.flatMap(\.revealTargets)
    if !urls.isEmpty { NSWorkspace.shared.activateFileViewerSelecting(urls) }
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
          .filter { FileManager.default.fileExists(atPath: $0.path) }
        let count = (result?["removed"] as? [String])?.count ?? keys.count
        selection.subtract(keys)
        notice = "已将 \(count) 项移到废纸篓。"
        if !files.isEmpty {
          NSWorkspace.shared.recycle(files) { _, error in
            guard error != nil else { return }
            DispatchQueue.main.async {
              notice = "已从列表删除 \(count) 项，部分文件未能自动移到废纸篓。"
            }
          }
        }
        await downloads.refresh()
        await reload()
      } catch { notice = error.localizedDescription }
    }
  }

  private func startLinkDownload() {
    guard let url = detectedLink, !submittingUrl else { return }
    submittingUrl = true
    notice = ""
    Task {
      defer { submittingUrl = false }
      if await downloads.startUrlDownload(url) {
        text = ""
      }
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
        guard !options.isEmpty else { throw FetchyFailure(text: "清单没有可下载的条目。") }
        preview = ManifestPreview(source: url, items: options)
      } catch { notice = error.localizedDescription }
    }
  }
}
