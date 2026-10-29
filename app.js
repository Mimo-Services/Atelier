/* DuoCore — application hors ligne.
 * Le téléphone garde les lots en cours et la page de déclaration. Une déclaration faite
 * sans réseau est mise en file d'attente et envoyée dès que la connexion revient.
 * Le serveur (Apps Script) refait tous les contrôles : un refus arrive dans « À corriger ». */
(function () {
  "use strict";

  var VERSION_APP = "2026-11-05 HE";
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
    url = avecAppareil(url, options);
    var ctl = window.AbortController ? new AbortController() : null;
    if (ctl) options.signal = ctl.signal;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return attendre(fetch(url, options), ms + 1000).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function (txt) {
      var j;
      try { j = JSON.parse(txt); }
      catch (e) { throw new Error("Réponse illisible du serveur (déploiement à jour ? accès « Tout le monde » ?)"); }
      surReponseSecurite(j);
      return j;
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
    $("vuePlanif").style.display = vue === "vuePlanif" ? "flex" : "none";
    PL.actif = vue === "vuePlanif";
    if (PL.actif) $("vueListe").innerHTML = "";
    if (vue !== "vuePlanif") { $("plCadre").srcdoc = ""; $("plC").innerHTML = ""; PL.id = null; }
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
    function section(titre) { t.push("<div class='sect'>" + titre + "</div>"); }
    section("Atelier");
    tuile("scan", "📷", "Scanner une fiche", "Atelier", { cls: "principale" });
    tuile("manuel", "🔢", "Lot sans QR", S.recents.length ? "Derniers lots" : "");
    Object.keys(fs).forEach(function (k) {
      if (k === "stock" && droitStockVal()) return;   // fusionnée : tuile « Sortie de stock » = saisie + liste des demandes
      tuile("form:" + k, k === "stock" ? "📦" : "🧾", k === "stock" ? "Sortie de stock" : fs[k].nom || fs[k].titre || k, fs[k].erreur ? "indisponible" : k === "stock" ? "Nouvelle saisie" : "");
    });
    if (droitStockVal()) { var nS = stockNbAttente(); tuile("stockval", "📦", "Sortie de stock", S.stockv && S.stockv.direction ? "Saisie, à valider" : "Saisie, mes demandes", nS ? { badge: nS, bcls: S.stockv && S.stockv.direction ? "rouge" : "orange" } : {}); }
    if (droitPlanif() || droitFin() || droitRH() || droitCom() || droitTreso() || droitMis()) section("Gestion");
    if (droitPlanif()) {
      var nPl = S.file.filter(function (x) { return x.type === "planif"; }).length;
      tuile("planif", "🗂️", "Planification", "BDC, saisie", nPl ? { badge: nPl, bcls: "orange", cls: "large" } : { cls: "large" });
    }
    if (droitFin()) {
      var nF = finNbATraiter();
      tuile("finances", "💰", "Finances", S.fin && S.fin.role ? "Validation " + S.fin.role : S.fin && S.fin.comptable ? "Comptabilité" : "Demandes, paiements", nF ? { badge: nF, bcls: "rouge", cls: "large" } : { cls: "large" });
    }
    if (droitRH()) {
      var nR = rhNbATraiter();
      tuile("rh", "👥", "RH", S.rh && S.rh.direction ? "Personnel, validation" : "Personnel, événements", nR ? { badge: nR, bcls: "rouge", cls: "large" } : { cls: "large" });
    }
    if (droitCom()) {
      var nC = comRetards().length;
      tuile("commercial", "🤝", "Commercial", "Contrats, BL, factures", nC ? { badge: "⏰" + nC, bcls: "rouge", cls: "large" } : { cls: "large" });
    }
    if (droitTreso()) tuile("treso", "🏦", "Trésorerie", S.formulaires.droits.validation === "Walid" || S.formulaires.droits.validation === "DG" ? "Tous les comptes" : "Vos comptes", { cls: "large" });
    if (droitMis()) {
      var nM = misNbBadge();
      tuile("missions", "🎯", "Missions", S.mis && S.mis.direction ? "Équipe, clôture" : "Mes missions", nM ? { badge: nM, bcls: "rouge", cls: "large" } : { cls: "large" });
    }
    section("Appareil");
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
        else if (id === "finances") afficherFinances();
        else if (id === "rh") afficherRH();
        else if (id === "commercial") afficherCom();
        else if (id === "missions") afficherMis();
        else if (id === "treso") afficherTreso();
        else if (id === "stockval") afficherStockVal();
        else if (id === "planif") { if (modePC()) afficherPlanifPC(); else afficherPlanif(); }
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
      S.agent = null; S.formulaires = null; S.planif = null; S.fin = null; S.rh = null; S.com = null; S.mis = null; S.treso = null; S.stockv = null; ecrire("stockv", null); TRV.releves = {}; ecrire("treso", null); FOUR.liste = null; FOUR.fiches = {}; ecrire("four", null); ecrire("com", null); ecrire("mis", null); ecrire("agent", null); ecrire("formulaires", null); ecrire("planif", null); ecrire("fin", null); ecrire("rh", null); montrer("vueAccueil");
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
    majCarteNotif();
    if ($("infoAffichage")) $("infoAffichage").textContent = "Affichage actuel : " + (modePC() ? "PC / tablette" : "Téléphone");
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
    if (x.type === "mis") return "<b>🎯 " + esc(x.titre || "Missions") + "</b><br><small>" + esc(x.agent) + " · " + dateCourte(x.horodatage) + "</small>";
    if (x.type === "com") return "<b>🤝 " + esc(x.titre || "Commercial") + "</b><br><small>" + esc(x.agent) + " · " + dateCourte(x.horodatage) + "</small>";
    if (x.type === "rh") return "<b>👥 " + esc(x.titre || "RH") + "</b><br><small>" + esc(x.agent) + " · " + dateCourte(x.horodatage) + "</small>";
    if (x.type === "fin") return "<b>💰 " + esc(x.titre || "Finances") + "</b><br><small>" + esc(x.agent) + " · " + dateCourte(x.horodatage) + "</small>";
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
      b.onclick = function () { ouvrirBDC(S.aCorriger[+b.getAttribute("data-planif")].donnees.id); };
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
    var bandeau = "<div style='margin-top:8px;padding:8px 10px;border-radius:10px;font-size:13px;background:" + (document.body.classList.contains("clair") ? (nAtt ? "#fff4e0" : "#f1ede7") : (nAtt ? "#3a2f1a" : "#2a2826")) + "'>" +
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
    html = html.replace("</head>", (document.body.classList.contains("clair") ? "<style>:root{color-scheme:only light}</style>" : STYLE_SOMBRE_LOT.replace("<style>", "<style>:root{color-scheme:only dark}")) + "</head>");
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
    planifFM: planifFM,
    planifRetenir: function (b, sc, r) { return planifRetenir(b, sc, r); },
    fermerFM: function () { if (PL.id) ouvrirBDCPC(PL.id, "lignes"); else if (FM_OUVERT) ouvrirSaisieBDC(FM_OUVERT); else montrer("vueAccueil"); },
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
      return attendre(reponse, (it.type === "planif" || it.type === "rh" || it.type === "com" || it.type === "mis" ? DELAI_PLANIF : DELAI_ENVOI) + 5000).catch(function () { return null; }).then(function (r) {
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
      var ageFi = S.fin ? Date.now() - S.fin.recu : Infinity;
      var p4 = (S.url && droitFin() && (forcerDonnees || n > 0 || ageFi > 5 * 60000)) ? rafraichirFin().catch(function () {}) : null;
      var ageRh = S.rh ? Date.now() - S.rh.recu : Infinity;
      var p5 = (S.url && droitRH() && (forcerDonnees || n > 0 || ageRh > 5 * 60000)) ? rafraichirRH().catch(function () {}) : null;
      var ageCo = S.com ? Date.now() - S.com.recu : Infinity;
      var p6 = (S.url && droitCom() && (forcerDonnees || n > 0 || ageCo > 5 * 60000)) ? rafraichirCom().catch(function () {}) : null;
      var ageMi = S.mis ? Date.now() - S.mis.recu : Infinity;
      var p7 = (S.url && droitMis() && (forcerDonnees || n > 0 || ageMi > 5 * 60000)) ? rafraichirMis().catch(function () {}) : null;
      var ageSt = S.stockv ? Date.now() - S.stockv.recu : Infinity;
      var p8 = (S.url && droitStockVal() && (forcerDonnees || n > 0 || ageSt > 5 * 60000)) ? rafraichirStockVal().catch(function () {}) : null;
      return Promise.all([p1, p2, p3, p4, p5, p6, p7, p8]);
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
      if (it.type === "mis") corps = { api: "misEnvoyer", agent: it.agent, code: it.code, op: it.op, jeton: it.jeton, horodatage: String(it.horodatage), donnees: it.donnees };
      else if (it.type === "com") corps = { api: "comEnvoyer", agent: it.agent, code: it.code, op: it.op, jeton: it.jeton, horodatage: String(it.horodatage), donnees: it.donnees };
      else if (it.type === "rh") corps = { api: "rhEnvoyer", agent: it.agent, code: it.code, op: it.op, jeton: it.jeton, horodatage: String(it.horodatage), donnees: it.donnees };
      else if (it.type === "fin") corps = { api: "finEnvoyer", agent: it.agent, code: it.code, op: it.op, jeton: it.jeton, horodatage: String(it.horodatage), donnees: it.donnees };
      else if (it.type === "planif") corps = { api: "planifEnvoyer", agent: it.agent, code: it.code, op: it.op, jeton: it.jeton, horodatage: String(it.horodatage), donnees: it.donnees };
      else if (it.type === "form") corps = { api: "repondre", agent: it.agent, code: it.code, formulaire: it.form, jeton: it.jeton, horodatage: String(it.horodatage), reponses: it.reponses };
      else { corps = { api: "declarer" }; for (var k in it.o) corps[k] = it.o[k]; }
      return requete(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(corps), redirect: "follow" }, it.type === "planif" || it.type === "fin" || it.type === "rh" || it.type === "com" || it.type === "mis" ? DELAI_PLANIF : DELAI_ENVOI)
        .then(function (r) {
          S.derniereSync = Date.now(); ecrire("derniereSync", S.derniereSync);
          if (r && r.appareilRefus) { it.essais--; it.erreur = "en attente du code de connexion (DG)"; return sauver().then(function () { return n; }); }   // gardé : repart après le code
          if (erreurPassagere(r) && it.essais < 6) { it.erreur = r.message; return sauver().then(function () { return n; }); }
          S.file.shift();
          resultats[it.jeton] = r;
          if (attenteJetons[it.jeton]) attenteJetons[it.jeton](r);
          if (r.ok) { if (it.o) { S.envoyes.push({ jeton: it.jeton, o: it.o, recuA: Date.now() }); n++; } else if (it.type === "planif" || it.type === "fin" || it.type === "rh" || it.type === "com" || it.type === "mis") n++; }
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
      // Feuilles mères encore en file d'attente : gardées telles que saisies sur cet appareil.
      S.file.forEach(function (it) {
        if (it.type !== "planif" || (it.op !== "feuilleMere" && it.op !== "supprimerFM")) return;
        var b = r.bdcs.filter(function (y) { return y.libelle === it.donnees.bdc; })[0]; if (!b) return;
        var k = String(it.op === "feuilleMere" ? it.donnees.x.nom : it.donnees.nom).toLowerCase();
        b.feuillesMeres = (b.feuillesMeres || []).filter(function (f) { return f.nom.toLowerCase() !== k; });
        if (it.op === "feuilleMere") { var x = it.donnees.x; b.feuillesMeres.push({ nom: x.nom, papier: x.papier, machine: x.machine, format: x.format, total: x.total, types: x.types, donnees: x.donnees, quand: "⏳ sur cet appareil" }); }
      });
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
      Array.prototype.forEach.call($("plListe").querySelectorAll("[data-bdc]"), function (el) { el.onclick = function () { ouvrirBDC(el.getAttribute("data-bdc")); }; });
    }
    $("plCherche").oninput = liste; liste();
  }

  function ouvrirSaisieBDC(id, o) {
    o = o || {};
    var b = bdcPlanif(id); if (!b) return;
    if (!o.cible && modePC()) { ouvrirBDCPC(id, "lignes"); return; }
    var loc = S.planifLocal[id], src = loc || { lignes: b.lignes, commun: b.commun, papCommun: b.papCommun };
    var PAP = (S.planif.papiers || []);
    function opt(v) { var o = "<option value=''>—</option>", ok = false; PAP.forEach(function (x) { o += "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; if (x === v) ok = true; }); if (v && !ok) o += "<option selected>" + esc(v) + "</option>"; return o; }
    if (!o.cible) $("titre").textContent = "Saisie BDC";
    var h = "<div class='carte'>" + (o.cible ? "" : "<h3>" + esc(b.libelle) + "</h3><div class='info'>" + esc(b.client || "") + " · " + esc(b.statut || "") +
      (b.qteGlobale !== "" && b.qteGlobale != null ? " · Qté globale " + Number(b.qteGlobale).toLocaleString("fr-FR") : "") + "</div>") +
      (loc ? "<div class='carte att' style='margin-top:8px'>⏳ Votre saisie du " + dateCourte(loc.quand) + " " + (enAttentePlanif(id) ? "attend l'envoi." : "est envoyée ; ⟳ pour voir l'état du serveur.") + "</div>" : "") +
      (o.cible ? "" : "<button class='bouton second' id='sbFM'>🧱 Feuille mère" + ((b.feuillesMeres || []).length ? " (" + b.feuillesMeres.length + ")" : "") + "</button>" +
      "<button class='bouton second' id='sbScen'>🧩 Scénarios de montage</button>" +
      (scenEnAttente(b.libelle) ? "<div class='carte att' style='margin-top:8px'>⏳ Scénario retenu sur cet appareil : " + esc(scenEnAttente(b.libelle).titre) + " — attend l'envoi.</div>" : "") +
      htmlPublication(b)) +
      (o.table ? "<div class='ligne pcCommun'><div><label>Format fini commun (mm, L×H)</label><input id='sbFmt' placeholder='100x150' value='" + esc(src.commun) + "'></div>" +
                 "<div><label>Papier commun</label><select id='sbPap'>" + opt(src.papCommun) + "</select></div>" +
                 "<div><label>Feuillets / carnet pour tous</label><div class='ligne'><input id='sbFc' inputmode='numeric' placeholder='25'><button class='bouton second' id='sbFcOk' style='margin-top:6px'>Appliquer</button></div></div></div></div>" +
                 "<div class='carte'><div class='info'>Astuce : copiez des lignes depuis Excel (Nom, Qté, N° départ, Abrév., Format, Feuillets/carnet, Stock fini) et collez-les dans une case « Article ».</div>" +
                 "<div class='tabPC'><table class='grilleBDC'><thead><tr><th>Article (nom sur BDC)</th><th>Qté BDC</th><th>N° départ</th><th>Abrév.</th><th>Format</th><th>F./carnet</th><th>Stock fini</th><th>Papier (si diff.)</th><th>Comp.</th><th></th></tr></thead><tbody id='sbLignes'></tbody></table></div>" +
                 "<button class='bouton second' id='sbAjout' style='width:auto;display:inline-block;padding:8px 16px'>➕ Ligne</button></div>"
              : "<label>Format fini commun (mm, L×H)</label><input id='sbFmt' placeholder='100x150' value='" + esc(src.commun) + "'>" +
                "<label>Papier commun</label><select id='sbPap'>" + opt(src.papCommun) + "</select>" +
                "<label>Feuillets / carnet pour tous (sauf composants)</label><div class='ligne'><input id='sbFc' inputmode='numeric' placeholder='25'><button class='bouton second' id='sbFcOk' style='margin-top:6px'>Appliquer</button></div></div>" +
                "<div id='sbLignes'></div><button class='bouton second' id='sbAjout'>➕ Ligne</button>") +
      "<div class='carte' id='sbTotal'></div><div class='carte' id='sbConf' style='display:none'></div>" +
      "<button class='bouton second' id='sbEnr'>💾 Enregistrer</button><button class='bouton' id='sbEnv'>✅ Enregistrer et envoyer dans Statut Prod</button>" +
      "<div id='sbMsg' class='info' style='margin-top:8px;white-space:pre-line'></div>";
    if (o.cible) o.cible.innerHTML = h; else { $("vueListe").innerHTML = h; montrer("vueListe"); }
    function carte(l) {
      l = l || {}; var comp = /\(composant\)\s*$/i.test(l.nom || ""), nom = String(l.nom || "").replace(/\s*\(composant\)\s*$/i, "");
      if (o.table) {
        // PC / tablette : une ligne de tableau (mêmes classes que les cartes → même lecture).
        var tr = document.createElement("tr"); tr.className = "sbL";
        tr.innerHTML = "<td><input class='nm' value='" + esc(nom) + "'></td><td><input class='q' inputmode='decimal' value='" + esc(l.qte) + "'></td>" +
          "<td><input class='dp' inputmode='numeric' value='" + esc(l.depart) + "'></td><td><input class='ab' value='" + esc(l.abr) + "'></td>" +
          "<td><input class='fm' placeholder='LxH' value='" + esc(l.fmt) + "'></td><td><input class='fc' inputmode='numeric' placeholder='1' value='" + esc(l.fc) + "'></td>" +
          "<td><input class='sf' inputmode='numeric' placeholder='0' value='" + esc(l.sf) + "'></td><td><select class='pp'>" + opt(l.pap) + "</select></td>" +
          "<td style='text-align:center'><input type='checkbox' class='cp' title='Composant (non facturé)'" + (comp ? " checked" : "") + "></td>" +
          "<td><button class='lien' style='color:#ff8a80;font-size:18px' title='Supprimer'>✖</button>" + (l.etat ? "<div class='info' style='font-size:11px'>" + esc(l.etat) + "</div>" : "") + "</td>";
        tr.querySelector(".lien").onclick = function () { tr.remove(); total(); };
        tr.querySelector(".q").oninput = total; tr.querySelector(".cp").onchange = total;
        tr.querySelector(".nm").addEventListener("paste", function (e) {
          var t = (e.clipboardData || window.clipboardData).getData("text");
          if (!/[\t\n]/.test(t)) return;
          e.preventDefault();
          var rows = t.replace(/\r/g, "").split("\n").filter(function (x) { return x.trim(); }), cls = ["nm", "q", "dp", "ab", "fm", "fc", "sf"], cur = tr;
          rows.forEach(function (r, i) {
            if (i > 0) { carte({}); cur = $("sbLignes").lastChild; }
            r.split("\t").forEach(function (v, j) { if (cls[j]) cur.querySelector("." + cls[j]).value = v.trim(); });
          });
          total();
        });
        $("sbLignes").appendChild(tr);
        return;
      }
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
    if ($("sbFM")) $("sbFM").onclick = function () { ouvrirFeuilleMere(b.id); };
    if ($("sbScen")) $("sbScen").onclick = function () { ouvrirScenarios(b.id); };
    if ($("pubGo")) $("pubGo").onclick = function () { publierCoches(b); };
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

  /* ---------- Feuille mère (éditeur du script, exécuté dans l'app, hors ligne) ---------- */
  var SHIM_FM = "<script>(function(){function mk(s,f){return{withSuccessHandler:function(x){return mk(x,f);},withFailureHandler:function(y){return mk(s,y);}," +
    "enregistrerFeuilleMere:function(b,x){parent.ATELIER.planifFM('enregistrer',b,x).then(s,function(e){if(f)f(e);});}," +
    "supprimerFeuilleMere:function(b,n){parent.ATELIER.planifFM('supprimer',b,n).then(s,function(e){if(f)f(e);});}};}" +
    "window.google={script:{run:mk(null,null),host:{close:function(){parent.ATELIER.fermerFM();}}}};})();<\/script>";
  var FM_OUVERT = null;
  function ouvrirFeuilleMere(id) {
    var b = bdcPlanif(id), P = S.planif;
    if (!b) return;
    if (!P.editeurFM) { alert("Éditeur indisponible : synchronisez (⟳) avec réseau."); return; }
    if (!(b.groupes || []).length) { alert("Aucun format fini pour ce BDC dans Statut Prod : enregistrez et envoyez d'abord la saisie BDC dans Statut Prod (format fini commun ou par ligne)."); return; }
    var ctx = { bdc: b.libelle, formats: b.groupes, machines: P.machines || [], papiers: P.papiersMontage || [], enreg: b.feuillesMeres || [],
                machinesEtapes: P.machinesEtapes || [], etapes: P.etapesPlanche || [], couleurs: P.couleurs || [], papierB5: "" };
    var html = P.editeurFM.replace("<?!= donnees ?>", JSON.stringify(ctx).replace(/</g, "\\u003c"));
    FM_OUVERT = b.id;
    var cadreFM = PL.id ? $("plCadre") : $("cadre");
    if (!PL.id) { montrer("vueLot"); $("titre").textContent = "Feuille mère"; }
    cadreFM.srcdoc = "<!DOCTYPE html><html lang='fr'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>" +
      "<style>html,body{background:#fff;color:#222}body{overflow-x:auto}</style>" + SHIM_FM + "</head><body>" +
      "<div style='margin:6px 0 10px;padding:6px 8px;background:#e8f0fe;border-radius:6px;font:13px Arial'>🗂️ <b>" + esc(b.libelle) + "</b> — les enregistrements partent à la synchronisation (hors ligne possible).</div>" +
      html + "</body></html>";
  }
  // Appelé par l'éditeur (google.script.run simulé) : mise à jour locale + file d'attente.
  function planifFM(action, bdcLib, x) {
    var b = ((S.planif && S.planif.bdcs) || []).filter(function (y) { return y.libelle === bdcLib; })[0];
    if (!b) return Promise.reject(new Error("BDC introuvable sur cet appareil : synchronisez (⟳)."));
    b.feuillesMeres = b.feuillesMeres || [];
    var nom = action === "enregistrer" ? x.nom : x, k = String(nom).toLowerCase();
    var ex = b.feuillesMeres.filter(function (f) { return f.nom.toLowerCase() === k; })[0];
    var ancien = ex ? (ex.quand === "⏳ sur cet appareil" ? "local" : ex.quand) : "";
    b.feuillesMeres = b.feuillesMeres.filter(function (f) { return f.nom.toLowerCase() !== k; });
    if (action === "enregistrer") b.feuillesMeres.push({ nom: x.nom, papier: x.papier, machine: x.machine, format: x.format, total: x.total, types: x.types, donnees: x.donnees, quand: "⏳ sur cet appareil" });
    ecrire("planif", S.planif);
    var it = { type: "planif", op: action === "enregistrer" ? "feuilleMere" : "supprimerFM", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code,
               donnees: action === "enregistrer" ? { id: b.id, bdc: b.libelle, x: x, ancienQuand: ancien } : { id: b.id, bdc: b.libelle, nom: nom, ancienQuand: ancien },
               titre: action === "enregistrer" ? "Feuille mère « " + nom + " »" : "Suppression feuille mère « " + nom + " »", resume: b.libelle, essais: 0 };
    soumettre(it).then(function (r) { if (r && !r.enAttente && !r.ok) alert("⛔ " + r.titre + "\n" + r.message); });
    return Promise.resolve({ enreg: b.feuillesMeres, message: "« " + nom + " » " + (action === "enregistrer" ? "enregistrée" : "supprimée") +
      " sur cet appareil. Envoi au serveur en cours (ou à la prochaine connexion) — suivez « En attente » / « À corriger »." });
  }

  /* ---------- Deux affichages : Téléphone (suivi, publication) / PC-tablette (espace de travail) ---------- */
  var PL = { id: null, onglet: "lignes" };
  /* Mode jour / nuit : bouton ☀️ / 🌙 de l'en-tête, gardé sur l'appareil. */
  function appliquerTheme(clair) {
    document.body.classList.toggle("clair", !!clair); document.documentElement.classList.toggle("clair", !!clair);
    if ($("metaScheme")) $("metaScheme").content = clair ? "only light" : "only dark";   // le navigateur ne doit pas changer le thème tout seul
    if ($("choixTheme")) $("choixTheme").value = clair ? "clair" : "sombre";
    if ($("btnTheme")) { $("btnTheme").textContent = clair ? "🌙" : "☀️"; $("btnTheme").title = clair ? "Passer en mode nuit" : "Passer en mode jour"; }
    try { localStorage.setItem("duocoreTheme", clair ? "clair" : "sombre"); } catch (e) {}
  }
  setTimeout(function () {
    appliquerTheme(document.body.classList.contains("clair"));
    if ($("choixTheme")) $("choixTheme").onchange = function () { appliquerTheme(this.value === "clair"); };
    if ($("btnTheme")) $("btnTheme").onclick = function () {
      appliquerTheme(!document.body.classList.contains("clair"));
      if (S.lotOuvert && $("vueLot").style.display !== "none") ouvrirLot(S.lotOuvert.bdc, S.lotOuvert.cle, true);   // page du lot redessinée
    };
  }, 0);
  /* Affichage PC : classe sur <body>, et mise en page de chaque écran (liste en grille, formulaire, fiche). */
  function majClassePC() { document.body.classList.toggle("pc", modePC()); misePagePC(); }
  var SEL_CARTES = ".carte[data-no],.carte[data-ev],.carte[data-n],.carte[data-ct],.carte[data-fa],.carte[data-cl],.carte[data-mi],.carte[data-fo]";
  function misePagePC() {
    var v = $("vueListe"); if (!v) return;
    v.classList.remove("formulaire", "fiche");
    if (!document.body.classList.contains("pc")) return;
    // Conteneurs dont au moins deux enfants sont des cartes cliquables → grille.
    var parents = [];
    Array.prototype.forEach.call(v.querySelectorAll(SEL_CARTES), function (c) { var p = c.parentNode; if (parents.indexOf(p) < 0) parents.push(p); });
    var grille = false;
    parents.forEach(function (p) {
      var n = Array.prototype.filter.call(p.children, function (c) { return c.matches(SEL_CARTES); }).length;
      if (n >= 2 && p !== v) { p.classList.add("gl"); grille = true; }
    });
    if (grille) return;
    var champs = v.querySelectorAll("input:not([type=checkbox]):not([type=file]):not([type=radio]),select,textarea").length;
    if (champs >= 3 && v.children.length <= 2) v.classList.add("formulaire");
    else if (v.children.length >= 3) v.classList.add("fiche");
  }
  if (window.MutationObserver) setTimeout(function () {
    var v = $("vueListe"), t = null;
    if (v) new MutationObserver(function () { clearTimeout(t); t = setTimeout(misePagePC, 0); }).observe(v, { childList: true, subtree: true });
  }, 0);
  window.addEventListener("resize", function () { clearTimeout(window.__rpc); window.__rpc = setTimeout(majClassePC, 150); });
  function modePC() { var a = S.affichage || "auto"; return a === "pc" || (a === "auto" && Math.min(window.innerWidth, 4000) >= 760); }
  function ouvrirBDC(id, onglet) { if (modePC()) { if (!PL.actif) afficherPlanifPC(id, onglet); else ouvrirBDCPC(id, onglet || "lignes"); } else ouvrirSuiviBDC(id); }

  // Téléphone : consultation du BDC + publication ; la saisie se fait sur PC / tablette.
  function ouvrirSuiviBDC(id) {
    var b = bdcPlanif(id); if (!b) return;
    var loc = S.planifLocal[id], L = (loc ? loc.lignes : b.lignes) || [];
    $("titre").textContent = "Suivi BDC";
    var h = "<div class='carte'><h3>" + esc(b.libelle) + "</h3><div class='info'>" + esc(b.client || "") + " · " + esc(b.statut || "") + "</div>" +
      (loc ? "<div class='carte att' style='margin-top:8px'>⏳ Saisie du " + dateCourte(loc.quand) + (enAttentePlanif(id) ? " en attente d'envoi." : " envoyée.") + "</div>" : "") + "</div>" +
      "<div class='carte'><h3>📝 Lignes (" + L.length + ")</h3><table>" + L.map(function (l) {
        return "<tr><td>" + esc(l.abr || "—") + "</td><td style='font-size:13px'>" + esc(l.nom) + "</td><td class='v'>" + esc(l.qte) + "</td></tr>"; }).join("") + "</table></div>" +
      "<div class='carte'><h3>🧱 Feuilles mères</h3><div class='info'>" + ((b.feuillesMeres || []).map(function (f) { return esc(f.nom) + " (" + esc(f.quand || "") + ")"; }).join("<br>") || "Aucune") + "</div></div>" +
      (scenEnAttente(b.libelle) ? "<div class='carte att'>⏳ " + esc(scenEnAttente(b.libelle).titre) + " — attend l'envoi.</div>" : "") +
      htmlPublication(b) +
      "<div id='telFiches'></div>" +
      "<div class='carte info'>Saisie des lignes, feuilles mères et scénarios : sur PC / tablette (ou Réglages › Affichage › PC / tablette).</div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    afficherFiches(b, $("telFiches"), false);
    if ($("pubGo")) $("pubGo").onclick = function () { publierCoches(b); };
  }

  // PC / tablette : liste des BDC à gauche, BDC ouvert à droite avec onglets.
  function afficherPlanifPC(id, onglet) {
    var P = S.planif;
    $("titre").textContent = "Planification";
    if (!P) { $("vueListe").innerHTML = "<div class='carte'><h3>Planification</h3><p class='info'>Aucune donnée : connectez-vous au réseau puis appuyez sur ⟳.</p></div>"; montrer("vueListe"); return; }
    montrer("vuePlanif");
    $("plGauche").innerHTML = "<input id='plCherchePC' placeholder='Rechercher un BDC, un client…'><div class='info' style='margin:6px 2px'>" + P.bdcs.length + " BDC · données du " + dateCourte(P.genere) + "</div><div id='plListePC'></div>";
    function liste() {
      var q = $("plCherchePC").value.trim().toLowerCase();
      $("plListePC").innerHTML = P.bdcs.filter(function (b) { return !q || (b.libelle + " " + b.client + " " + b.statut).toLowerCase().indexOf(q) !== -1; }).map(function (b) {
        var att = enAttentePlanif(b.id), T = b.tirages || [], nPub = T.filter(function (t) { return /publi/i.test(t.statut || ""); }).length;
        return "<div class='plItem" + (PL.id === b.id ? " sel" : "") + "' data-bdc='" + esc(b.id) + "'><b>" + esc(b.libelle) + "</b><div class='info'>" + esc(b.client || "—") + " · " + esc(b.statut || "—") +
          "<br>" + b.lignes.length + " ligne(s) · " + (b.feuillesMeres || []).length + " f. mère(s)" + (T.length ? " · " + nPub + "/" + T.length + " publiée(s)" : "") + (att ? " · ⏳" : "") + "</div></div>";
      }).join("") || "<p class='info'>Aucun BDC.</p>";
      Array.prototype.forEach.call($("plListePC").querySelectorAll("[data-bdc]"), function (el) { el.onclick = function () { ouvrirBDCPC(el.getAttribute("data-bdc"), PL.onglet === "fiches" ? "fiches" : "lignes"); }; });
    }
    $("plCherchePC").oninput = liste;
    PL.liste = liste;
    if (id) ouvrirBDCPC(id, onglet || "lignes");
    else { PL.id = null; liste(); $("plEntete").innerHTML = ""; $("plC").innerHTML = "<div class='carte info'>Choisissez un BDC à gauche.</div>"; $("plC").style.display = "block"; $("plCadre").style.display = "none"; }
  }
  function ouvrirBDCPC(id, onglet) {
    var b = bdcPlanif(id); if (!b) return;
    if (!PL.actif) { afficherPlanifPC(id, onglet); return; }
    PL.id = id; PL.onglet = onglet || "lignes"; FM_OUVERT = id;
    if (PL.liste) PL.liste();
    var O = [["lignes", "📝 Lignes"], ["fm", "🧱 Feuilles mères" + ((b.feuillesMeres || []).length ? " (" + b.feuillesMeres.length + ")" : "")], ["scen", "🧩 Scénarios"], ["publication", "📤 Publication"], ["fiches", "🧾 Fiches"]];
    $("plEntete").innerHTML = "<div class='plTitre'><b>" + esc(b.libelle) + "</b> <span class='info'>" + esc(b.client || "") + " · " + esc(b.statut || "") +
      (b.qteGlobale !== "" && b.qteGlobale != null ? " · Qté globale " + Number(b.qteGlobale).toLocaleString("fr-FR") : "") + "</span></div>" +
      "<div class='onglets'>" + O.map(function (x) { return "<button data-o='" + x[0] + "' class='" + (x[0] === PL.onglet ? "actif" : "") + "'>" + x[1] + "</button>"; }).join("") + "</div>";
    Array.prototype.forEach.call($("plEntete").querySelectorAll("[data-o]"), function (bt) { bt.onclick = function () { ouvrirBDCPC(id, bt.getAttribute("data-o")); }; });
    var C = $("plC"), F = $("plCadre");
    var cadre = PL.onglet === "fm" || PL.onglet === "scen";
    C.style.display = cadre ? "none" : "block"; F.style.display = cadre ? "block" : "none";
    if (!cadre) F.srcdoc = "";
    C.scrollTop = 0;
    if (PL.onglet === "lignes") ouvrirSaisieBDC(id, { cible: C, table: true });
    else if (PL.onglet === "fm") ouvrirFeuilleMere(id);
    else if (PL.onglet === "scen") ouvrirScenarios(id);
    else if (PL.onglet === "publication") {
      C.innerHTML = (scenEnAttente(b.libelle) ? "<div class='carte att'>⏳ " + esc(scenEnAttente(b.libelle).titre) + " — attend l'envoi.</div>" : "") +
        (htmlPublication(b) || "<div class='carte info'>Aucune imposition retenue : lancez les scénarios (onglet 🧩) puis « Retenir ».</div>");
      if ($("pubGo")) $("pubGo").onclick = function () { publierCoches(b); };
    } else afficherFiches(b, C, true);
    // Feuille mère / scénarios indisponibles : on revient sur les lignes.
    if (cadre && !F.srcdoc) { C.style.display = "block"; F.style.display = "none"; C.innerHTML = "<div class='carte info'>Onglet indisponible pour l'instant (voir le message). Complétez les étapes précédentes ou synchronisez (⟳).</div>"; }
  }

  /* ---------- Finances : demandes, validations (Walid puis DG), preuves ---------- */
  function droitFin() { return !!(S.agent && S.formulaires && S.formulaires.droits && S.formulaires.droits.finances); }
  var rafFin = null;
  function rafraichirFin() {
    if (!S.url || !droitFin()) return Promise.resolve();
    if (rafFin) return rafFin;
    rafFin = api({ api: "finances" }).then(function (r) { r.recu = Date.now(); S.fin = r; return ecrire("fin", r); })
      .then(function () { rafFin = null; }, function (e) { rafFin = null; throw e; });
    return rafFin;
  }
  function gnf(v) { return Math.round(+v || 0).toLocaleString("fr-FR"); }
  function finAttente(no) { return S.file.filter(function (x) { return x.type === "fin" && x.donnees && (x.donnees.no === no || (x.donnees.demande && x.donnees.demande.no === no)); }); }
  function finATraiter(d) {
    var F = S.fin, role = F && F.role;
    if (finAttente(d.no).length) return false;
    if (role && ((d.statut === "En attente Walid" && role === "Walid") || (d.statut === "En attente DG" && role === "DG"))) return true;
    if (d.demandeur === F.auto && d.statut === "À exécuter" && (role || F.comptable || F.rh)) return true;
    return d.demandeur === (S.agent && S.agent.nom) && (d.statut === "À corriger" || d.statut === "À exécuter");
  }
  function finNbATraiter() { return S.fin ? S.fin.demandes.filter(finATraiter).length : 0; }
  var COUL_ST = { "En attente Walid": "#e65100", "En attente DG": "#e65100", "À corriger": "#b26a00", "Refusée": "#c62828", "Validée": "#2e7d32", "À exécuter": "#1565c0", "Exécutée": "#2e7d32", "Annulée": "#777" };
  function statutFin(d) { return d.solde && d.statut === "Validée" ? (d.solde.reste <= 0 ? "Soldée" : d.solde.regle > 0 ? "Partiellement payée" : "Validée — à payer") : d.statut; }
  function libelleFin(d) { return d.type === "Mouvement de trésorerie" || d.type === "Opération constatée" ? d.op : d.type === "Paiement RH" ? (S.fin && d.demandeur === S.fin.auto ? "Salaire · " : "Paie RH · ") + d.personnel : d.type; }
  var FIN = { filtre: "traiter" };
  function afficherFinances(no) {
    $("titre").textContent = "Finances";
    var F = S.fin;
    if (!F) {
      $("vueListe").innerHTML = "<div class='carte'><h3>💰 Finances</h3><p class='info'>Aucune donnée sur cet appareil : réseau puis ⟳.</p></div>"; montrer("vueListe");
      rafraichirFin().then(function () { if (S.fin) afficherFinances(no); }).catch(function () {});
      return;
    }
    if (no) { ouvrirDemandeFin(no); return; }
    var nouv = S.file.filter(function (x) { return x.type === "fin" && x.op === "creer"; });
    var h = "<div class='carte'><h3>💰 Finances</h3><div class='info'>" + esc(F.agent) + (F.role ? " · valideur " + esc(F.role) : F.comptable ? " · comptable (lecture)" : "") + " · données du " + dateCourte(F.recu || F.genere) + "</div>" +
      "<div class='ligne'><button class='bouton' id='fnNouv'>➕ Nouvelle demande</button><button class='bouton second' id='fnFour'>🏭 Fournisseurs</button></div>" +
      (F.role || F.comptable ? "<div class='ligne'><button class='bouton second' id='fnSol'>📊 Soldes</button><button class='bouton second' id='fnIc'>🔁 Inter-sociétés</button><button class='bouton second' id='fnExp'>📤 Export du mois</button></div>" : "") +
      (F.suiviAchat || F.comptable ? "<button class='bouton second' id='fnAch'>📦 Suivi des achats (" + ((F.achat && F.achat.ouverts) || []).length + ")</button>" : "") +
      "<div class='onglets' style='margin-top:10px'>" + [["traiter", "À traiter (" + finNbATraiter() + ")"], ["miennes", "Mes demandes"]].concat(F.role || F.comptable ? [["toutes", "Toutes"]] : [])
        .map(function (o) { return "<button data-f='" + o[0] + "' class='" + (FIN.filtre === o[0] ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + o[1] + "</button>"; }).join("") + "</div>" +
      "<input id='fnCherche' placeholder='Rechercher (n°, fournisseur, objet…)' style='margin-top:8px'></div>" +
      (nouv.length ? "<div class='carte att'>⏳ " + nouv.length + " nouvelle(s) demande(s) sur cet appareil, en attente d'envoi.</div>" : "") +
      "<div id='fnListe'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    function liste() {
      var q = $("fnCherche").value.trim().toLowerCase(), moi = S.agent.nom;
      var L = F.demandes.filter(function (d) {
        if (FIN.filtre === "traiter" && !finATraiter(d)) return false;
        if (FIN.filtre === "miennes" && d.demandeur !== moi) return false;
        return !q || (d.no + " " + d.type + " " + d.op + " " + d.fournisseur + " " + d.objet + " " + d.refFacture + " " + d.demandeur).toLowerCase().indexOf(q) >= 0;
      }).sort(function (a, b) { return b.date - a.date; });
      $("fnListe").innerHTML = L.map(function (d) {
        var att = finAttente(d.no).length;
        return "<div class='carte" + (att ? " att" : "") + "' data-no='" + esc(d.no) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + esc(d.no) + " · " + esc(libelleFin(d)) + "</b>" +
          "<b style='flex:0;white-space:nowrap'>" + gnf(d.montant) + " " + esc(d.devise) + "</b></div>" +
          "<div class='info'>" + esc(d.fournisseur || d.objet || d.compte || "") + (d.pourCompte ? " · <b>pour " + esc(d.pourCompte) + "</b>" : "") + " · " + esc(d.demandeur) + " · " + dateCourte(d.date) + "</div>" +
          "<div style='color:" + (COUL_ST[d.statut] || "#999") + ";font-weight:700;font-size:14px'>" + esc(statutFin(d)) + (att ? " · ⏳ action en attente d'envoi" : "") +
          (d.solde ? " · reste " + gnf(d.solde.reste) + " GNF" : "") + "</div></div>";
      }).join("") || "<p class='info' style='padding:0 4px'>Rien ici.</p>";
      Array.prototype.forEach.call($("fnListe").querySelectorAll("[data-no]"), function (el) { el.onclick = function () { ouvrirDemandeFin(el.getAttribute("data-no")); }; });
    }
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-f]"), function (b) { b.onclick = function () { FIN.filtre = b.getAttribute("data-f"); afficherFinances(); }; });
    $("fnCherche").oninput = liste; liste();
    $("fnNouv").onclick = function () { formulaireFin(null); };
    $("fnFour").onclick = afficherFournisseurs;
    if ($("fnAch")) $("fnAch").onclick = function () { afficherSuiviAchats(); };
    if ($("fnSol")) $("fnSol").onclick = function () { afficherSoldes("fournisseurs"); };
    if ($("fnExp")) $("fnExp").onclick = exporterFin;
    if ($("fnIc")) $("fnIc").onclick = afficherInterco;
  }

  // Pièce : image affichée, PDF ouvert ; gardée en mémoire le temps de la session.
  var PIECES = {};
  function voirPiece(no, p, cible) {
    var aff = function (o) {
      var url = URL.createObjectURL(o);
      if (p.type === "pdf") { window.open(url, "_blank"); return; }
      cible.innerHTML = "<img src='" + url + "' style='max-width:100%;border-radius:8px;margin-top:8px'>";
    };
    if (PIECES[p.id]) { aff(PIECES[p.id]); return; }
    cible.innerHTML = "<div class='info'>⏳ Chargement…</div>";
    api({ api: "finPiece", no: no, id: p.id }, 120000).then(function (r) {
      var bin = atob(r.data), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      PIECES[p.id] = new Blob([u], { type: r.mime || (p.type === "pdf" ? "application/pdf" : "image/jpeg") }); cible.innerHTML = ""; aff(PIECES[p.id]);
    }, function (e) { cible.innerHTML = "<div class='info'>⛔ " + esc(e.message) + " (réseau nécessaire pour voir les pièces)</div>"; });
  }
  function htmlPieces(d, liste, titre, k) {
    if (!liste.length) return "";
    return "<div class='carte'><h3>" + titre + "</h3>" + liste.map(function (p, i) {
      return "<button class='bouton second' data-p='" + k + i + "' style='display:inline-block;width:auto;padding:8px 12px;margin-right:6px'>" + (p.type === "pdf" ? "📄 " : "🖼️ ") + esc(p.nom.replace(d.no + " ", "")) + "</button>";
    }).join("") + "<div id='pv" + k + "'></div></div>";
  }
  function ouvrirDemandeFin(no) {
    var F = S.fin, d = F && F.demandes.filter(function (x) { return x.no === no; })[0];
    if (!d) { afficherFinances(); return; }
    $("titre").textContent = d.no;
    var moi = S.agent.nom, att = finAttente(no), role = F.role;
    function ligne(l, v) { return v ? "<tr><td>" + l + "</td><td class='v' style='white-space:normal'>" + v + "</td></tr>" : ""; }
    function trace(t, r) { return t ? (t.d === "valider" ? "✅" : t.d === "refuser" ? "⛔" : "✏️") + " " + esc(t.a) + " · " + dateCourte(t.q) + (t.c ? " — " + esc(t.c) : "") : "<span class='info'>en attente</span>"; }
    var h = "<div class='carte'><h3>" + esc(d.no) + " · " + esc(libelleFin(d)) + "</h3>" +
      "<div style='color:" + (COUL_ST[d.statut] || "#999") + ";font-weight:700'>" + esc(statutFin(d)) + "</div>" +
      (att.length ? "<div class='carte att'>⏳ " + esc(att[0].titre) + " — en attente d'envoi.</div>" : "") +
      "<table>" + ligne("Montant", "<b>" + gnf(d.montant) + " " + esc(d.devise) + "</b>" + (d.devise !== "GNF" ? (d.taux ? "<br><small>taux " + gnf(d.taux) + " → " + gnf(d.gnf) + " GNF</small>" : "<br><small>montant dans la devise du salaire ; compte et taux choisis au paiement</small>") : "")) +
      ligne("Fournisseur", esc(d.fournisseur)) + ligne("Facture", d.facture ? esc(d.facture) : d.refFacture ? "Réf. " + esc(d.refFacture) : "") +
      ligne("Objet", esc(d.objet)) + ligne("Mode", esc(d.mode)) + ligne("Compte", esc(d.compte) + (d.contrepartie ? " → " + esc(d.contrepartie) : "")) +
      ligne("Personnel", esc(d.personnel) + (d.motifRH ? " · " + esc(d.motifRH) : "")) +
      ligne("Achat", d.achat ? esc(d.achat.nature + " · " + (d.achat.article || d.achat.designation || (d.achat.articles || []).join(", ")) + (d.achat.quantite ? " · qté " + d.achat.quantite : "")) + (d.achatId ? " [" + esc(d.achatId) + "]" : "") : "") +
      ligne("Pour le compte de", d.pourCompte ? "<b>" + esc(d.pourCompte) + "</b> (dette envers " + esc(d.societe) + ")" : "") + ligne("Bénéficiaire", esc(d.beneficiaire)) + ligne("Catégorie", esc(d.categorie)) + ligne(d.type === "Paiement RH" ? "Équivalent" : "Reçu", d.recu ? gnf(d.recu) + " " + esc(d.deviseRecue) : "") +
      ligne("Mois", d.dateEffet ? moisLib(d.dateEffet) : "") +
      ligne("Base", d.ligneBase ? "ligne " + esc(d.ligneBase) : "") + ligne("Société", esc(d.societe)) + ligne("Échéance", d.echeance ? dateCourte(d.echeance).split(" ")[0] : "") +
      ligne("Demandeur", esc(d.demandeur) + " · " + dateCourte(d.date)) +
      (d.solde ? ligne("Réglé / reste", gnf(d.solde.regle) + " / <b>" + gnf(d.solde.reste) + " GNF</b>" + (d.solde.engage ? "<br><small>dont " + gnf(d.solde.engage) + " en cours</small>" : "")) : "") +
      ligne("Walid", trace(d.walid)) + (d.validations.indexOf("DG") >= 0 ? ligne("DG", trace(d.dg)) : "") + "</table></div>" +
      htmlPieces(d, d.pieces, "Pièces", "P") + htmlPieces(d, d.preuves, "Preuves", "R") +
      "<div class='carte'><h3>Historique</h3>" + d.historique.map(function (x) { return "<div class='info'>" + dateCourte(x.q) + " · " + esc(x.a) + " · " + esc(x.act) + (x.c ? " — " + esc(x.c) : "") + "</div>"; }).join("") + "</div>" +
      "<div id='fnActions'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-p]"), function (b) {
      b.onclick = function () { var k = b.getAttribute("data-p"), src = k.charAt(0) === "R" ? d.preuves : d.pieces;
        voirPiece(d.no, src[+k.substring(1)], $("pv" + k.charAt(0))); };
    });
    if (att.length) return;
    var A = $("fnActions"), peutValider = (d.statut === "En attente Walid" && role === "Walid") || (d.statut === "En attente DG" && role === "DG");
    if (peutValider) {
      A.innerHTML = "<div class='carte'><h3>Votre décision</h3><label>Commentaire (obligatoire pour refuser ou faire corriger)</label><textarea id='fnCom' rows='2'></textarea>" +
        "<button class='bouton' id='fnVal' style='background:var(--vert)'>✅ Valider</button><button class='bouton alerte' id='fnCor'>✏️ À corriger</button><button class='bouton' id='fnRef' style='background:var(--rouge)'>⛔ Refuser</button><div id='fnMsg' class='info'></div></div>";
      [["fnVal", "valider"], ["fnCor", "corriger"], ["fnRef", "refuser"]].forEach(function (x) {
        $(x[0]).onclick = function () {
          var com = $("fnCom").value.trim();
          if (x[1] !== "valider" && !com) { $("fnMsg").textContent = "⛔ Commentaire obligatoire."; return; }
          if (x[1] !== "valider" && !confirm((x[1] === "refuser" ? "Refuser " : "Renvoyer pour correction ") + d.no + " ?")) return;
          envoyerFin("decider", { no: d.no, version: d.version, decision: x[1], commentaire: com }, (x[1] === "valider" ? "Validation " : x[1] === "refuser" ? "Refus " : "Correction ") + d.no, d.no);
        };
      });
    } else if (d.statut === "À exécuter" && (d.demandeur === moi || role || (d.demandeur === F.auto && (F.comptable || F.rh)))) {
      var auto = d.demandeur === F.auto;
      // Salaire automatique : mode, compte payeur et, si sa devise diffère de celle du salaire, montant payé et taux.
      A.innerHTML = "<div class='carte'><h3>Paiement effectué</h3>" +
        (auto ? "<div class='ligne'><div><label>Mode</label><select id='fnPm'><option" + (d.beneficiaire ? "" : " selected") + ">Espèces</option><option" + (d.beneficiaire ? " selected" : "") + ">Virement</option></select></div>" +
          "<div style='flex:2'><label>Compte payeur</label><select id='fnPc'></select></div></div>" +
          "<div id='fnPmB'><label id='fnPmL'>Montant payé</label><input id='fnPmt' inputmode='decimal'></div><div id='fnPtB'><label>Taux (1 unité = … GNF)</label><input id='fnPt' inputmode='decimal'></div>" +
          "<div class='info' id='fnPi'></div>" : "") +
        "<div class='info'>" + (d.type === "Dépense de caisse" ? "Justificatif facultatif." : "Photo de la preuve obligatoire : reçu, talon de chèque, avis de virement…") + "</div>" +
        champFichiers("fnPr") + "<label>Commentaire</label><input id='fnCom'><button class='bouton' id='fnExe'>🧾 Clôturer : paiement effectué</button><div id='fnMsg' class='info'></div></div>";
      lierFichiers("fnPr");
      function nbx(x) { x = String(x || "").replace(/[\s  ]/g, "").replace(",", "."); return parseFloat(x) || 0; }
      function cptP() { return F.comptes.filter(function (c) { return c.nom === $("fnPc").value; })[0]; }
      function majP() {
        var esp = $("fnPm").value === "Espèces", cur = $("fnPc").value;
        $("fnPc").innerHTML = "<option value=''>— choisir —</option>" + F.comptes.filter(function (c) { return c.type === (esp ? "Caisse" : "Banque"); })
          .map(function (c) { return "<option" + (c.nom === cur ? " selected" : "") + ">" + esc(c.nom) + "</option>"; }).join("");
        var c = cptP(), dev = c ? c.devise : d.devise;
        $("fnPmB").style.display = c && dev !== d.devise ? "" : "none"; $("fnPmL").textContent = "Montant payé en " + dev;
        $("fnPtB").style.display = c && dev !== "GNF" ? "" : "none";
        $("fnPi").textContent = "Net à payer : " + gnf(d.montant) + " " + d.devise + (c && dev !== d.devise ? " — payé en " + dev + " (le net reste l'équivalent pour le Journal RH)" : "");
      }
      if (auto) { $("fnPm").onchange = majP; $("fnPc").onchange = majP; majP(); }
      $("fnExe").onclick = function () {
        var f = FICH.fnPr || [], x = { no: d.no, version: d.version, commentaire: $("fnCom").value.trim(), fichiers: f };
        if (auto) {
          var c = cptP();
          if (!c) { $("fnMsg").textContent = "⛔ Choisissez le compte payeur."; return; }
          x.paiement = { mode: $("fnPm").value, compte: c.nom, montant: c.devise !== d.devise ? nbx($("fnPmt").value) : d.montant, taux: c.devise !== "GNF" ? nbx($("fnPt").value) : 1 };
          if (!(x.paiement.montant > 0)) { $("fnMsg").textContent = "⛔ Indiquez le montant payé."; return; }
          if (!(x.paiement.taux > 0)) { $("fnMsg").textContent = "⛔ Indiquez le taux."; return; }
        }
        if (!f.length && d.type !== "Dépense de caisse") { $("fnMsg").textContent = "⛔ Ajoutez la photo de la preuve."; return; }
        envoyerFin("executer", x, "Paiement " + d.no, d.no);
      };
    } else if ((d.demandeur === moi || (d.demandeur === F.auto && role)) && ["En attente Walid", "En attente DG", "À corriger"].indexOf(d.statut) >= 0) {
      A.innerHTML = "<div class='carte'>" + (d.statut === "À corriger" && d.demandeur === moi ? "<button class='bouton' id='fnMod'>✏️ Corriger et renvoyer</button>" : "") +
        "<button class='bouton second' id='fnAnn'>Annuler la demande</button></div>";
      if ($("fnMod")) $("fnMod").onclick = function () { formulaireFin(d); };
      $("fnAnn").onclick = function () { if (confirm("Annuler " + d.no + " ?")) envoyerFin("annuler", { no: d.no, version: d.version }, "Annulation " + d.no, d.no); };
    }
  }
  function envoyerFin(op, donnees, titre, retour) {
    var it = { type: "fin", op: op, jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: donnees, titre: titre, resume: "Finances", essais: 0 };
    soumettre(it).then(function (r) {
      if (r.ok && !r.enAttente) return rafraichirFin().catch(function () {}).then(function () { alert("✅ " + r.titre + (r.message ? "\n" + r.message : "")); if (r.no || retour) ouvrirDemandeFin(r.no || retour); else afficherFinances(); });
      alert((r.enAttente ? "📥 " : "⛔ ") + (r.titre || "") + "\n" + (r.message || ""));
      if (retour && S.fin.demandes.some(function (x) { return x.no === retour; })) ouvrirDemandeFin(retour); else afficherFinances();
    });
  }

  // Photos (compressées) et PDF : [{nom, type, data base64}]
  var FICH = {};
  function champFichiers(id) {
    return "<label>Photos / PDF</label><div class='ligne'><button class='bouton second' id='" + id + "Ph' style='margin-top:6px'>📷 Photo</button><button class='bouton second' id='" + id + "Fi' style='margin-top:6px'>📎 Fichier</button></div>" +
      "<input type='file' id='" + id + "InPh' accept='image/*' capture='environment' style='display:none'><input type='file' id='" + id + "InFi' accept='image/*,application/pdf' multiple style='display:none'>" +
      "<div id='" + id + "Li' class='info'></div>";
  }
  function compresser(file) {
    return new Promise(function (ok, ko) {
      var rd = new FileReader();
      rd.onerror = function () { ko(new Error("lecture impossible")); };
      if (/pdf/i.test(file.type)) {
        if (file.size > 6e6) { ko(new Error("PDF trop lourd (6 Mo max)")); return; }
        rd.onload = function () { ok({ nom: file.name, type: "application/pdf", data: String(rd.result).split(",")[1] }); }; rd.readAsDataURL(file); return;
      }
      rd.onload = function () {
        var im = new Image();
        im.onload = function () {
          var k = Math.min(1, 1600 / Math.max(im.width, im.height)), c = document.createElement("canvas");
          c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
          ok({ nom: file.name || "photo.jpg", type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.72).split(",")[1] });
        };
        im.onerror = function () { ko(new Error("image illisible")); };
        im.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
  }
  function lierFichiers(id) {
    FICH[id] = [];
    function maj() { $(id + "Li").innerHTML = FICH[id].map(function (f, i) { return "• " + esc(f.nom) + " (" + Math.round(f.data.length * 0.75 / 1024) + " Ko) <button class='lien' data-x='" + i + "'>retirer</button>"; }).join("<br>");
      Array.prototype.forEach.call($(id + "Li").querySelectorAll("[data-x]"), function (b) { b.onclick = function () { FICH[id].splice(+b.getAttribute("data-x"), 1); maj(); }; }); }
    function prendre(inp) { Promise.all(Array.prototype.map.call(inp.files, compresser)).then(function (L) { FICH[id] = FICH[id].concat(L); inp.value = ""; maj(); }, function (e) { alert("⛔ " + e.message); }); }
    $(id + "Ph").onclick = function () { $(id + "InPh").click(); }; $(id + "Fi").onclick = function () { $(id + "InFi").click(); };
    $(id + "InPh").onchange = function () { prendre(this); }; $(id + "InFi").onchange = function () { prendre(this); };
  }

  // Nouvelle demande (ou correction d'une demande « À corriger »).
  function formulaireFin(src) {
    var F = S.fin; src = src || {};
    var A0 = src.achat || {}, AC = F.achat || { categories: [], articles: {}, ouverts: [], typesFrais: [] };
    $("titre").textContent = src.no ? "Corriger " + src.no : "Nouvelle demande";
    function opts(L, v, vide) { return (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { return "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; }).join(""); }
    var types = F.types.filter(function (t) { return t !== "Opération constatée" || F.role || F.comptable; });
    var fourActifs = F.fournisseurs.filter(function (f) { return f.actif !== false; }), raisonsF = [];
    fourActifs.forEach(function (f) { if (raisonsF.indexOf(fourRaison(f)) < 0) raisonsF.push(fourRaison(f)); }); raisonsF.sort();
    var fourSrc = src.fournisseur ? F.fournisseurs.filter(function (f) { return f.nom.toLowerCase() === String(src.fournisseur).toLowerCase(); })[0] : null;
    function comptesDe(r) { return F.fournisseurs.filter(function (f) { return fourRaison(f).toLowerCase() === String(r).trim().toLowerCase() && (f.actif !== false || (fourSrc && f.nom === fourSrc.nom)); })
      .sort(function (a, b) { return (a.societe || a.projet ? 1 : 0) - (b.societe || b.projet ? 1 : 0) || a.nom.localeCompare(b.nom); }); }
    function compteChoisi() { var C = comptesDe(v("ffFour")); return C.length ? v("ffFourC") : v("ffFour").trim(); }
    var h = "<div class='carte'><label>Type</label><select id='ffType'>" + opts(types, src.type || "Règlement fournisseur") + "</select>" +
      "<div id='ffOpB'><label>Mouvement</label><select id='ffOp'>" + opts(F.opsBanque, src.type === "Mouvement de trésorerie" ? src.op : "", "— choisir —") + "</select></div>" +
      "<div id='ffOcB'><label>Opération constatée (sans validation)</label><select id='ffOc'>" + opts(F.opsConstatees || [], src.type === "Opération constatée" ? src.op : "", "— choisir —") + "</select></div>" +
      "<div class='ligne'><div><label>Société (payeuse)</label><select id='ffSoc'>" + opts(["AB", "M2S"], src.societe || "AB") + "</select></div>" +
      "<div id='ffPcB'><label>Pour le compte de</label><select id='ffPc'><option value=''>— elle-même —</option>" + (F.pourCompte || ["CASAFINO"]).map(function (x) { return "<option" + (x === src.pourCompte ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select></div></div>" +
      "<div id='ffRhB'><div class='ligne'><div><label>Personnel</label><select id='ffPers'>" + opts(F.personnel || [], src.personnel, "— choisir —") + "</select></div>" +
      "<div><label>Motif</label><select id='ffMotRH'>" + opts(F.motifsRH || [], src.motifRH, "— choisir —") + "</select></div></div>" +
      "<div id='ffMoisB'><label>Mois du salaire</label><input id='ffMois' type='month' value='" + (src.dateEffet ? new Date(src.dateEffet).toISOString().slice(0, 7) : "") + "'></div></div>" +
      "<div id='ffFourB'><label>Fournisseur</label><input id='ffFour' list='ffFourL' value='" + esc(fourSrc ? fourRaison(fourSrc) : src.fournisseur || "") + "' placeholder='Nom (nouveau : créé avec un compte général)'>" +
      "<datalist id='ffFourL'>" + raisonsF.map(function (r) { return "<option value='" + esc(r) + "'>"; }).join("") + "</datalist>" +
      "<div id='ffFourCB'><label>Compte du fournisseur</label><select id='ffFourC'></select></div><div id='ffFourI' class='info'></div>" +
      "<div id='ffNouvF' style='display:none'><div class='ligne'><div><label>Téléphone</label><input id='ffTel'></div><div><label>NIF</label><input id='ffNif'></div></div><label>RIB / compte</label><input id='ffRib'></div></div>" +
      "<div id='ffFactB'><label>Facture à régler</label><select id='ffFact'></select><div id='ffFactI' class='info'></div></div>" +
      "<div id='ffRefB'><label>Réf. de la facture</label><input id='ffRef' value='" + esc(src.refFacture || "") + "'><label>Échéance</label><input id='ffEch' type='date' value='" + (src.echeance ? new Date(src.echeance).toISOString().slice(0, 10) : "") + "'></div>" +
      "<label>Objet</label><input id='ffObj' value='" + esc(src.objet || "") + "'>" +
      "<div id='ffModeB'><label>Mode de paiement</label><select id='ffMode'></select></div>" +
      "<div class='ligne' id='ffCptB'><div><label id='ffCptL'>Compte</label><select id='ffCpt'></select></div><div id='ffCtpB'><label id='ffCtpL'>Vers</label><select id='ffCtp'></select></div></div>" +
      "<div class='ligne'><div style='flex:2'><label>Montant</label><input id='ffMt' inputmode='decimal' value='" + esc(src.montant || "") + "'></div><div><label>Devise</label><select id='ffDev'>" + opts(["GNF", "USD", "EURO", "TND"], src.devise || "GNF") + "</select></div></div>" +
      "<div id='ffTauxB'><label>Taux (1 unité = … GNF)</label><input id='ffTaux' inputmode='decimal' value='" + esc(src.taux && src.devise !== "GNF" ? src.taux : "") + "'></div>" +
      "<div id='ffGnf' class='info'></div>" +
      "<div id='ffChqI' class='info'>Chèque client (recouvrement) : à déclarer en COMMERCIAL › Recouvrement, pas ici.</div>" +
      "<div id='ffRecuB'><label id='ffRecuL'>Montant reçu</label><input id='ffRecu' inputmode='decimal' value='" + esc(src.recu || "") + "'></div>" +
      "<div id='ffEqB'><label id='ffEqL'>Équivalent</label><input id='ffEq' inputmode='decimal' value='" + esc(src.type === "Paiement RH" && src.recu ? src.recu : "") + "'></div>" +
      "<div id='ffCatB'><label>Catégorie (trésorerie)</label><select id='ffCat'>" + opts(F.categories || [], src.categorie, "— choisir —") + "</select></div>" +
      // Achat d'article (Fourniture Locale / Importée) → Suivi Achats
      "<div id='ffAchB' class='carte' style='margin-top:10px'><h3>📦 Achat (Suivi Achats)</h3>" +
      "<label>Nature</label><select id='ffAN'>" + opts(["Article existant", "Nouvel article", "Frais"], A0.nature, "— choisir —") + "</select>" +
      "<div id='ffAEx'><div class='ligne'><div><label>Catégorie d'article</label><select id='ffACat'>" + opts(AC.categories, A0.categorie, "— choisir —") + "</select></div>" +
      "<div style='flex:2'><label>Article</label><select id='ffAArt'></select></div></div></div>" +
      "<div id='ffANv'><label>Désignation du nouvel article</label><input id='ffADes' value='" + esc(A0.designation || "") + "'>" +
      "<label>Catégorie du nouvel article</label><select id='ffACatN'>" + opts(AC.categories, A0.catNouvel, "— choisir —") + "</select>" +
      "<div id='ffAPap' class='ligne'><div><label>Format Y (mm)</label><input id='ffAY' inputmode='numeric' value='" + esc((A0.carac || {}).y || "") + "'></div><div><label>Format X (mm)</label><input id='ffAX' inputmode='numeric' value='" + esc((A0.carac || {}).x || "") + "'></div></div>" +
      "<div id='ffAEnc'><label>Kg par boîte</label><input id='ffAKg' value='" + esc((A0.carac || {}).kg || "") + "'></div>" +
      "<div id='ffAPla' class='ligne'><div><label>Unités / rouleau</label><input id='ffAU' value='" + esc((A0.carac || {}).unites || "") + "'></div><div><label>Mètres / rouleau</label><input id='ffAM' value='" + esc((A0.carac || {}).metres || "") + "'></div></div></div>" +
      "<div id='ffAQt' class='ligne'><div><label>Quantité commandée</label><input id='ffAQ' inputmode='decimal' value='" + esc(A0.quantite || "") + "'></div><div><label>Expéditeur</label><input id='ffAExp' value='" + esc(A0.expediteur || "") + "'></div></div>" +
      "<div id='ffAFr'><label>Type de frais</label><select id='ffATF'>" + opts(AC.typesFrais || [], A0.typeFrais, "— choisir —") + "</select>" +
      "<label>Articles concernés (le frais est réparti au prorata)</label><div id='ffAOuv'>" + (AC.ouverts.length ? AC.ouverts.map(function (o, i) {
        return "<label style='font-weight:400'><input type='checkbox' class='ffAO' value='" + esc(o.libelle) + "' style='width:auto'" + ((A0.articles || []).indexOf(o.libelle) >= 0 ? " checked" : "") + "> " + esc(o.libelle) + "</label>"; }).join("") : "<div class='info'>Aucun achat ouvert.</div>") + "</div></div>" +
      "<div id='ffAFact' class='info'></div></div>" +
      "<div id='ffBenB'><label>Bénéficiaire du chèque / virement</label><input id='ffBen' value='" + esc(src.beneficiaire || "") + "'></div>" +
      champFichiers("ffP") + (src.pieces && src.pieces.length ? "<div class='info'>Déjà jointes : " + src.pieces.length + " pièce(s).</div>" : "") +
      "<div id='ffRegle' class='carte' style='margin-top:10px'></div>" +
      "<label>Commentaire</label><input id='ffCom'>" +
      "<button class='bouton' id='ffEnv'>📤 Envoyer</button><div id='ffMsg' class='info' style='white-space:pre-line'></div></div>";
    $("vueListe").innerHTML = h; montrer("vueListe"); lierFichiers("ffP");
    function v(id) { return $(id).value.trim(); }
    function nb(x) { x = String(x || "").replace(/[\s  ]/g, "").replace(",", "."); return parseFloat(x) || 0; }
    function vis(id, ok) { $(id).style.display = ok ? "" : "none"; }
    function on(id) { return $(id).style.display !== "none"; }
    var modePrec = src.mode;
    function maj() {
      var t = v("ffType"), op = t === "Mouvement de trésorerie" ? v("ffOp") : t === "Opération constatée" ? v("ffOc") : "", dev = v("ffDev");
      vis("ffOpB", t === "Mouvement de trésorerie"); vis("ffOcB", t === "Opération constatée"); vis("ffRhB", t === "Paiement RH");
      vis("ffFourB", t === "Facture d'achat" || t === "Règlement fournisseur" || t === "Dépense de caisse");
      $("ffFourB").querySelector("label").textContent = t === "Dépense de caisse" ? "Fournisseur / prestataire (facultatif, pour son compte)" : "Fournisseur";
      vis("ffFactB", t === "Règlement fournisseur"); vis("ffRefB", t === "Facture d'achat");
      // Modes de paiement selon le type.
      var modes = t === "Règlement fournisseur" ? ["Espèces", "Chèque", "Virement"] : t === "Paiement RH" ? ["Espèces", "Virement"] : [];
      vis("ffModeB", modes.length);
      var curM = $("ffMode").value || modePrec || ""; $("ffMode").innerHTML = opts(modes, curM, "— choisir —"); modePrec = "";
      var mode = v("ffMode");
      // Comptes possibles : source (débitée) → destination (créditée) ; devise = celle du compte.
      var CA = F.comptes.filter(function (c) { return c.type === "Caisse"; }), BA = F.comptes.filter(function (c) { return c.type === "Banque"; });
      var srcL = CA.concat(BA), dstL = null, lS = "Compte", lD = "Vers";
      if (t === "Dépense de caisse" || ((t === "Règlement fournisseur" || t === "Paiement RH") && mode === "Espèces")) { srcL = CA; lS = "Caisse"; }
      else if (t === "Règlement fournisseur" || t === "Paiement RH" || t === "Opération constatée") { srcL = BA; lS = "Compte bancaire"; }
      else if (t === "Mouvement de trésorerie") {
        if (op === "Retrait") { srcL = BA; dstL = CA; lS = "Compte du chèque"; lD = "Vers la caisse"; }
        else if (op === "Versement") { srcL = CA; dstL = BA; lS = "Depuis la caisse"; lD = "Vers le compte bancaire"; }
        else if (op === "Virement") { srcL = BA; dstL = BA; lS = "Depuis le compte"; lD = "Vers le compte (ou bénéficiaire)"; }
        else if (op === "Dépôt de chèque") { srcL = BA; dstL = BA; lS = "Chèque tiré sur"; lD = "Déposé sur"; }
        else if (op === "Transfert entre caisses") { srcL = CA; dstL = CA; lS = "Depuis la caisse"; lD = "Vers la caisse"; }
        else if (op === F.opRemb) { srcL = F.comptes.filter(function (c) { return ["AB", "M2S", "CASAFINO"].indexOf(c.societe) >= 0; }); dstL = srcL; lS = "Depuis un compte de la société qui rembourse"; lD = "Vers un compte de la société remboursée"; }
      }
      function remplir(id, L, val, vide) { var cur = $(id).value || val || ""; $(id).innerHTML = (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (c) { return "<option" + (c.nom === cur ? " selected" : "") + ">" + esc(c.nom) + "</option>"; }).join(""); }
      remplir("ffCpt", srcL, src.compte, "— choisir —"); remplir("ffCtp", dstL || [], src.contrepartie, op === "Virement" ? "— bénéficiaire externe —" : "— choisir —");
      $("ffCptL").textContent = lS; $("ffCtpL").textContent = lD;
      vis("ffCptB", t !== "Facture d'achat"); vis("ffCtpB", !!dstL);
      var cpt = F.comptes.filter(function (c) { return c.nom === v("ffCpt"); })[0], dst = F.comptes.filter(function (c) { return c.nom === v("ffCtp"); })[0];
      if (cpt && cpt.devise) { $("ffDev").value = cpt.devise; $("ffDev").disabled = true; dev = cpt.devise; } else $("ffDev").disabled = false;
      var devR = dst && dst.devise && dst.devise !== dev ? dst.devise : "";
      vis("ffChqI", t === "Mouvement de trésorerie" && op === "Dépôt de chèque");
      vis("ffRecuB", !!devR); $("ffRecuL").textContent = "Montant reçu sur " + (dst ? dst.nom : "") + " (" + devR + ")";
      // Paie RH : mois du salaire ; équivalent dans la devise du salaire si le compte est dans une autre devise.
      var mot = v("ffMotRH"), devSal = t === "Paiement RH" ? (F.devisesPersonnel || {})[v("ffPers")] || "" : "";
      vis("ffMoisB", t === "Paiement RH" && mot === "SALAIRE (RH)");
      vis("ffEqB", !!devSal && devSal !== dev && ["SALAIRE (RH)", "AVANCE (RH)", "PRIME SUR SALAIRE (RH)"].indexOf(mot) >= 0);
      $("ffEqL").textContent = "Équivalent en " + devSal + " (devise du salaire de " + v("ffPers") + ")";
      vis("ffBenB", (t === "Règlement fournisseur" && mode && mode !== "Espèces") || (t === "Mouvement de trésorerie" && op === "Virement" && !v("ffCtp")));
      vis("ffTauxB", dev !== "GNF");
      var Cf = comptesDe(v("ffFour")), curC = $("ffFourC").value || (fourSrc ? fourSrc.nom : "");
      if (Cf.map(function (c) { return c.nom; }).join("|") !== $("ffFourC").getAttribute("data-l")) {
        $("ffFourC").innerHTML = Cf.map(function (c) { return "<option value='" + esc(c.nom) + "'" + (c.nom === curC ? " selected" : "") + ">" + esc(fourLibCompte(c)) + "</option>"; }).join("");
        $("ffFourC").setAttribute("data-l", Cf.map(function (c) { return c.nom; }).join("|"));
      }
      vis("ffFourCB", on("ffFourB") && Cf.length > 0);
      var four = compteChoisi(), fc = F.fournisseurs.filter(function (f) { return f.nom.toLowerCase() === four.toLowerCase(); })[0], connu = !!fc;
      vis("ffNouvF", on("ffFourB") && four && !connu);
      // Société payeuse : libre (c'est le règlement qui choisit la source). Compte d'une société bénéficiaire payé par une autre → « pour le compte de » imposé (🔁 Inter-sociétés).
      $("ffSoc").disabled = false;
      vis("ffPcB", t === "Facture d'achat" || (t === "Règlement fournisseur" && !v("ffFact")) || t === "Dépense de caisse");
      if (fc && fc.societe && on("ffFourB")) { $("ffPc").value = fc.societe === v("ffSoc") ? "" : fc.societe; $("ffPc").disabled = true; }
      else { if (v("ffPc") === v("ffSoc")) $("ffPc").value = ""; $("ffPc").disabled = false; }
      var mtF = nb(v("ffMt"));
      if (fc && fc.article && on("ffCatB") && !v("ffCat") && (F.categories || []).indexOf(fc.article) >= 0) $("ffCat").value = fc.article;
      $("ffFourI").textContent = fc ? [fc.societe ? "bénéficiaire " + fc.societe : "toutes sociétés", fc.projet ? "projet " + fc.projet : "",
          fc.tva ? "assujetti TVA 18 %" + (mtF > 0 && t !== "Mouvement de trésorerie" ? " (HT " + gnf(Math.round(mtF / 1.18)) + " + TVA " + gnf(mtF - Math.round(mtF / 1.18)) + " " + v("ffDev") + ")" : "") : "",
          v("ffPc") && on("ffPcB") ? "payé par " + v("ffSoc") + " pour " + v("ffPc") + " → dette en 🔁 Inter-sociétés" : ""].filter(String).join(" · ")
        : four && on("ffFourB") ? "Nouveau fournisseur : il sera créé avec un compte général (comptes par société / projet dans 🏭 Fournisseurs)." : "";
      var fa = null;
      if (t === "Règlement fournisseur") {
        var nomsC = Cf.map(function (c) { return c.nom.toLowerCase(); });
        var Fa = F.factures.filter(function (f) { return !v("ffFour").trim() || (nomsC.length ? nomsC.indexOf(f.fournisseur.toLowerCase()) >= 0 : f.fournisseur.toLowerCase() === four.toLowerCase()); }), cur = $("ffFact").value || src.facture || "";
        $("ffFact").innerHTML = "<option value=''>Sans facture (avance)</option>" + Fa.map(function (f) { return "<option value='" + esc(f.no) + "'" + (f.no === cur ? " selected" : "") + ">" + esc(f.no + " · " + f.fournisseur + (f.ref ? " · " + f.ref : "") + " · reste " + gnf(f.reste - f.engage) + " GNF") + "</option>"; }).join("");
        fa = Fa.filter(function (f) { return f.no === $("ffFact").value; })[0] || null;
        if (fa && Cf.some(function (c) { return c.nom === fa.fournisseur; })) $("ffFourC").value = fa.fournisseur;   // le règlement va sur le compte de la facture
        $("ffFactI").textContent = fa ? "Total " + gnf(fa.total) + " GNF · déjà réglé " + gnf(fa.total - fa.reste) + " · en cours " + gnf(fa.engage) + " · disponible " + gnf(fa.reste - fa.engage) + " GNF (règlement par tranches possible)" +
          (fa.categorie ? " · catégorie " + fa.categorie + (fa.achat ? " (achat d'article de la facture)" : "") : "") : "";
      }
      // Catégorie : imposée pour les mouvements internes et la paie ; reprise de la facture réglée.
      var catAuto = (t === "Mouvement de trésorerie" && !(op === "Virement" && !v("ffCtp"))) || t === "Paiement RH" || (t === "Opération constatée" && op === "Credit bancaire") || (fa && fa.categorie);
      vis("ffCatB", !catAuto);
      var cat = on("ffCatB") ? v("ffCat") : fa ? fa.categorie : "";
      // Bloc achat : catégorie Fourniture (sauf règlement d'une facture qui porte déjà l'achat).
      vis("ffAchB", on("ffCatB") && (cat === "Fourniture Locale" || cat === "Fourniture Importee") && t !== "Opération constatée" && !(on("ffPcB") && v("ffPc") === "CASAFINO"));
      if (on("ffAchB")) {
        var n = v("ffAN"); vis("ffAEx", n === "Article existant"); vis("ffANv", n === "Nouvel article"); vis("ffAQt", n === "Article existant" || n === "Nouvel article"); vis("ffAFr", n === "Frais");
        var ca = v("ffACat"), artCur = $("ffAArt").value || A0.article || "";
        $("ffAArt").innerHTML = opts((AC.articles || {})[ca] || [], artCur, "— choisir —");
        var cn = v("ffACatN"); vis("ffAPap", cn === "PAPIER"); vis("ffAEnc", /ENCRE/.test(cn)); vis("ffAPla", cn === "PLATINE");
        $("ffAFact").textContent = t === "Facture d'achat" ? "Les détails de l'article servent au 1er règlement de cette facture ; les tranches suivantes s'ajoutent à son coût." : "";
      }
      var g = nb(v("ffMt")) * (dev === "GNF" ? 1 : nb(v("ffTaux")));
      $("ffGnf").textContent = dev !== "GNF" && g ? "= " + gnf(g) + " GNF" : "";
      // Règle de validation (aperçu ; le serveur décide).
      var gros = g >= (F.seuil || 5000000), regle;
      if (t === "Opération constatée") regle = "aucune (constatée, inscrite directement)";
      else regle = t === "Facture d'achat" || (t === "Dépense de caisse" && gros) || (t === "Règlement fournisseur" && !((mode === "Espèces" || mode === "Chèque") && !gros)) ||
        (t === "Paiement RH" && !(mode === "Espèces" && !gros)) || (t === "Mouvement de trésorerie" && !((op === "Dépôt de chèque" || op === "Transfert entre caisses" || op === F.opRemb) && !gros)) ? "Walid puis DG" : "Walid";
      var photo = t === "Facture d'achat" ? "photo de la facture obligatoire" : (t === "Règlement fournisseur" && mode === "Chèque") || (t === "Mouvement de trésorerie" && (op === "Dépôt de chèque" || op === "Retrait")) ? "photo du chèque obligatoire" : "pièces facultatives";
      $("ffRegle").innerHTML = "🔐 Validation : <b>" + regle + "</b> · 📷 " + photo + (t !== "Facture d'achat" && t !== "Opération constatée" ? " · preuve du paiement à joindre après validation" + (t === "Dépense de caisse" ? " (facultative)" : "") : "");
      $("ffEnv").textContent = t === "Opération constatée" ? "📒 Enregistrer" : "📤 Envoyer la demande";
    }
    ["ffType", "ffOp", "ffOc", "ffDev", "ffSoc", "ffPc", "ffFourC", "ffMode", "ffFact", "ffCpt", "ffCtp", "ffCat", "ffAN", "ffACat", "ffACatN", "ffPers", "ffMotRH"].forEach(function (id) { $(id).onchange = maj; });
    ["ffMt", "ffTaux", "ffFour"].forEach(function (id) { $(id).oninput = maj; });
    maj();
    $("ffEnv").onclick = function () {
      var t = v("ffType"), m = $("ffMsg"), op = t === "Mouvement de trésorerie" ? v("ffOp") : t === "Opération constatée" ? v("ffOc") : "";
      var s = { no: src.no, type: t, op: op, societe: v("ffSoc"), pourCompte: on("ffPcB") ? v("ffPc") : "", fournisseur: on("ffFourB") ? compteChoisi() : "", facture: t === "Règlement fournisseur" ? v("ffFact") : "",
        refFacture: t === "Facture d'achat" ? v("ffRef") : "", echeance: t === "Facture d'achat" ? v("ffEch") : "", objet: v("ffObj"), montant: nb(v("ffMt")), devise: v("ffDev"), taux: nb(v("ffTaux")),
        mode: on("ffModeB") ? v("ffMode") : t === "Dépense de caisse" ? "Espèces" : "", compte: t === "Facture d'achat" ? "" : v("ffCpt"), contrepartie: on("ffCtpB") ? v("ffCtp") : "",
        beneficiaire: on("ffBenB") ? v("ffBen") : "", commentaire: v("ffCom"), personnel: t === "Paiement RH" ? v("ffPers") : "", motifRH: t === "Paiement RH" ? v("ffMotRH") : "",
        categorie: on("ffCatB") ? v("ffCat") : "", recu: on("ffRecuB") ? nb(v("ffRecu")) : on("ffEqB") ? nb(v("ffEq")) : 0, moisEffet: on("ffMoisB") ? v("ffMois") : "", fourTel: v("ffTel"), fourNif: v("ffNif"), fourRib: v("ffRib") };
      if (on("ffAchB")) s.achat = { nature: v("ffAN"), categorie: v("ffACat"), article: v("ffAArt"), designation: v("ffADes"), catNouvel: v("ffACatN"),
        carac: { y: v("ffAY"), x: v("ffAX"), kg: v("ffAKg"), unites: v("ffAU"), metres: v("ffAM") }, quantite: nb(v("ffAQ")), expediteur: v("ffAExp"), typeFrais: v("ffATF"),
        articles: Array.prototype.filter.call(document.querySelectorAll(".ffAO"), function (c) { return c.checked; }).map(function (c) { return c.value; }) };
      var A = s.achat;
      var err = t === "Paiement RH" && !s.personnel ? "personnel" : t === "Paiement RH" && !s.motifRH ? "motif RH" : on("ffModeB") && !s.mode ? "mode de paiement" :
        !s.compte && t !== "Facture d'achat" ? "compte" : on("ffCatB") && !s.categorie && t !== "Facture d'achat" ? "catégorie" : on("ffRecuB") && !(s.recu > 0) ? "montant reçu" : on("ffEqB") && !(s.recu > 0) ? "équivalent dans la devise du salaire" : on("ffMoisB") && !s.moisEffet ? "mois du salaire" :
        on("ffCtpB") && !s.contrepartie && !(op === "Virement" && s.beneficiaire) ? "compte de destination" : !(s.montant > 0) ? "montant" : s.devise !== "GNF" && !(s.taux > 0) ? "taux de change" :
        (t === "Mouvement de trésorerie" || t === "Opération constatée") && !op ? "opération" : (t === "Facture d'achat" || t === "Règlement fournisseur") && !s.fournisseur ? "fournisseur" :
        A && !A.nature ? "nature de l'achat" : A && A.nature === "Article existant" && !A.article ? "article acheté" : A && A.nature === "Nouvel article" && !(A.designation && A.catNouvel) ? "nouvel article (désignation et catégorie)" :
        A && A.nature !== "Frais" && !(A.quantite > 0) ? "quantité commandée" : A && A.nature === "Frais" && !A.articles.length ? "article concerné par le frais" : "";
      if (err) { m.textContent = "⛔ Indiquez : " + err + "."; return; }
      var nbP = (FICH.ffP || []).length + ((src.pieces || []).length);
      if (/obligatoire/.test($("ffRegle").textContent) && !nbP) { m.textContent = "⛔ Photo obligatoire (voir ci-dessus)."; return; }
      var lib = (op || t) + (t === "Paiement RH" ? " · " + s.personnel : "");
      if (!confirm((t === "Opération constatée" ? "Enregistrer : " : "Envoyer la demande : ") + lib + " · " + gnf(s.montant) + " " + s.devise + " ?")) return;
      envoyerFin(src.no ? "modifier" : "creer", src.no ? { demande: s, version: src.version, fichiers: FICH.ffP } : { demande: s, fichiers: FICH.ffP }, (src.no ? "Correction " + src.no : lib) + " · " + gnf(s.montant) + " " + s.devise, src.no);
    };
  }

  // Soldes : fournisseurs (factures, règlements, avances, échéances) et trésorerie (soldes réels de BASE + engagements DuoCore).
  function afficherSoldes(onglet) {
    var F = S.fin, D = F.demandes, now = Date.now();
    $("titre").textContent = "Soldes";
    var h = "<div class='carte'><div class='onglets'>" + [["fournisseurs", "🏭 Fournisseurs"]].map(function (o) {
      return "<button data-s='" + o[0] + "' class='" + (onglet === o[0] ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + o[1] + "</button>"; }).join("") +
      "</div><div class='info' style='margin-top:6px'>Données du " + dateCourte(F.recu || F.genere) + " (⟳ pour actualiser).</div></div>";
    if (onglet === "fournisseurs") {
      var P = {};
      D.forEach(function (d) {
        if (!d.fournisseur) return;
        var f = P[d.fournisseur] = P[d.fournisseur] || { fact: 0, regle: 0, avances: 0, engage: 0, echu: 0, factures: [] };
        if (d.type === "Facture d'achat" && d.solde) {
          f.fact += d.solde.total; f.regle += d.solde.regle; f.engage += d.solde.engage;
          if (d.solde.reste > 0) { f.factures.push(d); if (d.echeance && d.echeance < now) f.echu += d.solde.reste; }
        }
        if (d.type === "Règlement fournisseur" && !d.facture && d.statut === "Exécutée") f.avances += d.gnf;
      });
      var K = Object.keys(P).sort(function (a, b) { return (P[b].fact - P[b].regle) - (P[a].fact - P[a].regle); });
      var tot = K.reduce(function (t, k) { return t + P[k].fact - P[k].regle - P[k].avances; }, 0), totE = K.reduce(function (t, k) { return t + P[k].echu; }, 0);
      h += "<div class='carte'><b>Reste à payer : " + gnf(tot) + " GNF</b>" + (totE ? "<br><span style='color:#c62828;font-weight:700'>dont échu : " + gnf(totE) + " GNF</span>" : "") + "</div>" +
        K.map(function (k) {
          var f = P[k], reste = f.fact - f.regle - f.avances;
          return "<div class='carte'><div class='ligne' style='justify-content:space-between'><b>" + esc(k) + "</b><b style='flex:0;white-space:nowrap'>" + gnf(reste) + " GNF</b></div>" +
            "<div class='info'>Facturé " + gnf(f.fact) + " · réglé " + gnf(f.regle) + (f.avances ? " · avances " + gnf(f.avances) : "") + (f.engage ? " · en cours " + gnf(f.engage) : "") + "</div>" +
            (f.echu ? "<div style='color:#c62828;font-weight:700'>Échu : " + gnf(f.echu) + " GNF</div>" : "") +
            f.factures.map(function (d) { var r = d.echeance && d.echeance < now; return "<div class='info' data-no='" + esc(d.no) + "' style='cursor:pointer" + (r ? ";color:#ff8a80" : "") + "'>• " + esc(d.no) + (d.refFacture ? " · " + esc(d.refFacture) : "") +
              " · reste " + gnf(d.solde.reste) + (d.echeance ? " · échéance " + dateCourte(d.echeance).split(" ")[0] + (r ? " ⚠️" : "") : "") + "</div>"; }).join("") + "</div>";
        }).join("") || "<div class='carte info'>Aucune facture fournisseur.</div>";
    } else {
      var T = F.tresorerie || [], eng = {};
      // Engagements : demandes validées (à exécuter) ou en attente de validation, par compte débité.
      D.forEach(function (d) {
        if (["À exécuter", "En attente Walid", "En attente DG"].indexOf(d.statut) < 0 || !d.compte) return;
        var e = eng[d.compte] = eng[d.compte] || { aExec: 0, attente: 0 };
        if (d.statut === "À exécuter") e.aExec += d.montant; else e.attente += d.montant;
      });
      var G = {}; T.forEach(function (c) { (G[c.groupe] = G[c.groupe] || []).push(c); });
      h += Object.keys(G).map(function (g) {
        return "<div class='carte'><h3>" + esc(g) + "</h3><table>" + G[g].map(function (c) {
          var e = eng[c.compte] || {}, dispo = c.solde - (e.aExec || 0);
          return "<tr><td>" + esc(c.compte) + "<br><small class='info'>" + esc(c.societe) + (e.aExec ? " · à payer " + gnf(e.aExec) : "") + (e.attente ? " · en validation " + gnf(e.attente) : "") + "</small></td>" +
            "<td class='v'>" + gnf(c.solde) + " " + esc(c.devise) + (e.aExec ? "<br><small style='color:" + (dispo < 0 ? "#ff8a80" : "#9ccc65") + "'>après paiements : " + gnf(dispo) + "</small>" : "") + "</td></tr>";
        }).join("") + "</table></div>";
      }).join("") || "<div class='carte info'>Feuille « Tresorerie Disponible » introuvable ou vide.</div>";
    }
    $("vueListe").innerHTML = h; montrer("vueListe");
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-s]"), function (b) { b.onclick = function () { afficherSoldes(b.getAttribute("data-s")); }; });
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-no]"), function (el) { el.onclick = function () { ouvrirDemandeFin(el.getAttribute("data-no")); }; });
  }
  // Export mensuel (réseau) : classeur Drive + fichier .xlsx téléchargé.
  function exporterFin() {
    var d = new Date(), def = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2);
    var mois = prompt("Mois à exporter (AAAA-MM) :", def);
    if (!mois) return;
    if (!/^\d{4}-\d{2}$/.test(mois.trim())) { alert("Format : AAAA-MM (ex. " + def + ")."); return; }
    if (!navigator.onLine) { alert("Export : réseau nécessaire."); return; }
    $("titre").textContent = "Export…";
    api({ api: "finExport", mois: mois.trim() }, 180000).then(function (r) {
      $("titre").textContent = "Finances";
      if (r.xlsx) {
        var bin = atob(r.xlsx), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        var f = new File([u], r.nom, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        if (navigator.canShare && navigator.canShare({ files: [f] }) && confirm("✅ " + r.message + "\nPartager le fichier ? (Annuler = télécharger)")) navigator.share({ files: [f], title: r.nom }).catch(function () {});
        else { var a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = r.nom; document.body.appendChild(a); a.click(); a.remove(); }
      }
      if (confirm("✅ " + r.titre + " : " + r.message + "\nOuvrir aussi le classeur dans Google Drive ?")) window.open(r.url, "_blank");
    }, function (e) { $("titre").textContent = "Finances"; alert("⛔ Export : " + e.message); });
  }

  // Suivi des achats (DG / WALID) : tracking, livraison, statut, entrée en stock → ligne SUIVI ACHAT dans Base.
  function afficherSuiviAchats() {
    var F = S.fin, AC = F.achat || { ouverts: [] };
    $("titre").textContent = "Suivi des achats";
    $("vueListe").innerHTML = "<div class='carte'><h3>📦 Achats en cours</h3><div class='info'>" + AC.ouverts.length + " achat(s) non clôturé(s) · Suivi Achats de BASE.</div></div>" +
      AC.ouverts.map(function (o, i) {
        return "<div class='carte' data-a='" + i + "' style='cursor:pointer'><b>" + esc(o.desig) + "</b> <small>[" + esc(o.id) + "]</small>" +
          "<div class='info'>Qté " + esc(o.qte) + (o.qteLivree ? " · livrée " + esc(o.qteLivree) : "") + (o.tracking ? " · " + esc(o.tracking) : "") + (o.revient ? " · revient " + gnf(o.revient) + " GNF" : "") + "</div>" +
          "<div style='font-weight:700;color:#e65100'>" + esc(o.statut || "Payé") + "</div></div>";
      }).join("");
    montrer("vueListe");
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-a]"), function (el) { el.onclick = function () { majAchat(AC.ouverts[+el.getAttribute("data-a")]); }; });
  }
  function majAchat(o) {
    var F = S.fin, AC = F.achat;
    $("titre").textContent = o.id;
    function opts(L, v, vide) { return (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { return "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; }).join(""); }
    $("vueListe").innerHTML = "<div class='carte'><h3>" + esc(o.desig) + "</h3><div class='info'>Ne remplir que ce qui change.</div>" +
      "<label>Tracking</label><input id='saTr' placeholder='" + esc(o.tracking) + "'>" +
      "<div class='ligne'><div><label>Date de livraison</label><input id='saDl' type='date'></div><div><label>Qté livrée</label><input id='saQl' inputmode='decimal'></div></div>" +
      "<label>Statut</label><select id='saSt'>" + opts(AC.statuts || [], "", "— inchangé (" + (o.statut || "Payé") + ") —") + "</select>" +
      "<div id='saStk' style='display:none'><label>Entrée en stock ?</label><select id='saES'>" + opts(["Oui", "Non"], "", "— choisir —") + "</select><label>Quantité entrée en stock (vide = livrée)</label><input id='saQS' inputmode='decimal'></div>" +
      "<label>Commentaire</label><textarea id='saCo' rows='2'></textarea>" +
      "<button class='bouton' id='saOk'>💾 Enregistrer</button><div id='saMsg' class='info'></div></div>";
    montrer("vueListe");
    $("saSt").onchange = function () { $("saStk").style.display = this.value === "Clôturé" ? "" : "none"; };
    $("saOk").onclick = function () {
      var d = { id: o.id, tracking: $("saTr").value.trim(), livraison: $("saDl").value, qteLivree: $("saQl").value.replace(",", "."), statut: $("saSt").value, commentaire: $("saCo").value.trim(),
                stock: $("saSt").value === "Clôturé" ? $("saES").value : "", qteStock: $("saQS").value.replace(",", ".") };
      if (d.statut === "Clôturé" && !d.stock) { $("saMsg").textContent = "⛔ Entrée en stock : Oui ou Non."; return; }
      if (!d.tracking && !d.livraison && !d.qteLivree && !d.statut && !d.commentaire) { $("saMsg").textContent = "⛔ Rien à enregistrer."; return; }
      var it = { type: "fin", op: "suiviAchat", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: d, titre: "Suivi achat " + o.id, resume: "Finances", essais: 0 };
      d.jeton = it.jeton;
      soumettre(it).then(function (r) {
        alert((r.enAttente ? "📥 " : r.ok ? "✅ " : "⛔ ") + (r.titre || "") + "\n" + (r.message || ""));
        if (r.ok && !r.enAttente) rafraichirFin().catch(function () {}).then(afficherSuiviAchats); else afficherSuiviAchats();
      });
    };
  }

  /* ---------- Notifications (Firebase Cloud Messaging) ---------- */
  var FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
  function notifDispo() { return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window; }
  function iosHorsEcranAccueil() { return /iphone|ipad|ipod/i.test(navigator.userAgent) && !(navigator.standalone || matchMedia("(display-mode: standalone)").matches); }
  function majCarteNotif() {
    var i = $("infoNotif"), b = $("btnNotif"); if (!i) return;
    var cfg = S.formulaires && S.formulaires.notif;
    lire("notif").then(function (n) {
      var ok = n && n.agent === (S.agent && S.agent.nom) && Notification.permission === "granted";
      if (!notifDispo()) { i.textContent = iosHorsEcranAccueil() ? "Sur iPhone : installez d'abord DuoCore sur l'écran d'accueil (Partager › Sur l'écran d'accueil), puis ouvrez-le depuis l'icône." : "Ce navigateur ne gère pas les notifications."; b.style.display = "none"; return; }
      b.style.display = "";
      if (!S.agent) { i.textContent = "Connectez-vous d'abord (agent)."; b.disabled = true; return; }
      if (!cfg) { i.textContent = "Pas encore configurées sur le serveur (BASE › 🔔 Configurer les notifications), ou ⟳ à faire."; b.disabled = true; return; }
      if (Notification.permission === "denied") { i.textContent = "⛔ Notifications bloquées pour DuoCore : autorisez-les dans les réglages du navigateur / du téléphone, puis réessayez."; b.disabled = false; return; }
      b.disabled = false;
      i.textContent = ok ? "✅ Actives sur cet appareil pour " + n.agent + " (depuis le " + dateCourte(n.quand) + ")." : "Inactives sur cet appareil.";
      b.textContent = ok ? "Envoyer une notification de test" : "Activer sur cet appareil";
    });
  }
  function chargerFirebase() {
    return Promise.all([import(FIREBASE_SDK + "firebase-app.js"), import(FIREBASE_SDK + "firebase-messaging.js")]).then(function (m) { return { app: m[0], msg: m[1] }; });
  }
  // Jeton de l'appareil (Firebase) → enregistré au serveur pour l'agent connecté.
  function activerNotifications(test) {
    var cfg = S.formulaires && S.formulaires.notif;
    if (!cfg || !S.agent) return Promise.reject(new Error("configuration ou agent manquant"));
    // Chaque étape signale la sienne en cas d'échec (diagnostic : téléchargement, Firebase, serveur).
    function etape(nom, pr) { return pr.catch(function (e) { throw new Error(nom + " : " + ((e && e.message) || e)); }); }
    function essai(f, n) { return f().catch(function (e) { if (n > 0) return new Promise(function (ok) { setTimeout(ok, 2000); }).then(function () { return essai(f, n - 1); }); throw e; }); }
    return Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") throw new Error("autorisation refusée");
      return Promise.all([etape("1/3 Téléchargement de Firebase (www.gstatic.com)", essai(chargerFirebase, 1)), navigator.serviceWorker.ready]);
    }).then(function (r) {
      var F = r[0], appF = F.app.getApps().length ? F.app.getApp() : F.app.initializeApp(cfg.config);
      return etape("2/3 Jeton Firebase (googleapis.com)", essai(function () { return F.msg.getToken(F.msg.getMessaging(appF), { vapidKey: cfg.vapid, serviceWorkerRegistration: r[1] }); }, 2));
    }).then(function (jeton) {
      if (!jeton) throw new Error("2/3 Jeton Firebase : aucun jeton reçu");
      return etape("3/3 Enregistrement au serveur", api({ api: "notifEnregistrer", token: jeton, appareil: (modePC() ? "PC/tablette · " : "Téléphone · ") + navigator.platform, test: !!test })).then(function () {
        return ecrire("notif", { jeton: jeton, agent: S.agent.nom, quand: Date.now() });
      });
    });
  }
  // Au démarrage (une fois par jour) : jeton rafraîchi / rattaché à l'agent connecté.
  function verifierNotifications() {
    if (!notifDispo() || Notification.permission !== "granted" || !S.agent || !(S.formulaires && S.formulaires.notif) || !navigator.onLine) return;
    lire("notif").then(function (n) {
      if (n && n.agent === S.agent.nom && Date.now() - n.quand < 86400000) return;
      activerNotifications(false).catch(function () {});
    });
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", function (e) {
    var m = e.data || {};
    if (m.type === "notif") synchroniser(true).catch(function () {});
    if (m.type === "ouvrir") ouvrirDepuisNotif(m.data || {});
  });
  /* ---------- 👥 Ressources humaines : personnel, événements (validés par Walid), paie du mois ---------- */
  function droitRH() { var d = S.agent && S.formulaires && S.formulaires.droits; return !!(d && (d.rh || d.validation)); }
  var rafRH = null;
  function rafraichirRH() {
    if (!S.url || !droitRH()) return Promise.resolve();
    if (rafRH) return rafRH;
    rafRH = api({ api: "rh" }).then(function (r) { r.recu = Date.now(); S.rh = r; return ecrire("rh", r); })
      .then(function () { rafRH = null; }, function (e) { rafRH = null; throw e; });
    return rafRH;
  }
  function z2(n) { return (n < 10 ? "0" : "") + n; }
  function moisLib(t) { var d = new Date(t); return z2(d.getMonth() + 1) + "/" + d.getFullYear(); }
  function jourLib(t) { var d = new Date(t); return z2(d.getDate()) + "/" + z2(d.getMonth() + 1) + "/" + d.getFullYear(); }
  function cleLib(c) { var m = String(c).split("-"); return m[1] + "/" + m[0]; }
  function cleMois(t) { var d = new Date(t); return d.getFullYear() + "-" + z2(d.getMonth() + 1); }
  function nomRH(x) { return String(x || "").trim().toUpperCase(); }
  function nombre(v) { return typeof v === "number" ? v.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : esc(v); }
  function rhAttente(no) { return S.file.filter(function (x) { return x.type === "rh" && x.donnees && x.donnees.no === no; }); }
  function rhNbATraiter() {
    var R = S.rh; if (!R || !R.direction) return 0;
    return R.evenements.filter(function (e) { return e.statut === "En attente Walid" && !rhAttente(e.no).length; }).length;
  }
  var COUL_EV = { "En attente Walid": "#e65100", "Validé": "#2e7d32", "Refusé": "#c62828", "Annulé": "#777" };
  function envoyerRH(op, donnees, titre, suite) {
    var it = { type: "rh", op: op, jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: donnees, titre: titre, resume: "RH", essais: 0 };
    soumettre(it).then(function (r) {
      var fin = function () { if (suite) suite(r); else afficherRH(); };
      if (r.ok && !r.enAttente) return rafraichirRH().catch(function () {}).then(function () { alert("✅ " + r.titre + (r.message ? "\n" + r.message : "")); fin(); });
      alert((r.enAttente ? "📥 " : "⛔ ") + (r.titre || "") + "\n" + (r.message || "")); fin();
    });
  }
  function journalDe(nom) { return (S.rh.journal || []).filter(function (j) { return nomRH(j.nom) === nomRH(nom); }).sort(function (a, b) { return a.mois < b.mois ? 1 : -1; }); }

  var RHV = { onglet: "personnel", mois: "" };
  function afficherRH(id) {
    $("titre").textContent = "Ressources humaines";
    var R = S.rh;
    if (!R) {
      $("vueListe").innerHTML = "<div class='carte'><h3>👥 Ressources humaines</h3><p class='info'>Aucune donnée sur cet appareil : réseau puis ⟳.</p></div>"; montrer("vueListe");
      rafraichirRH().then(function () { if (S.rh) afficherRH(id); }).catch(function () {});
      return;
    }
    if (id && /^RH-/.test(id)) { ouvrirEvRH(id); return; }
    if (id === "paie") RHV.onglet = "paie";
    var nEv = R.evenements.filter(function (e) { return e.statut === "En attente Walid"; }).length;
    var envoi = S.file.filter(function (x) { return x.type === "rh"; }).length;
    var h = "<div class='carte'><h3>👥 Ressources humaines</h3><div class='info'>" + esc(R.agent) + (R.direction ? " · direction (" + esc(R.role) + ")" : " · responsable RH") + " · données du " + dateCourte(R.recu || R.genere) + "</div>" +
      "<button class='bouton' id='rhEv'>➕ Événement : heures, absence, congé, prélèvement</button>" +
      (R.direction ? "<button class='bouton second' id='rhNouv'>👤 Nouvel agent</button>" : "") +
      "<div class='onglets' style='margin-top:10px'>" + [["personnel", "Personnel"], ["evenements", "Événements" + (nEv ? " (" + nEv + ")" : "")], ["paie", "Paie du mois"], ["historique", "Historique"]]
        .map(function (o) { return "<button data-o='" + o[0] + "' class='" + (RHV.onglet === o[0] ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + o[1] + "</button>"; }).join("") + "</div></div>" +
      (envoi ? "<div class='carte att'>⏳ " + envoi + " opération(s) RH sur cet appareil, en attente d'envoi.</div>" : "") +
      "<div id='rhCorps'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-o]"), function (b) { b.onclick = function () { RHV.onglet = b.getAttribute("data-o"); afficherRH(); }; });
    $("rhEv").onclick = function () { formulaireEvRH(""); };
    if ($("rhNouv")) $("rhNouv").onclick = formulaireNouvelRH;
    var C = $("rhCorps");
    if (RHV.onglet === "personnel") {
      C.innerHTML = "<div class='carte'><input id='rhQ' placeholder='Rechercher un agent'></div><div id='rhL'></div>";
      var liste = function () {
        var q = $("rhQ").value.trim().toLowerCase();
        var P = R.personnel.filter(function (p) { return !q || p.nom.toLowerCase().indexOf(q) >= 0 || (p.intitule || "").toLowerCase().indexOf(q) >= 0; })
          .sort(function (a, b) { return (b.actif - a.actif) || a.nom.localeCompare(b.nom); });
        $("rhL").innerHTML = P.map(function (p) {
          var j = journalDe(p.nom)[0], att = R.evenements.filter(function (e) { return e.statut === "En attente Walid" && nomRH(e.personnel) === nomRH(p.nom); }).length;
          return "<div class='carte' data-n='" + esc(p.nom) + "' style='cursor:pointer" + (p.actif ? "" : ";opacity:.55") + "'><div class='ligne' style='justify-content:space-between'><b>" + esc(p.nom) + "</b>" +
            "<b style='flex:0;white-space:nowrap'>" + nombre(p.actuel) + " " + esc(p.devise) + "</b></div>" +
            "<div class='info'>" + (p.actif ? "" : "Parti · ") + (j ? "Paie " + cleLib(j.mois) + " : net " + nombre(j.v[12]) + " " + esc(j.v[13]) + " · " + esc(j.v[16]) : "Aucune paie au journal") +
            (att ? " · <b style='color:#e65100'>" + att + " événement(s) en attente</b>" : "") + "</div></div>";
        }).join("") || "<p class='info' style='padding:0 4px'>Personne.</p>";
        Array.prototype.forEach.call($("rhL").querySelectorAll("[data-n]"), function (el) { el.onclick = function () { ficheRH(el.getAttribute("data-n")); }; });
      };
      $("rhQ").oninput = liste; liste();
    } else if (RHV.onglet === "evenements") {
      var E = R.evenements.slice().sort(function (a, b) { return ((b.statut === "En attente Walid") - (a.statut === "En attente Walid")) || b.saisi - a.saisi; }).slice(0, 120);
      C.innerHTML = E.map(htmlEvRH).join("") || "<p class='info' style='padding:0 4px'>Aucun événement.</p>";
      Array.prototype.forEach.call(C.querySelectorAll("[data-ev]"), function (el) { el.onclick = function () { ouvrirEvRH(el.getAttribute("data-ev")); }; });
    } else if (RHV.onglet === "paie") afficherPaieRH(C);
    else {
      C.innerHTML = "<div class='carte'><h3>Salaires de base, arrivées, départs</h3>" + (R.historique.slice().reverse().map(function (x) {
        return "<div class='info'>" + jourLib(x.date) + " · " + esc(x.agent) + " · <b>" + esc(x.action) + "</b> · " + esc(x.personnel) + " · " + esc(x.detail) + " · dès " + esc(cleLib(x.mois)) +
          (x.etat === "En attente" ? " · <b style='color:#e65100'>en attente du mois</b>" : "") + "</div>";
      }).join("") || "<div class='info'>Rien pour l'instant.</div>") + "</div>";
    }
  }
  function htmlEvRH(e) {
    var att = rhAttente(e.no).length;
    return "<div class='carte" + (att ? " att" : "") + "' data-ev='" + esc(e.no) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + esc(e.type) + " · " + esc(e.personnel) + "</b>" +
      "<b style='flex:0;white-space:nowrap'>" + nombre(e.qte) + " " + esc(e.unite) + "</b></div>" +
      "<div class='info'>" + esc(e.no) + " · effet " + jourLib(e.effet) + " · saisi par " + esc(e.par) + (e.com ? " · " + esc(e.com) : "") + "</div>" +
      "<div style='color:" + (COUL_EV[e.statut] || "#999") + ";font-weight:700;font-size:14px'>" + esc(e.statut) + (att ? " · ⏳ action en attente d'envoi" : "") + "</div></div>";
  }
  function ouvrirEvRH(no) {
    var R = S.rh, e = R && R.evenements.filter(function (x) { return x.no === no; })[0];
    if (!e) { RHV.onglet = "evenements"; afficherRH(); return; }
    $("titre").textContent = e.no;
    var h = htmlEvRH(e).replace("cursor:pointer", "") + "<div class='carte'><h3>Historique</h3>" + e.historique.map(function (x) {
      return "<div class='info'>" + dateCourte(x.q) + " · " + esc(x.a) + " · " + esc(x.act) + (x.c ? " — " + esc(x.c) : "") + "</div>"; }).join("") +
      (e.ligneBase ? "<div class='info'>📒 Base, ligne " + esc(e.ligneBase) + "</div>" : "") + "</div><div id='rhAct'></div>" +
      "<button class='bouton second' id='rhFiche'>Fiche de " + esc(e.personnel) + "</button>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    $("rhFiche").onclick = function () { ficheRH(e.personnel); };
    if (e.statut !== "En attente Walid" || rhAttente(e.no).length) return;
    var A = $("rhAct");
    if (R.direction) {
      A.innerHTML = "<div class='carte'><h3>Votre décision</h3><label>Commentaire (obligatoire pour refuser)</label><input id='rhCom'>" +
        "<button class='bouton' id='rhVal' style='background:var(--vert)'>✅ Valider (inscrit dans Base)</button><button class='bouton' id='rhRef' style='background:var(--rouge)'>⛔ Refuser</button><div id='rhMsg' class='info'></div></div>";
      $("rhVal").onclick = function () { envoyerRH("decider", { no: e.no, version: e.version, decision: "valider", commentaire: $("rhCom").value.trim() }, "Validation " + e.no, function () { ouvrirEvRH(e.no); }); };
      $("rhRef").onclick = function () {
        var c = $("rhCom").value.trim(); if (!c) { $("rhMsg").textContent = "⛔ Commentaire obligatoire."; return; }
        if (confirm("Refuser " + e.no + " ?")) envoyerRH("decider", { no: e.no, version: e.version, decision: "refuser", commentaire: c }, "Refus " + e.no, function () { ouvrirEvRH(e.no); });
      };
    } else if (nomRH(e.par) === nomRH(R.agent)) {
      A.innerHTML = "<div class='carte'><button class='bouton second' id='rhAnn'>Annuler cet événement</button></div>";
      $("rhAnn").onclick = function () { if (confirm("Annuler " + e.no + " ?")) envoyerRH("annuler", { no: e.no, version: e.version }, "Annulation " + e.no, function () { ouvrirEvRH(e.no); }); };
    }
  }

  function ficheRH(nom, moisSel) {
    var R = S.rh, p = R.personnel.filter(function (x) { return nomRH(x.nom) === nomRH(nom); })[0];
    if (!p) { afficherRH(); return; }
    $("titre").textContent = p.nom;
    var J = journalDe(p.nom), j = J.filter(function (x) { return x.mois === moisSel; })[0] || J[0];
    // Évolution du salaire de base (changements seulement).
    var cles = Object.keys(p.salaires).sort(), evol = [], prec = null;
    cles.forEach(function (k) { var v = p.salaires[k]; if (v !== prec) evol.push([k, v]); prec = v; });
    var an = String(new Date().getFullYear()), cum = { cm: 0, ca: 0, ha: 0, hs: 0 };
    J.forEach(function (x) { if (x.mois.indexOf(an) === 0) { cum.hs += +x.v[7] || 0; cum.ha += +x.v[8] || 0; cum.cm += +x.v[14] || 0; cum.ca += +x.v[15] || 0; } });
    var EV = R.evenements.filter(function (e) { return nomRH(e.personnel) === nomRH(p.nom); }).sort(function (a, b) { return b.effet - a.effet; });
    var PA = R.paie.filter(function (d) { return nomRH(d.personnel) === nomRH(p.nom); }).sort(function (a, b) { return b.date - a.date; });
    var MV = R.saisies.filter(function (x) { return nomRH(x.nom) === nomRH(p.nom); }).sort(function (a, b) { return b.effet - a.effet; }).slice(0, 40);
    function tr(l, v, b) { return "<tr><td>" + l + "</td><td class='v'>" + (b ? "<b>" + v + "</b>" : v) + "</td></tr>"; }
    var h = "<div class='carte'><h3>" + esc(p.nom) + (p.actif ? "" : " · parti") + "</h3><table>" +
      tr("Salaire de base", nombre(p.actuel) + " " + esc(p.devise), true) + (p.intitule ? tr("Titulaire du compte", esc(p.intitule)) : "") + (p.rib ? tr("RIB", esc(p.rib)) : "") +
      tr("Évolution", evol.map(function (x) { return cleLib(x[0]) + " : " + nombre(x[1]); }).join("<br>") || "—") + "</table>" +
      "<button class='bouton' id='rhFEv'>➕ Événement pour " + esc(p.nom) + "</button>" +
      (droitFin() ? "<button class='bouton second' id='rhFPay'>💰 Paiement (avance, prime, salaire…)</button>" : "") +
      (R.direction ? "<div class='ligne'><button class='bouton second' id='rhFSal'>💵 Salaire de base</button>" + (p.actif ? "<button class='bouton second' id='rhFDep'>🚪 Départ</button>" : "") + "</div>" : "") + "</div>";
    // Paie (Journal RH)
    h += "<div class='carte'><h3>🧾 Paie</h3>" + (J.length ? "<select id='rhFM'>" + J.map(function (x) { return "<option value='" + x.mois + "'" + (x === j ? " selected" : "") + ">" + cleLib(x.mois) + "</option>"; }).join("") + "</select>" +
      "<table>" + R.entetesJournal.map(function (t, i) {
        var v = j.v[i]; if (i !== 0 && i !== 11 && i !== 12 && i !== 16 && (v === 0 || v === "")) return "";
        return tr(esc(t.replace(/ \(RH\)| \(GNF\)/g, "").toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); })) + (/\(GNF\)/.test(t) ? " <small>GNF</small>" : ""), nombre(v), i === 12 || i === 16);
      }).join("") + "</table><div class='info'>Primes et prises en charge : affichées, hors net. Heure sup = salaire/26/8 ; heure d'absence = salaire/26/4.</div>" : "<div class='info'>Aucune ligne au Journal RH.</div>") + "</div>";
    // Paiements (Finances)
    h += "<div class='carte'><h3>💰 Paiements</h3>" + (PA.map(function (d) {
      return "<div class='info' data-fin='" + esc(d.no) + "' style='cursor:pointer'>" + esc(d.no) + " · " + esc((d.motif || "").replace(" (RH)", "")) + (d.dateEffet ? " " + moisLib(d.dateEffet) : "") + " · <b>" + nombre(d.montant) + " " + esc(d.devise) + "</b>" +
        (d.recu ? " (= " + nombre(d.recu) + " " + esc(d.deviseRecue) + ")" : "") + " · <span style='color:" + (COUL_ST[d.statut] || "#999") + ";font-weight:700'>" + esc(d.statut) + "</span></div>";
    }).join("") || "<div class='info'>Aucune demande.</div>") + "</div>";
    // Congés et absences
    h += "<div class='carte'><h3>🗓️ Congés et absences " + an + "</h3><table>" + tr("Congé autorisé", nombre(cum.ca) + " j") + tr("Congé maladie", nombre(cum.cm) + " j") +
      tr("Heures d'absence", nombre(cum.ha) + " h") + tr("Heures sup", nombre(cum.hs) + " h") + "</table>" + EV.slice(0, 30).map(htmlEvRH).join("") + "</div>";
    // Mouvements (Journal Saisie RH)
    h += "<div class='carte'><h3>📒 Mouvements (12 mois)</h3>" + (MV.map(function (x) {
      return "<div class='info'>" + jourLib(x.effet) + " · " + esc(x.type.replace(" (RH)", "")) + " · " + (x.montant !== "" ? "<b>" + nombre(x.montant) + " " + esc(x.devise) + "</b>" + (x.equiv !== "" && x.devCible && x.devCible !== x.devise ? " (= " + nombre(x.equiv) + " " + esc(x.devCible) + ")" : "") : nombre(x.qte) + " " + esc(String(x.unite).toLowerCase())) +
        (x.paye ? " · " + esc(x.paye) : "") + "</div>";
    }).join("") || "<div class='info'>Aucun mouvement.</div>") + "</div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    if ($("rhFM")) $("rhFM").onchange = function () { ficheRH(p.nom, this.value); };
    $("rhFEv").onclick = function () { formulaireEvRH(p.nom); };
    if ($("rhFPay")) $("rhFPay").onclick = function () {
      var go = function () { if (S.fin) formulaireFin({ type: "Paiement RH", personnel: p.nom }); else alert("Données Finances absentes : réseau puis ⟳."); };
      if (S.fin) go(); else rafraichirFin().catch(function () {}).then(go);
    };
    if ($("rhFSal")) $("rhFSal").onclick = function () { formulaireSalaireRH(p); };
    if ($("rhFDep")) $("rhFDep").onclick = function () { formulaireDepartRH(p); };
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-ev]"), function (el) { el.onclick = function () { ouvrirEvRH(el.getAttribute("data-ev")); }; });
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-fin]"), function (el) {
      el.onclick = function () { if (!droitFin()) return; var no = el.getAttribute("data-fin"); if (S.fin && S.fin.demandes.some(function (x) { return x.no === no; })) ouvrirDemandeFin(no); else rafraichirFin().catch(function () {}).then(function () { afficherFinances(no); }); };
    });
  }

  function formulaireEvRH(nom) {
    var R = S.rh, T = R.types, types = Object.keys(T);
    $("titre").textContent = "Événement RH";
    var actifs = R.personnel.filter(function (p) { return p.actif; });
    $("vueListe").innerHTML = "<div class='carte'><h3>➕ Événement RH</h3>" +
      "<label>Agent</label><select id='reP'><option value=''>— choisir —</option>" + actifs.map(function (p) { return "<option" + (nomRH(p.nom) === nomRH(nom) ? " selected" : "") + ">" + esc(p.nom) + "</option>"; }).join("") + "</select>" +
      "<label>Type</label><select id='reT'>" + types.map(function (t) { return "<option>" + esc(t) + "</option>"; }).join("") + "</select>" +
      "<div class='ligne'><div><label id='reQL'>Quantité</label><input id='reQ' inputmode='decimal'></div><div><label>Date d'effet</label><input id='reD' type='date' value='" + new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) + "'></div></div>" +
      "<label>Commentaire</label><input id='reC'>" +
      "<div class='info' id='reI'></div><button class='bouton' id='reEnv'>📤 Envoyer</button><div class='info' id='reM'></div></div>";
    montrer("vueListe");
    function maj() {
      var t = T[$("reT").value], p = actifs.filter(function (x) { return x.nom === $("reP").value; })[0];
      $("reQL").textContent = t.unite === "devise" ? "Montant (" + (p ? p.devise : "devise du salaire") + ")" : "Nombre de " + t.unite;
      $("reI").textContent = (R.direction ? "Saisi par la direction : validé et inscrit dans Base tout de suite." : "Validation : Walid, puis inscrit dans Base.") + " Le mois de la date d'effet compte pour la paie.";
    }
    $("reT").onchange = maj; $("reP").onchange = maj; maj();
    $("reEnv").onclick = function () {
      var p = $("reP").value, q = parseFloat(String($("reQ").value).replace(/\s/g, "").replace(",", ".")), dt = $("reD").value, t = $("reT").value;
      if (!p) { $("reM").textContent = "⛔ Choisissez l'agent."; return; }
      if (!(q > 0)) { $("reM").textContent = "⛔ Quantité."; return; }
      if (!dt) { $("reM").textContent = "⛔ Date d'effet."; return; }
      if (!confirm(t + " · " + p + " : " + q + " — " + dt.split("-").reverse().join("/") + " ?")) return;
      envoyerRH("evenement", { personnel: p, type: t, quantite: q, effet: dt, commentaire: $("reC").value.trim() }, t + " · " + p, function (r) { if (r.no) ouvrirEvRH(r.no); else ficheRH(p); });
    };
  }
  function moisCourant() { return cleMois(Date.now()); }
  function formulaireSalaireRH(p) {
    $("titre").textContent = "Salaire de " + p.nom;
    $("vueListe").innerHTML = "<div class='carte'><h3>💵 Salaire de base · " + esc(p.nom) + "</h3><div class='info'>Actuel : " + nombre(p.actuel) + " " + esc(p.devise) + "</div>" +
      "<div class='ligne'><div style='flex:2'><label>Nouveau salaire (" + esc(p.devise) + ")</label><input id='rsM' inputmode='decimal'></div><div><label>À partir de</label><input id='rsD' type='month' value='" + moisCourant() + "'></div></div>" +
      "<label>Commentaire</label><input id='rsC'><div class='info'>Mois passé : le Journal RH est recalculé (une demande de salaire en validation est mise à jour). Mois pas encore ouvert : appliqué le 1er.</div>" +
      "<button class='bouton' id='rsEnv'>Enregistrer</button><button class='bouton second' id='rsAnn'>Retour</button><div class='info' id='rsMsg'></div></div>";
    montrer("vueListe");
    $("rsAnn").onclick = function () { ficheRH(p.nom); };
    $("rsEnv").onclick = function () {
      var m = parseFloat(String($("rsM").value).replace(/\s/g, "").replace(",", ".")), mo = $("rsD").value;
      if (!(m > 0) || !mo) { $("rsMsg").textContent = "⛔ Montant et mois."; return; }
      if (!confirm(p.nom + " : " + m.toLocaleString("fr-FR") + " " + p.devise + " à partir de " + cleLib(mo) + " ?")) return;
      envoyerRH("salaire", { personnel: p.nom, montant: m, mois: mo, commentaire: $("rsC").value.trim() }, "Salaire " + p.nom, function () { ficheRH(p.nom); });
    };
  }
  function formulaireDepartRH(p) {
    $("titre").textContent = "Départ de " + p.nom;
    $("vueListe").innerHTML = "<div class='carte'><h3>🚪 Départ · " + esc(p.nom) + "</h3><label>Dernier mois de salaire</label><input id='rdD' type='month' value='" + moisCourant() + "'>" +
      "<label>Commentaire (motif)</label><input id='rdC'><div class='info'>Le salaire passe à 0 le mois suivant : plus de demande de salaire, l'agent sort des listes. Le dernier mois reste à payer normalement.</div>" +
      "<button class='bouton' id='rdEnv' style='background:var(--rouge)'>Enregistrer le départ</button><button class='bouton second' id='rdAnn'>Retour</button></div>";
    montrer("vueListe");
    $("rdAnn").onclick = function () { ficheRH(p.nom); };
    $("rdEnv").onclick = function () {
      var mo = $("rdD").value; if (!mo) return;
      if (!confirm("Départ de " + p.nom + " : dernier mois payé " + cleLib(mo) + " ?")) return;
      envoyerRH("depart", { personnel: p.nom, mois: mo, commentaire: $("rdC").value.trim() }, "Départ " + p.nom, function () { ficheRH(p.nom); });
    };
  }
  function formulaireNouvelRH() {
    $("titre").textContent = "Nouvel agent";
    $("vueListe").innerHTML = "<div class='carte'><h3>👤 Nouvel agent</h3><label>Nom (ID collaborateur, en majuscules)</label><input id='rnN' style='text-transform:uppercase'>" +
      "<div class='ligne'><div style='flex:2'><label>Salaire de base</label><input id='rnS' inputmode='decimal'></div><div><label>Devise</label><select id='rnD'><option>GNF</option><option>USD</option><option>EURO</option><option>TND</option></select></div></div>" +
      "<label>À partir de</label><input id='rnM' type='month' value='" + moisCourant() + "'>" +
      "<label>RIB / compte (virement, facultatif)</label><input id='rnR'><label>Titulaire du compte (facultatif)</label><input id='rnI'><label>Commentaire</label><input id='rnC'>" +
      "<button class='bouton' id='rnEnv'>Enregistrer</button><div class='info' id='rnMsg'></div></div>";
    montrer("vueListe");
    $("rnEnv").onclick = function () {
      var n = $("rnN").value.trim().toUpperCase(), s = parseFloat(String($("rnS").value).replace(/\s/g, "").replace(",", ".")), mo = $("rnM").value;
      if (!n || !(s > 0) || !mo) { $("rnMsg").textContent = "⛔ Nom, salaire et mois."; return; }
      if (S.rh.personnel.some(function (p) { return nomRH(p.nom) === n; })) { $("rnMsg").textContent = "⛔ " + n + " existe déjà."; return; }
      if (!confirm("Nouvel agent " + n + " : " + s.toLocaleString("fr-FR") + " " + $("rnD").value + " à partir de " + cleLib(mo) + " ?")) return;
      envoyerRH("nouvel", { nom: n, salaire: s, devise: $("rnD").value, mois: mo, rib: $("rnR").value.trim(), intitule: $("rnI").value.trim(), commentaire: $("rnC").value.trim() }, "Nouvel agent " + n,
        function () { if (S.rh.personnel.some(function (p) { return nomRH(p.nom) === n; })) ficheRH(n); else afficherRH(); });
    };
  }

  /* Paie du mois : Journal RH + demandes de salaire ; direction : générer, valider en une fois. */
  function afficherPaieRH(C) {
    var R = S.rh, moisL = [], vu = {};
    R.journal.forEach(function (j) { if (!vu[j.mois]) { vu[j.mois] = 1; moisL.push(j.mois); } });
    moisL.sort().reverse();
    var prec = cleMois(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime());
    var m = RHV.mois && vu[RHV.mois] ? RHV.mois : vu[prec] ? prec : moisL[0] || prec;
    var J = R.journal.filter(function (j) { return j.mois === m; }).sort(function (a, b) { return a.nom.localeCompare(b.nom); });
    var D = R.paie.filter(function (d) { return d.motif === "SALAIRE (RH)" && d.dateEffet && cleMois(d.dateEffet) === m && ["Refusée", "Annulée"].indexOf(d.statut) < 0; });
    var aValider = R.role ? D.filter(function (d) { return d.statut === "En attente " + R.role && !finAttente(d.no).length; }) : [];
    var tot = {};
    var h = "<div class='carte'><div class='ligne'><div><label>Mois</label><select id='rpM'>" + moisL.map(function (x) { return "<option value='" + x + "'" + (x === m ? " selected" : "") + ">" + cleLib(x) + "</option>"; }).join("") + "</select></div></div>" +
      (R.direction ? "<button class='bouton second' id='rpGen'>⚙️ Générer / mettre à jour les demandes de salaire " + cleLib(m) + "</button>" : "") +
      (aValider.length && droitFin() ? "<button class='bouton' id='rpVal' style='background:var(--vert)'>✅ Valider les " + aValider.length + " salaire(s) en attente (" + esc(R.role) + ")</button>" : "") +
      "<div class='info'>Les demandes sont créées automatiquement le 1er du mois (8 h) pour le mois écoulé : Walid puis DG valident, puis le paiement se clôture avec la preuve dans 💰 Finances.</div></div>";
    h += J.map(function (j) {
      var d = D.filter(function (x) { return nomRH(x.personnel) === nomRH(j.nom); })[0], net = j.v[12], dev = j.v[13];
      if (typeof net === "number") tot[dev] = (tot[dev] || 0) + net;
      var paye = String(j.v[16]).indexOf("PAY") === 0;
      return "<div class='carte' data-n='" + esc(j.nom) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + esc(j.nom) + "</b><b style='flex:0;white-space:nowrap'>" + nombre(net) + " " + esc(dev) + "</b></div>" +
        "<div class='info'>Base " + nombre(j.v[0]) + (j.v[6] ? " · avance " + nombre(j.v[6]) : "") + (j.v[7] ? " · " + nombre(j.v[7]) + " h sup" : "") + (j.v[8] ? " · " + nombre(j.v[8]) + " h abs." : "") + (j.v[9] ? " · prélèv. " + nombre(j.v[9]) : "") + (j.v[10] ? " · prime " + nombre(j.v[10]) : "") + "</div>" +
        "<div style='font-weight:700;font-size:14px;color:" + (paye ? "#2e7d32" : d ? (COUL_ST[d.statut] || "#999") : typeof net === "number" ? "#e65100" : "#c62828") + "'>" +
        (paye ? "✅ Payé" + (j.v[17] ? " (" + nombre(j.v[17]) + ")" : "") : d ? esc(d.no) + " · " + esc(d.statut) : typeof net === "number" ? "Pas encore de demande" : "⚠️ Net à compléter (équivalent manquant dans Base)") + "</div></div>";
    }).join("") || "<p class='info' style='padding:0 4px'>Aucune ligne au Journal RH pour ce mois.</p>";
    if (Object.keys(tot).length) h += "<div class='carte'><b>Total net : " + Object.keys(tot).map(function (k) { return nombre(Math.round(tot[k] * 100) / 100) + " " + esc(k); }).join(" · ") + "</b></div>";
    C.innerHTML = h;
    $("rpM").onchange = function () { RHV.mois = this.value; afficherRH(); };
    Array.prototype.forEach.call(C.querySelectorAll("[data-n]"), function (el) { el.onclick = function () { ficheRH(el.getAttribute("data-n"), m); }; });
    if ($("rpGen")) $("rpGen").onclick = function () {
      if (!confirm("Générer les demandes de salaire " + cleLib(m) + " (une par personne, net du Journal RH) ?")) return;
      envoyerRH("genererPaie", { mois: m }, "Paie " + cleLib(m), function () { rafraichirFin().catch(function () {}); RHV.onglet = "paie"; afficherRH(); });
    };
    if ($("rpVal")) $("rpVal").onclick = function () {
      if (!confirm("Valider " + aValider.length + " salaire(s) " + cleLib(m) + " :\n" + aValider.map(function (d) { return d.personnel + " " + nombre(d.montant) + " " + d.devise; }).join("\n") + " ?")) return;
      aValider.forEach(function (d) {
        S.file.push({ type: "fin", op: "decider", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code,
          donnees: { no: d.no, version: d.version, decision: "valider", commentaire: "" }, titre: "Validation " + d.no + " · salaire " + d.personnel, resume: "Finances", essais: 0 });
      });
      var avant = S.aCorriger.length;
      $("rpVal").disabled = true; $("rpVal").textContent = "Envoi…";
      sauver().then(function () { majEtat(); return lancerEnvoi(); }).then(function () {
        return Promise.all([rafraichirRH().catch(function () {}), rafraichirFin().catch(function () {})]);
      }).then(function () {
        var reste = S.file.filter(function (x) { return x.type === "fin"; }).length, ko = S.aCorriger.length - avant;
        alert((ko > 0 ? "⛔ " + ko + " refusée(s) : voir « À corriger ».\n" : "") + (reste ? "📥 " + reste + " en attente de réseau." : "✅ Validations envoyées."));
        RHV.onglet = "paie"; afficherRH();
      });
    };
  }

  /* ---------- 🤝 Commercial : contrats, BDC, BL / factures (PDF), encaissements, retards, relances ---------- */
  function droitCom() { var d = S.agent && S.formulaires && S.formulaires.droits; return !!(d && (d.commercial || d.validation || d.comptable)); }
  var rafCom = null;
  function rafraichirCom() {
    if (!S.url || !droitCom()) return Promise.resolve();
    if (rafCom) return rafCom;
    rafCom = api({ api: "commercial" }).then(function (r) { r.recu = Date.now(); S.com = r; return ecrire("com", r); })
      .then(function () { rafCom = null; }, function (e) { rafCom = null; throw e; });
    return rafCom;
  }
  function comRetards() { var now = Date.now(); return S.com ? S.com.factures.filter(function (f) { return !f.paye && f.echeance && f.echeance < now; }) : []; }
  function comAttente(id) { return S.file.filter(function (x) { return x.type === "com" && x.donnees && (x.donnees.facture === id || x.donnees.contrat === id); }); }
  function jours(t) { return Math.floor((Date.now() - t) / 86400000); }
  function dateISO(t) { var d = new Date(t); return d.getFullYear() + "-" + z2(d.getMonth() + 1) + "-" + z2(d.getDate()); }
  function envoyerCom(op, donnees, titre, suite) {
    var it = { type: "com", op: op, jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: donnees, titre: titre, resume: "Commercial", essais: 0 };
    soumettre(it).then(function (r) {
      var fin = function () { if (suite) suite(r); else afficherCom(); };
      if (r.ok && !r.enAttente) return rafraichirCom().catch(function () {}).then(function () { alert("✅ " + r.titre + (r.message ? "\n" + r.message : "")); fin(); });
      alert((r.enAttente ? "📥 " : "⛔ ") + (r.titre || "") + "\n" + (r.message || "")); fin();
    });
  }
  // PDF d'un BL / d'une facture : gardé sur l'appareil après le 1er téléchargement.
  function pdfCom(id) {
    return lire("pdfc:" + id).then(function (c) {
      if (c) return c;
      return api({ api: "comPdf", id: id }, 120000).then(function (r) {
        var o = { nom: r.nom, blob: base64Blob(r.pdf) };
        return ecrire("pdfc:" + id, o).then(function () { return o; });
      });
    });
  }
  function ouvrirPdfCom(id, partager) {
    pdfCom(id).then(function (o) {
      var f = new File([o.blob], o.nom, { type: "application/pdf" });
      if (partager && navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: o.nom }).catch(function () {}); return; }
      var u = URL.createObjectURL(o.blob), w = window.open(u, "_blank");
      if (!w) { var a = document.createElement("a"); a.href = u; a.download = o.nom; document.body.appendChild(a); a.click(); a.remove(); }
    }, function (e) { alert("⛔ PDF : " + e.message + (navigator.onLine ? "" : " (réseau nécessaire la 1re fois)")); });
  }
  function barre(v, tot, coul) { var p = tot > 0 ? Math.min(100, Math.round(v / tot * 100)) : 0; return "<div style='height:6px;background:var(--bord);border-radius:3px;margin:2px 0 6px'><div style='height:6px;width:" + p + "%;background:" + coul + ";border-radius:3px'></div></div>"; }
  function htmlFacture(f) {
    var ret = !f.paye && f.echeance && f.echeance < Date.now(), att = comAttente(f.id).length;
    return "<div class='carte" + (att ? " att" : "") + "' data-fa='" + esc(f.id) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + esc(f.id) + "</b><b style='flex:0;white-space:nowrap'>" + gnf(f.montant) + " " + esc(f.devise) + "</b></div>" +
      "<div class='info'>" + esc(f.client) + " · " + esc(f.projet) + " · du " + jourLib(f.date) + "</div>" +
      "<div style='font-weight:700;font-size:14px;color:" + (f.paye ? "#2e7d32" : ret ? "#c62828" : "#e65100") + "'>" + (f.paye ? "✅ Encaissée le " + jourLib(f.encaisse) : ret ? "⏰ En retard de " + jours(f.echeance) + " j (échéance " + jourLib(f.echeance) + ")" : "À encaisser · échéance " + jourLib(f.echeance)) +
      (att ? " · ⏳ en attente d'envoi" : "") + "</div></div>";
  }

  var COMV = { onglet: "contrats", filtre: "nonpayees" };
  function afficherCom(id) {
    $("titre").textContent = "Commercial";
    var K = S.com;
    if (!K) {
      $("vueListe").innerHTML = "<div class='carte'><h3>🤝 Commercial</h3><p class='info'>Aucune donnée sur cet appareil : réseau puis ⟳.</p></div>"; montrer("vueListe");
      rafraichirCom().then(function () { if (S.com) afficherCom(id); }).catch(function () {});
      return;
    }
    if (id === "retards") { COMV.onglet = "factures"; COMV.filtre = "retard"; }
    else if (id && K.factures.some(function (f) { return f.id === id; })) { ficheFactureCom(id); return; }
    else if (id && K.contrats.some(function (c) { return c.id === id; })) { ficheContratCom(id); return; }
    var nR = comRetards().length, envoi = S.file.filter(function (x) { return x.type === "com"; }).length;
    var h = "<div class='carte'><h3>🤝 Commercial</h3><div class='info'>" + esc(K.agent) + (K.ecriture ? "" : " · lecture seule") + " · données du " + dateCourte(K.recu || K.genere) + "</div>" +
      (K.ecriture ? "<div class='ligne'><button class='bouton' id='cmBL'>📦 BL</button><button class='bouton' id='cmFa'>🧾 Facture</button></div>" +
        "<div class='ligne'><button class='bouton second' id='cmEnc'>💵 Encaissement</button><button class='bouton second' id='cmCt'>📄 Contrat</button><button class='bouton second' id='cmBdc'>🛒 BDC</button></div>" : "") +
      "<div class='onglets' style='margin-top:10px'>" + [["contrats", "Contrats"], ["factures", "Factures" + (nR ? " (⏰ " + nR + ")" : "")], ["clients", "Clients"], ["production", "BDC & production"]]
        .map(function (o) { return "<button data-o='" + o[0] + "' class='" + (COMV.onglet === o[0] ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + o[1] + "</button>"; }).join("") + "</div></div>" +
      (envoi ? "<div class='carte att'>⏳ " + envoi + " opération(s) commerciale(s) en attente d'envoi.</div>" : "") + "<div id='cmCorps'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-o]"), function (b) { b.onclick = function () { COMV.onglet = b.getAttribute("data-o"); afficherCom(); }; });
    if ($("cmBL")) { $("cmBL").onclick = function () { formulaireDocCom("bl"); }; $("cmFa").onclick = function () { formulaireDocCom("facture"); };
      $("cmEnc").onclick = function () { formulaireEncCom(""); }; $("cmCt").onclick = formulaireContratCom; $("cmBdc").onclick = function () { formulaireBdcCom(""); }; }
    var C = $("cmCorps");
    if (COMV.onglet === "contrats") {
      C.innerHTML = "<div class='carte'><input id='cmQ' placeholder='Rechercher (client, projet, n°)'><label style='font-weight:400'><input type='checkbox' id='cmClos' style='width:auto'> afficher les contrats clos</label></div><div id='cmL'></div>";
      var liste = function () {
        var q = $("cmQ").value.trim().toLowerCase(), clos = $("cmClos").checked;
        $("cmL").innerHTML = K.contrats.filter(function (c) { return (clos || !/clos/i.test(c.statut)) && (!q || (c.id + " " + c.client + " " + c.projet + " " + c.designation + " " + c.immat).toLowerCase().indexOf(q) >= 0); })
          .map(function (c) {
            var du = c.facture - c.recouvre;
            return "<div class='carte' data-ct='" + esc(c.id) + "' style='cursor:pointer" + (/clos/i.test(c.statut) ? ";opacity:.6" : "") + "'><div class='ligne' style='justify-content:space-between'><b>" + esc(c.designation) + "</b><span class='info' style='flex:0;white-space:nowrap'>" + esc(c.entreprise) + " · " + esc(c.statut) + "</span></div>" +
              "<div class='info'>" + esc(c.id) + " · " + esc(c.client) + " · " + esc(c.type) + "</div>" +
              "<div class='info'>Commandé " + gnf(c.commande) + " · livré " + gnf(c.livre) + "</div>" + barre(c.livre, c.commande, "#1565c0") +
              "<div class='info'>Facturé " + gnf(c.facture) + " · encaissé " + gnf(c.recouvre) + (du > 0 ? " · <b style='color:#c62828'>dû " + gnf(du) + " " + esc(c.devise) + "</b>" : "") + "</div>" + barre(c.recouvre, c.facture, "#2e7d32") + "</div>";
          }).join("") || "<p class='info' style='padding:0 4px'>Aucun contrat.</p>";
        Array.prototype.forEach.call($("cmL").querySelectorAll("[data-ct]"), function (el) { el.onclick = function () { ficheContratCom(el.getAttribute("data-ct")); }; });
      };
      $("cmQ").oninput = liste; $("cmClos").onchange = liste; liste();
    } else if (COMV.onglet === "factures") {
      var now = Date.now(), FL = { retard: "⏰ En retard", nonpayees: "À encaisser", toutes: "Toutes" };
      C.innerHTML = "<div class='carte'><div class='onglets'>" + Object.keys(FL).map(function (k) { return "<button data-fl='" + k + "' class='" + (COMV.filtre === k ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + FL[k] + "</button>"; }).join("") + "</div></div><div id='cmL'></div>";
      var L = K.factures.filter(function (f) { return COMV.filtre === "toutes" || (!f.paye && (COMV.filtre === "nonpayees" || (f.echeance && f.echeance < now))); })
        .sort(function (a, b) { return COMV.filtre === "toutes" ? b.date - a.date : a.echeance - b.echeance; });
      var tot = {}; L.forEach(function (f) { if (!f.paye) tot[f.devise] = (tot[f.devise] || 0) + f.montant; });
      $("cmL").innerHTML = (Object.keys(tot).length ? "<div class='carte'><b>Reste à encaisser : " + Object.keys(tot).map(function (k) { return gnf(tot[k]) + " " + esc(k); }).join(" · ") + "</b></div>" : "") +
        (L.map(htmlFacture).join("") || "<p class='info' style='padding:0 4px'>Rien ici.</p>");
      Array.prototype.forEach.call(C.querySelectorAll("[data-fl]"), function (b) { b.onclick = function () { COMV.filtre = b.getAttribute("data-fl"); afficherCom(); }; });
      Array.prototype.forEach.call(C.querySelectorAll("[data-fa]"), function (el) { el.onclick = function () { ficheFactureCom(el.getAttribute("data-fa")); }; });
    } else if (COMV.onglet === "clients") {
      C.innerHTML = K.clients.map(function (cl) {
        var Ct = K.contrats.filter(function (c) { return c.client === cl.nom; }), F = K.factures.filter(function (f) { return f.client === cl.nom; });
        var du = F.filter(function (f) { return !f.paye; }).reduce(function (t, f) { return t + f.montant; }, 0), ret = F.filter(function (f) { return !f.paye && f.echeance < Date.now(); }).length;
        return "<div class='carte' data-cl='" + esc(cl.nom) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + esc(cl.nom) + "</b><span class='info' style='flex:0;white-space:nowrap'>" + esc(cl.regime) + "</span></div>" +
          "<div class='info'>" + Ct.length + " contrat(s) · " + F.length + " facture(s)" + (du ? " · <b style='color:#c62828'>dû " + gnf(du) + "</b>" : "") + (ret ? " · ⏰ " + ret + " en retard" : "") + "</div></div>";
      }).join("");
      Array.prototype.forEach.call(C.querySelectorAll("[data-cl]"), function (el) { el.onclick = function () { ficheClientCom(el.getAttribute("data-cl")); }; });
    } else {
      var B = K.bdcs.filter(function (b) { return !/livré$/i.test(b.statut || "") || (b.lignes || []).length; }).sort(function (a, b) { return b.date - a.date; });
      C.innerHTML = B.map(htmlBdcCom).join("") || "<p class='info' style='padding:0 4px'>Aucun BDC.</p>";
    }
  }
  function lotsBdc(id) { return ((S.donnees && S.donnees.lots) || []).filter(function (l) { return String(l.bdc).toUpperCase().indexOf(String(id).toUpperCase()) >= 0; }); }
  function htmlBdcCom(b) {
    var lots = lotsBdc(b.id), L = b.lignes || [];
    var tq = 0, tl = 0, tf = 0; L.forEach(function (l) { tq += l.qte || 0; tl += l.livre || 0; tf += l.facture || 0; });
    return "<div class='carte'><div class='ligne' style='justify-content:space-between'><b>🛒 " + esc(b.id) + "</b><b style='flex:0;white-space:nowrap'>" + gnf(b.montant) + " " + esc(b.devise || "GNF") + "</b></div>" +
      "<div class='info'>" + esc(b.client) + " · " + esc(b.projet) + " · <b>" + esc(b.statut || "—") + "</b>" + (lots.length ? " · 🏭 " + lots.length + " lot(s) en atelier" : "") + "</div>" +
      (L.length ? "<details><summary class='info'>" + L.length + " article(s) · livré " + gnf(tl) + " / " + gnf(tq) + " · facturé " + gnf(tf) + " (DuoCore)</summary><table>" +
        "<tr><td><b>Article</b></td><td class='v'><b>Cmd</b></td><td class='v'><b>Livré</b></td><td class='v'><b>Fact.</b></td></tr>" +
        L.map(function (l) { return "<tr><td>" + esc(l.abr || l.designation) + "</td><td class='v'>" + gnf(l.qte) + "</td><td class='v'>" + gnf(l.livre || 0) + "</td><td class='v'>" + gnf(l.facture || 0) + "</td></tr>"; }).join("") + "</table></details>" : "<div class='info'>Articles : à saisir dans 🗂️ Planification.</div>") +
      (lots.length ? "<details><summary class='info'>Avancement des lots</summary>" + lots.slice(0, 40).map(function (l) { return "<div class='info'>" + esc(l.cle) + " · " + esc(l.designation) + (l.resume ? " — " + esc(String(l.resume).replace(/<[^>]+>/g, " ").slice(0, 90)) : "") + "</div>"; }).join("") + "</details>" : "") + "</div>";
  }
  function ficheContratCom(id) {
    var K = S.com, c = K.contrats.filter(function (x) { return x.id === id; })[0];
    if (!c) { afficherCom(); return; }
    $("titre").textContent = c.id;
    var F = K.factures.filter(function (f) { return f.contrat === c.id; }).sort(function (a, b) { return b.date - a.date; });
    var BL = K.bls.filter(function (b) { return b.contrat === c.id; }).sort(function (a, b) { return b.date - a.date; });
    var BD = K.bdcs.filter(function (b) { return b.contrat === c.id; });
    function tr(l, v) { return "<tr><td>" + l + "</td><td class='v' style='white-space:normal'>" + v + "</td></tr>"; }
    var h = "<div class='carte'><h3>" + esc(c.designation) + "</h3><table>" + tr("Contrat", esc(c.id) + (c.immat ? " · " + esc(c.immat) : "")) + tr("Client", esc(c.client) + " · " + esc(c.regime)) +
      tr("Société / compte", esc(c.entreprise) + " · " + esc(c.benef)) + tr("Type", esc(c.type) + " · " + esc(c.statut)) +
      tr("Commandé", "<b>" + gnf(c.commande) + " " + esc(c.devise) + "</b>") + tr("Livré", gnf(c.livre) + " · reste " + gnf(c.commande - c.livre)) +
      tr("Facturé", gnf(c.facture)) + tr("Encaissé", gnf(c.recouvre)) + tr("Dû", "<b>" + gnf(c.facture - c.recouvre) + "</b>") + "</table>" +
      (S.com.ecriture && !/clos/i.test(c.statut) ? "<div class='ligne'><button class='bouton' id='ctBL'>📦 BL</button><button class='bouton' id='ctFa'>🧾 Facture</button>" + (/avec bdc/i.test(c.type) ? "<button class='bouton second' id='ctBdc'>🛒 BDC</button>" : "") + "</div>" : "") + "</div>" +
      BD.map(htmlBdcCom).join("") +
      "<div class='carte'><h3>🧾 Factures</h3></div>" + (F.map(htmlFacture).join("") || "<p class='info' style='padding:0 4px'>Aucune.</p>") +
      "<div class='carte'><h3>📦 Bons de livraison</h3>" + (BL.map(function (b) {
        return "<div class='ligne' style='justify-content:space-between'><div class='info'><b>" + esc(b.id) + "</b> · " + jourLib(b.date) + " · " + gnf(b.montant) + (b.reference ? " · " + esc(b.reference) : "") + "</div>" +
          (b.pdf ? "<button class='bouton second' data-pdf='" + esc(b.id) + "' style='flex:0;width:auto;padding:6px 10px'>📄</button>" : "") + "</div>";
      }).join("") || "<div class='info'>Aucun.</div>") + "</div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    if ($("ctBL")) { $("ctBL").onclick = function () { formulaireDocCom("bl", c.id); }; $("ctFa").onclick = function () { formulaireDocCom("facture", c.id); }; }
    if ($("ctBdc")) $("ctBdc").onclick = function () { formulaireBdcCom(c.id); };
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-fa]"), function (el) { el.onclick = function () { ficheFactureCom(el.getAttribute("data-fa")); }; });
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-pdf]"), function (el) { el.onclick = function () { ouvrirPdfCom(el.getAttribute("data-pdf")); }; });
  }
  function ficheFactureCom(id) {
    var K = S.com, f = K.factures.filter(function (x) { return x.id === id; })[0];
    if (!f) { afficherCom(); return; }
    $("titre").textContent = f.id;
    var R = K.relances.filter(function (r) { return r.facture === f.id; }).sort(function (a, b) { return b.date - a.date; });
    var h = htmlFacture(f).replace("cursor:pointer", "") + "<div class='carte'><table><tr><td>Contrat</td><td class='v'>" + esc(f.contrat) + "</td></tr><tr><td>Compte</td><td class='v'>" + esc(f.benef) + "</td></tr>" +
      (f.bdc ? "<tr><td>BDC</td><td class='v'>" + esc(f.bdc) + "</td></tr>" : "") + "<tr><td>Saisie</td><td class='v'>" + esc(f.editeur) + "</td></tr></table>" +
      (f.pdf ? "<div class='ligne'><button class='bouton second' id='faPdf'>📄 Ouvrir le PDF</button><button class='bouton second' id='faPart'>📤 Partager</button></div>" : "<div class='info'>Facture saisie avant DuoCore : pas de PDF.</div>") +
      (K.ecriture && !f.paye ? "<button class='bouton' id='faEnc' style='background:var(--vert)'>💵 Encaissée</button><button class='bouton second' id='faRel'>📞 Noter une relance</button>" : "") + "</div>" +
      "<div class='carte'><h3>Relances</h3>" + (R.map(function (r) { return "<div class='info'>" + jourLib(r.date) + " · " + esc(r.agent) + " · <b>" + esc(r.mode) + "</b>" + (r.com ? " — " + esc(r.com) : "") + (r.prochaine ? " · prochaine " + jourLib(r.prochaine) : "") + "</div>"; }).join("") || "<div class='info'>Aucune.</div>") + "</div>" +
      "<button class='bouton second' id='faCt'>Contrat " + esc(f.contrat) + "</button>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    if ($("faPdf")) { $("faPdf").onclick = function () { ouvrirPdfCom(f.id); }; $("faPart").onclick = function () { ouvrirPdfCom(f.id, true); }; }
    if ($("faEnc")) { $("faEnc").onclick = function () { formulaireEncCom(f.id); }; $("faRel").onclick = function () { formulaireRelanceCom(f); }; }
    $("faCt").onclick = function () { ficheContratCom(f.contrat); };
  }
  function ficheClientCom(nom) {
    var K = S.com, cl = K.clients.filter(function (c) { return c.nom === nom; })[0];
    if (!cl) { afficherCom(); return; }
    $("titre").textContent = cl.nom;
    var Ct = K.contrats.filter(function (c) { return c.client === nom; }), F = K.factures.filter(function (f) { return f.client === nom; }).sort(function (a, b) { return b.date - a.date; });
    var fa = 0, en = 0; F.forEach(function (f) { fa += f.montant; if (f.paye) en += f.montant; });
    var h = "<div class='carte'><h3>" + esc(cl.nom) + " <small class='info'>" + esc(cl.code) + "</small></h3><table><tr><td>Facturé</td><td class='v'>" + gnf(fa) + "</td></tr><tr><td>Encaissé</td><td class='v'>" + gnf(en) + "</td></tr>" +
      "<tr><td>Dû</td><td class='v'><b>" + gnf(fa - en) + "</b></td></tr></table>" +
      "<label>Régime des factures</label><select id='clReg'" + (K.ecriture ? "" : " disabled") + ">" + K.regimes.map(function (r) { return "<option" + (r === cl.regime ? " selected" : "") + ">" + r + "</option>"; }).join("") + "</select>" +
      "<div class='info'>Administration : prix TTC, précompte 50 % de la TVA, ARMP 0,6 %. Privé : HT + TVA 18 % = TTC.</div></div>" +
      "<div class='carte'><h3>Contrats</h3>" + Ct.map(function (c) { return "<div class='info' data-ct='" + esc(c.id) + "' style='cursor:pointer'><b>" + esc(c.designation) + "</b> · " + esc(c.id) + " · " + esc(c.statut) + "</div>"; }).join("") + "</div>" +
      F.map(htmlFacture).join("");
    $("vueListe").innerHTML = h; montrer("vueListe");
    $("clReg").onchange = function () { var v = this.value; if (confirm(cl.nom + " : régime « " + v + " » pour les prochaines factures ?")) envoyerCom("client", { nom: cl.nom, regime: v }, "Régime " + cl.nom, function () { ficheClientCom(nom); }); };
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-ct]"), function (el) { el.onclick = function () { ficheContratCom(el.getAttribute("data-ct")); }; });
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-fa]"), function (el) { el.onclick = function () { ficheFactureCom(el.getAttribute("data-fa")); }; });
  }

  function optsCom(L, v, vide, val, lib) { return (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { var k = val ? val(x) : x; return "<option value='" + esc(k) + "'" + (k === v ? " selected" : "") + ">" + esc(lib ? lib(x) : x) + "</option>"; }).join(""); }
  function nbCom(x) { x = String(x || "").replace(/[\s  ]/g, "").replace(",", "."); return parseFloat(x) || 0; }
  function blocPrix(p) {
    return "<label>Prix</label><select id='" + p + "PU'><option value='non'>Montant global</option><option value='oui'>Prix unitaire unique × quantité</option></select>" +
      "<div id='" + p + "MtB'><label>Montant net à payer</label><input id='" + p + "Mt' inputmode='decimal'></div>" +
      "<div id='" + p + "PuB' class='ligne' style='display:none'><div><label>Net unitaire</label><input id='" + p + "Pu' inputmode='decimal'></div><div><label>Quantité globale</label><input id='" + p + "Q' inputmode='decimal'></div></div>" +
      "<label>Devise</label><select id='" + p + "Dev'><option>GNF</option><option>EURO</option><option>USD</option><option>TND</option></select>";
  }
  function lierPrix(p) { $(p + "PU").onchange = function () { var u = this.value === "oui"; $(p + "MtB").style.display = u ? "none" : ""; $(p + "PuB").style.display = u ? "" : "none"; }; }
  function lirePrix(p) {
    var u = $(p + "PU").value === "oui";
    return { prixUnique: u, montant: nbCom($(p + "Mt").value), pu: nbCom($(p + "Pu").value), qte: nbCom($(p + "Q").value), devise: $(p + "Dev").value };
  }
  function formulaireContratCom() {
    var K = S.com; $("titre").textContent = "Nouveau contrat";
    $("vueListe").innerHTML = "<div class='carte'><h3>📄 Nouveau contrat</h3>" +
      "<label>Client</label><select id='ncCl'>" + optsCom(K.clients.map(function (c) { return c.nom; }), "", "— choisir —") + "<option value='+'>➕ Nouveau client</option></select>" +
      "<div id='ncNC' style='display:none'><div class='ligne'><div style='flex:2'><label>Nom du client</label><input id='ncNCn'></div><div><label>Code (ID)</label><input id='ncNCc' style='text-transform:uppercase'></div></div>" +
      "<label>Régime</label><select id='ncReg'>" + optsCom(K.regimes, "Administration") + "</select></div>" +
      "<label>Projet</label><select id='ncPr'>" + optsCom(K.projets.map(function (p) { return p.nom; }), "", "— choisir —") + "<option value='+'>➕ Nouveau projet</option></select>" +
      "<div id='ncNP' style='display:none' class='ligne'><div style='flex:2'><label>Nom du projet</label><input id='ncNPn'></div><div><label>Code produit</label><input id='ncNPc' style='text-transform:uppercase'></div></div>" +
      "<label>Immatriculation (facultatif)</label><input id='ncIm'><label>Compte bénéficiaire</label><select id='ncBen'>" + optsCom(K.beneficiaires, "", "— choisir —") + "</select>" +
      "<label>Le contrat recevra-t-il des BDC ?</label><select id='ncBdc'><option value='non'>Non : le contrat est la commande</option><option value='oui'>Oui : on déclare ici le 1er BDC</option></select>" +
      blocPrix("nc") + "<label>Date</label><input id='ncD' type='date' value='" + dateISO(Date.now()) + "'>" +
      "<button class='bouton' id='ncEnv'>📤 Enregistrer</button><div class='info' id='ncM'></div></div>";
    montrer("vueListe"); lierPrix("nc");
    $("ncCl").onchange = function () { $("ncNC").style.display = this.value === "+" ? "" : "none"; };
    $("ncPr").onchange = function () { $("ncNP").style.display = this.value === "+" ? "" : "none"; };
    $("ncEnv").onclick = function () {
      var d = lirePrix("nc"), cl = $("ncCl").value, pr = $("ncPr").value;
      d.nouveauClient = cl === "+"; d.client = d.nouveauClient ? "" : cl; d.nomClient = $("ncNCn").value.trim(); d.codeClient = $("ncNCc").value.trim().toUpperCase(); d.regime = $("ncReg").value;
      d.nouveauProjet = pr === "+"; d.projet = d.nouveauProjet ? "" : pr; d.nomProjet = $("ncNPn").value.trim(); d.codeProduit = $("ncNPc").value.trim().toUpperCase();
      d.immat = $("ncIm").value.trim(); d.benef = $("ncBen").value; d.avecBdc = $("ncBdc").value === "oui"; d.date = $("ncD").value;
      var err = !cl ? "client" : d.nouveauClient && !d.nomClient ? "nom du client" : !pr ? "projet" : d.nouveauProjet && !d.nomProjet ? "nom du projet" : !d.benef ? "compte bénéficiaire" :
        d.prixUnique ? (!(d.pu > 0) || !(d.qte > 0) ? "prix unitaire et quantité" : "") : !(d.montant > 0) ? "montant" : "";
      if (err) { $("ncM").textContent = "⛔ Indiquez : " + err + "."; return; }
      var mt = d.prixUnique ? d.pu * d.qte : d.montant;
      if (!confirm("Nouveau contrat : " + (d.client || d.nomClient) + " · " + (d.projet || d.nomProjet) + " · " + gnf(mt) + " " + d.devise + " ?")) return;
      envoyerCom("contrat", d, "Contrat " + (d.client || d.nomClient));
    };
  }
  function formulaireBdcCom(idC) {
    var K = S.com, CT = K.contrats.filter(function (c) { return /avec bdc/i.test(c.type) && !/clos/i.test(c.statut); });
    $("titre").textContent = "Nouveau BDC";
    $("vueListe").innerHTML = "<div class='carte'><h3>🛒 Nouveau BDC</h3><label>Contrat</label><select id='nbC'>" + optsCom(CT, idC, "— choisir —", function (c) { return c.id; }, function (c) { return c.designation + " · " + c.id; }) + "</select>" +
      blocPrix("nb") + "<label>Date</label><input id='nbD' type='date' value='" + dateISO(Date.now()) + "'><div class='info'>Les articles du BDC se saisissent ensuite dans 🗂️ Planification (Saisi BDC).</div>" +
      "<button class='bouton' id='nbEnv'>📤 Enregistrer</button><div class='info' id='nbM'></div></div>";
    montrer("vueListe"); lierPrix("nb");
    $("nbEnv").onclick = function () {
      var d = lirePrix("nb"); d.contrat = $("nbC").value; d.date = $("nbD").value;
      var err = !d.contrat ? "contrat" : d.prixUnique ? (!(d.pu > 0) || !(d.qte > 0) ? "prix unitaire et quantité" : "") : !(d.montant > 0) ? "montant" : "";
      if (err) { $("nbM").textContent = "⛔ Indiquez : " + err + "."; return; }
      if (!confirm("Nouveau BDC sur " + d.contrat + " · " + gnf(d.prixUnique ? d.pu * d.qte : d.montant) + " " + d.devise + " ?")) return;
      envoyerCom("bdc", d, "BDC " + d.contrat, function () { ficheContratCom(d.contrat); });
    };
  }
  /* BL / facture : lignes du BDC (Prix BDC), quantités proposées = reste, tout modifiable ; aperçu des montants. */
  function formulaireDocCom(type, idC) {
    var K = S.com, fact = type === "facture", CT = K.contrats.filter(function (c) { return !/clos/i.test(c.statut); });
    $("titre").textContent = fact ? "Nouvelle facture" : "Nouveau BL";
    $("vueListe").innerHTML = "<div class='carte'><h3>" + (fact ? "🧾 Nouvelle facture" : "📦 Nouveau bon de livraison") + "</h3>" +
      "<label>Contrat</label><select id='dcC'>" + optsCom(CT, idC || "", "— choisir —", function (c) { return c.id; }, function (c) { return c.designation + " · " + c.id; }) + "</select>" +
      "<div id='dcBB'><label>Bon de commande</label><select id='dcB'></select></div><div class='info' id='dcI'></div>" +
      "<div id='dcL'></div><button class='bouton second' id='dcAj'>➕ Ligne libre</button>" +
      "<div class='ligne'><div><label>Date</label><input id='dcD' type='date' value='" + dateISO(Date.now()) + "'></div>" + (fact ? "<div><label>Échéance</label><input id='dcE' type='date'></div>" : "") + "</div>" +
      "<label>" + (fact ? "Référence (BL, bon d'engagement… facultatif)" : "Livré à (lieu, réceptionnaire)") + "</label><input id='dcR'>" +
      "<div class='carte' id='dcT' style='margin-top:10px'></div><button class='bouton' id='dcEnv'>📤 " + (fact ? "Émettre la facture (PDF)" : "Émettre le BL (PDF)") + "</button><div class='info' id='dcM' style='white-space:pre-line'></div></div>";
    montrer("vueListe");
    var lignes = [];
    function contrat() { return K.contrats.filter(function (c) { return c.id === $("dcC").value; })[0]; }
    function soc() { var c = contrat(); return (K.societes || {})[c ? String(c.entreprise).toUpperCase() : "AB"] || { tva: 18, precompte: 50, armp: 0.6, delai: 30 }; }
    function dessinerLignes() {
      $("dcL").innerHTML = lignes.length ? (fact && $("dcB").value ? "<button class='bouton second' id='dcRes'>↺ Quantités = commandé − déjà facturé</button>" : "") + lignes.map(function (l, i) {
        return "<div style='border-top:1px solid var(--bord);padding:6px 0" + (l.qte > 0 ? "" : ";opacity:.75") + "'><div class='ligne'><input class='dcN' data-i='" + i + "' value='" + esc(l.designation) + "' style='padding:6px;flex:1' placeholder='Désignation'>" +
          "<button class='bouton second' data-x='" + i + "' style='padding:4px 8px;width:auto;flex:0'>✕</button></div>" + (l.info ? "<div class='info' style='font-size:11px'>" + esc((l.abr ? l.abr + " · " : "") + l.info) + "</div>" : "") +
          "<div class='ligne'><div><small>Quantité</small><input class='dcQ' data-i='" + i + "' inputmode='decimal' value='" + (l.qte || "") + "' style='padding:6px'></div>" +
          "<div><small>Net unitaire</small><input class='dcP' data-i='" + i + "' inputmode='decimal' value='" + (l.pu || "") + "' style='padding:6px'></div></div></div>";
      }).join("") : "<div class='info'>Aucune ligne : choisissez le BDC ou ajoutez une ligne libre.</div>";
      if ($("dcRes")) $("dcRes").onclick = function () { lignes.forEach(function (l) { if (l.cmd !== undefined) l.qte = Math.max(0, l.cmd - (l.fac || 0)); }); dessinerLignes(); };
      Array.prototype.forEach.call(document.querySelectorAll(".dcN,.dcQ,.dcP"), function (inp) {
        inp.oninput = function () { var l = lignes[+inp.getAttribute("data-i")]; if (inp.className === "dcN") l.designation = inp.value; else if (inp.className === "dcQ") l.qte = nbCom(inp.value); else l.pu = nbCom(inp.value); totaux(); };
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-x]"), function (b) { b.onclick = function () { lignes.splice(+b.getAttribute("data-x"), 1); dessinerLignes(); }; });
      totaux();
    }
    function totaux() {
      var c = contrat(), s = soc(), reg = c ? c.regime : "Administration", t = s.tva / 100, net = 0, q = 0;
      lignes.forEach(function (l) { if (l.qte > 0) { net += l.qte * (l.pu || 0); q += l.qte; } });
      var h = "<b>" + lignes.filter(function (l) { return l.qte > 0; }).length + " ligne(s) · " + gnf(q) + " unités</b><br>Net à payer : <b>" + gnf(net) + " " + esc(c ? c.devise : "GNF") + "</b>";
      if (fact && net) {
        if (reg === "Privé") h += "<br><small>Privé : HT " + gnf(net / (1 + t)) + " + TVA " + s.tva + " % = TTC " + gnf(net) + "</small>";
        else { var k = 1 + t - t * s.precompte / 100 - s.armp / 100, ht = net / k; h += "<br><small>Administration : HT " + gnf(ht) + " · TTC " + gnf(ht * (1 + t)) + " − précompte " + gnf(ht * t * s.precompte / 100) + " − ARMP " + gnf(ht * s.armp / 100) + "</small>"; }
      }
      $("dcT").innerHTML = h;
    }
    function chargerBdc() {
      var b = K.bdcs.filter(function (x) { return x.id === $("dcB").value; })[0];
      lignes = b ? (b.lignes || []).map(function (l) {
        var reste = fact ? (l.livre || 0) - (l.facture || 0) : l.qte - (l.livre || 0);
        return { designation: l.designation, abr: l.abr, qte: Math.max(0, reste), pu: l.pu, cmd: l.qte, fac: l.facture || 0, info: "Cmd " + gnf(l.qte) + " · livré " + gnf(l.livre || 0) + " · facturé " + gnf(l.facture || 0) };
      }) : [];
      $("dcI").textContent = b ? (b.lignes.length ? "Quantités proposées : " + (fact ? "livré non facturé (BL DuoCore)" : "reste à livrer") + ". Modifiez librement ; une ligne à 0 est ignorée." : "Aucun article saisi pour ce BDC (Planification) : ajoutez des lignes libres.") : "";
      dessinerLignes();
    }
    function majContrat() {
      var c = contrat(), B = c ? K.bdcs.filter(function (b) { return b.contrat === c.id; }) : [];
      $("dcB").innerHTML = optsCom(B, B.length === 1 ? B[0].id : "", B.length > 1 ? "— choisir —" : "", function (b) { return b.id; }, function (b) { return b.id + " · " + (b.statut || "") + " · " + gnf(b.montant); });
      $("dcBB").style.display = B.length ? "" : "none";
      if (fact && $("dcE")) { var d0 = new Date($("dcD").value + "T00:00:00").getTime() || Date.now(); $("dcE").value = dateISO(d0 + soc().delai * 86400000); }
      chargerBdc();
    }
    $("dcC").onchange = majContrat; $("dcB").onchange = chargerBdc;
    $("dcAj").onclick = function () { lignes.push({ designation: "", qte: 0, pu: 0 }); dessinerLignes(); };
    majContrat();
    $("dcEnv").onclick = function () {
      var c = contrat(), L = lignes.filter(function (l) { return String(l.designation).trim() && l.qte > 0; });
      if (!c) { $("dcM").textContent = "⛔ Choisissez le contrat."; return; }
      if (!L.length) { $("dcM").textContent = "⛔ Au moins une ligne avec une quantité."; return; }
      if (fact && L.some(function (l) { return !(l.pu > 0); })) { $("dcM").textContent = "⛔ Prix unitaire manquant sur une ligne."; return; }
      var net = L.reduce(function (t, l) { return t + l.qte * (l.pu || 0); }, 0);
      if (!confirm((fact ? "Émettre la facture" : "Émettre le BL") + " · " + c.client + " · " + L.length + " ligne(s)" + (net ? " · net " + gnf(net) + " " + c.devise : "") + " ?\nLe n° est attribué par le serveur (réseau nécessaire pour le PDF).")) return;
      var d = { contrat: c.id, bdc: $("dcB").value, lignes: L.map(function (l) { return { designation: String(l.designation).trim(), abr: l.abr || "", qte: l.qte, pu: l.pu || 0 }; }),
        date: $("dcD").value, echeance: fact ? $("dcE").value : "", reference: $("dcR").value.trim(), devise: c.devise || "GNF" };
      envoyerCom(type, d, (fact ? "Facture " : "BL ") + c.client, function (r) {
        if (r && r.ok && r.id && r.pdf) { ficheContratCom(c.id); if (confirm("Ouvrir le PDF " + r.id + " ?")) ouvrirPdfCom(r.id); } else ficheContratCom(c.id);
      });
    };
  }
  function formulaireEncCom(idF) {
    var K = S.com, F = K.factures.filter(function (f) { return !f.paye && !comAttente(f.id).length; }).sort(function (a, b) { return a.echeance - b.echeance; });
    $("titre").textContent = "Encaissement";
    $("vueListe").innerHTML = "<div class='carte'><h3>💵 Encaissement d'une facture</h3><label>Facture (payée en entier)</label><select id='enF'>" +
      optsCom(F, idF, "— choisir —", function (f) { return f.id; }, function (f) { return f.id + " · " + f.client + " · " + gnf(f.montant) + " " + f.devise; }) + "</select>" +
      "<div class='info' id='enI'></div><label>Date réelle d'encaissement (relevé bancaire)</label><input id='enD' type='date' value='" + dateISO(Date.now()) + "'>" +
      "<button class='bouton' id='enEnv' style='background:var(--vert)'>💵 Enregistrer l'encaissement</button><div class='info' id='enM'></div></div>";
    montrer("vueListe");
    function info() { var f = F.filter(function (x) { return x.id === $("enF").value; })[0]; $("enI").textContent = f ? "Crédité sur " + f.benef + " (compte du contrat)." : ""; }
    $("enF").onchange = info; info();
    $("enEnv").onclick = function () {
      var f = F.filter(function (x) { return x.id === $("enF").value; })[0], dt = $("enD").value;
      if (!f || !dt) { $("enM").textContent = "⛔ Facture et date."; return; }
      if (!confirm("Encaissement " + f.id + " : " + gnf(f.montant) + " " + f.devise + " le " + dt.split("-").reverse().join("/") + " sur " + f.benef + " ?")) return;
      envoyerCom("recouvrement", { facture: f.id, date: dt }, "Encaissement " + f.id, function () { ficheFactureCom(f.id); });
    };
  }
  function formulaireRelanceCom(f) {
    $("titre").textContent = "Relance";
    $("vueListe").innerHTML = "<div class='carte'><h3>📞 Relance · " + esc(f.id) + "</h3><div class='info'>" + esc(f.client) + " · " + gnf(f.montant) + " " + esc(f.devise) + "</div>" +
      "<label>Mode</label><select id='rlM'><option>Appel</option><option>Visite</option><option>Courrier</option><option>E-mail</option><option>WhatsApp</option></select>" +
      "<label>Compte rendu</label><textarea id='rlC' rows='3'></textarea><label>Prochaine relance</label><input id='rlP' type='date' value='" + dateISO(Date.now() + 7 * 86400000) + "'>" +
      "<button class='bouton' id='rlEnv'>Enregistrer</button></div>";
    montrer("vueListe");
    $("rlEnv").onclick = function () { envoyerCom("relance", { facture: f.id, client: f.client, mode: $("rlM").value, commentaire: $("rlC").value.trim(), prochaine: $("rlP").value }, "Relance " + f.id, function () { ficheFactureCom(f.id); }); };
  }

  /* ---------- 🎯 Missions : créer, assigner, check-list, suivi ; clôture par DG / WALID ---------- */
  function droitMis() { return !!(S.agent && S.formulaires && S.formulaires.droits); }
  var rafMis = null;
  function rafraichirMis() {
    if (!S.url || !droitMis()) return Promise.resolve();
    if (rafMis) return rafMis;
    rafMis = api({ api: "missions" }).then(function (r) { r.recu = Date.now(); S.mis = r; return ecrire("mis", r); })
      .then(function () { rafMis = null; }, function (e) { rafMis = null; throw e; });
    return rafMis;
  }
  var COUL_MIS = { "En attente": "#e65100", "En cours": "#1565c0", "À clôturer": "#6a1b9a", "Terminée": "#2e7d32", "Annulée": "#777" };
  function misOuv(m) { return m.statut !== "Terminée" && m.statut !== "Annulée"; }
  function misAuj() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function misPour(m, nom) { return m.assignes.some(function (a) { return nomRH(a) === nomRH(nom); }); }
  function misAttente(id) { return S.file.filter(function (x) { return x.type === "mis" && x.donnees && x.donnees.id === id; }); }
  function misNbBadge() {
    var M = S.mis; if (!M) return 0;
    var fin = misAuj() + 86400000, moi = M.agent;
    return M.missions.filter(function (m) { return misOuv(m) && ((misPour(m, moi) && m.statut !== "À clôturer" && m.echeance && m.echeance < fin) || (M.direction && m.statut === "À clôturer")); }).length;
  }
  function envoyerMis(op, donnees, titre, suite) {
    var it = { type: "mis", op: op, jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: donnees, titre: titre, resume: "Missions", essais: 0 };
    soumettre(it).then(function (r) {
      var fin = function () { if (suite) suite(r); else afficherMis(); };
      if (r.ok && !r.enAttente) return rafraichirMis().catch(function () {}).then(function () { if (!/^☑|^☐/.test(titre)) alert("✅ " + r.titre + (r.message ? "\n" + r.message : "")); fin(); });
      alert((r.enAttente ? "📥 " : "⛔ ") + (r.titre || "") + "\n" + (r.message || "")); fin();
    });
  }
  function htmlMis(m) {
    var auj = misAuj(), ret = misOuv(m) && m.echeance && m.echeance < auj, jour = misOuv(m) && m.echeance >= auj && m.echeance < auj + 86400000;
    var nf = m.liste.filter(function (i) { return i.fait; }).length, att = misAttente(m.id).length;
    return "<div class='carte" + (att ? " att" : "") + "' data-mi='" + esc(m.id) + "' style='cursor:pointer" + (misOuv(m) ? "" : ";opacity:.6") + (m.prio === "Haute" && misOuv(m) ? ";border-left:4px solid #c62828" : "") + "'>" +
      "<div class='ligne' style='justify-content:space-between'><b>" + esc(m.titre) + "</b><span style='flex:0;white-space:nowrap;font-size:13px;font-weight:700;color:" + (COUL_MIS[m.statut] || "#999") + "'>" + esc(m.statut) + "</span></div>" +
      "<div class='info'>" + esc(m.assignes.join(", ")) + (m.par && !misPour(m, m.par) ? " · par " + esc(m.par) : "") + (m.rec ? " · 🔁 " + esc(m.rec.toLowerCase()) : "") +
      (m.liste.length ? " · ☑ " + nf + "/" + m.liste.length : "") + "</div>" +
      "<div style='font-size:13px;font-weight:700;color:" + (ret ? "#c62828" : jour ? "#e65100" : "var(--texte2,#888)") + "'>" + (m.echeance ? (ret ? "⏰ En retard · " : jour ? "Aujourd'hui · " : "Échéance ") + jourLib(m.echeance) : "Sans échéance") +
      (m.prio === "Haute" ? " · haute priorité" : "") + (att ? " · ⏳ en attente d'envoi" : "") + "</div></div>";
  }
  var MISV = { onglet: "moi", clos: false };
  function afficherMis(id) {
    $("titre").textContent = "Missions";
    var M = S.mis;
    if (!M) {
      $("vueListe").innerHTML = "<div class='carte'><h3>🎯 Missions</h3><p class='info'>Aucune donnée sur cet appareil : réseau puis ⟳.</p></div>"; montrer("vueListe");
      rafraichirMis().then(function () { if (S.mis) afficherMis(id); }).catch(function () {});
      return;
    }
    if (id && M.missions.some(function (m) { return m.id === id; })) { ficheMis(id); return; }
    var moi = M.agent, O = [["moi", "Mes missions"], ["donnees", "Confiées"]].concat(M.direction ? [["cloturer", "À clôturer (" + M.missions.filter(function (m) { return m.statut === "À clôturer"; }).length + ")"], ["equipe", "Équipe"]] : []);
    var envoi = S.file.filter(function (x) { return x.type === "mis"; }).length;
    var h = "<div class='carte'><h3>🎯 Missions</h3><div class='info'>" + esc(moi) + (M.direction ? " · clôture des missions" : "") + " · données du " + dateCourte(M.recu || M.genere) + "</div>" +
      "<button class='bouton' id='miNouv'>➕ Nouvelle mission</button><div class='onglets' style='margin-top:10px'>" +
      O.map(function (o) { return "<button data-o='" + o[0] + "' class='" + (MISV.onglet === o[0] ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + o[1] + "</button>"; }).join("") + "</div>" +
      (MISV.onglet !== "equipe" ? "<label style='font-weight:400'><input type='checkbox' id='miClos' style='width:auto'" + (MISV.clos ? " checked" : "") + "> afficher les missions closes</label>" : "") + "</div>" +
      (envoi ? "<div class='carte att'>⏳ " + envoi + " opération(s) en attente d'envoi.</div>" : "") + "<div id='miL'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    $("miNouv").onclick = function () { formulaireMis(null); };
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-o]"), function (b) { b.onclick = function () { MISV.onglet = b.getAttribute("data-o"); afficherMis(); }; });
    if ($("miClos")) $("miClos").onchange = function () { MISV.clos = this.checked; afficherMis(); };
    var auj = misAuj(), C = $("miL");
    if (MISV.onglet === "equipe") {
      var P = {};
      M.missions.filter(misOuv).forEach(function (m) { m.assignes.forEach(function (a) {
        var o = P[a] = P[a] || { att: 0, cours: 0, clo: 0, ret: 0 };
        if (m.statut === "À clôturer") o.clo++; else if (m.statut === "En cours") o.cours++; else o.att++;
        if (m.statut !== "À clôturer" && m.echeance && m.echeance < auj) o.ret++;
      }); });
      C.innerHTML = "<div class='carte'><h3>Tableau d'équipe</h3><table><tr><td><b>Agent</b></td><td class='v'><b>Attente</b></td><td class='v'><b>En cours</b></td><td class='v'><b>À clôt.</b></td><td class='v'><b>Retard</b></td></tr>" +
        Object.keys(P).sort().map(function (a) { var o = P[a]; return "<tr data-ag='" + esc(a) + "' style='cursor:pointer'><td>" + esc(a) + "</td><td class='v'>" + o.att + "</td><td class='v'>" + o.cours + "</td><td class='v'>" + o.clo + "</td><td class='v'" + (o.ret ? " style='color:#c62828;font-weight:700'" : "") + ">" + o.ret + "</td></tr>"; }).join("") +
        "</table><div class='info'>Touchez un agent pour voir ses missions.</div></div><div id='miAg'></div>";
      Array.prototype.forEach.call(C.querySelectorAll("[data-ag]"), function (tr) {
        tr.onclick = function () { var a = tr.getAttribute("data-ag"); $("miAg").innerHTML = M.missions.filter(function (m) { return misOuv(m) && misPour(m, a); }).sort(function (x, y) { return (x.echeance || 9e15) - (y.echeance || 9e15); }).map(htmlMis).join("");
          Array.prototype.forEach.call($("miAg").querySelectorAll("[data-mi]"), function (el) { el.onclick = function () { ficheMis(el.getAttribute("data-mi")); }; }); };
      });
      return;
    }
    var L = M.missions.filter(function (m) {
      if (!MISV.clos && !misOuv(m)) return false;
      if (MISV.onglet === "moi") return misPour(m, moi);
      if (MISV.onglet === "donnees") return nomRH(m.par) === nomRH(moi) && !misPour(m, moi);
      return m.statut === "À clôturer";
    }).sort(function (a, b) { return (misOuv(b) - misOuv(a)) || (a.echeance || 9e15) - (b.echeance || 9e15) || ((a.prio === "Haute") ? -1 : 1); });
    C.innerHTML = L.map(htmlMis).join("") || "<p class='info' style='padding:0 4px'>Aucune mission ici.</p>";
    Array.prototype.forEach.call(C.querySelectorAll("[data-mi]"), function (el) { el.onclick = function () { ficheMis(el.getAttribute("data-mi")); }; });
  }
  function ficheMis(id) {
    var M = S.mis, m = M.missions.filter(function (x) { return x.id === id; })[0];
    if (!m) { afficherMis(); return; }
    $("titre").textContent = m.id;
    var moi = M.agent, ass = misPour(m, moi), cre = nomRH(m.par) === nomRH(moi), dir = M.direction, ouv = misOuv(m), att = misAttente(m.id).length;
    var h = htmlMis(m).replace("cursor:pointer", "") + "<div class='carte'>" + (m.desc ? "<div style='white-space:pre-line'>" + esc(m.desc) + "</div>" : "<div class='info'>Pas de description.</div>") +
      "<div class='info' style='margin-top:6px'>" + esc(m.id) + " · créée par " + esc(m.par) + " le " + jourLib(m.cree) + (m.source && m.source !== "DuoCore" ? " · " + esc(m.source) : "") + "</div></div>";
    if (m.liste.length) h += "<div class='carte'><h3>Check-list</h3>" + m.liste.map(function (i, k) {
      return "<label style='font-weight:400;display:flex;gap:8px;align-items:flex-start;margin:6px 0'><input type='checkbox' class='miCk' data-k='" + k + "' style='width:auto;margin-top:3px'" + (i.fait ? " checked" : "") + (ouv && (ass || cre || dir) && !att ? "" : " disabled") + ">" +
        "<span" + (i.fait ? " style='text-decoration:line-through;color:#888'" : "") + ">" + esc(i.t) + (i.fait ? " <small class='info'>(" + esc(i.par) + " " + jourLib(i.q) + ")</small>" : "") + "</span></label>"; }).join("") + "</div>";
    if (ouv && !att) {
      h += "<div class='carte'><label>Commentaire</label><input id='miCom'>";
      if (ass) h += (m.statut !== "En cours" && m.statut !== "À clôturer" ? "<button class='bouton second' id='miCours'>▶ Je commence (en cours)</button>" : "") +
        (m.statut !== "À clôturer" ? "<button class='bouton' id='miSig' style='background:#6a1b9a'>✅ Signaler terminée (à clôturer)</button>" : "<div class='info'>Signalée terminée : en attente de clôture par DG / WALID.</div>");
      if (dir) h += "<div class='ligne'><button class='bouton' id='miFin' style='background:var(--vert)'>🏁 Clôturer : terminée</button><button class='bouton' id='miAnn' style='background:var(--rouge)'>⛔ Annuler</button></div>";
      h += "<button class='bouton second' id='miCm'>💬 Ajouter le commentaire</button>" + (cre || dir ? "<button class='bouton second' id='miMod'>✏️ Modifier</button>" : "") + "<div class='info' id='miMsg'></div></div>";
    }
    h += "<div class='carte'><h3>Historique</h3>" + m.historique.slice().reverse().map(function (x) { return "<div class='info'>" + dateCourte(x.q) + " · " + esc(x.a) + " · " + esc(x.act) + (x.c ? " — " + esc(x.c) : "") + "</div>"; }).join("") + "</div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    function com() { return $("miCom") ? $("miCom").value.trim() : ""; }
    var retour = function () { ficheMis(m.id); };
    Array.prototype.forEach.call(document.querySelectorAll(".miCk"), function (c) {
      c.onchange = function () { var k = +c.getAttribute("data-k"); m.liste[k].fait = c.checked; envoyerMis("cocher", { id: m.id, index: k, fait: c.checked }, (c.checked ? "☑ " : "☐ ") + m.liste[k].t, retour); };
    });
    if ($("miCours")) $("miCours").onclick = function () { envoyerMis("statut", { id: m.id, version: m.version, statut: "En cours", commentaire: com() }, "En cours " + m.id, retour); };
    if ($("miSig")) $("miSig").onclick = function () {
      var reste = m.liste.filter(function (i) { return !i.fait; }).length;
      if (!confirm((reste ? reste + " étape(s) non cochée(s). " : "") + "Signaler « " + m.titre + " » terminée ? DG / WALID la clôtureront.")) return;
      envoyerMis("statut", { id: m.id, version: m.version, statut: "À clôturer", commentaire: com() }, "À clôturer " + m.id, retour);
    };
    if ($("miFin")) $("miFin").onclick = function () { if (confirm("Clôturer « " + m.titre + " » (terminée) ?" + (m.rec ? "\nLa suivante (" + m.rec.toLowerCase() + ") sera créée." : ""))) envoyerMis("statut", { id: m.id, version: m.version, statut: "Terminée", commentaire: com() }, "Clôture " + m.id, retour); };
    if ($("miAnn")) $("miAnn").onclick = function () { if (!com()) { $("miMsg").textContent = "⛔ Indiquez la raison dans le commentaire."; return; } if (confirm("Annuler « " + m.titre + " » ?")) envoyerMis("statut", { id: m.id, version: m.version, statut: "Annulée", commentaire: com() }, "Annulation " + m.id, retour); };
    if ($("miCm")) $("miCm").onclick = function () { if (!com()) { $("miMsg").textContent = "⛔ Écrivez le commentaire."; return; } envoyerMis("commenter", { id: m.id, commentaire: com() }, "Commentaire " + m.id, retour); };
    if ($("miMod")) $("miMod").onclick = function () { formulaireMis(m); };
  }
  function formulaireMis(src) {
    var M = S.mis, s = src || {}, lst = (s.liste || []).map(function (i) { return { t: i.t, fait: i.fait, par: i.par, q: i.q }; });
    $("titre").textContent = src ? "Modifier " + s.id : "Nouvelle mission";
    var demain = new Date(misAuj() + 86400000);
    $("vueListe").innerHTML = "<div class='carte'><h3>" + (src ? "✏️ " + esc(s.id) : "➕ Nouvelle mission") + "</h3>" +
      "<label>Titre</label><input id='mfT' value='" + esc(s.titre || "") + "'><label>Description</label><textarea id='mfD' rows='3'>" + esc(s.desc || "") + "</textarea>" +
      "<label>Assignée à (une ou plusieurs personnes)</label><div id='mfA'>" + M.agents.map(function (a) {
        return "<label style='font-weight:400;display:inline-block;margin:2px 10px 2px 0'><input type='checkbox' class='mfAg' value='" + esc(a) + "' style='width:auto'" + ((s.assignes || []).some(function (x) { return nomRH(x) === nomRH(a); }) ? " checked" : "") + "> " + esc(a) + "</label>"; }).join("") + "</div>" +
      "<div class='ligne'><div><label>Échéance</label><input id='mfE' type='date' value='" + dateISO(s.echeance || demain.getTime()) + "'></div><div><label>Priorité</label><select id='mfP'>" +
      M.priorites.map(function (p) { return "<option" + (p === (s.prio || "Normale") ? " selected" : "") + ">" + p + "</option>"; }).join("") + "</select></div></div>" +
      "<label>Récurrence</label><select id='mfR'>" + M.recurrences.map(function (r) { return "<option value='" + r + "'" + (r === (s.rec || "") ? " selected" : "") + ">" + (r || "Aucune (une seule fois)") + "</option>"; }).join("") + "</select>" +
      "<div class='info'>Récurrente : à la clôture, la suivante est créée automatiquement avec la check-list remise à zéro.</div>" +
      "<label>Check-list (étapes à cocher)</label><div id='mfL'></div><div class='ligne'><input id='mfLn' placeholder='Nouvelle étape'><button class='bouton second' id='mfLa' style='flex:0;width:auto'>➕</button></div>" +
      (src ? "<label>Commentaire (raison du changement)</label><input id='mfC'>" : "") +
      "<button class='bouton' id='mfEnv'>" + (src ? "Enregistrer" : "📤 Créer et notifier") + "</button><div class='info' id='mfM'></div></div>";
    montrer("vueListe");
    function dessiner() {
      $("mfL").innerHTML = lst.map(function (i, k) { return "<div class='ligne' style='align-items:center'><span style='flex:1'>" + (i.fait ? "☑ " : "☐ ") + esc(i.t) + "</span><button class='bouton second' data-x='" + k + "' style='flex:0;width:auto;padding:4px 8px'>✕</button></div>"; }).join("") || "<div class='info'>Aucune étape.</div>";
      Array.prototype.forEach.call($("mfL").querySelectorAll("[data-x]"), function (b) { b.onclick = function () { lst.splice(+b.getAttribute("data-x"), 1); dessiner(); }; });
    }
    dessiner();
    function ajouter() { var t = $("mfLn").value.trim(); if (t) { lst.push({ t: t, fait: false }); $("mfLn").value = ""; dessiner(); } }
    $("mfLa").onclick = ajouter; $("mfLn").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); ajouter(); } };
    $("mfEnv").onclick = function () {
      if ($("mfLn").value.trim()) ajouter();
      var d = { titre: $("mfT").value.trim(), desc: $("mfD").value.trim(), assignes: Array.prototype.filter.call(document.querySelectorAll(".mfAg"), function (c) { return c.checked; }).map(function (c) { return c.value; }),
        echeance: $("mfE").value, prio: $("mfP").value, rec: $("mfR").value, liste: lst };
      var err = !d.titre ? "titre" : !d.assignes.length ? "au moins une personne" : !d.echeance ? "échéance" : "";
      if (err) { $("mfM").textContent = "⛔ Indiquez : " + err + "."; return; }
      if (src) { d.id = s.id; d.version = s.version; d.commentaire = $("mfC").value.trim(); envoyerMis("modifier", d, "Modification " + s.id, function () { ficheMis(s.id); }); }
      else envoyerMis("creer", d, "Mission " + d.titre, function (r) { if (r && r.id) ficheMis(r.id); else afficherMis(); });
    };
  }

  /* ---------- 🏭 Comptes fournisseurs / prestataires (tous les agents Finances) ---------- */
  var FOUR = { liste: null, fiches: {}, q: "" };
  /* 🏭 Fournisseurs à deux niveaux : le FOURNISSEUR (fiche unique) et ses COMPTES (société + projet, soldes séparés). */
  function fourRaison(f) { return f.raison || f.nom; }
  function fourGroupes(L) {   // { raison: [comptes] } ; le compte général (sans société ni projet) en premier
    var G = {}, ordre = [];
    L.forEach(function (f) { var r = fourRaison(f); if (!G[r]) { G[r] = []; ordre.push(r); } G[r].push(f); });
    ordre.forEach(function (r) { G[r].sort(function (a, b) { return (a.societe || a.projet ? 1 : 0) - (b.societe || b.projet ? 1 : 0) || a.nom.localeCompare(b.nom); }); });
    return { G: G, ordre: ordre };
  }
  function fourLibCompte(f) { return [f.societe || "", f.projet || ""].filter(String).join(" · ") || "Compte général"; }
  function fourCoord(raison) {   // coordonnées du fournisseur (compte général, sinon le premier)
    var L = ((S.fin && S.fin.fournisseurs) || []).filter(function (f) { return fourRaison(f) === raison; });
    return L.filter(function (f) { return !f.societe && !f.projet; })[0] || L[0] || { raison: raison, nom: raison };
  }
  function chargerFour(fn) {
    api({ api: "finFour" }).then(function (r) { r.recu = Date.now(); FOUR.liste = r; ecrire("four", r); fn(""); }, function (e) { fn("⛔ " + e.message + " (dernière copie affichée)"); });
  }
  function afficherFournisseurs() {
    $("titre").textContent = "Fournisseurs";
    var dessiner = function (msg) {
      var L = (FOUR.liste && FOUR.liste.fournisseurs) || [], P = [];
      L.forEach(function (f) { if (f.projet && P.indexOf(f.projet) < 0) P.push(f.projet); });
      $("vueListe").innerHTML = "<div class='carte'><h3>🏭 Fournisseurs et prestataires</h3><div class='info'>" + (FOUR.liste ? "Données du " + dateCourte(FOUR.liste.recu) : "") + (msg ? " · " + esc(msg) : "") + "</div>" +
        "<button class='bouton' id='foNouv'>➕ Nouveau fournisseur / prestataire</button>" +
        "<div class='ligne'><input id='foQ' placeholder='Rechercher' value='" + esc(FOUR.q) + "'><select id='foS' style='flex:0 0 140px'><option value=''>Toutes sociétés</option>" +
        ["AB", "M2S", "CASAFINO"].map(function (x) { return "<option" + (FOUR.soc === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" +
        "<select id='foP'><option value=''>Tous les projets</option>" + P.sort().map(function (x) { return "<option" + (x === FOUR.projet ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select>" +
        "<label style='font-weight:400'><input type='checkbox' id='foI' style='width:auto'" + (FOUR.inactifs ? " checked" : "") + "> afficher les comptes désactivés</label>" +
        "<div class='info'>Un fournisseur peut avoir plusieurs comptes (société, projet), chacun avec son solde. Solde = facturé − payé (positif : reste dû ; négatif : avance).</div></div><div id='foL'></div>";
      montrer("vueListe");
      var liste = function () {
        FOUR.q = $("foQ").value; FOUR.soc = $("foS").value; FOUR.projet = $("foP").value; FOUR.inactifs = $("foI").checked; var q = FOUR.q.trim().toLowerCase();
        var Lf = L.filter(function (f) { return (FOUR.inactifs || f.actif !== false) && (!FOUR.soc || f.societe === FOUR.soc) && (!FOUR.projet || f.projet === FOUR.projet) &&
          (!q || (f.nom + " " + fourRaison(f) + " " + (f.projet || "")).toLowerCase().indexOf(q) >= 0); });
        var tot = Lf.reduce(function (a, f) { a.fa += f.facture || 0; a.pa += f.paye || 0; a.co += f.cours || 0; return a; }, { fa: 0, pa: 0, co: 0 }), h = "";
        if (FOUR.projet || FOUR.soc) h += "<div class='carte'><h3>" + (FOUR.projet ? "📁 " + esc(FOUR.projet) : "") + (FOUR.projet && FOUR.soc ? " · " : "") + esc(FOUR.soc) + "</h3><table><tr><td>Comptes</td><td class='v'>" + Lf.length + "</td></tr>" +
          "<tr><td>Facturé</td><td class='v'>" + gnf(tot.fa) + " GNF</td></tr><tr><td>Payé</td><td class='v'>" + gnf(tot.pa) + " GNF</td></tr>" + (tot.co ? "<tr><td>En cours de validation</td><td class='v'>" + gnf(tot.co) + " GNF</td></tr>" : "") +
          "<tr><td><b>" + (tot.fa - tot.pa >= 0 ? "Reste dû" : "Avance versée") + "</b></td><td class='v'><b>" + gnf(Math.abs(tot.fa - tot.pa)) + " GNF</b></td></tr></table></div>";
        var g = fourGroupes(Lf);
        h += g.ordre.map(function (r) {
          var C = g.G[r], so = 0, fa = 0, pa = 0, ech = 0, ty = C[0].type;
          C.forEach(function (f) { so += f.solde || 0; fa += f.facture || 0; pa += f.paye || 0; ech += f.echu || 0; });
          return "<div class='carte' data-fr='" + esc(r) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + (ty === "Prestataire" ? "🛠️ " : "🏭 ") + esc(r) + "</b>" +
            "<b style='flex:0;white-space:nowrap;color:" + (so > 0 ? "#c62828" : so < 0 ? "#1565c0" : "inherit") + "'>" + gnf(so) + " GNF</b></div>" +
            "<div class='info'>Facturé " + gnf(fa) + " · payé " + gnf(pa) + (ech ? " · <b style='color:#c62828'>échu " + gnf(ech) + "</b>" : "") + " · " + C.length + " compte" + (C.length > 1 ? "s" : "") + "</div>" +
            "<div class='info' style='font-size:12.5px'>" + C.map(function (f) { return esc(fourLibCompte(f)) + " : " + gnf(f.solde || 0) + (f.actif === false ? " (désactivé)" : ""); }).join(" · ") + "</div></div>";
        }).join("") || "<p class='info' style='padding:0 4px'>" + (FOUR.liste ? "Aucun fournisseur." : "Réseau nécessaire la 1re fois.") + "</p>";
        $("foL").innerHTML = h;
        Array.prototype.forEach.call($("foL").querySelectorAll("[data-fr]"), function (el) { el.onclick = function () { ficheFourMere(el.getAttribute("data-fr")); }; });
      };
      $("foQ").oninput = liste; $("foS").onchange = liste; $("foP").onchange = liste; $("foI").onchange = liste; liste();
      $("foNouv").onclick = function () { formulaireFourMere(null); };
    };
    dessiner(FOUR.liste ? "mise à jour…" : "chargement…");
    chargerFour(function (m) { if ($("foL")) dessiner(m); });
  }
  /* Fiche d'un fournisseur : coordonnées, total et ses comptes. */
  function ficheFourMere(raison) {
    $("titre").textContent = raison;
    var dessiner = function (msg) {
      var C = ((FOUR.liste && FOUR.liste.fournisseurs) || []).filter(function (f) { return fourRaison(f) === raison; }), k = fourCoord(raison);
      C = fourGroupes(C).G[raison] || [];
      var so = 0, fa = 0, pa = 0; C.forEach(function (f) { so += f.solde || 0; fa += f.facture || 0; pa += f.paye || 0; });
      var h = "<div class='carte'><h3>" + (k.type === "Prestataire" ? "🛠️ " : "🏭 ") + esc(raison) + "</h3><div class='info'>" +
        [k.type || "Fournisseur", k.article ? "catégorie " + k.article : "", k.tva ? "assujetti TVA 18 %" : "non assujetti TVA", k.tel ? "☎ " + k.tel : "", k.nif ? "NIF " + k.nif : "", k.rib ? "RIB " + k.rib : ""].filter(String).map(esc).join(" · ") + (msg ? " · " + esc(msg) : "") + "</div>" +
        "<table><tr><td>Facturé (tous comptes)</td><td class='v'>" + gnf(fa) + " GNF</td></tr><tr><td>Payé</td><td class='v'>" + gnf(pa) + " GNF</td></tr><tr><td><b>" + (so >= 0 ? "Reste dû" : "Avance chez lui") + "</b></td><td class='v'><b style='color:" + (so > 0 ? "#c62828" : "#1565c0") + "'>" + gnf(Math.abs(so)) + " GNF</b></td></tr></table>" +
        "<div class='ligne'><button class='bouton' id='fmCpt'>➕ Nouveau compte</button><button class='bouton second' id='fmMod'>✏️ Modifier le fournisseur</button><button class='bouton second' id='fmDem'>➕ Demande</button></div></div>" +
        "<div class='carte'><h3>Comptes (" + C.length + ")</h3>" + (C.map(function (f) {
          return "<div data-fo='" + esc(f.nom) + "' style='cursor:pointer;padding:8px 0;border-bottom:1px solid var(--bord)" + (f.actif === false ? ";opacity:.55" : "") + "'><div class='ligne' style='justify-content:space-between'><b>" + esc(fourLibCompte(f)) + "</b>" +
            "<b style='flex:0;white-space:nowrap;color:" + (f.solde > 0 ? "#c62828" : f.solde < 0 ? "#1565c0" : "inherit") + "'>" + gnf(f.solde || 0) + " GNF</b></div>" +
            "<div class='info'>Facturé " + gnf(f.facture || 0) + " · payé " + gnf(f.paye || 0) + (f.cours ? " · en cours " + gnf(f.cours) : "") + (f.echu ? " · <b style='color:#c62828'>échu " + gnf(f.echu) + "</b>" : "") + (f.actif === false ? " · désactivé" : "") + "</div></div>";
        }).join("") || "<div class='info'>Aucun compte.</div>") + "</div>";
      $("vueListe").innerHTML = h; montrer("vueListe");
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-fo]"), function (el) { el.onclick = function () { ficheFournisseur(el.getAttribute("data-fo")); }; });
      $("fmCpt").onclick = function () { formulaireCompteFour(raison, null); };
      $("fmMod").onclick = function () { formulaireFourMere(raison); };
      $("fmDem").onclick = function () { formulaireFin({ type: "Règlement fournisseur", fournisseur: (C.filter(function (f) { return f.actif !== false; })[0] || {}).nom || raison }); };
    };
    dessiner(FOUR.liste ? "" : "chargement…");
    if (!FOUR.liste) chargerFour(function (m) { dessiner(m); });
  }
  function envoyerFour(d, titre, apres) {
    var it = { type: "fin", op: "fournisseur", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: d, titre: titre, resume: "Finances", essais: 0 };
    soumettre(it).then(function (r) {
      alert((r.ok ? (r.enAttente ? "📥 " : "✅ ") : "⛔ ") + (r.titre || "") + "\n" + (r.message || ""));
      if (!r.ok) return;
      if (d.projet && S.fin && S.fin.projets && S.fin.projets.indexOf(d.projet) < 0) S.fin.projets.push(d.projet);
      FOUR.liste = null; FOUR.fiches = {};
      rafraichirFin().catch(function () {}).then(function () { if (r.enAttente) afficherFournisseurs(); else chargerFour(function () { apres(r); }); });
    });
  }
  /* Création / modification d'un FOURNISSEUR (niveau 1) : à la création, son compte général est créé d'office. */
  function formulaireFourMere(raison) {
    var F = S.fin || {}, nouveau = !raison, k = nouveau ? {} : fourCoord(raison), C0 = (F.categories || []).slice();
    if (k.article && C0.indexOf(k.article) < 0) C0.push(k.article);
    function opt(L, v, vide) { return (vide !== undefined ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { return "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; }).join(""); }
    $("titre").textContent = nouveau ? "Nouveau fournisseur" : raison;
    $("vueListe").innerHTML = "<div class='carte'><h3>" + (nouveau ? "➕ Nouveau fournisseur / prestataire" : "✏️ " + esc(raison)) + "</h3>" +
      (nouveau ? "<label>Raison sociale</label><input id='cfR'>" : "") +
      "<div class='ligne'><div><label>Type</label><select id='cfT'>" + opt(["Fournisseur", "Prestataire"], k.type || "Fournisseur") + "</select></div>" +
      "<div><label>Assujetti à la TVA 18 %</label><select id='cfV'>" + opt(["Non", "Oui"], k.tva ? "Oui" : "Non") + "</select></div></div>" +
      "<label>Catégorie de dépense habituelle</label><select id='cfA'>" + opt(C0, k.article || "", "— aucune —") + "</select>" +
      "<div class='ligne'><div><label>Téléphone</label><input id='cfTe' value='" + esc(k.tel || "") + "'></div><div><label>NIF</label><input id='cfN' value='" + esc(k.nif || "") + "'></div></div>" +
      "<label>RIB / compte bancaire</label><input id='cfRi' value='" + esc(k.rib || "") + "'>" +
      "<div class='info'>" + (nouveau ? "Un compte général (toutes sociétés, sans projet) est créé d'office. Vous pourrez ensuite lui ajouter des comptes par société et projet." : "Ces informations s'appliquent à tous ses comptes.") + "</div>" +
      "<button class='bouton' id='cfEnv'>" + (nouveau ? "Créer le fournisseur" : "Enregistrer") + "</button><div class='info' id='cfM'></div></div>";
    montrer("vueListe");
    $("cfEnv").onclick = function () {
      var d = { type: $("cfT").value, tva: $("cfV").value === "Oui", article: $("cfA").value, tel: $("cfTe").value.trim(), nif: $("cfN").value.trim(), rib: $("cfRi").value.trim() };
      if (nouveau) {
        d.raison = $("cfR").value.replace(/\s+/g, " ").trim(); d.nom = d.raison; d.creer = true; d.general = true; d.societe = ""; d.projet = "";
        if (!d.raison) { $("cfM").textContent = "⛔ Indiquez la raison sociale."; return; }
        if ((F.fournisseurs || []).some(function (x) { return fourRaison(x).toLowerCase() === d.raison.toLowerCase() || x.nom.toLowerCase() === d.raison.toLowerCase(); })) { $("cfM").textContent = "⛔ Ce fournisseur existe déjà : ouvrez sa fiche pour lui ajouter un compte."; return; }
      } else { d.raison = raison; d.mere = true; d.nom = k.nom || raison; }
      envoyerFour(d, (nouveau ? "Nouveau fournisseur " : "Fournisseur ") + d.raison, function () { ficheFourMere(d.raison); });
    };
  }
  /* Création d'un COMPTE du fournisseur (société + projet) ou modification (actif). */
  function formulaireCompteFour(raison, f) {
    var F = S.fin || {}, nouveau = !f, k = fourCoord(raison), P = (F.projets || []).slice();
    var dir = ["DG", "WALID"].indexOf(String(S.agent.nom).toUpperCase()) >= 0;
    var existants = (F.fournisseurs || []).filter(function (x) { return fourRaison(x) === raison; });
    $("titre").textContent = nouveau ? "Nouveau compte" : f.nom;
    $("vueListe").innerHTML = "<div class='carte'><h3>" + (nouveau ? "➕ Nouveau compte · " + esc(raison) : "✏️ " + esc(fourLibCompte(f)) + " · " + esc(raison)) + "</h3>" +
      (nouveau ? "<div class='ligne'><div><label>Société bénéficiaire</label><select id='ccS'><option value=''>— toutes —</option><option>AB</option><option>M2S</option><option>CASAFINO</option></select></div>" +
        "<div><label>Projet (facultatif)</label><input id='ccP' list='ccPL' placeholder='ex. Dépôt Nongo'><datalist id='ccPL'>" + P.map(function (x) { return "<option value='" + esc(x) + "'>"; }).join("") + "</datalist></div></div>" +
        "<div class='info'>Société pour laquelle l'achat ou la prestation est fait. Le règlement reste libre : payé par une autre société, la dette va en 🔁 Inter-sociétés. Un projet nouveau est ajouté à la liste.</div>" +
        "<div class='info' style='margin-top:10px'>Nom du compte : <b id='ccNomV'></b>" + (dir ? " <button class='lien' id='ccNomE'>✏️ modifier</button>" : "") + "</div><input id='ccNom' style='display:none'>"
      : "<div class='info'>Société : " + esc(f.societe || "toutes") + " · projet : " + esc(f.projet || "aucun") + "</div><label style='font-weight:400'><input type='checkbox' id='ccAc' style='width:auto'" + (f.actif === false ? "" : " checked") + "> compte actif (proposé dans les demandes)</label>") +
      "<button class='bouton' id='ccEnv'>" + (nouveau ? "Créer le compte" : "Enregistrer") + "</button><div class='info' id='ccM'></div></div>";
    montrer("vueListe");
    var manuel = false;
    function proposer() {
      if (manuel) return;
      var base = [raison, $("ccS").value, $("ccP").value.replace(/\s+/g, " ").trim()].filter(String).join(" — "), nom = base, n = 2;
      while ((F.fournisseurs || []).some(function (x) { return x.nom.toLowerCase() === nom.toLowerCase(); })) nom = base + " (" + (n++) + ")";
      $("ccNom").value = nom; $("ccNomV").textContent = nom;
    }
    if (nouveau) {
      $("ccS").onchange = proposer; $("ccP").oninput = proposer; proposer();
      if ($("ccNomE")) $("ccNomE").onclick = function () { manuel = true; $("ccNom").style.display = ""; $("ccNomE").style.display = "none"; $("ccNom").focus(); };
      $("ccNom").oninput = function () { $("ccNomV").textContent = $("ccNom").value; };
    }
    $("ccEnv").onclick = function () {
      var d;
      if (nouveau) {
        d = { creer: true, nom: $("ccNom").value.replace(/\s+/g, " ").trim(), raison: raison, societe: $("ccS").value, projet: $("ccP").value.replace(/\s+/g, " ").trim(),
              type: k.type || "Fournisseur", article: k.article || "", tva: !!k.tva, tel: k.tel || "", nif: k.nif || "", rib: k.rib || "" };
        if (existants.some(function (x) { return (x.societe || "") === d.societe && (x.projet || "").toLowerCase() === d.projet.toLowerCase(); })) { $("ccM").textContent = "⛔ Ce fournisseur a déjà un compte pour cette société et ce projet."; return; }
        if (!d.nom || (F.fournisseurs || []).some(function (x) { return x.nom.toLowerCase() === d.nom.toLowerCase(); })) { $("ccM").textContent = "⛔ Nom de compte vide ou déjà pris."; return; }
      } else d = { nom: f.nom, actif: $("ccAc").checked };
      envoyerFour(d, (nouveau ? "Nouveau compte " : "Compte ") + d.nom, function (r) { if (nouveau) ficheFourMere(raison); else ficheFournisseur(f.nom); });
    };
  }
  /* 🔁 Comptes entre sociétés : ce que chaque société doit aux autres (paiements faits pour son compte). */
  function afficherInterco() {
    $("titre").textContent = "Inter-sociétés";
    $("vueListe").innerHTML = "<div class='carte'><h3>🔁 Comptes entre sociétés</h3><p class='info'>⏳ Chargement…</p></div>"; montrer("vueListe");
    api({ api: "finInterco" }).then(function (r) {
      var SOC = ["AB", "M2S", "CASAFINO"], NOMS = { AB: "AB", M2S: "M2S", CASAFINO: "CasaFino" }, paires = [["CASAFINO", "AB"], ["CASAFINO", "M2S"], ["M2S", "AB"]];
      function net(a, b) { return (r.soldes[a + "|" + b] || 0) - (r.soldes[b + "|" + a] || 0); }   // > 0 : a doit à b
      var h = "<div class='carte pleine'><h3>🔁 Dettes entre sociétés</h3><div class='info'>Paiements faits par une société pour le compte d'une autre − remboursements − compensations / apports.</div><table>" +
        paires.map(function (p) { var v = net(p[0], p[1]), a = v >= 0 ? p[0] : p[1], b = v >= 0 ? p[1] : p[0];
          return "<tr><td><b>" + NOMS[a] + "</b> doit à <b>" + NOMS[b] + "</b></td><td class='v' style='color:" + (v ? "#c62828" : "inherit") + "'>" + gnf(Math.abs(v)) + " GNF</td></tr>"; }).join("") + "</table>" +
        (r.direction ? "<div class='ligne'><button class='bouton second' id='icRemb'>💸 Remboursement (mouvement)</button><button class='bouton second' id='icComp'>⚖️ Compensation / apport</button></div>" : "") + "</div>";
      paires.forEach(function (p) {
        var solde = 0, L = r.mouvements.filter(function (m) { return (m.entite === p[0] && m.societe === p[1]) || (m.entite === p[1] && m.societe === p[0]); });
        if (!L.length) return;
        h += "<div class='carte'><h3>" + NOMS[p[0]] + " ↔ " + NOMS[p[1]] + "</h3><div class='info'>Solde positif : " + NOMS[p[0]] + " doit à " + NOMS[p[1]] + ".</div><table><tr><td><b>Date</b></td><td><b>Opération</b></td><td class='v'><b>Dû</b></td><td class='v'><b>Remb.</b></td><td class='v'><b>Solde</b></td></tr>" +
          L.map(function (m) { var sg = m.entite === p[0] ? 1 : -1; solde += sg * (m.du - m.rembourse);
            return "<tr" + (m.no ? " data-no='" + esc(m.no) + "' style='cursor:pointer'" : "") + "><td>" + jourLib(m.date).substring(0, 5) + "</td><td style='white-space:normal'>" + esc(m.op) + "<div class='info' style='font-size:11px'>" + esc(NOMS[m.entite] + " doit à " + NOMS[m.societe]) + (m.no ? " · " + esc(m.no) : "") + "</div></td><td class='v'>" + (m.du ? gnf(m.du) : "") + "</td><td class='v'>" + (m.rembourse ? gnf(m.rembourse) : "") + "</td><td class='v'><b>" + gnf(solde) + "</b></td></tr>"; }).join("") + "</table></div>";
      });
      if (r.enCours.length) h += "<div class='carte'><h3>En cours (pas encore dans la dette)</h3>" + r.enCours.map(function (c) { return "<div class='info' data-no='" + esc(c.no) + "' style='cursor:pointer'>" + esc(c.no) + " · " + esc(c.societe) + " · " + esc(c.op) + " · <b>" + gnf(c.gnf) + " GNF</b> · " + esc(c.statut) + "</div>"; }).join("") + "</div>";
      $("vueListe").innerHTML = h;
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-no]"), function (el) { el.onclick = function () { var no = el.getAttribute("data-no"); if (S.fin && S.fin.demandes.some(function (x) { return x.no === no; })) ouvrirDemandeFin(no); }; });
      if ($("icRemb")) $("icRemb").onclick = function () { formulaireFin({ type: "Mouvement de trésorerie", op: S.fin.opRemb }); };
      if ($("icComp")) $("icComp").onclick = function () {
        var o = SOC.map(function (x) { return "<option value='" + x + "'>" + NOMS[x] + "</option>"; }).join("");
        $("vueListe").innerHTML = "<div class='carte'><h3>⚖️ Compensation / apport définitif</h3><div class='info'>Diminue la dette d'une société envers une autre, sans mouvement d'argent.</div>" +
          "<div class='ligne'><div><label>Société débitrice</label><select id='icE'>" + o + "</select></div><div><label>Envers (créancière)</label><select id='icS'>" + o + "</select></div></div>" +
          "<label>Nature</label><select id='icN'><option>Compensation</option><option>Apport définitif</option></select>" +
          "<label>Montant (GNF)</label><input id='icM' inputmode='decimal'><label>Commentaire (obligatoire)</label><input id='icC'><button class='bouton' id='icEnv'>Enregistrer</button><div class='info' id='icMsg'></div></div>";
        $("icS").value = "AB";
        $("icEnv").onclick = function () {
          var m = parseFloat(String($("icM").value).replace(/\s/g, "").replace(",", ".")), c = $("icC").value.trim(), e = $("icE").value, so = $("icS").value;
          if (e === so) { $("icMsg").textContent = "⛔ Deux sociétés différentes."; return; }
          if (!(m > 0) || !c) { $("icMsg").textContent = "⛔ Montant et commentaire."; return; }
          if (!confirm($("icN").value + " de " + gnf(m) + " GNF : dette de " + NOMS[e] + " envers " + NOMS[so] + " ?")) return;
          var it = { type: "fin", op: "interco", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: { entite: e, societe: so, nature: $("icN").value, montant: m, commentaire: c }, titre: "Inter-sociétés " + $("icN").value, resume: "Finances", essais: 0 };
          soumettre(it).then(function (r2) { alert((r2.ok ? (r2.enAttente ? "📥 " : "✅ ") : "⛔ ") + r2.titre + "\n" + (r2.message || "")); afficherInterco(); });
        };
      };
    }, function (e) { $("vueListe").innerHTML = "<div class='carte'><h3>🔁 Comptes entre sociétés</h3><p class='info'>⛔ " + esc(e.message) + " (réseau nécessaire)</p></div>"; });
  }
  var FOURF = { soc: "", du: "", au: "" };
  function ficheFournisseur(nom) {
    $("titre").textContent = nom;
    var dessiner = function (msg) {
      var R = FOUR.fiches[nom], f = R ? R.fournisseur : { nom: nom }, M = R ? R.mouvements : [], C = R ? R.cours : [];
      var du = FOURF.du ? new Date(FOURF.du + "T00:00:00").getTime() : 0, au = FOURF.au ? new Date(FOURF.au + "T23:59:59").getTime() : Infinity;
      var Ms = M.filter(function (m) { return f.societe || !FOURF.soc || !m.societe || m.societe === FOURF.soc; }), report = 0, solde, tf = 0, tp = 0;
      Ms.forEach(function (m) { if (m.date < du) report += m.facture - m.paye; });
      solde = report;
      var lignes = Ms.filter(function (m) { return m.date >= du && m.date <= au; }).map(function (m) {
        solde += m.facture - m.paye; tf += m.facture; tp += m.paye;
        return "<tr data-no='" + esc(m.no) + "' style='cursor:pointer'><td>" + jourLib(m.date).substring(0, 5) + "</td><td style='white-space:normal'>" + esc(m.op) + "<div class='info' style='font-size:11px'>" + esc(m.no) + (m.societe ? " · " + esc(m.societe) : "") +
          (m.devise !== "GNF" ? " · " + gnf(m.montant) + " " + esc(m.devise) : "") + (m.reste > 0 && m.echeance ? " · éch. " + jourLib(m.echeance) : "") + "</div></td>" +
          "<td class='v'>" + (m.facture ? gnf(m.facture) : "") + "</td><td class='v'>" + (m.paye ? gnf(m.paye) : "") + "</td><td class='v'><b>" + gnf(solde) + "</b></td></tr>";
      }).join("");
      var h = "<div class='carte'><h3>🏭 " + esc(f.nom) + "</h3>" + (msg ? "<div class='info'>" + esc(msg) + "</div>" : "") +
        "<div class='info'>" + [f.raison && f.raison !== f.nom ? f.raison : "", f.type, f.societe ? "bénéficiaire " + f.societe : "commun", f.projet ? "projet " + f.projet : "", f.article ? f.article : "", f.tva ? "assujetti TVA 18 %" : "non assujetti TVA", f.actif === false ? "désactivé" : ""].filter(String).map(esc).join(" · ") + "</div>" +
        "<div class='ligne'><button class='bouton second' id='ftEnr'>✏️ Modifier le compte</button><button class='bouton second' id='ftCopie'>🏭 Fiche du fournisseur</button></div></div>" +
        "<div class='carte'><label" + (f.societe ? " style='display:none'" : "") + ">Société payeuse</label><select id='ftS'" + (f.societe ? " style='display:none'" : "") + "><option value=''>AB + M2S</option><option" + (FOURF.soc === "AB" ? " selected" : "") + ">AB</option><option" + (FOURF.soc === "M2S" ? " selected" : "") + ">M2S</option></select>" +
        "<div class='ligne'><div><label>Du</label><input id='ftDu' type='date' value='" + FOURF.du + "'></div><div><label>Au</label><input id='ftAu' type='date' value='" + FOURF.au + "'></div></div>" +
        "<table><tr><td>Solde au début</td><td class='v'>" + gnf(report) + "</td></tr><tr><td>Facturé (période)</td><td class='v'>" + gnf(tf) + "</td></tr><tr><td>Payé (période)</td><td class='v'>" + gnf(tp) + "</td></tr>" +
        "<tr><td><b>" + (solde >= 0 ? "Reste dû" : "Avance chez lui") + "</b></td><td class='v'><b style='color:" + (solde > 0 ? "#c62828" : "#1565c0") + "'>" + gnf(Math.abs(solde)) + " GNF</b></td></tr>" +
        (R && R.echu ? "<tr><td>Échu (toutes sociétés)</td><td class='v' style='color:#c62828'><b>" + gnf(R.echu) + "</b></td></tr>" : "") + "</table>" +
        "<div class='ligne'><button class='bouton' id='ftPdf'>📄 Relevé PDF</button><button class='bouton second' id='ftDem'>➕ Demande</button></div></div>" +
        "<div class='carte'><h3>Relevé de compte</h3>" + (lignes ? "<table><tr><td><b>Date</b></td><td><b>Opération</b></td><td class='v'><b>Facturé</b></td><td class='v'><b>Payé</b></td><td class='v'><b>Solde</b></td></tr>" + lignes + "</table>" : "<div class='info'>Aucune opération sur la période.</div>") + "</div>" +
        (C.length ? "<div class='carte'><h3>En cours (" + C.length + ")</h3>" + C.map(function (c) { return "<div class='info' data-no='" + esc(c.no) + "' style='cursor:pointer'>" + jourLib(c.date) + " · " + esc(c.op) + " · <b>" + gnf(c.gnf) + " GNF</b> · " + esc(c.statut) + " · " + esc(c.no) + "</div>"; }).join("") + "</div>" : "");
      $("vueListe").innerHTML = h; montrer("vueListe");
      ["ftS", "ftDu", "ftAu"].forEach(function (id) { $(id).onchange = function () { FOURF.soc = $("ftS").value; FOURF.du = $("ftDu").value; FOURF.au = $("ftAu").value; dessiner(""); }; });
      $("ftEnr").onclick = function () { formulaireCompteFour(f.raison || f.nom, f); };
      $("ftCopie").onclick = function () { ficheFourMere(f.raison || f.nom); };
      $("ftDem").onclick = function () { formulaireFin({ type: "Règlement fournisseur", fournisseur: f.nom }); };
      $("ftPdf").onclick = function () {
        var soc = (f.societe && f.societe !== "CASAFINO" ? f.societe : "") || FOURF.soc || (f.societe ? "AB" : "") || prompt("Relevé pour quelle société ? (AB ou M2S)", "AB");
        soc = String(soc || "").trim().toUpperCase(); if (soc !== "AB" && soc !== "M2S") return;
        $("ftPdf").disabled = true; $("ftPdf").textContent = "⏳ PDF…";
        api({ api: "finReleve", nom: f.nom, societe: soc, du: FOURF.du, au: FOURF.au }, 120000).then(function (r) {
          var blob = base64Blob(r.pdf), fi = new File([blob], r.nom, { type: "application/pdf" });
          if (navigator.canShare && navigator.canShare({ files: [fi] }) && confirm("Partager le relevé ? (Annuler = l'ouvrir)")) navigator.share({ files: [fi], title: r.nom }).catch(function () {});
          else { var u = URL.createObjectURL(blob); if (!window.open(u, "_blank")) { var a = document.createElement("a"); a.href = u; a.download = r.nom; document.body.appendChild(a); a.click(); a.remove(); } }
          dessiner("");
        }, function (e) { alert("⛔ Relevé : " + e.message + " (réseau nécessaire)"); dessiner(""); });
      };
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-no]"), function (el) {
        el.onclick = function () { var no = el.getAttribute("data-no"); if (S.fin && S.fin.demandes.some(function (x) { return x.no === no; })) ouvrirDemandeFin(no); };
      });
    };
    dessiner(FOUR.fiches[nom] ? "mise à jour…" : "chargement…");
    api({ api: "finFour", nom: nom }).then(function (r) { FOUR.fiches[nom] = r; if ($("ftS")) dessiner(""); }, function (e) { if ($("ftS")) dessiner("⛔ " + e.message + (FOUR.fiches[nom] ? " (dernière copie)" : "")); });
  }

  /* ---------- 🏦 Trésorerie : consultation des comptes (DG, WALID : tous ; autres : comptes attribués) ---------- */
  function droitTreso() { return !!(S.agent && S.formulaires && S.formulaires.droits && S.formulaires.droits.treso); }
  var TRV = { releves: {}, du: "", au: "" };
  function afficherTreso() {
    $("titre").textContent = "Trésorerie";
    function dessiner(msg) {
      var T = S.treso, h = "<div class='carte pleine'><h3>🏦 Comptes et caisses</h3><div class='info'>" + (T ? (T.tous ? "Tous les comptes" : "Vos comptes") + " · données du " + dateCourte(T.recu || T.genere) : "") + (msg ? " · " + esc(msg) : "") + "</div></div>";
      if (T) {
        var G = {}; T.comptes.forEach(function (c) { var g = c.type === "Caisse" ? "Caisses" : "Comptes bancaires"; (G[g] = G[g] || []).push(c); });
        Object.keys(G).forEach(function (g) {
          h += "<div class='carte pleine'><h3>" + esc(g) + "</h3></div>" + G[g].map(function (c) {
            var apres = c.solde - c.aPayer + c.aRecevoir;
            return "<div class='carte' data-tr='" + esc(c.nom) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + esc(c.nom) + "</b>" +
              "<b style='flex:0;white-space:nowrap" + (c.solde < 0 ? ";color:#c62828" : "") + "'>" + gnf(c.solde) + " " + esc(c.devise) + "</b></div>" +
              "<div class='info'>" + [c.societe, c.aPayer ? "à payer " + gnf(c.aPayer) : "", c.aRecevoir ? "à recevoir " + gnf(c.aRecevoir) : "", c.enValidation ? "en validation " + gnf(c.enValidation) : ""].filter(String).map(esc).join(" · ") + "</div>" +
              (c.aPayer || c.aRecevoir ? "<div style='font-size:13px;font-weight:700;color:" + (apres < 0 ? "#c62828" : "#2e7d32") + "'>Après paiements : " + gnf(apres) + " " + esc(c.devise) + "</div>" : "") + "</div>";
          }).join("");
        });
      }
      $("vueListe").innerHTML = h; montrer("vueListe");
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-tr]"), function (el) { el.onclick = function () { ficheTreso(el.getAttribute("data-tr")); }; });
    }
    dessiner(S.treso ? "mise à jour…" : "chargement…");
    api({ api: "treso" }).then(function (r) { r.recu = Date.now(); S.treso = r; ecrire("treso", r); dessiner(""); },
      function (e) { dessiner("⛔ " + e.message + (S.treso ? " (dernière copie)" : "")); });
  }
  function ficheTreso(nom) {
    $("titre").textContent = nom;
    var c = (S.treso && S.treso.comptes.filter(function (x) { return x.nom === nom; })[0]) || { nom: nom, devise: "", solde: 0 };
    function dessiner(msg) {
      var R = TRV.releves[nom + "|" + TRV.du + "|" + TRV.au], dev = c.devise;
      var h = "<div class='carte'><h3>🏦 " + esc(nom) + "</h3><table><tr><td>Solde actuel</td><td class='v'>" + gnf(c.solde) + " " + esc(dev) + "</td></tr>" +
        (c.aPayer ? "<tr><td>Validé, à payer</td><td class='v'>− " + gnf(c.aPayer) + "</td></tr>" : "") + (c.aRecevoir ? "<tr><td>À recevoir</td><td class='v'>+ " + gnf(c.aRecevoir) + "</td></tr>" : "") +
        (c.aPayer || c.aRecevoir ? "<tr><td><b>Après paiements</b></td><td class='v'><b>" + gnf(c.solde - c.aPayer + c.aRecevoir) + " " + esc(dev) + "</b></td></tr>" : "") +
        (c.enValidation ? "<tr><td>En validation (non compté)</td><td class='v'>" + gnf(c.enValidation) + "</td></tr>" : "") + "</table>" + (msg ? "<div class='info'>" + esc(msg) + "</div>" : "") + "</div>" +
        "<div class='carte'><div class='ligne'><div><label>Du</label><input id='trDu' type='date' value='" + TRV.du + "'></div><div><label>Au</label><input id='trAu' type='date' value='" + TRV.au + "'></div></div>" +
        "<button class='bouton' id='trPdf'>📄 Relevé PDF</button></div>";
      if (R && R.engagements.length) h += "<div class='carte'><h3>Engagements DuoCore</h3>" + R.engagements.map(function (x) {
        return "<div class='info' data-no='" + esc(x.no) + "' style='cursor:pointer'>" + esc(x.no) + " · " + esc(x.libelle) + " · <b>" + (x.sortie ? "− " + gnf(x.sortie) : "+ " + gnf(x.entree)) + "</b> · " + esc(x.statut) + "</div>"; }).join("") + "</div>";
      if (R) {
        var L = R.lignes.slice().reverse();
        h += "<div class='carte pleine'><h3>Relevé</h3>" + (R.message ? "<div class='info'>" + esc(R.message) + "</div>" : "") + (R.tronque ? "<div class='info'>400 dernières opérations (choisissez une période pour remonter plus loin).</div>" : "") +
          (L.length && !modePC() ? L.map(function (l) {   // téléphone : une ligne par opération
            return "<div style='border-bottom:1px solid var(--bord);padding:7px 0'><div class='ligne' style='justify-content:space-between'><span>" + jourLib(l.date).substring(0, 5) + " · <b>" + esc(l.op) + "</b></span>" +
              "<b style='flex:0;white-space:nowrap;color:" + (l.debit ? "#c62828" : "#2e7d32") + "'>" + (l.debit ? "− " + gnf(l.debit) : "+ " + gnf(l.credit)) + "</b></div>" +
              "<div class='ligne' style='justify-content:space-between'><span class='info' style='font-size:12.5px'>" + esc(l.libelle) + " · " + esc(l.debit ? "→ " + l.benef : "← " + l.source) + "</span><span class='info' style='flex:0;white-space:nowrap;font-size:12.5px'>solde " + gnf(l.solde) + "</span></div></div>";
          }).join("") + "<div class='info' style='padding-top:6px'>Solde de début : " + gnf(R.report) + "</div>" :
           L.length ? "<table><tr><td><b>Date</b></td><td><b>Opération</b></td><td class='v'><b>Débit</b></td><td class='v'><b>Crédit</b></td><td class='v'><b>Solde</b></td></tr>" + L.map(function (l) {
            return "<tr><td>" + jourLib(l.date) + "</td><td style='white-space:normal'>" + esc(l.op) + "<div class='info' style='font-size:11.5px'>" + esc(l.libelle) + " · " + esc(l.debit ? "→ " + l.benef : "← " + l.source) + (l.cat ? " · " + esc(l.cat) : "") + "</div></td>" +
              "<td class='v' style='color:#c62828'>" + (l.debit ? gnf(l.debit) : "") + "</td><td class='v' style='color:#2e7d32'>" + (l.credit ? gnf(l.credit) : "") + "</td><td class='v'><b>" + gnf(l.solde) + "</b></td></tr>"; }).join("") +
            "<tr><td></td><td><i>Solde de début</i></td><td></td><td></td><td class='v'>" + gnf(R.report) + "</td></tr></table>" : "<div class='info'>Aucune opération sur la période.</div>") + "</div>";
      }
      $("vueListe").innerHTML = h; montrer("vueListe");
      ["trDu", "trAu"].forEach(function (id) { $(id).onchange = function () { TRV.du = $("trDu").value; TRV.au = $("trAu").value; charger(); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-no]"), function (el) { el.onclick = function () { var no = el.getAttribute("data-no"); if (S.fin && S.fin.demandes.some(function (x) { return x.no === no; })) ouvrirDemandeFin(no); }; });
      $("trPdf").onclick = function () {
        $("trPdf").disabled = true; $("trPdf").textContent = "⏳ PDF…";
        api({ api: "tresoPdf", compte: nom, du: TRV.du, au: TRV.au }, 120000).then(function (r) {
          var blob = base64Blob(r.pdf), fi = new File([blob], r.nom, { type: "application/pdf" });
          if (navigator.canShare && navigator.canShare({ files: [fi] }) && confirm("Partager le relevé ? (Annuler = l'ouvrir)")) navigator.share({ files: [fi], title: r.nom }).catch(function () {});
          else { var u = URL.createObjectURL(blob); if (!window.open(u, "_blank")) { var a = document.createElement("a"); a.href = u; a.download = r.nom; document.body.appendChild(a); a.click(); a.remove(); } }
          dessiner("");
        }, function (e) { alert("⛔ Relevé : " + e.message); dessiner(""); });
      };
    }
    function charger() {
      dessiner("⏳ chargement du relevé…");
      api({ api: "tresoReleve", compte: nom, du: TRV.du, au: TRV.au }).then(function (r) { TRV.releves[nom + "|" + TRV.du + "|" + TRV.au] = r; if ($("trDu")) dessiner(""); },
        function (e) { if ($("trDu")) dessiner("⛔ " + e.message + " (réseau nécessaire)"); });
    }
    charger();
  }

  /* ---------- 🔐 Sécurité : utilisateur + PIN ; nouvelle combinaison agent + appareil → code (OTP) envoyé au DG ---------- */
  var SEC = { refus: "", ouvert: false };
  function hexAleatoire(n) { var a = new Uint8Array(n); (window.crypto || window.msCrypto).getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function lireAppareil() {
    var d = null; try { d = JSON.parse(localStorage.getItem("duocoreAppareil") || "null"); } catch (e) {}
    if (!d || !d.id || !d.secret) { d = { id: hexAleatoire(8), secret: hexAleatoire(20), approuve: false }; }
    S.dev = d; sauverAppareil(); return d;
  }
  function sauverAppareil() { try { localStorage.setItem("duocoreAppareil", JSON.stringify(S.dev)); } catch (e) {} ecrire("appareil", S.dev); }
  function libelleAppareil() {
    var u = navigator.userAgent, os = /Android/i.test(u) ? "Android" : /iPhone|iPad/i.test(u) ? "iPhone/iPad" : /Windows/i.test(u) ? "Windows" : /Mac/i.test(u) ? "Mac" : /Linux/i.test(u) ? "Linux" : "Appareil";
    var nav = /Edg\//.test(u) ? "Edge" : /SamsungBrowser/.test(u) ? "Samsung" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : /Firefox/.test(u) ? "Firefox" : "";
    return os + (nav ? " · " + nav : "") + (modePC() ? " · PC/tablette" : " · téléphone") + " · " + screen.width + "×" + screen.height;
  }
  /* Ajoute l'identité de l'appareil à toute demande au serveur ; détecte un refus d'appareil. */
  function avecAppareil(url, options) {
    if (!S.dev || !S.url || String(url).indexOf(S.url) !== 0) return url;
    if (options && typeof options.body === "string" && options.body.charAt(0) === "{") {
      try { var c = JSON.parse(options.body); c.appareil = S.dev.id; c.secret = S.dev.secret; options.body = JSON.stringify(c); } catch (e) {}
      return url;
    }
    return url + (url.indexOf("?") < 0 ? "?" : "&") + "appareil=" + encodeURIComponent(S.dev.id) + "&secret=" + encodeURIComponent(S.dev.secret);
  }
  function surReponseSecurite(r) {
    if (!r || !r.appareilRefus) return;
    SEC.refus = r.appareilRefus;
    // Agent connecté mais pas (ou plus) autorisé sur cet appareil : code au DG.
    if (S.agent && !SEC.ouvert) setTimeout(function () { ecranSecurite("agent", { nom: S.agent.nom, code: S.agent.code }); }, 0);
  }
  function apiLibre(corps) {
    corps.appareil = S.dev.id; corps.secret = S.dev.secret;
    return requete(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow", body: JSON.stringify(corps) }, DELAI_DONNEES);
  }
  /* Écran plein (au-dessus de tout) : 1re connexion d'un agent sur cet appareil (code envoyé au DG). */
  function ecranSecurite(mode, pre) {
    pre = pre || {};
    var o = $("ecranSec");
    if (!o) { o = document.createElement("div"); o.id = "ecranSec"; document.body.appendChild(o); }
    o.style.display = "block";
    SEC.ouvert = true;
    function fermer() { o.style.display = "none"; o.innerHTML = ""; SEC.ouvert = false; }
    var tete = "<div class='secBoite'><div style='text-align:center'><img src='icone-192.png' style='width:64px;height:64px;border-radius:14px'><h2 style='margin:8px 0 2px'>DuoCore</h2></div>";
    // Autorisation : utilisateur + PIN, puis code envoyé au DG.
    var titre = "Première connexion sur cet appareil";
    o.innerHTML = tete + "<h3 style='margin-top:6px'>🔐 " + titre + "</h3><p class='info'>Connexion en deux étapes : votre nom + votre PIN, puis le code à 6 chiffres envoyé au DG (à lui demander).</p>" +
      "<div id='secEt1'><label>Utilisateur</label><select id='secNom'><option value=''>— chargement… —</option></select>" +
      "<label>PIN</label><input id='secPin' type='password' inputmode='numeric' autocomplete='off' value='" + esc(pre.code || "") + "'>" +
      "<button class='bouton' id='secDem'>📧 Demander le code au DG</button></div>" +
      "<div id='secEt2' style='display:none'><label>Code reçu par le DG (6 chiffres)</label><input id='secOtp' inputmode='numeric' maxlength='6' autocomplete='one-time-code' style='font-size:22px;letter-spacing:6px;text-align:center'>" +
      "<button class='bouton' id='secVal'>✅ Valider</button><button class='bouton second' id='secRe'>Renvoyer un code</button></div>" +
      "<button class='bouton second' id='secAnn'>Annuler</button>" +
      "<div id='secMsg' class='info' style='margin-top:8px;white-space:pre-line'></div><div class='info' style='margin-top:12px;font-size:12px'>Appareil : " + esc(libelleAppareil()) + " · " + esc(S.dev.id.substring(0, 8)) + "</div></div>";
    function nomsCharges(noms) { $("secNom").innerHTML = "<option value=''>— choisir —</option>" + noms.map(function (n) { return "<option" + (n === pre.nom ? " selected" : "") + ">" + esc(n) + "</option>"; }).join(""); }
    if (!S.url) { $("secMsg").textContent = "⛔ Adresse du serveur inconnue (config.js)."; return; }
    apiLibre({ api: "agentsListe" }).then(function (r) { nomsCharges((r && r.agents) || []); }, function (e) { nomsCharges(pre.nom ? [pre.nom] : []); $("secMsg").textContent = "⛔ " + e.message + " (réseau nécessaire)"; });
    $("secAnn").onclick = function () { if (S.agent && SEC.refus) deconnecterAgent(); fermer(); montrer("vueAccueil"); };
    function demander() {
      var nom = $("secNom").value, pin = $("secPin").value.trim();
      if (!nom || !pin) { $("secMsg").textContent = "⛔ Utilisateur et PIN."; return; }
      $("secMsg").textContent = "⏳ Envoi…";
      apiLibre({ api: "otpDemander", agent: nom, code: pin, libelle: libelleAppareil() }).then(function (r) {
        if (!r.ok) { $("secMsg").textContent = "⛔ " + r.titre + " : " + r.message; return; }
        pre.nom = nom; pre.code = pin;
        if (r.dejaAutorise) return terminer();
        $("secEt1").style.display = "none"; $("secEt2").style.display = ""; $("secMsg").textContent = "📧 " + r.message; try { $("secOtp").focus(); } catch (e) {}
      }, function (e) { $("secMsg").textContent = "⛔ " + e.message; });
    }
    function terminer() {
      S.dev.approuve = true; sauverAppareil(); SEC.refus = "";
      $("secMsg").textContent = "✅ Appareil autorisé. Chargement…";
      rafraichirFormulaires({ nom: pre.nom, code: pre.code }).then(function () { fermer(); montrer("vueAccueil"); synchroniser(true); },
        function (e) { $("secMsg").textContent = "⛔ " + e.message; });
    }
    $("secDem").onclick = demander; $("secRe").onclick = function () { $("secEt2").style.display = "none"; $("secEt1").style.display = ""; demander(); };
    $("secVal").onclick = function () {
      var c = $("secOtp").value.replace(/\D/g, "");
      if (c.length !== 6) { $("secMsg").textContent = "⛔ 6 chiffres."; return; }
      $("secMsg").textContent = "⏳ Vérification…";
      apiLibre({ api: "otpValider", agent: pre.nom, code: pre.code, otp: c }).then(function (r) {
        if (!r.ok) { $("secMsg").textContent = "⛔ " + r.titre + " : " + r.message; return; }
        terminer();
      }, function (e) { $("secMsg").textContent = "⛔ " + e.message; });
    };
  }
  function deconnecterAgent() {
    S.agent = null; S.formulaires = null; S.planif = null; S.fin = null; S.rh = null; S.com = null; S.mis = null; S.treso = null;
    S.stockv = null;
    ["agent", "formulaires", "planif", "fin", "rh", "com", "mis", "treso", "four", "stockv"].forEach(function (k) { ecrire(k, null); });
    montrer("vueAccueil");
  }
  function initSecurite() { lireAppareil(); return true; }
  /* ---------- 📦 Sorties de stock hors production : validation WALID ou DG ---------- */
  function droitStockVal() { var d = S.agent && S.formulaires && S.formulaires.droits; return !!(d && (d.stock || ["DG", "WALID"].indexOf(String(S.agent.nom).toUpperCase()) >= 0)); }
  var rafStk = null;
  function rafraichirStockVal() {
    if (!S.url || !droitStockVal()) return Promise.resolve();
    if (rafStk) return rafStk;
    rafStk = api({ api: "stockAValider" }).then(function (r) { r.recu = Date.now(); S.stockv = r; return ecrire("stockv", r); })
      .then(function () { rafStk = null; }, function (e) { rafStk = null; throw e; });
    return rafStk;
  }
  function stockNbAttente() { return S.stockv ? S.stockv.sorties.filter(function (x) { return x.statut === "En attente"; }).length : 0; }
  function afficherStockVal(id) {
    $("titre").textContent = "Sortie de stock";
    function dessiner(msg) {
      var K = S.stockv, L = K ? K.sorties : [], C = { "En attente": "#e65100", "Validée": "#2e7d32", "Refusée": "#c62828" };
      var fsS = S.formulaires && S.formulaires.formulaires && S.formulaires.formulaires.stock;
      var h = "<div class='carte pleine'><h3>📦 Sortie de stock (hors production)</h3>" +
        (fsS ? "<button class='bouton' id='skNouv'" + (fsS.erreur ? " disabled" : "") + ">➕ Nouvelle sortie de stock</button>" : "") +
        "<h3 style='margin-top:14px'>📋 Liste des demandes</h3><div class='info'>" + (K && K.direction ? "Validation : WALID ou DG (un seul suffit) ; vos propres saisies sont validées d'office. " : "Vos sorties : elles n'entrent dans le stock qu'après validation par WALID ou le DG. ") +
        (K ? "Données du " + dateCourte(K.recu || K.genere) : "") + (msg ? " · " + esc(msg) : "") + "</div></div>";
      h += L.map(function (x, i) {
        return "<div class='carte'" + (x.no === id ? " style='border-color:var(--cuivre)'" : "") + "><div class='ligne' style='justify-content:space-between'><b>" + esc(x.no) + " · " + esc(x.agent) + "</b>" +
          "<span style='flex:0;white-space:nowrap;font-weight:700;color:" + (C[x.statut] || "#999") + "'>" + esc(x.statut) + "</span></div><div>" + esc(x.resume) + "</div>" +
          "<div class='info'>Saisie le " + dateCourte(x.saisi) + (x.par ? " · " + esc(x.statut.toLowerCase()) + " par " + esc(x.par) + " le " + dateCourte(x.le) : "") + (x.motif ? " — " + esc(x.motif) : "") + "</div>" +
          (K.direction && x.statut === "En attente" ? "<input data-m='" + i + "' placeholder='Motif (obligatoire pour refuser)'><div class='ligne'><button class='bouton' data-v='" + i + "' style='background:var(--vert)'>✅ Valider</button><button class='bouton' data-r='" + i + "' style='background:var(--rouge)'>⛔ Refuser</button></div>" : "") + "</div>";
      }).join("") || "<p class='info' style='padding:0 4px'>Aucune sortie de stock.</p>";
      $("vueListe").innerHTML = h; montrer("vueListe");
      if ($("skNouv")) $("skNouv").onclick = function () { ouvrirFormulaire("stock"); };
      function decider(i, dec) {
        var x = L[i], m = (document.querySelector("[data-m='" + i + "']") || {}).value || "";
        if (dec === "refuser" && !m.trim()) { alert("⛔ Indiquez le motif du refus."); return; }
        if (!confirm((dec === "valider" ? "Valider " : "Refuser ") + x.no + " : " + x.resume + " ?")) return;
        dessiner("⏳ envoi…");
        api({ api: "stockAValider", no: x.no, decision: dec, motif: m.trim() }).then(function (r) { alert("✅ " + r.titre + "\n" + (r.message || "")); return rafraichirStockVal(); },
          function (e) { alert("⛔ " + e.message + " (réseau nécessaire)"); }).then(function () { dessiner(""); });
      }
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-v]"), function (b) { b.onclick = function () { decider(+b.getAttribute("data-v"), "valider"); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-r]"), function (b) { b.onclick = function () { decider(+b.getAttribute("data-r"), "refuser"); }; });
    }
    dessiner(S.stockv ? "mise à jour…" : "chargement…");
    rafraichirStockVal().then(function () { dessiner(""); }, function (e) { dessiner("⛔ " + e.message); });
  }

  function ouvrirDepuisNotif(d) {
    synchroniser(true).catch(function () {}).then(function () {
      if (d.vue === "finances" && typeof afficherFinances === "function") afficherFinances(d.id);
      else if (d.vue === "rh" && droitRH()) afficherRH(d.id);
      else if (d.vue === "commercial" && droitCom()) afficherCom(d.id);
      else if (d.vue === "missions" && droitMis()) afficherMis(d.id);
      else if (d.vue === "stockval" && droitStockVal()) afficherStockVal(d.id);
      else montrer("vueAccueil");
    });
  }

  /* ---------- Fiches (étape 5) : PDF gardés sur l'appareil (lecture, impression, partage hors ligne) ---------- */
  function base64Blob(b64) { var bin = atob(b64), n = bin.length, u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: "application/pdf" }); }
  function nomFichierPdf(f) { return String(f.nom).replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-").substring(0, 120) + ".pdf"; }
  function api(corps, delai) {
    var c = { agent: S.agent.nom, code: S.agent.code }; Object.keys(corps).forEach(function (k) { c[k] = corps[k]; });
    return requete(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow", body: JSON.stringify(c) }, delai || DELAI_DONNEES)
      .then(function (r) { if (!r.ok) throw new Error(r.message || r.titre || "refusé"); return r; });
  }
  // PDF gardé si à jour, sinon téléchargé (réseau) ; hors ligne : la dernière copie.
  function pdfFiche(b, f) {
    return lire("pdf:" + f.id).then(function (c) {
      if (c && c.modifie >= f.modifie) return c;
      if (!S.url || !navigator.onLine) { if (c) return c; throw new Error("pas encore enregistrée sur cet appareil (réseau nécessaire une fois)"); }
      return api({ api: "fichePdf", bdc: b.libelle, id: f.id }, 120000).then(function (r) {
        var o = { modifie: r.modifie, nom: r.nom, blob: base64Blob(r.pdf) };
        return ecrire("pdf:" + f.id, o).then(function () { return o; });
      }, function (e) { if (c) return c; throw e; });
    });
  }
  function afficherFiches(b, C, pc) {
    var etat = { msg: "" };
    function dessiner() {
      var L = b.fiches || [], att = S.file.filter(function (x) { return x.type === "planif" && x.op === "refaireFicheMontage" && x.donnees.bdc === b.libelle; })[0];
      C.innerHTML = "<div class='carte'><h3>🧾 Fiches" + (b.fichesRecu ? " <small class='info'>(liste du " + dateCourte(b.fichesRecu) + ")</small>" : "") + "</h3>" +
        (L.length ? L.map(function (f, i) {
          return "<div class='ficheL'><div><b>" + (f.type === "montage" ? "🖨️ Fiche Montage" : "📄 Fiche d'atelier — IMP " + esc(f.lettre)) + "</b>" +
            "<div class='info' style='font-size:12px'>" + esc(f.nom) + " · " + dateCourte(f.modifie) + " · <span id='fcE" + i + "'>…</span></div></div>" +
            "<div class='ficheB'>" + (pc ? "<button class='bouton second' data-a='voir' data-i='" + i + "'>👁 Voir</button>" : "") +
            "<button class='bouton second' data-a='ouvrir' data-i='" + i + "'>" + (pc ? "🖨️ Imprimer" : "👁 Ouvrir") + "</button>" +
            "<button class='bouton second' data-a='partager' data-i='" + i + "'>📤 Partager</button>" +
            "<a class='bouton second' href='" + esc(f.url) + "' target='_blank' rel='noopener'>🔗 Drive</a></div></div>";
        }).join("") : "<p class='info'>Aucune fiche pour ce BDC" + (b.fichesRecu ? "" : " sur cet appareil : ⟳ avec réseau") + ". Les fiches sont créées à la publication.</p>") +
        "<button class='bouton second' id='fcRefaire'>🔄 Refaire la Fiche Montage</button>" +
        (att ? "<div class='carte att'>⏳ Fiche Montage demandée — " + (att.essais ? "envoi en cours" : "attend l'envoi") + ".</div>" : "") +
        "<div id='fcMsg' class='info' style='white-space:pre-line;margin-top:6px'>" + esc(etat.msg) + "</div></div>" +
        (pc ? "<iframe id='fcApercu' title='Aperçu' style='display:none;width:100%;height:75vh;border:0;border-radius:10px;margin-top:10px;background:#fff'></iframe>" : "");
      L.forEach(function (f, i) {
        lire("pdf:" + f.id).then(function (c) { var e = C.querySelector("#fcE" + i); if (e) e.textContent = c ? (c.modifie >= f.modifie ? "✅ sur l'appareil" : "↻ version plus récente au serveur") : "☁️ pas encore sur l'appareil"; });
      });
      Array.prototype.forEach.call(C.querySelectorAll("[data-a]"), function (bt) {
        bt.onclick = function () {
          var f = L[+bt.getAttribute("data-i")], a = bt.getAttribute("data-a"), w = null;
          if (a === "ouvrir") w = window.open("", "_blank");          // ouverte tout de suite (sinon bloquée après l'attente)
          C.querySelector("#fcMsg").textContent = "⏳ Préparation du PDF…";
          pdfFiche(b, f).then(function (o) {
            var url = URL.createObjectURL(o.blob);
            C.querySelector("#fcMsg").textContent = "";
            if (a === "voir") { var fr = C.querySelector("#fcApercu"); fr.style.display = "block"; fr.src = url; fr.scrollIntoView({ behavior: "smooth" }); }
            else if (a === "ouvrir") { if (w) w.location.href = url; else window.open(url, "_blank"); }
            else {
              var fichier = new File([o.blob], nomFichierPdf(o), { type: "application/pdf" });
              if (navigator.canShare && navigator.canShare({ files: [fichier] })) navigator.share({ files: [fichier], title: o.nom }).catch(function () {});
              else { var l = document.createElement("a"); l.href = url; l.download = fichier.name; document.body.appendChild(l); l.click(); l.remove(); C.querySelector("#fcMsg").textContent = "Partage direct indisponible ici : PDF téléchargé (" + fichier.name + ")."; }
            }
            L.forEach(function (g, j) { if (g.id === f.id) { var e = C.querySelector("#fcE" + j); if (e) e.textContent = "✅ sur l'appareil"; } });
          }, function (e) { if (w) w.close(); C.querySelector("#fcMsg").textContent = "⛔ " + e.message; });
        };
      });
      C.querySelector("#fcRefaire").onclick = function () {
        if (!confirm("Refaire la Fiche Montage de « " + b.libelle + " » ? (30 s à 1 min sur le serveur)")) return;
        var it = { type: "planif", op: "refaireFicheMontage", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code,
                   donnees: { id: b.id, bdc: b.libelle }, titre: "Fiche Montage", resume: b.libelle, essais: 0 };
        etat.msg = "⏳ Demande envoyée…"; dessiner();
        soumettre(it).then(function (r) { etat.msg = (r.enAttente ? "📥 " : r.ok ? "✅ " : "⛔ ") + (r.titre || "") + "\n" + (r.message || ""); if (r.ok && !r.enAttente) charger(); else dessiner(); });
      };
    }
    function charger() {
      if (!S.url || !navigator.onLine) { dessiner(); return; }
      api({ api: "fiches", bdc: b.libelle }).then(function (r) {
        b.fiches = r.fiches; b.fichesRecu = Date.now(); ecrire("planif", S.planif);
        dessiner();
        // Copie sur l'appareil des fiches nouvelles ou modifiées (lecture hors ligne).
        r.fiches.reduce(function (pr, f) { return pr.then(function () { return pdfFiche(b, f).catch(function () {}); }); }, Promise.resolve()).then(function () { if (C.isConnected) dessiner(); });
      }, function (e) { etat.msg = "Liste non actualisée (" + e.message + ") : fiches gardées sur l'appareil."; dessiner(); });
    }
    dessiner(); charger();
  }

  /* ---------- Scénarios de montage (calcul du script, exécuté dans l'app, hors ligne) ---------- */
  var SHIM_SCEN = "<script>(function(){function mk(s,f){return{withSuccessHandler:function(x){return mk(x,f);},withFailureHandler:function(y){return mk(s,y);}," +
    "retenirScenarioMontage:function(b,sc,r){parent.ATELIER.planifRetenir(b,sc,r).then(s,function(e){if(f)f(e);});}};}" +
    "window.google={script:{run:mk(null,null),host:{close:function(){parent.ATELIER.fermerFM();}}}};})();<\/script>";
  function scenEnAttente(lib) { return S.file.filter(function (x) { return x.type === "planif" && x.op === "retenirScenario" && x.donnees.bdc === lib; })[0] || null; }
  // Même signature que le serveur (signatureTypesFM) : planches, poses, nombre, article réservé.
  function signatureTypesFM(types) {
    return JSON.stringify((types || []).map(function (t) { return [t.lettre, +t.N || 0, +t.nb || 0, +t.nx || 0, +t.ny || 0, !!t.t, String(t.ar || "")]; }));
  }
  var SCEN_OUVERT = null;
  function ouvrirScenarios(id) {
    var b = bdcPlanif(id), P = S.planif;
    if (!b) return;
    if (!P.editeurScen) { alert("Scénarios indisponibles : synchronisez (⟳) avec réseau (script FX ou plus récent)."); return; }
    var fms = b.feuillesMeres || [];
    var sans = (b.groupes || []).filter(function (g) { return !fms.some(function (f) { return f.donnees && f.donnees.cle === g.cle; }); });
    if (!fms.length || sans.length) { alert("Feuille mère manquante pour :\n" + sans.map(function (g) { return "• " + g.fL + "×" + g.fH + " · " + (g.papier || "papier non déclaré") + (g.comp ? " · composants" : "") + " (" + (g.abrs || []).join(", ") + ")"; }).join("\n") +
      "\n\nÉditez d'abord la feuille mère de chaque groupe (🧱)."); return; }
    function lancer(sc) {
      if (!sc) { alert("Articles à imposer inconnus sur cet appareil pour ce BDC : synchronisez (⟳) avec réseau (les feuilles mères doivent être envoyées)."); return; }
      if (sc.erreur) { alert("Scénarios : " + sc.erreur); return; }
      if (!sc.articles.length && !sc.sansFormat.length) { alert("Aucun article à imposer pour « " + b.libelle + " ».\n\n" + (sc.exclus.length ? "Exclus : " + sc.exclus.map(function (x) { return x.abr + " (" + x.motif + ")"; }).join(", ") : "")); return; }
      if (!sc.articles.length) { alert("Format fini manquant pour ce BDC : complétez la saisie BDC (format commun ou par ligne) et envoyez-la dans Statut Prod."); return; }
      var PAPM = P.papiersMontage || [];
      var ctx = {}; Object.keys(P.scenReglages || {}).forEach(function (k) { ctx[k] = P.scenReglages[k]; });
      ctx.bdc = b.libelle; ctx.articles = sc.articles; ctx.exclus = sc.exclus; ctx.sansFormat = sc.sansFormat; ctx.machines = P.machines || []; ctx.papiers = PAPM;
      ctx.papierB5 = ""; ctx.lettresPrises = sc.lettresPrises || [];
      ctx.feuillesMeres = fms.map(function (x) { var d = x.donnees || {}, pp = PAPM.filter(function (p) { return p.nom === x.papier; })[0] || {};
        return { nom: x.nom, papier: x.papier, machine: x.machine, fL: d.fL, fH: d.fH, comp: !!d.comp, types: x.types, W: pp.y || 0, H: pp.x || 0 }; });
      SCEN_OUVERT = { id: b.id, ctx: ctx, sc: sc };
      FM_OUVERT = b.id;
      var att = scenEnAttente(b.libelle), local = fms.some(function (f) { return f.quand === "⏳ sur cet appareil"; });
      var html = P.editeurScen.replace("<?!= donnees ?>", JSON.stringify(ctx).replace(/</g, "\\u003c"));
      var cadreSc = PL.id ? $("plCadre") : $("cadre");
      if (!PL.id) { montrer("vueLot"); $("titre").textContent = "Scénarios de montage"; }
      cadreSc.srcdoc = "<!DOCTYPE html><html lang='fr'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>" +
        "<style>html,body{background:#fff;color:#222}body{overflow-x:auto}</style>" + SHIM_SCEN + "</head><body>" +
        "<div style='margin:6px 0 10px;padding:6px 8px;background:#e8f0fe;border-radius:6px;font:13px Arial'>🧩 <b>" + esc(b.libelle) + "</b> — calcul sur cet appareil (hors ligne possible). « Retenir » part à la synchronisation ; le serveur refuse si les données ont changé entre-temps." +
        (local ? "<br>⚠️ Feuille(s) mère(s) modifiée(s) sur cet appareil : elles partiront avant le scénario." : "") +
        (att ? "<br>⏳ Un scénario retenu attend déjà l'envoi : retenir de nouveau le remplacera." : "") + "</div>" + html + "</body></html>";
    }
    if (b.scen) { lancer(b.scen); return; }
    if (!S.url || !navigator.onLine) { lancer(null); return; }
    requete(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow",
      body: JSON.stringify({ api: "planifScen", agent: S.agent.nom, code: S.agent.code, bdc: b.libelle }) }, DELAI_DONNEES).then(function (r) {
      if (!r.ok) throw new Error(r.message || "refusé");
      b.scen = r.scen; ecrire("planif", S.planif); lancer(r.scen);
    }).catch(function () { lancer(null); });
  }
  // Appelé par la page des scénarios (« Retenir ») : file d'attente, appliqué par le serveur à la synchronisation.
  function planifRetenir(bdcLib, sc, reglages) {
    var o = SCEN_OUVERT, b = o ? bdcPlanif(o.id) : null;
    if (!b || b.libelle !== bdcLib) return Promise.reject(new Error("BDC introuvable sur cet appareil : rouvrez les scénarios."));
    // Plusieurs « Retenir » : envoyés dans l'ordre, le dernier remplace les précédents (impositions non publiées).
    var attendu = { articles: o.sc.articles.map(function (a) { return [a.abr, a.qte]; }), lettres: o.sc.lettresPrises || [],
                    fms: o.ctx.feuillesMeres.map(function (f) { return { nom: f.nom, sig: signatureTypesFM(f.types) }; }) };
    var n = (sc.montages || []).length;
    var it = { type: "planif", op: "retenirScenario", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code,
               donnees: { id: b.id, bdc: bdcLib, sc: sc, reglages: reglages, attendu: attendu },
               titre: "Scénario de montage (" + n + " imposition" + (n > 1 ? "s" : "") + ")", resume: bdcLib, essais: 0 };
    soumettre(it).then(function (r) { if (r && !r.enAttente && !r.ok) alert("⛔ " + r.titre + "\n" + r.message); else if (r && r.ok && !r.enAttente) rafraichirPlanif().catch(function () {}); });
    return Promise.resolve(n + " imposition(s) retenue(s) sur cet appareil. Envoi au serveur en cours (ou à la prochaine connexion) : les lettres sont données par le serveur — suivez « En attente » / « À corriger ».");
  }

  /* ---------- Publication des tirages (étape 4) : file d'attente, publiés par PRODUCTION ---------- */
  function pubEnAttente(lib, lettre) { return S.file.filter(function (x) { return x.type === "planif" && x.op === "publierTirage" && x.donnees.bdc === lib && x.donnees.lettre === lettre; })[0] || null; }
  function htmlPublication(b) {
    var T = b.tirages || [];
    if (!T.length) return "";
    var h = "<div class='carte' style='margin-top:8px'><h3>📤 Publication des impositions</h3>";
    var aPub = 0;
    T.forEach(function (t) {
      var publie = t.statut === "Publiée" || /publi/i.test(t.statut || ""), loc = pubEnAttente(b.libelle, t.lettre), f = t.file, etat = "", coul = "";
      if (publie) { etat = "✅ Publiée"; coul = "#2e7d32"; }
      else if (loc) { etat = "⏳ Demande sur cet appareil, attend l'envoi"; coul = "#e65100"; }
      else if (f && (f.etat === "En attente" || f.etat === "En cours")) { etat = (f.etat === "En cours" ? "⚙️ " : "⏳ ") + f.etat + (f.message ? " — " + f.message : ""); coul = "#e65100"; }
      else if (f && f.etat === "Refusé") { etat = "⛔ Refusé — " + f.message; coul = "#c62828"; }
      var coche = !publie && !loc && !(f && (f.etat === "En attente" || f.etat === "En cours")) && !!t.fmp;
      if (coche) aPub++;
      h += "<label style='font-weight:400;display:block;margin:6px 0'>" + (coche ? "<input type='checkbox' class='pubC' value='" + esc(t.lettre) + "' checked style='width:auto'> " : "<span style='display:inline-block;width:18px'></span>") +
        "<b>" + esc(t.lettre) + "</b> " + (t.comp ? "<small>(composant)</small> " : "") + esc(t.articles).substring(0, 90) + (String(t.articles).length > 90 ? "…" : "") +
        " <small>· " + Number(t.mere || 0).toLocaleString("fr-FR") + " f. mères</small>" +
        (!t.fmp && !publie ? "<br><small style='color:#c62828'>Sans feuille mère partagée : publication dans Sheets.</small>" : "") +
        (etat ? "<br><small style='color:" + coul + "'>" + esc(etat) + "</small>" : "") + "</label>";
    });
    h += aPub ? "<button class='bouton' id='pubGo'>📤 Publier les impositions cochées</button><div class='info'>Contenu d'abord, composants en dernier. Chaque imposition part séparément ; PRODUCTION la publie (Etude, lots, fiches) dans la minute qui suit l'envoi. ⟳ pour suivre l'état.</div>"
              : "<div class='info'>Rien à publier.</div>";
    return h + "<div id='pubMsg' class='info' style='white-space:pre-line'></div></div>";
  }
  function publierCoches(b) {
    var choix = Array.prototype.map.call(document.querySelectorAll(".pubC:checked"), function (c) { return c.value; });
    if (!choix.length) { $("pubMsg").textContent = "Cochez au moins une imposition."; return; }
    var T = (b.tirages || []).filter(function (t) { return choix.indexOf(t.lettre) >= 0; })
      .sort(function (x, y) { return (x.comp ? 1 : 0) - (y.comp ? 1 : 0) || (x.lettre < y.lettre ? -1 : 1); });
    var comps = T.filter(function (t) { return t.comp; }), restants = (b.tirages || []).filter(function (t) { return !t.comp && t.fmp && !/publi/i.test(t.statut || "") && choix.indexOf(t.lettre) < 0; });
    if (comps.length && restants.length && !confirm("Contenu non coché : " + restants.map(function (t) { return t.lettre; }).join(", ") + ".\nLes composants (" + comps.map(function (t) { return t.lettre; }).join(", ") + ") seront refusés tant que le contenu n'est pas publié. Continuer ?")) return;
    if (!confirm("Publier " + T.map(function (t) { return t.lettre; }).join(", ") + " pour « " + b.libelle + " » ?")) return;
    T.forEach(function (t) {
      var it = { type: "planif", op: "publierTirage", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code,
                 donnees: { id: b.id, bdc: b.libelle, lettre: t.lettre, controle: t.controle }, titre: "Publication imposition " + t.lettre, resume: b.libelle, essais: 0 };
      soumettre(it).then(function (r) { if (r && !r.enAttente && !r.ok) alert("⛔ " + t.lettre + " : " + r.titre + "\n" + r.message); });
    });
    $("pubMsg").textContent = "📥 " + T.length + " demande(s) de publication envoyée(s) (ou gardées jusqu'à la connexion).";
    setTimeout(function () { ouvrirBDC(b.id, "publication"); }, 400);
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
    $("cxCode").setAttribute("placeholder", "PIN");
    $("cxOk").onclick = function () {
      var a = { nom: $("cxNom").value, code: $("cxCode").value.trim() };
      if (!a.nom || !a.code) { $("cxMsg").textContent = "Nom et code obligatoires."; return; }
      $("cxOk").disabled = true; $("cxMsg").textContent = "Vérification…";
      SEC.refus = "";
      rafraichirFormulaires(a).then(function () { if (droitPlanif()) rafraichirPlanif().catch(function () {}).then(majAccueil); montrer("vueAccueil"); }, function (e) {
        $("cxOk").disabled = false; $("cxMsg").textContent = "⛔ " + e.message;
        if (SEC.refus) ecranSecurite("agent", { nom: a.nom, code: a.code });
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
  $("btnNotif").onclick = function () {
    var b = this; b.disabled = true; $("infoNotif").textContent = "⏳ Activation…";
    activerNotifications(true).then(function () { majCarteNotif(); }, function (e) { $("infoNotif").textContent = "⛔ " + e.message; b.disabled = false; });
  };
  $("choixAffichage").onchange = function () { S.affichage = this.value; ecrire("affichage", S.affichage); majClassePC(); $("infoAffichage").textContent = "Affichage actuel : " + (modePC() ? "PC / tablette" : "Téléphone"); };
  $("annulerScan").onclick = function () { montrer("vueAccueil"); };
  $("btnRetour").onclick = function () {
    if (FM_OUVERT && $("vueLot").style.display !== "none" && !S.lotOuvert) { var id = FM_OUVERT; FM_OUVERT = null; ouvrirSaisieBDC(id); return; }
    FM_OUVERT = null; montrer("vueAccueil");
  };
  $("btnSync").onclick = function () {
    var b = $("btnSync"); b.disabled = true; b.textContent = "⏳";
    synchroniser(true).then(function () {
      b.disabled = false; b.textContent = "⟳";
      if (S.lotOuvert) ouvrirLot(S.lotOuvert.bdc, S.lotOuvert.cle, true);
      // Espace PC : liste à jour ; l'onglet Publication est rafraîchi (les saisies en cours ne sont pas touchées).
      if (PL.actif && PL.liste) { PL.liste(); if (PL.id && PL.onglet === "publication") ouvrirBDCPC(PL.id, "publication"); }
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

  if ("serviceWorker" in navigator) {
    // Nouvelle version installée : rechargement automatique (une seule fois), sauf saisie ou lot en cours.
    var avaitControleur = !!navigator.serviceWorker.controller, recharge = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!avaitControleur || recharge) return;
      recharge = true;
      if ($("vueAccueil").style.display !== "none") { $("etatDonnees").textContent = "✨ Mise à jour installée : redémarrage…"; setTimeout(function () { location.reload(); }, 800); }
      else $("sousTitre").textContent = "✨ Mise à jour prête : revenez à l'accueil";
    });
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      document.addEventListener("visibilitychange", function () { if (!document.hidden) reg.update().catch(function () {}); });
      setInterval(function () { reg.update().catch(function () {}); }, 30 * 60000);
    }).catch(function () {});
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  Promise.all(["url", "donnees", "gabarit", "gv", "file", "envoyes", "aCorriger", "recents", "derniereSync", "agent", "formulaires", "planif", "planifLocal", "affichage", "fin", "rh", "com", "mis", "treso", "stockv"].map(lire)).then(function (v) {
    S.treso = v[18] || null; S.stockv = v[19] || null;
    S.fin = v[14] || null; S.rh = v[15] || null; S.com = v[16] || null; S.mis = v[17] || null;
    S.agent = v[9] || null; S.formulaires = v[10] || null; S.planif = v[11] || null; S.planifLocal = v[12] || {}; S.affichage = v[13] || "auto";
    $("choixAffichage").value = S.affichage; majClassePC();
    S.url = v[0] || (typeof URL_SERVEUR === "string" ? URL_SERVEUR : "") || "";
    S.donnees = v[1] || null; S.gabarit = v[2] || ""; S.gv = v[3] || "";
    S.file = v[4] || []; S.envoyes = v[5] || []; S.aCorriger = v[6] || []; S.recents = v[7] || []; S.derniereSync = v[8] || 0;
    if (!S.gabarit) S.gv = "";
    initSecurite();
    var q = new URLSearchParams(location.search), bdc = q.get("bdc"), cle = q.get("cle");
    if (q.get("notif")) { history.replaceState(null, "", location.pathname); setTimeout(function () { ouvrirDepuisNotif({ vue: q.get("notif"), id: q.get("id") }); }, 300); }
    setTimeout(verifierNotifications, 4000);
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
