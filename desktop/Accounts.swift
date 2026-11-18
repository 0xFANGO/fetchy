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

/// One row per site. Status comes from `fetchy accounts`, which reads each site's own cookies.
struct AccountsPane: View {
  @EnvironmentObject var app: AppState
  private let commands = LocalCommands()
  @State private var rows: [AccountRow] = []
  @State private var newSite = ""
  @State private var notice = ""
  @State private var busy = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("账号").font(.title.bold())
        Spacer()
        Button("刷新") { Task { await refresh() } }.disabled(busy)
      }
      Text("在这里登录一次，浏览器扩展、命令行和桌面端的下载都会用到。登录只在 Fetchy 的内置浏览器里进行。")
        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      ScrollViewReader { proxy in
        List(rows) { row in
          HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
              Text(row.label).font(.headline)
              Text(row.url).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(row.statusText).foregroundStyle(row.statusColor)
            Button(row.status == "logged_in" ? "打开" : "登录") { app.open(row.url, signingIn: true) }
            if row.status != "logged_out" {
              Button("退出登录") { Task { await logout(row) } }.disabled(busy)
            }
          }
          .padding(.vertical, 4)
          .listRowBackground(app.focusedSite == row.site ? Color.accentColor.opacity(0.12) : nil)
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
      if !notice.isEmpty { Text(notice).foregroundStyle(.secondary) }
    }
    .padding(22)
    .task { await refresh() }
    .onChange(of: app.pane) { _, pane in if pane == .accounts { Task { await refresh() } } }
  }

  private func refresh() async {
    do {
      let result = try await commands.run(["accounts"]) as? [[String: Any]] ?? []
      rows = result.compactMap(AccountRow.init)
      notice = ""
    } catch { notice = error.localizedDescription }
  }

  private func logout(_ row: AccountRow) async {
    busy = true
    defer { busy = false }
    do {
      // Clear the store in this process too: the open browser keeps its cookies in memory.
      let info = try await app.browser.siteInfo(row.url)
      await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        WKWebsiteDataStore(forIdentifier: info.profile).removeData(
          ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
        ) { done.resume() }
      }
      _ = try await commands.run(["logout", row.site])
      if app.browser.site?.profile == info.profile {
        app.browser.reload()
        app.browser.refreshSignIn()
      }
      await refresh()
    } catch { notice = error.localizedDescription }
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
      await refresh()
      app.focusedSite = site
    } catch { notice = error.localizedDescription }
  }
}
