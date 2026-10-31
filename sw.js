// Offline support. Pages and data are always fetched from the network first so
// scores are never stale; the saved copy is only used when there is no signal.
var VERSION = "v1";
var CACHE = "league-" + VERSION;
self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(["./", "manifest.json"]).catch(function () {}); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;           // fonts, Firebase, CDNs: leave alone
  var key = url.origin + url.pathname;                  // ignore ?v=... cache-busters
  var fresh = req.mode === "navigate" || /\.(json|html)$/.test(url.pathname) || url.pathname.slice(-1) === "/";
  if (fresh) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
      return res;
    }).catch(function () { return caches.match(key).then(function (hit) { return hit || caches.match("./"); }); }));
    return;
  }
  e.respondWith(caches.match(key).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
      return res;
    }).catch(function () { return hit; });
    return hit || net;
  }));
});
