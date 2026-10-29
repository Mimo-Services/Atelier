// Service worker : garde l'application sur le téléphone pour qu'elle s'ouvre sans réseau.
// Changer VERSION à chaque mise à jour des fichiers de l'application.
var VERSION = "duocore-2026-11-03-GW";
var FICHIERS = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest",
  "icone-192.png", "icone-512.png", "icone-maskable-512.png", "apple-touch-icon.png"];
var JSQR = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return c.addAll(FICHIERS).then(function () {
      // Lecteur QR de secours (téléphones sans lecteur intégré) : facultatif.
      return c.add(new Request(JSQR, { mode: "cors" })).catch(function () {});
    });
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (cles) {
    return Promise.all(cles.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Notifications (Firebase Cloud Messaging, messages « data ») : affichées ici, que l'app soit ouverte ou non.
self.addEventListener("push", function (e) {
  var d = {};
  try { var j = e.data ? e.data.json() : {}; d = j.data || j || {}; } catch (x) { d = { texte: e.data ? e.data.text() : "" }; }
  var titre = d.titre || "DuoCore";
  e.waitUntil(Promise.all([
    self.registration.showNotification(titre, { body: d.texte || "", icon: "icone-192.png", badge: "icone-192.png", tag: d.tag || undefined, renotify: !!d.tag, data: d }),
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cl) { cl.forEach(function (c) { c.postMessage({ type: "notif", data: d }); }); })
  ]));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var d = e.notification.data || {}, cible = "./?notif=" + encodeURIComponent(d.vue || "accueil") + (d.id ? "&id=" + encodeURIComponent(d.id) : "");
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cl) {
    for (var i = 0; i < cl.length; i++) { if ("focus" in cl[i]) { cl[i].postMessage({ type: "ouvrir", data: d }); return cl[i].focus(); } }
    return self.clients.openWindow(cible);
  }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  // Serveur Apps Script : jamais en cache (toujours les données du moment).
  if (url.hostname.indexOf("google") !== -1) return;
  if (url.origin !== location.origin && req.url !== JSQR) return;
  // Ouverture de l'application (avec ou sans ?bdc=…&cle=…) : la page en cache.
  if (req.mode === "navigate") {
    // Cache d'abord (réseau lent à Conakry), mise à jour en arrière-plan.
    e.respondWith(caches.match("index.html").then(function (enCache) {
      var reseau = fetch(req).then(function (r) {
        if (r && r.ok) { var copie = r.clone(); caches.open(VERSION).then(function (c) { c.put("index.html", copie); }); }
        return r;
      }).catch(function () { return enCache; });
      return enCache || reseau;
    }));
    return;
  }
  // Fichiers de l'application : cache d'abord, mise à jour en arrière-plan.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (enCache) {
    var reseau = fetch(req).then(function (r) {
      if (r && (r.ok || r.type === "opaque")) { var copie = r.clone(); caches.open(VERSION).then(function (c) { c.put(req, copie); }); }
      return r;
    }).catch(function () { return enCache; });
    return enCache || reseau;
  }));
});
