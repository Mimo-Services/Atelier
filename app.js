/* DuoCore — application hors ligne.
 * Le téléphone garde les lots en cours et la page de déclaration. Une déclaration faite
 * sans réseau est mise en file d'attente et envoyée dès que la connexion revient.
 * Le serveur (Apps Script) refait tous les contrôles : un refus arrive dans « À corriger ». */
(function () {
  "use strict";

  var VERSION_APP = "2026-10-26 FI";
  var DELAI_PLANIF = 240000;   // une saisie BDC peut prendre 1 à 2 minutes côté serveur
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
    recents: [], derniereSync: 0, lotOuvert: null,
    agent: null,        // { nom, code } : agent connecté pour les saisies (Stock…)
    formulaires: null,  // { genere, droits, formulaires: { stock: {...} } }
    planif: null,       // { genere, bdcs: [...], papiers } : planification (droit « Planification »)
    planifLocal: {}     // saisies faites sur le téléphone, par BDC (affichées tant que le serveur ne les a pas reprises)
  };
  function sauver() {
    return Promise.all([ecrire("file", S.file), ecrire("envoyes", S.envoyes), ecrire("aCorriger", S.aCorriger), ecrire("recents", S.recents)]);
  }

  /* ---------- Outils ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return (v === null || v === undefined ? "" : String(v)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
      if (o && o.bdc === lot.bdc && o.cle === lot.cle) appliquerLocal(lot, etats, o, profondeur || 0);
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
    ["vueAccueil", "vueListe", "vueManuel", "vueReglages"].forEach(function (v) { $(v).style.display = v === vue ? "block" : "none"; });
    $("vueScan").style.display = vue === "vueScan" ? "block" : "none";
    $("vueLot").style.display = vue === "vueLot" ? "block" : "none";
    $("btnRetour").style.display = vue === "vueAccueil" ? "none" : "";
    if (vue !== "vueScan") arreterScan();
    if (vue !== "vueLot") { $("cadre").srcdoc = ""; S.lotOuvert = null; }
    if (vue === "vueAccueil") { $("titre").textContent = "DuoCore"; majAccueil(); }
    if (vue === "vueManuel") { $("titre").textContent = "Lot sans QR"; majAccueil(); }
    if (vue === "vueReglages") { $("titre").textContent = "Réglages"; majAccueil(); }
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
    // Tuiles de l'accueil : atelier, saisies autorisées, files d'envoi, synchronisation.
    var fs = (S.agent && S.formulaires && S.formulaires.formulaires) || {}, t = [];
    function tuile(id, ico, lib, det, opt) {
      opt = opt || {};
      t.push("<div class='tuile" + (opt.cls ? " " + opt.cls : "") + "' data-t='" + id + "' role='button' tabindex='0'>" +
        (opt.badge ? "<span class='badge" + (opt.bcls ? " " + opt.bcls : "") + "'>" + esc(opt.badge) + "</span>" : "") +
        "<span class='ico'>" + ico + "</span><span>" + esc(lib) + "</span>" + (det ? "<span class='det'>" + esc(det) + "</span>" : "") + "</div>");
    }
    tuile("scan", "📷", "Scanner une fiche", "Atelier", { cls: "principale" });
    tuile("manuel", "🔢", "Lot sans QR", S.recents.length ? "Derniers lots" : "");
    Object.keys(fs).forEach(function (k) {
      tuile("form:" + k, k === "stock" ? "📦" : "🧾", fs[k].nom || fs[k].titre || k, fs[k].erreur ? "indisponible" : "");
    });
    if (droitPlanif()) {
      var nPl = S.file.filter(function (x) { return x.type === "planif"; }).length;
      tuile("planif", "🗂️", "Planification", "BDC, saisie", nPl ? { badge: nPl, bcls: "orange", cls: "large" } : { cls: "large" });
    }
    if (!S.agent && S.url) tuile("connexion", "🔐", "Saisies", "Se connecter");
    tuile("attente", "⏳", "En attente", S.file.length ? "à envoyer" : "rien", S.file.length ? { badge: S.file.length, bcls: "orange" } : {});
    tuile("corriger", "⛔", "À corriger", S.aCorriger.length ? "refusés" : "rien", S.aCorriger.length ? { badge: S.aCorriger.length, bcls: "rouge" } : {});
    tuile("sync", "⇅", "Synchronisation", S.derniereSync ? dateCourte(S.derniereSync) : "jamais");
    tuile("reglages", "⚙️", "Réglages", S.agent ? S.agent.nom : "");
    $("tuiles").innerHTML = t.join("");
    Array.prototype.forEach.call($("tuiles").querySelectorAll("[data-t]"), function (el) {
      el.onclick = function () {
        var id = el.getAttribute("data-t");
        if (id === "scan") demarrerScan();
        else if (id === "manuel") montrer("vueManuel");
        else if (id.indexOf("form:") === 0) ouvrirFormulaire(id.substring(5));
        else if (id === "connexion") pageConnexion();
        else if (id === "planif") afficherPlanif();
        else if (id === "attente") afficherListe("attente");
        else if (id === "corriger") afficherListe("corriger");
        else if (id === "sync") $("btnSync").onclick();
        else if (id === "reglages") montrer("vueReglages");
      };
    });
    $("sousTitre").textContent = S.agent ? S.agent.nom + " · Atelier & saisies" : "Atelier";
    $("carteAgent").innerHTML = S.agent
      ? "<h3>Agent connecté</h3><div>" + esc(S.agent.nom) + "</div><button class='bouton second' id='btnDeconnexion'>Changer d'agent</button>"
      : "<h3>Saisies</h3><div class='info'>Aucun agent connecté sur ce téléphone.</div>" + (S.url ? "<button class='bouton' id='btnConnexion'>Se connecter</button>" : "");
    if ($("btnConnexion")) $("btnConnexion").onclick = pageConnexion;
    if ($("btnDeconnexion")) $("btnDeconnexion").onclick = function () {
      if (S.file.some(function (x) { return x.type === "form"; }) && !confirm("Des saisies sont en attente d'envoi : elles partiront quand même. Changer d'agent ?")) return;
      S.agent = null; S.formulaires = null; S.planif = null; ecrire("agent", null); ecrire("formulaires", null); ecrire("planif", null); montrer("vueAccueil");
    };

    var d = S.donnees;
    $("etatDonnees").innerHTML = d
      ? "Données du " + dateCourte(d.genere) + " · " + d.lots.length + " lots en cours"
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
  /* Résumé lisible d'un élément de la file (déclaration atelier ou saisie de formulaire). */
  function descriptionItem(x) {
    if (x.type === "planif") return "<b>🗂️ " + esc(x.titre || "Planification") + "</b><br>" + esc(x.resume || "") + "<br><small>" + esc(x.agent) + " · " + dateCourte(x.horodatage) + "</small>";
    if (x.type === "form") return "<b>" + esc(x.titre || "Saisie") + "</b><br>" + esc(x.resume || "") + "<br><small>" + esc(x.agent) + " · " + dateCourte(x.horodatage) + "</small>";
    var o = x.o;
    return esc(o.cle) + " · " + esc(o.bdc) + "<br>" + esc(o.poste) + libEvt(o) + (o.quantite ? " · " + esc(o.quantite) : "") +
      "<br><small>" + esc(o.operateur) + " · " + dateCourte(x.horodatage) + "</small>";
  }
  function afficherListe(type) {
    var v = $("vueListe"), h;
    $("titre").textContent = type === "corriger" ? "À corriger" : "En attente";
    if (type === "corriger") {
      h = "<p class='info'>Le serveur a refusé ces envois (faits hors ligne) : rien n'a été enregistré. " +
          "Vérifiez, refaites la bonne saisie si besoin, puis effacez-la de la liste.</p>";
      h += S.aCorriger.map(function (x, i) {
        var r = x.r || {};
        return "<div class='carte ko'><h3>⛔ " + esc(r.titre || "Refusé") + "</h3>" +
          "<div>" + descriptionItem(x) + "</div>" +
          "<p style='white-space:pre-line'>" + esc(r.message || "") + "</p>" +
          (r.details && r.details.length ? "<table>" + r.details.map(function (d) {
            return "<tr><td>" + esc(d[0]) + "</td><td class='v'>" + esc(d[1]) + "</td></tr>"; }).join("") + "</table>" : "") +
          "<div class='ligne'>" + (x.o ? "<button class='bouton second' data-ouvrir='" + i + "'>Ouvrir le lot</button>" : "") +
          (x.type === "planif" && x.donnees ? "<button class='bouton second' data-planif='" + i + "'>Reprendre la saisie</button>" : "") +
          "<button class='bouton' data-effacer='" + i + "'>Vu, effacer</button></div></div>";
      }).join("") || "<p>Rien à corriger.</p>";
    } else {
      h = "<p class='info'>Ces envois sont gardés sur le téléphone et partiront dès que le réseau revient, " +
          "avec l'heure de la saisie. Ne les refaites pas.</p>";
      h += S.file.map(function (x) {
        return "<div class='carte att'>" + descriptionItem(x) +
          (x.essais ? "<br><small>" + x.essais + " essai(s)" + (x.erreur ? " — " + esc(x.erreur) : "") + "</small>" : "") + "</div>";
      }).join("") || "<p>Rien en attente.</p>";
      h += "<button class='bouton' id='btnEnvoyerMaintenant'>Envoyer maintenant</button>";
    }
    v.innerHTML = h;
    montrer("vueListe");
    Array.prototype.forEach.call(v.querySelectorAll("[data-effacer]"), function (b) {
      b.onclick = function () { S.aCorriger.splice(+b.getAttribute("data-effacer"), 1); sauver(); afficherListe("corriger"); };
    });
    Array.prototype.forEach.call(v.querySelectorAll("[data-planif]"), function (b) {
      b.onclick = function () { ouvrirSaisieBDC(S.aCorriger[+b.getAttribute("data-planif")].donnees.id); };
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
    var ctx = contexteLot(lot), nAtt = S.file.filter(function (x) { return x.o && x.o.bdc === lot.bdc && x.o.cle === lot.cle; }).length;
    var bandeau = "<div style='margin-top:8px;padding:8px 10px;border-radius:10px;font-size:13px;background:" + (nAtt ? "#3a2f1a" : "#2a2826") + "'>" +
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
    html = html.replace("</head>", STYLE_SOMBRE_LOT + "</head>");
    S.lotOuvert = lot;
    $("titre").textContent = lot.cle + " · " + lot.bdc;
    montrer("vueLot");
    S.lotOuvert = lot;
    $("cadre").srcdoc = html;
  }

  /* Thème sombre DuoCore appliqué à la page de déclaration (gabarit du serveur, conçu en clair). */
  var STYLE_SOMBRE_LOT = "<style>" +
    "body{background:#1c1b19!important;color:#f1eee9!important;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif!important}" +
    "body>h2:first-child{display:none}" +
    ".entete{background:#2a2826!important;border-radius:14px!important;border:1px solid #3a3835}" +
    "input,select,textarea{background:#2a2826!important;color:#f1eee9!important;border:1px solid #55514c!important;border-radius:10px!important;padding:10px!important}" +
    "input[type=checkbox],input[type=radio]{accent-color:#c8643c}" +
    "button{background:#c8643c!important;border-radius:12px!important;font-weight:700}button:disabled{background:#555!important}" +
    "#mRetry{background:#b26a00!important}" +
    "#info{border-radius:10px!important}.ok{background:#1f3324!important;color:#b9f6ca!important;border-color:#2e7d32!important}" +
    ".ko{background:#3a1f1f!important;color:#ffd0d0!important;border-color:#8e2a2a!important}" +
    ".av{background:#2a2826!important;border-color:#3a3835!important;border-radius:14px!important}.av h4{color:#e2c48d!important;border-color:#3a3835!important}" +
    ".br{background:#3a3835!important}.ici{background:#1f2f45!important}.arb div{border-color:#3a3835!important}" +
    ".pp.todo{background:#3a3835!important;color:#ccc!important}.pp.ok{background:#1f3324!important;color:#b9f6ca!important}.pp.cours{background:#3a2f1a!important;color:#ffcc80!important}" +
    ".puce.cur{border-color:#e2c48d!important}" +
    "#mBoite{background:#2a2826!important;color:#f1eee9!important;border-radius:16px!important}#mDet td{border-color:#3a3835}" +
    "#blocStock{border-color:#3a3835!important;border-radius:12px!important}" +
    "[style*='color:#666'],[style*='color:#555']{color:#a9a39b!important}#infoOp{color:#ff8a80!important}" +
    "</style>";

  /* ---------- Déclarations : file d'attente et envoi ---------- */
  var resultats = {};      // jeton → réponse du serveur
  var attenteJetons = {};  // jeton → page qui attend sa réponse
  window.ATELIER = {
    declarer: function (o) {
      var it = { jeton: o.jeton || nouveauJeton(), horodatage: parseFloat(o.horodatage) || Date.now(), o: o, essais: 0 };
      it.o.jeton = it.jeton; it.o.horodatage = String(it.horodatage);
      return soumettre(it);
    },
    // OK après une déclaration : la page du lot est rouverte, à jour (comme la page web).
    fermerLot: function () { var l = S.lotOuvert; if (l) ouvrirLot(l.bdc, l.cle, true); else montrer("vueAccueil"); }
  };
  function nouveauJeton() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
  /* Met l'élément en file, tente l'envoi tout de suite ; réponse du serveur, ou « gardée sur le téléphone ». */
  function soumettre(it) {
    if (S.file.some(function (x) { return x.jeton === it.jeton; })) return Promise.resolve(enAttente());
    S.file.push(it);
    var reponse = new Promise(function (ok) { attenteJetons[it.jeton] = ok; });
    return sauver().then(function () {
      majEtat();
      var envoi = envoiP ? envoiP.then(lancerEnvoi) : lancerEnvoi();
      envoi.then(function () { if (attenteJetons[it.jeton]) attenteJetons[it.jeton](resultats[it.jeton] || null); });
      return attendre(reponse, (it.type === "planif" ? DELAI_PLANIF : DELAI_ENVOI) + 5000).catch(function () { return null; }).then(function (r) {
        delete attenteJetons[it.jeton];
        synchroniser(false);
        if (!r) return enAttente();
        // Réponse reçue tout de suite : l'agent la voit, rien à reprendre plus tard.
        S.aCorriger = S.aCorriger.filter(function (x) { return x.jeton !== it.jeton; });
        sauver();
        return r;
      });
    });
  }
  function enAttente() {
    return { ok: true, enAttente: true, titre: "Gardée sur le téléphone",
      message: "Pas de réseau (ou réseau trop lent) : c'est enregistré sur ce téléphone et partira automatiquement dès que la connexion revient.\n\nNE REFAITES PAS LA SAISIE." };
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
      var p1 = (S.url && (forcerDonnees || age > RAFRAICHIR_APRES || (n > 0 && age > 5 * 60000))) ? rafraichir().catch(function () {}) : null;
      var ageF = S.formulaires ? Date.now() - S.formulaires.recu : Infinity;
      var p2 = (S.url && S.agent && (forcerDonnees || ageF > RAFRAICHIR_APRES)) ? rafraichirFormulaires().catch(function () {}) : null;
      var ageP = S.planif ? Date.now() - S.planif.recu : Infinity;
      var p3 = (S.url && droitPlanif() && (forcerDonnees || n > 0 || ageP > RAFRAICHIR_APRES)) ? rafraichirPlanif().catch(function () {}) : null;
      return Promise.all([p1, p2, p3]);
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
      var corps;
      if (it.type === "planif") corps = { api: "planifEnvoyer", agent: it.agent, code: it.code, op: it.op, jeton: it.jeton, horodatage: String(it.horodatage), donnees: it.donnees };
      else if (it.type === "form") corps = { api: "repondre", agent: it.agent, code: it.code, formulaire: it.form, jeton: it.jeton, horodatage: String(it.horodatage), reponses: it.reponses };
      else { corps = { api: "declarer" }; for (var k in it.o) corps[k] = it.o[k]; }
      return requete(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(corps), redirect: "follow" }, it.type === "planif" ? DELAI_PLANIF : DELAI_ENVOI)
        .then(function (r) {
          S.derniereSync = Date.now(); ecrire("derniereSync", S.derniereSync);
          if (erreurPassagere(r) && it.essais < 6) { it.erreur = r.message; return sauver().then(function () { return n; }); }
          S.file.shift();
          resultats[it.jeton] = r;
          if (attenteJetons[it.jeton]) attenteJetons[it.jeton](r);
          if (r.ok) { if (it.o) { S.envoyes.push({ jeton: it.jeton, o: it.o, recuA: Date.now() }); n++; } else if (it.type === "planif") n++; }
          else { var c = JSON.parse(JSON.stringify(it)); c.r = r; delete c.code; S.aCorriger.push(c); }
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

  /* ---------- Planification (BDC) : hors ligne, envoyée à la synchronisation ---------- */
  var rafPl = null;
  function droitPlanif() { return !!(S.agent && S.formulaires && S.formulaires.droits && S.formulaires.droits.planif); }
  function rafraichirPlanif() {
    if (!S.url || !droitPlanif()) return Promise.resolve();
    if (rafPl) return rafPl;
    rafPl = requete(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow",
      body: JSON.stringify({ api: "planif", agent: S.agent.nom, code: S.agent.code }) }, DELAI_DONNEES).then(function (r) {
      if (!r.ok) throw new Error(r.message || "accès refusé");
      r.recu = Date.now(); S.planif = r;
      // Saisies locales déjà appliquées par le serveur : retirées.
      Object.keys(S.planifLocal).forEach(function (id) {
        if (!S.file.some(function (x) { return x.type === "planif" && x.donnees.id === id; })) delete S.planifLocal[id];
      });
      return Promise.all([ecrire("planif", r), ecrire("planifLocal", S.planifLocal)]);
    }).then(function () { rafPl = null; }, function (e) { rafPl = null; throw e; });
    return rafPl;
  }
  function bdcPlanif(id) { return ((S.planif && S.planif.bdcs) || []).filter(function (b) { return b.id === id; })[0] || null; }
  function enAttentePlanif(id) { return S.file.some(function (x) { return x.type === "planif" && x.donnees.id === id; }); }

  function afficherPlanif() {
    $("titre").textContent = "Planification";
    var P = S.planif;
    if (!P) {
      $("vueListe").innerHTML = "<div class='carte'><h3>Planification</h3><p class='info'>Aucune donnée sur ce téléphone : connectez-vous au réseau puis appuyez sur ⟳.</p></div>";
      montrer("vueListe"); return;
    }
    var h = "<div class='carte'><h3>🗂️ BDC ouverts</h3><div class='info'>Données du " + dateCourte(P.genere) + " · " + P.bdcs.length + " BDC. " +
      "Les saisies faites ici partent à la synchronisation.</div><input id='plCherche' placeholder='Rechercher un BDC, un client…'></div><div id='plListe'></div>";
    $("vueListe").innerHTML = h;
    montrer("vueListe");
    function liste() {
      var q = $("plCherche").value.trim().toLowerCase();
      $("plListe").innerHTML = P.bdcs.filter(function (b) { return !q || (b.libelle + " " + b.client + " " + b.statut).toLowerCase().indexOf(q) !== -1; })
        .map(function (b) {
          var att = enAttentePlanif(b.id);
          return "<div class='carte" + (att ? " att" : "") + "' data-bdc='" + esc(b.id) + "' style='cursor:pointer'><b>" + esc(b.libelle) + "</b>" +
            "<div class='info'>" + esc(b.client || "—") + " · " + esc(b.statut || "—") + " · " + b.lignes.length + " ligne(s)" + (att ? " · ⏳ saisie en attente d'envoi" : "") + "</div></div>";
        }).join("") || "<p class='info'>Aucun BDC.</p>";
      Array.prototype.forEach.call($("plListe").querySelectorAll("[data-bdc]"), function (el) { el.onclick = function () { ouvrirSaisieBDC(el.getAttribute("data-bdc")); }; });
    }
    $("plCherche").oninput = liste; liste();
  }

  function ouvrirSaisieBDC(id) {
    var b = bdcPlanif(id); if (!b) return;
    var loc = S.planifLocal[id], src = loc || { lignes: b.lignes, commun: b.commun, papCommun: b.papCommun };
    var PAP = (S.planif.papiers || []);
    function opt(v) { var o = "<option value=''>—</option>", ok = false; PAP.forEach(function (x) { o += "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; if (x === v) ok = true; }); if (v && !ok) o += "<option selected>" + esc(v) + "</option>"; return o; }
    $("titre").textContent = "Saisie BDC";
    var h = "<div class='carte'><h3>" + esc(b.libelle) + "</h3><div class='info'>" + esc(b.client || "") + " · " + esc(b.statut || "") +
      (b.qteGlobale !== "" && b.qteGlobale != null ? " · Qté globale " + Number(b.qteGlobale).toLocaleString("fr-FR") : "") + "</div>" +
      (loc ? "<div class='carte att' style='margin-top:8px'>⏳ Votre saisie du " + dateCourte(loc.quand) + " " + (enAttentePlanif(id) ? "attend l'envoi." : "est envoyée ; ⟳ pour voir l'état du serveur.") + "</div>" : "") +
      "<label>Format fini commun (mm, L×H)</label><input id='sbFmt' placeholder='100x150' value='" + esc(src.commun) + "'>" +
      "<label>Papier commun</label><select id='sbPap'>" + opt(src.papCommun) + "</select>" +
      "<label>Feuillets / carnet pour tous (sauf composants)</label><div class='ligne'><input id='sbFc' inputmode='numeric' placeholder='25'><button class='bouton second' id='sbFcOk' style='margin-top:6px'>Appliquer</button></div></div>" +
      "<div id='sbLignes'></div><button class='bouton second' id='sbAjout'>➕ Ligne</button>" +
      "<div class='carte' id='sbTotal'></div><div class='carte' id='sbConf' style='display:none'></div>" +
      "<button class='bouton second' id='sbEnr'>💾 Enregistrer</button><button class='bouton' id='sbEnv'>✅ Enregistrer et envoyer dans Statut Prod</button>" +
      "<div id='sbMsg' class='info' style='margin-top:8px;white-space:pre-line'></div>";
    $("vueListe").innerHTML = h;
    montrer("vueListe");
    function carte(l) {
      l = l || {}; var comp = /\(composant\)\s*$/i.test(l.nom || ""), nom = String(l.nom || "").replace(/\s*\(composant\)\s*$/i, "");
      var d = document.createElement("div"); d.className = "carte sbL";
      d.innerHTML = "<div class='ligne'><div style='flex:3'><label style='margin-top:0'>Article (nom sur BDC)</label><input class='nm' value='" + esc(nom) + "'></div>" +
        "<button class='lien' style='flex:0;align-self:flex-start;color:#ff8a80;font-size:22px' title='Supprimer'>✖</button></div>" +
        "<div class='ligne'><div><label>Qté BDC</label><input class='q' inputmode='decimal' value='" + esc(l.qte) + "'></div><div><label>N° départ</label><input class='dp' inputmode='numeric' value='" + esc(l.depart) + "'></div><div><label>Abrév.</label><input class='ab' value='" + esc(l.abr) + "'></div></div>" +
        "<div class='ligne'><div><label>Format (si diff.)</label><input class='fm' placeholder='LxH' value='" + esc(l.fmt) + "'></div><div><label>Feuillets / carnet</label><input class='fc' inputmode='numeric' placeholder='1' value='" + esc(l.fc) + "'></div><div><label>Stock fini</label><input class='sf' inputmode='numeric' placeholder='0' value='" + esc(l.sf) + "'></div></div>" +
        "<label>Papier (si différent)</label><select class='pp'>" + opt(l.pap) + "</select>" +
        "<label style='font-weight:400'><input type='checkbox' class='cp' style='width:auto'" + (comp ? " checked" : "") + "> Composant (couverture, dossier… non facturé)</label>" +
        (l.etat ? "<div class='info'>" + esc(l.etat) + "</div>" : "");
      d.querySelector(".lien").onclick = function () { d.remove(); total(); };
      d.querySelector(".q").oninput = total; d.querySelector(".cp").onchange = total;
      $("sbLignes").appendChild(d);
    }
    function num(v) { v = String(v || "").replace(/[\s  ]/g, ""); if (/^-?\d{1,3}([.,]\d{3})+$/.test(v)) return parseFloat(v.replace(/[.,]/g, "")); var x = parseFloat(v.replace(",", ".")); return isNaN(x) ? 0 : x; }
    function lignes() {
      var L = [];
      Array.prototype.forEach.call(document.querySelectorAll(".sbL"), function (c) {
        var n = c.querySelector(".nm").value.trim(); if (!n) return;
        L.push({ nom: n + (c.querySelector(".cp").checked ? " (composant)" : ""), qte: c.querySelector(".q").value, depart: c.querySelector(".dp").value,
                 abr: c.querySelector(".ab").value, fmt: c.querySelector(".fm").value, fc: c.querySelector(".fc").value, pap: c.querySelector(".pp").value, sf: c.querySelector(".sf").value });
      });
      return L;
    }
    // Hausse de quantité par rapport aux lignes du serveur : confirmation du montant (comme dans Sheets).
    function hausses(L) {
      var av = {}; b.lignes.forEach(function (l) { av[String(l.nom).toLowerCase()] = num(l.qte); });
      return L.filter(function (l) { var a = av[String(l.nom).toLowerCase()]; return b.lignes.length && (a === undefined ? num(l.qte) > 0 : num(l.qte) > a); });
    }
    function total() {
      var t = 0; lignes().forEach(function (l) { if (!/\(composant\)\s*$/i.test(l.nom)) t += num(l.qte); });
      var g = b.qteGlobale !== "" && b.qteGlobale != null ? Number(b.qteGlobale) : null;
      $("sbTotal").innerHTML = "Total saisi : <b>" + t.toLocaleString("fr-FR") + "</b>" + (g !== null ? " / Qté globale : <b>" + g.toLocaleString("fr-FR") + "</b> " + (Math.abs(t - g) < 0.001 ? "✔" : "✖") : "");
      var hs = hausses(lignes());
      $("sbConf").style.display = hs.length ? "" : "none";
      if (hs.length && !$("sbMotif")) $("sbConf").innerHTML = "<h3>⚠️ Hausse de quantité</h3><div class='info' id='sbHs'></div>" +
        "<label style='font-weight:400'><input type='radio' name='sbM' value='garder' checked style='width:auto'> Garder le montant actuel du BDC</label>" +
        "<label style='font-weight:400'><input type='radio' name='sbM' value='nouveau' style='width:auto'> Nouveau montant :</label><input id='sbMontant' inputmode='decimal'>" +
        "<label>Motif (obligatoire)</label><input id='sbMotif' placeholder='ex. avenant client du …'>";
      if (hs.length) $("sbHs").textContent = hs.map(function (l) { return l.nom + " → " + l.qte; }).join(" ; ");
    }
    (src.lignes.length ? src.lignes : [{}]).forEach(carte); total();
    $("sbAjout").onclick = function () { carte({}); };
    $("sbFcOk").onclick = function () { var v = $("sbFc").value.trim(); Array.prototype.forEach.call(document.querySelectorAll(".sbL"), function (c) { if (!c.querySelector(".cp").checked) c.querySelector(".fc").value = v; }); };
    function envoyer(env) {
      var L = lignes(), msg = $("sbMsg");
      if (!L.length) { msg.textContent = "⛔ Saisissez au moins une ligne."; return; }
      var mal = L.filter(function (l) { return String(l.fmt || "").trim() && !/^\d+(?:[.,]\d+)?\s*[x×*]\s*\d+(?:[.,]\d+)?$/i.test(String(l.fmt).trim()); });
      if (mal.length) { msg.textContent = "⛔ Format illisible pour « " + mal[0].nom + " » : écrivez par ex. 148x210."; return; }
      if (env && !$("sbFmt").value.trim() && L.some(function (l) { return !String(l.fmt || "").trim(); })) { msg.textContent = "⛔ Format fini obligatoire pour envoyer dans Statut Prod (commun ou par ligne)."; return; }
      var conf = null;
      if (hausses(L).length) {
        var mo = ($("sbMotif") || {}).value || "", m = document.querySelector("input[name=sbM]:checked");
        if (!mo.trim()) { msg.textContent = "⛔ Hausse de quantité : motif obligatoire."; return; }
        if (m && m.value === "nouveau") { if (!(num($("sbMontant").value) > 0)) { msg.textContent = "⛔ Nouveau montant invalide."; return; } conf = { montant: num($("sbMontant").value), motif: mo.trim() }; }
        else conf = { garder: true, motif: mo.trim() };
      }
      var donnees = { id: b.id, lignes: L, envoyer: !!env, commun: $("sbFmt").value.trim(), papCommun: $("sbPap").value, semi: b.semi || [], confirmation: conf, version: b.version };
      S.planifLocal[b.id] = { lignes: L, commun: donnees.commun, papCommun: donnees.papCommun, quand: Date.now() };
      ecrire("planifLocal", S.planifLocal);
      var it = { type: "planif", op: "saisieBDC", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: donnees,
                 titre: "Saisie BDC" + (env ? " + envoi Statut Prod" : ""), resume: b.libelle + " · " + L.length + " ligne(s)", essais: 0 };
      $("sbEnr").disabled = $("sbEnv").disabled = true; msg.textContent = "⏳ Envoi… (jusqu'à 2 minutes : Lignes BDC, Paramètres montage, Statut Prod)";
      soumettre(it).then(function (r) {
        $("sbEnr").disabled = $("sbEnv").disabled = false;
        msg.textContent = (r.enAttente ? "📥 " : r.ok ? "✅ " : "⛔ ") + (r.titre || "") + "\n" + (r.message || "");
        if (r.ok && !r.enAttente) rafraichirPlanif().catch(function () {});
      });
    }
    $("sbEnr").onclick = function () { envoyer(false); };
    $("sbEnv").onclick = function () { envoyer(true); };
  }

  /* ---------- Saisies (formulaires Google : Stock, puis BASE) ---------- */
  var rafF = null;
  function rafraichirFormulaires(agent) {
    agent = agent || S.agent;
    if (!S.url || !agent) return Promise.reject(new Error("non connecté"));
    if (rafF) return rafF;
    rafF = requete(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow",
      body: JSON.stringify({ api: "formulaires", agent: agent.nom, code: agent.code }) }, DELAI_DONNEES).then(function (r) {
      if (!r.ok) {
        if (r.titre === "Accès refusé" && agent === S.agent) { S.agent = null; S.formulaires = null; ecrire("agent", null); ecrire("formulaires", null); }
        throw new Error(r.message || "accès refusé");
      }
      r.recu = Date.now();
      S.agent = { nom: r.agent, code: agent.code }; S.formulaires = r;
      return Promise.all([ecrire("agent", S.agent), ecrire("formulaires", r)]);
    }).then(function () { rafF = null; }, function (e) { rafF = null; throw e; });
    return rafF;
  }

  function pageConnexion() {
    // Seuls les agents autorisés dans « Accès App » (code + rubrique cochée) sont proposés.
    var noms = ((S.donnees && (S.donnees.agentsApp || S.donnees.operateurs)) || []);
    $("titre").textContent = "Connexion";
    $("vueListe").innerHTML = "<div class='carte'><h3>Saisies (Stock…)</h3><p class='info'>Choisissez votre nom et tapez votre code personnel " +
      "(donné par la direction). Une seule fois sur ce téléphone, avec réseau.</p>" +
      "<label for='cxNom'>Nom</label><select id='cxNom'><option value=''>— Choisir —</option>" +
      noms.map(function (n) { return "<option>" + esc(n) + "</option>"; }).join("") + "</select>" +
      "<label for='cxCode'>Code personnel</label><input id='cxCode' type='password' inputmode='numeric' autocomplete='off'>" +
      "<div id='cxMsg' class='info' style='margin-top:8px'></div>" +
      "<button class='bouton' id='cxOk'>Se connecter</button></div>";
    montrer("vueListe");
    $("cxOk").onclick = function () {
      var a = { nom: $("cxNom").value, code: $("cxCode").value.trim() };
      if (!a.nom || !a.code) { $("cxMsg").textContent = "Nom et code obligatoires."; return; }
      $("cxOk").disabled = true; $("cxMsg").textContent = "Vérification…";
      rafraichirFormulaires(a).then(function () { if (droitPlanif()) rafraichirPlanif().catch(function () {}).then(majAccueil); montrer("vueAccueil"); }, function (e) {
        $("cxOk").disabled = false; $("cxMsg").textContent = "⛔ " + e.message;
      });
    };
  }

  /* Formulaire : une page à la fois, mêmes sections et mêmes branchements que Google Forms. */
  var F = null;   // { cle, st, idx, chemin: [index des pages], rep: { id: valeur } }
  function ouvrirFormulaire(cle) {
    var st = S.formulaires && S.formulaires.formulaires[cle];
    if (!st || st.erreur) { alert("Formulaire indisponible" + (st && st.erreur ? " : " + st.erreur : "") + ". Appuyez sur 🔄 avec réseau."); return; }
    F = { cle: cle, st: st, idx: 0, chemin: [0], rep: {} };
    // Identifiants d'affichage ; réponses par défaut (agent connecté, date du jour, valeur fixe).
    var auj = new Date(), z = function (n) { return (n < 10 ? "0" : "") + n; };
    var jour = auj.getFullYear() + "-" + z(auj.getMonth() + 1) + "-" + z(auj.getDate());
    st.pages.forEach(function (pg, i) {
      pg.questions.forEach(function (q, j) {
        q.id = i + "_" + j;
        var d = String(q.defaut || "").toUpperCase(), estAgent = q.choix && q.choix.some(function (c) { return String(c.v).toUpperCase() === S.agent.nom.toUpperCase(); });
        if ((d === "AGENT" || (!d && /EDITEUR|ÉDITEUR|AGENT|SAISI|OP[ÉE]RATEUR/i.test(q.titre))) && (estAgent || !q.choix))
          F.rep[q.id] = q.choix ? q.choix.filter(function (c) { return String(c.v).toUpperCase() === S.agent.nom.toUpperCase(); })[0].v : S.agent.nom;
        else if (d === "AUJOURDHUI" || d === "AUJOURD'HUI" || (!d && q.type === "date")) F.rep[q.id] = q.type === "dateheure" ? jour + "T" + z(auj.getHours()) + ":" + z(auj.getMinutes()) : jour;
        else if (q.defaut && d !== "AGENT") F.rep[q.id] = q.type === "cases" ? String(q.defaut).split(/\s*;\s*/) : q.defaut;
      });
    });
    afficherPageFormulaire();
  }
  function champQuestion(q) {
    var v = F.rep[q.id], id = "q" + q.id, h = "<div class='carte' id='bloc" + q.id + "'><label for='" + id + "' style='margin-top:0'>" + esc(q.titre) + (q.requis ? " <span style='color:#b00020'>*</span>" : "") + "</label>" +
      (q.aide ? "<div class='info'>" + esc(q.aide) + "</div>" : "");
    if (q.type === "titre") return "<div class='carte'><h3>" + esc(q.titre) + "</h3>" + (q.aide ? "<div class='info'>" + esc(q.aide) + "</div>" : "") + "</div>";
    if (q.type === "non_gere") return h + "<div class='info'>⚠️ Question non gérée par l'application (laissée vide).</div></div>";
    if (q.type === "liste") {
      h += "<select id='" + id + "' data-q='" + q.id + "'><option value=''>— Choisir —</option>" + q.choix.map(function (c) {
        return "<option" + (String(c.v) === String(v) ? " selected" : "") + ">" + esc(c.v) + "</option>"; }).join("") + "</select>";
      if (q.choix.length > 15) h += "<input type='search' placeholder='🔎 Filtrer la liste…' data-filtre='" + id + "' style='margin-top:6px'>";
    } else if (q.type === "choix" || q.type === "cases") {
      var multi = q.type === "cases", vals = multi ? [].concat(v || []) : [v];
      h += q.choix.map(function (c, i) {
        return "<label style='font-weight:normal;display:flex;gap:10px;align-items:center;margin-top:8px'><input type='" + (multi ? "checkbox" : "radio") +
          "' name='" + id + "' data-q='" + q.id + "' value=\"" + esc(c.v) + "\" style='width:22px;height:22px;margin:0'" + (vals.indexOf(c.v) !== -1 ? " checked" : "") + "> " + esc(c.v) + "</label>";
      }).join("");
    } else if (q.type === "paragraphe") h += "<textarea id='" + id + "' data-q='" + q.id + "' rows='3' style='width:100%;font-size:16px;padding:8px'>" + esc(v || "") + "</textarea>";
    else {
      var typ = { texte: "text", nombre: "text", date: "date", dateheure: "datetime-local", heure: "time", echelle: "number" }[q.type] || "text";
      h += "<input id='" + id + "' data-q='" + q.id + "' type='" + typ + "' value=\"" + esc(v || "") + "\"" + (estNombre(q) ? " inputmode='decimal'" : "") +
        (q.type === "echelle" ? " min='" + q.min + "' max='" + q.max + "' inputmode='numeric'" : "") + ">";
    }
    return h + "<div class='info' id='err" + q.id + "' style='color:#b00020'></div></div>";
  }
  function lireReponsesPage() {
    var pg = F.st.pages[F.idx];
    pg.questions.forEach(function (q) {
      if (q.type === "choix") { var r = document.querySelector("input[name='q" + q.id + "']:checked"); F.rep[q.id] = r ? r.value : ""; }
      else if (q.type === "cases") F.rep[q.id] = Array.prototype.map.call(document.querySelectorAll("input[name='q" + q.id + "']:checked"), function (x) { return x.value; });
      else { var el = $("q" + q.id); if (el) F.rep[q.id] = el.value.trim(); }
    });
  }
  // Les règles de validation du formulaire ne sont pas lisibles : une question de quantité / montant attend un nombre.
  function estNombre(q) { return q.type === "nombre" || q.type === "texte" && /QUANTIT|MONTANT|PRIX|NOMBRE|POIDS|\bQTE\b|\bQTÉ\b/i.test(q.titre); }
  function vide(v) { return v === undefined || v === null || v === "" || (v instanceof Array && !v.length); }
  /* Page suivante : branchement de la réponse choisie, sinon suite de la section, sinon page suivante. */
  function pageSuivante() {
    var pg = F.st.pages[F.idx], aller = null;
    pg.questions.forEach(function (q) {
      if ((q.type === "liste" || q.type === "choix") && !vide(F.rep[q.id]))
        q.choix.forEach(function (c) { if (String(c.v) === String(F.rep[q.id]) && c.aller) aller = c.aller; });
    });
    aller = aller || pg.suite;
    if (aller && aller.fin) return -1;
    if (aller && aller.debut) return 0;
    if (aller && aller.page !== undefined) {
      for (var i = 0; i < F.st.pages.length; i++) if (F.st.pages[i].id === aller.page) return i;
    }
    return F.idx + 1 < F.st.pages.length ? F.idx + 1 : -1;
  }
  function afficherPageFormulaire() {
    var pg = F.st.pages[F.idx], derniere = pageSuivante() === -1;
    $("titre").textContent = F.st.nom || F.st.titre;
    $("vueListe").innerHTML = "<div class='carte info'>Page " + F.chemin.length + " · " + esc(S.agent.nom) + "</div>" +
      (pg.titre && F.idx > 0 ? "<h3 style='margin:14px 0 0'>" + esc(pg.titre) + "</h3>" : "") +
      (pg.aide ? "<p class='info' style='white-space:pre-line'>" + esc(pg.aide) + "</p>" : "") +
      pg.questions.map(champQuestion).join("") +
      "<div class='ligne'>" + (F.chemin.length > 1 ? "<button class='bouton second' id='fPrec'>◀ Précédent</button>" : "") +
      "<button class='bouton' id='fSuiv'>" + (derniere ? "Vérifier et envoyer" : "Suivant ▶") + "</button></div>";
    montrer("vueListe");
    Array.prototype.forEach.call(document.querySelectorAll("[data-filtre]"), function (f) {
      var sel = $(f.getAttribute("data-filtre")), tous = Array.prototype.map.call(sel.options, function (o) { return o.value; });
      f.oninput = function () {
        var t = f.value.toUpperCase(), garde = sel.value;
        sel.innerHTML = "<option value=''>— Choisir —</option>" + tous.filter(function (x) { return x && x.toUpperCase().indexOf(t) !== -1; })
          .map(function (x) { return "<option" + (x === garde ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("");
      };
    });
    // Un choix qui change le branchement change aussi le libellé du bouton.
    Array.prototype.forEach.call(document.querySelectorAll("[data-q]"), function (el) {
      el.addEventListener("change", function () { lireReponsesPage(); $("fSuiv").textContent = pageSuivante() === -1 ? "Vérifier et envoyer" : "Suivant ▶"; });
    });
    if ($("fPrec")) $("fPrec").onclick = function () { lireReponsesPage(); F.chemin.pop(); F.idx = F.chemin[F.chemin.length - 1]; afficherPageFormulaire(); };
    $("fSuiv").onclick = function () {
      lireReponsesPage();
      pg.questions.forEach(function (q) { var e = $("err" + q.id); if (e) e.textContent = ""; });
      var manque = pg.questions.filter(function (q) {
        if (q.requis && vide(F.rep[q.id])) { $("err" + q.id).textContent = "Réponse obligatoire."; return true; }
        if (estNombre(q) && !vide(F.rep[q.id])) {
          F.rep[q.id] = String(F.rep[q.id]).replace(/\s/g, "").replace(",", ".");
          if (isNaN(parseFloat(F.rep[q.id])) || !/^-?[\d.]+$/.test(F.rep[q.id])) { $("err" + q.id).textContent = "Un nombre est attendu."; return true; }
        }
        return false;
      });
      if (manque.length) { $("bloc" + manque[0].id).scrollIntoView(); return; }
      var n = pageSuivante();
      if (n === -1) return recapFormulaire();
      F.idx = n; F.chemin.push(n); afficherPageFormulaire();
    };
  }
  /* Réponses retenues : seulement celles des pages réellement parcourues (comme Google Forms). */
  function reponsesRetenues() {
    var r = [], lignes = [];
    F.chemin.forEach(function (i) {
      F.st.pages[i].questions.forEach(function (q) {
        if (q.type === "titre" || q.type === "non_gere" || vide(F.rep[q.id])) return;
        r.push([q.titre, F.rep[q.id], q.type]);
        lignes.push([q.titre, [].concat(F.rep[q.id]).join(", ")]);
      });
    });
    return { reponses: r, lignes: lignes };
  }
  function recapFormulaire() {
    var rr = reponsesRetenues();
    $("vueListe").innerHTML = "<div class='carte'><h3>Vérifiez avant d'envoyer</h3><table>" + rr.lignes.map(function (l) {
      return "<tr><td>" + esc(l[0]) + "</td><td class='v'>" + esc(l[1]) + "</td></tr>"; }).join("") + "</table></div>" +
      "<div class='ligne'><button class='bouton second' id='fModif'>◀ Modifier</button><button class='bouton' id='fEnvoyer'>Envoyer</button></div>";
    window.scrollTo(0, 0);
    $("fModif").onclick = afficherPageFormulaire;
    $("fEnvoyer").onclick = function () {
      var b = $("fEnvoyer"); b.disabled = true; b.textContent = "Envoi…";
      var it = { type: "form", form: F.cle, titre: F.st.nom || F.st.titre, jeton: nouveauJeton(), horodatage: Date.now(), essais: 0,
                 agent: S.agent.nom, code: S.agent.code, reponses: rr.reponses,
                 resume: rr.lignes.slice(0, 4).map(function (l) { return l[1]; }).join(" · ") };
      soumettre(it).then(function (r) {
        var couleur = r.enAttente ? "att" : (r.ok ? "" : "ko");
        $("vueListe").innerHTML = "<div class='carte " + couleur + "'><h3>" + (r.enAttente ? "📥 " : r.ok ? "✅ " : "⛔ ") + esc(r.titre) + "</h3>" +
          "<p style='white-space:pre-line'>" + esc(r.message || "") + "</p></div>" +
          (r.ok ? "<button class='bouton' id='fNouveau'>Nouvelle saisie</button>" : "<button class='bouton' id='fCorriger'>◀ Corriger la saisie</button>") +
          "<button class='bouton second' id='fAccueil'>Accueil</button>";
        if ($("fNouveau")) $("fNouveau").onclick = function () { ouvrirFormulaire(F.cle); };
        if ($("fCorriger")) $("fCorriger").onclick = afficherPageFormulaire;
        $("fAccueil").onclick = function () { montrer("vueAccueil"); };
      });
    };
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
  $("btnMenu").onclick = function () { montrer("vueReglages"); };
  $("annulerScan").onclick = function () { montrer("vueAccueil"); };
  $("btnRetour").onclick = function () { montrer("vueAccueil"); };
  $("btnSync").onclick = function () {
    var b = $("btnSync"); b.disabled = true; b.textContent = "⏳";
    synchroniser(true).then(function () {
      b.disabled = false; b.textContent = "⟳";
      if (S.lotOuvert) ouvrirLot(S.lotOuvert.bdc, S.lotOuvert.cle, true);
    });
  };
  $("choixBdc").onchange = majChoixCle;
  $("btnOuvrirManuel").onclick = function () { if ($("choixCle").value) ouvrirLot($("choixBdc").value, $("choixCle").value); };
  $("btnEnregistrerUrl").onclick = function () {
    var v = $("urlServeur").value.trim();
    if (v && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(v)) { alert("L'adresse doit commencer par https://script.google.com/ et finir par /exec"); return; }
    S.url = v; var be = $("btnEnregistrerUrl"); be.textContent = "✅ Adresse enregistrée";
    setTimeout(function () { be.textContent = "Enregistrer"; }, 3000);
    ecrire("url", v).then(function () { synchroniser(true); });
  };
  window.addEventListener("online", function () { majEtat(); synchroniser(false); });
  window.addEventListener("offline", majEtat);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) synchroniser(false); });
  setInterval(function () { if (S.file.length || !S.donnees || Date.now() - S.donnees.recu > RAFRAICHIR_APRES) synchroniser(false); }, 60000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  Promise.all(["url", "donnees", "gabarit", "gv", "file", "envoyes", "aCorriger", "recents", "derniereSync", "agent", "formulaires", "planif", "planifLocal"].map(lire)).then(function (v) {
    S.agent = v[9] || null; S.formulaires = v[10] || null; S.planif = v[11] || null; S.planifLocal = v[12] || {};
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
