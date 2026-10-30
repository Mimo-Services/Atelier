// Service worker : garde l'application sur le téléphone pour qu'elle s'ouvre sans réseau.
// Changer VERSION à chaque mise à jour des fichiers de l'application.
var VERSION = "duocore-2026-11-05-HV";
var FICHIERS = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest",
  "icone-192.png", "icone-512.png", "icone-maskable-512.png", "apple-touch-icon.png"];
var JSQR = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";

// Installation : fichiers téléchargés un par un (progression envoyée à l'app : barre de mise à jour).
function annoncer(m) { return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cl) { cl.forEach(function (c) { c.postMessage(m); }); }); }
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    var fait = 0, total = FICHIERS.length;
    annoncer({ type: "majProgres", etape: "telechargement", fait: 0, total: total, version: VERSION });
    // cache: "reload" : toujours les fichiers du serveur (pas ceux du cache du navigateur), sinon une mise à jour pourrait garder l'ancien app.js.
    return FICHIERS.reduce(function (p, f) {
      return p.then(function () {
        return fetch(new Request(f, { cache: "reload" })).then(function (r) {
          if (!r.ok) throw new Error(f + " : HTTP " + r.status);
          return c.put(f, r);
        }).then(function () { fait++; return annoncer({ type: "majProgres", etape: "telechargement", fait: fait, total: total, version: VERSION }); });
      });
    }, Promise.resolve()).then(function () {
      // Lecteur QR de secours (téléphones sans lecteur intégré) : facultatif.
      return c.add(new Request(JSQR, { mode: "cors" })).catch(function () {});
    });
  }).then(function () { annoncer({ type: "majProgres", etape: "installation", version: VERSION }); return self.skipWaiting(); }));
});

self.addEventListener("message", function (e) { if (e.data && e.data.type === "activer") self.skipWaiting(); });

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (cles) {
    return Promise.all(cles.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Historique (🔔 dans l'app) : gardé 30 jours dans la base de l'appareil (même base que l'app, clé « notifs »).
function garderNotif(titre, d) {
  return new Promise(function (ok) {
    try {
      var r = indexedDB.open("atelier", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onerror = function () { ok(); };
      r.onsuccess = function () {
        var db = r.result, t = db.transaction("kv", "readwrite"), st = t.objectStore("kv"), g = st.get("notifs");
        g.onsuccess = function () {
          var L = (g.result || []).filter(function (x) { return x.recu > Date.now() - 30 * 86400000; }).slice(0, 199);
          L.unshift({ titre: titre, texte: d.texte || "", vue: d.vue || "", id: d.id || "", recu: Date.now(), lu: false });
          st.put(L, "notifs");
        };
        t.oncomplete = function () { ok(); }; t.onerror = function () { ok(); };
      };
    } catch (x) { ok(); }
  });
}

// Notifications (Firebase Cloud Messaging, messages « data ») : affichées ici, que l'app soit ouverte ou non.
self.addEventListener("push", function (e) {
  var d = {};
  try { var j = e.data ? e.data.json() : {}; d = j.data || j || {}; } catch (x) { d = { texte: e.data ? e.data.text() : "" }; }
  var titre = d.titre || "DuoCore";
  e.waitUntil(Promise.all([
    garderNotif(titre, d),
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
