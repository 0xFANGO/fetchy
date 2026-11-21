import AppKit
import CryptoKit
import SwiftUI
import WebKit

// Hidden modes are run by Node (the CLI and the native worker) and answer on stdout.
// Every other launch shows the one Fetchy window.
let hiddenModes: Set<String> = ["logout", "capture", "post", "cookies", "import-cookies", "notify"]
let openRequest = Notification.Name("app.fetchy.desktop.open")
let openAcknowledged = Notification.Name("app.fetchy.desktop.opened")
let siteLoggedOut = Notification.Name("app.fetchy.desktop.logout")
let siteCookiesImported = Notification.Name("app.fetchy.desktop.cookies-imported")
/// `--data-dir <dir>` from `fetchy login`/`browse` under FETCHY_DATA_DIR; Launch Services drops the variable.
var dataDirectoryOverride: String?

/// Another running Fetchy that shows the window (hidden helpers run as accessory apps).
func otherWindowInstance() -> NSRunningApplication? {
  let me = ProcessInfo.processInfo.processIdentifier
  return NSRunningApplication.runningApplications(
    withBundleIdentifier: Bundle.main.bundleIdentifier ?? "app.fetchy.desktop"
  ).first { $0.processIdentifier != me && $0.activationPolicy == .regular }
}

@MainActor final class Application: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var session: BrowserSession?
  var window: NSWindow?
  var cookieView: WKWebView?
  let state = AppState()
  private var confirmedQuit = false

  private var activeDownloadCount: Int {
    state.downloads.active.filter { !$0.isInterrupted }.count
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let args = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }
    if let mode = args.first, hiddenModes.contains(mode) {
      runHidden(mode, args)
      return
    }
    // `fetchy login` and `fetchy browse` reach a running window through this notification.
    // Listen before anything else: AppState can take a request before the window exists.
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(receiveOpen(_:)), name: openRequest, object: nil)
    var route = args
    if let index = route.firstIndex(of: "--data-dir"), index + 1 < route.count {
      dataDirectoryOverride = route[index + 1]
      route.removeSubrange(index...(index + 1))
    }
    // One window: a second launch hands its request to the running window and quits.
    if let other = otherWindowInstance() {
      if route.count == 2, ["login", "browse"].contains(route[0]) {
        DistributedNotificationCenter.default().postNotificationName(
          openRequest, object: nil, userInfo: ["command": route[0], "url": route[1]],
          deliverImmediately: true)
      }
      other.activate(options: [])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
      return
    }
    let defaults =
      (dataDirectoryOverride ?? ProcessInfo.processInfo.environment["FETCHY_DATA_DIR"]).flatMap { path in
        let key = SHA256.hash(data: Data(path.utf8)).prefix(16).map { String(format: "%02x", $0) }
          .joined()
        return UserDefaults(suiteName: "app.fetchy.desktop." + key)
      } ?? .standard
    let host = NSHostingController(
      rootView: MainView().environmentObject(state).defaultAppStorage(defaults))
    // The panes' titles, search field and toolbar buttons go into the window's own toolbar.
    host.sceneBridgingOptions = [.toolbars, .title]
    host.sizingOptions = [.minSize]
    let panel = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
      styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
      backing: .buffered, defer: false
    )
    panel.contentViewController = host
    panel.toolbarStyle = .unified
    panel.setContentSize(NSSize(width: 1200, height: 780))
    panel.title = "Fetchy"
    panel.isReleasedWhenClosed = false
    panel.delegate = self
    panel.setFrameAutosaveName("FetchyMain")
    window = panel
    panel.center()
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    // `fetchy logout` clears the store in another process; this window drops its copy too.
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(receiveLogout(_:)), name: siteLoggedOut, object: nil)
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(receiveCookiesImported(_:)), name: siteCookiesImported, object: nil)
    if route.count == 2, ["login", "browse"].contains(route[0]) { self.open(route[0], route[1]) }
  }

  @objc func receiveOpen(_ notification: Notification) {
    guard let info = notification.userInfo, let command = info["command"] as? String,
      let url = info["url"] as? String
    else { return }
    self.open(command, url)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if let nonce = info["nonce"] as? String {
      DistributedNotificationCenter.default().postNotificationName(
        openAcknowledged, object: nonce, userInfo: nil, deliverImmediately: true)
    }
  }

  @objc func receiveLogout(_ notification: Notification) {
    let info = notification.userInfo
    let rawProfile = (info?["profile"] as? String) ?? (notification.object as? String)
    let profile = rawProfile.flatMap(UUID.init(uuidString:))
    let hosts = Set(info?["hosts"] as? [String] ?? [])
    Task { @MainActor [weak self] in
      guard let self else { return }
      await clearSiteData(hosts: hosts, legacyProfile: profile)
      let matchesCurrent =
        (!hosts.isEmpty && self.state.browser.isViewing(hosts: hosts))
        || (profile != nil && self.state.browser.site?.profile == profile)
      if matchesCurrent {
        self.state.browser.reload()
        self.state.browser.refreshSignIn()
      }
    }
  }

  @objc func receiveCookiesImported(_ notification: Notification) {
    let hosts = Set(notification.userInfo?["hosts"] as? [String] ?? [])
    if !hosts.isEmpty && state.browser.isViewing(hosts: hosts) {
      state.browser.reload()
      state.browser.refreshSignIn()
    }
  }

  func open(_ command: String, _ url: String) {
    state.open(url, signingIn: command == "login")
  }

  // MARK: - Menu Actions

  @objc func browserFocusAddress(_ sender: Any?) {
    state.pane = .browser
    state.browser.requestFocusAddress()
  }

  @objc func browserReload(_ sender: Any?) {
    guard state.pane == .browser else { return }
    state.browser.reload()
  }

  @objc func browserBack(_ sender: Any?) {
    guard state.pane == .browser else { return }
    state.browser.back()
  }

  @objc func browserForward(_ sender: Any?) {
    guard state.pane == .browser else { return }
    state.browser.forward()
  }

  @objc func browserGoHome(_ sender: Any?) {
    state.pane = .browser
    state.browser.goHome()
  }

  @objc func browserZoomIn(_ sender: Any?) {
    guard state.pane == .browser else { return }
    state.browser.zoomIn()
  }

  @objc func browserZoomOut(_ sender: Any?) {
    guard state.pane == .browser else { return }
    state.browser.zoomOut()
  }

  @objc func browserResetZoom(_ sender: Any?) {
    guard state.pane == .browser else { return }
    state.browser.resetZoom()
  }

  @objc func browserToggleSidebar(_ sender: Any?) {
    guard state.pane == .browser else { return }
    state.browser.toggleSidePanel()
  }

  // MARK: - Window & Quit Protection

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    guard sender === window else { return true }
    let running = activeDownloadCount
    guard running > 0, !confirmedQuit else { return true }
    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = "仍有 \(running) 个下载正在进行中"
    alert.informativeText = "隐藏窗口后，下载会继续在后台完成；点击 Dock 图标可随时重新打开 Fetchy。"
    alert.addButton(withTitle: "后台继续下载")
    alert.addButton(withTitle: "取消")
    alert.addButton(withTitle: "仍要退出")
    let response = alert.runModal()
    switch response {
    case .alertFirstButtonReturn:
      sender.orderOut(nil)
      return false
    case .alertThirdButtonReturn:
      confirmedQuit = true
      NSApp.terminate(nil)
      return false
    default:
      return false
    }
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    let running = activeDownloadCount
    guard running > 0, !confirmedQuit else { return .terminateNow }
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "仍有 \(running) 个下载正在进行中"
    alert.informativeText = "退出后正在进行的下载会暂停，下次打开 Fetchy 可以继续。"
    alert.addButton(withTitle: "取消")
    alert.addButton(withTitle: "仍要退出")
    let response = alert.runModal()
    if response == .alertSecondButtonReturn {
      confirmedQuit = true
      return .terminateNow
    }
    return .terminateCancel
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    activeDownloadCount == 0
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag {
      window?.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
    return true
  }

  // MARK: - Hidden CLI Helper Modes

  func runHidden(_ mode: String, _ args: [String]) {
    if mode == "notify" {
      guard args.count == 3 else {
        BrowserSession.respond(["ok": false, "error": "invalid_options"], 1)
      }
      // A running window acknowledges with the nonce; hidden helpers never do.
      let nonce = UUID().uuidString
      _ = DistributedNotificationCenter.default().addObserver(
        forName: openAcknowledged, object: nonce, queue: .main
      ) { _ in
        MainActor.assumeIsolated { () -> Void in
          BrowserSession.respond(["ok": true, "delivered": true])
        }
      }
      DistributedNotificationCenter.default().postNotificationName(
        openRequest, object: nil, userInfo: ["command": args[1], "url": args[2], "nonce": nonce],
        deliverImmediately: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        BrowserSession.respond([
          "ok": true, "delivered": otherWindowInstance()?.isFinishedLaunching == true,
        ])
      }
      return
    }
    guard args.count >= 2, let id = UUID(uuidString: args[1]) else {
      BrowserSession.respond(["ok": false, "error": "invalid_options"], 1)
    }
    if mode == "logout", args.count == 2 || args.count == 3 {
      let hosts = args.count == 3 ? Set(args[2].split(separator: ",").map(String.init)) : Set<String>()
      Task { @MainActor in
        await clearSiteData(hosts: hosts, legacyProfile: id)
        DistributedNotificationCenter.default().postNotificationName(
          Notification.Name("app.fetchy.desktop.logout." + id.uuidString), object: nil,
          userInfo: nil, deliverImmediately: true)
        DistributedNotificationCenter.default().postNotificationName(
          siteLoggedOut, object: id.uuidString,
          userInfo: ["profile": id.uuidString, "hosts": Array(hosts)],
          deliverImmediately: true)
        BrowserSession.respond(["ok": true])
      }
      return
    }
    if mode == "cookies", args.count == 3 {
      readCookies(id, hosts: Set(args[2].split(separator: ",").map(String.init)))
      return
    }
    if mode == "import-cookies", args.count == 3 {
      importCookies(id, hosts: Set(args[2].split(separator: ",").map(String.init)))
      return
    }
    guard
      (mode == "capture" && args.count == 5) || (mode == "post" && args.count == 4),
      let url = URL(string: args[2]), let host = url.host,
      url.scheme == "https"
        || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
      url.user == nil, url.password == nil
    else { BrowserSession.respond(["ok": false, "error": "invalid_options"], 1) }
    let hosts = Set(args.last!.split(separator: ",").map(String.init))
    Task { @MainActor [weak self] in
      await migrateLegacyProfileIfNeeded(id, hosts: hosts)
      self?.session = BrowserSession(
        url, profile: id,
        hosts: hosts,
        readingPost: mode == "post",
        destination: mode == "capture" ? URL(fileURLWithPath: args[3]) : nil)
    }
  }

  // Only cookies for the requested hosts leave the app, and only to the Node process that asked.
  func readCookies(_ profile: UUID, hosts: Set<String>) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
      BrowserSession.respond(["ok": false, "error": "timeout"], 1)
    }
    Task { @MainActor [weak self] in
      let configuration = WKWebViewConfiguration()
      let store = sharedBrowserStore()
      configuration.websiteDataStore = store
      // A web view attached to the store initializes WebKit and loads persisted cookies.
      let view = WKWebView(frame: .zero, configuration: configuration)
      self?.cookieView = view
      await migrateLegacyProfileIfNeeded(profile, hosts: hosts)
      let cookies = await store.httpCookieStore.allCookies()
      let rows: [[String: Any]] = cookies.filter { cookie in
        hosts.contains { cookie.matches(host: $0) }
          && XiaohongshuLogin.shared.mayUse(cookie, profile: profile)
      }.map { cookie in
        [
          "name": cookie.name, "value": cookie.value, "domain": cookie.domain, "path": cookie.path,
          "secure": cookie.isSecure, "httpOnly": cookie.isHTTPOnly,
          "expires": cookie.expiresDate?.timeIntervalSince1970 ?? 0,
        ]
      }
      BrowserSession.respond(["ok": true, "cookies": rows, "xiaohongshuSessionVerification": 1])
    }
  }

  func importCookies(_ profile: UUID, hosts: Set<String>) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
      BrowserSession.respond(["ok": false, "error": "timeout"], 1)
    }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 4 * 1024 * 1024,
      let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else {
      BrowserSession.respond(["ok": false, "error": "invalid_options"], 1)
    }
    Task { @MainActor [weak self] in
      let configuration = WKWebViewConfiguration()
      configuration.websiteDataStore = sharedBrowserStore()
      let view = WKWebView(frame: .zero, configuration: configuration)
      self?.cookieView = view
      let count = await applyImportedCookies(rows, profile: profile, hosts: hosts)
      // Give WebKit's networking helper a moment to flush cookies to disk.
      try? await Task.sleep(nanoseconds: 250_000_000)
      DistributedNotificationCenter.default().postNotificationName(
        siteCookiesImported, object: profile.uuidString,
        userInfo: ["profile": profile.uuidString, "hosts": Array(hosts)],
        deliverImmediately: true)
      BrowserSession.respond(["ok": true, "count": count])
    }
  }
}

@MainActor private func buildMainMenu(_ delegate: Application) -> NSMenu {
  let bar = NSMenu()

  let appItem = NSMenuItem()
  let appMenu = NSMenu(title: "Fetchy")
  appMenu.addItem(
    withTitle: "关于 Fetchy", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
    keyEquivalent: "")
  appMenu.addItem(.separator())
  appMenu.addItem(
    withTitle: "隐藏 Fetchy", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
  let hideOthers = appMenu.addItem(
    withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)),
    keyEquivalent: "h")
  hideOthers.keyEquivalentModifierMask = [.command, .option]
  appMenu.addItem(
    withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)),
    keyEquivalent: "")
  appMenu.addItem(.separator())
  appMenu.addItem(
    withTitle: "退出 Fetchy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
  appItem.submenu = appMenu
  bar.addItem(appItem)

  let fileItem = NSMenuItem()
  let fileMenu = NSMenu(title: "文件")
  fileMenu.addItem(
    withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
  fileItem.submenu = fileMenu
  bar.addItem(fileItem)

  let editItem = NSMenuItem()
  let editMenu = NSMenu(title: "编辑")
  editMenu.addItem(withTitle: "撤销", action: NSSelectorFromString("undo:"), keyEquivalent: "z")
  let redo = editMenu.addItem(
    withTitle: "重做", action: NSSelectorFromString("redo:"), keyEquivalent: "z")
  redo.keyEquivalentModifierMask = [.command, .shift]
  editMenu.addItem(.separator())
  for (name, selector, key) in [
    ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a"),
  ] {
    editMenu.addItem(withTitle: name, action: NSSelectorFromString(selector), keyEquivalent: key)
  }
  editItem.submenu = editMenu
  bar.addItem(editItem)

  let viewItem = NSMenuItem()
  let viewMenu = NSMenu(title: "显示")
  let reloadItem = viewMenu.addItem(
    withTitle: "重新加载页面", action: #selector(Application.browserReload(_:)), keyEquivalent: "r")
  reloadItem.target = delegate
  viewMenu.addItem(.separator())
  let zoomInItem = viewMenu.addItem(
    withTitle: "放大", action: #selector(Application.browserZoomIn(_:)), keyEquivalent: "+")
  zoomInItem.target = delegate
  let zoomInAlt = viewMenu.addItem(
    withTitle: "放大", action: #selector(Application.browserZoomIn(_:)), keyEquivalent: "=")
  zoomInAlt.target = delegate
  zoomInAlt.isAlternate = true
  zoomInAlt.keyEquivalentModifierMask = [.command]
  let zoomOutItem = viewMenu.addItem(
    withTitle: "缩小", action: #selector(Application.browserZoomOut(_:)), keyEquivalent: "-")
  zoomOutItem.target = delegate
  let resetZoomItem = viewMenu.addItem(
    withTitle: "实际大小", action: #selector(Application.browserResetZoom(_:)), keyEquivalent: "0")
  resetZoomItem.target = delegate
  viewMenu.addItem(.separator())
  let sidebarItem = viewMenu.addItem(
    withTitle: "切换右侧媒体栏", action: #selector(Application.browserToggleSidebar(_:)),
    keyEquivalent: "\\")
  sidebarItem.target = delegate
  viewItem.submenu = viewMenu
  bar.addItem(viewItem)

  let goItem = NSMenuItem()
  let goMenu = NSMenu(title: "前往")
  let focusItem = goMenu.addItem(
    withTitle: "聚焦地址栏", action: #selector(Application.browserFocusAddress(_:)),
    keyEquivalent: "l")
  focusItem.target = delegate
  let backItem = goMenu.addItem(
    withTitle: "后退", action: #selector(Application.browserBack(_:)), keyEquivalent: "[")
  backItem.target = delegate
  let forwardItem = goMenu.addItem(
    withTitle: "前进", action: #selector(Application.browserForward(_:)), keyEquivalent: "]")
  forwardItem.target = delegate
  let homeItem = goMenu.addItem(
    withTitle: "起始页", action: #selector(Application.browserGoHome(_:)), keyEquivalent: "h")
  homeItem.keyEquivalentModifierMask = [.command, .shift]
  homeItem.target = delegate
  goItem.submenu = goMenu
  bar.addItem(goItem)

  let windowItem = NSMenuItem()
  let windowMenu = NSMenu(title: "窗口")
  windowMenu.addItem(
    withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
  windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
  windowMenu.addItem(.separator())
  windowMenu.addItem(
    withTitle: "全部置于顶层", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
  windowItem.submenu = windowMenu
  bar.addItem(windowItem)

  return bar
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let hidden = hiddenModes.contains(CommandLine.arguments.dropFirst().first ?? "")
  app.setActivationPolicy(hidden ? .accessory : .regular)
  let delegate = Application()
  if !hidden {
    app.mainMenu = buildMainMenu(delegate)
  }
  app.delegate = delegate
  withExtendedLifetime(delegate) { app.run() }
}
