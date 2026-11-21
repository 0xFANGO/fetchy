import AppKit
import SwiftUI

func formatBytes(_ bytes: Int64) -> String {
  ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
}

func formatSpeed(_ bytesPerSec: Int64) -> String {
  guard bytesPerSec > 0 else { return "" }
  return ByteCountFormatter.string(fromByteCount: bytesPerSec, countStyle: .file) + "/s"
}

/// Active download cards shown at the top of the main Downloads view — one card per item.
struct ActiveDownloadsSection: View {
  @ObservedObject var downloads: DownloadsModel

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text("正在下载").font(.headline)
        Text("\(downloads.active.count)")
          .font(.caption.weight(.semibold)).monospacedDigit()
          .foregroundStyle(.white)
          .padding(.horizontal, 7).padding(.vertical, 2)
          .background(Capsule().fill(fetchyAccent))
        Spacer()
        if downloads.hasInterrupted {
          Button("继续中断项") { Task { await downloads.resumeInterrupted() } }
            .controlSize(.small)
        }
        if downloads.active.count > 1 {
          Button("全部取消") { Task { await downloads.cancelAllActive() } }
            .controlSize(.small).foregroundStyle(.secondary)
        }
      }
      VStack(spacing: 8) {
        ForEach(downloads.active) { item in
          ActiveDownloadRow(item: item) {
            Task { await downloads.cancelItem(item) }
          }
        }
      }
    }
    .padding(14)
    .background {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(Color.primary.opacity(0.035))
        .overlay {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
        }
    }
  }
}

struct ActiveDownloadRow: View {
  let item: ActiveDownloadItem
  let onCancel: () -> Void
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(item.isRunning ? fetchyAccent.opacity(0.14) : Color.primary.opacity(0.06))
        Image(
          systemName: item.isInterrupted
            ? "pause.circle"
            : item.kind == "video"
              ? "film"
              : item.kind == "audio" ? "waveform" : "photo"
        )
        .foregroundStyle(item.isRunning ? fetchyAccent : .secondary)
      }
      .frame(width: 36, height: 36)

      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 6) {
          Text(item.title).font(.callout.weight(.medium)).lineLimit(1)
          Spacer(minLength: 8)
          Text(statusRightText)
            .font(.caption).monospacedDigit().foregroundStyle(.secondary)
        }

        if let fraction = item.fraction {
          ProgressView(value: fraction)
            .progressViewStyle(.linear)
            .tint(fetchyAccent)
        } else if item.isRunning {
          ProgressView()
            .progressViewStyle(.linear)
            .tint(fetchyAccent)
        } else {
          ProgressView(value: 0)
            .progressViewStyle(.linear)
        }

        HStack(spacing: 6) {
          Text(metaLine)
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
          Spacer()
        }
      }

      Button(action: onCancel) {
        Image(systemName: "xmark.circle.fill")
          .foregroundStyle(hovering ? Color.primary.opacity(0.7) : Color.secondary.opacity(0.55))
          .font(.title3)
      }
      .buttonStyle(.plain)
      .help("取消此条下载")
    }
    .padding(.horizontal, 12).padding(.vertical, 9)
    .background {
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(Color(nsColor: .controlBackgroundColor))
        .overlay {
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .strokeBorder(Color.primary.opacity(0.06), lineWidth: 1)
        }
    }
    .onHover { hovering = $0 }
  }

  private var metaLine: String {
    var parts = [platformName(item.platform)]
    if !item.folder.isEmpty { parts.append(item.folder) }
    parts.append(item.stageText)
    return parts.joined(separator: " · ")
  }

  private var statusRightText: String {
    if item.totalBytes > 0 {
      let pct = Int((Double(item.downloadedBytes) / Double(item.totalBytes) * 100).rounded())
      var parts = ["\(formatBytes(item.downloadedBytes)) / \(formatBytes(item.totalBytes))"]
      let spd = formatSpeed(item.speedBytesPerSec)
      if !spd.isEmpty { parts.append(spd) }
      parts.append("\(pct)%")
      return parts.joined(separator: " · ")
    }
    if item.downloadedBytes > 0 {
      let spd = formatSpeed(item.speedBytesPerSec)
      return spd.isEmpty
        ? formatBytes(item.downloadedBytes)
        : "\(formatBytes(item.downloadedBytes)) · \(spd)"
    }
    return item.isRunning ? "进行中" : (item.isInterrupted ? "已中断" : "排队中")
  }
}

/// Flat list of failed downloads shown when the user selects the "失败" filter pill.
struct FailedDownloadsSection: View {
  @EnvironmentObject var app: AppState
  @ObservedObject var downloads: DownloadsModel

  var body: some View {
    if downloads.failed.isEmpty {
      ContentUnavailableView {
        Label("没有失败的下载", systemImage: "checkmark.circle")
      } description: {
        Text("下载失败的条目会出现在这里，可以查看具体原因并一键重试。")
      }
      .frame(maxWidth: .infinity, minHeight: 280)
    } else {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("共 \(downloads.failed.count) 条下载失败")
            .font(.callout).foregroundStyle(.secondary)
          Spacer()
          Button("重试全部") { Task { await downloads.retryAllFailed() } }
            .buttonStyle(.borderedProminent).controlSize(.small)
          Button("清空失败记录") { Task { await downloads.dismissFailed() } }
            .controlSize(.small)
        }

        LazyVStack(spacing: 8) {
          ForEach(downloads.failed) { item in
            FailedDownloadRow(downloads: downloads, item: item)
          }
        }
      }
    }
  }
}

struct FailedDownloadRow: View {
  @EnvironmentObject var app: AppState
  @ObservedObject var downloads: DownloadsModel
  let item: FailedDownloadItem

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle((item.needsLogin || item.needsVerification) ? Color.orange : Color.red)
        .font(.title3)

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          Text(item.title).font(.callout.weight(.medium)).lineLimit(1)
          Text(item.reasonLabel)
            .font(.caption2.weight(.semibold))
            .foregroundStyle((item.needsLogin || item.needsVerification) ? Color.orange : Color.red)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(
              Capsule().fill(((item.needsLogin || item.needsVerification) ? Color.orange : Color.red).opacity(0.12)))
        }
        Text(
          ([platformName(item.platform), item.author].filter { !$0.isEmpty }.joined(separator: " · ")
            + (item.stepHint.isEmpty ? "" : " · " + item.stepHint))
        )
        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }

      Spacer(minLength: 10)

      HStack(spacing: 6) {
        if item.needsVerification, let source = item.sourceUrl {
          Button("去验证") {
            app.open(source, signingIn: false)
          }
          .controlSize(.small)
        } else if item.needsLogin {
          Button("去登录") {
            if let shortcut = shortcutFor(site: item.platform) {
              app.open(shortcut.url, signingIn: true)
            } else if let source = item.sourceUrl {
              app.open(source, signingIn: true)
            } else {
              app.focusedSite = item.platform
              app.pane = .accounts
            }
          }
          .controlSize(.small)
        }
        if let source = item.sourceUrl {
          Button("原帖") { app.open(source) }
            .controlSize(.small)
        }
        Button("重试") { Task { await downloads.retryItem(item) } }
          .buttonStyle(.borderedProminent).controlSize(.small)
        Button {
          Task { await downloads.dismissFailed([item.key]) }
        } label: {
          Image(systemName: "xmark")
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.borderless)
        .help("移除此失败记录")
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .background {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color(nsColor: .controlBackgroundColor))
        .overlay {
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
        }
    }
  }
}
