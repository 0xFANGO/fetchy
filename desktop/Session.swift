import AppKit
import WebKit

// Each explicit origin has its own WebKit store. Authentication never passes through Node.
@MainActor
final class BrowserSession: NSObject, WKNavigationDelegate, WKDownloadDelegate, NSWindowDelegate {
  let input: URL
  let hosts: Set<String>
  let destination: URL?
  let view: WKWebView
  var window: NSWindow?
  var download: WKDownload?
  var title = ""
  var tries = 0
  var finished = false
  var handingOffNavigation = false
  var observation: NSKeyValueObservation?
  let limit: Int64 = 2 * 1024 * 1024 * 1024

  init(_ url: URL, profile: UUID, hosts: Set<String>, destination: URL?) {
    input = url
    self.hosts = hosts
    self.destination = destination
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: profile)
    configuration.mediaTypesRequiringUserActionForPlayback = []
    view = WKWebView(
      frame: NSRect(x: 0, y: 0, width: 1000, height: 720), configuration: configuration)
    super.init()
    view.navigationDelegate = self
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(endSiteSession),
      name: Notification.Name("app.fetchy.desktop.logout." + profile.uuidString), object: nil)
    // Keep even a non-visible capture view attached to a window for WebKit media loading.
    let window = NSWindow(
      contentRect: view.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    window.delegate = self
    self.window = window
    if destination == nil {
      window.title = "Fetchy Browser · " + (url.host ?? "")
      window.center()
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
    view.load(URLRequest(url: url))
  }

  static func respond(_ value: [String: Any], _ code: Int32 = 0) -> Never {
    if let json = try? JSONSerialization.data(withJSONObject: value) {
      FileHandle.standardOutput.write(json)
    }
    exit(code)
  }

  func fail(_ code: String) {
    guard !finished, destination != nil else { return }
    finished = true
    Self.respond(["ok": false, "error": code], 1)
  }

  @objc func endSiteSession() {
    if destination != nil { fail("auth_required") } else { NSApp.terminate(nil) }
  }

  func sameSite(_ url: URL?) -> Bool {
    guard let url else { return false }
    let port: (URL) -> Int? = { $0.port ?? ($0.scheme == "https" ? 443 : 80) }
    return url.scheme == input.scheme && (url.host.map { hosts.contains($0.lowercased()) } ?? false)
      && port(url) == port(input) && url.password == nil && url.user == nil
  }

  func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url,
      ["http", "https", "about", "blob"].contains(url.scheme ?? "")
    else {
      decisionHandler(.cancel)
      return
    }
    if url.scheme == "http" && !["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? "")
    {
      decisionHandler(.cancel)
      fail("unavailable")
      return
    }
    if destination != nil && action.targetFrame?.isMainFrame == true && !sameSite(url) {
      decisionHandler(.cancel)
      fail("auth_required")
      return
    }
    // Login providers may open a new window. Keep the user's sign-in within this profile.
    if destination == nil && action.targetFrame == nil
      && ["http", "https"].contains(url.scheme ?? "")
    {
      decisionHandler(.cancel)
      webView.load(action.request)
      return
    }
    decisionHandler(.allow)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    guard destination != nil, response.isForMainFrame else {
      decisionHandler(.allow)
      return
    }
    let code = (response.response as? HTTPURLResponse)?.statusCode ?? 200
    if !sameSite(response.response.url) || code == 401 || code == 403 {
      decisionHandler(.cancel)
      fail("auth_required")
      return
    }
    if code >= 400 {
      decisionHandler(.cancel)
      fail("unavailable")
      return
    }
    let mime = response.response.mimeType?.lowercased() ?? ""
    if mime == "video/mp4" || mime == "video/webm" || mime == "application/octet-stream" {
      handingOffNavigation = true
      decisionHandler(.download)
    } else {
      decisionHandler(.allow)
    }
  }

  func webView(
    _ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload
  ) { attach(download) }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if destination == nil {
      window?.title = "Fetchy Browser · " + (webView.url?.host ?? "")
    } else {
      inspectPage()
    }
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    if !handingOffNavigation && (error as NSError).code != NSURLErrorCancelled {
      fail("network_error")
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if !handingOffNavigation && (error as NSError).code != NSURLErrorCancelled && download == nil {
      fail("network_error")
    }
  }

  func inspectPage() {
    guard !finished, download == nil, destination != nil else { return }
    let script = """
      (() => {
        const password = document.querySelector('input[type=password]');
        const login = Boolean(password && password.getClientRects().length) || /\\/(login|signin|sign_in)(\\/|$)/i.test(location.pathname);
        const players = [...document.querySelectorAll('video')];
        if(players.length === 1 && players[0].paused) { players[0].muted=true; players[0].play().catch(()=>{}); }
        const preferred = document.querySelector('meta[property="og:video:secure_url"],meta[property="og:video:url"],meta[property="og:video"]')?.content;
        const sources = [...new Set(players.map(v=>v.currentSrc || v.src || v.querySelector('source')?.src).filter(Boolean))];
        const network = [...new Set(performance.getEntriesByType('resource').filter(entry => {
          try {
            const u = new URL(entry.name);
            return u.origin === location.origin && /[.](?:mp4|webm)$/i.test(u.pathname)
              && ['video','fetch','xmlhttprequest'].includes(entry.initiatorType);
          } catch { return false; }
        }).map(entry => entry.name))];
        let raw = sources.length === 1 ? sources[0] : sources.length === 0 ? preferred : null;
        if ((!raw || raw.startsWith('blob:')) && players.length === 1 && network.length === 1) raw = network[0];
        let media = ''; try { if(raw)media=new URL(raw,location.href).href; }catch{}
        return {login,media,title:document.title.slice(0,240)};
      })()
      """
    view.evaluateJavaScript(script, in: nil, in: .defaultClient) { [weak self] result in
      guard let self, !self.finished, self.download == nil else { return }
      if case .success(let value) = result, let info = value as? [String: Any] {
        if info["login"] as? Bool == true {
          self.fail("auth_required")
          return
        }
        if let raw = info["media"] as? String, let media = URL(string: raw), self.sameSite(media) {
          self.title = info["title"] as? String ?? ""
          self.view.startDownload(using: URLRequest(url: media)) { self.attach($0) }
          return
        }
      }
      self.tries += 1
      if self.tries >= 20 {
        self.fail("no_formats")
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self.inspectPage() }
    }
  }

  func attach(_ transfer: WKDownload) {
    guard download == nil else { return }
    download = transfer
    transfer.delegate = self
    observation = transfer.progress.observe(\.completedUnitCount) { [weak self] progress, _ in
      let bytes = progress.completedUnitCount
      DispatchQueue.main.async { if let self, bytes > self.limit { self.fail("size_limit") } }
    }
  }

  func download(
    _ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void
  ) {
    if sameSite(request.url) {
      decisionHandler(.allow)
    } else {
      decisionHandler(.cancel)
      fail("no_formats")
    }
  }

  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void
  ) {
    guard sameSite(response.url), let destination else {
      completionHandler(nil)
      fail("no_formats")
      return
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 200
    if status == 401 || status == 403 {
      completionHandler(nil)
      fail("auth_required")
      return
    }
    if !(200..<300).contains(status) {
      completionHandler(nil)
      fail("unavailable")
      return
    }
    if response.expectedContentLength > limit {
      completionHandler(nil)
      fail("size_limit")
      return
    }
    if response.mimeType == "text/html" {
      completionHandler(nil)
      fail("auth_required")
      return
    }
    if title.isEmpty { title = (suggestedFilename as NSString).deletingPathExtension }
    completionHandler(destination)
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let path = destination?.path,
      let attrs = try? FileManager.default.attributesOfItem(atPath: path),
      let size = attrs[.size] as? NSNumber, size.int64Value > 0
    else {
      fail("output_invalid")
      return
    }
    if size.int64Value > limit {
      fail("size_limit")
      return
    }
    finished = true
    Self.respond(["ok": true, "title": String(title.prefix(240))])
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    fail("network_error")
  }
}
