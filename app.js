/* Suivi Atelier — application hors ligne.
 * Le téléphone garde les lots en cours et la page de déclaration. Une déclaration faite
 * sans réseau est mise en file d'attente et envoyée dès que la connexion revient.
 * Le serveur (Apps Script) refait tous les contrôles : un refus arrive dans « À corriger ». */
(function () {
  "use strict";

  var VERSION_APP = "2026-10-23 DY";
  var DELAI_ENVOI = 30000, DELAI_DONNEES = 120000, RAFRAICHIR_APRES = 15 * 60000;

  /* ---------- Stockage (IndexedDB, clé → valeur) ---------- */
  var dbP = null;
  function db() {
    if (!dbP) dbP = new Promise(function (ok, ko) {
      var r = indexedDB.open("atelier", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ko(r.error); };
    });
    return dbP;
  }
  function lire(k) {
    return db().then(function (d) {
      return new Promise(function (ok, ko) {
        var q = d.transaction("kv").objectStore("kv").get(k);
        q.onsuccess = function () { ok(q.result); }; q.onerror = function () { ko(q.error); };
      });
    });
  }
  function ecrire(k, v) {
    return db().then(function (d) {
      return new Promise(function (ok, ko) {
        var t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k);
        t.oncomplete = function () { ok(); }; t.onerror = function () { ko(t.error); };
      });
    });
  }

  /* ---------- État en mémoire ---------- */
  var S = {
    url: "", donnees: null, gabarit: "", gv: "",
    file: [],       // déclarations en attente d'envoi (dans l'ordre)
    envoyes: [],    // envoyées et acceptées, pas encore dans les données téléchargées
    aCorriger: [],  // refusées par le serveur
    recents: [], derniereSync: 0, lotOuvert: null
  };
  function sauver() {
    return Promise.all([ecrire("file", S.file), ecrire("envoyes", S.envoyes), ecrire("aCorriger", S.aCorriger), ecrire("recents", S.recents)]);
  }

  /* ---------- Outils ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return (v === null || v === undefined ? "" : String(v)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function dateCourte(t) {
    var d = new Date(t), z = function (n) { return (n < 10 ? "0" : "") + n; };
    return z(d.getDate()) + "/" + z(d.getMonth() + 1) + " " + z(d.getHours()) + ":" + z(d.getMinutes());
  }
  function C() { return (S.donnees && S.donnees.constantes) || {}; }
  function dans(liste, x) { return (liste || []).indexOf(x) !== -1; }
  function attendre(p, ms) {
    return Promise.race([p, new Promise(function (ok, ko) { setTimeout(function () { ko(new Error("délai")); }, ms); })]);
  }
  function requete(url, options, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    if (ctl) options.signal = ctl.signal;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return attendre(fetch(url, options), ms + 1000).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function (txt) {
      try { return JSON.parse(txt); }
      catch (e) { throw new Error("Réponse illisible du serveur (déploiement à jour ? accès « Tout le monde » ?)"); }
    }, function (e) { clearTimeout(t); throw e; });
  }

  /* ---------- Règles de production (copie de celles du script, pour l'affichage) ---------- */
  function vierge() { return { ctp: false, calage: false, bar: false, debut: false, fin: false, cumul: 0 }; }
  function passagesPrevus(detail, nom) {
    for (var i = 0; i < (detail || []).length; i++) if (detail[i].nom === nom) return detail[i].passages || 1;
    return 1;
  }
  function diviseurEtape(detail, nom) {
    var idxA = -1, n = 1;
    for (var i = 0; i < (detail || []).length; i++) {
      if (detail[i].nom === "Assemblage" && detail[i].parametre > 1) { idxA = i; n = detail[i].parametre; }
      if (detail[i].nom === nom) return (idxA !== -1 && i > idxA) ? n : 1;
    }
    return 1;
  }
  function quantitePlanifieeEtape(lot, nom) {
    var q = parseFloat(lot && lot.quantite) || 0, d = diviseurEtape(lot && lot.etapesDetail, nom);
    return d > 1 ? Math.round(q / d) : q;
  }
  function convertir(lot, q, de, vers) {
    var a = diviseurEtape(lot.etapesDetail, de), b = diviseurEtape(lot.etapesDetail, vers);
    return a === b ? q : Math.floor(q * a / b);
  }
  function passageCourant(etats, poste) {
    var e = etats[poste];
    if (!e || !e.passages.length) return vierge();
    var d = e.passages[e.passages.length - 1];
    return d.fin ? vierge() : d;
  }
  function numeroPassageCourant(etats, poste) {
    var e = etats[poste]; if (!e) return 1;
    var n = 0; e.passages.forEach(function (p) { if (p.fin) n++; });
    return n + 1;
  }
  function etapeSoldee(etats, poste, prevus) {
    var e = etats[poste]; if (!e) return false;
    var n = 0; e.passages.forEach(function (p) { if (p.fin) n++; });
    return n >= (prevus || 1);
  }
  function cumulEtape(etats, poste) {
    var e = etats[poste]; if (!e) return 0;
    var t = 0; e.passages.forEach(function (p) { t += p.cumul; });
    return t;
  }
  function productionEtape(etats, poste, prevus) {
    var e = etats[poste]; if (!e) return 0;
    if ((prevus || 1) > 1) { var p = e.passages[prevus - 1]; return p ? p.cumul : 0; }
    return cumulEtape(etats, poste);
  }
  function appliquerEvenement(etat, evt, quantite, noPassage) {
    var idx;
    if (noPassage > 0) { while (etat.passages.length < noPassage) etat.passages.push(vierge()); idx = noPassage - 1; }
    else {
      idx = etat.passages.length - 1;
      if (idx < 0 || etat.passages[idx].fin) { etat.passages.push(vierge()); idx = etat.passages.length - 1; }
    }
    var p = etat.passages[idx];
    if (evt === "Plaque CTP") p.ctp = true;
    else if (evt === "Calage") p.calage = true;
    else if (evt === "BAR") p.bar = true;
    else if (evt === "Début") p.debut = true;
    else if (evt === "Fin") p.fin = true;
    if (dans(C().comptabilises || ["Pointage", "Fin", "Sortie stock"], evt)) p.cumul += parseFloat(quantite) || 0;
    return p;
  }
  function lotEstTermine(etapes, etats) {
    if (!etapes || !etapes.length) return false;
    var d = etats[etapes[etapes.length - 1]];
    return !!(d && d.passages.some(function (p) { return p.fin; }));
  }
  function cleParent(cle) { cle = String(cle || "").trim(); return cle.length <= 1 ? "" : cle.substring(0, cle.length - 1); }
  function trouverLot(bdc, cle) {
    var l = (S.donnees && S.donnees.lots) || [];
    bdc = String(bdc || "").trim(); cle = String(cle || "").trim();
    for (var i = 0; i < l.length; i++) if (l[i].cle === cle && (!bdc || l[i].bdc === bdc)) return l[i];
    return null;
  }

  /* État d'un lot = état téléchargé + déclarations envoyées depuis + déclarations en attente. */
  function etatsLot(lot, profondeur) {
    var etats = JSON.parse(JSON.stringify(lot.etats || {}));
    S.envoyes.concat(S.file).forEach(function (it) {
      var o = it.o;
      if (o.bdc === lot.bdc && o.cle === lot.cle) appliquerLocal(lot, etats, o, profondeur || 0);
    });
    return etats;
  }
  function dispoParent(lot, profondeur) {
    var p = trouverLot(lot.bdc, cleParent(lot.cle));
    if (!p || !p.etapes.length || (profondeur || 0) > 6) return null;
    var der = p.etapes[p.etapes.length - 1], qP = quantitePlanifieeEtape(p, der), q = parseFloat(lot.quantite) || 0;
    var prod = productionEtape(etatsLot(p, (profondeur || 0) + 1), der, passagesPrevus(p.etapesDetail, der));
    return qP > 0 ? Math.round(prod * q / qP) : prod;
  }
  /* Effet attendu d'une déclaration (pour que l'étape suivante soit possible sans réseau). */
  function appliquerLocal(lot, etats, o, profondeur) {
    var poste = o.poste, evt = o.typeEvenement, q = parseFloat(String(o.quantite || "").replace(",", ".")) || 0;
    if (!poste) return;
    var prevus = passagesPrevus(lot.etapesDetail, poste);
    var np = prevus > 1 ? (parseInt(o.passage, 10) || numeroPassageCourant(etats, poste)) : 0;
    if (!etats[poste]) etats[poste] = { passages: [] };
    var e = etats[poste];
    if (dans(C().qteSeule, poste)) { appliquerEvenement(e, "Sortie stock", q, 0); return; }
    if (dans(C().validation, poste)) { appliquerEvenement(e, "Fin", 0, 0); return; }
    var qPlan = quantitePlanifieeEtape(lot, poste);
    if (evt === "Fin") {
      var i = lot.etapes.indexOf(poste), dispo;
      if (np > 1) dispo = (e.passages[np - 2] || vierge()).cumul;
      else if (i > 0) dispo = convertir(lot, productionEtape(etats, lot.etapes[i - 1], passagesPrevus(lot.etapesDetail, lot.etapes[i - 1])), lot.etapes[i - 1], poste);
      else { var dp = dispoParent(lot, profondeur); dispo = dp === null ? qPlan : dp; }
      var cour = np > 0 ? (e.passages[np - 1] || vierge()) : passageCourant(etats, poste);
      q = Math.max(0, Math.min(qPlan, dispo) - cour.cumul);
    }
    var p = appliquerEvenement(e, evt, q, np);
    if (evt === C().evtBar || evt === "BAR") appliquerEvenement(e, "Début", 0, np);
    if (evt === "Pointage" && qPlan > 0 && !p.fin && p.cumul >= qPlan) p.fin = true;
  }

  /* Contexte de la page (même contenu que celui calculé par doGet). */
  function contexteLot(lot) {
    var etats = etatsLot(lot), c = C(), resume = {}, div = {}, stock = {};
    lot.etapes.forEach(function (nom) {
      var prevus = passagesPrevus(lot.etapesDetail, nom), cour = passageCourant(etats, nom);
      resume[nom] = {
        ctp: cour.ctp, calage: cour.calage, bar: cour.bar, debut: cour.debut, fin: cour.fin, cumul: cour.cumul,
        passage: numeroPassageCourant(etats, nom), prevus: prevus,
        soldee: etapeSoldee(etats, nom, prevus), produit: productionEtape(etats, nom, prevus),
        passagesEtat: (etats[nom] ? etats[nom].passages : []).map(function (p) {
          return { ctp: p.ctp, calage: p.calage, bar: p.bar, debut: p.debut, fin: p.fin, cumul: p.cumul };
        })
      };
      div[nom] = diviseurEtape(lot.etapesDetail, nom);
      if (S.donnees.stock && S.donnees.stock[nom]) stock[nom] = S.donnees.stock[nom];
    });
    var q = parseFloat(lot.quantite) || 0;
    return {
      dispoParent: dispoParent(lot), etapes: lot.etapes, etats: resume, globale: q, globaleLot: q, div: div,
      qteSeule: c.qteSeule, validation: c.validation, passages: c.passages, sansCtp: c.sansCtp,
      multiOp: c.multiOp, unOp: c.unOp, evtBar: c.evtBar, sortieLibre: c.sortieLibre, stock: stock
    };
  }
  /* Avertissements au scan (lot terminé, lot précédent pas commencé). */
  function alerteLot(lot) {
    var etats = etatsLot(lot);
    if (lotEstTermine(lot.etapes, etats)) return { titre: "Lot déjà terminé", message: C().msgTermine,
      details: [["Clé Lot", lot.cle], ["Désignation", lot.designation], ["Dernière étape", lot.etapes[lot.etapes.length - 1]]] };
    var p = trouverLot(lot.bdc, cleParent(lot.cle));
    if (p) {
      var ep = etatsLot(p), produit = false;
      for (var k in ep) if (cumulEtape(ep, k) > 0) { produit = true; break; }
      if (!lotEstTermine(p.etapes, ep) && !produit) return { titre: "Lot précédent non commencé", message: C().msgPrecedent,
        details: [["Clé Lot scannée", lot.cle], ["Lot précédent", p.cle], ["Désignation du précédent", p.designation]] };
    }
    return null;
  }

  /* ---------- Écrans ---------- */
  function montrer(vue) {
    ["vueAccueil", "vueListe"].forEach(function (v) { $(v).style.display = v === vue ? "block" : "none"; });
    $("vueScan").style.display = vue === "vueScan" ? "block" : "none";
    $("vueLot").style.display = vue === "vueLot" ? "block" : "none";
    $("btnRetour").style.display = vue === "vueAccueil" ? "none" : "";
    if (vue !== "vueScan") arreterScan();
    if (vue !== "vueLot") { $("cadre").srcdoc = ""; S.lotOuvert = null; }
    if (vue === "vueAccueil") { $("titre").textContent = "Suivi Atelier"; majAccueil(); }
    window.scrollTo(0, 0);
  }

  function majEtat() {
    var el = $("etatReseau"), n = S.file.length;
    if (n) { el.className = "pastille envoi"; el.textContent = "⏳ " + n + " en attente"; }
    else if (navigator.onLine) { el.className = "pastille enligne"; el.textContent = "En ligne"; }
    else { el.className = "pastille horsligne"; el.textContent = "Hors ligne"; }
  }

  function majAccueil() {
    majEtat();
    var h = "";
    if (S.aCorriger.length) h += "<div class='carte ko'><h3>⛔ " + S.aCorriger.length + " déclaration(s) refusée(s) — à corriger</h3>" +
      "<button class='bouton alerte' data-liste='corriger'>Voir</button></div>";
    if (S.file.length) h += "<div class='carte att'><h3>⏳ " + S.file.length + " déclaration(s) en attente d'envoi</h3>" +
      "<div class='info'>Elles partiront seules dès que le réseau revient. Ne les refaites pas.</div>" +
      "<button class='bouton second' data-liste='attente'>Voir</button></div>";
    $("blocAlertes").innerHTML = h;
    Array.prototype.forEach.call($("blocAlertes").querySelectorAll("[data-liste]"), function (b) {
      b.onclick = function () { afficherListe(b.getAttribute("data-liste")); };
    });

    var d = S.donnees;
    $("etatDonnees").innerHTML = d
      ? "Données du <b>" + dateCourte(d.genere) + "</b> · " + d.lots.length + " lots · serveur " + esc(d.version) +
        (S.derniereSync ? "<br>Dernière connexion réussie : " + dateCourte(S.derniereSync) : "")
      : (S.url ? "Aucune donnée sur ce téléphone : connectez-le au réseau puis appuyez sur 🔄."
               : "Adresse du serveur inconnue : scannez une fiche (avec réseau) ou renseignez-la dans Réglages.");

    // Choix manuel BDC / lot
    var sb = $("choixBdc"), bdcs = [], vu = {};
    ((d && d.lots) || []).forEach(function (l) { if (!vu[l.bdc]) { vu[l.bdc] = 1; bdcs.push(l.bdc); } });
    var garde = sb.value;
    sb.innerHTML = "<option value=''>— BDC —</option>" + bdcs.map(function (b) { return "<option>" + esc(b) + "</option>"; }).join("");
    if (vu[garde]) sb.value = garde;
    majChoixCle();

    var rc = S.recents.filter(function (r) { return trouverLot(r.bdc, r.cle); }).slice(0, 6);
    $("carteRecents").style.display = rc.length ? "" : "none";
    $("recents").innerHTML = rc.map(function (r, i) {
      var l = trouverLot(r.bdc, r.cle);
      return "<button class='bouton second' style='text-align:left' data-i='" + i + "'>" + esc(r.cle) + " · " + esc(r.bdc) +
        "<br><small>" + esc(l.designation) + "</small></button>";
    }).join("");
    Array.prototype.forEach.call($("recents").querySelectorAll("button"), function (b) {
      b.onclick = function () { var r = rc[+b.getAttribute("data-i")]; ouvrirLot(r.bdc, r.cle); };
    });
    $("urlServeur").value = S.url || "";
    $("infoVersion").textContent = "Application " + VERSION_APP + (d ? " · serveur " + d.version : "");
  }
  function majChoixCle() {
    var b = $("choixBdc").value, sc = $("choixCle");
    var l = ((S.donnees && S.donnees.lots) || []).filter(function (x) { return x.bdc === b; });
    l.sort(function (x, y) { return x.cle.localeCompare(y.cle); });
    sc.innerHTML = l.map(function (x) {
      return "<option value='" + esc(x.cle) + "'>" + esc(x.cle) + " — " + esc(String(x.designation).substring(0, 40)) + "</option>";
    }).join("") || "<option value=''>—</option>";
  }

  function libEvt(o) {
    return dans(C().qteSeule, o.poste) || dans(C().validation, o.poste) ? "" : " · " + esc(o.typeEvenement || "") + (o.passage && o.passage !== "1" ? " (P" + esc(o.passage) + ")" : "");
  }
  function afficherListe(type) {
    var v = $("vueListe"), h;
    $("titre").textContent = type === "corriger" ? "À corriger" : "En attente";
    if (type === "corriger") {
      h = "<p class='info'>Le serveur a refusé ces déclarations (faites hors ligne) : rien n'a été enregistré. " +
          "Vérifiez avec le chef d'atelier, refaites la bonne déclaration si besoin, puis effacez-la de la liste.</p>";
      h += S.aCorriger.map(function (x, i) {
        var o = x.o, r = x.r || {};
        return "<div class='carte ko'><h3>⛔ " + esc(r.titre || "Refusé") + "</h3>" +
          "<div>" + esc(o.cle) + " · " + esc(o.bdc) + "<br>" + esc(o.poste) + libEvt(o) +
          (o.quantite ? " · " + esc(o.quantite) : "") + "<br>" + esc(o.operateur) + " · saisi le " + dateCourte(x.horodatage) + "</div>" +
          "<p style='white-space:pre-line'>" + esc(r.message || "") + "</p>" +
          (r.details && r.details.length ? "<table>" + r.details.map(function (d) {
            return "<tr><td>" + esc(d[0]) + "</td><td class='v'>" + esc(d[1]) + "</td></tr>"; }).join("") + "</table>" : "") +
          "<div class='ligne'><button class='bouton second' data-ouvrir='" + i + "'>Ouvrir le lot</button>" +
          "<button class='bouton' data-effacer='" + i + "'>Vu, effacer</button></div></div>";
      }).join("") || "<p>Rien à corriger.</p>";
    } else {
      h = "<p class='info'>Ces déclarations sont gardées sur le téléphone et partiront dès que le réseau revient, " +
          "avec l'heure à laquelle elles ont été faites. Ne les refaites pas.</p>";
      h += S.file.map(function (x) {
        var o = x.o;
        return "<div class='carte att'>" + esc(o.cle) + " · " + esc(o.bdc) + "<br>" + esc(o.poste) + libEvt(o) +
          (o.quantite ? " · " + esc(o.quantite) : "") + "<br><small>" + esc(o.operateur) + " · " + dateCourte(x.horodatage) +
          (x.essais ? " · " + x.essais + " essai(s)" + (x.erreur ? " — " + esc(x.erreur) : "") : "") + "</small></div>";
      }).join("") || "<p>Rien en attente.</p>";
      h += "<button class='bouton' id='btnEnvoyerMaintenant'>Envoyer maintenant</button>";
    }
    v.innerHTML = h;
    montrer("vueListe");
    Array.prototype.forEach.call(v.querySelectorAll("[data-effacer]"), function (b) {
      b.onclick = function () { S.aCorriger.splice(+b.getAttribute("data-effacer"), 1); sauver(); afficherListe("corriger"); };
    });
    Array.prototype.forEach.call(v.querySelectorAll("[data-ouvrir]"), function (b) {
      b.onclick = function () { var o = S.aCorriger[+b.getAttribute("data-ouvrir")].o; ouvrirLot(o.bdc, o.cle); };
    });
    var be = $("btnEnvoyerMaintenant");
    if (be) be.onclick = function () { be.disabled = true; be.textContent = "Envoi…"; synchroniser(true).then(function () { afficherListe("attente"); }); };
  }

  function pageAlerte(a, suite) {
    var v = $("vueListe");
    $("titre").textContent = "Attention";
    v.innerHTML = "<div class='carte att'><h3>" + esc(a.titre) + "</h3><p>" + esc(a.message) + "</p></div>" +
      "<table>" + a.details.map(function (d) { return "<tr><td>" + esc(d[0]) + "</td><td class='v'>" + esc(d[1]) + "</td></tr>"; }).join("") + "</table>" +
      "<button class='bouton' id='btnForcer'>Ouvrir quand même la déclaration</button>" +
      "<button class='bouton second' id='btnAbandon'>Retour (scanner le bon QR code)</button>";
    montrer("vueListe");
    $("btnForcer").onclick = suite;
    $("btnAbandon").onclick = function () { montrer("vueAccueil"); };
  }

  function pageIntrouvable(bdc, cle) {
    var v = $("vueListe");
    $("titre").textContent = "Lot introuvable";
    v.innerHTML = "<div class='carte ko'><h3>Lot absent du téléphone</h3><p>Clé « " + esc(cle) + " » du BDC « " + esc(bdc) + " ».</p>" +
      "<p class='info'>Le lot est peut-être terminé (BDC soldé), ou la fiche est plus récente que les données du téléphone" +
      (S.donnees ? " (" + dateCourte(S.donnees.genere) + ")" : "") + ".</p></div>" +
      "<button class='bouton' id='btnResync'>🔄 Mettre à jour les données (réseau)</button>" +
      (S.url ? "<button class='bouton second' id='btnEnLigne'>Ouvrir la page en ligne</button>" : "") +
      "<button class='bouton second' id='btnAbandon'>Retour</button>";
    montrer("vueListe");
    $("btnResync").onclick = function () {
      $("btnResync").disabled = true; $("btnResync").textContent = "Mise à jour…";
      rafraichir().then(function () {
        if (trouverLot(bdc, cle)) ouvrirLot(bdc, cle);
        else { $("btnResync").disabled = false; $("btnResync").textContent = "Toujours introuvable — réessayer"; }
      }, function (e) { $("btnResync").disabled = false; $("btnResync").textContent = "Échec (" + e.message + ") — réessayer"; });
    };
    if ($("btnEnLigne")) $("btnEnLigne").onclick = function () {
      location.href = S.url + "?bdc=" + encodeURIComponent(bdc) + "&cle=" + encodeURIComponent(cle);
    };
    $("btnAbandon").onclick = function () { montrer("vueAccueil"); };
  }

  function ouvrirLot(bdc, cle, force) {
    var lot = trouverLot(bdc, cle);
    if (!lot || !S.gabarit) return pageIntrouvable(bdc, cle);
    if (!force) { var a = alerteLot(lot); if (a) return pageAlerte(a, function () { ouvrirLot(bdc, cle, true); }); }
    S.recents = [{ bdc: lot.bdc, cle: lot.cle }].concat(S.recents.filter(function (r) { return !(r.bdc === lot.bdc && r.cle === lot.cle); })).slice(0, 10);
    sauver();
    var ctx = contexteLot(lot), nAtt = S.file.filter(function (x) { return x.o.bdc === lot.bdc && x.o.cle === lot.cle; }).length;
    var bandeau = "<div style='margin-top:8px;padding:8px 10px;border-radius:6px;font-size:13px;background:" + (nAtt ? "#fff4e5" : "#f3f3f3") + "'>" +
      (nAtt ? "⏳ <b>" + nAtt + " déclaration(s) de ce lot en attente d'envoi</b> : déjà prises en compte ci-dessous, pas encore dans l'avancement.<br>" : "") +
      "Avancement : données du " + dateCourte(S.donnees.genere) + "</div>";
    var options = lot.etapes.map(function (n) { return "<option value=\"" + esc(n) + "\">" + esc(n) + "</option>"; }).join("") || "<option value=''>—</option>";
    var vals = {
      "@@BDC@@": esc(lot.bdc), "@@CLE@@": esc(lot.cle), "@@NIVEAU@@": esc(lot.niveau), "@@DESIG@@": esc(lot.designation),
      "@@QTE@@": esc(lot.quantite), "@@BANDEAU@@": bandeau, "@@RESUME@@": lot.resume || "", "@@OPTIONS@@": options,
      "\"@@CTX@@\"": JSON.stringify(ctx).replace(/<\//g, "<\\/")
    };
    var html = S.gabarit;
    Object.keys(vals).forEach(function (k) { html = html.split(k).join(vals[k]); });
    S.lotOuvert = lot;
    $("titre").textContent = lot.cle + " · " + lot.bdc;
    montrer("vueLot");
    S.lotOuvert = lot;
    $("cadre").srcdoc = html;
  }

  /* ---------- Déclarations : file d'attente et envoi ---------- */
  var resultats = {};      // jeton → réponse du serveur
  var attenteJetons = {};  // jeton → page qui attend sa réponse
  window.ATELIER = {
    declarer: function (o) {
      var it = { jeton: o.jeton || (Date.now().toString(36) + Math.random().toString(36).slice(2)), horodatage: parseFloat(o.horodatage) || Date.now(), o: o, essais: 0 };
      it.o.jeton = it.jeton; it.o.horodatage = String(it.horodatage);
      if (S.file.some(function (x) { return x.jeton === it.jeton; })) return Promise.resolve(enAttente());
      S.file.push(it);
      var reponse = new Promise(function (ok) { attenteJetons[it.jeton] = ok; });
      return sauver().then(function () {
        majEtat();
        var envoi = envoiP ? envoiP.then(lancerEnvoi) : lancerEnvoi();
        envoi.then(function () { if (attenteJetons[it.jeton]) attenteJetons[it.jeton](resultats[it.jeton] || null); });
        return attendre(reponse, DELAI_ENVOI + 5000).catch(function () { return null; }).then(function (r) {
          delete attenteJetons[it.jeton];
          synchroniser(false);
          if (!r) return enAttente();
          // Réponse reçue tout de suite : l'opérateur la voit, rien à reprendre plus tard.
          S.aCorriger = S.aCorriger.filter(function (x) { return x.jeton !== it.jeton; });
          sauver();
          return r;
        });
      });
    },
    // OK après une déclaration : la page du lot est rouverte, à jour (comme la page web).
    fermerLot: function () { var l = S.lotOuvert; if (l) ouvrirLot(l.bdc, l.cle, true); else montrer("vueAccueil"); }
  };
  function enAttente() {
    return { ok: true, enAttente: true, titre: "Gardée sur le téléphone",
      message: "Pas de réseau (ou réseau trop lent) : la déclaration est enregistrée sur ce téléphone et partira automatiquement dès que la connexion revient.\n\nNE LA REFAITES PAS." };
  }

  // Envoi de la file et téléchargement des données : chacun une seule fois à la fois.
  var envoiP = null, rafP = null;
  function lancerEnvoi() {
    if (!envoiP) envoiP = envoyerFile().then(function (n) { envoiP = null; majEtat(); return n; }, function () { envoiP = null; return 0; });
    return envoiP;
  }
  function synchroniser(forcerDonnees) {
    return lancerEnvoi().then(function (n) {
      var age = S.donnees ? Date.now() - S.donnees.recu : Infinity;
      if (S.url && (forcerDonnees || age > RAFRAICHIR_APRES || (n > 0 && age > 5 * 60000))) return rafraichir().catch(function () {});
    }).catch(function () {}).then(function () { majEtat(); if ($("vueAccueil").style.display !== "none") majAccueil(); });
  }
  function erreurPassagere(r) {
    return r && !r.ok && r.titre === "Erreur" && /lock|verrou|timeout|délai|too many|service|temporar|serveur/i.test(r.message || "");
  }
  function envoyerFile() {
    if (!S.url || !S.file.length) return Promise.resolve(0);
    var n = 0;
    function suivant() {
      if (!S.file.length) return Promise.resolve(n);
      var it = S.file[0];
      it.essais = (it.essais || 0) + 1;
      var corps = { api: "declarer" }; for (var k in it.o) corps[k] = it.o[k];
      return requete(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(corps), redirect: "follow" }, DELAI_ENVOI)
        .then(function (r) {
          S.derniereSync = Date.now(); ecrire("derniereSync", S.derniereSync);
          if (erreurPassagere(r) && it.essais < 6) { it.erreur = r.message; return sauver().then(function () { return n; }); }
          S.file.shift();
          resultats[it.jeton] = r;
          if (attenteJetons[it.jeton]) attenteJetons[it.jeton](r);
          if (r.ok) { S.envoyes.push({ jeton: it.jeton, o: it.o, recuA: Date.now() }); n++; }
          else S.aCorriger.push({ jeton: it.jeton, o: it.o, horodatage: it.horodatage, r: r });
          return sauver().then(function () { majEtat(); return suivant(); });
        }, function (e) {
          it.erreur = e.message;
          return sauver().then(function () { return n; });   // réseau absent : on réessaiera
        });
    }
    return suivant();
  }
  function rafraichir() {
    if (!S.url) return Promise.reject(new Error("adresse du serveur inconnue"));
    if (rafP) return rafP;
    var debut = Date.now();
    rafP = requete(S.url + "?api=donnees&gv=" + encodeURIComponent(S.gv || ""), { redirect: "follow" }, DELAI_DONNEES).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.message) || "réponse invalide");
      if (d.gabarit) { S.gabarit = d.gabarit; S.gv = d.gv; ecrire("gabarit", S.gabarit); ecrire("gv", S.gv); }
      delete d.gabarit;
      d.recu = Date.now();
      S.donnees = d; S.derniereSync = Date.now();
      // Ce que le serveur avait accepté avant cette demande figure maintenant dans les données.
      S.envoyes = S.envoyes.filter(function (x) { return x.recuA >= debut; });
      return Promise.all([ecrire("donnees", d), ecrire("derniereSync", S.derniereSync), sauver()]);
    }).then(function () { rafP = null; }, function (e) { rafP = null; throw e; });
    return rafP;
  }

  /* ---------- Scanner ---------- */
  var flux = null, boucle = null, detecteur = null;
  function chargerJsQR() {
    if (window.jsQR) return Promise.resolve();
    return new Promise(function (ok, ko) {
      var s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
      s.onload = ok; s.onerror = function () { ko(new Error("lecteur QR indisponible")); }; document.head.appendChild(s);
    });
  }
  function demarrerScan() {
    montrer("vueScan");
    $("titre").textContent = "Scanner";
    $("msgScan").textContent = "Placez le QR code de la fiche dans le cadre.";
    var pret = ("BarcodeDetector" in window)
      ? window.BarcodeDetector.getSupportedFormats().then(function (f) {
          if (f.indexOf("qr_code") === -1) return chargerJsQR();
          detecteur = new window.BarcodeDetector({ formats: ["qr_code"] });
        }).catch(chargerJsQR)
      : chargerJsQR();
    pret.then(function () {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    }).then(function (s) {
      flux = s; var v = $("video"); v.srcObject = s; return v.play();
    }).then(function () {
      var cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true }), occupe = false;
      boucle = setInterval(function () {
        var v = $("video"); if (occupe || !v.videoWidth) return;
        occupe = true;
        var fin = function (txt) { occupe = false; if (txt) lu(txt); };
        if (detecteur) detecteur.detect(v).then(function (c) { fin(c.length ? c[0].rawValue : ""); }, function () { fin(""); });
        else {
          var w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
          cv.width = w; cv.height = h; cx.drawImage(v, 0, 0, w, h);
          var r = window.jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
          fin(r ? r.data : "");
        }
      }, 250);
    }).catch(function (e) {
      $("msgScan").textContent = "Caméra indisponible : " + e.message + ". Utilisez « Sans QR code » sur l'accueil.";
    });
  }
  function arreterScan() {
    if (boucle) clearInterval(boucle); boucle = null;
    if (flux) flux.getTracks().forEach(function (t) { t.stop(); }); flux = null;
  }
  function lu(txt) {
    var bdc = "", cle = "";
    try {
      var u = new URL(String(txt).trim());
      bdc = u.searchParams.get("bdc") || ""; cle = u.searchParams.get("cle") || "";
      // Ancien QR (adresse de l'app web) : on en retient l'adresse du serveur si elle manque.
      if (!S.url && /script\.google(usercontent)?\.com$/.test(u.hostname) && /\/exec$/.test(u.pathname)) {
        S.url = u.origin + u.pathname; ecrire("url", S.url);
        if (!S.donnees) { arreterScan(); $("msgScan").textContent = "Premier téléchargement des données…";
          return rafraichir().then(function () { ouvrirLot(bdc, cle); }, function (e) { $("msgScan").textContent = "Échec : " + e.message; }); }
      }
    } catch (e) {}
    if (!cle) { $("msgScan").textContent = "QR code non reconnu (ce n'est pas une fiche de lot)."; return; }
    if (navigator.vibrate) navigator.vibrate(80);
    arreterScan();
    ouvrirLot(bdc, cle);
  }

  /* ---------- Démarrage ---------- */
  $("btnScanner").onclick = demarrerScan;
  $("annulerScan").onclick = function () { montrer("vueAccueil"); };
  $("btnRetour").onclick = function () { montrer("vueAccueil"); };
  $("btnSync").onclick = function () {
    var b = $("btnSync"); b.disabled = true; b.textContent = "⏳";
    synchroniser(true).then(function () {
      b.disabled = false; b.textContent = "🔄";
      if (S.lotOuvert) ouvrirLot(S.lotOuvert.bdc, S.lotOuvert.cle, true);
    });
  };
  $("choixBdc").onchange = majChoixCle;
  $("btnOuvrirManuel").onclick = function () { if ($("choixCle").value) ouvrirLot($("choixBdc").value, $("choixCle").value); };
  $("btnReglages").onclick = function () { var c = $("carteReglages"); c.style.display = c.style.display === "none" ? "" : "none"; };
  $("btnEnregistrerUrl").onclick = function () {
    var v = $("urlServeur").value.trim();
    if (v && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(v)) { alert("L'adresse doit commencer par https://script.google.com/ et finir par /exec"); return; }
    S.url = v; ecrire("url", v).then(function () { synchroniser(true); });
  };
  window.addEventListener("online", function () { majEtat(); synchroniser(false); });
  window.addEventListener("offline", majEtat);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) synchroniser(false); });
  setInterval(function () { if (S.file.length || !S.donnees || Date.now() - S.donnees.recu > RAFRAICHIR_APRES) synchroniser(false); }, 60000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  Promise.all(["url", "donnees", "gabarit", "gv", "file", "envoyes", "aCorriger", "recents", "derniereSync"].map(lire)).then(function (v) {
    S.url = v[0] || (typeof URL_SERVEUR === "string" ? URL_SERVEUR : "") || "";
    S.donnees = v[1] || null; S.gabarit = v[2] || ""; S.gv = v[3] || "";
    S.file = v[4] || []; S.envoyes = v[5] || []; S.aCorriger = v[6] || []; S.recents = v[7] || []; S.derniereSync = v[8] || 0;
    if (!S.gabarit) S.gv = "";
    var q = new URLSearchParams(location.search), bdc = q.get("bdc"), cle = q.get("cle");
    if (cle) history.replaceState(null, "", location.pathname);
    if (cle && S.donnees) { ouvrirLot(bdc || "", cle); synchroniser(false); }
    else {
      montrer("vueAccueil");
      var premier = !S.donnees;
      if (premier) $("etatDonnees").textContent = "Premier téléchargement des données…";
      synchroniser(premier).then(function () { if (cle && S.donnees) ouvrirLot(bdc || "", cle); });
    }
  }).catch(function (e) {
    $("etatDonnees").textContent = "Stockage du téléphone indisponible : " + e.message;
  });
})();
