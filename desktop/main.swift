import AppKit
import CryptoKit
import SwiftUI
import WebKit

// Hidden modes are run by Node (the CLI and the native worker) and answer on stdout.
// Every other launch shows the one Fetchy window.
let hiddenModes: Set<String> = ["logout", "capture", "post", "cookies", "notify"]
let openRequest = Notification.Name("app.fetchy.desktop.open")

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
    let defaults =
      ProcessInfo.processInfo.environment["FETCHY_DATA_DIR"].flatMap { path in
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
    // `fetchy login` and `fetchy browse` reach a running window through this notification.
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(receiveOpen(_:)), name: openRequest, object: nil)
    if args.count == 2, ["login", "browse"].contains(args[0]) { route(args[0], args[1]) }
  }

  @objc func receiveOpen(_ notification: Notification) {
    guard let info = notification.userInfo, let command = info["command"] as? String,
      let url = info["url"] as? String
    else { return }
    route(command, url)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func route(_ command: String, _ url: String) {
    state.open(url, signingIn: command == "login")
  }

  func runHidden(_ mode: String, _ args: [String]) {
    if mode == "notify" {
      guard args.count == 3 else {
        BrowserSession.respond(["ok": false, "error": "invalid_options"], 1)
      }
      DistributedNotificationCenter.default().postNotificationName(
        openRequest, object: nil, userInfo: ["command": args[1], "url": args[2]],
        deliverImmediately: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { BrowserSession.respond(["ok": true]) }
      return
    }
    guard args.count >= 2, let id = UUID(uuidString: args[1]) else {
      BrowserSession.respond(["ok": false, "error": "invalid_options"], 1)
    }
    if mode == "logout", args.count == 2 {
      DistributedNotificationCenter.default().postNotificationName(
        Notification.Name("app.fetchy.desktop.logout." + id.uuidString), object: nil,
        userInfo: nil, deliverImmediately: true)
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
      BrowserSession.respond(["ok": true, "cookies": rows])
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
