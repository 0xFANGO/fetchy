import Foundation
import JavaScriptCore

let suite = "app.fetchy.test.sign-in." + UUID().uuidString
let store = UserDefaults(suiteName: suite)!
defer { store.removePersistentDomain(forName: suite) }
let login = XiaohongshuLogin(defaults: store)
let profile = UUID()
func cookie(_ host: String, _ value: String, expires: Date = .distantFuture) -> HTTPCookie {
  HTTPCookie(properties: [
    .name: "web_session", .value: value, .path: "/",
    .domain: host, .expires: expires, .secure: "TRUE",
  ])!
}
func state(_ flags: String, live: String = "undefined") -> String {
  let js = JSContext()!
  js.evaluateScript("var window = {__INITIAL_STATE__: {user: " + flags + "}}")
  js.evaluateScript(
    """
    const pinia = {state:{value:{user:\(live)}}};
    const document = {querySelector() { return {__vue_app__:{config:{globalProperties:{$pinia:pinia}}}} }};
    """)
  return js.evaluateScript(XiaohongshuLogin.pageState).toString()
}
let guest = state("{loggedIn: false, userInfo: {guest: true}}")
let member = state("{loggedIn: true, userInfo: {guest: false}}")
let unknown = state("{}")
precondition(guest == "guest" && member == "member" && unknown == "unknown")
precondition(state("{loggedIn: true, userInfo:{guest:true}}") == "guest")
precondition(state("{loggedIn:true,userInfo:{}}") == "unknown")
precondition(
  state("{loggedIn:true,userInfo:{guest:false}}", live: "{loggedIn:false,userInfo:{guest:true}}")
    == "guest")
precondition(
  state("{loggedIn:false,userInfo:{guest:true}}", live: "{loggedIn:true,userInfo:{guest:false}}")
    == "member")
precondition(
  state("{loggedIn:{__v_isRef:true,value:false},userInfo:{__v_isRef:true,value:{guest:true}}}")
    == "guest")
precondition(
  state("{loggedIn:{__v_isRef:true,value:true},userInfo:{__v_isRef:true,value:{userId:'fixture'}}}")
    == "member")
let host = "www.rednote.com"
let domestic = cookie(".xiaohongshu.com", "domestic-fixture")
let current = cookie(".rednote.com", "regional-fixture")
let rotated = cookie(".rednote.com", "rotated-fixture")
precondition(XiaohongshuLogin.pageHost(URL(string: "https://www.rednote.com/example")) == host)
for url in [
  "https://www.rednote.com.evil.test/", "https://rednote.com:8080/", "http://rednote.com/",
] {
  precondition(XiaohongshuLogin.pageHost(URL(string: url)) == nil)
}
login.observe(guest, cookies: [current], host: host, profile: profile)
precondition(!login.mayUse(current, profile: profile))
login.observe(member, cookies: [current], host: "rednote.com.other.test", profile: profile)
precondition(!login.mayUse(current, profile: profile))
login.observe(member, cookies: [domestic, current], host: host, profile: profile)
login.observe(unknown, cookies: [], host: host, profile: profile)
precondition(login.mayUse(current, profile: profile))
precondition(!login.mayUse(domestic, profile: profile))
precondition(!login.mayUse(current, profile: UUID()))
precondition(!login.mayUse(rotated, profile: profile))
precondition(
  !login.mayUse(cookie(".rednote.com", "regional-fixture", expires: .distantPast), profile: profile)
)
let stored = store.persistentDomain(forName: suite) ?? [:]
precondition(!stored.isEmpty && !String(describing: stored).contains("regional-fixture"))
login.observe(member, cookies: [domestic], host: "www.xiaohongshu.com", profile: profile)
login.observe(guest, cookies: [current], host: host, profile: profile)
precondition(!login.mayUse(current, profile: profile))
precondition(login.mayUse(domestic, profile: profile))
login.forget(profile)
precondition(!login.mayUse(domestic, profile: profile))
