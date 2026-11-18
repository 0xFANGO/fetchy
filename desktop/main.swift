import AppKit
import CryptoKit
import SwiftUI
import WebKit

@MainActor final class Application: NSObject, NSApplicationDelegate {
  var session: BrowserSession?
  var window: NSWindow?
  func applicationDidFinishLaunching(_ notification: Notification) {
    let args = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }
    if let mode = args.first {
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
      guard
        (mode == "browse" && args.count == 3) || (mode == "capture" && args.count == 5)
          || (mode == "post" && args.count == 4),
        let url = URL(string: args[2]), let host = url.host,
        url.scheme == "https"
          || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
        url.user == nil, url.password == nil
      else { BrowserSession.respond(["ok": false, "error": "invalid_options"], 1) }
      session = BrowserSession(
        url, profile: id,
        hosts: mode != "browse" ? Set(args.last!.split(separator: ",").map(String.init)) : [host],
        readingPost: mode == "post",
        destination: mode == "capture" ? URL(fileURLWithPath: args[3]) : nil)
      return
    }
    let defaults =
      ProcessInfo.processInfo.environment["FETCHY_DATA_DIR"].flatMap { path in
        let key = SHA256.hash(data: Data(path.utf8)).prefix(16).map { String(format: "%02x", $0) }
          .joined()
        return UserDefaults(suiteName: "app.fetchy.desktop." + key)
      } ?? .standard
    let host = NSHostingView(rootView: Workspace().defaultAppStorage(defaults))
    let panel = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 760, height: 500),
      styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false
    )
    panel.contentView = host
    panel.title = "Fetchy"
    panel.isReleasedWhenClosed = false
    window = panel
    panel.center()
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
MainActor.assumeIsolated {
  let app = NSApplication.shared
  let hidden = ["logout", "capture", "post"].contains(CommandLine.arguments.dropFirst().first ?? "")
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
