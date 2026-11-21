import SwiftUI
import WebKit

struct AccountRow: Identifiable {
  let site: String
  let label: String
  let url: String
  let status: String
  let verified: Bool
  var id: String { site }
  init?(_ row: [String: Any]) {
    guard let site = row["site"] as? String, let url = row["url"] as? String else { return nil }
    self.site = site
    self.url = url
    label = row["label"] as? String ?? site
    status = row["status"] as? String ?? "logged_out"
    verified = row["verified"] as? Bool ?? false
  }
  var statusText: String {
    switch status {
    case "logged_in": return verified ? "已登录" : "有登录信息"
    case "expired": return "已过期"
    default: return "未登录"
    }
  }
  var statusColor: Color {
    switch status {
    case "logged_in": return .green
    case "expired": return .orange
    default: return .secondary
    }
  }
}

private let externalBrowsers: [(id: String, label: String)] = [
  ("chrome", "Chrome"),
  ("safari", "Safari"),
  ("edge", "Edge"),
  ("firefox", "Firefox"),
  ("brave", "Brave"),
]

/// One row per site. Status comes from `fetchy accounts`, which reads each site's own cookies.
struct AccountsPane: View {
  @EnvironmentObject var app: AppState
  private let commands = LocalCommands()
  @State private var rows: [AccountRow] = []
  @State private var newSite = ""
  @State private var notice = ""
  @State private var noticeIsError = false
  @State private var busy = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("在这里登录一次，桌面端、浏览器扩展和命令行都会复用同一份登录态。如遇到复杂验证，也可从 Chrome / Safari 导入登录态。")
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        Button {
          Task { await refresh() }
        } label: {
          Label("刷新状态", systemImage: "arrow.clockwise")
        }
        .controlSize(.small).disabled(busy)
      }
      if !notice.isEmpty {
        HStack(spacing: 8) {
          Image(systemName: noticeIsError ? "exclamationmark.triangle" : "checkmark.circle")
            .foregroundStyle(noticeIsError ? .orange : .green)
          Text(notice)
            .font(.callout)
            .foregroundStyle(noticeIsError ? .primary : .secondary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer()
          Button {
            notice = ""
            noticeIsError = false
          } label: {
            Image(systemName: "xmark").font(.caption)
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(noticeIsError ? Color.orange.opacity(0.1) : Color.primary.opacity(0.05))
        )
      }
      ScrollViewReader { proxy in
        List(rows) { row in
          HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
              Text(row.label).font(.headline)
              Text(row.url).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(row.statusText).font(.callout).foregroundStyle(row.statusColor)
            if let shortcut = shortcutFor(site: row.site) {
              Button("打开\(shortcut.favoritesLabel)") {
                app.openFavorites(shortcut)
              }
              .controlSize(.small)
            }
            Button(row.status == "logged_in" ? "打开网站" : "登录") {
              app.open(row.url, signingIn: true)
            }
            .controlSize(.small)
            Menu("导入登录态") {
              ForEach(externalBrowsers, id: \.id) { browser in
                Button("从 \(browser.label) 导入") {
                  Task { await importFromBrowser(row, browser: browser.id, label: browser.label) }
                }
              }
            }
            .controlSize(.small)
            .fixedSize()
            .disabled(busy)
            if row.status != "logged_out" {
              Button("退出登录") { Task { await logout(row) } }
                .controlSize(.small).disabled(busy)
            }
          }
          .padding(.vertical, 4)
          .listRowBackground(app.focusedSite == row.site ? fetchyAccent.opacity(0.12) : nil)
          .id(row.site)
        }
        .onChange(of: app.focusedSite) { _, site in
          if let site { withAnimation { proxy.scrollTo(site, anchor: .center) } }
        }
        .onAppear { if let site = app.focusedSite { proxy.scrollTo(site, anchor: .center) } }
      }
      HStack {
        TextField("添加其他网站，例如 https://forum.example.org", text: $newSite)
          .textFieldStyle(.roundedBorder).onSubmit { Task { await add() } }
        Button("添加") { Task { await add() } }
          .disabled(busy || newSite.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
    .padding(22)
    .navigationTitle("账号")
    .task { await refresh() }
    .onChange(of: app.pane) { _, pane in if pane == .accounts { Task { await refresh() } } }
  }

  private func refresh() async {
    do {
      let result = try await commands.run(["accounts"]) as? [[String: Any]] ?? []
      rows = result.compactMap(AccountRow.init)
    } catch {
      notice = error.localizedDescription
      noticeIsError = true
    }
  }

  private func importFromBrowser(_ row: AccountRow, browser: String, label: String) async {
    busy = true
    defer { busy = false }
    notice = "正在从 \(label) 读取 \(row.label) 登录态…"
    noticeIsError = false
    do {
      let result =
        try await commands.run(["import-cookies", row.site, browser, "--inline"], bridge: true)
        as? [String: Any]
      var count = result?["count"] as? Int ?? 0
      if let rawProfile = result?["profile"] as? String,
        let profile = UUID(uuidString: rawProfile),
        let hosts = result?["hosts"] as? [String],
        let cookieRows = result?["cookies"] as? [[String: Any]]
      {
        count = await applyImportedCookies(cookieRows, profile: profile, hosts: Set(hosts))
      }
      if let info = try? await app.browser.siteInfo(row.url),
        app.browser.isViewing(hosts: Set(info.hosts))
      {
        app.browser.reload()
        app.browser.refreshSignIn()
      }
      await refresh()
      notice = "已从 \(label) 导入 \(row.label) 登录态（\(count) 条 Cookie）。"
      noticeIsError = false
    } catch {
      notice = error.localizedDescription
      noticeIsError = true
    }
  }

  private func logout(_ row: AccountRow) async {
    busy = true
    defer { busy = false }
    do {
      let info = try await app.browser.siteInfo(row.url)
      let hostSet = Set(info.hosts)
      await clearSiteData(hosts: hostSet, legacyProfile: info.profile)
      _ = try await commands.run(["logout", row.site])
      if app.browser.isViewing(hosts: hostSet) {
        app.browser.reload()
        app.browser.refreshSignIn()
      }
      await refresh()
      notice = "已退出 \(row.label)，其他站点登录态不受影响。"
      noticeIsError = false
    } catch {
      notice = error.localizedDescription
      noticeIsError = true
    }
  }

  private func add() async {
    var raw = newSite.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return }
    if !raw.contains("://") { raw = "https://" + raw }
    busy = true
    defer { busy = false }
    do {
      guard let row = try await commands.run(["account-add", raw], bridge: true) as? [String: Any],
        let site = row["site"] as? String
      else { throw FetchyFailure(text: "无法添加这个网站。") }
      newSite = ""
      notice = ""
      noticeIsError = false
      await refresh()
      app.focusedSite = site
    } catch {
      notice = error.localizedDescription
      noticeIsError = true
    }
  }
}
