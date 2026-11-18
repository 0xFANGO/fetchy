import AppKit
import CryptoKit
import SwiftUI
import WebKit

// Hidden modes are run by Node (the CLI and the native worker) and answer on stdout.
// Every other launch shows the one Fetchy window.
let hiddenModes: Set<String> = ["logout", "capture", "post", "cookies", "notify"]
let openRequest = Notification.Name("app.fetchy.desktop.open")
let openAcknowledged = Notification.Name("app.fetchy.desktop.opened")
let siteLoggedOut = Notification.Name("app.fetchy.desktop.logout")
/// `--data-dir <dir>` from `fetchy login`/`browse` under FETCHY_DATA_DIR; Launch Services drops the variable.
var dataDirectoryOverride: String?

/// Another running Fetchy that shows the window (hidden helpers run as accessory apps).
func otherWindowInstance() -> NSRunningApplication? {
  let me = ProcessInfo.processInfo.processIdentifier
  return NSRunningApplication.runningApplications(
    withBundleIdentifier: Bundle.main.bundleIdentifier ?? "app.fetchy.desktop"
  ).first { $0.processIdentifier != me && $0.activationPolicy == .regular }
}

@MainActor final class Application: NSObject, NSApplicationDelegate {
  var session: BrowserSession?
  var window: NSWindow?
  var cookieView: WKWebView?
  let state = AppState()

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
    let host = NSHostingView(
      rootView: MainView().environmentObject(state).defaultAppStorage(defaults))
    let panel = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
      styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false
    )
    panel.contentView = host
    panel.title = "Fetchy"
    panel.isReleasedWhenClosed = false
    panel.setFrameAutosaveName("FetchyMain")
    window = panel
    panel.center()
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    // `fetchy logout` clears the store in another process; this window drops its copy too.
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(receiveLogout(_:)), name: siteLoggedOut, object: nil)
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
    guard let raw = notification.object as? String, let profile = UUID(uuidString: raw) else {
      return
    }
    WKWebsiteDataStore(forIdentifier: profile).removeData(
      ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
    ) { [weak self] in
      guard let browser = self?.state.browser, browser.site?.profile == profile else { return }
      browser.reload()
      browser.refreshSignIn()
    }
  }

  func open(_ command: String, _ url: String) {
    state.open(url, signingIn: command == "login")
  }

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
        // Delivered on the main queue; the reply touches main-actor state.
        MainActor.assumeIsolated { () -> Void in
          BrowserSession.respond(["ok": true, "delivered": true])
        }
      }
      DistributedNotificationCenter.default().postNotificationName(
        openRequest, object: nil, userInfo: ["command": args[1], "url": args[2], "nonce": nonce],
        deliverImmediately: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        // A window that is slow to answer still gets the request; only hidden helpers
        // (accessory policy) or no instance at all mean a new window must be launched.
        BrowserSession.respond([
          "ok": true, "delivered": otherWindowInstance()?.isFinishedLaunching == true,
        ])
      }
      return
    }
    guard args.count >= 2, let id = UUID(uuidString: args[1]) else {
      BrowserSession.respond(["ok": false, "error": "invalid_options"], 1)
    }
    if mode == "logout", args.count == 2 {
      DistributedNotificationCenter.default().postNotificationName(
        Notification.Name("app.fetchy.desktop.logout." + id.uuidString), object: nil,
        userInfo: nil, deliverImmediately: true)
      DistributedNotificationCenter.default().postNotificationName(
        siteLoggedOut, object: id.uuidString, userInfo: nil, deliverImmediately: true)
      let store = WKWebsiteDataStore(forIdentifier: id)
      store.removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
      ) {
        BrowserSession.respond(["ok": true])
      }
      return
    }
    if mode == "cookies", args.count == 3 {
      readCookies(id, hosts: Set(args[2].split(separator: ",").map(String.init)))
      return
    }
    guard
      (mode == "capture" && args.count == 5) || (mode == "post" && args.count == 4),
      let url = URL(string: args[2]), let host = url.host,
      url.scheme == "https"
        || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
      url.user == nil, url.password == nil
    else { BrowserSession.respond(["ok": false, "error": "invalid_options"], 1) }
    session = BrowserSession(
      url, profile: id,
      hosts: Set(args.last!.split(separator: ",").map(String.init)),
      readingPost: mode == "post",
      destination: mode == "capture" ? URL(fileURLWithPath: args[3]) : nil)
  }

  // Only cookies for the requested hosts leave the app, and only to the Node process that asked.
  func readCookies(_ profile: UUID, hosts: Set<String>) {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: profile)
    // A web view attached to the store makes WebKit load its persisted cookies.
    let view = WKWebView(frame: .zero, configuration: configuration)
    cookieView = view
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
      BrowserSession.respond(["ok": false, "error": "timeout"], 1)
    }
    configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
      let rows: [[String: Any]] = cookies.filter { cookie in
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        return hosts.contains { $0 == domain || $0.hasSuffix("." + domain) }
      }.map { cookie in
        [
          "name": cookie.name, "value": cookie.value, "domain": cookie.domain, "path": cookie.path,
          "secure": cookie.isSecure, "httpOnly": cookie.isHTTPOnly,
          "expires": cookie.expiresDate?.timeIntervalSince1970 ?? 0,
        ]
      }
      // WebKit calls back on the main thread.
      MainActor.assumeIsolated { () -> Void in
        BrowserSession.respond(["ok": true, "cookies": rows])
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let hidden = hiddenModes.contains(CommandLine.arguments.dropFirst().first ?? "")
  app.setActivationPolicy(hidden ? .accessory : .regular)
  if !hidden {
    let bar = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "退出 Fetchy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    bar.addItem(appItem)
    let edit = NSMenuItem()
    let edits = NSMenu(title: "编辑")
    for (name, selector, key) in [
      ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a"),
    ] {
      edits.addItem(withTitle: name, action: NSSelectorFromString(selector), keyEquivalent: key)
    }
    edit.submenu = edits
    bar.addItem(edit)
    app.mainMenu = bar
  }
  let delegate = Application()
  app.delegate = delegate
  withExtendedLifetime(delegate) { app.run() }
}
