/* DuoCore — application hors ligne.
 * Le téléphone garde les lots en cours et la page de déclaration. Une déclaration faite
 * sans réseau est mise en file d'attente et envoyée dès que la connexion revient.
 * Le serveur (Apps Script) refait tous les contrôles : un refus arrive dans « À corriger ». */
(function () {
  "use strict";

  var VERSION_APP = "2026-11-14 LL";
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
    journal: [],    // 📤 derniers envois traités par le serveur (boîte « Envoyés »)
    recents: [], derniereSync: 0, lotOuvert: null,
    agent: null,        // { nom, code } : agent connecté pour les saisies (Stock…)
    formulaires: null,  // { genere, droits, formulaires: { stock: {...} } }
    planif: null,       // { genere, bdcs: [...], papiers } : planification (droit « Planification »)
    planifLocal: {}     // saisies faites sur le téléphone, par BDC (affichées tant que le serveur ne les a pas reprises)
  };
  function sauver() {
    return Promise.all([ecrire("file", S.file), ecrire("envoyes", S.envoyes), ecrire("aCorriger", S.aCorriger), ecrire("recents", S.recents), ecrire("journal", S.journal)]);
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
  function jourFr(t) { var d = new Date(t), z = function (n) { return (n < 10 ? "0" : "") + n; }; return z(d.getDate()) + "/" + z(d.getMonth() + 1) + "/" + d.getFullYear(); }
  function C() { return (S.donnees && S.donnees.constantes) || {}; }
  function dans(liste, x) { return (liste || []).indexOf(x) !== -1; }
  function attendre(p, ms) {
    return Promise.race([p, new Promise(function (ok, ko) { setTimeout(function () { ko(new Error("délai")); }, ms); })]);
  }
  /* Écran d'attente : pendant un échange avec le serveur lancé par l'opérateur (clic, touche), tout est bloqué
     et le logo DuoCore tourne. « Annuler l'attente » après 30 s (l'opération continue / reste en file). */
  var GESTE = 0, OCC = { n: 0, el: null, t: null, t30: null };
  ["pointerdown", "touchstart", "keydown"].forEach(function (ev) { document.addEventListener(ev, function (e) { if (!OCC.el || !OCC.el.contains(e.target)) GESTE = Date.now(); }, true); });
  function occupe(msg) {
    if (!OCC.el) {
      var st = document.createElement("style");
      st.textContent = "@keyframes dcTour{to{transform:rotate(360deg)}}#dcOcc{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(20,24,40,0);transition:background .2s}" +
        "#dcOcc.vis{background:rgba(20,24,40,.55)}#dcOcc .bx{opacity:0;transition:opacity .2s;background:var(--tuile,#fff);color:var(--texte,#222);border:1px solid var(--bord,#ddd);border-radius:16px;padding:22px 26px;text-align:center;min-width:220px;max-width:80vw;box-shadow:0 8px 30px rgba(0,0,0,.3)}" +
        "#dcOcc.vis .bx{opacity:1}#dcOcc img{width:72px;height:72px;border-radius:16px;animation:dcTour 1.2s linear infinite}#dcOcc p{margin:12px 0 0;font-weight:600}#dcOcc small{display:block;margin-top:4px;color:#888}";
      document.head.appendChild(st);
      OCC.el = document.createElement("div"); OCC.el.id = "dcOcc";
      OCC.el.innerHTML = "<div class='bx'><img src='icone-192.png' alt=''><p id='dcOccM'></p><small id='dcOccS'>Merci de patienter…</small>" +
        "<button class='bouton second' id='dcOccA' style='display:none;margin-top:12px'>Annuler l'attente</button></div>";
      document.body.appendChild(OCC.el);
      OCC.el.querySelector("#dcOccA").onclick = function () { OCC.n = 0; cacher(); };
    }
    function cacher() { clearTimeout(OCC.t); clearTimeout(OCC.t30); OCC.el.className = ""; OCC.el.style.display = "none"; }
    OCC.n++;
    OCC.el.querySelector("#dcOccM").textContent = msg || "Communication avec le serveur…";
    if (OCC.n === 1) {
      OCC.el.style.display = "flex"; OCC.el.querySelector("#dcOccA").style.display = "none";
      OCC.el.querySelector("#dcOccS").textContent = "Merci de patienter…";
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      OCC.t = setTimeout(function () { OCC.el.className = "vis"; }, 250);   // pas de clignotement pour les réponses rapides
      OCC.t30 = setTimeout(function () { OCC.el.querySelector("#dcOccA").style.display = ""; OCC.el.querySelector("#dcOccS").textContent = "Le serveur tarde : vous pouvez annuler l'attente (l'opération continue ou reste en file d'attente)."; }, 30000);
    }
    var fait = false;
    return function () { if (fait) return; fait = true; OCC.n = Math.max(0, OCC.n - 1); if (!OCC.n) cacher(); };
  }
  // Les fenêtres de question (alert / confirm / prompt) masquent l'écran d'attente.
  ["alert", "confirm", "prompt"].forEach(function (f) { var nat = window[f]; window[f] = function () { if (OCC.el && OCC.n) { OCC.n = 0; clearTimeout(OCC.t); clearTimeout(OCC.t30); OCC.el.className = ""; OCC.el.style.display = "none"; } return nat.apply(window, arguments); }; });
  /* PC : PDF affiché dans DuoCore (aperçu + télécharger / imprimer / partager), sans passer par les téléchargements. */
  function voirPdfBlob(blob, nom) {
    var u = URL.createObjectURL(blob), o = document.createElement("div");
    o.style.cssText = "position:fixed;inset:0;z-index:99990;background:rgba(20,24,40,.7);display:flex;flex-direction:column;padding:12px";
    o.innerHTML = "<div class='ligne' style='gap:8px;margin-bottom:8px;align-items:center'><b style='flex:1;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>📄 " + esc(nom) + "</b>" +
      "<a class='bouton second' href='" + u + "' download='" + esc(nom) + "' style='flex:0 0 auto;width:auto;margin:0'>⬇️ Télécharger</a>" +
      "<button class='bouton second' id='pdfImp' style='flex:0 0 auto;width:auto;margin:0'>🖨️ Imprimer</button>" +
      "<button class='bouton' id='pdfFerm' style='flex:0 0 auto;width:auto;margin:0'>✕ Fermer</button></div>" +
      "<iframe src='" + u + "' style='flex:1;border:0;border-radius:10px;background:#fff'></iframe>";
    document.body.appendChild(o);
    o.querySelector("#pdfFerm").onclick = function () { o.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); };
    o.querySelector("#pdfImp").onclick = function () { try { o.querySelector("iframe").contentWindow.print(); } catch (e) { window.open(u, "_blank"); } };
  }
  function messageAttente(url, options) {
    var b = String(options.body || ""), m = b.match(/"api":"(\w+)"/), a = m ? m[1] : "";
    if (!a) return /api=donnees/.test(url) ? "Mise à jour des données…" : "Communication avec le serveur…";
    if (/Envoyer$|^repondre$|^declarer$/.test(a) || /"decision":/.test(b)) return "Envoi en cours…";
    if (/Pdf$|^finExport$|^finReleve$|^tresoReleve$/.test(a)) return "Préparation du document…";
    return "Chargement…";
  }
  function requete(url, options, ms) {
    var fin = navigator.onLine !== false && Date.now() - GESTE < 1500 ? occupe(messageAttente(url, options)) : null;
    return requeteBrute(url, options, ms).then(function (j) { if (fin) fin(); return j; }, function (e) { if (fin) fin(); throw e; });
  }
  function requeteBrute(url, options, ms) {
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
  var NAV = { pile: [], retour: false };
  function navEnvelopper(nom, fn) {
    return function () {
      var a = Array.prototype.slice.call(arguments).filter(function (x) { return !(x && x.target !== undefined && x.type); });   // pas l'événement du clic
      if (["afficherFinances", "afficherRH", "afficherCom", "afficherMis"].indexOf(nom) >= 0) a = [];   // la liste, pas l'élément ouvert
      if (!NAV.retour) {
        var P = NAV.pile, i;
        while (P.length && /^formulaire|^ouvrirFormulaire/.test(P[P.length - 1].n) && P[P.length - 1].n !== nom) P.pop();
        for (i = 0; i < P.length; i++) if (P[i].n === nom) break;
        if (i < P.length) P.length = i;   // écran déjà dans la pile : on y remonte
        P.push({ n: nom, a: a });
      }
      return fn.apply(null, a);
    };
  }
  function montrer(vue) {
    if (vue === "vueAccueil") NAV.pile = [];
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
    try { majCloche(); } catch (eC) {}
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
    if (droitPlanif()) {
      var nPl = S.file.filter(function (x) { return x.type === "planif"; }).length;
      tuile("planif", "🗂️", "Planification", "BDC, saisie", nPl ? { badge: nPl, bcls: "orange" } : {});
    }
    tuile("scan", "📷", "Scanner une fiche", "Atelier", { cls: "principale" });
    tuile("manuel", "🔢", "Lot sans QR", S.recents.length ? "Derniers lots" : "");
    if (S.agent && S.url) { tuile("journal", "🧾", "Journal Prod", "Vérifier les scans"); tuile("avancement", "📊", "État d'avancement", "BDC et lots"); }
    Object.keys(fs).forEach(function (k) {
      if (k === "stock") return;   // dans la rubrique « Magasins » (Sortie Stock M2S)
      tuile("form:" + k, k === "stock" ? "📦" : "🧾", k === "stock" ? "Sortie de stock" : fs[k].nom || fs[k].titre || k, fs[k].erreur ? "indisponible" : k === "stock" ? "Nouvelle saisie" : "");
    });
    if (droitFin() || droitRH() || droitCom() || droitTreso() || droitMis() || droitRep() || droitStockVal() || fs.stock) section("Gestion");
    if (droitStockVal() || fs.stock) { var nS = stockNbAttente(); tuile("magasins", "🏬", "Magasins", "Stock, Sortie Stock M2S, transferts", nS ? { badge: nS, bcls: S.stockv && S.stockv.direction ? "rouge" : "orange" } : {}); }
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
    if (droitRep()) tuile("repartition", "📊", "Répartition", "Recouvrements, commissions", { cls: "large" });
    if (droitMis()) {
      var nM = misNbBadge();
      tuile("missions", "🎯", "Missions", S.mis && S.mis.direction ? "Équipe, clôture" : "Mes missions", nM ? { badge: nM, bcls: "rouge", cls: "large" } : { cls: "large" });
    }
    section("Appareil");
    if (!S.agent && S.url) tuile("connexion", "🔐", "Saisies", "Se connecter");
    var nAtt = S.file.length + S.aCorriger.length;   // seulement ce qui n'est pas passé : suspendus ⛔ + attente réseau
    tuile("attente", "⏳", "En attente", S.aCorriger.length ? S.aCorriger.length + " suspendu" + (S.aCorriger.length > 1 ? "s" : "") + (S.file.length ? " · " + S.file.length + " à envoyer" : "") : S.file.length ? "à envoyer" : "rien",
      nAtt ? { badge: nAtt, bcls: S.aCorriger.length ? "rouge" : "orange" } : {});
    tuile("sync", "⇅", "Synchronisation", S.derniereSync ? dateCourte(S.derniereSync) : "jamais");
    tuile("reglages", "⚙️", "Réglages", S.agent ? S.agent.nom : "");
    $("tuiles").innerHTML = t.join("");
    Array.prototype.forEach.call($("tuiles").querySelectorAll("[data-t]"), function (el) {
      el.onclick = function () {
        var id = el.getAttribute("data-t");
        AIDE.ctx = AIDE_TUILE[id] || (id.indexOf("form:") === 0 ? "magasins" : "base");
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
        else if (id === "magasins") afficherMagasins("");
        else if (id === "repartition") afficherRepartition();
        else if (id === "journal") afficherJournal();
        else if (id === "avancement") afficherAvancement();
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
      S.agent = null; S.formulaires = null; S.planif = null; S.fin = null; S.rh = null; S.com = null; S.mis = null; S.treso = null; S.stockv = null; ecrire("stockv", null); S.mag = null; ecrire("mag", null); S.rep = null; ecrire("rep", null); TRV.releves = {}; ecrire("treso", null); FOUR.liste = null; FOUR.fiches = {}; ecrire("four", null); ecrire("com", null); ecrire("mis", null); ecrire("agent", null); ecrire("formulaires", null); ecrire("planif", null); ecrire("fin", null); ecrire("rh", null); montrer("vueAccueil");
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
    if (!o) return "<b>" + esc(x.titre || x.resume || "Envoi") + "</b><br><small>" + esc(x.agent || "") + " · " + dateCourte(x.horodatage) + "</small>";
    return esc(o.cle) + " · " + esc(o.bdc) + "<br>" + esc(o.poste) + libEvt(o) + (o.quantite ? " · " + esc(o.quantite) : "") +
      "<br><small>" + esc(o.operateur) + " · " + dateCourte(x.horodatage) + "</small>";
  }
  // 📤 Envoyés : copie légère (sans fichiers ni données) des 10 derniers envois traités, pour se situer.
  function noterEnvoi(it, r) {
    if (!(r && r.ok)) return;   // refusés : restent en ⛔ Suspendus (S.aCorriger)
    var dn = it.donnees || {}, no = (r && (r.no || r.id)) || dn.no || (dn.demande && dn.demande.no) || dn.id || "";
    S.journal = S.journal || [];
    S.journal.unshift({ jeton: it.jeton, type: it.type, op: it.op || "", titre: it.titre || "", resume: it.resume || "", agent: it.agent, horodatage: it.horodatage, o: it.o || null,
      no: String(no || ""), recuA: Date.now(), ok: !!(r && r.ok), rt: (r && r.titre) || "", rm: String((r && r.message) || "").split("\n")[0].substring(0, 160) });
    S.journal = S.journal.filter(function (x, i, A) { return A.findIndex(function (y) { return y.jeton === x.jeton; }) === i; }).slice(0, 10);
  }
  function ouvrirEnvoi(x) {
    if (x.o) return ouvrirLot(x.o.bdc, x.o.cle);
    if (x.type === "fin" && /^D-\d{4}-\d+$/.test(x.no)) return afficherFinances(x.no);
    if (x.type === "fin") return afficherFinances();
    if (x.type === "mis" && typeof ficheMis === "function" && /^M-/.test(x.no)) return ficheMis(x.no);
    if (x.type === "planif" && x.no && typeof ouvrirBDC === "function") return ouvrirBDC(x.no);
  }
  // ⏳ En attente : ⛔ suspendus (refusés par le serveur, à renvoyer) en haut, 📥 attente réseau, ✅ 10 derniers envoyés en bas.
  function afficherListe(type) {
    var v = $("vueListe"), h = "";
    $("titre").textContent = "En attente";
    h += "<h3 style='margin:4px 0'>⛔ Suspendus (" + S.aCorriger.length + ")</h3>";
    h += S.aCorriger.map(function (x, i) {
      var r = x.r || {};
      return "<div class='carte ko'><div>" + descriptionItem(x) + "</div><b>⛔ " + esc(r.titre || "Refusé") + "</b>" +
        "<p style='white-space:pre-line;margin:4px 0'>" + esc(r.message || "") + "</p>" +
        (r.details && r.details.length ? "<table>" + r.details.map(function (d) { return "<tr><td>" + esc(d[0]) + "</td><td class='v'>" + esc(d[1]) + "</td></tr>"; }).join("") + "</table>" : "") +
        "<div class='ligne'><button class='bouton' data-renvoyer='" + i + "'>🔁 Renvoyer</button>" + (x.o ? "<button class='bouton second' data-ouvrir='" + i + "'>Ouvrir le lot</button>" : "") +
        (x.type === "planif" && x.donnees ? "<button class='bouton second' data-planif='" + i + "'>Reprendre la saisie</button>" : "") +
        "<button class='bouton second' data-effacer='" + i + "'>🗑️ Effacer</button></div></div>";
    }).join("") || "<p class='info'>Aucun envoi suspendu.</p>";
    h += "<h3 style='margin:16px 0 4px'>📥 En attente de réseau (" + S.file.length + ")</h3>";
    h += S.file.map(function (x) {
      return "<div class='carte att'>" + descriptionItem(x) + (x.essais ? "<br><small>" + x.essais + " essai(s)" + (x.erreur ? " — " + esc(x.erreur) : "") + "</small>" : "") + "</div>";
    }).join("") || "<p class='info'>Rien en attente : tout est parti.</p>";
    if (S.file.length) h += "<button class='bouton' id='btnEnvoyerMaintenant'>Envoyer maintenant</button>";
    var J = (S.journal || []).filter(function (x) { return x.ok; }).slice(0, 10);
    h += "<h3 style='margin:16px 0 4px'>✅ Envoyés (10 derniers)</h3>";
    h += J.map(function (x) {
      var ouv = x.o || x.type === "fin" || (x.type === "mis" && /^M-/.test(x.no)) || (x.type === "planif" && x.no);
      return "<div class='carte'" + (ouv ? " data-env='" + esc(x.jeton) + "' style='cursor:pointer'" : "") + ">" + descriptionItem(x) +
        "<br><small>✅ " + esc(x.rt || "Enregistré") + (x.rm ? " — " + esc(x.rm) : "") + " · reçu " + dateCourte(x.recuA) + "</small>" + (ouv ? "<span style='float:right;opacity:.6'>›</span>" : "") + "</div>";
    }).join("") || "<p class='info'>Aucun envoi enregistré sur cet appareil pour l'instant.</p>";
    v.innerHTML = h;
    montrer("vueListe");
    Array.prototype.forEach.call(v.querySelectorAll("[data-effacer]"), function (b) {
      b.onclick = function () { if (!confirm("Effacer cet envoi suspendu ? Rien n'a été enregistré sur le serveur.")) return; S.aCorriger.splice(+b.getAttribute("data-effacer"), 1); sauver(); majAccueil(); afficherListe(); };
    });
    Array.prototype.forEach.call(v.querySelectorAll("[data-renvoyer]"), function (b) { b.onclick = function () { b.disabled = true; b.textContent = "Envoi…"; renvoyerSuspendu(+b.getAttribute("data-renvoyer")); }; });
    Array.prototype.forEach.call(v.querySelectorAll("[data-planif]"), function (b) { b.onclick = function () { ouvrirBDC(S.aCorriger[+b.getAttribute("data-planif")].donnees.id); }; });
    Array.prototype.forEach.call(v.querySelectorAll("[data-ouvrir]"), function (b) { b.onclick = function () { var o = S.aCorriger[+b.getAttribute("data-ouvrir")].o; ouvrirLot(o.bdc, o.cle); }; });
    Array.prototype.forEach.call(v.querySelectorAll("[data-env]"), function (b) { b.onclick = function () { ouvrirEnvoi(J.filter(function (x) { return x.jeton === b.getAttribute("data-env"); })[0]); }; });
    var be = $("btnEnvoyerMaintenant");
    if (be) be.onclick = function () { be.disabled = true; be.textContent = "Envoi…"; synchroniser(true).then(function () { afficherListe(); }); };
  }
  // 🔁 Renvoi d'un envoi suspendu : même saisie, nouveau jeton ; doublon possible (Finances) → confirmation.
  function renvoyerSuspendu(i, forcer) {
    var x = S.aCorriger[i]; if (!x) return afficherListe();
    var it = JSON.parse(JSON.stringify(x));
    delete it.r; delete it.erreur; it.jeton = nouveauJeton(); it.essais = 0; it.code = S.agent && S.agent.code;
    if (forcer && it.donnees) { it.donnees.forcerDoublon = true; if (it.donnees.demande) it.donnees.demande.forcerDoublon = true; }
    S.aCorriger.splice(i, 1);
    soumettre(it).then(function (r) {
      r = r || {};
      if (!r.ok && !r.enAttente) {   // refusé à nouveau : il revient en ⛔ (lancerEnvoi l'y a remis si la réponse est arrivée par la file)
        if (!S.aCorriger.some(function (y) { return y.jeton === it.jeton; })) { var c = JSON.parse(JSON.stringify(it)); c.r = r; delete c.code; S.aCorriger.unshift(c); sauver(); }
        if (r.doublon && confirm((r.titre || "") + "\n\n" + (r.message || "") + "\n\nOK = envoyer quand même")) {
          var k = S.aCorriger.findIndex(function (y) { return y.jeton === it.jeton; }); if (k >= 0) return renvoyerSuspendu(k, true);
        } else if (!r.doublon) alert("⛔ " + (r.titre || "Refusé") + "\n" + (r.message || ""));
      } else alert((r.enAttente ? "📥 " : "✅ ") + (r.titre || "") + (r.message ? "\n" + r.message : ""));
      majAccueil(); afficherListe();
    });
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
    if ($("lotAp") && S.agent && S.url) { $("lotAp").style.display = ""; apercuServeur("lotAp", "l:" + lot.bdc + "|" + lot.cle, { quoi: "lot", bdc: lot.bdc, cle: lot.cle }, "5 derniers pointages de ce lot", function (r) {
      return apercuLignes((r.lignes || []).map(function (l) { return { date: l.date, lib: l.poste + (l.passage > 1 ? " P" + l.passage : "") + " · " + l.evenement + (l.quantite ? " · " + gnf(l.quantite) : "") + " · 👷 " + l.operateur + (l.anomalies && l.anomalies.length ? " · ⚠️" : "") }; }), "");
    }); } else if ($("lotAp")) $("lotAp").style.display = "none";
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
    if (S.majRequise && plusAncienne(S.majRequise)) return Promise.resolve(0);   // tout est bloqué jusqu'à la mise à jour
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
          if (r && r.majRequise) { it.essais--; it.erreur = "en attente de la mise à jour de l'app"; return sauver().then(function () { return n; }); }   // gardé : repart après la mise à jour
          if (r && r.appareilRefus) { it.essais--; it.erreur = "en attente du code de connexion (DG)"; return sauver().then(function () { return n; }); }   // gardé : repart après le code
          if (erreurPassagere(r) && it.essais < 6) { it.erreur = r.message; return sauver().then(function () { return n; }); }
          S.file.shift();
          resultats[it.jeton] = r;
          noterEnvoi(it, r);
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
    var cadreFM = PL.id ? $("plCadre") : $("cadre"); if (!PL.id && $("lotAp")) $("lotAp").style.display = "none";
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
    if (d.proposition && !d.proposition.etat) return role === "DG";
    if (d.doublon && d.doublon.etat === "attente" && d.statut === "À exécuter") return role === "DG" || role === "Walid";
    if (finDoublonsExec(d).length) return true;
    if (d.demandeur === F.auto && d.statut === "À exécuter" && (role || F.comptable || F.rh)) return true;
    return d.demandeur === (S.agent && S.agent.nom) && (d.statut === "À corriger" || d.statut === "À exécuter");
  }
  // « À traiter » : toute opération non close (ni exécutée, refusée, annulée, ni facture soldée) ; 👉 = action attendue de vous.
  // Doublon possible déjà exécuté : demande exécutée semblable à une autre exécutée avant elle (≤ 72 h), non encore tranchée par Walid / le DG.
  function finDoublonsExec(d) {
    if (!S.fin || d.statut !== "Exécutée" || (d.doublon && d.doublon.etat) || !(S.fin.role === "DG" || S.fin.role === "Walid")) return [];
    var tx = d.execute || d.date;
    return S.fin.demandes.filter(function (z) {
      var tz = z.execute || z.date;
      return z.no !== d.no && z.statut === "Exécutée" && (!d.groupe || z.groupe !== d.groupe) && z.type === d.type && z.op === d.op && z.compte === d.compte && z.contrepartie === d.contrepartie
        && z.devise === d.devise && Math.abs(z.montant - d.montant) <= 0.5 && (d.fournisseur || "") === (z.fournisseur || "") && (d.personnel || "") === (z.personnel || "")
        && (tz < tx || (tz === tx && z.no < d.no)) && tx - tz < 72 * 3600000 && finObjetsProches(z.objet, d.objet);
    });
  }
  // Objets semblables : mêmes mots significatifs (≥ 70 % du plus court), repères [..] ignorés (même règle que le script).
  function finMotsObjet(v) {
    var VIDES = ["les", "des", "du", "de", "la", "le", "pour", "avec", "sur", "dans", "par", "aux", "une", "un", "et", "mois"], A = [];
    String(v || "").replace(/\[[^\]]*\]/g, " ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/)
      .forEach(function (w) { if (w.length >= 3 && VIDES.indexOf(w) < 0 && A.indexOf(w) < 0) A.push(w); });
    return A;
  }
  function finObjetsProches(a, b) {
    var A = finMotsObjet(a), B = finMotsObjet(b);
    if (!A.length && !B.length) return true;
    if (!A.length || !B.length) return false;
    return A.filter(function (w) { return B.indexOf(w) >= 0; }).length / Math.min(A.length, B.length) >= 0.7;
  }
  function finOuverte(d) { return (["Exécutée", "Refusée", "Annulée"].indexOf(d.statut) < 0 && !(d.statut === "Validée" && (!d.solde || d.solde.reste <= 0))) || finDoublonsExec(d).length > 0; }
  function finNbOuvertes() { return S.fin ? S.fin.demandes.filter(finOuverte).length : 0; }
  function finNbATraiter() { return S.fin ? S.fin.demandes.filter(finATraiter).length : 0; }
  var COUL_ST = { "En attente Walid": "#e65100", "En attente DG": "#e65100", "À corriger": "#b26a00", "Refusée": "#c62828", "Validée": "#2e7d32", "À exécuter": "#1565c0", "Exécutée": "#2e7d32", "Annulée": "#777" };
  function statutFin(d) { return d.solde && d.statut === "Validée" ? (d.solde.reste <= 0 ? "Soldée" : d.solde.regle > 0 ? "Partiellement payée" : "Validée — à payer") : d.statut; }
  // Clôture sans pièce : retrait (la photo du chèque de la demande fait foi) et transfert entre caisses.
  function sansPreuveFin(d) { return (d.type === "Mouvement de trésorerie" && (d.op === "Retrait" || d.op === "Transfert entre caisses")) || (d.type === "Règlement fournisseur" && d.mode === "Chèque" && d.categorie === "Commission") || (d.categorie === "Commission" && (d.pieces || []).length > 0); }
  function libelleFin(d) { return d.type === "Mouvement de trésorerie" || d.type === "Opération constatée" ? d.op : d.type === "Paiement RH" ? (S.fin && d.demandeur === S.fin.auto ? "Salaire · " : "Paie RH · ") + d.personnel
    : d.type === "Règlement fournisseur" && d.groupe ? "Règlement groupé · " + (d.refFacture || d.facture)
    : d.type === "Règlement fournisseur" && d.op === "Achat comptant" ? "Achat payé" + (d.refFacture ? "" : " sans facture") : d.type === "Facture d'achat" ? (d.op === "Sans facture" ? "Achat à payer sans facture" : "Achat à payer (facture)") : d.type; }
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
      "<div class='onglets' style='margin-top:10px'>" + [["traiter", "À traiter (" + finNbOuvertes() + (finNbATraiter() ? " · 👉 " + finNbATraiter() : "") + ")"], ["miennes", "Mes demandes"]].concat(F.role || F.comptable ? [["toutes", "Toutes"]] : [])
        .map(function (o) { return "<button data-f='" + o[0] + "' class='" + (FIN.filtre === o[0] ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + o[1] + "</button>"; }).join("") + "</div>" +
      "<input id='fnCherche' placeholder='Rechercher (n°, fournisseur, objet…)' style='margin-top:8px'></div>" +
      (nouv.length ? "<div class='carte att'>⏳ " + nouv.length + " nouvelle(s) demande(s) sur cet appareil, en attente d'envoi.</div>" : "") +
      "<div id='fnListe'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    function liste() {
      var q = $("fnCherche").value.trim().toLowerCase(), moi = S.agent.nom;
      var L = F.demandes.filter(function (d) {
        if (FIN.filtre === "traiter" && !finOuverte(d)) return false;
        if (FIN.filtre === "miennes" && d.demandeur !== moi) return false;
        return !q || (d.no + " " + d.type + " " + d.op + " " + d.fournisseur + " " + d.objet + " " + d.refFacture + " " + d.demandeur).toLowerCase().indexOf(q) >= 0;
      }).sort(function (a, b) { return (FIN.filtre === "traiter" ? (finATraiter(b) ? 1 : 0) - (finATraiter(a) ? 1 : 0) : 0) || b.date - a.date; });
      $("fnListe").innerHTML = L.map(function (d) {
        var att = finAttente(d.no).length, moiA = finATraiter(d);
        return "<div class='carte" + (att ? " att" : "") + "' data-no='" + esc(d.no) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + esc(d.no) + " · " + esc(libelleFin(d)) + "</b>" +
          "<b style='flex:0;white-space:nowrap'>" + gnf(d.montant) + " " + esc(d.devise) + "</b></div>" +
          "<div class='info'>" + esc(d.fournisseur || d.objet || d.compte || "") + (d.pourCompte ? " · <b>pour " + esc(d.pourCompte) + "</b>" : "") + " · " + esc(d.demandeur) + " · " + dateCourte(d.date) +
            (d.dateEffet && !(d.type === "Paiement RH" && d.motifRH === "SALAIRE (RH)") && (!d.execute || isoJour(d.dateEffet) !== isoJour(d.execute)) ? " · effet " + jourFr(d.dateEffet) : "") + "</div>" +
          "<div style='color:" + (COUL_ST[d.statut] || "#999") + ";font-weight:700;font-size:14px'>" + (moiA ? "👉 " : "") + esc(statutFin(d)) + (moiA ? " · à vous" : "") + (att ? " · ⏳ action en attente d'envoi" : "") +
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
  function voirPiece(no, p, cible, apiNom) {
    var aff = function (o) {
      var url = URL.createObjectURL(o);
      if (p.type === "pdf") { window.open(url, "_blank"); return; }
      cible.innerHTML = "<img src='" + url + "' style='max-width:100%;border-radius:8px;margin-top:8px'>";
    };
    if (PIECES[p.id]) { aff(PIECES[p.id]); return; }
    cible.innerHTML = "<div class='info'>⏳ Chargement…</div>";
    api({ api: apiNom || "finPiece", no: no, id: p.id }, 120000).then(function (r) {
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
      ligne("Achat", d.achat ? esc(d.achat.nature + " · " + (d.achat.article || d.achat.designation || (d.achat.articles || []).join(", ")) + (d.achat.quantite ? " · qté " + d.achat.quantite : "") + (d.achat.magasin ? " · 🏬 " + d.achat.magasin : "")) + (d.achatId ? " [" + esc(d.achatId) + "]" : "") : "") +
      ligne("Pour le compte de", d.pourCompte ? "<b>" + esc(d.pourCompte) + "</b> (dette envers " + esc(d.societe) + ")" : "") + ligne("Bénéficiaire", esc(d.beneficiaire)) + ligne("Catégorie", esc(d.categorie)) + ligne(d.type === "Paiement RH" ? "Équivalent" : "Reçu", d.recu ? gnf(d.recu) + " " + esc(d.deviseRecue) : "") +
      (d.type === "Paiement RH" && d.motifRH === "SALAIRE (RH)" ? ligne("Mois", d.dateEffet ? moisLib(d.dateEffet) : "")
        : ligne("Date d'effet", d.dateEffet ? "<b>" + jourFr(d.dateEffet) + "</b>" : d.statut === "Exécutée" ? "= date d'exécution" : "")) +
      ligne("Exécutée le", d.execute ? dateCourte(d.execute) : "") +
      ligne("Base", d.ligneBase ? "ligne " + esc(d.ligneBase) : "") + ligne("Société", esc(d.societe)) + ligne("Échéance", d.echeance ? dateCourte(d.echeance).split(" ")[0] : "") +
      ligne("Demandeur", esc(d.demandeur) + " · " + dateCourte(d.date)) +
      (d.solde ? ligne("Réglé / reste", gnf(d.solde.regle) + " / <b>" + gnf(d.solde.reste) + " GNF</b>" + (d.solde.engage ? "<br><small>dont " + gnf(d.solde.engage) + " en cours</small>" : "") + (d.solde.avance ? "<br><small>dont " + gnf(d.solde.avance) + " d'avance imputée (" + esc((d.solde.avances || []).join(", ")) + ")</small>" : "")) : "") +
      ligne("Walid", trace(d.walid)) + (d.validations.indexOf("DG") >= 0 ? ligne("DG", trace(d.dg)) : "") + "</table></div>" +
      htmlPieces(d, d.pieces, "Pièces", "P") + htmlPieces(d, d.preuves, "Preuves", "R") +
      "<div class='carte'><h3>Historique</h3>" + d.historique.map(function (x) { return "<div class='info'>" + dateCourte(x.q) + " · " + esc(x.a) + " · " + esc(x.act) + (x.c ? " — " + esc(x.c) : "") + "</div>"; }).join("") + "</div>" +
      "<div id='fnActions'></div><div id='fnImput'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    // 🔗 Avance fournisseur exécutée : imputation sur une facture non soldée du même compte (sans nouveau paiement).
    if (d.type === "Règlement fournisseur" && !d.facture && d.statut === "Exécutée" && (role || d.demandeur === moi)) (function () {
      var IM = d.imputations || [], deja = IM.reduce(function (t, x) { return t + (+x.mt || 0); }, 0), reste = Math.round(d.gnf - deja);
      var FA = (F.factures || []).filter(function (f) { return String(f.fournisseur).toLowerCase() === String(d.fournisseur).toLowerCase() && (f.devise || "GNF") === (d.devise || "GNF") && f.reste > 0; });
      $("fnImput").innerHTML = "<div class='carte'><h3>🔗 Avance : imputation sur facture</h3>" +
        "<div class='info'>Avance " + gnf(d.gnf) + " · imputé " + gnf(deja) + " · <b>reste à imputer " + gnf(reste) + " GNF</b></div>" +
        IM.map(function (x, i) { return "<div class='ligne' style='justify-content:space-between;align-items:center;border-top:1px solid var(--bord);padding:4px 0'><span>→ " + esc(x.facture) + " : " + gnf(x.mt) + " <small class='info'>(" + esc(x.par || "") + ")</small></span><button class='bouton second' data-imr='" + i + "' style='width:auto;flex:0 0 auto;padding:4px 10px'>Retirer</button></div>"; }).join("") +
        (reste > 0 ? (FA.length ? "<div class='ligne'><div style='flex:2'><label>Facture non soldée</label><select id='imF'>" + FA.map(function (f) { return "<option value='" + esc(f.no) + "' data-r='" + f.reste + "'>" + esc(f.no) + " · " + esc(f.ref || "") + " · reste " + gnf(f.reste) + "</option>"; }).join("") + "</select></div>" +
          "<div><label>Montant</label><input id='imM' inputmode='decimal'></div></div><button class='bouton' id='imOk'>🔗 Imputer sur la facture</button>" : "<p class='info'>Aucune facture non soldée sur ce compte fournisseur.</p>") : "") + "</div>";
      function maxi() { var o = $("imF").options[$("imF").selectedIndex]; $("imM").value = Math.min(reste, +o.getAttribute("data-r")); }
      if ($("imF")) { $("imF").onchange = maxi; maxi(); }
      if ($("imOk")) $("imOk").onclick = function () {
        var mt = parseFloat(String($("imM").value).replace(/\s/g, "").replace(",", "."));
        if (!(mt > 0)) { alert("⛔ Montant."); return; }
        if (!confirm("Imputer " + gnf(mt) + " de l'avance " + d.no + " sur la facture " + $("imF").value + " ?")) return;
        envoyerFin("imputer", { no: d.no, version: d.version, facture: $("imF").value, montant: mt }, "Imputation " + d.no, d.no);
      };
      Array.prototype.forEach.call($("fnImput").querySelectorAll("[data-imr]"), function (b) { b.onclick = function () { var x = IM[+b.getAttribute("data-imr")];
        if (confirm("Retirer l'imputation de " + gnf(x.mt) + " sur " + x.facture + " ?")) envoyerFin("imputer", { no: d.no, version: d.version, facture: x.facture, montant: 0 }, "Imputation retirée " + d.no, d.no); }; });
    })();
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-p]"), function (b) {
      b.onclick = function () { var k = b.getAttribute("data-p"), src = k.charAt(0) === "R" ? d.preuves : d.pieces;
        voirPiece(d.no, src[+k.substring(1)], $("pv" + k.charAt(0))); };
    });
    if (att.length) return;
    var A = $("fnActions"), peutValider = (d.statut === "En attente Walid" && (role === "Walid" || role === "DG")) || (d.statut === "En attente DG" && role === "DG");
    if (peutValider) {
      var nG = d.groupe ? F.demandes.filter(function (x) { return x.groupe === d.groupe && x.statut === d.statut; }).length : 0;
      A.innerHTML = "<div class='carte'><h3>Votre décision</h3>" + (nG > 1 ? "<div class='info'>🔗 Règlement groupé : la décision s'applique aux " + nG + " factures du groupe (" + esc(F.demandes.filter(function (x) { return x.groupe === d.groupe; }).map(function (x) { return x.no; }).join(", ")) + ").</div>" : "") + "<label>Commentaire / correction demandée (obligatoire pour refuser ou renvoyer)</label><textarea id='fnCom' rows='2'></textarea>" +
        "<button class='bouton' id='fnVal' style='background:var(--vert)'>✅ Valider</button><button class='bouton alerte' id='fnCor'>↩️ Retour pour correction</button><button class='bouton' id='fnRef' style='background:var(--rouge)'>⛔ Refuser</button><div id='fnMsg' class='info'></div></div>";
      [["fnVal", "valider"], ["fnCor", "corriger"], ["fnRef", "refuser"]].forEach(function (x) {
        $(x[0]).onclick = function () {
          var com = $("fnCom").value.trim();
          if (x[1] !== "valider" && !com) { $("fnMsg").textContent = "⛔ Commentaire obligatoire."; return; }
          if (x[1] !== "valider" && !confirm((x[1] === "refuser" ? "Refuser " : "Renvoyer pour correction ") + d.no + " ?")) return;
          envoyerFin("decider", { no: d.no, version: d.version, decision: x[1], commentaire: com }, (x[1] === "valider" ? "Validation " : x[1] === "refuser" ? "Refus " : "Correction ") + d.no, d.no);
        };
      });
    } else if (d.statut === "À exécuter" && ((d.proposition && !d.proposition.etat) || (d.doublon && d.doublon.etat === "attente"))) {
      A.innerHTML = "";   // exécution suspendue : la carte de la proposition s'affiche plus bas
    } else if (d.statut === "À exécuter" && (d.demandeur === moi || role || (d.demandeur === F.auto && (F.comptable || F.rh)))) {
      var auto = d.demandeur === F.auto;
      // Salaire automatique : mode, compte payeur et, si sa devise diffère de celle du salaire, montant payé et taux.
      A.innerHTML = "<div class='carte'><h3>Paiement effectué</h3>" +
        (auto ? "<div class='ligne'><div><label>Mode</label><select id='fnPm'><option" + (d.beneficiaire ? "" : " selected") + ">Espèces</option><option" + (d.beneficiaire ? " selected" : "") + ">Virement</option></select></div>" +
          "<div style='flex:2'><label>Compte payeur</label><select id='fnPc'></select></div></div>" +
          "<div id='fnPmB'><label id='fnPmL'>Montant payé</label><input id='fnPmt' inputmode='decimal'></div><div id='fnPtB'><label>Taux (1 unité = … GNF)</label><input id='fnPt' inputmode='decimal'></div>" +
          "<div class='info' id='fnPi'></div>" : "") +
        "<div class='info'>" + (d.type === "Dépense de caisse" ? "Justificatif facultatif." : sansPreuveFin(d) ? (d.categorie === "Commission" ? "Commission : le chèque / justificatif joint à la demande suffit, clôture directe (pièce facultative)." : "Pas de pièce à joindre (la photo du chèque de la demande fait foi) : justificatif facultatif.") : "Photo de la preuve obligatoire : reçu, talon de chèque, avis de virement…") + "</div>" +
        champFichiers("fnPr") + (d.type === "Paiement RH" && d.motifRH === "SALAIRE (RH)" ? "" : "<label>Date d'effet <small>(vide = aujourd'hui, date d'exécution)</small></label><input id='fnEff' type='date' value='" + (d.dateEffet ? isoJour(d.dateEffet) : "") + "'>") +
        "<label>Commentaire</label><input id='fnCom'><button class='bouton' id='fnExe'>🧾 Clôturer : paiement effectué</button><div id='fnMsg' class='info'></div></div>";
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
        if ($("fnEff")) x.dateEffet = $("fnEff").value;
        if (auto) {
          var c = cptP();
          if (!c) { $("fnMsg").textContent = "⛔ Choisissez le compte payeur."; return; }
          x.paiement = { mode: $("fnPm").value, compte: c.nom, montant: c.devise !== d.devise ? nbx($("fnPmt").value) : d.montant, taux: c.devise !== "GNF" ? nbx($("fnPt").value) : 1 };
          if (!(x.paiement.montant > 0)) { $("fnMsg").textContent = "⛔ Indiquez le montant payé."; return; }
          if (!(x.paiement.taux > 0)) { $("fnMsg").textContent = "⛔ Indiquez le taux."; return; }
        }
        if (!f.length && d.type !== "Dépense de caisse" && !sansPreuveFin(d)) { $("fnMsg").textContent = "⛔ Ajoutez la photo de la preuve."; return; }
        envoyerFin("executer", x, "Paiement " + d.no, d.no);
      };
    } else if ((d.demandeur === moi || (d.demandeur === F.auto && role)) && ["En attente Walid", "En attente DG", "À corriger"].indexOf(d.statut) >= 0) {
      var avantVal = d.statut === "En attente Walid" && !d.walid && !d.dg;
      A.innerHTML = "<div class='carte'>" + (d.demandeur === moi && (d.statut === "À corriger" || avantVal) ? "<button class='bouton' id='fnMod'>✏️ " + (d.statut === "À corriger" ? "Corriger et renvoyer" : "Modifier ma demande (avant validation)") + "</button>" : "") +
        "<button class='bouton second' id='fnAnn'>Annuler la demande</button></div>";
      if ($("fnMod")) $("fnMod").onclick = function () { formulaireFin(d); };
      $("fnAnn").onclick = function () { if (confirm("Annuler " + d.no + " ?")) envoyerFin("annuler", { no: d.no, version: d.version }, "Annulation " + d.no, d.no); };
    }
    // ✏️ Direction : avant validation WALID / DG modifient ; après validation le DG modifie, Walid demande une correction au DG.
    var avantV = ["En attente Walid", "En attente DG", "À corriger"].indexOf(d.statut) >= 0, apresV = ["À exécuter", "Validée"].indexOf(d.statut) >= 0 && !(d.solde && (d.solde.regle > 0 || d.solde.engage > 0));
    if (d.type !== "Opération constatée" && ((avantV && role) || (apresV && role === "DG"))) {
      A.insertAdjacentHTML("beforeend", "<div class='carte'><button class='bouton second' id='fnDirMod'>✏️ Modifier (" + esc(role) + ")</button><div class='info'>" + (avantV ? "Avant validation : Walid ou le DG corrigent directement." : "Après validation : seul le DG modifie.") + "</div></div>");
      $("fnDirMod").onclick = function () { formulaireDirection(d); };
    } else if (role === "Walid" && d.statut === "À exécuter" && !(d.proposition && !d.proposition.etat)) {
      A.insertAdjacentHTML("beforeend", "<div class='carte'><h3>Changer l'opération (accord du DG)</h3><div class='ligne'><button class='bouton second' id='fnPm'>✏️ Demander une modification</button>" +
        "<button class='bouton second' id='fnPa'>🗑️ Demander l'annulation</button></div><div class='info'>Modification : montant, comptes, objet… <b>sans changer la pièce jointe</b>. " +
        "Si la pièce doit changer (autre chèque) : demandez l'annulation, puis refaites la demande avec la nouvelle pièce.</div></div>");
      $("fnPm").onclick = function () { formulaireDirection(d, true); };
      $("fnPa").onclick = function () {
        var m = prompt("Annulation de " + d.no + " : motif (ex. chèque à remplacer) ?"); if (m === null) return;
        if (!m.trim()) { alert("⛔ Motif obligatoire."); return; }
        envoyerFin("proposerAnnul", { no: d.no, version: d.version, commentaire: m.trim() }, "Annulation demandée " + d.no, d.no);
      };
    }
    // ⚠️ Doublon possible déjà exécuté (ex. même remise saisie deux fois) : affiché seulement dans ce cas.
    var DX = finDoublonsExec(d);
    if (DX.length) {
      A.insertAdjacentHTML("beforeend", "<div class='carte' style='border-left:4px solid #ef6c00'><h3>⚠️ Doublon possible avec " + esc(DX.map(function (z) { return z.no; }).join(", ")) + "</h3>" +
        "<div class='info'>" + DX.map(function (z) { return esc(z.no) + " exécutée le " + dateCourte(z.execute || z.date) + " par " + esc(z.demandeur); }).join("<br>") + "<br>Même opération, mêmes comptes, même montant, objet semblable.</div>" +
        "<div class='ligne'>" + DX.map(function (z) { return "<button class='bouton second fnDxV' data-no='" + esc(z.no) + "'>👁️ Voir " + esc(z.no) + "</button>"; }).join("") + "</div>" +
        "<div class='ligne'><button class='bouton second' id='fnDxOk'>✅ Pas un doublon</button>" + (role === "DG" ? "<button class='bouton' id='fnAnX'>🚫 Annuler cette exécution</button>" : "") + "</div>" +
        "<div class='info'>" + (role === "DG" ? "Annuler : la demande passe « Annulée » et son écriture est retirée automatiquement de Base." : "Seul le DG peut annuler une exécution.") + "</div></div>");
      document.querySelectorAll(".fnDxV").forEach(function (b) { b.onclick = function () { ouvrirDemandeFin(b.getAttribute("data-no")); }; });
      $("fnDxOk").onclick = function () {
        if (!confirm(d.no + " n'est pas un doublon de " + DX.map(function (z) { return z.no; }).join(", ") + " ? L'alerte disparaîtra.")) return;
        envoyerFin("decideDoublon", { no: d.no, confirmer: true, avec: DX.map(function (z) { return z.no; }), commentaire: "" }, "Doublon écarté " + d.no, d.no);
      };
      if ($("fnAnX")) $("fnAnX").onclick = function () {
        var m = prompt("Annuler l'exécution de " + d.no + " (" + gnf(d.montant) + " " + d.devise + ") et retirer son écriture de Base : motif ?", "doublon de " + DX.map(function (z) { return z.no; }).join(", ")); if (m === null) return;
        if (!m.trim()) { alert("⛔ Motif obligatoire."); return; }
        envoyerFin("annulerExec", { no: d.no, commentaire: m.trim() }, "Annulation exécution " + d.no, d.no);
      };
    }
    // ⚠️ Doublon possible détecté à l'exécution : Walid ou le DG confirment ou bloquent ; tout le monde voit l'état.
    var DB = d.doublon;
    if (DB) {
      var hD = "<div class='carte' style='border-left:4px solid " + (DB.etat === "attente" ? "#ef6c00" : DB.etat === "confirmé" ? "#2e7d32" : "#c62828") + "'><h3>⚠️ Doublon possible avec " + esc((DB.avec || []).join(", ")) + "</h3>" +
        "<div class='info'>" + (DB.apres ? "Signalé après exécution" : "Détecté à l'exécution par " + esc(DB.par)) + " · " + dateCourte(DB.q) + "<br>" +
        (DB.etat === "attente" ? "⏸️ Exécution suspendue : Walid ou le DG doit décider." : (DB.etat === "confirmé" ? "✅ Pas un doublon" : "🚫 Bloquée") + " — " + esc((DB.rep || {}).par || "") + (DB.rep && DB.rep.c ? " : " + esc(DB.rep.c) : "")) + "</div>";
      if (DB.etat === "attente" && (role === "DG" || role === "Walid"))
        hD += "<div class='ligne'>" + (DB.avec || []).map(function (n) { return "<button class='bouton second fnDbV' data-no='" + esc(n) + "'>👁️ Voir " + esc(n) + "</button>"; }).join("") + "</div>" +
          "<div class='ligne'><button class='bouton' id='fnDbOk'>✅ Pas un doublon (exécuter)</button><button class='bouton second' id='fnDbNo'>🚫 Bloquer (doublon)</button></div>";
      A.insertAdjacentHTML("beforeend", hD + "</div>");
      document.querySelectorAll(".fnDbV").forEach(function (b) { b.onclick = function () { ouvrirDemandeFin(b.getAttribute("data-no")); }; });
      if ($("fnDbOk")) $("fnDbOk").onclick = function () {
        if (!confirm("Confirmer que " + d.no + " n'est PAS un doublon de " + DB.avec.join(", ") + " ? Elle pourra être exécutée.")) return;
        envoyerFin("decideDoublon", { no: d.no, confirmer: true, commentaire: "" }, "Doublon écarté " + d.no, d.no);
      };
      if ($("fnDbNo")) $("fnDbNo").onclick = function () {
        var m = prompt("Bloquer " + d.no + " (doublon de " + DB.avec.join(", ") + ") : elle passera « Annulée ». Commentaire ?", "doublon de " + DB.avec.join(", ")); if (m === null) return;
        envoyerFin("decideDoublon", { no: d.no, confirmer: false, commentaire: m.trim() }, "Doublon bloqué " + d.no, d.no);
      };
    }
    // Proposition de Walid : le DG accepte ou refuse ; tout le monde voit l'état.
    var PR = d.proposition;
    if (PR) {
      var LIBC = { montant: "Montant", taux: "Taux", mode: "Mode", compte: "Compte", contrepartie: "Vers", beneficiaire: "Bénéficiaire", categorie: "Catégorie", objet: "Objet", refFacture: "Réf. facture", echeance: "Échéance", dateEffet: "Date d'effet" };
      function vx(k, x) { return x === undefined || x === "" ? "—" : k === "montant" ? gnf(x) + " " + d.devise : k === "echeance" || k === "dateEffet" ? (x ? jourFr(x) : "—") : String(x); }
      var enAtt = !PR.etat, rows = PR.type === "modif" ? Object.keys(PR.modif || {}).map(function (k) { return "<tr><td>" + esc(LIBC[k] || k) + "</td><td style='color:#c62828;text-decoration:line-through'>" + esc(vx(k, (PR.avant || {})[k])) + "</td><td style='color:#2e7d32;font-weight:700'>" + esc(vx(k, PR.modif[k])) + "</td></tr>"; }).join("") : "";
      var h = "<div class='carte'><h3>" + (PR.type === "modif" ? "✏️ Modification proposée" : "🗑️ Annulation demandée") + " par " + esc(PR.par) + " · " + dateCourte(PR.q) + "</h3>" +
        "<div class='info'>Motif : " + esc(PR.motif) + "</div>" + (rows ? "<table class='tab' style='width:100%;margin:6px 0'><tr><th></th><th>Avant</th><th>Proposé</th></tr>" + rows + "</table>" : "") +
        (enAtt ? (role === "DG" ? "<label>Commentaire (obligatoire si refus)</label><input id='fnPrC'><div class='ligne'><button class='bouton' id='fnPrOk'>✅ Accepter</button><button class='bouton second' id='fnPrNo'>⛔ Refuser</button></div>"
                                : "<div class='info'>⏳ En attente de la réponse du DG — exécution suspendue.</div>")
               : "<div class='info'>" + (PR.etat === "acceptée" ? "✅" : "⛔") + " " + esc(PR.etat) + " par " + esc((PR.rep || {}).par || "DG") + ((PR.rep || {}).c ? " — " + esc(PR.rep.c) : "") + "</div>") +
        (PR.type === "annul" && PR.etat === "acceptée" && d.statut === "Annulée" && (role === "Walid" || role === "DG") ? "<button class='bouton' id='fnRefaire'>🔁 Refaire la demande (nouvelle pièce)</button>" : "") + "</div>";
      A.insertAdjacentHTML(enAtt ? "afterbegin" : "beforeend", h);
      if ($("fnPrOk")) {
        $("fnPrOk").onclick = function () { if (confirm("Accepter " + (PR.type === "modif" ? "la modification" : "l'annulation") + " de " + d.no + " ?")) envoyerFin("repondreProposition", { no: d.no, version: d.version, accepter: true, commentaire: $("fnPrC").value.trim() }, "Proposition acceptée " + d.no, d.no); };
        $("fnPrNo").onclick = function () { var c = $("fnPrC").value.trim(); if (!c) { alert("⛔ Indiquez le motif du refus."); return; } envoyerFin("repondreProposition", { no: d.no, version: d.version, accepter: false, commentaire: c }, "Proposition refusée " + d.no, d.no); };
      }
      if ($("fnRefaire")) $("fnRefaire").onclick = function () {
        var c = JSON.parse(JSON.stringify(d)); ["no", "version", "pieces", "preuves", "statut", "historique", "walid", "dg", "proposition", "execute", "ligneBase", "validations", "solde"].forEach(function (k) { delete c[k]; });
        c.objet = d.objet ? d.objet + " (remplace " + d.no + ")" : "Remplace " + d.no; formulaireFin(c);
      };
    }
  }
  /* Formulaire de modification par la direction (champs principaux ; trace dans l'historique, demandeur notifié). */
  function formulaireDirection(d, proposition) {
    var F = S.fin;
    $("titre").textContent = (proposition ? "Proposer une modification · " : "Modifier ") + d.no;
    function opts(L, v, vide) { return (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { return "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; }).join(""); }
    var cpts = F.comptes.map(function (c) { return c.nom; }), modes = d.type === "Règlement fournisseur" ? ["Espèces", "Chèque", "Virement"] : d.type === "Paiement RH" ? ["Espèces", "Virement"] : [];
    var fact = d.type === "Facture d'achat";
    $("vueListe").innerHTML = "<div class='carte'><h3>✏️ " + esc(d.no) + " · " + esc(libelleFin(d)) + "</h3><div class='info'>" + esc(statutFin(d)) + " · demandeur " + esc(d.demandeur) + "</div>" +
      "<div class='ligne'><div style='flex:2'><label>Montant</label><input id='dmMt' inputmode='decimal' value='" + esc(d.montant) + "'></div><div><label>Devise</label><input value='" + esc(d.devise) + "' disabled></div></div>" +
      (d.devise !== "GNF" ? "<label>Taux (1 unité = … GNF)</label><input id='dmTx' inputmode='decimal' value='" + esc(d.taux || "") + "'>" : "") +
      (modes.length ? "<label>Mode</label><select id='dmMo'>" + opts(modes, d.mode) + "</select>" : "") +
      (!fact ? "<label>Compte</label><select id='dmCp'>" + opts(cpts, d.compte, "— choisir —") + "</select>" : "") +
      (d.type === "Mouvement de trésorerie" ? "<label>Vers</label><select id='dmCt'>" + opts(cpts, d.contrepartie, "— (bénéficiaire externe) —") + "</select>" : "") +
      (!fact ? "<label>Bénéficiaire (chèque / virement)</label><input id='dmBe' value='" + esc(d.beneficiaire || "") + "'>" : "") +
      "<label>Catégorie</label><select id='dmCa'>" + opts(F.categories || [], d.categorie, "—") + "</select>" +
      "<label>Objet</label><input id='dmOb' value='" + esc(d.objet || "") + "'>" +
      (d.type === "Paiement RH" && d.motifRH === "SALAIRE (RH)" ? "" : "<label>Date d'effet <small>(vide = date d'exécution)</small></label><input id='dmEf' type='date' value='" + (d.dateEffet ? isoJour(d.dateEffet) : "") + "'>") +
      (fact ? "<label>Réf. facture</label><input id='dmRf' value='" + esc(d.refFacture || "") + "'><label>Échéance</label><input id='dmEc' type='date' value='" + (d.echeance ? new Date(d.echeance).toISOString().slice(0, 10) : "") + "'>" : "") +
      "<label>Motif de la modification" + (proposition ? " (obligatoire)" : "") + "</label><input id='dmCo'>" +
      (proposition ? "<div class='info'>📎 La pièce jointe reste celle de la demande. Le DG verra l'avant / après et acceptera ou refusera ; l'exécution est suspendue en attendant.</div>" : "") +
      "<button class='bouton' id='dmEnv'>" + (proposition ? "📤 Envoyer la proposition au DG" : "💾 Enregistrer la modification") + "</button><div class='info' id='dmMsg'></div></div>";
    montrer("vueListe");
    $("dmEnv").onclick = function () {
      function v(id) { return $(id) ? $(id).value : undefined; }
      var n = function (x) { return x === undefined ? undefined : parseFloat(String(x).replace(/[\s  ]/g, "").replace(",", ".")) || 0; };
      var m = { montant: n(v("dmMt")), taux: n(v("dmTx")), mode: v("dmMo"), compte: v("dmCp"), contrepartie: v("dmCt"), beneficiaire: v("dmBe"), categorie: v("dmCa"), objet: v("dmOb"), refFacture: v("dmRf"), echeance: v("dmEc"), dateEffet: v("dmEf") };
      Object.keys(m).forEach(function (k) { if (m[k] === undefined) delete m[k]; });
      if (!(m.montant > 0)) { $("dmMsg").textContent = "⛔ Montant."; return; }
      if (proposition) {
        if (!String(v("dmCo") || "").trim()) { $("dmMsg").textContent = "⛔ Motif obligatoire."; return; }
        if (!confirm("Envoyer au DG la proposition de modification de " + d.no + " ?")) return;
        envoyerFin("proposerModif", { no: d.no, version: d.version, modif: m, commentaire: v("dmCo") }, "Modification proposée " + d.no, d.no); return;
      }
      if (!confirm("Enregistrer la modification de " + d.no + " ?")) return;
      envoyerFin("modifierDirection", { no: d.no, version: d.version, modif: m, commentaire: v("dmCo") }, "Modification " + d.no, d.no);
    };
  }
  function envoyerFin(op, donnees, titre, retour) {
    var it = { type: "fin", op: op, jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: donnees, titre: titre, resume: "Finances", essais: 0 };
    soumettre(it).then(function (r) {
      if (r.ok && !r.enAttente && op === "creer" && AUD.creation) audEcritureCreee(donnees && donnees.demande);
      if (r.ok && !r.enAttente && r.maj && r.maj.length && S.fin) {   // ⚡ demande à jour reçue : affichage immédiat
        r.maj.forEach(function (z) { var i = -1; S.fin.demandes.forEach(function (x, k) { if (x.no === z.no) i = k; }); if (i >= 0) S.fin.demandes[i] = z; else S.fin.demandes.unshift(z); });
        ecrire("fin", S.fin); majCloche();
        alert("✅ " + r.titre + (r.message ? "\n" + r.message : ""));
        if (r.no || retour) ouvrirDemandeFin(r.no || retour); else afficherFinances();
        rafraichirFin().catch(function () {});   // complet en arrière-plan (factures, soldes…)
        return;
      }
      if (!r.ok && r.doublonExec) {   // exécution suspendue : Walid / DG décident sur la fiche
        alert(r.titre + "\n\n" + r.message);
        return rafraichirFin().catch(function () {}).then(function () { if (retour) ouvrirDemandeFin(retour); else afficherFinances(); });
      }
      if (!r.ok && r.doublon) {   // même opération déjà saisie : l'opérateur confirme ou abandonne
        if (confirm(r.titre + "\n\n" + r.message + "\n\nVérifiez avant d'envoyer.\nOK = envoyer quand même · Annuler = ne pas envoyer")) {
          donnees.forcerDoublon = true; if (donnees.demande) donnees.demande.forcerDoublon = true;
          envoyerFin(op, donnees, titre, retour);
        } else afficherFinances();
        return;
      }
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
  // Impôts imputables sur la réserve fiscale (code du repère [IMP:code|année]) ; AUTRE = charge courante (non imputée).
  var IMP_TYPES = [["IMF", "IMF (impôt minimum forfaitaire)"], ["IS1", "IS — 1er acompte"], ["IS2", "IS — 2e acompte"], ["ISS", "IS — solde"], ["AUTRE", "Autre impôt / taxe (charge courante, non imputée)"]];
  // Catégories proposées : « Prélèvement DG » est automatique (virement vers un compte personnel) ; « Dépenses personnelles DG » réservée au DG.
  function catsFin(F) { return (F.categories || []).filter(function (c) { return c !== "Prélèvement DG" && (c !== "Dépenses personnelles DG" || F.role === "DG"); }); }
  function formulaireFin(src) {
    var F = S.fin; src = src || {};
    var A0 = src.achat || {}, AC = F.achat || { categories: [], articles: {}, ouverts: [], typesFrais: [] };
    $("titre").textContent = src.no ? "Corriger " + src.no : "Nouvelle demande";
    function opts(L, v, vide) { return (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { return "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; }).join(""); }
    var types = F.types.filter(function (t) { return (t !== "Opération constatée" || F.role || F.comptable) && t !== "Facture d'achat"; });
    types.unshift("Achat fournisseur");   // Achat : avec / sans facture, payé maintenant / plus tard, stock / charge
    if (src.limiter) types = ["Achat fournisseur", "Règlement fournisseur"];   // depuis 🏭 Fournisseurs
    else if (!src.no && !src.type) types = types.filter(function (t) { return t !== "Achat fournisseur" && t !== "Règlement fournisseur"; });   // Finances › Nouvelle demande : achats et règlements par 🏭 Fournisseurs
    var CATS_STOCK = ["Fourniture Locale", "Fourniture Importee"];
    var IMP0 = (function () { var m = String(src.objet || "").match(/\s*\[IMP:([A-Z0-9]+)\|(\d{4})\]/); if (m) src.objet = String(src.objet).replace(m[0], ""); return { code: m ? m[1] : "", annee: m ? m[2] : String(new Date().getFullYear() - 1) }; })();
    var srcAchat = src.type === "Achat fournisseur" || src.type === "Facture d'achat" || (src.type === "Règlement fournisseur" && src.op === "Achat comptant");
    var A1 = { piece: srcAchat && (src.op === "Sans facture" || (src.type === "Règlement fournisseur" && !src.refFacture)) ? "Sans facture (reçu ou rien)" : "Avec facture",
               pay: src.type === "Facture d'achat" ? "À payer plus tard" : "Payé maintenant",
               dest: src.categorie && CATS_STOCK.indexOf(src.categorie) < 0 ? "💸 Charge ou prestation (passe directement)" : src.categorie === "Fourniture Importee" ? "📦 Stock · fourniture importée (Suivi Achats)" : "📦 Stock · fourniture locale (Suivi Achats)" };
    var REG = {}; if (src.facture) REG[src.facture] = { on: true, mt: src.montant };   // règlement : factures cochées
    var fourActifs = F.fournisseurs.filter(function (f) { return f.actif !== false; }), raisonsF = [];
    fourActifs.forEach(function (f) { if (raisonsF.indexOf(fourRaison(f)) < 0) raisonsF.push(fourRaison(f)); }); raisonsF.sort();
    var fourSrc = src.fournisseur ? F.fournisseurs.filter(function (f) { return f.nom.toLowerCase() === String(src.fournisseur).toLowerCase(); })[0] : null;
    function comptesDe(r) { return F.fournisseurs.filter(function (f) { return fourRaison(f).toLowerCase() === String(r).trim().toLowerCase() && ((f.actif !== false && !f.projetAcheve) || (fourSrc && f.nom === fourSrc.nom)); })
      .sort(function (a, b) { return (a.societe || a.projet ? 1 : 0) - (b.societe || b.projet ? 1 : 0) || a.nom.localeCompare(b.nom); }); }
    function estAchat() { return v("ffType") === "Achat fournisseur"; }
    // Achat : le compte du fournisseur découle de la société bénéficiaire + projet (créé s'il n'existe pas encore).
    function compteAchat(soc) {
      var r = v("ffFour").trim(), C = comptesDe(r), so = soc || v("ffSoc"), pr = v("ffProj").replace(/\s+/g, " ").trim();
      if (!r) return "";
      var ex = C.filter(function (c) { return (c.societe || "") === so && (c.projet || "").toLowerCase() === pr.toLowerCase(); })[0];
      return ex ? ex.nom : [C.length ? fourRaison(C[0]) : r, so, pr].filter(String).join(" — ");
    }
    var payManuel = !!(src.type === "Règlement fournisseur" && src.op === "Achat comptant");
    function payeurAchat(t) { return t === "Règlement fournisseur" ? v("ffPayS") || v("ffSoc") : v("ffSoc"); }
    function estRegl() { return v("ffType") === "Règlement fournisseur"; }
    function estAvance() { return estRegl() && v("ffRegM") === "Avance (sans facture)"; }
    function facturesDe(r) { var noms = F.fournisseurs.filter(function (f) { return fourRaison(f).toLowerCase() === String(r).trim().toLowerCase(); }).map(function (c) { return c.nom.toLowerCase(); });   /* toutes ses factures (même projet achevé) */ return F.factures.filter(function (f) { return noms.indexOf(f.fournisseur.toLowerCase()) >= 0 || (src.facture && f.no === src.facture); }); }
    function regCoches() { return Object.keys(REG).filter(function (k) { return REG[k].on; }).map(function (k) { return F.factures.filter(function (f) { return f.no === k; })[0]; }).filter(Boolean); }
    function compteChoisi() {
      if (estAchat()) return compteAchat();
      if (estAvance()) return compteAchat(v("ffAvS"));
      if (estRegl()) { var fc0 = regCoches()[0]; return fc0 ? fc0.fournisseur : (comptesDe(v("ffFour"))[0] || {}).nom || v("ffFour").trim(); }
      var C = comptesDe(v("ffFour")); return C.length ? v("ffFourC") : v("ffFour").trim(); }
    function dessinerFactures() {
      var r = v("ffFour").trim(), Fa = facturesDe(r), PR = [];
      Fa.forEach(function (f) { var c = F.fournisseurs.filter(function (x) { return x.nom === f.fournisseur; })[0] || {}; f._soc = c.societe || ""; f._pr = c.projet || ""; f._lib = fourLibCompte(c.nom ? c : { societe: f.societe }); if (f._pr && PR.indexOf(f._pr) < 0) PR.push(f._pr); });
      var key = r + "|" + Fa.map(function (f) { return f.no; }).join(",");
      if ($("ffRegP").getAttribute("data-k") !== key) { var p0 = $("ffRegP").value; $("ffRegP").innerHTML = "<option value=''>Tous projets</option>" + PR.sort().map(function (x) { return "<option" + (x === p0 ? " selected" : "") + ">" + esc(x) + "</option>"; }).join(""); $("ffRegP").setAttribute("data-k", key); }
      var fs = v("ffRegS"), fp = v("ffRegP"), L = Fa.filter(function (f) { return (!fs || f._soc === fs) && (!fp || f._pr === fp); });
      var cleL = key + "|" + fs + "|" + fp;
      if ($("ffRegL").getAttribute("data-k") !== cleL) {
        $("ffRegL").innerHTML = L.map(function (f) {
          var dispo = f.reste - f.engage + (src.facture === f.no ? +src.montant || 0 : 0), st = REG[f.no] || {};
          return "<div class='ligne' style='align-items:center;border-bottom:1px solid var(--bord);padding:6px 0'><label style='flex:3;font-weight:400;margin:0'><input type='checkbox' class='ffRc' data-no='" + esc(f.no) + "' style='width:auto'" + (st.on ? " checked" : "") + "> <b>" + esc(f.ref || f.no) + "</b> · " + esc(f._lib) +
            "<div class='info'>" + esc(f.no) + " · total " + gnf(f.total) + " · reste " + gnf(dispo) + " GNF" + (f.categorie ? " · " + esc(f.categorie) : "") + "</div></label>" +
            "<input class='ffRm' data-no='" + esc(f.no) + "' data-d='" + dispo + "' inputmode='decimal' style='flex:1;min-width:90px' placeholder='montant' value='" + esc(st.mt !== undefined ? st.mt : "") + "'></div>";
        }).join("") || "<div class='info'>" + (r ? "Aucune facture à régler pour ce fournisseur (choisissez « Avance »)." : "Choisissez d'abord le fournisseur.") + "</div>";
        $("ffRegL").setAttribute("data-k", cleL);
        Array.prototype.forEach.call($("ffRegL").querySelectorAll(".ffRc"), function (c) { c.onchange = function () {
          var no = c.getAttribute("data-no"), inp = $("ffRegL").querySelector(".ffRm[data-no='" + no + "']");
          REG[no] = REG[no] || {}; REG[no].on = c.checked;
          if (c.checked && !inp.value && v("ffDev") === "GNF") { inp.value = inp.getAttribute("data-d"); REG[no].mt = inp.value; }
          maj(); }; });
        Array.prototype.forEach.call($("ffRegL").querySelectorAll(".ffRm"), function (inp) { inp.oninput = function () {
          var no = inp.getAttribute("data-no"); REG[no] = REG[no] || {}; REG[no].mt = inp.value; if (nb(inp.value) > 0) { REG[no].on = true; $("ffRegL").querySelector(".ffRc[data-no='" + no + "']").checked = true; } maj(); }; });
      }
      var C2 = regCoches(), tot = C2.reduce(function (a, f) { return a + nb((REG[f.no] || {}).mt); }, 0);
      $("ffRegT").innerHTML = C2.length ? "<b>" + C2.length + " facture(s) · total " + gnf(tot) + " " + esc(v("ffDev")) + "</b>" : "Cochez une ou plusieurs factures.";
      $("ffMt").value = tot ? String(tot) : "";
      return C2;
    }
    var h = "<div class='carte'><label>Type</label><select id='ffType'>" + opts(types, srcAchat ? "Achat fournisseur" : src.type || types[0]) + "</select>" +
      // Devise de l'opération : choisie dès le départ ; hors GNF, taux de change obligatoire (valorisation en GNF).
      "<div class='ligne'><div><label>Devise de l'opération</label><select id='ffDev'>" + opts(["GNF", "USD", "EURO", "TND"], src.devise || "GNF") + "</select></div>" +
      "<div id='ffTauxB' style='flex:2'><label id='ffTauxL'>Taux de change (1 unité = … GNF)</label><input id='ffTaux' inputmode='decimal' placeholder='obligatoire' value='" + esc(src.taux && src.devise !== "GNF" ? src.taux : "") + "'></div></div>" +
      "<div id='ffAchatB'><div class='ligne'><div><label>Pièce</label><select id='ffPiece'>" + opts(["Avec facture", "Sans facture (reçu ou rien)"], A1.piece) + "</select></div>" +
      "<div><label>Paiement</label><select id='ffPay'>" + opts(["Payé maintenant", "À payer plus tard"], A1.pay) + "</select></div></div>" +
      "<label>Destination</label><select id='ffDest'>" + opts(["📦 Stock · fourniture locale (Suivi Achats)", "📦 Stock · fourniture importée (Suivi Achats)", "💸 Charge ou prestation (passe directement)"], A1.dest) + "</select></div>" +
      "<div id='ffOpB'><label>Mouvement</label><select id='ffOp'>" + opts(F.opsBanque, src.type === "Mouvement de trésorerie" ? (src.op === "Dépôt de chèque" || (src.op === "Virement" && src.mode === "Chèque") ? "Remise chèque" : src.op) : "", "— choisir —") + "</select></div>" +
      "<div id='ffOcB'><label>Opération constatée (sans validation)</label><select id='ffOc'>" + opts(F.opsConstatees || [], src.type === "Opération constatée" ? src.op : "", "— choisir —") + "</select></div>" +
      "<div class='ligne'><div><label id='ffSocL'>Société (payeuse)</label><select id='ffSoc'>" + opts(["AB", "M2S", "CASAFINO"].concat(src.societe === "DG" ? ["DG"] : []), (srcAchat && (src.pourCompte || (fourSrc && fourSrc.societe))) || src.societe || "AB") + "</select></div>" +
      "<div id='ffPaySB'><label>Société payeuse</label><select id='ffPayS'>" + opts(["AB", "M2S", "CASAFINO", "DG"], src.type === "Règlement fournisseur" && src.op === "Achat comptant" ? src.societe : "") + "</select><div class='info'>Caisse / compte proposés : ceux de la société payeuse. Différente de la bénéficiaire → 🔁 Inter-sociétés.</div></div>" +
      "<div id='ffProjB'><label>Projet / affectation (facultatif)</label><input id='ffProj' list='ffProjL' value='" + esc(fourSrc && fourSrc.projet ? fourSrc.projet : "") + "' placeholder='ex. Dépôt Nongo, Entretien et réparation Imprimerie'><datalist id='ffProjL'>" +
        (F.projets || []).map(function (x) { return "<option value='" + esc(x) + "'>"; }).join("") + "</datalist></div>" +
      "<div id='ffPcB'><label>Pour le compte de</label><select id='ffPc'><option value=''>— elle-même —</option>" + (F.pourCompte || ["CASAFINO"]).map(function (x) { return "<option" + (x === src.pourCompte ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select></div></div>" +
      "<div id='ffRhB'><div class='ligne'><div><label>Personnel</label><select id='ffPers'>" + opts(F.personnel || [], src.personnel, "— choisir —") + "</select></div>" +
      "<div><label>Motif</label><select id='ffMotRH'>" + opts(F.motifsRH || [], src.motifRH, "— choisir —") + "</select></div></div>" +
      "<div id='ffMoisB'><label>Mois du salaire</label><input id='ffMois' type='month' value='" + (src.dateEffet ? new Date(src.dateEffet).toISOString().slice(0, 7) : "") + "'></div><div id='apPers'></div></div>" +
      "<div id='ffFourB'><label>Fournisseur</label><input id='ffFour' list='ffFourL' value='" + esc(fourSrc ? fourRaison(fourSrc) : src.fournisseur || "") + "' placeholder='Nom (nouveau : créé avec un compte général)'>" +
      "<datalist id='ffFourL'>" + raisonsF.map(function (r) { return "<option value='" + esc(r) + "'>"; }).join("") + "</datalist>" +
      "<div id='ffFourCB'><label>Compte du fournisseur</label><select id='ffFourC'></select></div><div id='ffFourI' class='info'></div><div id='apFour'></div>" +
      "<div id='ffNouvF' style='display:none'><div class='ligne'><div><label>Téléphone</label><input id='ffTel'></div><div><label>NIF</label><input id='ffNif'></div></div><label>RIB / compte</label><input id='ffRib'></div></div>" +
      "<div id='ffFactB'><label>Facture à régler</label><select id='ffFact'></select><div id='ffFactI' class='info'></div></div>" +
      "<div id='ffRefB'><div id='ffRefOB'><label>Réf. de la facture</label><input id='ffRef' value='" + esc(src.refFacture && src.refFacture !== "Sans facture" ? src.refFacture : "") + "'></div><div id='ffEchB'><label>Échéance (à payer avant le)</label><input id='ffEch' type='date' value='" + (src.echeance ? new Date(src.echeance).toISOString().slice(0, 10) : "") + "'></div></div>" +
      "<div id='ffRegB'><label>Règlement</label><select id='ffRegM'>" + opts(["Factures à régler", "Avance (sans facture)"], src.no && !src.facture ? "Avance (sans facture)" : "Factures à régler") + "</select>" +
        "<div id='ffRegFB'><div class='ligne'><select id='ffRegS'><option value=''>Toutes sociétés bénéficiaires</option><option>AB</option><option>M2S</option><option>CASAFINO</option></select><select id='ffRegP'><option value=''>Tous projets</option></select></div>" +
        "<div id='ffRegL'></div><div id='ffRegT' class='info'></div></div>" +
        "<div id='ffAvB'><label>Société bénéficiaire de l'avance</label><select id='ffAvS'>" + opts(["AB", "M2S", "CASAFINO"], (fourSrc && fourSrc.societe) || "AB") + "</select></div></div>" +
      "<div id='ffObjB'><label>Objet</label><input id='ffObj' value='" + esc(src.objet || "") + "'></div>" +
      "<div id='ffModeB'><label>Mode de paiement</label><select id='ffMode'></select></div>" +
      "<div class='ligne' id='ffCptB'><div><label id='ffCptL'>Compte</label><select id='ffCpt'></select></div><div id='ffCtpB'><label id='ffCtpL'>Vers</label><select id='ffCtp'></select></div></div><div class='info' id='ffIcI' style='display:none'></div><div id='apCpt'></div><div id='apCtp'></div>" +
      "<label id='ffMtL'>Montant</label><input id='ffMt' inputmode='decimal' value='" + esc(src.montant || "") + "'>" +
      "<div id='ffGnf' class='info'></div>" +
      "<div id='ffChqI' class='info'>Chèque client (recouvrement) : à déclarer en COMMERCIAL › Recouvrement, pas ici.</div>" +
      "<div id='ffRecuB'><label id='ffRecuL'>Montant reçu</label><input id='ffRecu' inputmode='decimal' value='" + esc(src.recu || "") + "'></div>" +
      "<div id='ffEqB'><label id='ffEqL'>Équivalent</label><input id='ffEq' inputmode='decimal' value='" + esc(src.type === "Paiement RH" && src.recu ? src.recu : "") + "'></div>" +
      "<div id='ffCatB'><label>Catégorie (trésorerie)</label><select id='ffCat'>" + opts(catsFin(F), src.categorie, "— choisir —") + "</select></div>" +
      // 🧾 Impôts : imputés sur la réserve fiscale de l'année concernée (repère [IMP:code|année] dans l'objet)
      "<div id='ffImpB' class='ligne'><div><label>Impôt</label><select id='ffImp'>" + opts(IMP_TYPES.map(function (x) { return x[1]; }), (IMP_TYPES.filter(function (x) { return x[0] === IMP0.code; })[0] || [])[1] || "", "— choisir —") + "</select></div>" +
      "<div><label>Année concernée</label><input id='ffImpA' inputmode='numeric' value='" + esc(IMP0.annee) + "'></div></div>" +
      "<div id='ffImpCB'><label style='font-weight:400'><input type='checkbox' id='ffImpC' style='width:auto'" + (IMP0.code === "COM" ? " checked" : "") + "> 🧾 Liée aux impôts (imputée sur la réserve fiscale de l'année <input id='ffImpCA' inputmode='numeric' style='width:70px;display:inline-block;padding:4px' value='" + esc(IMP0.annee) + "'>)</label></div>" +
      // Achat d'article (Fourniture Locale / Importée) → Suivi Achats
      "<div id='ffAchB' class='carte' style='margin-top:10px'><h3>📦 Achat (Suivi Achats)</h3>" +
      "<label>Nature</label><select id='ffAN'>" + opts(["Article existant", "Nouvel article", "Frais"], A0.nature, "— choisir —") + "</select>" +
      "<div id='ffAMagB'><label>🏬 Magasin de destination</label><select id='ffAMag'></select></div>" +
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
      "<div id='ffAFact' class='info'></div><div id='ffAGnf' class='info'></div></div>" +
      "<div id='ffBenB'><label>Bénéficiaire du chèque / virement</label><input id='ffBen' value='" + esc(src.beneficiaire || "") + "'></div>" +
      champFichiers("ffP") + (src.pieces && src.pieces.length ? "<div class='info'>Déjà jointes : " + src.pieces.length + " pièce(s).</div>" : "") +
      (F.role === "DG" && !src.no ? "<div id='ffXB' class='carte' style='margin-top:10px'><h3>💳 Exécution directe (DG)</h3><div class='info'>Votre saisie est validée d'office. Joignez la preuve du paiement : elle est exécutée tout de suite (inscrite dans BASE). Sans preuve, elle reste « À exécuter ».</div>" +
        champFichiers("ffX").replace("Photos / PDF", "Preuve du paiement") + "</div>" : "") +
      "<div id='ffRegle' class='carte' style='margin-top:10px'></div>" +
      "<div id='ffEffB'><label>Date d'effet <small>(facultative : vide = date d'exécution)</small></label><input id='ffEff' type='date' value='" + (src.dateEffet && !(src.type === "Paiement RH" && src.motifRH === "SALAIRE (RH)") ? isoJour(src.dateEffet) : "") + "'></div>" +
      "<label>Commentaire</label><input id='ffCom'>" +
      "<button class='bouton' id='ffEnv'>📤 Envoyer</button><div id='ffMsg' class='info' style='white-space:pre-line'></div></div>";
    $("vueListe").innerHTML = h; montrer("vueListe"); lierFichiers("ffP"); if ($("ffXB")) lierFichiers("ffX");
    function v(id) { return $(id).value.trim(); }
    function nb(x) { x = String(x || "").replace(/[\s  ]/g, "").replace(",", "."); return parseFloat(x) || 0; }
    function vis(id, ok) { $(id).style.display = ok ? "" : "none"; }
    function on(id) { return $(id).style.display !== "none"; }
    var modePrec = src.mode;
    function maj() {
      var tU = v("ffType"), achat = tU === "Achat fournisseur", avecF = v("ffPiece") === "Avec facture", stock = /^📦/.test(v("ffDest"));
      var t = achat ? (v("ffPay") === "À payer plus tard" ? "Facture d'achat" : "Règlement fournisseur") : tU;
      var op = t === "Mouvement de trésorerie" ? v("ffOp") : t === "Opération constatée" ? v("ffOc") : "", dev = v("ffDev");
      vis("ffAchatB", achat); vis("ffProjB", achat);
      $("ffSocL").textContent = achat ? "Société bénéficiaire" : "Société (payeuse)";
      var socsV = ["AB", "M2S", "CASAFINO"].concat(achat ? [] : ["DG"]);
      vis("ffPaySB", achat && t === "Règlement fournisseur");
      if (achat && !payManuel && $("ffPayS").value !== v("ffSoc")) $("ffPayS").value = v("ffSoc");   // par défaut : la bénéficiaire
      if (socsV.join("|") !== $("ffSoc").getAttribute("data-l")) { var so0 = $("ffSoc").value; $("ffSoc").innerHTML = opts(socsV, socsV.indexOf(so0) >= 0 ? so0 : "AB"); $("ffSoc").setAttribute("data-l", socsV.join("|")); }
      // Catégories : Stock → fournitures (Suivi Achats) ; Charge → les autres.
      var catsL = catsFin(F).filter(function (c) { return !achat || (stock ? CATS_STOCK.indexOf(c) >= 0 : CATS_STOCK.indexOf(c) < 0); });
      if (catsL.join("|") !== $("ffCat").getAttribute("data-l")) {
        var curCat = $("ffCat").value || src.categorie || "";
        $("ffCat").innerHTML = opts(catsL, catsL.indexOf(curCat) >= 0 ? curCat : catsL.length === 1 ? catsL[0] : "", catsL.length === 1 ? "" : "— choisir —"); $("ffCat").setAttribute("data-l", catsL.join("|"));
      }
      vis("ffOpB", t === "Mouvement de trésorerie"); vis("ffOcB", t === "Opération constatée"); vis("ffRhB", t === "Paiement RH");
      vis("ffFourB", t === "Facture d'achat" || t === "Règlement fournisseur" || t === "Dépense de caisse");
      $("ffFourB").querySelector("label").textContent = t === "Dépense de caisse" ? "Fournisseur / prestataire (facultatif, pour son compte)" : "Fournisseur";
      var regl = t === "Règlement fournisseur" && !achat, avance = regl && v("ffRegM") === "Avance (sans facture)";
      vis("ffRegB", regl); vis("ffRegFB", regl && !avance); vis("ffAvB", avance); vis("ffObjB", !regl && !achat); vis("ffProjB", achat || avance);
      $("ffMt").readOnly = regl && !avance;
      var regC = regl && !avance ? dessinerFactures() : [];
      // Devise : celle des factures réglées (imposée) ; sinon choisie d'abord, et seuls les comptes de cette devise sont proposés.
      if (regC.length) { var devsF = []; regC.forEach(function (f) { var x = f.devise || "GNF"; if (devsF.indexOf(x) < 0) devsF.push(x); });
        $("ffDev").value = devsF[0]; $("ffDev").disabled = true; dev = devsF[0];
        if (devsF.length > 1) $("ffRegT").innerHTML += " · <b style='color:#c62828'>⛔ factures en devises différentes (" + devsF.join(", ") + ") : réglez-les séparément</b>"; }
      else $("ffDev").disabled = false;
      vis("ffFactB", false); vis("ffRefB", achat); vis("ffRefOB", avecF); vis("ffEchB", t === "Facture d'achat");
      // Modes de paiement selon le type.
      var chq = op === "Remise chèque", benExt = t === "Mouvement de trésorerie" && (op === "Virement" || chq) && !$("ffCtp").value;   // virement / chèque remis à un bénéficiaire externe
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
        else if (chq) { srcL = BA; dstL = BA; lS = "Chèque tiré sur"; lD = "Remis sur (ou bénéficiaire)"; }
        else if (op === "Transfert entre caisses") { srcL = CA; dstL = CA; lS = "Depuis la caisse"; lD = "Vers la caisse"; }
        else if (op === F.opRemb) { srcL = F.comptes.filter(function (c) { return ["AB", "M2S", "CASAFINO"].indexOf(c.societe) >= 0; }); dstL = srcL; lS = "Depuis un compte de la société qui rembourse"; lD = "Vers un compte de la société remboursée"; }
      }
      function remplir(id, L, val, vide, lib) { var cur = $(id).value || val || ""; $(id).innerHTML = (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (c) { return "<option value='" + esc(c.nom) + "'" + (c.nom === cur ? " selected" : "") + ">" + esc(lib ? lib(c) : c.nom) + "</option>"; }).join(""); }
      // Seuls les caisses / comptes de la société payeuse (et ceux sans société) sont proposés.
      var payeur = achat ? payeurAchat(t) : v("ffSoc"), deLui = function (c) { return !c.societe || c.societe === payeur; };
      // Retrait / transfert vers la caisse d'une autre société : proposé (après les siennes) → avance en 🔁 Inter-sociétés.
      var versAutre = t === "Mouvement de trésorerie" && (op === "Retrait" || op === "Transfert entre caisses" || op === "Versement");
      srcL = srcL.filter(function (c) { return deLui(c) && (c.devise || "GNF") === dev; });
      if (dstL && versAutre) dstL = dstL.filter(deLui).concat(dstL.filter(function (c) { return !deLui(c) && ["AB", "M2S", "CASAFINO", "DG"].indexOf(c.societe) >= 0; }));
      else if (dstL && op !== F.opRemb) dstL = dstL.filter(deLui);
      if (op === F.opRemb && dstL) dstL = dstL.filter(function (c) { return c.societe && c.societe !== payeur; });
      remplir("ffCpt", srcL, src.compte, "— choisir —"); remplir("ffCtp", dstL || [], src.contrepartie, op === "Virement" || chq ? "— bénéficiaire externe —" : "— choisir —", versAutre ? function (c) { return c.nom + (deLui(c) ? "" : " · " + c.societe + " (avance inter-sociétés)"); } : null);
      $("ffCptL").textContent = lS; $("ffCtpL").textContent = lD;
      apercuCompte("apCpt", on("ffCptB") ? v("ffCpt") : "", lS); apercuCompte("apCtp", on("ffCtpB") ? v("ffCtp") : "", lD);
      apercuLocal("apPers", t === "Paiement RH" && v("ffPers") ? apercuFinListe(function (d) { return d.type === "Paiement RH" && nomRH(d.personnel) === nomRH(v("ffPers")); }) : null, "Derniers paiements de " + v("ffPers"));
      apercuLocal("apFour", on("ffFourB") && v("ffFour").trim() ? apercuFinListe(function (d) { return d.fournisseur && (d.fournisseur.toLowerCase() === v("ffFour").trim().toLowerCase() || (fourRaison({ nom: d.fournisseur }) || "").toLowerCase() === v("ffFour").trim().toLowerCase()); }) : null, "Dernières opérations · " + v("ffFour"));
      benExt = t === "Mouvement de trésorerie" && (op === "Virement" || chq) && !v("ffCtp");
      vis("ffCptB", t !== "Facture d'achat"); vis("ffCtpB", !!dstL);
      var cpt = F.comptes.filter(function (c) { return c.nom === v("ffCpt"); })[0], dst = F.comptes.filter(function (c) { return c.nom === v("ffCtp"); })[0];
      var icAv = versAutre && dst && dst.societe && dst.societe !== payeur;
      vis("ffIcI", !!icAv); if (icAv) $("ffIcI").textContent = "🔁 " + dst.nom + " appartient à " + dst.societe + " : avance de " + payeur + " à " + dst.societe + ", inscrite comme dette de " + dst.societe + " dans Inter-sociétés.";
      // (la devise n'est plus imposée par le compte : la liste des comptes suit la devise choisie)
      var devR = dst && dst.devise && dst.devise !== dev ? dst.devise : "";
      vis("ffChqI", t === "Mouvement de trésorerie" && chq);
      vis("ffRecuB", !!devR); $("ffRecuL").textContent = "Montant reçu sur " + (dst ? dst.nom : "") + " (" + devR + ")";
      // Paie RH : mois du salaire ; équivalent dans la devise du salaire si le compte est dans une autre devise.
      var mot = v("ffMotRH"), devSal = t === "Paiement RH" ? (F.devisesPersonnel || {})[v("ffPers")] || "" : "";
      vis("ffMoisB", t === "Paiement RH" && mot === "SALAIRE (RH)");
      vis("ffEffB", !(t === "Paiement RH" && mot === "SALAIRE (RH)") && t !== "Facture d'achat");
      vis("ffEqB", !!devSal && devSal !== dev && ["SALAIRE (RH)", "AVANCE (RH)", "PRIME SUR SALAIRE (RH)"].indexOf(mot) >= 0);
      $("ffEqL").textContent = "Équivalent en " + devSal + " (devise du salaire de " + v("ffPers") + ")";
      vis("ffBenB", (t === "Règlement fournisseur" && mode && mode !== "Espèces") || benExt);
      vis("ffTauxB", dev !== "GNF");
      var Cf = comptesDe(v("ffFour")), curC = $("ffFourC").value || (fourSrc ? fourSrc.nom : "");
      if (Cf.map(function (c) { return c.nom; }).join("|") !== $("ffFourC").getAttribute("data-l")) {
        $("ffFourC").innerHTML = Cf.map(function (c) { return "<option value='" + esc(c.nom) + "'" + (c.nom === curC ? " selected" : "") + ">" + esc(fourLibCompte(c)) + "</option>"; }).join("");
        $("ffFourC").setAttribute("data-l", Cf.map(function (c) { return c.nom; }).join("|"));
      }
      vis("ffFourCB", on("ffFourB") && Cf.length > 0 && !achat && !regl);
      var four = compteChoisi(), fc = F.fournisseurs.filter(function (f) { return f.nom.toLowerCase() === four.toLowerCase(); })[0], connu = !!fc;
      vis("ffNouvF", on("ffFourB") && four && !connu && !(achat && comptesDe(v("ffFour")).length));
      // Société payeuse : libre (c'est le règlement qui choisit la source). Compte d'une société bénéficiaire payé par une autre → « pour le compte de » imposé (🔁 Inter-sociétés).
      $("ffSoc").disabled = false;
      vis("ffPcB", !achat && !regl && t === "Dépense de caisse");
      if (achat) { var pay0 = payeurAchat(t); $("ffPc").value = pay0 !== v("ffSoc") ? v("ffSoc") : ""; }
      else if (fc && fc.societe && on("ffFourB")) { $("ffPc").value = fc.societe === v("ffSoc") ? "" : fc.societe; $("ffPc").disabled = true; }
      else { if (v("ffPc") === v("ffSoc")) $("ffPc").value = ""; $("ffPc").disabled = false; }
      var mtF = nb(v("ffMt"));
      if (fc && fc.article && on("ffCatB") && !v("ffCat") && (F.categories || []).indexOf(fc.article) >= 0) $("ffCat").value = fc.article;
      if (achat) $("ffFourI").textContent = v("ffFour").trim() ? ["Compte : " + fourLibCompte(fc || { societe: v("ffSoc"), projet: v("ffProj").trim() }) + (fc ? "" : " (nouveau compte, créé à l'envoi)"),
          fc && fc.tva ? "assujetti TVA 18 %" + (mtF > 0 ? " (HT " + gnf(Math.round(mtF / 1.18)) + " + TVA " + gnf(mtF - Math.round(mtF / 1.18)) + " " + v("ffDev") + ")" : "") : "",
          t === "Règlement fournisseur" && v("ffPc") ? "payé par " + payeurAchat(t) + " pour " + v("ffSoc") + " → dette en 🔁 Inter-sociétés" : ""].filter(String).join(" · ") : "";
      else $("ffFourI").textContent = fc ? [fc.societe ? "bénéficiaire " + fc.societe : "toutes sociétés", fc.projet ? "projet " + fc.projet : "",
          fc.tva ? "assujetti TVA 18 %" + (mtF > 0 && t !== "Mouvement de trésorerie" ? " (HT " + gnf(Math.round(mtF / 1.18)) + " + TVA " + gnf(mtF - Math.round(mtF / 1.18)) + " " + v("ffDev") + ")" : "") : "",
          v("ffPc") && on("ffPcB") ? "payé par " + v("ffSoc") + " pour " + v("ffPc") + " → dette en 🔁 Inter-sociétés" : ""].filter(String).join(" · ")
        : four && on("ffFourB") ? "Nouveau fournisseur : il sera créé avec un compte général (comptes par société / projet dans 🏭 Fournisseurs)." : "";
      var fa = null;
      if (achat) $("ffFact").innerHTML = "<option value=''></option>";
      if (regl && regC.length) {   // info : bénéficiaires repris des factures ; payée par une autre société → Inter-sociétés
        var socsB = []; regC.forEach(function (f) { var b = f._soc || f.societe; if (b && socsB.indexOf(b) < 0) socsB.push(b); });
        $("ffFourI").textContent = "Bénéficiaire(s) : " + (socsB.join(", ") || "—") + (socsB.some(function (b) { return b !== v("ffSoc"); }) ? " · payé par " + v("ffSoc") + " → dette en 🔁 Inter-sociétés pour " + socsB.filter(function (b) { return b !== v("ffSoc"); }).join(", ") : "");
      } else if (avance) $("ffFourI").textContent = v("ffFour").trim() ? "Compte : " + fourLibCompte(fc || { societe: v("ffAvS"), projet: v("ffProj").trim() }) + (fc ? "" : " (nouveau compte, créé à l'envoi)") + (v("ffAvS") !== v("ffSoc") ? " · payé par " + v("ffSoc") + " pour " + v("ffAvS") + " → 🔁 Inter-sociétés" : "") : "";
      if (false) {
        var nomsC = Cf.map(function (c) { return c.nom.toLowerCase(); });
        var Fa = F.factures.filter(function (f) { return !v("ffFour").trim() || (nomsC.length ? nomsC.indexOf(f.fournisseur.toLowerCase()) >= 0 : f.fournisseur.toLowerCase() === four.toLowerCase()); }), cur = $("ffFact").value || src.facture || "";
        $("ffFact").innerHTML = "<option value=''>Sans facture (avance)</option>" + Fa.map(function (f) { return "<option value='" + esc(f.no) + "'" + (f.no === cur ? " selected" : "") + ">" + esc(f.no + " · " + f.fournisseur + (f.ref ? " · " + f.ref : "") + " · reste " + gnf(f.reste - f.engage) + " GNF") + "</option>"; }).join("");
        fa = Fa.filter(function (f) { return f.no === $("ffFact").value; })[0] || null;
        if (fa && Cf.some(function (c) { return c.nom === fa.fournisseur; }) && $("ffFourC").value !== fa.fournisseur) { $("ffFourC").value = fa.fournisseur; setTimeout(maj, 0); }   // le règlement va sur le compte de la facture
        $("ffFactI").textContent = fa ? "Total " + gnf(fa.total) + " GNF · déjà réglé " + gnf(fa.total - fa.reste) + " · en cours " + gnf(fa.engage) + " · disponible " + gnf(fa.reste - fa.engage) + " GNF (règlement par tranches possible)" +
          (fa.categorie ? " · catégorie " + fa.categorie + (fa.achat ? " (achat d'article de la facture)" : "") : "") : "";
      }
      // Catégorie : imposée pour les mouvements internes et la paie ; reprise de la facture réglée.
      var catStock = /importée/.test(v("ffDest")) ? "Fourniture Importee" : "Fourniture Locale";
      var catAuto = (t === "Mouvement de trésorerie" && !benExt) || t === "Paiement RH" || (t === "Opération constatée" && op === "Credit bancaire") ||
        (achat && (stock || t === "Facture d'achat")) || (regl && !avance && regC.length > 0 && regC.every(function (f) { return f.categorie; }));
      vis("ffCatB", !catAuto);
      vis("ffImpB", on("ffCatB") && v("ffCat") === "Impôts et taxes"); vis("ffImpCB", on("ffCatB") && v("ffCat") === "Commission");
      $("ffCatB").querySelector("label").textContent = regl && !avance && regC.length ? "Catégorie (factures sans catégorie)" : "Catégorie (trésorerie)";
      var cat = achat && stock ? catStock : on("ffCatB") ? v("ffCat") : "";
      // Bloc achat : catégorie Fourniture (sauf règlement d'une facture qui porte déjà l'achat).
      vis("ffAchB", (achat ? stock : on("ffCatB") && (cat === "Fourniture Locale" || cat === "Fourniture Importee")) && t !== "Opération constatée" && !(achat && v("ffSoc") === "CASAFINO") && !(on("ffPcB") && v("ffPc") === "CASAFINO"));
      // Magasin de destination : par défaut celui de la société bénéficiaire (sinon le magasin de la production).
      var MG = AC.magasins || [], socB = v("ffSoc");
      vis("ffAMagB", on("ffAchB") && v("ffAN") !== "Frais" && MG.length > 0);
      if (MG.map(function (m) { return m.nom; }).join("|") !== $("ffAMag").getAttribute("data-l")) {
        var mDef = A0.magasin || (MG.filter(function (m) { return m.societe === socB && m.nom === AC.magDefaut; })[0] || MG.filter(function (m) { return m.societe === socB; })[0] || {}).nom || AC.magDefaut;
        $("ffAMag").innerHTML = MG.map(function (m) { return "<option" + (m.nom === mDef ? " selected" : "") + ">" + esc(m.nom) + "</option>"; }).join("");
        $("ffAMag").setAttribute("data-l", MG.map(function (m) { return m.nom; }).join("|")); $("ffAMag").setAttribute("data-s", socB);
      } else if ($("ffAMag").getAttribute("data-s") !== socB && !A0.magasin) {   // société changée : magasin par défaut de la nouvelle société
        var m2 = MG.filter(function (m) { return m.societe === socB; })[0]; if (m2) $("ffAMag").value = m2.nom; $("ffAMag").setAttribute("data-s", socB);
      }
      if (on("ffAchB")) {
        var n = v("ffAN"); vis("ffAEx", n === "Article existant"); vis("ffANv", n === "Nouvel article"); vis("ffAQt", n === "Article existant" || n === "Nouvel article"); vis("ffAFr", n === "Frais");
        var ca = v("ffACat"), artCur = $("ffAArt").value || A0.article || "";
        $("ffAArt").innerHTML = opts((AC.articles || {})[ca] || [], artCur, "— choisir —");
        var cn = v("ffACatN"); vis("ffAPap", cn === "PAPIER"); vis("ffAEnc", /ENCRE/.test(cn)); vis("ffAPla", cn === "PLATINE");
        $("ffAFact").textContent = t === "Facture d'achat" ? "Les détails de l'article servent au 1er règlement de cette facture ; les tranches suivantes s'ajoutent à son coût." : "";
      }
      var g = nb(v("ffMt")) * (dev === "GNF" ? 1 : nb(v("ffTaux")));
      $("ffGnf").textContent = dev !== "GNF" ? (nb(v("ffTaux")) > 0 ? "Valorisation : " + gnf(nb(v("ffMt"))) + " " + dev + " × " + gnf(nb(v("ffTaux"))) + " = " + gnf(g) + " GNF" : "⚠ Indiquez le taux de change " + dev + " → GNF (en haut).") : "";
      $("ffMtL").textContent = "Montant (" + dev + ")"; $("ffTauxL").textContent = "Taux de change : 1 " + dev + " = … GNF";
      $("ffAGnf").textContent = on("ffAchB") && dev !== "GNF" ? (nb(v("ffTaux")) > 0 ? "Valorisation du stock (CUMP) : " + gnf(g) + " GNF au taux " + gnf(nb(v("ffTaux"))) : "Valorisation du stock : taux de change requis.") : "";
      // Règle de validation (aperçu ; le serveur décide).
      var gros = g >= (F.seuil || 5000000), regle;
      if (t === "Opération constatée") regle = "aucune (constatée, inscrite directement)";
      else regle = t === "Facture d'achat" || (t === "Dépense de caisse" && gros) || (t === "Règlement fournisseur" && !((mode === "Espèces" || mode === "Chèque") && !gros)) ||
        (t === "Paiement RH" && !(mode === "Espèces" && !gros)) || (t === "Mouvement de trésorerie" && !(((chq && !benExt) || op === "Transfert entre caisses" || op === F.opRemb) && !gros)) ? "Walid puis DG" : "Walid";
      var photo = achat ? (avecF ? "photo de la facture obligatoire" : "photo du reçu facultative") : t === "Facture d'achat" ? "photo de la facture obligatoire" : (t === "Règlement fournisseur" && mode === "Chèque") || (t === "Mouvement de trésorerie" && (chq || op === "Retrait")) ? "photo du chèque obligatoire" : "pièces facultatives";
      if (F.role === "DG") regle = "validée d'office (DG)" + (t === "Facture d'achat" || t === "Opération constatée" ? "" : " · exécution directe avec la preuve");
      else if (F.role === "Walid" && t !== "Opération constatée") regle = /DG/.test(regle) ? "Walid d'office, puis DG" : "validée d'office (Walid)";
      if ($("ffXB")) vis("ffXB", t !== "Facture d'achat" && t !== "Opération constatée");
      $("ffRegle").innerHTML = "🔐 Validation : <b>" + regle + "</b> · 📷 " + photo + (t !== "Facture d'achat" && t !== "Opération constatée" && F.role !== "DG" ? ((t === "Mouvement de trésorerie" && (op === "Retrait" || op === "Transfert entre caisses")) || (t === "Règlement fournisseur" && mode === "Chèque" && cat === "Commission") || cat === "Commission" ? " · clôture sans autre pièce (le chèque / justificatif joint suffit)" : " · preuve du paiement à joindre après validation" + (t === "Dépense de caisse" ? " (facultative)" : "")) : "");
      $("ffEnv").textContent = t === "Opération constatée" ? "📒 Enregistrer" : "📤 Envoyer la demande";
    }
    ["ffType", "ffPiece", "ffPay", "ffPayS", "ffDest", "ffRegM", "ffRegS", "ffRegP", "ffAvS", "ffOp", "ffOc", "ffDev", "ffSoc", "ffPc", "ffFourC", "ffMode", "ffFact", "ffCpt", "ffCtp", "ffCat", "ffAN", "ffACat", "ffACatN", "ffPers", "ffMotRH"].forEach(function (id) { $(id).onchange = maj; });
    $("ffPayS").onchange = function () { payManuel = true; maj(); };
    ["ffMt", "ffTaux", "ffFour", "ffProj"].forEach(function (id) { $(id).oninput = maj; });
    maj();
    $("ffEnv").onclick = function () {
      var tU = v("ffType"), achat = tU === "Achat fournisseur", avecF = v("ffPiece") === "Avec facture", m = $("ffMsg");
      var t = achat ? (v("ffPay") === "À payer plus tard" ? "Facture d'achat" : "Règlement fournisseur") : tU;
      var op = achat ? (t === "Règlement fournisseur" ? "Achat comptant" : avecF ? "" : "Sans facture") : t === "Mouvement de trésorerie" ? v("ffOp") : t === "Opération constatée" ? v("ffOc") : "";
      var s = { no: src.no, type: t, op: op, societe: achat ? payeurAchat(t) : v("ffSoc"), pourCompte: achat ? v("ffPc") : on("ffPcB") ? v("ffPc") : "",
        fourRaison: achat || estAvance() ? (comptesDe(v("ffFour")).length ? fourRaison(comptesDe(v("ffFour"))[0]) : v("ffFour").trim()) : "", fourSociete: achat ? v("ffSoc") : estAvance() ? v("ffAvS") : "", fourProjet: achat || estAvance() ? v("ffProj").replace(/\s+/g, " ").trim() : "", fournisseur: on("ffFourB") ? compteChoisi() : "", facture: t === "Règlement fournisseur" && !achat ? v("ffFact") : "",
        refFacture: achat && avecF ? v("ffRef") : "", echeance: t === "Facture d'achat" ? v("ffEch") : "", objet: v("ffObj"), montant: nb(v("ffMt")), devise: v("ffDev"), taux: nb(v("ffTaux")),
        mode: on("ffModeB") ? v("ffMode") : t === "Dépense de caisse" ? "Espèces" : "", compte: t === "Facture d'achat" ? "" : v("ffCpt"), contrepartie: on("ffCtpB") ? v("ffCtp") : "",
        beneficiaire: on("ffBenB") ? v("ffBen") : "", commentaire: v("ffCom"), personnel: t === "Paiement RH" ? v("ffPers") : "", motifRH: t === "Paiement RH" ? v("ffMotRH") : "",
        categorie: achat && /^📦/.test(v("ffDest")) ? (/importée/.test(v("ffDest")) ? "Fourniture Importee" : "Fourniture Locale") : on("ffCatB") ? v("ffCat") : "", recu: on("ffRecuB") ? nb(v("ffRecu")) : on("ffEqB") ? nb(v("ffEq")) : 0, moisEffet: on("ffMoisB") ? v("ffMois") : "", dateEffet: on("ffEffB") ? v("ffEff") : "", fourTel: v("ffTel"), fourNif: v("ffNif"), fourRib: v("ffRib") };
      var reglF = t === "Règlement fournisseur" && !achat && !estAvance();
      if (reglF) {
        var RC = regCoches();
        if (!RC.length) { m.textContent = "⛔ Cochez au moins une facture (ou choisissez « Avance »)."; return; }
        if (RC.some(function (f) { return (f.devise || "GNF") !== (RC[0].devise || "GNF"); })) { m.textContent = "⛔ Factures en devises différentes : réglez-les séparément."; return; }
        var trop = RC.filter(function (f) { var mt = nb((REG[f.no] || {}).mt); return !(mt > 0) || (s.devise === "GNF" && mt > f.reste - f.engage + (src.facture === f.no ? +src.montant || 0 : 0) + 0.5); })[0];
        if (trop) { m.textContent = "⛔ Montant de " + (trop.ref || trop.no) + " : vide ou supérieur au reste."; return; }
        s.objet = "Règlement " + RC.map(function (f) { return f.ref || f.no; }).join(", ");
        if (src.no) { s.facture = RC[0].no; s.fournisseur = RC[0].fournisseur; s.montant = nb(REG[RC[0].no].mt); }
        else { s.reglements = RC.map(function (f) { return { facture: f.no, montant: nb(REG[f.no].mt) }; }); s.facture = RC[0].no; s.fournisseur = RC[0].fournisseur; }
      }
      if (estAvance()) s.facture = "";
      // 🧾 Impôt / commission liée aux impôts : repère dans l'objet (lu par la Répartition dans Base)
      if (on("ffImpB")) {
        var ik = (IMP_TYPES.filter(function (x) { return x[1] === v("ffImp"); })[0] || [])[0], ia = String(v("ffImpA")).trim();
        if (!ik) { $("ffMsg").textContent = "⛔ Choisissez l'impôt."; return; }
        if (!/^\d{4}$/.test(ia)) { $("ffMsg").textContent = "⛔ Année concernée (ex. " + (new Date().getFullYear() - 1) + ")."; return; }
        s.objet = (String(s.objet || "").trim() || v("ffImp") + " " + ia) + " [IMP:" + ik + "|" + ia + "]";
      } else if (on("ffImpCB") && $("ffImpC").checked) {
        var ica = String(v("ffImpCA")).trim();
        if (!/^\d{4}$/.test(ica)) { $("ffMsg").textContent = "⛔ Année de la réserve fiscale (ex. " + (new Date().getFullYear() - 1) + ")."; return; }
        s.objet = String(s.objet || "").trim() + " [IMP:COM|" + ica + "]";
      }
      if (on("ffAchB")) s.achat = { nature: v("ffAN"), categorie: v("ffACat"), article: v("ffAArt"), designation: v("ffADes"), catNouvel: v("ffACatN"),
        carac: { y: v("ffAY"), x: v("ffAX"), kg: v("ffAKg"), unites: v("ffAU"), metres: v("ffAM") }, quantite: nb(v("ffAQ")), expediteur: v("ffAExp"), typeFrais: v("ffATF"),
        articles: Array.prototype.filter.call(document.querySelectorAll(".ffAO"), function (c) { return c.checked; }).map(function (c) { return c.value; }),
        magasin: on("ffAMagB") ? v("ffAMag") : "" };
      var A = s.achat;
      var err = t === "Paiement RH" && !s.personnel ? "personnel" : t === "Paiement RH" && !s.motifRH ? "motif RH" : on("ffModeB") && !s.mode ? "mode de paiement" :
        !s.compte && t !== "Facture d'achat" ? "compte" : on("ffCatB") && !s.categorie && t !== "Facture d'achat" ? "catégorie" : on("ffRecuB") && !(s.recu > 0) ? "montant reçu" : on("ffEqB") && !(s.recu > 0) ? "équivalent dans la devise du salaire" : on("ffMoisB") && !s.moisEffet ? "mois du salaire" :
        on("ffCtpB") && !s.contrepartie && !((op === "Virement" || op === "Remise chèque") && s.beneficiaire) ? "compte de destination" : !(s.montant > 0) ? "montant" : s.devise !== "GNF" && !(s.taux > 0) ? "taux de change" :
        (t === "Mouvement de trésorerie" || t === "Opération constatée") && !op ? "opération" : (t === "Facture d'achat" || t === "Règlement fournisseur") && !s.fournisseur ? "fournisseur" :
        A && !A.nature ? "nature de l'achat" : A && A.nature === "Article existant" && !A.article ? "article acheté" : A && A.nature === "Nouvel article" && !(A.designation && A.catNouvel) ? "nouvel article (désignation et catégorie)" :
        A && A.nature !== "Frais" && !(A.quantite > 0) ? "quantité commandée" : A && A.nature === "Frais" && !A.articles.length ? "article concerné par le frais" : "";
      if (err) { m.textContent = "⛔ Indiquez : " + err + "."; return; }
      var nbP = (FICH.ffP || []).length + ((src.pieces || []).length);
      if (/obligatoire/.test($("ffRegle").textContent) && !nbP) { m.textContent = "⛔ Photo obligatoire (voir ci-dessus)."; return; }
      var lib = reglF ? "Règlement " + (s.reglements && s.reglements.length > 1 ? s.reglements.length + " factures" : "facture") + " · " + v("ffFour").trim() : estAvance() ? "Avance · " + v("ffFour").trim() : achat ? "Achat " + (t === "Facture d'achat" ? "à payer" : "payé") + (avecF ? "" : " sans facture") + " · " + (s.fourRaison || s.fournisseur) + (s.fourSociete ? " · pour " + s.fourSociete : "") + (s.fourProjet ? " · " + s.fourProjet : "") : (op || t) + (t === "Paiement RH" ? " · " + s.personnel : "");
      if (!confirm((t === "Opération constatée" ? "Enregistrer : " : "Envoyer la demande : ") + lib + " · " + gnf(s.montant) + " " + s.devise + " ?")) return;
      envoyerFin(src.no ? "modifier" : "creer", src.no ? { demande: s, version: src.version, fichiers: FICH.ffP } : { demande: s, fichiers: FICH.ffP, preuves: $("ffXB") && on("ffXB") ? FICH.ffX : [] }, (src.no ? "Correction " + src.no : lib) + " · " + gnf(s.montant) + " " + s.devise, src.no);
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
        if (d.type === "Règlement fournisseur" && !d.facture && d.op !== "Achat comptant" && d.statut === "Exécutée") f.avances += d.gnf;
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
    if (m.type === "notif") { setTimeout(majCloche, 800); synchroniser(true).catch(function () {}); }
    if (m.type === "ouvrir") ouvrirDepuisNotif(m.data || {});
  });
  /* ---------- 👥 Ressources humaines : personnel, événements (validés par Walid), paie du mois ---------- */
  function droitRH() { var d = S.agent && S.formulaires && S.formulaires.droits; return !!(d && (d.rh || d.validation || d.comptable)); }
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
  var COUL_EV = { "À corriger": "#b26a00", "En attente Walid": "#e65100", "Validé": "#2e7d32", "Refusé": "#c62828", "Annulé": "#777" };
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
  /* ---------- 🏖️ Congés et billets d'avion (RH) ---------- */
  var CBV = { an: new Date().getFullYear(), form: "", fiche: "" };
  function cbJ(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function cbIso(t) { if (!t) return ""; var d = new Date(t); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function cbFinValidite(emis, mois) { var d = new Date(emis); d.setMonth(d.getMonth() + (mois || 11)); return d.getTime(); }
  // « 👍 Vu » : propre à l'agent et à cet appareil, jusqu'à l'étape suivante (30 j → 7 j). « ✅ Confirmé » : serveur, pour tous.
  var CB_VUS = (function () { try { return JSON.parse(localStorage.getItem("cbVus") || "{}"); } catch (e) { return {}; } })();
  function cbVuCle(a) { return ((S.agent && S.agent.nom) || "") + "|" + a.no + "|" + a.cle + "|" + a.etape; }
  function cbMarquerVu(a) { CB_VUS[cbVuCle(a)] = Date.now(); try { localStorage.setItem("cbVus", JSON.stringify(CB_VUS)); } catch (e) {} }
  function cbAlertes(R) {
    var auj = misAuj(), A = [], CB = R.cb || { liste: [] };
    function pousser(x, o) { if (o.cle && x.confirmes && x.confirmes[o.cle]) return; o.no = x.no; if (o.cle && CB_VUS[cbVuCle(o)]) return; A.push(o); }
    CB.liste.forEach(function (x) {
      if (x.statut === "En attente DG") A.push({ niv: 1, t: "⏳ " + x.type + " de " + x.personnel + " en attente de validation (DG)", no: x.no });
      if (x.statut !== "Validé") return;
      [["dep", x.du, x.type === "Congé" ? "🏖️ Congé de " + x.personnel + " (" + x.jours + " j)" : "✈️ Départ de " + x.personnel + (x.allerVers ? " vers " + x.allerVers : "")], ["ret", x.type === "Billet" ? x.au : 0, "↩️ Retour de " + x.personnel + (x.retourVers ? " vers " + x.retourVers : "") + " : à confirmer ou modifier"]].forEach(function (a) {
        if (!a[1]) return; var j = Math.round((cbJ(a[1]) - auj) / 86400000);
        if (j >= 0 && j <= 30) pousser(x, { niv: j <= 7 ? 2 : 3, t: a[2] + " — " + (j === 0 ? "aujourd'hui" : "dans " + j + " j") + " (" + jourFr(a[1]) + ")", cle: a[0] + "|" + cbIso(a[1]), etape: j <= 7 ? "7" : "30" });
      });
      if (x.type === "Billet" && (x.du || x.emis)) { var fv = cbFinValidite(x.du || x.emis, CB.validite), jv = Math.round((fv - auj) / 86400000); if (jv >= 0 && jv <= 30 && (!x.au || x.au > auj)) pousser(x, { niv: 2, t: "🎫 Billet de " + x.personnel + " : validité jusqu'au " + jourFr(fv), cle: "val|" + cbIso(fv), etape: jv <= 7 ? "7" : "30" }); }
    });
    return A.sort(function (a, b) { return a.niv - b.niv; });
  }
  // 🎯 Missions : « 👍 Vu » (pour moi, sur cet appareil) cache l'alerte pour la journée ; « ✅ Fait » = signalée terminée → clôture par le DG.
  var MIS_VUS = (function () { try { return JSON.parse(localStorage.getItem("misVus") || "{}"); } catch (e) { return {}; } })();
  function misVuCle(m) { return ((S.agent && S.agent.nom) || "") + "|" + m.id + "|" + m.echeance; }
  function misVu(m) { return MIS_VUS[misVuCle(m)] === dateISO(Date.now()); }
  function misMarquerVu(m) { MIS_VUS[misVuCle(m)] = dateISO(Date.now()); try { localStorage.setItem("misVus", JSON.stringify(MIS_VUS)); } catch (e) {} }
  function misBoutons(i, m) {
    var dg = String((S.agent && S.agent.nom) || "").toUpperCase() === "DG";
    if (m.statut === "À clôturer") return dg ? "<div class='ligne' style='margin-top:8px;gap:6px'><button class='bouton' data-mic='" + i + "' style='width:auto;flex:0 0 auto;padding:6px 12px;margin:0;background:var(--vert)'>✅ Valider (clôturer)</button></div>" : "";
    return "<div class='ligne' style='margin-top:8px;gap:6px'><button class='bouton' data-mif='" + i + "' style='width:auto;flex:0 0 auto;padding:6px 12px;margin:0;background:var(--vert)'>✅ Fait</button>" +
      "<button class='bouton second' data-miv='" + i + "' style='width:auto;flex:0 0 auto;padding:6px 12px;margin:0'>👍 Vu</button></div>";
  }
  function misLierBoutons(racine, liste, apres) {
    function m(b, k) { return liste[+b.getAttribute(k)]; }
    Array.prototype.forEach.call(racine.querySelectorAll("[data-miv]"), function (b) { b.onclick = function (ev) { ev.stopPropagation(); misMarquerVu(m(b, "data-miv")); apres(); }; });
    Array.prototype.forEach.call(racine.querySelectorAll("[data-mif]"), function (b) { b.onclick = function (ev) { ev.stopPropagation(); var x = m(b, "data-mif");
      if (!confirm("« " + x.titre + " » : faite ?\nElle est signalée terminée ; le DG valide la clôture.")) return;
      envoyerMis("statut", { id: x.id, version: x.version, statut: "À clôturer", commentaire: "Fait (depuis les notifications)" }, "À clôturer " + x.id, apres); }; });
    Array.prototype.forEach.call(racine.querySelectorAll("[data-mic]"), function (b) { b.onclick = function (ev) { ev.stopPropagation(); var x = m(b, "data-mic");
      if (!confirm("Clôturer « " + x.titre + " » (terminée) ?" + (x.rec ? "\nLa suivante (" + x.rec.toLowerCase() + ") sera créée." : ""))) return;
      envoyerMis("statut", { id: x.id, version: x.version, statut: "Terminée", commentaire: "Validée (depuis les notifications)" }, "Clôture " + x.id, apres); }; });
  }
  function cbBoutons(i) { return "<div class='ligne' style='margin-top:8px;gap:6px'><button class='bouton' data-cbc='" + i + "' style='width:auto;flex:0 0 auto;padding:6px 12px;margin:0;background:var(--vert)'>✅ Confirmé</button>" +
    "<button class='bouton second' data-cbv='" + i + "' style='width:auto;flex:0 0 auto;padding:6px 12px;margin:0'>👍 Vu</button></div>"; }
  function cbLierBoutons(racine, liste, apres) {
    Array.prototype.forEach.call(racine.querySelectorAll("[data-cbc]"), function (b) { b.onclick = function (ev) { ev.stopPropagation(); var a = liste[+b.getAttribute("data-cbc")];
      if (!confirm("Confirmer pour tout le monde : " + a.t + " ?\nL'alerte ne s'affichera plus (elle reviendra si la date change).")) return;
      envoyerRH("cbConfirmer", { no: a.no, cle: a.cle }, "Confirmation " + a.no, apres); }; });
    Array.prototype.forEach.call(racine.querySelectorAll("[data-cbv]"), function (b) { b.onclick = function (ev) { ev.stopPropagation(); cbMarquerVu(liste[+b.getAttribute("data-cbv")]); apres(); }; });
  }
  function vueCongesRH(C, R) {
    var CB = R.cb || { liste: [], soldes: {} }, dg = R.role === "DG", an = CBV.an, deb = new Date(an, 0, 1).getTime(), fin = new Date(an + 1, 0, 1).getTime(), duree = fin - deb, auj = misAuj();
    var pers = R.personnel.filter(function (p) { return p.actif; }).map(function (p) { return p.nom; }).concat(((R.pr || {}).prestataires || []).filter(function (p) { return p.actif; }).map(function (p) { return p.nom; })).sort();
    if (CBV.fiche) { ficheCB(C, R, CB.liste.filter(function (x) { return x.no === CBV.fiche; })[0]); return; }
    if (CBV.form) { formCB(C, R, pers); return; }
    function pct(t) { return Math.max(0, Math.min(100, (t - deb) / duree * 100)); }
    var A = cbAlertes(R);
    var h = "<div class='carte pleine'><div class='ligne' style='flex-wrap:wrap;gap:6px'><button class='bouton' id='cbC' style='width:auto;flex:0 0 auto;margin:0'>➕ Congé</button>" +
      "<button class='bouton' id='cbB' style='width:auto;flex:0 0 auto;margin:0'>✈️ Billet d'avion</button><button class='bouton second' id='cbD' style='width:auto;flex:0 0 auto;margin:0'>⚙️ Droits (début du cycle)</button></div>" +
      "<div class='info'>Droit : 30 jours / 12 mois (2,5 j par mois), fractionnable · billet aller-retour valable " + (CB.validite || 11) + " mois · saisie RH / Walid, validation DG.</div></div>";
    if (A.length) h += "<div class='carte pleine' style='border-color:var(--cuivre)'><h3>⚠️ À surveiller (" + A.length + ")</h3>" + A.map(function (a, i) {
      return "<div data-cb='" + esc(a.no) + "' style='cursor:pointer;padding:6px 0;border-top:1px solid var(--bord);color:" + (a.niv === 2 ? "#c62828" : a.niv === 1 ? "#e65100" : "inherit") + "'>" + esc(a.t) + (a.cle ? cbBoutons(i) : "") + "</div>"; }).join("") + "</div>";
    // Calendrier annuel : une ligne par personne.
    var mois = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"], MO = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
    h += "<div class='carte pleine'><div class='ligne' style='justify-content:space-between;align-items:center'><button class='bouton second' id='cbP' style='width:auto;flex:0 0 auto;margin:0'>‹</button><b>📅 Calendrier " + an + "</b><button class='bouton second' id='cbS' style='width:auto;flex:0 0 auto;margin:0'>›</button></div>" +
      "<div style='display:flex;margin:8px 0 2px 0'><div style='flex:0 0 110px'></div><div style='flex:1;display:grid;grid-template-columns:repeat(12,minmax(0,1fr))'>" + MO.map(function (m, i) { return "<div class='info' style='margin:0;text-align:center;font-size:11px;border-left:1px solid var(--bord)'>" + (window.innerWidth < 700 ? mois[i] : m) + "</div>"; }).join("") + "</div></div>" +
      pers.map(function (p) {
        var L = CB.liste.filter(function (x) { return x.personnel === p && ["Validé", "En attente DG"].indexOf(x.statut) >= 0 && (x.du < fin && (x.au || x.du) >= deb); }), s = CB.soldes[p] || {};
        var barres = L.map(function (x) {
          var att = x.statut !== "Validé";
          if (x.type === "Congé") return "<div data-cb='" + esc(x.no) + "' title='" + esc("Congé " + jourFr(x.du) + " → " + jourFr(x.au) + " · " + x.jours + " j" + (att ? " (en attente)" : "")) + "' style='cursor:pointer;position:absolute;top:3px;bottom:3px;left:" + pct(x.du) + "%;width:" + Math.max(0.6, pct(x.au + 86400000) - pct(x.du)) + "%;border-radius:4px;background:" + (att ? "repeating-linear-gradient(45deg,#2e7d32,#2e7d32 4px,#81c784 4px,#81c784 8px)" : "#2e7d32") + "'></div>";
          var o = "";
          if (x.au) o += "<div style='position:absolute;top:9px;height:4px;left:" + pct(x.du) + "%;width:" + Math.max(0.3, pct(x.au) - pct(x.du)) + "%;background:rgba(21,101,192,.35)'></div>";
          [[x.du, "✈️"], [x.au, "↩️"]].forEach(function (k) { if (k[0] && k[0] >= deb && k[0] < fin) o += "<div data-cb='" + esc(x.no) + "' title='" + esc((k[1] === "✈️" ? "Aller" + (x.allerVers ? " vers " + x.allerVers : "") + " " : "Retour" + (x.retourVers ? " vers " + x.retourVers : "") + " ") + jourFr(k[0]) + (att ? " (en attente)" : "")) + "' style='cursor:pointer;position:absolute;top:-1px;left:calc(" + pct(k[0]) + "% - 8px);font-size:14px'>" + k[1] + "</div>"; });
          return o;
        }).join("");
        return "<div style='display:flex;align-items:center;border-top:1px solid var(--bord)'><div style='flex:0 0 110px;font-size:12px;padding:4px 4px 4px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'><b>" + esc(p) + "</b><br><span class='info' style='margin:0;font-size:11px;color:" + ((s.solde || 0) < 0 ? "#c62828" : "inherit") + "'>solde " + (s.debut ? (Math.round((s.solde || 0) * 10) / 10) + " j" : "cycle ?") + "</span></div>" +
          "<div style='flex:1;position:relative;height:24px;background:repeating-linear-gradient(90deg,transparent 0,transparent calc(100%/12 - 1px),var(--bord) calc(100%/12 - 1px),var(--bord) calc(100%/12))'>" +
          (auj >= deb && auj < fin ? "<div style='position:absolute;top:0;bottom:0;left:" + pct(auj) + "%;width:2px;background:var(--cuivre)'></div>" : "") + barres + "</div></div>";
      }).join("") + "<div class='info'><span style='color:#2e7d32'>■</span> congé (hachuré : en attente) · ✈️ aller · ↩️ retour · ━ hors de l'atelier · <span style='color:var(--cuivre)'>|</span> aujourd'hui</div></div>";
    // Soldes et liste
    h += "<div class='carte pleine'><h3>Soldes et billets</h3><table style='width:100%;font-size:13px'><tr style='color:#888;text-align:left'><th>Agent</th><th>Cycle depuis</th><th style='text-align:right'>Acquis</th><th style='text-align:right'>Pris</th><th style='text-align:right'>Solde</th><th>Billet en cours</th></tr>" +
      pers.map(function (p) {
        var s = CB.soldes[p] || {}, b = CB.liste.filter(function (x) { return x.personnel === p && x.type === "Billet" && x.statut === "Validé" && (!x.au || x.au >= auj); }).sort(function (a, c) { return a.du - c.du; })[0];
        return "<tr style='border-top:1px solid var(--bord)'><td>" + esc(p) + "</td><td>" + (s.debut ? jourFr(s.debut) : "<span class='info'>à renseigner</span>") + "</td><td style='text-align:right'>" + (Math.round((s.acquis || 0) * 10) / 10) + "</td><td style='text-align:right'>" + (s.pris || 0) +
          "</td><td style='text-align:right;font-weight:700'>" + (Math.round((s.solde || 0) * 10) / 10) + " j</td><td>" + (b ? "<span data-cb='" + esc(b.no) + "' style='cursor:pointer'>✈️ " + (b.allerVers ? esc(b.allerVers) + " " : "") + jourFr(b.du) + " · ↩️ " + (b.au ? jourFr(b.au) : "ouvert") + "</span>" : "—") + "</td></tr>";
      }).join("") + "</table></div>";
    C.innerHTML = h;
    $("cbC").onclick = function () { CBV.form = "Congé"; CBV.edit = null; afficherRH(); };
    $("cbB").onclick = function () { CBV.form = "Billet"; CBV.edit = null; afficherRH(); };
    $("cbD").onclick = function () { CBV.form = "Droit"; CBV.edit = null; afficherRH(); };
    $("cbP").onclick = function () { CBV.an--; afficherRH(); }; $("cbS").onclick = function () { CBV.an++; afficherRH(); };
    Array.prototype.forEach.call(C.querySelectorAll("[data-cb]"), function (el) { el.onclick = function () { CBV.fiche = el.getAttribute("data-cb"); afficherRH(); window.scrollTo(0, 0); }; });
    cbLierBoutons(C, A, function () { afficherRH(); });
  }
  function formCB(C, R, pers) {
    var t = CBV.form, x = CBV.edit || {}, o = function (L, v) { return L.map(function (n) { return "<option" + (n === v ? " selected" : "") + ">" + esc(n) + "</option>"; }).join(""); };
    var s = (R.cb && R.cb.soldes) || {};
    var h = "<div class='carte pleine'><h3>" + (t === "Congé" ? "🏖️ " + (x.no ? "Modifier le congé " + x.no : "Nouveau congé") : t === "Billet" ? "✈️ " + (x.no ? "Modifier le billet " + x.no : "Nouveau billet d'avion (aller-retour)") : "⚙️ Droits aux congés") + "</h3>" +
      "<label>Personnel</label><select id='cfP'>" + o(pers, x.personnel || pers[0]) + "</select><div id='cfS' class='info'></div>";
    if (t === "Congé") h += "<div class='ligne'><div><label>Premier jour</label><input id='cfDu' type='date' value='" + cbIso(x.du) + "'></div><div><label>Dernier jour</label><input id='cfAu' type='date' value='" + cbIso(x.au) + "'></div></div><div id='cfJ' class='info'></div>";
    else if (t === "Billet") {
      var VL = (R.cb && R.cb.villes) || ["Tunis", "Conakry"], av0 = x.allerVers || "Tunis", rv0 = x.retourVers || (/^conakry$/i.test(av0) ? "Tunis" : "Conakry");
      var vOpts = function (v) { return VL.map(function (n) { return "<option" + (n.toLowerCase() === String(v).toLowerCase() ? " selected" : "") + ">" + esc(n) + "</option>"; }).join("") + "<option value='__autre'>Autre…</option>"; };
      h += "<div class='ligne'><div><label>Compagnie</label><input id='cfCo' value='" + esc(x.compagnie || "") + "'></div><div><label>N° du billet</label><input id='cfNb' value='" + esc(x.billet || "") + "'></div><div><label>Émis le</label><input id='cfEm' type='date' value='" + cbIso(x.emis || Date.now()) + "'></div></div>" +
        "<div class='ligne'><div><label>✈️ Aller vers</label><select id='cfAv'>" + vOpts(av0) + "</select><input id='cfAvA' placeholder='Ville' style='display:none;margin-top:6px'></div><div><label>Date de départ</label><input id='cfDu' type='date' value='" + cbIso(x.du) + "'></div></div>" +
        "<div class='ligne'><div><label>↩️ Retour vers</label><select id='cfRv'>" + vOpts(rv0) + "</select><input id='cfRvA' placeholder='Ville' style='display:none;margin-top:6px'></div><div><label>Date de retour <small>(vide = ouvert)</small></label><input id='cfAu' type='date' value='" + cbIso(x.au) + "'></div></div>" +
        "<div id='cfV' class='info'></div>" + champFichiers("cfPj").replace("Photos / PDF", "🎫 Billet (photo ou PDF) — obligatoire") + ((x.pieces || []).length ? "<div class='info'>Déjà joint : " + x.pieces.length + " pièce(s).</div>" : "") +
        "<label>💸 Paiement du billet</label><select id='cfPay'><option value='payer'" + (x.dejaPaye ? "" : " selected") + ">" + (x.no ? "À payer / payé via Finances" : "À payer → ouvrir Finances après l'enregistrement") + "</option><option value='deja'" + (x.dejaPaye ? " selected" : "") + ">Déjà payé</option></select>" +
        "<div class='info' id='cfPayI'></div>";
    }
    else h += "<div class='ligne'><div><label>Début du cycle (embauche ou dernier retour)</label><input id='cfDu' type='date'></div><div><label>Report de jours (facultatif)</label><input id='cfRe' inputmode='decimal'></div></div>";
    h += "<label>Commentaire</label><input id='cfCm' value='" + esc(x.com || "") + "'><div class='ligne'><button class='bouton' id='cfOk'>✅ Enregistrer</button><button class='bouton second' id='cfX'>Annuler</button></div></div>";
    C.innerHTML = h;
    if ($("cfPjPh")) lierFichiers("cfPj");
    function v(id) { return $(id) ? $(id).value.trim() : ""; }
    function vu(id, ok) { if ($(id)) $(id).style.display = ok ? "" : "none"; }
    function ville(id) { return v(id) === "__autre" ? v(id + "A") : v(id); }
    // Retour = inverse de l'aller : vers Conakry → ville d'origine (modifiable, Tunis par défaut) ; ailleurs → Conakry (imposé).
    function majVilles() {
      var ak = /^conakry$/i.test(ville("cfAv"));
      if (!ak) $("cfRv").value = "Conakry";
      else if (/^conakry$/i.test(v("cfRv"))) $("cfRv").value = "Tunis";
      $("cfRv").disabled = !ak;
      vu("cfAvA", v("cfAv") === "__autre"); vu("cfRvA", ak && v("cfRv") === "__autre");
    }
    if ($("cfPay")) { var majPay = function () { $("cfPayI").textContent = v("cfPay") === "deja" ? "Billet marqué « déjà payé » : aucune demande Finances (le bouton 💸 reste disponible sur la fiche pour un complément)." : x.no ? "" : "La demande Finances › Paiement RH (prise en charge) s'ouvrira pour saisir le prix et le paiement."; }; $("cfPay").onchange = majPay; majPay(); }
    if ($("cfAv")) { $("cfAv").onchange = majVilles; $("cfRv").onchange = majVilles; $("cfAvA").oninput = majVilles; majVilles(); }
    function maj() {
      var p = v("cfP"), so = s[p] || {};
      $("cfS").textContent = so.debut ? "Solde actuel : " + (Math.round(so.solde * 10) / 10) + " j (acquis " + (Math.round(so.acquis * 10) / 10) + ", pris " + so.pris + ", cycle depuis le " + jourFr(so.debut) + ")" : "Début du cycle non renseigné (⚙️ Droits).";
      if ($("cfJ") && v("cfDu") && v("cfAu")) { var n = Math.round((new Date(v("cfAu")) - new Date(v("cfDu"))) / 86400000) + 1; $("cfJ").textContent = n > 0 ? n + " jour(s) calendaires" + (so.debut && n > so.solde ? " · ⚠️ dépasse le solde" : "") : "⛔ dates incohérentes"; }
      if ($("cfV") && (v("cfDu") || v("cfEm"))) { var fvF = cbFinValidite(new Date(v("cfDu") || v("cfEm")).getTime(), R.cb && R.cb.validite);
        $("cfV").textContent = "Valide jusqu'au " + jourFr(fvF) + " (" + ((R.cb && R.cb.validite) || 11) + " mois après le départ, indicatif)" + (v("cfAu") && new Date(v("cfAu")).getTime() > fvF ? " · ⚠️ retour après cette date : vérifiez sur le billet" : ""); }
    }
    ["cfP", "cfDu", "cfAu", "cfEm"].forEach(function (id) { if ($(id)) $(id).onchange = maj; }); maj();
    $("cfX").onclick = function () { CBV.form = ""; afficherRH(); };
    $("cfOk").onclick = function () {
      var d = { personnel: v("cfP"), du: v("cfDu"), au: v("cfAu"), commentaire: v("cfCm") };
      if (x.no) d.no = x.no;
      if (t === "Billet") {
        d.compagnie = v("cfCo"); d.billet = v("cfNb"); d.emis = v("cfEm"); d.allerVers = ville("cfAv"); d.retourVers = ville("cfRv"); d.fichiers = FICH.cfPj || []; d.dejaPaye = v("cfPay") === "deja";
        if (!d.allerVers) { alert("⛔ Indiquez la ville de l'aller."); return; }
        if (!d.du) { alert("⛔ Indiquez la date de départ."); return; }
        if (!d.fichiers.length && !(x.pieces || []).length) { alert("⛔ Joignez le billet (photo ou PDF)."); return; }
      }
      if (t === "Droit") { d.debut = v("cfDu"); d.report = v("cfRe"); }
      CBV.form = "";
      envoyerRH(t === "Congé" ? "cbConge" : t === "Billet" ? "cbBillet" : "cbDroit", d, (t === "Droit" ? "Droits " : t + " ") + d.personnel,
        t === "Billet" && !x.no && !d.dejaPaye ? function (r) { if (r.ok && r.no) payerBillet({ no: r.no, personnel: d.personnel, compagnie: d.compagnie, billet: d.billet, du: cbDate(d.du), allerVers: d.allerVers }); else afficherRH(); } : null);
    };
  }
  function cbDate(s) { var m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0; }
  // 💸 Billet → Finances › Paiement RH, motif prise en charge non médicale ; « [CB-…] » dans l'objet relie le paiement au billet.
  function payerBillet(x) {
    var ouvrir = function () {
      formulaireFin({ type: "Paiement RH", personnel: x.personnel, motifRH: "PRISE EN CHARGE NON MEDICALE (RH)",
        objet: "Billet d'avion" + (x.compagnie ? " " + x.compagnie : "") + (x.billet ? " n° " + x.billet : "") + " — " + x.personnel + (x.allerVers ? " vers " + x.allerVers : "") + (x.du ? " (départ " + jourFr(x.du) + ")" : "") + " [" + x.no + "]" });
    };
    if (S.fin) { ouvrir(); return; }
    rafraichirFin().then(function () { if (S.fin) ouvrir(); else afficherRH(); }, function () { alert("⛔ Finances indisponible (réseau) : le paiement se fera depuis la fiche du billet."); afficherRH(); });
  }
  function cbPayLib(x) {
    var P = x.pay || []; if (!P.length) return x.dejaPaye ? "<span style='color:#2e7d32'>✅ déjà payé</span>" : "<span style='color:#c62828'>non payé</span>";
    return (x.dejaPaye ? "<span style='color:#2e7d32'>✅ déjà payé</span><br>" : "") + P.map(function (p) { return "💸 " + esc(p.no) + " · " + esc(p.statut) + (p.montant ? " · " + gnf(p.montant) + " " + esc(p.devise) : ""); }).join("<br>");
  }
  function ficheCB(C, R, x) {
    if (!x) { CBV.fiche = ""; afficherRH(); return; }
    var dg = R.role === "DG", auj = misAuj(), fv = x.type === "Billet" && (x.du || x.emis) ? cbFinValidite(x.du || x.emis, R.cb.validite) : 0;
    function l(a, b) { return b ? "<tr><td>" + a + "</td><td class='v' style='white-space:normal'>" + b + "</td></tr>" : ""; }
    var h = "<div class='carte pleine'><div class='ligne' style='justify-content:space-between'><h3>" + (x.type === "Congé" ? "🏖️ " : "✈️ ") + esc(x.no) + " · " + esc(x.personnel) + "</h3><button class='bouton second' id='cbF' style='width:auto;flex:0 0 auto'>✕</button></div>" +
      "<div style='font-weight:700;color:" + (x.statut === "Validé" ? "#2e7d32" : x.statut === "En attente DG" ? "#e65100" : "#c62828") + "'>" + esc(x.statut) + "</div><table>" +
      (x.type === "Congé" ? l("Du", jourFr(x.du)) + l("Au", jourFr(x.au)) + l("Jours", x.jours + " j calendaires")
        : l("Compagnie", esc(x.compagnie)) + l("N° billet", esc(x.billet)) + l("Émis le", jourFr(x.emis)) + l("✈️ Aller", (x.allerVers ? esc(x.allerVers) + " · " : "") + jourFr(x.du)) + l("↩️ Retour", (x.retourVers ? esc(x.retourVers) + " · " : "") + (x.au ? jourFr(x.au) : "ouvert")) +
          l("Validité", jourFr(fv) + (fv < auj ? " · ⛔ expiré" : "")) + l("Prix", x.prix ? gnf(x.prix) + " " + esc(x.devise) : "") + l("Paiement", cbPayLib(x))) +
      l("Commentaire", esc(x.com)) + l("Saisi", esc(x.par) + " · " + dateCourte(x.saisi)) + "</table>" +
      "<div class='info'>" + x.historique.map(function (k) { return dateCourte(k.q) + " · " + esc(k.a) + " · " + esc(k.act) + (k.c ? " — " + esc(k.c) : ""); }).join("<br>") + "</div></div>" +
      ((x.pieces || []).length ? htmlPieces(x, x.pieces, "🎫 Billet", "b") : "") + "<div class='carte pleine' id='cbAct'></div>";
    C.innerHTML = h;
    var A = "";
    if (x.statut === "En attente DG" && dg) A += "<h3>Décision</h3><input id='cbCm' placeholder='Motif (obligatoire pour refuser)'><div class='ligne'><button class='bouton' id='cbV' style='background:var(--vert)'>✅ Valider</button><button class='bouton alerte' id='cbR'>⛔ Refuser</button></div>";
    if (x.type === "Billet" && x.statut === "Validé") A += "<h3>↩️ Modifier le retour</h3><div class='ligne'><div><label>Nouvelle date de retour</label><input id='cbNr' type='date' value='" + cbIso(x.au) + "'></div><div style='flex:2'><label>Raison</label><input id='cbNc' placeholder='ex. travaux SGG en cours'></div></div>" + champFichiers("cbNf").replace("Photos / PDF", "🎫 Billet modifié (photo ou PDF) — obligatoire") + "<button class='bouton' id='cbNo'>↩️ Enregistrer le nouveau retour</button>" +
      (R.finances && (!(x.pay || []).length || x.dejaPaye) ? "<button class='bouton second' id='cbPay'>💸 Demande Finances (paiement du billet)</button>" : "");
    if (["En attente DG", "Validé"].indexOf(x.statut) >= 0) A += "<div class='ligne' style='margin-top:8px'><button class='bouton second' id='cbE'>✏️ Modifier</button>" + (x.statut !== "Validé" || dg ? "<button class='bouton second' id='cbA'>🗑️ Annuler</button>" : "") + "</div>";
    $("cbAct").innerHTML = A || "<div class='info'>Aucune action.</div>";
    $("cbF").onclick = function () { CBV.fiche = ""; afficherRH(); };
    var fini = function () { CBV.fiche = x.no; };
    if ($("cbV")) $("cbV").onclick = function () { envoyerRH("cbDecider", { no: x.no, version: x.version, decision: "valider", commentaire: $("cbCm").value }, "Validation " + x.no); };
    if ($("cbR")) $("cbR").onclick = function () { if (!$("cbCm").value.trim()) { alert("⛔ Motif."); return; } envoyerRH("cbDecider", { no: x.no, version: x.version, decision: "refuser", commentaire: $("cbCm").value }, "Refus " + x.no); };
    if ($("cbNfPh")) lierFichiers("cbNf");
    Array.prototype.forEach.call(C.querySelectorAll("[data-p^='b']"), function (b) { b.onclick = function () { voirPiece(x.no, x.pieces[+b.getAttribute("data-p").substring(1)], $("pvb"), "cbPiece"); }; });
    if ($("cbNo")) $("cbNo").onclick = function () { if (!$("cbNr").value) return; if (!(FICH.cbNf || []).length) { alert("⛔ Joignez le billet modifié (photo ou PDF)."); return; }
      envoyerRH("cbRetour", { no: x.no, version: x.version, au: $("cbNr").value, commentaire: $("cbNc").value, fichiers: FICH.cbNf }, "Retour " + x.no); };
    if ($("cbA")) $("cbA").onclick = function () { var m = prompt("Annuler " + x.no + " : motif ?"); if (m === null) return; CBV.fiche = ""; envoyerRH("cbAnnuler", { no: x.no, version: x.version, commentaire: m }, "Annulation " + x.no); };
    if ($("cbE")) $("cbE").onclick = function () { CBV.fiche = ""; CBV.form = x.type; CBV.edit = x; afficherRH(); };
    if ($("cbPay")) $("cbPay").onclick = function () {
      payerBillet(x);
    };
  }


  /* ---------- 🔧 Prestataires (ex. Ahmed, réparateur) : missions, rapports, comptes de fin de mission, paiements ---------- */
  var PRV = { fiche: "", form: "", prest: "" };
  function pmSolde(m) { return m.statut === "Clôturée" ? Math.round(((m.total || 0) - (m.paye || 0) - (m.enCours || 0)) * 100) / 100 : 0; }
  function prOuvReste(p) { return Math.round(((p.ouverture || 0) - (p.ouvPaye || 0) - (p.ouvEnCours || 0)) * 100) / 100; }
  function tnd(v) { return (+v || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " TND"; }
  function pmAlertes(R) {
    var P = (R.pr || {}).missions || [], auj = misAuj(), A = [];
    ((R.pr || {}).prestataires || []).forEach(function (p) { if (prOuvReste(p) > 0.5) A.push({ niv: 1, t: "💸 " + p.nom + " : solde d'ouverture " + tnd(prOuvReste(p)) + " à payer", no: "PR:" + p.nom, et: "Missions à payer" }); });
    P.forEach(function (m) {
      if (m.statut === "Planifiée") {
        var j = Math.round((cbJ(m.du) - auj) / 86400000), jf = Math.round((cbJ(m.au) - auj) / 86400000);
        if (jf <= 0) A.push({ niv: 1, t: "🔧 " + m.prestataire + " : mission " + (jf < 0 ? "terminée le " + jourFr(m.au) : "dernier jour aujourd'hui") + " — rapport et comptes", no: m.no, et: "Missions à clôturer" });
        else if (j >= 0 && j <= 7) A.push({ niv: 2, t: "🔧 Mission de " + m.prestataire + " — " + (j === 0 ? "arrivée aujourd'hui" : "dans " + j + " j") + " (" + jourFr(m.du) + ")", no: m.no, et: "Missions proches" });
      } else if (pmSolde(m) > 0.5) A.push({ niv: 1, t: "💸 " + m.prestataire + " : " + tnd(pmSolde(m)) + " à payer (" + m.no + ")", no: m.no, et: "Missions à payer" });
    });
    return A;
  }
  function vuePrestataires(C, R) {
    var PR = R.pr || { prestataires: [], missions: [] }, dir = !!R.direction;
    if (PRV.form === "prest") { formPrest(C, R); return; }
    if (PRV.form === "plan") { formPlanMission(C, R); return; }
    var mF = PRV.fiche ? PR.missions.filter(function (m) { return m.no === PRV.fiche; })[0] : null;
    if (PRV.form === "clot" && mF) { formClotMission(C, R, mF); return; }
    if (PRV.form === "pay" && mF) { formPayMission(C, R, mF); return; }
    var pF = PR.prestataires.filter(function (p) { return p.nom === PRV.prest; })[0];
    if (PRV.form === "payOuv" && pF) { formPayMission(C, R, { ouv: true, no: "PR:" + pF.nom, prestataire: pF.nom, sol: prOuvReste(pF) }); return; }
    if (PRV.form === "releve" && pF) { relevePrest(C, R, pF); return; }
    if (mF) { ficheMissionPr(C, R, mF); return; }
    var A = pmAlertes(R);
    var h = (A.length ? "<div class='carte pleine' style='border-color:var(--cuivre)'><h3>⚠️ À faire (" + A.length + ")</h3>" + A.map(function (a) {
      return "<div data-pm='" + esc(a.no) + "' style='cursor:pointer;padding:6px 0;border-top:1px solid var(--bord);color:" + (a.niv === 1 ? "#e65100" : "inherit") + "'>" + esc(a.t) + "</div>"; }).join("") + "</div>" : "");
    h += PR.prestataires.map(function (p) {
      var M = PR.missions.filter(function (m) { return m.prestataire === p.nom; }).sort(function (a, b) { return b.du - a.du; });
      var proch = M.filter(function (m) { return m.statut === "Planifiée"; }).sort(function (a, b) { return a.du - b.du; })[0], du = M.reduce(function (t, m) { return t + Math.max(0, pmSolde(m)); }, 0) + Math.max(0, prOuvReste(p));
      return "<div class='carte pleine'><div class='ligne' style='justify-content:space-between'><h3 style='margin:0'>🔧 " + esc(p.nom) + "</h3>" + (du > 0.5 ? "<b style='flex:0;white-space:nowrap;color:#c62828'>dû " + tnd(du) + "</b>" : "<b style='flex:0;white-space:nowrap;color:#2e7d32'>à jour</b>") + "</div>" +
        "<div class='info'>" + esc(p.metier) + " · " + tnd(p.honoraire) + " par mission · caisse " + tnd(p.caisse) + " · " + p.duree + " j tous les " + p.periode + " j · bénéficiaire " + esc(p.societe) + (p.actif ? "" : " · inactif") + "</div>" +
        (p.ouverture ? "<div class='info'>Solde d'ouverture : " + tnd(p.ouverture) + (p.ouvPaye ? " · payé " + tnd(p.ouvPaye) : "") + (p.ouvEnCours ? " · en paiement " + tnd(p.ouvEnCours) : "") + "</div>" : "") +
        (p.caisseRemise !== null && p.caisseRemise !== undefined ? "<div class='info'>💼 Caisse en sa possession (avance) : <b>" + tnd(p.caisseRemise) + "</b></div>" : "") +
        "<div class='info'>" + (proch ? "Prochaine mission : <b>" + jourFr(proch.du) + " → " + jourFr(proch.au) + "</b> (" + esc(proch.no) + ")" : "Aucune mission planifiée.") + "</div>" +
        "<div class='ligne' style='flex-wrap:wrap;gap:6px'><button class='bouton' data-pp='" + esc(p.nom) + "' style='width:auto;flex:0 0 auto'>➕ Planifier une mission</button>" +
          "<button class='bouton second' data-prl='" + esc(p.nom) + "' style='width:auto;flex:0 0 auto'>📄 Relevé</button>" +
          (prOuvReste(p) > 0.5 ? "<button class='bouton second' data-pou='" + esc(p.nom) + "' style='width:auto;flex:0 0 auto'>💸 Payer le solde d'ouverture</button>" : "") +
          (dir ? "<button class='bouton second' data-pf='" + esc(p.nom) + "' style='width:auto;flex:0 0 auto'>✏️ Fiche</button>" : "") + "</div>" +
        (M.length ? "<table style='width:100%;font-size:13px;margin-top:8px'><tr style='color:#888;text-align:left'><th>Mission</th><th>Dates</th><th>Statut</th><th style='text-align:right'>Total</th><th style='text-align:right'>Reste</th></tr>" + M.slice(0, 30).map(function (m) {
          return "<tr data-pm='" + esc(m.no) + "' style='cursor:pointer;border-top:1px solid var(--bord)" + (m.statut === "Annulée" ? ";opacity:.5" : "") + "'><td>" + esc(m.no) + "</td><td>" + jourFr(m.du) + " → " + jourFr(m.au) + "</td><td>" + esc(m.statut) + "</td><td style='text-align:right'>" + (m.total ? tnd(m.total) : "") +
            "</td><td style='text-align:right'>" + (m.statut === "Clôturée" ? (pmSolde(m) > 0.5 ? "<b style='color:#c62828'>" + tnd(pmSolde(m)) + "</b>" : m.enCours ? "en paiement" : "✅") : "") + "</td></tr>"; }).join("") + "</table>" : "") + "</div>";
    }).join("");
    if (dir) h += "<button class='bouton second' id='prNv'>➕ Nouveau prestataire</button>";
    C.innerHTML = h || "<p class='info'>Aucun prestataire.</p>";
    Array.prototype.forEach.call(C.querySelectorAll("[data-pm]"), function (el) { el.onclick = function () { var k = el.getAttribute("data-pm");
      if (/^PR:/.test(k)) { PRV.prest = k.substring(3); PRV.form = "payOuv"; } else PRV.fiche = k; afficherRH(); window.scrollTo(0, 0); }; });
    Array.prototype.forEach.call(C.querySelectorAll("[data-prl]"), function (el) { el.onclick = function () { PRV.prest = el.getAttribute("data-prl"); PRV.form = "releve"; afficherRH(); window.scrollTo(0, 0); }; });
    Array.prototype.forEach.call(C.querySelectorAll("[data-pou]"), function (el) { el.onclick = function () { PRV.prest = el.getAttribute("data-pou"); PRV.form = "payOuv"; afficherRH(); }; });
    Array.prototype.forEach.call(C.querySelectorAll("[data-pp]"), function (el) { el.onclick = function () { PRV.prest = el.getAttribute("data-pp"); PRV.form = "plan"; afficherRH(); }; });
    Array.prototype.forEach.call(C.querySelectorAll("[data-pf]"), function (el) { el.onclick = function () { PRV.prest = el.getAttribute("data-pf"); PRV.form = "prest"; afficherRH(); }; });
    if ($("prNv")) $("prNv").onclick = function () { PRV.prest = ""; PRV.form = "prest"; afficherRH(); };
  }
  function relevePrest(C, R, p) {
    var L = p.releve || [];
    C.innerHTML = "<div class='carte pleine'><div class='ligne' style='justify-content:space-between'><h3 style='margin:0'>📄 Relevé · " + esc(p.nom) + "</h3><button class='bouton second' id='rlX' style='width:auto;flex:0 0 auto'>✕</button></div>" +
      "<table style='width:100%;font-size:13px;margin-top:8px'><tr style='color:#888;text-align:left'><th>Date</th><th>Libellé</th><th style='text-align:right'>Dû</th><th style='text-align:right'>Payé</th><th style='text-align:right'>Solde</th></tr>" +
      L.map(function (l) { return "<tr style='border-top:1px solid var(--bord)'><td style='white-space:nowrap'>" + (l.d ? jourFr(l.d) : "") + "</td><td>" + esc(l.lib) + "</td><td style='text-align:right'>" + (l.du ? tnd(l.du) : "") + "</td><td style='text-align:right'>" + (l.paye ? tnd(l.paye) : "") +
        "</td><td style='text-align:right'><b>" + tnd(l.solde) + "</b></td></tr>"; }).join("") + "</table>" +
      "<table style='margin-top:10px'><tr><td>Reste dû</td><td class='v'><b style='color:" + ((p.solde || 0) > 0.5 ? "#c62828" : "#2e7d32") + "'>" + tnd(p.solde || 0) + "</b></td></tr>" +
      (p.enCours ? "<tr><td>Paiements en cours de validation</td><td class='v'>" + tnd(p.enCours) + "</td></tr>" : "") +
      (p.caisseRemise !== null && p.caisseRemise !== undefined ? "<tr><td>💼 Caisse en sa possession (avance)</td><td class='v'>" + tnd(p.caisseRemise) + "</td></tr>" : "") + "</table>" +
      "<div class='ligne' style='margin-top:10px'><button class='bouton' id='rlPdf'>📄 PDF</button><button class='bouton second' id='rlPart'>📤 Partager</button></div>" +
      "<div class='info'>Seuls les paiements exécutés (clôturés dans Finances) comptent ; ceux en cours sont indiqués à part.</div></div>";
    $("rlX").onclick = prRetour("");
    function pdf(partager) {
      api({ api: "prReleve", nom: p.nom }, 120000).then(function (r) {
        var b = base64Blob(r.pdf), f = new File([b], r.nom, { type: "application/pdf" });
        if (partager && navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: r.nom }).catch(function () {}); return; }
        var u = URL.createObjectURL(b), w = window.open(u, "_blank"); if (!w) { var a = document.createElement("a"); a.href = u; a.download = r.nom; document.body.appendChild(a); a.click(); a.remove(); }
      }, function (e) { alert("⛔ PDF : " + e.message + " (réseau nécessaire)"); });
    }
    $("rlPdf").onclick = function () { pdf(false); }; $("rlPart").onclick = function () { pdf(true); };
  }
  function prRetour(fiche) { return function () { PRV.form = ""; PRV.fiche = fiche || ""; afficherRH(); }; }
  function formPrest(C, R) {
    var p = ((R.pr || {}).prestataires || []).filter(function (x) { return x.nom === PRV.prest; })[0] || { devise: "TND", honoraire: 0, caisse: 0, periode: 60, duree: 10, societe: "M2S", actif: true };
    C.innerHTML = "<div class='carte pleine'><h3>🔧 " + (p.nom ? "Fiche " + esc(p.nom) : "Nouveau prestataire") + "</h3>" +
      "<div class='ligne'><div style='flex:2'><label>Nom (distinct du personnel)</label><input id='pfN' value='" + esc(p.nom || "") + "'></div><div style='flex:2'><label>Métier</label><input id='pfM' value='" + esc(p.metier || "") + "'></div></div>" +
      "<div class='ligne'><div><label>Honoraire par mission (TND)</label><input id='pfH' inputmode='decimal' value='" + (p.honoraire || "") + "'></div><div><label>Caisse fixe (TND)</label><input id='pfC' inputmode='decimal' value='" + (p.caisse || "") + "'></div></div>" +
      "<div class='ligne'><div><label>Durée d'une mission (jours, vol compris)</label><input id='pfD' inputmode='numeric' value='" + p.duree + "'></div><div><label>Une mission tous les (jours)</label><input id='pfP' inputmode='numeric' value='" + p.periode + "'></div></div>" +
      "<div class='ligne'><div><label>Société bénéficiaire</label><select id='pfS'>" + ["M2S", "AB", "CASAFINO"].map(function (x) { return "<option" + (x === p.societe ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" +
      "<div><label>Actif</label><select id='pfA'><option value='oui'>Oui</option><option value='non'" + (p.actif ? "" : " selected") + ">Non</option></select></div></div>" +
      "<div class='carte' style='margin-top:8px'><b>Situation de départ (reprise)</b><div class='ligne'><div><label>Solde d'ouverture dû (TND)</label><input id='pfO' inputmode='decimal' value='" + (p.ouverture || "") + "' placeholder='ex. 4000'></div>" +
      "<div><label>Au</label><input id='pfOd' type='date' value='" + (p.ouvertureLe ? cbIso(p.ouvertureLe) : cbIso(Date.now())) + "'></div></div>" +
      "<label>Caisse en sa possession (TND, avance de la société)</label><input id='pfCr' inputmode='decimal' value='" + (p.caisseRemise !== null && p.caisseRemise !== undefined ? p.caisseRemise : "") + "' placeholder='ex. 2000'>" +
      "<div class='info'>Le solde d'ouverture est ce qui lui est dû avant DuoCore (payable avec 💸). La caisse est l'argent de la société qu'il détient pour les pièces.</div></div>" +
      "<label>Commentaire</label><input id='pfCm' value='" + esc(p.com || "") + "'><div class='ligne'><button class='bouton' id='pfOk'>✅ Enregistrer</button><button class='bouton second' id='pfX'>Annuler</button></div></div>";
    $("pfX").onclick = prRetour("");
    $("pfOk").onclick = function () {
      var d = { ancien: p.nom || "", nom: $("pfN").value.trim(), metier: $("pfM").value.trim(), devise: "TND", honoraire: nbCom($("pfH").value), caisse: nbCom($("pfC").value), duree: nbCom($("pfD").value) || 10, periode: nbCom($("pfP").value) || 60,
        societe: $("pfS").value, actif: $("pfA").value === "oui", commentaire: $("pfCm").value.trim(),
        ouverture: nbCom($("pfO").value), ouvertureLe: $("pfOd").value, caisseRemise: $("pfCr").value.trim() === "" ? "" : nbCom($("pfCr").value) };
      if (!d.nom) { alert("⛔ Nom."); return; }
      PRV.form = ""; envoyerRH("pmPrest", d, "Prestataire " + d.nom);
    };
  }
  function formPlanMission(C, R) {
    var PR = (R.pr || {}).prestataires || [], p = PR.filter(function (x) { return x.nom === PRV.prest; })[0] || PR[0];
    if (!p) { PRV.form = ""; afficherRH(); return; }
    var der = ((R.pr || {}).missions || []).filter(function (m) { return m.prestataire === p.nom && m.statut !== "Annulée"; }).sort(function (a, b) { return b.du - a.du; })[0];
    var du0 = der ? der.du + p.periode * 86400000 : Date.now();
    C.innerHTML = "<div class='carte pleine'><h3>➕ Mission de " + esc(p.nom) + "</h3><div class='ligne'><div><label>Arrivée à Conakry (jour du vol)</label><input id='plD' type='date' value='" + cbIso(du0) + "'></div>" +
      "<div><label>Départ</label><input id='plA' type='date'></div></div><div class='info' id='plI'></div><label>Commentaire</label><input id='plC'>" +
      "<div class='ligne'><button class='bouton' id='plOk'>✅ Planifier</button><button class='bouton second' id='plX'>Annuler</button></div><div class='info'>Le billet d'avion se saisit dans 🏖️ Congés & billets (" + esc(p.nom) + " figure dans la liste).</div></div>";
    function maj() { var d = $("plD").value; if (d && !$("plA").dataset.m) $("plA").value = cbIso(new Date(d + "T12:00:00").getTime() + (p.duree - 1) * 86400000); $("plI").textContent = p.duree + " jours, vol compris."; }
    $("plD").onchange = maj; $("plA").onchange = function () { $("plA").dataset.m = "1"; }; maj();
    $("plX").onclick = prRetour("");
    $("plOk").onclick = function () { if (!$("plD").value) return; PRV.form = ""; envoyerRH("pmPlanifier", { prestataire: p.nom, du: $("plD").value, au: $("plA").value, commentaire: $("plC").value.trim() }, "Mission " + p.nom); };
  }
  function ficheMissionPr(C, R, m) {
    var dir = !!R.direction, sol = pmSolde(m);
    function l(a, b) { return b ? "<tr><td>" + a + "</td><td class='v' style='white-space:normal'>" + b + "</td></tr>" : ""; }
    var h = "<div class='carte pleine'><div class='ligne' style='justify-content:space-between'><h3>🔧 " + esc(m.no) + " · " + esc(m.prestataire) + "</h3><button class='bouton second' id='pmF' style='width:auto;flex:0 0 auto'>✕</button></div>" +
      "<div style='font-weight:700'>" + esc(m.statut) + "</div><table>" + l("Arrivée", jourFr(m.du)) + l("Départ", jourFr(m.au)) +
      (m.statut === "Clôturée" ? l("Honoraire", tnd(m.honoraire)) + l("Dépenses de caisse", tnd(m.depenses)) + l("Total dû", "<b>" + tnd(m.total) + "</b>") +
        l("Payé", tnd(m.paye)) + (m.enCours ? l("En cours de paiement", tnd(m.enCours)) : "") + l("Reste", sol > 0.5 ? "<b style='color:#c62828'>" + tnd(sol) + "</b>" : "✅ soldé") : "") +
      l("Paiements", (m.pay || []).map(function (p) { return "💸 " + esc(p.no) + " · " + esc(p.statut) + " · " + tnd(p.tnd) + " (" + gnf(p.montant) + " " + esc(p.devise) + ")"; }).join("<br>")) +
      l("Travaux réalisés", esc(m.travaux).replace(/\n/g, "<br>")) + l("Programme suivant", esc(m.programme).replace(/\n/g, "<br>")) + l("Prochaine mission", m.prochaine ? jourFr(m.prochaine) : "") + "</table>" +
      "<div class='info'>" + m.historique.map(function (k) { return dateCourte(k.q) + " · " + esc(k.a) + " · " + esc(k.act) + (k.c ? " — " + esc(k.c) : ""); }).join("<br>") + "</div></div>" +
      ((m.pieces || []).length ? htmlPieces(m, m.pieces, "📄 Rapport", "r") : "") + "<div class='carte pleine'>";
    if (m.statut === "Planifiée") h += "<button class='bouton' id='pmC'>📝 Clôturer : rapport et comptes</button><div class='ligne'><div><label>Arrivée</label><input id='pmD' type='date' value='" + cbIso(m.du) + "'></div><div><label>Départ</label><input id='pmA' type='date' value='" + cbIso(m.au) + "'></div></div>" +
      "<div class='ligne'><button class='bouton second' id='pmM'>✏️ Modifier les dates</button><button class='bouton second' id='pmX'>🗑️ Annuler la mission</button></div>";
    if (m.statut === "Clôturée" && sol > 0.5 && R.finances !== false) h += "<button class='bouton' id='pmP'>💸 Préparer le paiement (" + tnd(sol) + ")</button>";
    if (m.statut === "Clôturée" && dir) h += "<button class='bouton second' id='pmX'>🗑️ Annuler la mission</button>";
    C.innerHTML = h + "</div>";
    $("pmF").onclick = prRetour("");
    Array.prototype.forEach.call(C.querySelectorAll("[data-p^='r']"), function (b) { b.onclick = function () { voirPiece(m.no, m.pieces[+b.getAttribute("data-p").substring(1)], $("pvr"), "pmPiece"); }; });
    if ($("pmC")) $("pmC").onclick = function () { PRV.form = "clot"; afficherRH(); };
    if ($("pmP")) $("pmP").onclick = function () { PRV.form = "pay"; afficherRH(); };
    if ($("pmM")) $("pmM").onclick = function () { envoyerRH("pmModifier", { no: m.no, version: m.version, du: $("pmD").value, au: $("pmA").value }, "Dates " + m.no, prRetour(m.no)); };
    if ($("pmX")) $("pmX").onclick = function () { var c = prompt("Annuler " + m.no + " : motif ?"); if (c === null) return; envoyerRH("pmAnnuler", { no: m.no, version: m.version, commentaire: c }, "Annulation " + m.no, prRetour("")); };
  }
  function formClotMission(C, R, m) {
    var p = ((R.pr || {}).prestataires || []).filter(function (x) { return x.nom === m.prestataire; })[0] || { honoraire: m.honoraire, caisse: 0, periode: 60 };
    C.innerHTML = "<div class='carte pleine'><h3>📝 Fin de mission " + esc(m.no) + " · " + esc(m.prestataire) + "</h3>" +
      "<div class='ligne'><div><label>Arrivée</label><input id='fcD' type='date' value='" + cbIso(m.du) + "'></div><div><label>Départ</label><input id='fcA' type='date' value='" + cbIso(m.au) + "'></div></div>" +
      "<label>Travaux réalisés (rapport)</label><textarea id='fcT' rows='5'></textarea><label>Programme de la prochaine mission</label><textarea id='fcP' rows='3'></textarea>" +
      "<label>Date de la prochaine mission (arrivée)</label><input id='fcN' type='date' value='" + cbIso(m.du + (p.periode || 60) * 86400000) + "'>" +
      "<div class='ligne'><div><label>Honoraire (TND)</label><input id='fcH' inputmode='decimal' value='" + (m.honoraire || p.honoraire) + "'></div><div><label>Dépenses de la caisse (TND, montant global)</label><input id='fcE' inputmode='decimal' placeholder='0'></div></div>" +
      "<div class='carte' id='fcR' style='margin-top:8px'></div>" + champFichiers("fcF").replace("Photos / PDF", "📄 Rapport signé, reçus (photo ou PDF, facultatif)") +
      "<div class='ligne'><button class='bouton' id='fcOk'>✅ Clôturer la mission</button><button class='bouton second' id='fcX'>Annuler</button></div></div>";
    lierFichiers("fcF");
    function maj() { var h = nbCom($("fcH").value), e = nbCom($("fcE").value);
      $("fcR").innerHTML = "À payer : honoraire " + tnd(h) + " + dépenses " + tnd(e) + " = <b>" + tnd(h + e) + "</b><br><small>La caisse revient à " + tnd(p.caisse) + " (les dépenses sont remboursées). Ex. 2 500 dépensés → 2 500 remboursés.</small>"; }
    $("fcH").oninput = maj; $("fcE").oninput = maj; maj();
    $("fcX").onclick = prRetour(m.no);
    $("fcOk").onclick = function () {
      if (!$("fcT").value.trim()) { alert("⛔ Indiquez les travaux réalisés."); return; }
      var tot = nbCom($("fcH").value) + nbCom($("fcE").value);
      if (!confirm("Clôturer " + m.no + " : " + tnd(tot) + " à payer ?" + ($("fcN").value ? "\nLa prochaine mission sera planifiée à partir du " + $("fcN").value.split("-").reverse().join("/") + "." : ""))) return;
      envoyerRH("pmCloturer", { no: m.no, version: m.version, du: $("fcD").value, au: $("fcA").value, travaux: $("fcT").value, programme: $("fcP").value, prochaine: $("fcN").value,
        honoraire: $("fcH").value, depenses: $("fcE").value || "0", fichiers: FICH.fcF || [] }, "Fin de mission " + m.no, function (r) {
        PRV.form = ""; PRV.fiche = m.no; afficherRH();
        if (r && r.ok && !r.enAttente && confirm("Préparer le paiement maintenant ?")) { PRV.form = "pay"; afficherRH(); }
      });
    };
  }
  function formPayMission(C, R, m) {
    var sol = m.ouv ? m.sol : pmSolde(m);
    C.innerHTML = "<div class='carte pleine'><h3>💸 Paiement " + (m.ouv ? "du solde d'ouverture" : esc(m.no)) + " · " + esc(m.prestataire) + "</h3>" +
      "<label>Montant à régler (TND)</label><input id='fpT' inputmode='decimal' value='" + sol + "'>" +
      "<div class='ligne'><div><label>Payé en</label><select id='fpDv'><option>USD</option><option>EURO</option><option>TND</option></select></div><div><label>Taux : 1 <span id='fpDvL'>USD</span> = … TND</label><input id='fpTx' inputmode='decimal'></div></div>" +
      "<label>Mode</label><select id='fpMo'><option value='vir'>Virement (ex. BIAT DG USD → compte tiers)</option><option value='esp'>Espèces (EUR / USD remis avant le départ)</option></select>" +
      "<div class='carte' id='fpR' style='margin-top:8px'></div><button class='bouton' id='fpOk'>💸 Préparer la demande Finances</button><button class='bouton second' id='fpX'>Annuler</button>" +
      "<div class='info'>La demande suit la validation habituelle (Walid puis DG). Une fois exécutée, le montant en TND est déduit du reste dû de la mission.</div></div>";
    function calc() { var t = nbCom($("fpT").value), dv = $("fpDv").value, tx = dv === "TND" ? 1 : nbCom($("fpTx").value); $("fpDvL").textContent = dv; $("fpTx").disabled = dv === "TND";
      var mt = tx > 0 ? Math.round(t / tx * 100) / 100 : 0; $("fpR").innerHTML = tx > 0 ? tnd(t) + " ÷ " + tx + " = <b>" + mt.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " " + dv + "</b>" : "Indiquez le taux de change."; return { t: t, dv: dv, tx: tx, mt: mt }; }
    ["fpT", "fpTx"].forEach(function (id) { $(id).oninput = calc; }); $("fpDv").onchange = calc; calc();
    $("fpX").onclick = prRetour(m.ouv ? "" : m.no);
    $("fpOk").onclick = function () {
      var k = calc(); if (!(k.t > 0) || !(k.mt > 0)) { alert("⛔ Montant et taux."); return; }
      var objet = (m.ouv ? "Solde d'ouverture (prestation impayée) · " + m.prestataire + (k.t < sol - 0.5 ? " : acompte" : "") : "Mission " + m.no + " · " + m.prestataire + " : " + (k.t >= sol - 0.5 ? "honoraire " + tnd(m.honoraire) + " + caisse " + tnd(m.depenses) : "acompte")) +
        " (taux 1 " + k.dv + " = " + k.tx + " TND) [" + m.no + "|" + k.t + " TND]";
      var ouvrir = function () {
        PRV.form = ""; PRV.fiche = m.ouv ? "" : m.no;
        formulaireFin($("fpMo") && $("fpMo").value === "esp" ? { type: "Dépense de caisse", categorie: "Prestation", objet: objet, montant: k.mt, devise: k.dv }
          : { type: "Mouvement de trésorerie", op: "Virement", categorie: "Prestation", objet: objet, montant: k.mt, devise: k.dv, beneficiaire: m.prestataire });
      };
      if (S.fin) { ouvrir(); return; }
      rafraichirFin().then(function () { if (S.fin) ouvrir(); else alert("⛔ Finances indisponible."); }, function () { alert("⛔ Finances indisponible (réseau)."); });
    };
  }
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
    if (id === "cb") { RHV.onglet = "conges"; CBV.fiche = ""; CBV.form = ""; }
    if (id === "pr" || (id && /^PM-/.test(id))) { RHV.onglet = "prestataires"; PRV.form = ""; PRV.fiche = /^PM-/.test(id || "") ? id : ""; }
    if (id && /^PR:/.test(id)) { RHV.onglet = "prestataires"; PRV.fiche = ""; PRV.prest = id.substring(3); PRV.form = "payOuv"; }
    if (R.prSeul) RHV.onglet = "prestataires";
    var nEv = R.evenements.filter(function (e) { return e.statut === "En attente Walid"; }).length;
    var envoi = S.file.filter(function (x) { return x.type === "rh"; }).length;
    var h = "<div class='carte'><h3>👥 Ressources humaines</h3><div class='info'>" + esc(R.agent) + (R.direction ? " · direction (" + esc(R.role) + ")" : " · responsable RH") + " · données du " + dateCourte(R.recu || R.genere) + "</div>" +
      (R.prSeul ? "" : "<button class='bouton' id='rhEv'>➕ Événement : heures, absence, congé, prélèvement</button>") +
      (R.direction ? "<button class='bouton second' id='rhNouv'>👤 Nouvel agent</button>" : "") +
      "<div class='onglets' style='margin-top:10px'>" + [["personnel", "Personnel"], ["evenements", "Événements" + (nEv ? " (" + nEv + ")" : "")], ["conges", "🏖️ Congés & billets" + (function () { var n = R.cb ? cbAlertes(R).filter(function (a) { return a.niv <= 2; }).length : 0; return n ? " (" + n + ")" : ""; })()], ["paie", "Paie du mois"], ["historique", "Historique"], ["prestataires", "🔧 Prestataires" + (function () { var n = pmAlertes(R).length; return n ? " (" + n + ")" : ""; })()]].filter(function (o) { return !R.prSeul || o[0] === "prestataires"; })
        .map(function (o) { return "<button data-o='" + o[0] + "' class='" + (RHV.onglet === o[0] ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + o[1] + "</button>"; }).join("") + "</div></div>" +
      (envoi ? "<div class='carte att'>⏳ " + envoi + " opération(s) RH sur cet appareil, en attente d'envoi.</div>" : "") +
      "<div id='rhCorps'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-o]"), function (b) { b.onclick = function () { RHV.onglet = b.getAttribute("data-o"); CBV.fiche = ""; CBV.form = ""; PRV.fiche = ""; PRV.form = ""; afficherRH(); }; });
    if ($("rhEv")) $("rhEv").onclick = function () { formulaireEvRH(""); };
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
    } else if (RHV.onglet === "conges") vueCongesRH(C, R);
    else if (RHV.onglet === "prestataires") vuePrestataires(C, R);
    else if (RHV.onglet === "paie") afficherPaieRH(C);
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
    if (["En attente Walid", "À corriger"].indexOf(e.statut) < 0 || rhAttente(e.no).length) return;
    var A = $("rhAct"), auteur = nomRH(e.par) === nomRH(R.agent);
    if (auteur && (e.statut === "À corriger" || !R.direction)) {
      A.innerHTML = "<div class='carte'>" + (e.statut === "À corriger" && e.decision ? "<div style='color:#b26a00;font-weight:700'>↩️ Correction demandée par " + esc(e.decision.a) + " : " + esc(e.decision.c) + "</div>" : "") +
        "<button class='bouton' id='rhMod'>✏️ " + (e.statut === "À corriger" ? "Corriger et renvoyer" : "Modifier") + "</button><button class='bouton second' id='rhAnn'>Annuler cet événement</button></div>";
      $("rhMod").onclick = function () { formulaireEvRH(e.personnel, e); };
      $("rhAnn").onclick = function () { if (confirm("Annuler " + e.no + " ?")) envoyerRH("annuler", { no: e.no, version: e.version }, "Annulation " + e.no, function () { ouvrirEvRH(e.no); }); };
      return;
    }
    if (e.statut !== "En attente Walid") return;
    if (R.direction) {
      A.innerHTML = "<div class='carte'><h3>Votre décision</h3><label>Commentaire (obligatoire pour refuser ou renvoyer)</label><input id='rhCom'>" +
        "<button class='bouton' id='rhVal' style='background:var(--vert)'>✅ Valider (inscrit dans Base)</button><button class='bouton alerte' id='rhCor'>↩️ Retour pour correction</button><button class='bouton' id='rhRef' style='background:var(--rouge)'>⛔ Refuser</button><div id='rhMsg' class='info'></div></div>";
      $("rhCor").onclick = function () {
        var c = $("rhCom").value.trim(); if (!c) { $("rhMsg").textContent = "⛔ Indiquez la correction demandée."; return; }
        envoyerRH("decider", { no: e.no, version: e.version, decision: "corriger", commentaire: c }, "Retour " + e.no, function () { ouvrirEvRH(e.no); });
      };
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

  function formulaireEvRH(nom, ev) {
    var R = S.rh, T = R.types, types = Object.keys(T);
    $("titre").textContent = ev ? "Corriger " + ev.no : "Événement RH";
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
      if (ev) { envoyerRH("modifierEv", { no: ev.no, type: t, quantite: q, effet: dt, commentaire: $("reC").value.trim() }, "Correction " + ev.no, function () { ouvrirEvRH(ev.no); }); return; }
      envoyerRH("evenement", { personnel: p, type: t, quantite: q, effet: dt, commentaire: $("reC").value.trim() }, t + " · " + p, function (r) { if (r.no) ouvrirEvRH(r.no); else ficheRH(p); });
    };
    if (ev) {   // correction : valeurs actuelles, agent non modifiable
      $("reP").value = ev.personnel; $("reP").disabled = true; $("reT").value = ev.type; $("reQ").value = ev.qte; $("reC").value = ev.com || "";
      if (ev.effet) { var de = new Date(ev.effet); $("reD").value = de.getFullYear() + "-" + ("0" + (de.getMonth() + 1)).slice(-2) + "-" + ("0" + de.getDate()).slice(-2); }
      $("reEnv").textContent = "📤 Renvoyer"; maj();
    }
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
    return "<div class='carte" + (att ? " att" : "") + "' data-fa='" + esc(cleFac(f)) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + esc(f.id) + "</b><b style='flex:0;white-space:nowrap'>" + gnf(f.montant) + " " + esc(f.devise) + "</b></div>" +
      "<div class='info'>" + esc(f.client) + " · " + esc(f.projet) + " · du " + jourLib(f.date) + "</div>" +
      "<div style='font-weight:700;font-size:14px;color:" + (f.paye ? "#2e7d32" : ret ? "#c62828" : "#e65100") + "'>" + (f.paye ? "✅ Encaissée le " + jourLib(f.encaisse) : ret ? "⏰ En retard de " + jours(f.echeance) + " j (échéance " + jourLib(f.echeance) + ")" : (f.echeance ? "À encaisser · échéance " + jourLib(f.echeance) : "À encaisser · sans échéance")) +
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
      (K.ecriture ? "<div class='ligne'><button class='bouton' id='cmDv'>📝 Devis</button><button class='bouton' id='cmBL'>📦 BL</button><button class='bouton' id='cmFa'>🧾 Facture</button></div>" +
        "<div class='ligne'><button class='bouton second' id='cmEnc'>💵 Encaissement</button><button class='bouton second' id='cmCt'>📄 Contrat</button><button class='bouton second' id='cmBdc'>🛒 BDC</button></div>" : "") +
      "<div class='onglets' style='margin-top:10px'>" + [["contrats", "Contrats"], ["devis", "Devis"], ["factures", "Factures" + (nR ? " (⏰ " + nR + ")" : "")], ["clients", "Clients"], ["production", "BDC & production"]]
        .map(function (o) { return "<button data-o='" + o[0] + "' class='" + (COMV.onglet === o[0] ? "actif" : "") + "' style='border-radius:10px;border-bottom:1px solid var(--bord)'>" + o[1] + "</button>"; }).join("") + "</div></div>" +
      (envoi ? "<div class='carte att'>⏳ " + envoi + " opération(s) commerciale(s) en attente d'envoi.</div>" : "") + "<div id='cmCorps'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-o]"), function (b) { b.onclick = function () { COMV.onglet = b.getAttribute("data-o"); afficherCom(); }; });
    if ($("cmDv")) $("cmDv").onclick = formulaireDevisCom;
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
    } else if (COMV.onglet === "devis") {
      var DV = (K.devis || []).slice().sort(function (a, b) { return b.date - a.date; });
      C.innerHTML = DV.map(function (x) {
        var exp = x.validite && x.validite < Date.now();
        return "<div class='carte' data-dv='" + esc(x.id) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>📝 " + esc(x.id) + "</b><b style='flex:0;white-space:nowrap'>" + gnf(x.net) + " " + esc(x.devise) + "</b></div>" +
          "<div class='info'>" + esc(x.client) + (x.objet ? " · " + esc(x.objet) : "") + " · " + esc(x.societe) + " · " + esc(x.regime) + "</div>" +
          "<div class='info'>du " + jourLib(x.date) + " · " + (exp ? "<span style='color:#c62828'>expiré le " + jourLib(x.validite) + "</span>" : "valable jusqu'au " + jourLib(x.validite)) + " · " + esc(x.par) + " · 📄 PDF</div></div>";
      }).join("") || "<p class='info' style='padding:0 4px'>Aucun devis.</p>";
      Array.prototype.forEach.call(C.querySelectorAll("[data-dv]"), function (el) { el.onclick = function () { ouvrirPdfCom(el.getAttribute("data-dv")); }; });
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
  // Deux factures peuvent porter le même n° (ex. 02/SGG/ENTETES/2026) : clé = n° + date.
  function cleFac(f) { return f.id + "|" + f.date; }
  function factureCom(cle) {
    var K = S.com, i = String(cle || "").lastIndexOf("|"), id = i > 0 ? cle.substring(0, i) : cle, dt = i > 0 ? +cle.substring(i + 1) : NaN;
    var L = K.factures.filter(function (x) { return x.id === id; });
    if (!isNaN(dt)) { var e = L.filter(function (x) { return x.date === dt; })[0]; if (e) return e; }
    return L.filter(function (x) { return !x.paye; }).sort(function (a, b) { return b.date - a.date; })[0] || L[0];
  }
  function ficheFactureCom(id) {
    var K = S.com, f = factureCom(id);
    if (!f) { afficherCom(); return; }
    $("titre").textContent = f.id;
    var R = K.relances.filter(function (r) { return r.facture === f.id; }).sort(function (a, b) { return b.date - a.date; });
    var h = htmlFacture(f).replace("cursor:pointer", "") + "<div class='carte'><table><tr><td>Contrat</td><td class='v'>" + esc(f.contrat) + "</td></tr><tr><td>Compte</td><td class='v'>" + esc(f.benef) + "</td></tr>" +
      (f.bdc ? "<tr><td>BDC</td><td class='v'>" + esc(f.bdc) + "</td></tr>" : "") + "<tr><td>Saisie</td><td class='v'>" + esc(f.editeur) + "</td></tr></table>" +
      (f.pdf ? "<div class='ligne'><button class='bouton second' id='faPdf'>📄 Ouvrir le PDF</button><button class='bouton second' id='faPart'>📤 Partager</button></div>" : "<div class='info'>Facture saisie avant DuoCore : pas de PDF.</div>") +
      (K.ecriture && !f.paye ? "<button class='bouton' id='faEnc' style='background:var(--vert)'>💵 Encaissée</button><button class='bouton second' id='faRel'>📞 Noter une relance</button>" : "") +
      (!f.paye ? "<div style='margin-top:10px'><label>📅 Échéance de paiement" + (f.echeanceLib ? " (actuelle : " + esc(f.echeanceLib) + ")" : f.echeance ? " (actuelle : délai habituel)" : "") + "</label><div class='ligne'><select id='faEd'>" +
        ["Aucune", "15 jours", "1 mois", "2 mois", "3 mois", "6 mois", "Date"].map(function (x) { return "<option" + (x === (f.echeanceLib || "") ? " selected" : "") + ">" + x + "</option>"; }).join("") +
        "</select><input id='faEdD' type='date' style='display:none' value='" + (f.echeance ? dateISO(f.echeance) : "") + "'><button class='bouton second' id='faEdOk' style='flex:0 0 auto'>Enregistrer</button></div><div class='info'>Durée comptée à partir de la date de la facture (" + jourLib(f.date) + "). « Aucune » : jamais en retard.</div></div>" : "") + "</div>" +
      "<div class='carte'><h3>Relances</h3>" + (R.map(function (r) { return "<div class='info'>" + jourLib(r.date) + " · " + esc(r.agent) + " · <b>" + esc(r.mode) + "</b>" + (r.com ? " — " + esc(r.com) : "") + (r.prochaine ? " · prochaine " + jourLib(r.prochaine) : "") + "</div>"; }).join("") || "<div class='info'>Aucune.</div>") + "</div>" +
      "<button class='bouton second' id='faCt'>Contrat " + esc(f.contrat) + "</button>";
    $("vueListe").innerHTML = h; montrer("vueListe");
    if ($("faPdf")) { $("faPdf").onclick = function () { ouvrirPdfCom(f.id); }; $("faPart").onclick = function () { ouvrirPdfCom(f.id, true); }; }
    if ($("faEnc")) { $("faEnc").onclick = function () { formulaireEncCom(cleFac(f)); }; $("faRel").onclick = function () { formulaireRelanceCom(f); }; }
    $("faCt").onclick = function () { ficheContratCom(f.contrat); };
    if ($("faEd")) {
      var majEd = function () { $("faEdD").style.display = $("faEd").value === "Date" ? "" : "none"; }; $("faEd").onchange = majEd; majEd();
      $("faEdOk").onclick = function () {
        if ($("faEd").value === "Date" && !$("faEdD").value) { alert("⛔ Choisissez la date d'échéance."); return; }
        envoyerCom("echeance", { facture: f.id, dateFacture: f.date, duree: $("faEd").value, date: $("faEdD").value }, "Échéance " + f.id, function () { ficheFactureCom(cleFac(f)); });
      };
    }
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
      "<div class='info'>" + INFO_REG + "</div></div>" +
      "<div class='carte'><h3>Contrats</h3>" + Ct.map(function (c) { return "<div class='info' data-ct='" + esc(c.id) + "' style='cursor:pointer'><b>" + esc(c.designation) + "</b> · " + esc(c.id) + " · " + esc(c.statut) + "</div>"; }).join("") + "</div>" +
      F.map(htmlFacture).join("");
    $("vueListe").innerHTML = h; montrer("vueListe");
    $("clReg").onchange = function () { var v = this.value; if (confirm(cl.nom + " : régime « " + v + " » pour les prochaines factures ?")) envoyerCom("client", { nom: cl.nom, regime: v }, "Régime " + cl.nom, function () { ficheClientCom(nom); }); };
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-ct]"), function (el) { el.onclick = function () { ficheContratCom(el.getAttribute("data-ct")); }; });
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-fa]"), function (el) { el.onclick = function () { ficheFactureCom(el.getAttribute("data-fa")); }; });
  }

  var INFO_REG = "Prix saisis en HT. Administration : facture en TTC, − précompte 50 % de la TVA − ARMP 0,6 % (aucun HT affiché). Privé : HT + TVA 18 % = TTC. Exonéré (BCRG, Défense, statut spécial…) : HT seul, « Exonéré de TVA ».";
  // Montants d'un document selon le régime (même calcul que le serveur) ; pu = prix unitaire HT.
  function calcRegime(L, reg, s) {
    var t = (s.tva == null ? 18 : s.tva) / 100, pr = (s.precompte == null ? 50 : s.precompte) / 100, ar = (s.armp == null ? 0.6 : s.armp) / 100, ht = 0;
    L.forEach(function (l) { if (l.qte > 0) ht += l.qte * (l.pu || 0); });
    if (reg === "Exonéré") return { ht: ht, tva: 0, ttc: ht, precompte: 0, armp: 0, net: ht };
    var tva = ht * t, ttc = ht + tva;
    if (reg === "Privé") return { ht: ht, tva: tva, ttc: ttc, precompte: 0, armp: 0, net: ttc };
    var p = tva * pr, a = ht * ar; return { ht: ht, tva: tva, ttc: ttc, precompte: p, armp: a, net: ttc - p - a };
  }
  function coefRegime(reg, s) { var c = calcRegime([{ qte: 1, pu: 1 }], reg, s || {}); return c.net; }
  function optsCom(L, v, vide, val, lib) { return (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { var k = val ? val(x) : x; return "<option value='" + esc(k) + "'" + (k === v ? " selected" : "") + ">" + esc(lib ? lib(x) : x) + "</option>"; }).join(""); }
  function nbCom(x) { x = String(x || "").replace(/[\s  ]/g, "").replace(",", "."); return parseFloat(x) || 0; }
  function blocPrix(p) {
    return "<label>Prix</label><select id='" + p + "PU'><option value='non'>Montant global</option><option value='oui'>Prix unitaire unique × quantité</option></select>" +
      "<div id='" + p + "MtB'><label>Montant HT</label><input id='" + p + "Mt' inputmode='decimal'></div>" +
      "<div id='" + p + "PuB' class='ligne' style='display:none'><div><label>Prix unitaire HT</label><input id='" + p + "Pu' inputmode='decimal'></div><div><label>Quantité globale</label><input id='" + p + "Q' inputmode='decimal'></div></div>" +
      "<label>Devise</label><select id='" + p + "Dev'><option>GNF</option><option>EURO</option><option>USD</option><option>TND</option></select>" +
      "<div class='info'>Saisie en HT : Base reçoit le net à payer calculé selon le régime du client (Administration × 1,084 · Privé × 1,18 · Exonéré × 1).</div>";
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
      if (!confirm("Nouveau contrat : " + (d.client || d.nomClient) + " · " + (d.projet || d.nomProjet) + " · " + gnf(mt) + " " + d.devise + " HT ?")) return;
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
      if (!confirm("Nouveau BDC sur " + d.contrat + " · " + gnf(d.prixUnique ? d.pu * d.qte : d.montant) + " " + d.devise + " HT ?")) return;
      envoyerCom("bdc", d, "BDC " + d.contrat, function () { ficheContratCom(d.contrat); });
    };
  }
  /* BL / facture : lignes du BDC (Prix BDC), quantités proposées = reste, tout modifiable ; aperçu des montants. */
  function formulaireDocCom(type, idC) {
    var K = S.com, fact = type === "facture", CT = K.contrats.filter(function (c) { return !/clos/i.test(c.statut); });
    $("titre").textContent = fact ? "Nouvelle facture" : "Nouveau BL";
    $("vueListe").innerHTML = "<div class='carte'><h3>" + (fact ? "🧾 Nouvelle facture" : "📦 Nouveau bon de livraison") + "</h3>" +
      "<label>Contrat</label><select id='dcC'>" + optsCom(CT, idC || "", "— choisir —", function (c) { return c.id; }, function (c) { return c.designation + " · " + c.id; }) + "</select>" +
      "<div id='dcBB'><label>Bon de commande</label><select id='dcB'></select></div><div class='info' id='dcI'></div><div id='apDoc'></div>" +
      (fact ? "<label>Régime de la facture</label><select id='dcRg'>" + optsCom(K.regimes || ["Administration", "Privé", "Exonéré"], "Administration") + "</select><div class='info' id='dcRgI'></div>" : "") +
      "<div id='dcL'></div><button class='bouton second' id='dcAj'>➕ Ligne libre</button>" +
      "<div class='ligne'><div><label>Date</label><input id='dcD' type='date' value='" + dateISO(Date.now()) + "'></div>" + (fact ? "<div><label>Échéance de paiement</label><select id='dcEd'>" + ["Délai habituel", "Aucune", "15 jours", "1 mois", "2 mois", "3 mois", "6 mois", "Date"].map(function (x) { return "<option>" + x + "</option>"; }).join("") + "</select></div><div id='dcEB' style='display:none'><label>Date d'échéance</label><input id='dcE' type='date'></div>" : "") + "</div>" +
      "<label>" + (fact ? "Référence (BL, bon d'engagement… facultatif)" : "Livré à (lieu, réceptionnaire)") + "</label><input id='dcR'>" +
      "<div class='carte' id='dcT' style='margin-top:10px'></div><button class='bouton' id='dcEnv'>📤 " + (fact ? "Émettre la facture (PDF)" : "Émettre le BL (PDF)") + "</button><div class='info' id='dcM' style='white-space:pre-line'></div></div>";
    montrer("vueListe"); if ($("dcEd")) $("dcEd").onchange = function () { $("dcEB").style.display = $("dcEd").value === "Date" ? "" : "none"; };
    var lignes = [];
    function contrat() { return K.contrats.filter(function (c) { return c.id === $("dcC").value; })[0]; }
    function soc() { var c = contrat(); return (K.societes || {})[c ? String(c.entreprise).toUpperCase() : "AB"] || { tva: 18, precompte: 50, armp: 0.6, delai: 30 }; }
    function dessinerLignes() {
      $("dcL").innerHTML = lignes.length ? (fact && $("dcB").value ? "<button class='bouton second' id='dcRes'>↺ Quantités = commandé − déjà facturé</button>" : "") + lignes.map(function (l, i) {
        return "<div style='border-top:1px solid var(--bord);padding:6px 0" + (l.qte > 0 ? "" : ";opacity:.75") + "'><div class='ligne'><input class='dcN' data-i='" + i + "' value='" + esc(l.designation) + "' style='padding:6px;flex:1' placeholder='Désignation'>" +
          "<button class='bouton second' data-x='" + i + "' style='padding:4px 8px;width:auto;flex:0'>✕</button></div>" + (l.info ? "<div class='info' style='font-size:11px'>" + esc((l.abr ? l.abr + " · " : "") + l.info) + "</div>" : "") +
          "<div class='ligne'><div><small>Quantité</small><input class='dcQ' data-i='" + i + "' inputmode='decimal' value='" + (l.qte || "") + "' style='padding:6px'></div>" +
          "<div><small>Prix unitaire HT</small><input class='dcP' data-i='" + i + "' inputmode='decimal' value='" + (l.pu || "") + "' style='padding:6px'></div></div></div>";
      }).join("") : "<div class='info'>Aucune ligne : choisissez le BDC ou ajoutez une ligne libre.</div>";
      if ($("dcRes")) $("dcRes").onclick = function () { lignes.forEach(function (l) { if (l.cmd !== undefined) l.qte = Math.max(0, l.cmd - (l.fac || 0)); }); dessinerLignes(); };
      Array.prototype.forEach.call(document.querySelectorAll(".dcN,.dcQ,.dcP"), function (inp) {
        inp.oninput = function () { var l = lignes[+inp.getAttribute("data-i")]; if (inp.className === "dcN") l.designation = inp.value; else if (inp.className === "dcQ") l.qte = nbCom(inp.value); else l.pu = nbCom(inp.value); totaux(); };
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-x]"), function (b) { b.onclick = function () { lignes.splice(+b.getAttribute("data-x"), 1); dessinerLignes(); }; });
      totaux();
    }
    function regDoc() { var c = contrat(); return $("dcRg") ? $("dcRg").value : (c ? c.regime : "Administration"); }
    function totaux() {
      var c = contrat(), s = soc(), reg = regDoc(), q = 0, dv = esc(c ? c.devise : "GNF");
      lignes.forEach(function (l) { if (l.qte > 0) q += l.qte; });
      var k = calcRegime(lignes, reg, s);
      var h = "<b>" + lignes.filter(function (l) { return l.qte > 0; }).length + " ligne(s) · " + gnf(q) + " unités</b>";
      if (k.ht) {
        h += "<br>" + (reg === "Administration" ? "TTC " + gnf(k.ttc) + " − précompte " + gnf(k.precompte) + " − ARMP " + gnf(k.armp) : reg === "Privé" ? "HT " + gnf(k.ht) + " + TVA " + gnf(k.tva) + " = TTC " + gnf(k.ttc) : "HT " + gnf(k.ht) + " · exonéré de TVA") +
          "<br>Net à payer : <b>" + gnf(k.net) + " " + dv + "</b> <small>(" + esc(reg) + ")</small>";
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
      var LD = c ? (fact ? K.factures : (K.bls || [])).filter(function (x) { return x.client === c.client; }).sort(function (a, b) { return b.date - a.date; })
        .map(function (x) { return { date: x.date, lib: x.id + (fact ? (x.paye ? " · ✅ encaissée" : x.echeance && x.echeance < Date.now() ? " · ⏰ en retard" : " · à encaisser") : "") + (x.projet ? " · " + x.projet : ""), montant: x.montant, dev: x.devise }; }) : null;
      apercuLocal("apDoc", LD, (fact ? "Dernières factures éditées · " : "Derniers BL édités · ") + (c ? c.client : ""));
      $("dcB").innerHTML = optsCom(B, B.length === 1 ? B[0].id : "", B.length > 1 ? "— choisir —" : "", function (b) { return b.id; }, function (b) { return b.id + " · " + (b.statut || "") + " · " + gnf(b.montant); });
      $("dcBB").style.display = B.length ? "" : "none";
      if (fact && $("dcE")) { var d0 = new Date($("dcD").value + "T00:00:00").getTime() || Date.now(); $("dcE").value = dateISO(d0 + soc().delai * 86400000); }
      chargerBdc();
    }
    $("dcC").onchange = function () { var c = contrat(); if ($("dcRg") && c) $("dcRg").value = c.regime || "Administration"; majRg(); majContrat(); }; $("dcB").onchange = chargerBdc;
    function majRg() { if (!$("dcRg")) return; var c = contrat(); $("dcRgI").textContent = c && $("dcRg").value !== c.regime ? "⚠️ Différent du régime du client (" + c.regime + ") : pour cette facture seulement." : ""; totaux(); }
    if ($("dcRg")) $("dcRg").onchange = majRg;
    $("dcAj").onclick = function () { lignes.push({ designation: "", qte: 0, pu: 0 }); dessinerLignes(); };
    if ($("dcRg") && contrat()) $("dcRg").value = contrat().regime || "Administration";
    majContrat();
    $("dcEnv").onclick = function () {
      var c = contrat(), L = lignes.filter(function (l) { return String(l.designation).trim() && l.qte > 0; });
      if (!c) { $("dcM").textContent = "⛔ Choisissez le contrat."; return; }
      if (!L.length) { $("dcM").textContent = "⛔ Au moins une ligne avec une quantité."; return; }
      if (fact && L.some(function (l) { return !(l.pu > 0); })) { $("dcM").textContent = "⛔ Prix unitaire manquant sur une ligne."; return; }
      var net = calcRegime(L, regDoc(), soc()).net;
      if (!confirm((fact ? "Émettre la facture" : "Émettre le BL") + " · " + c.client + " · " + L.length + " ligne(s)" + (net ? " · net à payer " + gnf(net) + " " + c.devise + (fact ? " (" + regDoc() + ")" : "") : "") + " ?\nLe n° est attribué par le serveur (réseau nécessaire pour le PDF).")) return;
      var d = { contrat: c.id, bdc: $("dcB").value, lignes: L.map(function (l) { return { designation: String(l.designation).trim(), abr: l.abr || "", qte: l.qte, pu: l.pu || 0 }; }),
        date: $("dcD").value, echeance: fact && $("dcEd").value === "Date" ? $("dcE").value : "", duree: fact && $("dcEd").value !== "Délai habituel" ? $("dcEd").value : "", reference: $("dcR").value.trim(), devise: c.devise || "GNF", regime: fact ? regDoc() : "" };
      envoyerCom(type, d, (fact ? "Facture " : "BL ") + c.client, function (r) {
        if (r && r.ok && r.id && r.pdf) { ficheContratCom(c.id); if (confirm("Ouvrir le PDF " + r.id + " ?")) ouvrirPdfCom(r.id); } else ficheContratCom(c.id);
      });
    };
  }
  /* 📝 Devis simple : client (liste ou libre), objet, société, régime, lignes libres (PU HT), validité ; PDF ; rien dans Base. */
  function formulaireDevisCom() {
    var K = S.com, cls = K.clients.map(function (c) { return c.nom; });
    $("titre").textContent = "Nouveau devis";
    $("vueListe").innerHTML = "<div class='carte'><h3>📝 Nouveau devis</h3>" +
      "<label>Client</label><select id='dvCl'>" + optsCom(cls, "", "— choisir —") + "<option value='+'>✏️ Autre client (saisie libre)</option></select><input id='dvClL' placeholder='Nom du client' style='display:none;margin-top:6px'>" +
      "<label>Objet</label><input id='dvObj' placeholder='ex. Impression de 5 000 carnets…'>" +
      "<div class='ligne'><div><label>Société</label><select id='dvSo'>" + optsCom(Object.keys(K.societes || { AB: 1, M2S: 1 }), "AB") + "</select></div><div><label>Régime</label><select id='dvRg'>" + optsCom(K.regimes || ["Administration", "Privé", "Exonéré"], "Administration") + "</select></div>" +
      "<div><label>Devise</label><select id='dvDev'><option>GNF</option><option>EURO</option><option>USD</option><option>TND</option></select></div></div>" +
      "<div class='info'>" + INFO_REG + "</div><div id='dvL'></div><button class='bouton second' id='dvAj'>➕ Ligne</button>" +
      "<div class='ligne'><div><label>Date</label><input id='dvD' type='date' value='" + dateISO(Date.now()) + "'></div><div><label>Validité (jours)</label><input id='dvV' inputmode='numeric' value='30'></div></div>" +
      "<label>Référence (facultatif)</label><input id='dvR'><div class='carte' id='dvT' style='margin-top:10px'></div>" +
      "<button class='bouton' id='dvEnv'>📤 Émettre le devis (PDF)</button><div class='info' id='dvM' style='white-space:pre-line'></div></div>";
    montrer("vueListe");
    var lignes = [{ designation: "", qte: 0, pu: 0 }];
    function soc() { return (K.societes || {})[$("dvSo").value] || { tva: 18, precompte: 50, armp: 0.6 }; }
    function client() { return $("dvCl").value === "+" ? $("dvClL").value.trim() : $("dvCl").value; }
    function totaux() {
      var reg = $("dvRg").value, k = calcRegime(lignes, reg, soc()), dv = esc($("dvDev").value);
      $("dvT").innerHTML = k.ht ? (reg === "Administration" ? "TTC " + gnf(k.ttc) + " − précompte " + gnf(k.precompte) + " − ARMP " + gnf(k.armp) : reg === "Privé" ? "HT " + gnf(k.ht) + " + TVA " + gnf(k.tva) + " = TTC " + gnf(k.ttc) : "HT " + gnf(k.ht) + " · exonéré de TVA") +
        "<br>Net à payer : <b>" + gnf(k.net) + " " + dv + "</b>" : "<span class='info'>Saisissez les lignes.</span>";
    }
    function dessiner() {
      $("dvL").innerHTML = lignes.map(function (l, i) {
        return "<div style='border-top:1px solid var(--bord);padding:6px 0'><div class='ligne'><input class='dvN' data-i='" + i + "' value='" + esc(l.designation) + "' style='padding:6px;flex:1' placeholder='Désignation'>" +
          "<button class='bouton second' data-x='" + i + "' style='padding:4px 8px;width:auto;flex:0'>✕</button></div>" +
          "<div class='ligne'><div><small>Quantité</small><input class='dvQ' data-i='" + i + "' inputmode='decimal' value='" + (l.qte || "") + "' style='padding:6px'></div>" +
          "<div><small>Prix unitaire HT</small><input class='dvP' data-i='" + i + "' inputmode='decimal' value='" + (l.pu || "") + "' style='padding:6px'></div></div></div>";
      }).join("");
      Array.prototype.forEach.call(document.querySelectorAll(".dvN,.dvQ,.dvP"), function (inp) {
        inp.oninput = function () { var l = lignes[+inp.getAttribute("data-i")]; if (inp.className === "dvN") l.designation = inp.value; else if (inp.className === "dvQ") l.qte = nbCom(inp.value); else l.pu = nbCom(inp.value); totaux(); };
      });
      Array.prototype.forEach.call(document.querySelectorAll("#dvL [data-x]"), function (b) { b.onclick = function () { lignes.splice(+b.getAttribute("data-x"), 1); dessiner(); }; });
      totaux();
    }
    $("dvCl").onchange = function () {
      $("dvClL").style.display = this.value === "+" ? "" : "none";
      var c = K.clients.filter(function (x) { return x.nom === $("dvCl").value; })[0]; if (c) $("dvRg").value = c.regime || "Administration";
      totaux();
    };
    ["dvRg", "dvSo", "dvDev"].forEach(function (id) { $(id).onchange = totaux; });
    $("dvAj").onclick = function () { lignes.push({ designation: "", qte: 0, pu: 0 }); dessiner(); };
    dessiner();
    $("dvEnv").onclick = function () {
      var cl = client(), L = lignes.filter(function (l) { return String(l.designation).trim() && l.qte > 0; });
      if (!cl) { $("dvM").textContent = "⛔ Indiquez le client."; return; }
      if (!L.length) { $("dvM").textContent = "⛔ Au moins une ligne avec une quantité."; return; }
      if (L.some(function (l) { return !(l.pu > 0); })) { $("dvM").textContent = "⛔ Prix unitaire HT manquant sur une ligne."; return; }
      var reg = $("dvRg").value, net = calcRegime(L, reg, soc()).net;
      if (!confirm("Émettre le devis · " + cl + " · " + L.length + " ligne(s) · net à payer " + gnf(net) + " " + $("dvDev").value + " (" + reg + ") ?\nLe n° est attribué par le serveur (réseau nécessaire pour le PDF).")) return;
      var d = { client: cl, objet: $("dvObj").value.trim(), societe: $("dvSo").value, regime: reg, devise: $("dvDev").value, date: $("dvD").value, validite: nbCom($("dvV").value) || 30, reference: $("dvR").value.trim(),
        lignes: L.map(function (l) { return { designation: String(l.designation).trim(), qte: l.qte, pu: l.pu }; }) };
      envoyerCom("devis", d, "Devis " + cl, function (r) {
        COMV.onglet = "devis"; afficherCom();
        if (r && r.ok && r.id && r.pdf && confirm("Ouvrir le PDF " + r.id + " ?")) ouvrirPdfCom(r.id);
      });
    };
  }
  function formulaireEncCom(idF) {
    var K = S.com, F = K.factures.filter(function (f) { return !f.paye && !comAttente(f.id).length; }).sort(function (a, b) { return a.echeance - b.echeance; });
    $("titre").textContent = "Encaissement";
    $("vueListe").innerHTML = "<div class='carte'><h3>💵 Encaissement d'une facture</h3><label>Facture (payée en entier)</label><select id='enF'>" +
      optsCom(F, idF, "— choisir —", cleFac, function (f) { return f.id + " · du " + jourLib(f.date) + " · " + f.client + " · " + gnf(f.montant) + " " + f.devise; }) + "</select>" +
      "<div class='info' id='enI'></div><label>Date réelle d'encaissement (relevé bancaire)</label><input id='enD' type='date' value='" + dateISO(Date.now()) + "'>" +
      "<button class='bouton' id='enEnv' style='background:var(--vert)'>💵 Enregistrer l'encaissement</button><div class='info' id='enM'></div></div>";
    montrer("vueListe");
    function info() { var f = F.filter(function (x) { return cleFac(x) === $("enF").value; })[0]; $("enI").textContent = f ? "Crédité sur " + f.benef + " (compte du contrat)." : ""; }
    $("enF").onchange = info; info();
    $("enEnv").onclick = function () {
      var f = F.filter(function (x) { return cleFac(x) === $("enF").value; })[0], dt = $("enD").value;
      if (!f || !dt) { $("enM").textContent = "⛔ Facture et date."; return; }
      if (!confirm("Encaissement " + f.id + " : " + gnf(f.montant) + " " + f.devise + " le " + dt.split("-").reverse().join("/") + " sur " + f.benef + " ?")) return;
      envoyerCom("recouvrement", { facture: f.id, dateFacture: f.date, date: dt }, "Encaissement " + f.id, function () { ficheFactureCom(cleFac(f)); });
    };
  }
  function formulaireRelanceCom(f) {
    $("titre").textContent = "Relance";
    $("vueListe").innerHTML = "<div class='carte'><h3>📞 Relance · " + esc(f.id) + "</h3><div class='info'>" + esc(f.client) + " · " + gnf(f.montant) + " " + esc(f.devise) + "</div>" +
      "<label>Mode</label><select id='rlM'><option>Appel</option><option>Visite</option><option>Courrier</option><option>E-mail</option><option>WhatsApp</option></select>" +
      "<label>Compte rendu</label><textarea id='rlC' rows='3'></textarea><label>Prochaine relance</label><input id='rlP' type='date' value='" + dateISO(Date.now() + 7 * 86400000) + "'>" +
      "<button class='bouton' id='rlEnv'>Enregistrer</button></div>";
    montrer("vueListe");
    $("rlEnv").onclick = function () { envoyerCom("relance", { facture: f.id, client: f.client, mode: $("rlM").value, commentaire: $("rlC").value.trim(), prochaine: $("rlP").value }, "Relance " + f.id, function () { ficheFactureCom(cleFac(f)); }); };
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
  var MISV = { onglet: "moi", clos: false, mois: null, jour: null, vue: "30" };
  // 📅 Calendrier des missions : échéances du mois (missions ouvertes) + prochaines occurrences des récurrentes (en clair).
  function misRecSuiv(t, rec) {
    var d = new Date(t);
    if (rec === "Quotidienne") d.setDate(d.getDate() + 1); else if (rec === "Hebdomadaire") d.setDate(d.getDate() + 7);
    else if (rec === "Mensuelle") d.setMonth(d.getMonth() + 1); else if (rec === "Trimestrielle") d.setMonth(d.getMonth() + 3);
    else if (rec === "Tous les 4 mois") d.setMonth(d.getMonth() + 4); else if (rec === "Annuelle") d.setFullYear(d.getFullYear() + 1); else return 0;
    return d.getTime();
  }
  function calendrierMis(M) {
    var now = new Date(); if (!MISV.mois) MISV.mois = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    var d0 = new Date(MISV.mois), y = d0.getFullYear(), mo = d0.getMonth(), deb = d0.getTime(), fin = new Date(y, mo + 1, 1).getTime(), auj = misAuj();
    var trente = MISV.vue === "30";
    if (trente) { deb = auj; fin = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30).getTime(); }
    var MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"], J = {};
    function k(t) { var x = new Date(t); return x.getFullYear() + "-" + x.getMonth() + "-" + x.getDate(); }
    M.missions.filter(function (m) { return misOuv(m) && m.echeance && (M.direction || misPour(m, M.agent) || nomRH(m.par) === nomRH(M.agent)); }).forEach(function (m) {
      var t = m.echeance, n = 0;
      if (t >= deb && t < fin) (J[k(t)] = J[k(t)] || []).push({ m: m, prev: false });
      if (!m.rec) return;
      while ((t = misRecSuiv(t, m.rec)) && t < fin && n++ < 400) if (t >= deb) (J[k(t)] = J[k(t)] || []).push({ m: m, prev: true });
    });
    var j0 = new Date(deb), premier = (j0.getDay() + 6) % 7, nbj = trente ? 30 : new Date(y, mo + 1, 0).getDate(), cases = "";
    var MC = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
    for (var i = 0; i < premier; i++) cases += "<div></div>";
    for (var jj = 0; jj < nbj; jj++) {
      var dj = new Date(j0.getFullYear(), j0.getMonth(), j0.getDate() + jj), j = dj.getDate() + (trente && (jj === 0 || j === 1 || dj.getDate() === 1) ? " " + MC[dj.getMonth()] : "");
      var t = dj.getTime(), L = J[k(t)] || [], ret = L.some(function (x) { return !x.prev && t < auj && x.m.statut !== "À clôturer"; }), sel = MISV.jour === t;
      cases += "<div data-cj='" + t + "' style='cursor:pointer;min-height:54px;border-radius:8px;padding:3px;border:1px solid " + (sel ? "var(--cuivre)" : "var(--bord)") + ";background:" + (t === auj ? "rgba(200,120,60,.15)" : "var(--fond)") + "'>" +
        "<div style='font-size:12px;font-weight:" + (t === auj ? 800 : 600) + "'>" + j + "</div>" +
        L.slice(0, 3).map(function (x) { return "<div style='font-size:10px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:4px;padding:0 3px;margin-top:2px;" +
          (x.prev ? "border:1px dashed var(--bord);opacity:.7" : "background:" + (ret ? "#c62828" : x.m.prio === "Haute" ? "#e65100" : "#2e7d32") + ";color:#fff") + "'>" + esc(x.m.titre) + "</div>"; }).join("") +
        (L.length > 3 ? "<div style='font-size:10px' class='info'>+" + (L.length - 3) + "</div>" : "") + "</div>";
    }
    var det = "";
    if (MISV.jour === null && trente) MISV.jour = auj;
    if (MISV.jour && MISV.jour >= deb && MISV.jour < fin) {
      var LJ = J[k(MISV.jour)] || [];
      det = "<div style='margin-top:8px'><b>" + jourFr(MISV.jour) + "</b>" + (LJ.map(function (x) {
        return "<div data-mi='" + esc(x.m.id) + "' style='cursor:pointer;padding:6px 0;border-top:1px solid var(--bord)'>" + (x.prev ? "🔁 " : "🎯 ") + "<b>" + esc(x.m.titre) + "</b> <span class='info'>" +
          (x.prev ? "occurrence prévue (" + esc(x.m.rec.toLowerCase()) + ")" : esc(x.m.statut) + " · " + esc(x.m.assignes.join(", "))) + "</span></div>"; }).join("") || "<div class='info'>Aucune échéance ce jour.</div>") + "</div>";
    }
    var nb30 = 0; Object.keys(J).forEach(function (x) { nb30 += J[x].length; });
    return "<div class='carte pleine'><div class='ligne' style='justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px'>" +
      (trente ? "<b style='flex:1'>📅 30 prochains jours <span class='info'>(" + jourFr(deb) + " → " + jourFr(fin - 86400000) + " · " + nb30 + " échéance(s))</span></b><button class='bouton second' id='caV' style='width:auto;flex:0 0 auto;margin:0'>🗓️ Vue mois</button>"
        : "<button class='bouton second' id='caP' style='width:auto;flex:0 0 auto;margin:0'>‹</button><b style='flex:1;text-align:center'>📅 " + MOIS[mo] + " " + y + "</b>" +
          "<button class='bouton second' id='caS' style='width:auto;flex:0 0 auto;margin:0'>›</button><button class='bouton second' id='caV' style='width:auto;flex:0 0 auto;margin:0'>📅 30 jours</button>") + "</div>" +
      "<div style='display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;margin-top:8px'>" + ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map(function (x) { return "<div class='info' style='text-align:center;margin:0'>" + x + "</div>"; }).join("") + cases + "</div>" +
      "<div class='info'><span style='color:#2e7d32'>■</span> à venir · <span style='color:#e65100'>■</span> priorité haute · <span style='color:#c62828'>■</span> en retard · ┆ occurrence récurrente prévue</div>" + det + "</div>";
  }
  function lierCalendrierMis() {
    function mois(dm) { var d = new Date(MISV.mois); MISV.mois = new Date(d.getFullYear(), d.getMonth() + dm, 1).getTime(); MISV.jour = null; afficherMis(); }
    if ($("caP")) $("caP").onclick = function () { mois(-1); };
    if ($("caS")) $("caS").onclick = function () { mois(1); };
    if ($("caV")) $("caV").onclick = function () { var n = new Date(); MISV.vue = MISV.vue === "30" ? "mois" : "30"; MISV.mois = new Date(n.getFullYear(), n.getMonth(), 1).getTime(); MISV.jour = null; afficherMis(); };
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-cj]"), function (el) { el.onclick = function () { var t = +el.getAttribute("data-cj"); MISV.jour = MISV.jour === t ? null : t; afficherMis(); }; });
  }
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
      (envoi ? "<div class='carte att'>⏳ " + envoi + " opération(s) en attente d'envoi.</div>" : "") + calendrierMis(M) + "<div id='miL'></div>";
    $("vueListe").innerHTML = h; montrer("vueListe"); lierCalendrierMis();
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-cj] ~ * [data-mi], .carte.pleine [data-mi]"), function (el) { el.onclick = function () { ficheMis(el.getAttribute("data-mi")); }; });
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
      if (dir) h += "<div class='ligne'><button class='bouton' id='miFin' style='background:var(--vert)'>🏁 Clôturer : terminée</button>" + (m.statut === "À clôturer" && !ass ? "<button class='bouton alerte' id='miRet'>↩️ Retour (pas terminée)</button>" : "") + "<button class='bouton' id='miAnn' style='background:var(--rouge)'>⛔ Annuler</button></div>";
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
    if ($("miRet")) $("miRet").onclick = function () { if (!com()) { $("miMsg").textContent = "⛔ Indiquez dans le commentaire ce qui reste à faire."; return; } envoyerMis("statut", { id: m.id, version: m.version, statut: "En cours", commentaire: com() }, "Retour " + m.id, retour); };
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
  function fourLibCompte(f) { return (f.societe ? "" : "⚠️ sans société · ") + ([f.societe || "", f.projet || ""].filter(String).join(" · ") || "à affilier") + (f.projetAcheve ? " (projet achevé" + (Math.abs(f.solde || 0) > 0.5 ? " · ⚠️ solde à régler" : "") + ")" : ""); }
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
        "<label style='font-weight:400'><input type='checkbox' id='foI' style='width:auto'" + (FOUR.inactifs ? " checked" : "") + "> afficher les comptes désactivés et les projets achevés</label>" +
        "<div id='foPA'></div>" +
        "<div class='info'>Un fournisseur peut avoir plusieurs comptes (société, projet), chacun avec son solde. Solde = facturé − payé (positif : reste dû ; négatif : avance).</div></div><div id='foL'></div>";
      montrer("vueListe");
      var liste = function () {
        FOUR.q = $("foQ").value; FOUR.soc = $("foS").value; FOUR.projet = $("foP").value; FOUR.inactifs = $("foI").checked; var q = FOUR.q.trim().toLowerCase();
        var Lf = L.filter(function (f) { return (FOUR.inactifs || (f.actif !== false && (!f.projetAcheve || Math.abs(f.solde || 0) > 0.5))) && (!FOUR.soc || f.societe === FOUR.soc) && (!FOUR.projet || f.projet === FOUR.projet) &&
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
        // Direction : clôturer / rouvrir le projet filtré.
        var achS = (S.fin && S.fin.projetsAcheves) || [], dirF = S.fin && S.fin.role;
        $("foPA").innerHTML = FOUR.projet && dirF ? (achS.indexOf(FOUR.projet) >= 0
          ? "<div class='info'>📁 Projet achevé.</div><button class='bouton second' id='foPR'>↩️ Rouvrir le projet « " + esc(FOUR.projet) + " »</button>"
          : "<button class='bouton second' id='foPF'>✅ Marquer le projet « " + esc(FOUR.projet) + " » achevé</button>") : "";
        function projetOp(ach) {
          if (!confirm((ach ? "Marquer achevé" : "Rouvrir") + " le projet « " + FOUR.projet + " » ?" + (ach ? "\nSes comptes seront masqués (sauf solde à régler) et ne seront plus proposés dans les demandes." : ""))) return;
          var it = { type: "fin", op: "projet", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: { nom: FOUR.projet, acheve: ach }, titre: "Projet " + FOUR.projet, resume: "Finances", essais: 0 };
          soumettre(it).then(function (r) { alert((r.ok ? "✅ " : "⛔ ") + r.titre + "\n" + (r.message || "")); FOUR.liste = null; rafraichirFin().catch(function () {}).then(afficherFournisseurs); });
        }
        if ($("foPF")) $("foPF").onclick = function () { projetOp(true); };
        if ($("foPR")) $("foPR").onclick = function () { projetOp(false); };
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
      $("fmDem").onclick = function () { formulaireFin({ type: "Achat fournisseur", limiter: true, fournisseur: (C.filter(function (f) { return f.actif !== false; })[0] || {}).nom || raison }); };
    };
    dessiner(FOUR.liste ? "" : "chargement…");
    if (!FOUR.liste) chargerFour(function (m) { dessiner(m); });
  }
  function normFour(x) { return String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase(); }
  /* Fournisseur déjà connu : on ouvre sa fiche et directement le formulaire « Nouveau compte ». */
  function ouvrirFourExistant(raison) {
    var go = function () {
      var r = ((FOUR.liste && FOUR.liste.fournisseurs) || []).map(fourRaison).filter(function (x) { return normFour(x) === normFour(raison); })[0] || raison;
      ficheFourMere(r); formulaireCompteFour(r, null);
    };
    rafraichirFin().catch(function () {}).then(function () { FOUR.liste = null; chargerFour(go); });
  }
  function envoyerFour(d, titre, apres) {
    var it = { type: "fin", op: "fournisseur", jeton: nouveauJeton(), horodatage: Date.now(), agent: S.agent.nom, code: S.agent.code, donnees: d, titre: titre, resume: "Finances", essais: 0 };
    soumettre(it).then(function (r) {
      if (!r.ok && r.existant) { alert("ℹ️ " + r.titre + "\n" + r.message); ouvrirFourExistant(r.existant); return; }
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
      (nouveau ? "<label>Raison sociale</label><input id='cfR'>" +
        "<div class='ligne'><div><label>Société bénéficiaire du 1er compte</label><select id='cfS'><option value=''>— choisir —</option><option>AB</option><option>M2S</option><option>CASAFINO</option></select></div>" +
        "<div><label>Projet (facultatif)</label><input id='cfP' list='cfPL' placeholder='ex. Dépôt Nongo'><datalist id='cfPL'>" + (F.projets || []).map(function (x) { return "<option value='" + esc(x) + "'>"; }).join("") + "</datalist></div></div>" : "") +
      "<div class='ligne'><div><label>Type</label><select id='cfT'>" + opt(["Fournisseur", "Prestataire"], k.type || "Fournisseur") + "</select></div>" +
      "<div><label>Assujetti à la TVA 18 %</label><select id='cfV'>" + opt(["Non", "Oui"], k.tva ? "Oui" : "Non") + "</select></div></div>" +
      "<label>Catégorie de dépense habituelle</label><select id='cfA'>" + opt(C0, k.article || "", "— aucune —") + "</select>" +
      "<div class='ligne'><div><label>Téléphone</label><input id='cfTe' value='" + esc(k.tel || "") + "'></div><div><label>NIF</label><input id='cfN' value='" + esc(k.nif || "") + "'></div></div>" +
      "<label>RIB / compte bancaire</label><input id='cfRi' value='" + esc(k.rib || "") + "'>" +
      "<div class='info'>" + (nouveau ? "Le fournisseur est créé avec ce premier compte (société + projet). D'autres comptes s'ajoutent ensuite depuis sa fiche." : "Ces informations s'appliquent à tous ses comptes.") + "</div>" +
      "<button class='bouton' id='cfEnv'>" + (nouveau ? "Créer le fournisseur" : "Enregistrer") + "</button><div class='info' id='cfM'></div></div>";
    montrer("vueListe");
    $("cfEnv").onclick = function () {
      var d = { type: $("cfT").value, tva: $("cfV").value === "Oui", article: $("cfA").value, tel: $("cfTe").value.trim(), nif: $("cfN").value.trim(), rib: $("cfRi").value.trim() };
      if (nouveau) {
        d.raison = $("cfR").value.replace(/\s+/g, " ").trim(); d.creer = true; d.general = true; d.societe = $("cfS").value; d.projet = $("cfP").value.replace(/\s+/g, " ").trim();
        d.nom = [d.raison, d.societe, d.projet].filter(String).join(" — ");
        if (!d.raison) { $("cfM").textContent = "⛔ Indiquez la raison sociale."; return; }
        if (!d.societe) { $("cfM").textContent = "⛔ Choisissez la société bénéficiaire du premier compte."; return; }
        var ex = (F.fournisseurs || []).filter(function (x) { return normFour(fourRaison(x)) === normFour(d.raison) || normFour(x.nom) === normFour(d.raison); })[0];
        if (ex) { alert("ℹ️ « " + fourRaison(ex) + " » existe déjà : sa fiche s'ouvre pour lui ajouter un compte."); ouvrirFourExistant(fourRaison(ex)); return; }
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
      (nouveau ? "<div class='ligne'><div><label>Société bénéficiaire</label><select id='ccS'><option value=''>— choisir —</option><option>AB</option><option>M2S</option><option>CASAFINO</option></select></div>" +
        "<div><label>Projet (facultatif)</label><input id='ccP' list='ccPL' placeholder='ex. Dépôt Nongo'><datalist id='ccPL'>" + P.map(function (x) { return "<option value='" + esc(x) + "'>"; }).join("") + "</datalist></div></div>" +
        "<div class='info'>Société pour laquelle l'achat ou la prestation est fait. Le règlement reste libre : payé par une autre société, la dette va en 🔁 Inter-sociétés. Un projet nouveau est ajouté à la liste.</div>" +
        "<div class='info' style='margin-top:10px'>Nom du compte : <b id='ccNomV'></b>" + (dir ? " <button class='lien' id='ccNomE'>✏️ modifier</button>" : "") + "</div><input id='ccNom' style='display:none'>"
      : (f.societe ? "<div class='info'>Société : " + esc(f.societe) + " · projet : " + esc(f.projet || "aucun") + "</div>"
         : "<div class='info' style='color:#c62828'>⚠️ Compte sans société : choisissez la société bénéficiaire.</div><div class='ligne'><div><label>Société bénéficiaire</label><select id='ccSA'><option value=''>— choisir —</option><option>AB</option><option>M2S</option><option>CASAFINO</option></select></div>" +
           "<div><label>Projet (facultatif)</label><input id='ccPA' value='" + esc(f.projet || "") + "' list='ccPLA'><datalist id='ccPLA'>" + P.map(function (x) { return "<option value='" + esc(x) + "'>"; }).join("") + "</datalist></div></div>") + "<label style='font-weight:400'><input type='checkbox' id='ccAc' style='width:auto'" + (f.actif === false ? "" : " checked") + "> compte actif (proposé dans les demandes)</label>") +
      "<button class='bouton' id='ccEnv'>" + (nouveau ? "Créer le compte" : "Enregistrer") + "</button>" +
      (!nouveau && dir ? "<button class='bouton' id='ccSup' style='background:var(--rouge);margin-top:8px'>🗑️ Supprimer ce compte</button><div class='info'>Seulement s'il n'a aucune demande (sinon : décocher « compte actif »).</div>" : "") +
      "<div class='info' id='ccM'></div></div>";
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
    if ($("ccSup")) $("ccSup").onclick = function () {
      if (!confirm("Supprimer définitivement le compte « " + f.nom + " » ?")) return;
      envoyerFour({ nom: f.nom, supprimer: true }, "Suppression " + f.nom, function () { ficheFourMere(raison); });
    };
    $("ccEnv").onclick = function () {
      var d;
      if (nouveau) {
        d = { creer: true, nom: $("ccNom").value.replace(/\s+/g, " ").trim(), raison: raison, societe: $("ccS").value, projet: $("ccP").value.replace(/\s+/g, " ").trim(),
              type: k.type || "Fournisseur", article: k.article || "", tva: !!k.tva, tel: k.tel || "", nif: k.nif || "", rib: k.rib || "" };
        if (!d.societe) { $("ccM").textContent = "⛔ Choisissez la société bénéficiaire."; return; }
        if (existants.some(function (x) { return (x.societe || "") === d.societe && (x.projet || "").toLowerCase() === d.projet.toLowerCase(); })) { $("ccM").textContent = "⛔ Ce fournisseur a déjà un compte pour cette société et ce projet."; return; }
        if (!d.nom || (F.fournisseurs || []).some(function (x) { return x.nom.toLowerCase() === d.nom.toLowerCase(); })) { $("ccM").textContent = "⛔ Nom de compte vide ou déjà pris."; return; }
      } else { d = { nom: f.nom, actif: $("ccAc").checked };
        if ($("ccSA")) { if (!$("ccSA").value && d.actif) { $("ccM").textContent = "⛔ Choisissez la société bénéficiaire."; return; } if ($("ccSA").value) { d.societe = $("ccSA").value; d.projet = $("ccPA").value.replace(/\s+/g, " ").trim(); } } }
      envoyerFour(d, (nouveau ? "Nouveau compte " : "Compte ") + d.nom, function (r) { if (nouveau) ficheFourMere(raison); else ficheFournisseur(f.nom); });
    };
  }
  /* 🔁 Comptes entre sociétés : ce que chaque société doit aux autres (paiements faits pour son compte). */
  function afficherInterco() {
    $("titre").textContent = "Inter-sociétés";
    $("vueListe").innerHTML = "<div class='carte'><h3>🔁 Comptes entre sociétés</h3><p class='info'>⏳ Chargement…</p></div>"; montrer("vueListe");
    api({ api: "finInterco" }).then(function (r) {
      var SOC = ["AB", "M2S", "CASAFINO", "DG"], NOMS = { AB: "AB", M2S: "M2S", CASAFINO: "CasaFino", DG: "DG (personnel)" }, paires = [["CASAFINO", "AB"], ["CASAFINO", "M2S"], ["M2S", "AB"], ["AB", "DG"], ["M2S", "DG"], ["CASAFINO", "DG"]];
      function net(a, b) { return (r.soldes[a + "|" + b] || 0) - (r.soldes[b + "|" + a] || 0); }   // > 0 : a doit à b
      var h = "<div class='carte pleine'><h3>🔁 Dettes entre sociétés</h3><div class='info'>Paiements faits par une société pour le compte d'une autre − remboursements − compensations / apports.</div><table>" +
        paires.filter(function (p) { return p[1] !== "DG" || net(p[0], p[1]); }).map(function (p) { var v = net(p[0], p[1]), a = v >= 0 ? p[0] : p[1], b = v >= 0 ? p[1] : p[0];
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
        if (!modePC()) return "<div data-no='" + esc(m.no) + "' style='cursor:pointer;padding:8px 0;border-bottom:1px solid var(--bord)'><div class='ligne' style='justify-content:space-between'><b>" + esc(m.op) + "</b><span class='info' style='flex:0;white-space:nowrap'>" + jourLib(m.date).substring(0, 5) + "</span></div>" +
          "<div class='info' style='font-size:11px'>" + esc(m.no) + (m.societe ? " · " + esc(m.societe) : "") + (m.devise !== "GNF" ? " · " + gnf(m.montant) + " " + esc(m.devise) : "") + "</div>" +
          "<div class='ligne' style='justify-content:space-between;font-size:14px;margin-top:2px'>" + (m.facture ? "<span>Facturé <b>" + gnf(m.facture) + "</b></span>" : "") + (m.paye ? "<span>Payé <b style='color:#2e7d32'>" + gnf(m.paye) + "</b></span>" : "") +
          "<span>Solde <b style='color:" + (solde > 0 ? "#c62828" : "inherit") + "'>" + gnf(solde) + "</b></span></div></div>";
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
        "<div class='carte'><h3>Relevé de compte</h3>" + (lignes && !modePC() ? lignes : lignes ? "<table><tr><td><b>Date</b></td><td><b>Opération</b></td><td class='v'><b>Facturé</b></td><td class='v'><b>Payé</b></td><td class='v'><b>Solde</b></td></tr>" + lignes + "</table>" : "<div class='info'>Aucune opération sur la période.</div>") + "</div>" +
        (C.length ? "<div class='carte'><h3>En cours (" + C.length + ")</h3>" + C.map(function (c) { return "<div class='info' data-no='" + esc(c.no) + "' style='cursor:pointer'>" + jourLib(c.date) + " · " + esc(c.op) + " · <b>" + gnf(c.gnf) + " GNF</b> · " + esc(c.statut) + " · " + esc(c.no) + "</div>"; }).join("") + "</div>" : "");
      $("vueListe").innerHTML = h; montrer("vueListe");
      ["ftS", "ftDu", "ftAu"].forEach(function (id) { $(id).onchange = function () { FOURF.soc = $("ftS").value; FOURF.du = $("ftDu").value; FOURF.au = $("ftAu").value; dessiner(""); }; });
      $("ftEnr").onclick = function () { formulaireCompteFour(f.raison || f.nom, f); };
      $("ftCopie").onclick = function () { ficheFourMere(f.raison || f.nom); };
      $("ftDem").onclick = function () { formulaireFin({ type: "Achat fournisseur", limiter: true, fournisseur: f.nom }); };
      $("ftPdf").onclick = function () {
        var soc = (f.societe && f.societe !== "CASAFINO" ? f.societe : "") || FOURF.soc || (f.societe ? "AB" : "") || prompt("Relevé pour quelle société ? (AB ou M2S)", "AB");
        soc = String(soc || "").trim().toUpperCase(); if (soc !== "AB" && soc !== "M2S") return;
        $("ftPdf").disabled = true; $("ftPdf").textContent = "⏳ PDF…";
        api({ api: "finReleve", nom: f.nom, societe: soc, du: FOURF.du, au: FOURF.au }, 120000).then(function (r) {
          var blob = base64Blob(r.pdf), fi = new File([blob], r.nom, { type: "application/pdf" });
          if (modePC()) voirPdfBlob(blob, r.nom);
          else if (navigator.canShare && navigator.canShare({ files: [fi] }) && confirm("Partager le relevé ? (Annuler = l'ouvrir)")) navigator.share({ files: [fi], title: r.nom }).catch(function () {});
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
        var G = {}; T.comptes.forEach(function (c) { var g = c.perso ? "🔒 Comptes personnels DG (hors trésorerie des sociétés)" : c.type === "Caisse" ? "Caisses" : "Comptes bancaires"; (G[g] = G[g] || []).push(c); });
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
      var bt = T ? ("<div class='carte pleine'><div class='ligne' style='flex-wrap:wrap;gap:6px'>" + (T.tous ? "<button class='bouton' id='trAH' style='width:auto;flex:0 0 auto;margin:0'>📥 Relevés de la semaine</button><button class='bouton' id='trAB' style='width:auto;flex:0 0 auto;margin:0'>🔎 Audit bancaire</button>" : "") +
        (T.comptes.some(function (c) { return c.type === "Caisse"; }) ? "<button class='bouton' id='trAC' style='width:auto;flex:0 0 auto;margin:0'>💵 Audit de caisse</button>" : "") +
        "<button class='bouton second' id='trAL' style='width:auto;flex:0 0 auto;margin:0'>📋 Historique des audits</button>" + (T.tous ? "<button class='bouton second' id='trAR' style='width:auto;flex:0 0 auto;margin:0'>⚙️ Prélèvements récurrents</button>" : "") + "</div></div>") : "";
      $("vueListe").innerHTML = bt + h; montrer("vueListe");
      if ($("trAB")) $("trAB").onclick = function () { afficherAudit("banque"); };
      if ($("trAH")) $("trAH").onclick = function () { afficherAudit("hebdo"); };
      if ($("trAC")) $("trAC").onclick = function () { afficherAudit("caisse"); };
      if ($("trAL")) $("trAL").onclick = function () { afficherAudit("liste"); };
      if ($("trAR")) $("trAR").onclick = function () { AUD.edit = null; afficherAudit("regles"); };
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
          if (modePC()) voirPdfBlob(blob, r.nom);
          else if (navigator.canShare && navigator.canShare({ files: [fi] }) && confirm("Partager le relevé ? (Annuler = l'ouvrir)")) navigator.share({ files: [fi], title: r.nom }).catch(function () {});
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
      try { var c = JSON.parse(options.body); c.appareil = S.dev.id; c.secret = S.dev.secret; c.appVersion = VERSION_APP; options.body = JSON.stringify(c); } catch (e) {}
      return url;
    }
    return url + (url.indexOf("?") < 0 ? "?" : "&") + "appareil=" + encodeURIComponent(S.dev.id) + "&secret=" + encodeURIComponent(S.dev.secret) + "&appVersion=" + encodeURIComponent(VERSION_APP);
  }
  /* ---------- ⬆️ Mise à jour obligatoire : le script exige une version ; tant qu'elle n'est pas installée, tout est bloqué ---------- */
  function plusAncienne(v) { return !!v && String(VERSION_APP) < String(v); }
  function declencherMaj(v) {
    if (!plusAncienne(v)) return;
    if (S.majRequise !== v) { S.majRequise = v; ecrire("majRequise", v); }
    ecranMaj();
  }
  // Nouveautés de cette version (affichées après une mise à jour réussie) : à mettre à jour avec chaque version.
  var NOUVEAUTES = [
    "📅 Date d'effet de chaque opération (en plus de la date d'exécution) : à la demande, ajustable à la clôture ; inscrite dans BASE.",
    "Demande « À exécuter » : Walid propose une modification (pièce inchangée) ou une annulation ; le DG accepte / refuse.",
    "🔁 Retrait / transfert vers la caisse d'une autre société : avance inscrite en Inter-sociétés."
  ];
  var MAJ = { pct: 0, etape: "", encours: false };
  function court(v) { return String(v || "").split(" ").pop().replace(/^duocore-.*-/, ""); }
  function ecranMaj(etat) {
    var o = $("ecranMaj");
    if (!o) { o = document.createElement("div"); o.id = "ecranMaj"; document.body.appendChild(o); }
    var essais = 0; try { essais = +localStorage.getItem("majEssais") || 0; } catch (e) {}
    var nAtt = S.file.length, enc = etat === "encours";
    o.innerHTML = "<div class='carte' style='max-width:560px;margin:0 auto'><h3>⬆️ Mise à jour obligatoire</h3>" +
      "<p>Une nouvelle version de DuoCore est exigée. Aucune saisie n'est possible tant qu'elle n'est pas installée.</p>" +
      "<table><tr><td>Version installée</td><td class='v'><b>" + esc(court(VERSION_APP)) + "</b></td></tr><tr><td>Version exigée</td><td class='v'><b style='color:#2e7d32'>" + esc(court(S.majRequise)) + "</b></td></tr></table>" +
      (nAtt ? "<div class='info' style='margin-top:8px'>📥 " + nAtt + " saisie(s) gardée(s) sur l'appareil : elles partiront automatiquement après la mise à jour. Ne les refaites pas.</div>" : "") +
      (enc ? "<div style='margin-top:14px;text-align:center'><div class='majRoue'>⚙️</div><div id='majEtape' style='font-weight:700;margin:6px 0'>" + esc(MAJ.etape || "Recherche de la nouvelle version…") + "</div>" +
        "<div style='height:12px;background:var(--bord);border-radius:8px;overflow:hidden'><div id='majBarre' style='height:100%;width:" + MAJ.pct + "%;background:var(--cuivre);transition:width .4s'></div></div>" +
        "<div class='info' id='majPct'>" + MAJ.pct + " %</div><div class='info'>Ne fermez pas l'application.</div></div>"
       : "<button class='bouton' id='majGo' style='margin-top:12px'>⬆️ Mettre à jour</button>") +
      "<div class='info' id='majMsg' style='white-space:pre-line'>" + (etat === "hors" ? "⛔ Pas de réseau : connectez l'appareil (Wi-Fi ou données) puis réessayez." : etat === "echec" || (essais && !enc) ? "⚠️ La mise à jour automatique n'a pas abouti (" + essais + " essai(s)). La nouvelle version n'est peut-être pas encore publiée, ou le téléphone garde l'ancienne : suivez les instructions ci-dessous." : "") + "</div>" +
      "<details" + (essais && !enc ? " open" : "") + " style='margin-top:12px'><summary><b>Instructions si le bouton ne suffit pas</b></summary><ol style='padding-left:20px;line-height:1.6'>" +
      "<li>Vérifiez que l'appareil a du réseau, puis touchez <b>⬆️ Mettre à jour</b> et attendez la fin de la barre.</li>" +
      "<li>Fermez complètement DuoCore (bouton des applications récentes → balayer DuoCore), puis rouvrez-la.</li>" +
      "<li>Toujours l'ancienne version ? Android (Chrome) : Chrome → ⋮ → Paramètres → Paramètres des sites → Toutes les données → mimo-services.github.io → <b>Effacer</b>, puis rouvrez DuoCore et reconnectez-vous (code au DG si demandé).</li>" +
      "<li>PC (Chrome / Edge) : sur la page DuoCore, appuyez sur <b>Ctrl + Maj + R</b>.</li>" +
      "<li>iPhone : supprimez l'icône DuoCore de l'écran d'accueil, rouvrez le lien dans Safari, puis Partager → Sur l'écran d'accueil.</li>" +
      "<li>Si rien ne change après 15 minutes : la nouvelle version n'est peut-être pas encore publiée — prévenez le DG.</li></ol>" +
      "<div class='info'>⚠️ N'effacez les données (étape 3) qu'en dernier recours : les saisies en attente sur l'appareil seraient perdues.</div></details></div>";
    o.style.display = "block";
    if ($("majGo")) $("majGo").onclick = installerMaj;
  }
  function progresMaj(pct, etape) {
    MAJ.pct = Math.max(MAJ.pct, Math.round(pct)); if (etape) MAJ.etape = etape;
    if ($("majBarre")) { $("majBarre").style.width = MAJ.pct + "%"; $("majPct").textContent = MAJ.pct + " %"; $("majEtape").textContent = MAJ.etape; }
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", function (e) {
    var m = e.data || {};
    if (m.type !== "majProgres" || !MAJ.encours) return;
    if (m.etape === "telechargement") progresMaj(15 + 70 * (m.fait / Math.max(1, m.total)), "Téléchargement de la version " + court(m.version) + " (" + m.fait + " / " + m.total + " fichiers)…");
    else if (m.etape === "installation") progresMaj(90, "Installation…");
  });
  function installerMaj() {
    if (MAJ.encours) return;
    if (!navigator.onLine) { ecranMaj("hors"); return; }
    MAJ.encours = true; MAJ.pct = 0; MAJ.etape = "Recherche de la nouvelle version…";
    ecranMaj("encours"); progresMaj(5);
    try { localStorage.setItem("majEssais", String((+localStorage.getItem("majEssais") || 0) + 1));
          localStorage.setItem("majAvant", JSON.stringify({ de: VERSION_APP, attente: S.file.length, t: Date.now() })); } catch (e) {}
    var fini = false;
    function recharger() { if (fini) return; fini = true; progresMaj(100, "Redémarrage…"); setTimeout(function () { location.reload(); }, 600); }
    if (!("serviceWorker" in navigator)) { recharger(); return; }
    navigator.serviceWorker.addEventListener("controllerchange", recharger);
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) return recharger();
      progresMaj(10);
      return reg.update().then(function () {
        var w = reg.installing || reg.waiting;
        if (w) { progresMaj(15, "Téléchargement de la nouvelle version…"); w.addEventListener("statechange", function () { if (w.state === "activated") recharger(); }); if (reg.waiting) reg.waiting.postMessage({ type: "activer" }); }
        else progresMaj(20, "Vérification sur le serveur…");
      });
    }).catch(function () {});
    // Filet : après 25 s, vider le cache des fichiers de l'app (pas les données) et recharger depuis le réseau.
    setTimeout(function () {
      if (fini) return;
      progresMaj(80, "Rechargement depuis le serveur…");
      (window.caches ? caches.keys().then(function (k) { return Promise.all(k.map(function (c) { return caches.delete(c); })); }) : Promise.resolve()).then(recharger, recharger);
    }, 25000);
  }
  /* Après le redémarrage : panneau « ✅ DuoCore est à jour » (version, nouveautés, saisies envoyées) ou échec. */
  function panneauMajReussie(av) {
    var o = document.createElement("div");
    o.id = "panneauMaj";
    o.style.cssText = "position:fixed;inset:0;z-index:130;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px";
    o.onclick = function (e) { if (e.target === o) o.remove(); };   // toucher en dehors = fermer
    o.innerHTML = "<div class='carte' style='max-width:460px;width:100%;max-height:85vh;display:flex;flex-direction:column;text-align:center;margin:0'>" +
      "<div style='overflow-y:auto;flex:1;min-height:0'><div style='font-size:38px'>✅</div><h3 style='justify-content:center'>DuoCore est à jour</h3>" +
      "<div>Version <b>" + esc(court(VERSION_APP)) + "</b> installée" + (av.de ? " (avant : " + esc(court(av.de)) + ")" : "") + ".</div>" +
      (NOUVEAUTES.length ? "<div style='text-align:left;margin-top:10px;font-size:14px'><b>Nouveautés</b><ul style='padding-left:20px;margin:6px 0'>" + NOUVEAUTES.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>" : "") +
      (av.attente ? "<div class='info' id='pmEnv' style='margin-top:8px'>📤 Envoi des " + av.attente + " saisie(s) en attente…</div>" : "") +
      "</div><button class='bouton' id='pmOk' style='margin-top:10px;flex:0 0 auto'>OK</button></div>";
    document.body.appendChild(o);
    $("pmOk").onclick = function () { o.remove(); };
    if (av.attente) lancerEnvoi().then(function () {
      var reste = S.file.length, env = Math.max(0, av.attente - reste);
      if ($("pmEnv")) $("pmEnv").textContent = "📤 " + env + " saisie(s) en attente envoyée(s)" + (reste ? " · " + reste + " encore en attente (réseau)" : "") + ".";
    });
  }
  function verifierMajAuDemarrage() {
    var av = null; try { av = JSON.parse(localStorage.getItem("majAvant") || "null"); } catch (e) {}
    if (av && av.de && String(av.de) < String(VERSION_APP)) {
      try { localStorage.removeItem("majAvant"); localStorage.removeItem("majEssais"); } catch (e) {}
      setTimeout(function () { panneauMajReussie(av); }, 400);
    } else if (av && av.de === VERSION_APP) { try { localStorage.removeItem("majAvant"); } catch (e) {} setTimeout(function () { if (S.majRequise && plusAncienne(S.majRequise)) ecranMaj("echec"); }, 500); }
    return lire("majRequise").then(function (v) {
      if (v && plusAncienne(v)) { S.majRequise = v; ecranMaj(); }
      else if (v) { S.majRequise = null; ecrire("majRequise", null); try { localStorage.removeItem("majEssais"); } catch (e) {} }
    });
  }

  /* ⚡ Nouveautés des autres téléphones : chaque réponse du serveur porte les horloges de changement par rubrique ;
     l'app vérifie aussi toutes les 30 s (écran visible). Rubrique changée → rechargée, cloche et écran de liste mis à jour. */
  var VERS = { connu: null, verif: 0, cours: false };
  var VERS_RAF = { fin: function () { return droitFin() ? rafraichirFin() : null; }, rh: function () { return droitRH() ? rafraichirRH() : null; },
    mis: function () { return droitMis() ? rafraichirMis() : null; }, com: function () { return droitCom() ? rafraichirCom() : null; },
    stockv: function () { return droitStockVal() ? rafraichirStockVal() : null; } };
  var VERS_ECRANS = { fin: ["afficherFinances"], rh: ["afficherRH"], mis: ["afficherMis"], com: ["afficherCom"], stockv: ["afficherStockVal", "afficherMagasins"] };
  function comparerVersions(v) {
    if (!v || !S.agent) return;
    if (!VERS.connu) { VERS.connu = v; return; }
    var chg = Object.keys(VERS_RAF).filter(function (k) { return v[k] && v[k] > (VERS.connu[k] || 0); });
    VERS.connu = v;
    if (!chg.length) return;
    var P = chg.map(function (k) { var x = VERS_RAF[k](); return x ? x.catch(function () {}) : null; });
    Promise.all(P).then(function () {
      majCloche();
      if ($("vueAccueil").style.display !== "none") { majAccueil(); return; }
      var e = NAV.pile[NAV.pile.length - 1], act = document.activeElement, saisie = act && /INPUT|TEXTAREA|SELECT/.test(act.tagName);
      if (e && !saisie && chg.some(function (k) { return VERS_ECRANS[k].indexOf(e.n) >= 0; }) && !e.a.length) { NAV.retour = true; try { NAV_FN[e.n].apply(null, e.a); } finally { NAV.retour = false; } }
    });
  }
  function verifierNouveautes() {
    if (VERS.cours || !S.url || !S.agent || !navigator.onLine || document.visibilityState === "hidden" || Date.now() - VERS.verif < 25000) return;
    VERS.cours = true; VERS.verif = Date.now();
    requeteBrute(S.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow",
      body: JSON.stringify({ api: "versions", agent: S.agent.nom, code: S.agent.code }) }, 20000).then(function () {}, function () {}).then(function () { VERS.cours = false; });
  }
  setInterval(verifierNouveautes, 30000);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") { VERS.verif = 0; verifierNouveautes(); } });
  function surReponseSecurite(r) {
    if (r && r.versions) setTimeout(function () { comparerVersions(r.versions); }, 0);
    if (r && r.appRequise && plusAncienne(r.appRequise)) declencherMaj(r.appRequise);
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
  /* ---------- 🏭 Suivi atelier : Journal Prod (vérifier les scans) et État d'avancement ---------- */
  var JRN = { du: "", au: "", op: "", q: "", etape: "", anom: false, vue: "liste", data: null };
  function isoJour(t) { var d = new Date(t); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function afficherJournal() {
    $("titre").textContent = "Journal Prod";
    if (!JRN.du) { JRN.du = isoJour(Date.now() - 86400000); JRN.au = isoJour(Date.now()); }
    function dessiner(msg) {
      var R = JRN.data, L = R ? R.lignes : [], ops = [], ets = [];
      L.forEach(function (x) { if (x.operateur && ops.indexOf(x.operateur) < 0) ops.push(x.operateur); if (x.poste && ets.indexOf(x.poste) < 0) ets.push(x.poste); });
      ops.sort(); ets.sort();
      var q = JRN.q.trim().toLowerCase();
      var F = L.filter(function (x) { return (!JRN.op || x.operateur === JRN.op) && (!JRN.etape || x.poste === JRN.etape) && (!JRN.anom || x.anomalies.length) &&
        (!q || (x.bdc + " " + x.cle + " " + x.article).toLowerCase().indexOf(q) >= 0); });
      var nA = F.filter(function (x) { return x.anomalies.length; }).length;
      function o(L2, v, vide) { return "<option value=''>" + vide + "</option>" + L2.map(function (x) { return "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; }).join(""); }
      var h = "<div class='carte pleine'><h3>🧾 Journal Prod · vérifier les scans</h3>" +
        "<div class='ligne'><div><label>Du</label><input type='date' id='jrDu' value='" + JRN.du + "'></div><div><label>Au</label><input type='date' id='jrAu' value='" + JRN.au + "'></div></div>" +
        "<div class='ligne'><select id='jrOp'>" + o(ops, JRN.op, "Tous les opérateurs") + "</select><select id='jrEt'>" + o(ets, JRN.etape, "Toutes les étapes") + "</select></div>" +
        "<input id='jrQ' placeholder='Lot, BDC ou article' value='" + esc(JRN.q) + "'>" +
        "<label style='font-weight:400'><input type='checkbox' id='jrAn' style='width:auto'" + (JRN.anom ? " checked" : "") + "> anomalies seulement</label>" +
        "<div class='ligne'><button class='bouton" + (JRN.vue === "liste" ? "" : " second") + "' id='jrL'>📋 Scans (" + F.length + ")</button><button class='bouton" + (JRN.vue === "total" ? "" : " second") + "' id='jrT'>👷 Total par opérateur</button></div>" +
        "<div class='info'>" + (R ? "Données du " + dateCourte(R.genere) + (R.tronque ? " · limité aux 3000 derniers scans : réduisez la période" : "") : "") + (nA ? " · <b style='color:#c62828'>⚠️ " + nA + " anomalie(s)</b>" : "") + (msg ? " · " + esc(msg) : "") + "</div></div>";
      if (JRN.vue === "total") {
        var T = {}, et2 = [];
        F.forEach(function (x) { if (!x.compte || !x.quantite) return; var k = x.operateur || "?"; T[k] = T[k] || { tot: 0, n: 0, p: {} }; T[k].tot += x.quantite; T[k].n++; T[k].p[x.poste] = (T[k].p[x.poste] || 0) + x.quantite; });
        h += Object.keys(T).sort(function (a, b) { return T[b].tot - T[a].tot; }).map(function (k) {
          return "<div class='carte'><div class='ligne' style='justify-content:space-between'><b>👷 " + esc(k) + "</b><b style='flex:0;white-space:nowrap'>" + gnf(T[k].tot) + "</b></div>" +
            "<div class='info'>" + T[k].n + " déclaration(s) comptabilisée(s)</div><table>" + Object.keys(T[k].p).sort().map(function (e) { return "<tr><td>" + esc(e) + "</td><td class='v'>" + gnf(T[k].p[e]) + "</td></tr>"; }).join("") + "</table></div>";
        }).join("") || "<p class='info' style='padding:0 4px'>Aucune quantité sur la période.</p>";
      } else {
        h += F.slice(0, 400).map(function (x) {
          return "<div class='carte'" + (x.anomalies.length ? " style='border-color:#c62828'" : "") + "><div class='ligne' style='justify-content:space-between'><b>" + esc(x.bdc) + " · " + esc(x.cle) + "</b>" +
            "<span style='flex:0;white-space:nowrap' class='info'>" + dateCourte(x.date) + "</span></div>" +
            "<div>" + esc(x.poste) + (x.passage > 1 ? " · passage " + x.passage : "") + " · <b>" + esc(x.evenement) + "</b>" + (x.quantite ? " · " + gnf(x.quantite) : "") + (x.dispo !== "" ? " <span class='info'>(dispo " + gnf(x.dispo) + ")</span>" : "") + "</div>" +
            "<div class='info'>👷 " + esc(x.operateur || "?") + (x.article ? " · " + esc(x.article) : "") + " · ligne " + x.ligne + "</div>" +
            x.anomalies.map(function (a) { return "<div style='color:#c62828;font-size:13px'>⚠️ " + esc(a) + "</div>"; }).join("") + "</div>";
        }).join("") || "<p class='info' style='padding:0 4px'>" + (R ? "Aucun scan." : "Réseau nécessaire.") + "</p>";
        if (F.length > 400) h += "<p class='info' style='padding:0 4px'>400 premiers affichés sur " + F.length + " : filtrez davantage.</p>";
      }
      $("vueListe").innerHTML = h; montrer("vueListe");
      function lire() { JRN.op = $("jrOp").value; JRN.etape = $("jrEt").value; JRN.q = $("jrQ").value; JRN.anom = $("jrAn").checked; }
      $("jrOp").onchange = $("jrEt").onchange = $("jrAn").onchange = function () { lire(); dessiner(""); };
      $("jrQ").onchange = function () { lire(); dessiner(""); };
      $("jrL").onclick = function () { lire(); JRN.vue = "liste"; dessiner(""); };
      $("jrT").onclick = function () { lire(); JRN.vue = "total"; dessiner(""); };
      $("jrDu").onchange = $("jrAu").onchange = function () { lire(); JRN.du = $("jrDu").value; JRN.au = $("jrAu").value; charger(); };
    }
    function charger() {
      dessiner("⏳ chargement…");
      api({ api: "suiviAtelier", vue: "journal", du: JRN.du, au: JRN.au }, 90000).then(function (r) { JRN.data = r; dessiner(""); }, function (e) { dessiner("⛔ " + e.message + " (réseau nécessaire)"); });
    }
    charger();
  }
  var AVC = { q: "", data: null, termines: false, lotsFinis: false, ouv: {}, det: {} };
  function afficherAvancement(bdcOuvert) {
    $("titre").textContent = "État d'avancement";
    if (bdcOuvert) AVC.ouv["b|" + bdcOuvert] = true;
    var C = { ok: "#2e7d32", cours: "#e67e22", todo: "#b0b0b0" };
    function couleur(pc) { return pc >= 100 ? "#2e7d32" : pc > 0 ? "#e67e22" : "#b0b0b0"; }
    function barre(pc, w) { return "<div style='flex:" + (w ? "0 0 " + w : "1") + ";height:9px;background:var(--bord);border-radius:6px;overflow:hidden'><div style='height:100%;width:" + pc + "%;background:" + couleur(pc) + "'></div></div>"; }
    function pcLot(x) { return x.fini >= x.nb ? 100 : Math.round((x.ratio || 0) * 100); }
    function niv(x) { return typeof x.niveau === "number" ? x.niveau : Math.max(0, String(x.cle).length - 1); }
    function pastilles(x) { return x.etapes.map(function (e) { return "<span title='" + esc(e.nom + (e.texte ? " · " + e.texte : "")) + "' style='display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;font-size:10px;border-radius:50%;margin-right:2px;color:#fff;background:" + C[e.st] + "'>" + (e.st === "ok" ? "✓" : e.st === "cours" ? "●" : "") + "</span>"; }).join(""); }
    // Groupes : un lot de niveau 0 (A, B, C…) ouvre un groupe ; ses sous-lots (A1, A11…) le suivent.
    function groupes(lots) {
      var G = [];
      lots.forEach(function (x) { if (!G.length || niv(x) === 0) G.push({ cle: x.cle, lots: [] }); G[G.length - 1].lots.push(x); });
      G.forEach(function (g) { g.pc = Math.round(g.lots.reduce(function (t, x) { return t + pcLot(x); }, 0) / g.lots.length); g.finis = g.lots.filter(function (x) { return pcLot(x) >= 100; }).length; });
      return G;
    }
    // Récapitulatif par étape (tous lots et sous-lots) : réalisé / restant en lots, passages et unités.
    function recapEtapes(b) {
      if (!b.recap || !b.recap.length) return "";
      function rr(f, p, u) { return "<b>" + gnf(f) + "</b> <span style='color:#999'>/ " + gnf(Math.max(0, p - f)) + "</span>" + (u ? " <small>" + esc(u) + "</small>" : ""); }
      return "<div style='margin:8px 0 0 22px;overflow-x:auto' onclick='event.stopPropagation()'><table style='width:100%;border-collapse:collapse;font-size:12.5px'>" +
        "<tr style='color:var(--muet,#888);text-align:left'><th style='padding:2px 6px'>Étape</th><th style='padding:2px 6px'>Lots<br><small>réalisés / restants</small></th>" +
        "<th style='padding:2px 6px'>Passages<br><small>réalisés / restants</small></th><th style='padding:2px 6px'>Unités<br><small>réalisées / restantes</small></th><th style='padding:2px 6px;width:22%'></th></tr>" +
        b.recap.map(function (e) {
          var pc = e.valid ? (e.lots ? Math.round(e.lotsF / e.lots * 100) : 0) : e.uP ? Math.round(e.uF / e.uP * 100) : (e.pP ? Math.round(e.pF / e.pP * 100) : 0);
          if (e.lotsF >= e.lots) pc = 100;
          return "<tr style='border-top:1px solid var(--bord)'><td style='padding:3px 6px;white-space:nowrap'><span style='color:" + couleur(pc) + "'>" + (pc >= 100 ? "✓" : pc > 0 ? "●" : "○") + "</span> " + esc(e.nom) + "</td>" +
            "<td style='padding:3px 6px;white-space:nowrap'>" + rr(e.lotsF, e.lots) + "</td>" +
            "<td style='padding:3px 6px;white-space:nowrap'>" + (e.valid ? "—" : rr(e.pF, e.pP)) + "</td>" +
            "<td style='padding:3px 6px;white-space:nowrap'>" + (e.valid || !e.uP ? "—" : rr(e.uF, e.uP, e.unite)) + "</td>" +
            "<td style='padding:3px 6px'><div class='ligne' style='gap:6px;align-items:center'>" + barre(pc) + "<small style='flex:0 0 34px;text-align:right'>" + pc + "%</small></div></td></tr>";
        }).join("") + "</table></div>";
    }
    function dessiner(msg) {
      var R = AVC.data, L = R ? R.bdcs : [], q = AVC.q.trim().toLowerCase();
      function trouve(x) { return !q || (x.cle + " " + x.designation).toLowerCase().indexOf(q) >= 0; }
      var F = L.filter(function (b) { return (AVC.termines || !b.termine) && (!q || b.bdc.toLowerCase().indexOf(q) >= 0 || b.lots.some(trouve)); });
      var h = "<div class='carte pleine'><h3>📊 État d'avancement</h3><input id='avQ' placeholder='Rechercher un BDC, un lot, un article' value='" + esc(AVC.q) + "'>" +
        "<label style='font-weight:400'><input type='checkbox' id='avL' style='width:auto'" + (AVC.lotsFinis ? " checked" : "") + "> afficher les lots terminés</label>" +
        "<label style='font-weight:400'><input type='checkbox' id='avT' style='width:auto'" + (AVC.termines ? " checked" : "") + "> afficher les BDC terminés (30 derniers jours)</label>" +
        "<div class='info'>" + (R ? F.length + " BDC · données du " + dateCourte(R.genere) : "") + (msg ? " · " + esc(msg) : "") +
        " · <span style='color:#2e7d32'>✓ fait</span> <span style='color:#e67e22'>● en cours</span> <span style='color:#999'>○ à faire</span></div></div>";
      h += "<div class='carte pleine' style='padding:4px 0'>" + (F.map(function (b) {
        var kb = "b|" + b.bdc, ob = !!AVC.ouv[kb] || !!q, pc = b.termine ? 100 : Math.round(b.ratio * 100);
        var nf = b.lots.filter(function (x) { return pcLot(x) >= 100; }).length;
        var t = "<div data-k='" + esc(kb) + "' style='cursor:pointer;padding:10px 12px;border-bottom:1px solid var(--bord)'>" +
          "<div class='ligne' style='gap:8px;align-items:center'><span style='flex:0 0 14px'>" + (ob ? "▼" : "▶") + "</span><b style='flex:1;min-width:0'>📄 " + esc(b.bdc) + "</b><b style='flex:0;white-space:nowrap;color:" + couleur(pc) + "'>" + (b.termine ? "✔" : pc + " %") + "</b></div>" +
          "<div class='ligne' style='gap:8px;align-items:center;margin:6px 0 0 22px'>" + barre(pc) + "</div>" +
          "<div class='info' style='margin-left:22px'>" + nf + " / " + b.lots.length + " lot(s) terminé(s)" + (b.commande ? " · livré " + gnf(b.livre) + " / " + gnf(b.commande) : "") + (b.dernier ? " · dernier scan " + dateCourte(b.dernier) : "") + "</div>" + recapEtapes(b) + "</div>";
        if (!ob) return t;
        var G = groupes(b.lots), caches = 0;
        t += G.map(function (g) {
          var vis = g.lots.filter(function (x) { return (AVC.lotsFinis || pcLot(x) < 100) && trouve(x); });
          if (!vis.length) { caches++; return ""; }
          var kg = kb + "|" + g.cle, og = !!AVC.ouv[kg] || !!q;
          var r = "<div data-k='" + esc(kg) + "' style='cursor:pointer;padding:8px 12px 8px 34px;border-bottom:1px solid var(--bord);background:var(--fond)'>" +
            "<div class='ligne' style='gap:8px;align-items:center'><span style='flex:0 0 14px'>" + (og ? "▼" : "▶") + "</span><b style='flex:0 0 auto'>" + esc(g.cle) + "</b>" +
            "<span class='info' style='flex:0 0 auto;margin:0'>(" + g.lots.length + " lot" + (g.lots.length > 1 ? "s" : "") + (g.finis ? ", " + g.finis + " ✔" : "") + ")</span>" + barre(g.pc) +
            "<b style='flex:0 0 44px;text-align:right;color:" + couleur(g.pc) + "'>" + g.pc + " %</b></div></div>";
          if (og) r += vis.map(function (x) {
            var kl = kg + "|" + x.cle, p2 = pcLot(x), od = !!AVC.det[kl];
            return "<div data-d='" + esc(kl) + "' style='cursor:pointer;padding:6px 12px 6px " + (56 + Math.max(0, niv(x) - 1) * 12) + "px;border-bottom:1px solid var(--bord)'>" +
              "<div class='ligne' style='gap:8px;align-items:center'><b style='flex:0 0 46px'>" + esc(x.cle) + "</b><span style='flex:1;white-space:nowrap'>" + pastilles(x) + "</span>" +
              "<b style='flex:0 0 44px;text-align:right;color:" + couleur(p2) + "'>" + p2 + " %</b></div>" +
              (od ? "<div class='info' style='margin:4px 0 0'>" + esc(x.designation) + (x.quantite ? " · " + gnf(x.quantite) : "") + " · " + x.fini + "/" + x.nb + " étapes" +
                (x.dernier ? "<br>Dernier : " + esc(x.dernier.poste) + " " + esc(x.dernier.evenement) + " (" + esc(x.dernier.operateur) + ", " + dateCourte(x.dernier.date) + ")" : "") + "<br>" +
                x.etapes.map(function (e) { return "<span style='color:" + C[e.st] + "'>" + (e.st === "ok" ? "✓" : e.st === "cours" ? "●" : "○") + " " + esc(e.nom) + (e.st === "cours" && e.texte ? " · " + esc(e.texte) : "") + "</span>"; }).join(" &nbsp; ") + "</div>" : "") + "</div>";
          }).join("");
          return r;
        }).join("");
        if (caches) t += "<div class='info' style='padding:6px 12px 8px 34px;border-bottom:1px solid var(--bord)'>✔ " + caches + " groupe(s) terminé(s) masqué(s)</div>";
        return t;
      }).join("") || "<p class='info' style='padding:0 12px'>" + (R ? "Aucun BDC en cours." : "Réseau nécessaire.") + "</p>") + "</div>";
      $("vueListe").innerHTML = h; montrer("vueListe");
      $("avQ").onchange = function () { AVC.q = $("avQ").value; dessiner(""); };
      $("avT").onchange = function () { AVC.termines = $("avT").checked; dessiner(""); };
      $("avL").onchange = function () { AVC.lotsFinis = $("avL").checked; dessiner(""); };
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-k]"), function (el) { el.onclick = function () { var k = el.getAttribute("data-k"); AVC.ouv[k] = !AVC.ouv[k]; dessiner(""); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-d]"), function (el) { el.onclick = function () { var k = el.getAttribute("data-d"); AVC.det[k] = !AVC.det[k]; dessiner(""); }; });
    }
    dessiner(AVC.data ? "mise à jour…" : "⏳ chargement…");
    api({ api: "suiviAtelier", vue: "avancement" }, 90000).then(function (r) { AVC.data = r; dessiner(""); }, function (e) { dessiner("⛔ " + e.message + " (réseau nécessaire)"); });
  }

  /* ---------- 📊 Répartition (DG, WALID) : événements, factures (cascade), commissions par bénéficiaire, balances, paramètres ---------- */
  var REPV = { onglet: "ev", ouv: {}, fiche: null, rat: null, pay: null, clos: false, grp: false };
  function repEvClos(D) { var c = {}; (D.evs || []).forEach(function (e) { if (e.clos) c[e.id] = 1; }); return c; }
  function droitRep() { return !!(S.agent && ["DG", "WALID"].indexOf(String(S.agent.nom).toUpperCase()) >= 0); }
  function rafraichirRep(corps) {
    if (!S.url) return Promise.reject(new Error("adresse du serveur inconnue"));
    var c = corps || {}; c.api = "repartition";
    return api(c, 300000).then(function (r) { r.recu = Date.now(); S.rep = r; ecrire("rep", r); return r; });
  }
  function repPct(x) { return x === "" || x === null || x === undefined || isNaN(x) ? "" : (Math.round(x * 1000) / 10).toString().replace(".", ",") + " %"; }
  function repOpts(L, v, vide) { return (vide !== undefined ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { var val = typeof x === "object" ? x.v : x, lib = typeof x === "object" ? x.l : x; return "<option value='" + esc(val) + "'" + (val === v ? " selected" : "") + ">" + esc(lib) + "</option>"; }).join(""); }
  // Bénéficiaires : Emna (interne), démarcheurs (par contrat, Paramétrage col. L), Trésor, attribution.
  function repBenef(D) {
    var F = D.factures.filter(function (f) { return !f.prev; }), B = {}, evB = {}, cB = {};
    function b(id, nom, type, du) { return B[id] || (B[id] = { id: id, nom: nom, type: type, du: du, mv: [] }); }
    F.forEach(function (f) { var n = f.benef || "Démarcheur (non précisé)"; if (f.ev && !evB[f.ev]) evB[f.ev] = n; if (!cB[f.t[2]]) cB[f.t[2]] = n; });
    F.forEach(function (f) {
      if (f.t[12]) b("emna", "Emna", "Commission interne", true).mv.push({ d: f.t[0], lib: "Dû · " + f.t[1], du: f.t[12], v: 0, ev: f.ev });
      if (f.t[5]) { var n = f.benef || "Démarcheur (non précisé)"; b("ext:" + n, n, "Démarchage externe", true).mv.push({ d: f.t[0], lib: "Dû · " + f.t[1], du: f.t[5], v: 0, ev: f.ev }); }
    });
    D.com.forEach(function (x) {
      if (x.hors) return;
      var o = x.ty === "Commission interne" ? b("emna", "Emna", "Commission interne", true)
        : x.ty === "Démarchage externe" ? (function () { var n = evB[x.ev] || cB[x.c] || "Démarcheur (non précisé)"; return b("ext:" + n, n, "Démarchage externe", true); })()
        : x.ty === "Commission directe (Trésor)" ? b("tres", "Trésor (commission directe)", "Commission directe (Trésor)", false)
        : x.ty === "Commission d'attribution" ? b("attr", "Commission d'attribution", "Commission d'attribution", false) : b("nr", "Versements sans type", "", false);
      o.mv.push({ d: x.d, lib: "Versé · " + (x.mo || "").substring(0, 70), du: 0, v: x.m, ev: x.ev, src: x.src, ty: x.ty });
    });
    // Événements clôturés (situation soldée / 🔒) : regroupés en une ligne « Report ». Emna : solde reporté (à payer) ;
    // démarchage, Trésor, attribution : soldés à la clôture (report 0).
    var EC = repEvClos(D), fin = D.p && D.p.soldeAu ? D.p.soldeAu + 86399000 : 0;
    return Object.keys(B).map(function (k) {
      var o = B[k]; o.mv.sort(function (a, c) { return a.d - c.d || (c.du - a.du); });
      var clos = o.mv.filter(function (m) { return m.ev ? !!EC[m.ev] : (fin && m.d <= fin); }), ouv = o.mv.filter(function (m) { return clos.indexOf(m) < 0; });
      if (clos.length) {
        var rep = clos.reduce(function (t, m) { return t + m.du - m.v; }, 0), garde = k === "emna";
        o.hist = clos;
        o.mv = [{ d: clos[clos.length - 1].d, lib: "🔒 Report des événements clôturés (" + clos.filter(function (m) { return m.v; }).length + " versement(s))" + (garde ? (rep >= 0 ? " — reste dû à payer" : " — avance") : " — soldé à la clôture"),
          du: garde && rep > 0 ? rep : 0, v: garde && rep < 0 ? -rep : 0, report: true }].concat(ouv);
      }
      var s = 0; o.mv.forEach(function (m) { if (m.raz) s = 0; else s += m.du - m.v; m.solde = s; });
      o.tDu = o.mv.reduce(function (t, m) { return t + m.du; }, 0); o.tV = o.mv.reduce(function (t, m) { return t + m.v; }, 0); o.solde = s;
      return o;
    }).filter(function (o) { return o.mv.length; }).sort(function (a, c) { return (a.id === "emna" ? 0 : a.du ? 1 : 2) - (c.id === "emna" ? 0 : c.du ? 1 : 2) || c.tV - a.tV; });
  }
  function afficherRepartition(onglet) {
    if (onglet) REPV.onglet = onglet;
    $("titre").textContent = "Répartition";
    var ONG = [["ev", "📅 Événements"], ["fac", "🧾 Factures"], ["com", "💼 Commissions"], ["bal", "⚖️ Balances"], ["par", "⚙️ Paramètres"]];
    function ligneV(lib, v, cl) { return "<tr" + (cl ? " style='font-weight:700;border-top:1px solid var(--bord)'" : "") + "><td style='padding:3px 0'>" + lib + "</td><td style='text-align:right;white-space:nowrap'>" + v + "</td></tr>"; }
    function dessiner(msg) {
      var R = S.rep, D = R && R.data, h = "<div class='carte pleine'><h3>📊 Répartition des recouvrements</h3><div class='ligne' style='flex-wrap:wrap;gap:6px'>" +
        ONG.map(function (o) { return "<button class='bouton" + (REPV.onglet === o[0] ? "" : " second") + "' data-g='" + o[0] + "' style='flex:0 0 auto;width:auto;padding:8px 12px;margin:0'>" + o[1] + "</button>"; }).join("") +
        "<button class='bouton second' id='rpRec' style='flex:0 0 auto;width:auto;padding:8px 12px;margin:0'>🔄 Recalculer</button></div>" +
        "<div class='info'>" + (D ? "Calculé le " + dateCourte(D.genere) : "") + (msg ? " · " + esc(msg) : "") + "</div></div>";
      if (D) h += ({ ev: vueEv, fac: vueFac, com: vueCom, bal: vueBal, par: vuePar }[REPV.onglet])(R, D);
      else h += "<p class='info'>" + (R ? "Aucune donnée : lancez 🔄 Recalculer." : "Réseau nécessaire.") + "</p>";
      $("vueListe").innerHTML = h; montrer("vueListe");
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-g]"), function (b) { b.onclick = function () { REPV.onglet = b.getAttribute("data-g"); REPV.fiche = null; dessiner(""); }; });
      $("rpRec").onclick = function () { envoyer({ op: "recalculer" }); };
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-o]"), function (el) { el.onclick = function () { var k = el.getAttribute("data-o"); REPV.ouv[k] = !REPV.ouv[k]; dessiner(""); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-f]"), function (el) { el.onclick = function () { REPV.fiche = el.getAttribute("data-f"); dessiner(""); window.scrollTo(0, 0); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-rat]"), function (el) { el.onclick = function (e) { e.stopPropagation(); REPV.rat = REPV.rat === el.getAttribute("data-rat") ? null : el.getAttribute("data-rat"); dessiner(""); }; });
      if ($("rtOk")) $("rtOk").onclick = function () { envoyer({ op: "rattacher", src: REPV.rat, ev: $("rtEv").value, type: $("rtTy").value }, function () { REPV.rat = null; }); };
      if ($("pyOk")) $("pyOk").onclick = payer;
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-sur]"), function (b) { b.onclick = function () { transfererSurplus(b.getAttribute("data-sur")); }; });
      if ($("evCl")) $("evCl").onchange = function () { REPV.clos = $("evCl").checked; dessiner(""); };
      if ($("evNv")) $("evNv").onclick = function () { REPV.grp = !REPV.grp; dessiner(""); };
      if ($("evGrOk")) $("evGrOk").onclick = function () {
        var L = Array.prototype.filter.call(document.querySelectorAll(".evGr"), function (c) { return c.checked; }).map(function (c) { return { id: c.getAttribute("data-id"), d: +c.getAttribute("data-d") }; });
        if (L.length < 2) { alert("⛔ Cochez au moins deux règlements."); return; }
        if (!confirm("Regrouper " + L.length + " règlement(s) en un seul événement ?")) return;
        envoyer({ op: "grouper", regl: L }, function () { REPV.grp = false; });
      };
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-evc]"), function (b) { b.onclick = function () { var ev = b.getAttribute("data-evc");
        if (confirm("Clôturer " + ev + " ?\n\n• Ses factures disparaissent des Paramètres et des listes.\n• Démarchage, Trésor et attribution de l'événement sont considérés soldés.\n• Le solde d'Emna est reporté (à payer).")) envoyer({ op: "cloturerEv", ev: ev }); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-evr]"), function (b) { b.onclick = function () { var ev = b.getAttribute("data-evr"); if (confirm("Rouvrir " + ev + " ?")) envoyer({ op: "rouvrirEv", ev: ev }); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-evd]"), function (b) { b.onclick = function () { var ev = b.getAttribute("data-evd"); if (confirm("Dégrouper " + ev + " (un événement par jour et par client) ?")) envoyer({ op: "degrouper", ev: ev }); }; });
      if ($("rpFermer")) $("rpFermer").onclick = function () { REPV.fiche = null; dessiner(""); };
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-gl]"), function (b) { b.onclick = function () { var k = b.getAttribute("data-gl"); envoyer({ op: "param", glob: +k, valeur: $("gl" + k).value }); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-pr]"), function (b) { b.onclick = function () {
        var row = +b.getAttribute("data-pr"), chg = [];
        Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-row='" + row + "']"), function (inp) { if (inp.value !== inp.getAttribute("data-v")) chg.push({ col: +inp.getAttribute("data-col"), valeur: inp.value }); });
        if (!chg.length) { alert("Aucune modification sur cette ligne."); return; }
        var p = Promise.resolve();
        chg.forEach(function (c, i) { p = p.then(function () { return rafraichirRep({ op: "param", row: row, col: c.col, valeur: c.valeur }).then(function (r) { if (i === chg.length - 1) alert("✅ " + (r.message || "Enregistré")); }); }); });
        p.then(function () { dessiner(""); }, function (e) { alert("⛔ " + e.message); dessiner(""); });
      }; });
    }
    function envoyer(c, ok) {
      rafraichirRep(c).then(function (r) { if (ok) ok(); if (r.message) alert("✅ " + r.message); dessiner(""); }, function (e) { alert("⛔ " + e.message + " (réseau nécessaire)"); dessiner(""); });
    }
    function evOpts(D, v) { return repOpts(D.evs.map(function (e) { return { v: e.id, l: e.id + " · " + jourFr(e.date) + " · " + e.client }; }).concat([{ v: "Hors contrat", l: "Hors contrat (non réparti)" }]), v, "— sans événement —"); }
    function blocRat(D, x) {
      if (REPV.rat !== x.src) return "";
      return "<div class='carte' style='margin:6px 0;background:var(--fond)'><b>🔗 Rattacher ce versement</b><div class='ligne'><div><label>Événement</label><select id='rtEv'>" + evOpts(D, x.ev) + "</select></div>" +
        "<div><label>Type</label><select id='rtTy'>" + repOpts(S.rep.types, x.ty, "—") + "</select></div></div><button class='bouton' id='rtOk'>✅ Enregistrer</button></div>";
    }
    function ligneCom(D, x) {
      return "<div style='padding:6px 0;border-top:1px solid var(--bord)'><div class='ligne' style='justify-content:space-between;gap:8px'><span style='flex:1;min-width:0'>" + jourFr(x.d) + " · " + esc(x.ty || "sans type") + (x.ev ? " · " + esc(x.ev) : x.hors ? " · hors contrat" : " · ⚠️ sans événement") +
        "<br><small class='info'>" + esc((x.mo || "").substring(0, 90)) + " · " + esc(x.src) + "</small></span><b style='flex:0;white-space:nowrap'>" + gnf(x.m) + "</b>" +
        "<button class='bouton second' data-rat='" + esc(x.src) + "' style='flex:0 0 auto;padding:4px 8px'>🔗</button></div>" + blocRat(D, x) + "</div>";
    }
    // 📅 Événements
    function vueEv(R, D) {
      var EC = repEvClos(D), nC = D.evs.filter(function (e) { return e.clos; }).length;
      var tete = "<div class='carte pleine'><div class='ligne' style='flex-wrap:wrap;gap:6px;align-items:center'><button class='bouton' id='evNv' style='flex:0 0 auto;width:auto;margin:0'>➕ Nouvel événement</button>" +
        "<label style='font-weight:400;flex:1'><input type='checkbox' id='evCl' style='width:auto'" + (REPV.clos ? " checked" : "") + "> afficher les " + nC + " événement(s) clôturé(s)</label></div>";
      if (REPV.grp) {
        var RG = D.factures.filter(function (f) { return !f.prev && f.ev && !EC[f.ev]; });
        tete += "<div class='info'>Cochez les règlements à regrouper en un seul événement (date = dernier règlement).</div>" + (RG.map(function (f, i) {
          return "<label style='font-weight:400;display:block;padding:4px 0;border-top:1px solid var(--bord)'><input type='checkbox' class='evGr' data-id='" + esc(f.t[1]) + "' data-d='" + f.rd + "' style='width:auto'> " +
            jourFr(f.rd) + " · " + esc(f.t[1]) + " · " + gnf(f.t[3]) + " <small class='info'>(" + esc(f.ev) + ")</small></label>"; }).join("") || "<p class='info'>Aucun règlement dans un événement ouvert.</p>") +
          "<button class='bouton' id='evGrOk'>✅ Créer l'événement</button>";
      }
      tete += "</div>";
      return tete + D.evs.filter(function (e) { return REPV.clos || !e.clos; }).map(function (e) {
        var F = D.factures.filter(function (f) { return !f.prev && f.ev === e.id; }), C = D.com.filter(function (x) { return x.ev === e.id && !x.hors; });
        function s(i) { return F.reduce(function (t, f) { return t + (+f.t[i] || 0); }, 0); }
        function v(ty) { return C.filter(function (x) { return x.ty === ty; }).reduce(function (t, x) { return t + x.m; }, 0); }
        var ht = s(4), tot = C.reduce(function (t, x) { return t + x.m; }, 0), o = !!REPV.ouv["e" + e.id];
        return "<div class='carte'" + (e.clos ? " style='opacity:.75'" : "") + "><div data-o='e" + esc(e.id) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + (o ? "▼ " : "▶ ") + (e.clos ? "🔒 " : "") + esc(e.id) + " · " + jourFr(e.date) + " · " + esc(e.client) + "</b><b style='flex:0;white-space:nowrap'>" + gnf(ht) + " HT</b></div>" +
          "<div class='info'>" + esc(e.factures.join(", ")) + "</div>" +
          "<table style='width:100%;font-size:13px;margin-top:4px'>" +
          "<tr><td>Démarchage externe</td><td style='text-align:right'>dû " + gnf(s(5)) + "</td><td style='text-align:right'>versé " + gnf(v("Démarchage externe")) + "</td></tr>" +
          "<tr><td>Emna (interne)</td><td style='text-align:right'>dû " + gnf(s(12)) + "</td><td style='text-align:right'>versé " + gnf(v("Commission interne")) + "</td></tr>" +
          "<tr><td>Trésor · Attribution</td><td></td><td style='text-align:right'>versé " + gnf(v("Commission directe (Trésor)") + v("Commission d'attribution")) + "</td></tr>" +
          "<tr style='font-weight:700'><td>Total versé</td><td></td><td style='text-align:right'>" + gnf(tot) + " · " + (ht ? Math.round(tot / ht * 1000) / 10 : 0) + " %</td></tr></table></div>" +
          (o ? "<div style='margin-top:6px'><b>Versements</b>" + (C.map(function (x) { return ligneCom(D, x); }).join("") || "<p class='info'>Aucun.</p>") + "</div>" + (e.clos ? "" : blocSurplus(D, e.id)) +
            "<div class='ligne' style='gap:6px;flex-wrap:wrap'>" + (e.clos ? "<span class='info' style='flex:1'>🔒 Clôturé (" + esc(e.closPar) + ")</span>" + (e.closPar !== "situation soldée" ? "<button class='bouton second' data-evr='" + esc(e.id) + "' style='width:auto;flex:0 0 auto'>↩️ Rouvrir</button>" : "")
              : "<button class='bouton' data-evc='" + esc(e.id) + "' style='width:auto;flex:0 0 auto'>🔒 Clôturer l'événement</button>") +
            (e.groupe && !e.clos ? "<button class='bouton second' data-evd='" + esc(e.id) + "' style='width:auto;flex:0 0 auto'>✂️ Dégrouper</button>" : "") + "</div>" : "") + "</div>";
      }).join("") + (function () {
        var sans = D.com.filter(function (x) { return !x.ev && !x.hors; }), o = !!REPV.ouv.sans;
        return sans.length ? "<div class='carte' style='border-color:#e67e22'><div data-o='sans' style='cursor:pointer'><b>" + (o ? "▼" : "▶") + " ⚠️ " + sans.length + " versement(s) sans événement</b></div>" + (o ? sans.map(function (x) { return ligneCom(D, x); }).join("") : "") + "</div>" : "";
      })();
    }
    // 🧾 Factures + fiche cascade
    function vueFac(R, D) {
      if (REPV.fiche && REPV.fiche.indexOf("f") === 0) {
        var f = D.factures[+REPV.fiche.substring(1)]; if (f) {
          var t = f.t, x = f.taux;
          return "<div class='carte pleine'><div class='ligne' style='justify-content:space-between'><h3>" + (f.prev ? "⏳ " : "") + esc(t[1]) + "</h3><button class='bouton second' id='rpFermer' style='flex:0 0 auto;width:auto;padding:6px 12px;margin:0'>✕</button></div>" +
            "<div class='info'>" + esc(t[2]) + " · " + (f.prev ? "émise le " + jourFr(t[0]) + " (prévisionnel)" : "réglée le " + jourFr(t[0])) + (f.ev ? " · " + esc(f.ev) : "") + "</div><table style='width:100%;font-size:14px'>" +
            ligneV("Montant (net à payer)", gnf(t[3])) + ligneV("HT (÷ diviseur)", gnf(t[4]), 1) +
            ligneV("− Démarchage externe " + repPct(x.dem), gnf(t[5])) + ligneV("− Commission directe (Trésor)", gnf(t[6])) + ligneV("− Réserve fiscale " + repPct(x.fisc), gnf(t[7])) +
            ligneV("− Attribution + charges AO", gnf(t[8])) + ligneV("− Amortissement stock (plafond " + repPct(x.plSt) + ")", gnf(t[9])) + ligneV("− Amortissement fonds de roulement (plafond " + repPct(x.plCh) + ")", gnf(t[10])) +
            ligneV("▶ Marge brute", gnf(t[11]), 1) + ligneV("− Commission interne " + repPct(x.emna), gnf(t[12])) + ligneV("▶ Marge nette", gnf(t[13]), 1) +
            ligneV("− Réserve fonds de roulement", gnf(t[14])) + ligneV("▶ Bénéfice libre", gnf(t[15]), 1) + "</table>" + (f.note ? "<div class='info'>" + esc(f.note) + "</div>" : "") + "</div>";
        }
      }
      function liste(pv, titre) {
        var EC = repEvClos(D), L = D.factures.map(function (f, i) { return { f: f, i: i }; }).filter(function (z) { return z.f.prev === pv && (REPV.clos || !EC[z.f.ev]); });
        if (!pv) L.reverse();
        var tot = L.reduce(function (s, z) { return s + z.f.t[15]; }, 0);
        return "<div class='carte pleine'><h3>" + titre + " <small class='info'>(" + L.length + " · bénéfice libre " + gnf(tot) + ")</small></h3>" + L.map(function (z) {
          var t = z.f.t;
          return "<div data-f='f" + z.i + "' style='cursor:pointer;padding:6px 0;border-top:1px solid var(--bord)'><div class='ligne' style='justify-content:space-between'><b>" + esc(t[1]) + "</b><b style='flex:0;white-space:nowrap'>" + gnf(t[4]) + " HT</b></div>" +
            "<div class='info'>" + jourFr(t[0]) + (z.f.ev ? " · " + esc(z.f.ev) : "") + " · externe " + gnf(t[5]) + " · Emna " + gnf(t[12]) + " · marge nette " + gnf(t[13]) + "</div></div>";
        }).join("") + "</div>";
      }
      return "<div class='carte pleine'><label style='font-weight:400'><input type='checkbox' id='evCl' style='width:auto'" + (REPV.clos ? " checked" : "") + "> afficher les factures des événements clôturés</label></div>" +
        liste(false, "✅ Factures réglées (événements ouverts)") + liste(true, "⏳ Prévisionnel (factures engagées)");
    }
    // 💼 Commissions par bénéficiaire
    function vueCom(R, D) {
      var B = repBenef(D);
      if (REPV.fiche && REPV.fiche.indexOf("b:") === 0) {
        var o = B.filter(function (x) { return "b:" + x.id === REPV.fiche; })[0];
        if (o) {
          var pay = REPV.pay = { benef: o, ev: "" };
          return "<div class='carte pleine'><div class='ligne' style='justify-content:space-between'><h3>👤 " + esc(o.nom) + "</h3><button class='bouton second' id='rpFermer' style='flex:0 0 auto;width:auto;padding:6px 12px;margin:0'>✕</button></div>" +
            "<div class='info'>" + esc(o.type) + (o.du ? " · dû " + gnf(o.tDu) : "") + " · versé " + gnf(o.tV) + (o.du ? " · <b>" + (o.solde >= 0 ? "reste dû " + gnf(o.solde) : "avance " + gnf(-o.solde)) + "</b>" : "") + "</div>" +
            "<div class='carte' style='background:var(--fond)'><b>💸 Payer</b><div class='ligne'><div><label>Événement</label><select id='pyEv'>" + evOpts(D, (function () {
              var rp = o.mv[0] && o.mv[0].report && o.mv[0].du > 0, Lc = D.evs.filter(function (e) { return rp ? e.clos : !e.clos; }).sort(function (a, b) { return a.date - b.date; });   // report à payer → dernier événement clôturé
              return ((Lc.length ? Lc : D.evs)[(Lc.length ? Lc : D.evs).length - 1] || {}).id; })()) + "</select></div>" +
            "<div><label>Montant</label><input id='pyMt' inputmode='decimal' value='" + (o.du && o.solde > 0 ? Math.round(o.solde) : "") + "'></div></div>" +
            "<div class='ligne'><div><label>Payé par</label><select id='pyMo'>" + repOpts(["Banque (virement)", "Chèque remis au bénéficiaire", "Caisse (espèces)"], "Banque (virement)") + "</select></div><div><label>Société</label><select id='pySo'>" + repOpts(["AB", "M2S"], "AB") + "</select></div></div>" +
            "<button class='bouton' id='pyOk'>💸 Préparer la demande Finances</button><div class='info'>La demande s'ouvre pré-remplie (type, catégorie Commission, montant, événement) ; elle suit la validation habituelle. Une fois exécutée, le versement est rattaché tout seul à l'événement.</div></div>" +
            "<table style='width:100%;font-size:13px'><tr style='color:#888;text-align:left'><th>Date</th><th>Mouvement</th><th style='text-align:right'>Dû</th><th style='text-align:right'>Versé</th><th style='text-align:right'>Solde</th></tr>" +
            o.mv.map(function (m) {
              var x = m.src ? D.com.filter(function (c) { return c.src === m.src; })[0] : null;
              return "<tr style='border-top:1px solid var(--bord)" + (m.report ? ";font-weight:700;color:#1155cc" : "") + "'><td style='white-space:nowrap'>" + jourFr(m.d) + "</td><td>" + esc(m.lib) + (m.ev ? " <small>(" + esc(m.ev) + ")</small>" : "") +
                (x ? " <button class='bouton second' data-rat='" + esc(x.src) + "' style='padding:2px 6px;width:auto;display:inline-block'>🔗</button>" + blocRat(D, x) : "") + "</td><td style='text-align:right'>" + (m.du ? gnf(m.du) : "") + "</td><td style='text-align:right'>" + (m.v ? gnf(m.v) : "") +
                "</td><td style='text-align:right'>" + (o.du ? gnf(m.solde) : "") + "</td></tr>";
            }).join("") + "</table></div>";
        }
      }
      return B.map(function (o) {
        return "<div class='carte' data-f='b:" + esc(o.id) + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>👤 " + esc(o.nom) + "</b>" +
          (o.du ? "<b style='flex:0;white-space:nowrap;color:" + (o.solde > 0 ? "#c62828" : "#2e7d32") + "'>" + (o.solde >= 0 ? "reste " + gnf(o.solde) : "avance " + gnf(-o.solde)) + "</b>" : "<b style='flex:0;white-space:nowrap'>" + gnf(o.tV) + "</b>") + "</div>" +
          "<div class='info'>" + esc(o.type || "à typer") + (o.du ? " · dû " + gnf(o.tDu) : "") + " · versé " + gnf(o.tV) + " · " + o.mv.filter(function (m) { return m.v; }).length + " versement(s)" + "" + "</div></div>";
      }).join("");
    }
    function payer() {
      var o = REPV.pay && REPV.pay.benef; if (!o) return;
      var ev = $("pyEv").value, mt = parseFloat(String($("pyMt").value).replace(/\s/g, "").replace(",", ".")), banque = /Banque|Chèque/.test($("pyMo").value), cheque = /Chèque/.test($("pyMo").value);
      if (!(mt > 0)) { alert("⛔ Indiquez le montant."); return; }
      if (!S.fin) { alert("⛔ Ouvrez d'abord Finances une fois (données Finances absentes)."); return; }
      var ty = o.type || "Démarchage externe", objet = "Commission " + (ty === "Commission interne" ? "interne" : ty === "Démarchage externe" ? "démarchage" : ty === "Commission directe (Trésor)" ? "directe Trésor" : "attribution") + " — " + o.nom + " [" + (ev || "Hors contrat") + "|" + ty + "]";
      formulaireFin(banque ? { type: "Mouvement de trésorerie", op: cheque ? "Remise chèque" : "Virement", societe: $("pySo").value, categorie: "Commission", objet: objet, montant: mt, beneficiaire: o.nom }
                           : { type: "Dépense de caisse", societe: $("pySo").value, categorie: "Commission", objet: objet, montant: mt });
    }
    // 🏦 Surplus transférable vers DG BIG GNF (après commissions) : par société ; réserve fiscale gardée sur le compte BIG GNF,
    // fonds de roulement commun sur l'ensemble des comptes bancaires GNF de la société (caisses exclues).
    function blocSurplus(D, ev) {
      var SU = D.bal && D.bal.surplus; if (!SU || !SU.societes) return "";
      var dues = repBenef(D).filter(function (o) { return o.du && o.solde > 0; }).reduce(function (t, o) { return t + o.solde; }, 0), cle = ev || "bal";
      REPV.surp = REPV.surp || {};
      return "<div class='carte' style='border-left:4px solid #2e7d32'><h3>🏦 Surplus transférable vers " + esc(SU.vers) + "</h3><div class='info'>Après commissions · situation au " + dateCourte(D.genere) +
        (ev ? " (" + esc(ev) + ")" : "") + " · comptes bancaires GNF, caisses exclues</div>" + SU.societes.map(function (o) {
          var com = Math.round(dues * o.part), surplus = Math.round(o.surplus - com), k = cle + "|" + o.societe;
          var CP = o.comptes.filter(function (c) { return c.dispo > 0.5; }).sort(function (a, b) { return b.dispo - a.dispo; });
          REPV.surp[k] = { societe: o.societe, surplus: surplus, comptes: CP, ev: ev || "" };
          return "<div style='margin-top:8px;padding-top:6px;border-top:1px solid var(--bord)'><b>" + esc(o.societe) + "</b> <small class='info'>· " + Math.round(o.part * 1000) / 10 + " % des recouvrements</small>" +
            (o.alerte ? "<div class='carte ko' style='margin:6px 0;padding:8px'>⚠️ " + esc(o.alerte) + "</div>" : "") +
            "<table style='width:100%;font-size:13px'><tr class='info'><td>Compte</td><td style='text-align:right'>Solde</td><td style='text-align:right'>Engagé</td><td style='text-align:right'>Disponible</td></tr>" +
            o.comptes.map(function (c) { return "<tr><td>" + esc(c.nom) + (c.big ? " <small class='info'>(− réserve fiscale " + gnf(c.fiscal) + ")</small>" : "") + "</td><td style='text-align:right'>" + gnf(c.solde) + "</td><td style='text-align:right;white-space:nowrap'>" + (c.engage ? "− " + gnf(c.engage) : "") + "</td><td style='text-align:right;font-weight:700'>" + gnf(c.dispo) + "</td></tr>"; }).join("") +
            "</table><table style='width:100%;font-size:14px'>" +
            ligneV("Réserve fiscale (sur " + esc(o.big || "—") + ")", gnf(o.fiscal)) +
            ligneV("<small class='info'>= " + SU.annee + " : " + gnf(o.fiscN) + " + reliquat " + (SU.annee - 1) + " : " + gnf(o.fiscN1) + " − impôts imputés " + gnf(o.impotsN1) + "</small>", "") +
            ligneV("Disponible des comptes", gnf(o.dispo), 1) +
            ligneV("− Fonds de roulement commun (" + Math.round(o.part * 1000) / 10 + " % de " + gnf(SU.fdr) + ")", gnf(o.fdr)) +
            ligneV("− Commissions restant dues (part)", gnf(com)) +
            "<tr style='font-weight:700;color:" + (surplus > 0 ? "#2e7d32" : "#c62828") + "'><td>▶ " + (surplus > 0 ? "Surplus transférable" : "Manque") + "</td><td style='text-align:right'>" + gnf(Math.abs(surplus)) + "</td></tr></table>" +
            (surplus > 0 && CP.length ? "<div class='ligne' style='align-items:flex-end;gap:6px'><div style='flex:2'><label>Depuis</label><select id='su_c_" + esc(k) + "'>" +
              CP.map(function (c) { return "<option value='" + esc(c.nom) + "'>" + esc(c.nom) + " · dispo " + gnf(c.dispo) + "</option>"; }).join("") + "</select></div>" +
              "<div style='flex:1'><label>Montant</label><input id='su_m_" + esc(k) + "' inputmode='decimal' value='" + Math.round(Math.min(surplus, CP[0].dispo)) + "'></div></div>" +
              "<button class='bouton' data-sur='" + esc(k) + "'>💸 Transférer vers " + esc(SU.vers) + "</button>" : "") +
            (o.impots && o.impots.length ? "<details><summary class='info'>Impôts imputés sur la réserve " + (SU.annee - 1) + " (" + o.impots.length + ")</summary>" + o.impots.map(function (x) { return "<div class='info'>" + jourFr(x.d) + " · " + esc(x.c) + " · " + gnf(x.m) + " · " + esc(x.l) + "</div>"; }).join("") + "</details>" : "") + "</div>";
        }).join("") + "<div class='info' style='margin-top:6px'>Impôts imputés : catégorie « Impôts et taxes » (IMF, IS acomptes / solde ; TVA et « autre impôt » exclus) et commissions cochées « liées aux impôts », sur tous les comptes GNF de la société. Le reliquat de " + (SU.annee - 2) + " et avant est libre.</div></div>";
    }
    function transfererSurplus(k) {
      var z = REPV.surp && REPV.surp[k]; if (!z) return;
      if (!S.fin) { alert("⛔ Ouvrez d'abord Finances une fois (données Finances absentes)."); return; }
      var cpt = $("su_c_" + k).value, c = z.comptes.filter(function (x) { return x.nom === cpt; })[0] || {}, mt = parseFloat(String($("su_m_" + k).value).replace(/\s/g, "").replace(",", "."));
      if (!(mt > 0)) { alert("⛔ Indiquez le montant."); return; }
      if (mt > c.dispo + 0.5 && !confirm("⚠️ " + gnf(mt) + " dépasse le disponible de " + cpt + " (" + gnf(c.dispo) + ", réserve fiscale et paiements engagés déduits). Continuer ?")) return;
      if (mt > z.surplus + 0.5 && !confirm("⚠️ " + gnf(mt) + " dépasse le surplus de " + z.societe + " (" + gnf(z.surplus) + "). Continuer ?")) return;
      formulaireFin({ type: "Mouvement de trésorerie", op: "Virement", mode: "Virement", societe: z.societe, compte: cpt, contrepartie: (S.rep.data.bal.surplus || {}).vers || "DG BIG GNF", categorie: "Alimentation",
        objet: "Transfert du surplus " + z.societe + " (après réserves fiscale et FDR)" + (z.ev ? " — " + z.ev : ""), montant: mt });
    }
    // ⚖️ Balances
    function vueBal(R, D) {
      var X = D.bal || {}, P = D.factures.filter(function (f) { return f.prev; });
      function s(i) { return P.reduce(function (t, f) { return t + (+f.t[i] || 0); }, 0); }
      function bloc(t, L) { return "<div class='carte'><h3>" + t + "</h3><table style='width:100%;font-size:14px'>" + L.join("") + "</table></div>"; }
      return bloc("📦 Amortissement stock", [ligneV("Valeur du stock (CUMP)", gnf(X.valeurCump)), ligneV("Stock complémentaire", gnf(X.valeurStock - X.valeurCump)), ligneV("Total à amortir", gnf(X.valeurStock), 1),
          ligneV("Déjà amorti (factures réglées)", gnf(X.stRecup)), ligneV("Reste à amortir", gnf(Math.max(0, X.valeurStock - X.stRecup)), 1), ligneV("dont couvert par les engagées", gnf(s(9)))]) +
        bloc("🏭 Fonds de roulement (arriérés de charges)", [ligneV("Arriérés depuis " + jourFr(X.debut), gnf(X.fdrCumul)), ligneV("Amorti par les factures réglées", gnf(X.chRecup)), ligneV("Amorti par les engagées (prévisionnel)", gnf(s(10))),
          ligneV("Non couvert", gnf(Math.max(0, X.fdrCumul - X.chRecup - s(10))), 1)]) +
        bloc("🛡️ Réserve fonds de roulement", [ligneV("Constituée (factures réglées)", gnf(X.resCum)), ligneV("+ prévisionnel", gnf(X.resProj)), ligneV("Objectif", gnf(X.objectif)), ligneV("Écart", gnf(Math.max(0, X.objectif - X.resCum)), 1)]) +
        bloc("🧾 Réserve fiscale", [ligneV("Réservée depuis le " + jourFr(X.fiscalDepuis) + " (à verser l'année suivante)", gnf(X.fiscalCumul), 1)]) + blocSurplus(D, "");
    }
    // ⚙️ Paramètres
    function vuePar(R) {
      var COLS = [[4, "Démarch. %"], [5, "Fiscal %"], [6, "Emna %"], [7, "Plaf. stock %"], [8, "Plaf. FDR %"]];
      function pc(x) { return x === "" || x === null || x === undefined ? "" : String(Math.round(x * 1000) / 10).replace(".", ","); }
      var h = "<div class='carte pleine'><h3>Paramètres généraux</h3>" + R.glob.map(function (g) {
        var v = g.sorte === "date" ? (typeof g.val === "number" ? isoJour(g.val) : "") : String(g.val === null || g.val === undefined ? "" : g.val);
        return "<div class='ligne' style='align-items:flex-end;gap:6px'><div style='flex:3'><label>" + esc(g.lib) + "</label><input id='gl" + g.k + "' " + (g.sorte === "date" ? "type='date' " : g.sorte === "num" ? "inputmode='decimal' " : "") + "value='" + esc(v) + "'></div>" +
          "<button class='bouton second' data-gl='" + g.k + "' style='flex:0 0 auto;width:auto;padding:10px'>💾</button></div>";
      }).join("") + "</div>";
      h += "<div class='carte pleine'><h3>Contrats et factures</h3><div class='info'>Taux en %. Case vide = valeur de la ligne du dessus (facture ← contrat ← Par défaut). Chaque 💾 recalcule la répartition (≈ 1 min).</div>" + R.arbre.map(function (a) {
        var ind = a.niv === "f" ? 18 : 0, o = a.niv !== "f" || !!REPV.ouv["p" + a.row];
        var t = "<div style='padding:6px 0 6px " + ind + "px;border-top:1px solid var(--bord)" + (a.niv === "d" ? ";background:var(--fond)" : "") + "'><div class='ligne' style='justify-content:space-between'" + (a.niv === "f" ? " data-o='p" + a.row + "'" : "") + "><b style='" + (a.engagee ? "color:#b26a00" : "") + "'>" + (a.niv === "f" ? (o ? "▼ " : "▶ ") + "↳ " : "") + esc(a.lib) + (a.engagee ? " (engagée)" : "") + "</b>" +
          "<small class='info' style='flex:0;white-space:nowrap;margin:0'>" + (a.niv === "f" ? (typeof a.b === "number" ? jourFr(a.b) : "") + " · " + gnf(a.mt) : esc(String(a.b || ""))) + "</small></div>";
        if (!o) return t + "</div>";
        t += "<div class='ligne' style='flex-wrap:wrap;gap:6px'>" + COLS.map(function (c) { var v = pc(a.taux[c[0] - 4]); return "<div style='flex:1 1 90px'><label style='font-size:11px'>" + c[1] + "</label><input data-row='" + a.row + "' data-col='" + c[0] + "' data-v='" + esc(v) + "' value='" + esc(v) + "' inputmode='decimal' placeholder='hérité'></div>"; }).join("") +
          (a.niv === "c" ? "<div style='flex:1 1 120px'><label style='font-size:11px'>Charges AO</label><input data-row='" + a.row + "' data-col='10' data-v='" + esc(a.ao) + "' value='" + esc(a.ao) + "' inputmode='decimal'></div>" : "") +
          (a.niv !== "f" ? "<div style='flex:2 1 160px'><label style='font-size:11px'>Bénéficiaire démarchage</label><input data-row='" + a.row + "' data-col='12' data-v='" + esc(a.benef) + "' value='" + esc(a.benef) + "'></div>" : "") + "</div>" +
          (a.attr || a.tres ? "<div class='info'>" + (a.attr ? "Attribution versée " + gnf(a.attr) : "") + (a.tres ? " Trésor versé " + gnf(a.tres) : "") + "</div>" : "") +
          "<button class='bouton second' data-pr='" + a.row + "' style='width:auto;padding:6px 12px'>💾 Enregistrer la ligne</button></div>";
        return t;
      }).join("") + "</div>";
      return h;
    }
    dessiner(S.rep ? "mise à jour…" : "chargement…");
    rafraichirRep().then(function () { dessiner(""); }, function (e) { dessiner("⛔ " + e.message + " (réseau nécessaire)"); });
  }

  /* ---------- 🏬 Magasins : stock par magasin, Sortie Stock M2S, sorties des autres magasins, transferts, création ---------- */
  var MAG = { ouv: {}, vue: "" };
  function optsM(L, v, vide) { return (vide ? "<option value=''>" + vide + "</option>" : "") + L.map(function (x) { return "<option" + (x === v ? " selected" : "") + ">" + esc(x) + "</option>"; }).join(""); }
  function afficherMagasins(vue) {
    $("titre").textContent = "Magasins";
    if (vue !== undefined) MAG.vue = vue || "";
    var fsS = S.formulaires && S.formulaires.formulaires && S.formulaires.formulaires.stock;
    function dessiner(msg) {
      var K = S.mag, L = K ? K.magasins : [], dir = !!(K && K.direction), nS = stockNbAttente();
      var h = "<div class='carte pleine'><h3>🏬 Magasins</h3>" +
        "<div class='ligne' style='flex-wrap:wrap'>" +
        (droitStockVal() || fsS ? "<button class='bouton' id='mgM2S'>📦 Sortie Stock M2S" + (nS ? " (" + nS + ")" : "") + "</button>" : "") +
        "<button class='bouton second' id='mgSort'>📤 Sortie (autre magasin)</button>" +
        (dir ? "<button class='bouton second' id='mgTr'>🔁 Transfert</button><button class='bouton second' id='mgNv'>➕ Nouveau magasin</button>" : "") + "</div>" +
        "<div class='info'>" + (K ? L.length + " magasin(s) · données du " + dateCourte(K.recu || K.genere) : "") + (msg ? " · " + esc(msg) : "") + "</div></div>";
      if (MAG.vue) h += formulaireMag(MAG.vue, K);
      h += L.map(function (m, i) {
        var o = !!MAG.ouv[m.nom];
        return "<div class='carte'><div data-o='" + i + "' style='cursor:pointer'><div class='ligne' style='justify-content:space-between'><b>" + (o ? "▼" : "▶") + " 🏬 " + esc(m.nom) + (m.actif ? "" : " <small>(inactif)</small>") + "</b>" +
          "<b style='flex:0;white-space:nowrap'>" + gnf(m.valeur) + " GNF</b></div>" +
          "<div class='info'>" + esc(m.societe || "—") + (m.projet ? " · " + esc(m.projet) : "") + " · " + m.articles.length + " article(s) en stock" + (m.defaut ? " · magasin de la production" : "") + "</div></div>" +
          (o ? (m.articles.length ? "<table style='width:100%;border-collapse:collapse;font-size:13px;margin-top:6px'><tr style='text-align:left;color:#888'><th>Article</th><th style='text-align:right'>Qté</th><th style='text-align:right'>CUMP</th><th style='text-align:right'>Valeur</th></tr>" +
            m.articles.map(function (a) { return "<tr style='border-top:1px solid var(--bord)'><td style='padding:3px 0'>" + esc(a.nom) + "</td><td style='text-align:right'>" + gnf(a.qte) + "</td><td style='text-align:right'>" + gnf(a.cmp) + "</td><td style='text-align:right'>" + gnf(a.val) + "</td></tr>"; }).join("") + "</table>"
            : "<p class='info'>Aucun article en stock.</p>") : "") + "</div>";
      }).join("") || "<p class='info' style='padding:0 4px'>" + (K ? "Aucun magasin." : "Réseau nécessaire.") + "</p>";
      $("vueListe").innerHTML = h; montrer("vueListe");
      if ($("mgM2S")) $("mgM2S").onclick = function () { if (droitStockVal()) afficherStockVal(); else ouvrirFormulaire("stock"); };
      $("mgSort").onclick = function () { MAG.vue = MAG.vue === "sortie" ? "" : "sortie"; dessiner(""); };
      if ($("mgTr")) $("mgTr").onclick = function () { MAG.vue = MAG.vue === "transfert" ? "" : "transfert"; dessiner(""); };
      if ($("mgNv")) $("mgNv").onclick = function () { MAG.vue = MAG.vue === "creer" ? "" : "creer"; dessiner(""); };
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-o]"), function (el) { el.onclick = function () { var m = L[+el.getAttribute("data-o")]; MAG.ouv[m.nom] = !MAG.ouv[m.nom]; dessiner(""); }; });
      if (MAG.vue) lierFormMag(MAG.vue, K, dessiner);
    }
    dessiner(S.mag ? "mise à jour…" : "chargement…");
    rafraichirMag().then(function () { dessiner(""); }, function (e) { dessiner("⛔ " + e.message + " (réseau nécessaire)"); });
  }
  var rafMg = null;
  function rafraichirMag() {
    if (!S.url) return Promise.reject(new Error("adresse du serveur inconnue"));
    if (rafMg) return rafMg;
    rafMg = api({ api: "magasins" }).then(function (r) { r.recu = Date.now(); S.mag = r; ecrire("mag", r); rafMg = null; }, function (e) { rafMg = null; throw e; });
    return rafMg;
  }
  function formulaireMag(vue, K) {
    var L = K ? K.magasins.filter(function (m) { return m.actif; }) : [], noms = L.map(function (m) { return m.nom; });
    if (vue === "creer") return "<div class='carte'><h3>➕ Nouveau magasin</h3>" +
      "<div class='ligne'><div><label>Société</label><select id='mfSoc'>" + optsM(["AB", "M2S", "CASAFINO"], "AB") + "</select></div><div style='flex:2'><label>Projet (facultatif)</label><input id='mfPr' placeholder='ex. Dépôt Nongo'></div></div>" +
      "<label>Nom du magasin <small>(facultatif : « Société · Projet »)</small></label><input id='mfNom'>" +
      "<button class='bouton' id='mfOk'>✅ Créer le magasin</button><div id='mfMsg' class='info'></div></div>";
    var sortie = vue === "sortie", srcL = sortie ? noms.filter(function (n) { return n !== (K && K.defaut); }) : noms;
    return "<div class='carte'><h3>" + (sortie ? "📤 Sortie d'un magasin" : "🔁 Transfert entre magasins") + "</h3>" +
      (sortie ? "<div class='info'>Pour le magasin de la production, utilisez « 📦 Sortie Stock M2S ».</div>" : "") +
      "<div class='ligne'><div><label>" + (sortie ? "Magasin" : "Depuis") + "</label><select id='mfMag'>" + optsM(srcL, srcL[0], srcL.length ? "" : "— aucun —") + "</select></div>" +
      (sortie ? "" : "<div><label>Vers</label><select id='mfVers'></select></div>") + "</div>" +
      "<label>Article</label><select id='mfArt'></select><div id='mfDisp' class='info'></div><div id='apStk'></div>" +
      "<div class='ligne'><div><label>Quantité</label><input id='mfQ' inputmode='decimal'></div>" + (sortie ? "<div style='flex:2'><label>Projet / affectation</label><input id='mfPr'></div>" : "") + "</div>" +
      "<label>Motif</label><input id='mfMot'>" +
      "<button class='bouton' id='mfOk'>" + (sortie ? "📤 Envoyer la sortie" : "🔁 Transférer") + "</button><div id='mfMsg' class='info'></div></div>";
  }
  function lierFormMag(vue, K, dessiner) {
    var jeton = nouveauJeton();
    function v(id) { return $(id) ? $(id).value.trim() : ""; }
    function envoyer(c, ok) {
      $("mfOk").disabled = true; $("mfMsg").textContent = "⏳ envoi…"; c.api = "magasins"; c.jeton = jeton;
      api(c).then(function (r) { alert("✅ " + r.titre + "\n" + (r.message || "")); MAG.vue = ""; return rafraichirMag().then(function () { if (ok) ok(); dessiner(""); }); },
        function (e) { $("mfOk").disabled = false; $("mfMsg").textContent = "⛔ " + e.message; });
    }
    if (vue === "creer") { $("mfOk").onclick = function () { envoyer({ op: "creer", societe: v("mfSoc"), projet: v("mfPr"), nom: v("mfNom") }); }; return; }
    var L = K ? K.magasins : [];
    function maj() {
      var m = L.filter(function (x) { return x.nom === v("mfMag"); })[0], A = m ? m.articles : [], cur = $("mfArt").value;
      $("mfArt").innerHTML = optsM(A.map(function (a) { return a.nom; }), cur, A.length ? "— choisir —" : "— aucun article en stock —");
      var a = A.filter(function (x) { return x.nom === v("mfArt"); })[0];
      $("mfDisp").textContent = a ? "Disponible : " + gnf(a.qte) + " · CUMP " + gnf(a.cmp) + " GNF" : "";
      apercuServeur("apStk", a ? "s:" + v("mfMag") + "|" + a.nom : "", { quoi: "stock", article: a ? a.nom : "", magasin: v("mfMag") }, "5 derniers mouvements · " + (a ? a.nom : ""), function (r) {
        return apercuLignes((r.lignes || []).map(function (l) { return { date: l.date, lib: l.type + (l.projet ? " · " + l.projet : "") + (l.lot ? " · lot " + l.lot : "") + (l.par ? " · " + l.par : "") + " · stock après " + gnf(l.stock), montant: l.type === "Sortie" ? -l.qte : l.qte }; }), "");
      });
      if ($("mfVers")) { var cv = $("mfVers").value, dl = L.filter(function (x) { return x.actif && x.nom !== v("mfMag"); }).map(function (x) { return x.nom; }); $("mfVers").innerHTML = optsM(dl, cv, "— choisir —"); }
    }
    $("mfMag").onchange = maj; $("mfArt").onchange = maj; maj();
    $("mfOk").onclick = function () {
      var q = parseFloat(v("mfQ").replace(/\s/g, "").replace(",", "."));
      if (!v("mfMag") || !v("mfArt")) { $("mfMsg").textContent = "⛔ Choisissez le magasin et l'article."; return; }
      if (!(q > 0)) { $("mfMsg").textContent = "⛔ Quantité."; return; }
      if (vue === "transfert" && !v("mfVers")) { $("mfMsg").textContent = "⛔ Magasin de destination."; return; }
      if (!confirm((vue === "sortie" ? "Sortie de " : "Transfert de ") + q + " × " + v("mfArt") + (vue === "sortie" ? " depuis " + v("mfMag") : " : " + v("mfMag") + " → " + v("mfVers")) + " ?")) return;
      envoyer(vue === "sortie" ? { op: "sortie", magasin: v("mfMag"), article: v("mfArt"), quantite: q, projet: v("mfPr"), motif: v("mfMot") }
        : { op: "transfert", magasin: v("mfMag"), vers: v("mfVers"), article: v("mfArt"), quantite: q, motif: v("mfMot") }, function () { if (vue === "sortie") rafraichirStockVal().catch(function () {}); });
    };
  }

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
  function stockNbAttente() { return S.stockv ? (S.stockv.sorties || []).filter(function (x) { return x.statut === "En attente"; }).length : 0; }
  function afficherStockVal(id) {
    $("titre").textContent = "Sortie Stock M2S";
    function dessiner(msg) {
      var K = S.stockv, L = K ? K.sorties : [], C = { "En attente": "#e65100", "À corriger": "#b26a00", "Validée": "#2e7d32", "Refusée": "#c62828", "Annulée": "#777" }, moiS = S.agent && S.agent.nom;
      function qteDe(x) { var m = String(x.resume).split(" · "); return m[1] || ""; }
      var fsS = S.formulaires && S.formulaires.formulaires && S.formulaires.formulaires.stock;
      var h = "<div class='carte pleine'><h3>📦 Sortie Stock M2S (hors production)</h3><div class='info'>Magasin de la production (M2S · Atelier). Les sorties des autres magasins en attente de validation figurent aussi ici.</div>" +
        (fsS ? "<button class='bouton' id='skNouv'" + (fsS.erreur ? " disabled" : "") + ">➕ Nouvelle sortie de stock</button>" : "") +
        "<h3 style='margin-top:14px'>📋 Liste des demandes</h3><div class='info'>" + (K && K.direction ? "Validation : WALID ou DG (un seul suffit) ; vos propres saisies sont validées d'office. " : "Vos sorties : elles n'entrent dans le stock qu'après validation par WALID ou le DG. ") +
        (K ? "Données du " + dateCourte(K.recu || K.genere) : "") + (msg ? " · " + esc(msg) : "") + "</div></div>";
      h += L.map(function (x, i) {
        return "<div class='carte'" + (x.no === id ? " style='border-color:var(--cuivre)'" : "") + "><div class='ligne' style='justify-content:space-between'><b>" + esc(x.no) + " · " + esc(x.agent) + "</b>" +
          "<span style='flex:0;white-space:nowrap;font-weight:700;color:" + (C[x.statut] || "#999") + "'>" + esc(x.statut) + "</span></div><div>" + esc(x.resume) + "</div>" +
          "<div class='info'>Saisie le " + dateCourte(x.saisi) + (x.par ? " · " + esc(x.statut.toLowerCase()) + " par " + esc(x.par) + " le " + dateCourte(x.le) : "") + (x.motif ? " — " + esc(x.motif) : "") + "</div>" +
          (String(x.agent).toUpperCase() === String(moiS).toUpperCase() && (x.statut === "En attente" || x.statut === "À corriger") ?
            "<div class='ligne'><div><label>Quantité de sortie</label><input data-q='" + i + "' inputmode='decimal' value='" + esc(qteDe(x)) + "'></div><div><label>Projet</label><input data-p='" + i + "'></div></div>" +
            "<div class='ligne'><button class='bouton' data-c='" + i + "'>✏️ " + (x.statut === "À corriger" ? "Corriger et renvoyer" : "Modifier") + "</button><button class='bouton second' data-a='" + i + "'>Annuler</button></div>" : "") +
          (K.direction && x.statut === "En attente" ? "<input data-m='" + i + "' placeholder='Motif (obligatoire pour refuser ou renvoyer)'><button class='bouton alerte' data-k='" + i + "'>↩️ Retour pour correction</button><div class='ligne'><button class='bouton' data-v='" + i + "' style='background:var(--vert)'>✅ Valider</button><button class='bouton' data-r='" + i + "' style='background:var(--rouge)'>⛔ Refuser</button></div>" : "") + "</div>";
      }).join("") || "<p class='info' style='padding:0 4px'>Aucune sortie de stock.</p>";
      $("vueListe").innerHTML = h; montrer("vueListe");
      if ($("skNouv")) $("skNouv").onclick = function () { ouvrirFormulaire("stock"); };
      function decider(i, dec) {
        var x = L[i], m = (document.querySelector("[data-m='" + i + "']") || {}).value || "";
        if ((dec === "refuser" || dec === "corriger") && !m.trim()) { alert("⛔ Indiquez le motif."); return; }
        if (!confirm((dec === "valider" ? "Valider " : dec === "corriger" ? "Renvoyer pour correction " : "Refuser ") + x.no + " : " + x.resume + " ?")) return;
        dessiner("⏳ envoi…");
        api({ api: "stockAValider", no: x.no, decision: dec, motif: m.trim() }).then(function (r) { alert("✅ " + r.titre + "\n" + (r.message || "")); return rafraichirStockVal(); },
          function (e) { alert("⛔ " + e.message + " (réseau nécessaire)"); }).then(function () { dessiner(""); });
      }
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-v]"), function (b) { b.onclick = function () { decider(+b.getAttribute("data-v"), "valider"); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-r]"), function (b) { b.onclick = function () { decider(+b.getAttribute("data-r"), "refuser"); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-k]"), function (b) { b.onclick = function () { decider(+b.getAttribute("data-k"), "corriger"); }; });
      function agir(i, dec) {
        var x = L[i], q = (document.querySelector("[data-q='" + i + "']") || {}).value || "", pr = (document.querySelector("[data-p='" + i + "']") || {}).value;
        if (dec === "modifier" && !(parseFloat(String(q).replace(",", ".")) > 0)) { alert("⛔ Quantité."); return; }
        if (!confirm((dec === "modifier" ? "Envoyer la correction de " : "Annuler ") + x.no + " ?")) return;
        dessiner("⏳ envoi…");
        var c = { api: "stockAValider", no: x.no, decision: dec, quantite: q }; if (pr) c.projet = pr;
        api(c).then(function (r) { alert("✅ " + r.titre + "\n" + (r.message || "")); return rafraichirStockVal(); }, function (e) { alert("⛔ " + e.message + " (réseau nécessaire)"); }).then(function () { dessiner(""); });
      }
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-c]"), function (b) { b.onclick = function () { agir(+b.getAttribute("data-c"), "modifier"); }; });
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-a]"), function (b) { b.onclick = function () { agir(+b.getAttribute("data-a"), "annuler"); }; });
    }
    dessiner(S.stockv ? "mise à jour…" : "chargement…");
    rafraichirStockVal().then(function () { dessiner(""); }, function (e) { dessiner("⛔ " + e.message); });
  }

  /* Notification touchée : l'opération s'ouvre tout de suite (données du téléphone), puis se met à jour après la synchronisation
     (si l'agent est toujours sur cet écran). Elle est marquée lue dans l'historique 🔔. */
  var NOTIF_MARQUE = 0;
  function routerNotif(d) {
    if (d.vue === "maj") {   // notification de mise à jour : elle se lance aussitôt
      if (d.id && plusAncienne(d.id)) { declencherMaj(d.id); setTimeout(installerMaj, 300); }
      else { montrer("vueAccueil"); if (d.id) panneauMajReussie({ de: "", attente: 0 }); }
      return true;
    }
    if (d.vue === "finances" && droitFin()) {
      if (d.id && S.fin && S.fin.demandes.some(function (x) { return x.no === d.id; })) { afficherFinances(); ouvrirDemandeFin(d.id); return true; }
      afficherFinances(); return false;
    }
    if (d.vue === "rh" && droitRH()) { afficherRH(d.id); return true; }
    if (d.vue === "commercial" && droitCom()) { afficherCom(d.id); return true; }
    if (d.vue === "missions" && droitMis()) { afficherMis(d.id); return true; }
    if (d.vue === "stockval" && droitStockVal()) { afficherStockVal(d.id); return true; }
    if (d.vue === "magasins") { afficherMagasins(""); return true; }
    if (d.vue === "audit") { afficherAudit("hebdo"); return true; }
    montrer("vueAccueil"); return true;
  }
  function ouvrirDepuisNotif(d) {
    var marque = ++NOTIF_MARQUE;
    marquerNotifLue(d);
    if (d.vue === "maj") { routerNotif(d); return; }
    if (!S.agent) { montrer("vueAccueil"); return; }
    var trouve = routerNotif(d), titre = $("titre").textContent;
    if (!trouve) $("titre").textContent = "⏳ " + (d.id || "Chargement…");
    synchroniser(true).catch(function () {}).then(function () {
      if (marque !== NOTIF_MARQUE) return;
      if (!trouve || $("titre").textContent === titre) routerNotif(d);   // mise à jour seulement si l'agent n'a pas changé d'écran
    });
  }
  /* 🔔 Historique des notifications (30 jours, sur l'appareil) */
  /* 🔔 « À résoudre » : liste vivante calculée sur les données de l'appareil ; une ligne disparaît quand l'opération est close. */
  function aResoudre() {
    var L = [], moi = S.agent && S.agent.nom;
    if (!S.agent) return L;
    if (S.fin && droitFin()) S.fin.demandes.filter(finOuverte).forEach(function (d) {
      var h = d.historique || [], der = h[h.length - 1] || {}, corr = ((d.proposition && !d.proposition.etat) || /Correction demandée au DG/.test(der.act || "")) && S.fin.role === "DG";
      L.push({ rub: "💰", t: d.no + " · " + libelleFin(d), s: statutFin(d) + " · " + gnf(d.montant) + " " + d.devise + " · " + d.demandeur + (corr ? " · 📝 " + (d.proposition && d.proposition.type === "annul" ? "annulation" : "modification") + " demandée : " + (der.c || "") : ""),
               moi: finATraiter(d) || corr, q: d.date, et: corr ? "Proposition à décider" : finDoublonsExec(d).length ? "⚠️ Doublon possible avec " + finDoublonsExec(d).map(function (z) { return z.no; }).join(", ") : statutFin(d), ouvrir: function () { afficherFinances(); ouvrirDemandeFin(d.no); },
               sal: d.type === "Paiement RH" && d.motifRH === "SALAIRE (RH)" && d.demandeur === S.fin.auto ? { mois: d.dateEffet || d.date, statut: statutFin(d), mt: d.montant, dev: d.devise, nom: d.personnel } : null });
    });
    if (S.rh && S.rh.direction && droitRH()) S.rh.evenements.filter(function (e) { return e.statut === "En attente Walid"; }).forEach(function (e) {
      L.push({ rub: "👥", t: e.type + " · " + e.personnel, s: "Événement RH à valider · " + e.no, moi: true, et: "À valider", q: e.date || 0, ouvrir: function () { afficherRH(); if (typeof ouvrirEvRH === "function") ouvrirEvRH(e.no); } });
    });
    if (S.rh && droitRH() && S.rh.cb) cbAlertes(S.rh).filter(function (a) { return a.niv <= 2; }).forEach(function (a) {
      L.push({ rub: "👥", t: a.t, s: a.no, moi: a.niv === 1 ? S.rh.role === "DG" : true, et: a.niv === 1 ? "Congés / billets à valider" : "Congés / voyages proches", q: 0, cb: a.cle ? a : null, ouvrir: function () { afficherRH("cb"); CBV.fiche = a.no; afficherRH(); } });
    });
    if (S.rh && droitRH() && S.rh.pr) pmAlertes(S.rh).forEach(function (a) {
      L.push({ rub: "👥", t: a.t, s: a.no, moi: a.niv === 1, et: a.et, q: 0, ouvrir: function () { afficherRH(a.no); } });
    });
    if (S.stockv && droitStockVal()) (S.stockv.sorties || []).filter(function (x) { return x.statut === "En attente"; }).forEach(function (x) {
      L.push({ rub: "📦", t: x.no + " · sortie de stock", s: x.resume + " · " + x.agent, moi: !!S.stockv.direction, et: "Sorties à valider", q: x.saisi, ouvrir: function () { afficherStockVal(x.no); } });
    });
    if (S.mis && droitMis()) { var M = S.mis, fin = misAuj() + 86400000;
      M.missions.filter(function (m) { return misOuv(m) && ((misPour(m, M.agent) && m.statut !== "À clôturer" && m.echeance && m.echeance < fin && !misVu(m)) || (M.direction && m.statut === "À clôturer")); }).forEach(function (m) {
        L.push({ rub: "🎯", t: m.titre, s: (m.statut === "À clôturer" ? "Signalée terminée : à clôturer" : "Échéance " + jourLib(m.echeance)) + " · " + m.assignes.join(", "), moi: true, et: m.statut === "À clôturer" ? "À clôturer" : "Échéance proche", q: m.echeance || 0, mis: m, ouvrir: function () { afficherMis(); ficheMis(m.id); } });
      }); }
    if (S.com && droitCom()) comRetards().forEach(function (f) {
      L.push({ rub: "🤝", t: f.id + " · " + f.client, s: "Facture en retard (" + jours(f.echeance) + " j) · " + gnf(f.montant) + " " + f.devise, moi: false, et: "Factures en retard", q: f.echeance, ouvrir: function () { afficherCom(); ficheFactureCom(cleFac(f)); } });
    });
    return L.sort(function (a, b) { return (b.moi ? 1 : 0) - (a.moi ? 1 : 0) || (b.q || 0) - (a.q || 0); });
  }
  function majCloche() {
    var n = 0; try { n = aResoudre().length; } catch (e) {}
    $("nbNotifs").textContent = n > 99 ? "99+" : String(n); $("nbNotifs").style.display = n ? "" : "none";
    return Promise.resolve(n);
  }
  function marquerNotifLue(d) {
    lire("notifs").then(function (L) {
      L = L || []; var ch = false;
      L.forEach(function (x) { if (!x.lu && x.vue === (d.vue || "") && String(x.id) === String(d.id || "")) { x.lu = true; ch = true; } });
      if (ch) return ecrire("notifs", L);
    }).then(majCloche, function () {});
  }
  var CLOCHE = { onglet: "resoudre", ouv: {} };
  // « À résoudre » par rubrique ; salaires automatiques d'un même mois et même étape regroupés en une ligne.
  var RUBS_NOTIF = [["💰", "Finances"], ["👥", "RH"], ["📦", "Magasins · sorties de stock"], ["🎯", "Missions"], ["🤝", "Commercial"]];
  function groupesNotifs(A) {
    var MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
    return RUBS_NOTIF.map(function (rb) {
      var L = A.filter(function (x) { return x.rub === rb[0]; }), sal = {}, out = [];
      L.forEach(function (x) {
        if (!x.sal) { out.push(x); return; }
        var d = new Date(x.sal.mois), k = d.getFullYear() + "-" + d.getMonth() + "|" + x.sal.statut;
        if (!sal[k]) { sal[k] = { rub: rb[0], et: x.et, moi: false, q: x.q, enfants: [], titre: "Salaires de " + MOIS[d.getMonth()] + " " + d.getFullYear(), statut: x.sal.statut, tot: {} }; out.push(sal[k]); }
        var g = sal[k]; g.enfants.push(x); g.moi = g.moi || x.moi; g.tot[x.sal.dev] = (g.tot[x.sal.dev] || 0) + (+x.sal.mt || 0);
      });
      out.forEach(function (g) { if (g.enfants) { g.t = g.titre + " · " + g.enfants.length + " " + g.statut.toLowerCase(); g.s = Object.keys(g.tot).map(function (dv) { return gnf(g.tot[dv]) + " " + dv; }).join(" + ") + " · " + g.enfants.map(function (e) { return e.sal.nom; }).join(", "); } });
      out.sort(function (a, b) { return (b.moi ? 1 : 0) - (a.moi ? 1 : 0) || (b.q || 0) - (a.q || 0); });
      // Sous-groupes par étape (À exécuter, À valider…), ceux qui m'attendent d'abord.
      var ET = {}, ordreE = [];
      out.forEach(function (x) { var e = x.et || "Autres"; if (!ET[e]) { ET[e] = { et: e, L: [], n: 0, moi: 0 }; ordreE.push(e); } ET[e].L.push(x); ET[e].n += x.enfants ? x.enfants.length : 1; if (x.moi) ET[e].moi += x.enfants ? x.enfants.filter(function (c) { return c.moi; }).length : 1; });
      var E = ordreE.map(function (e) { return ET[e]; }).sort(function (a, b) { return (b.moi ? 1 : 0) - (a.moi ? 1 : 0); });
      return { rub: rb[0], lib: rb[1], L: out, E: E, n: L.length, moi: L.filter(function (x) { return x.moi; }).length };
    }).filter(function (g) { return g.n; });
  }


  /* ---------- Lecture d'un relevé bancaire (Excel .xlsx / CSV / PDF) → [{d, lib, debit, credit, solde}] ---------- */
  var MOIS_REL = { jan: 1, janv: 1, janvier: 1, feb: 2, fev: 2, fevr: 2, fevrier: 2, mar: 3, mars: 3, apr: 4, avr: 4, avril: 4, may: 5, mai: 5, jun: 6, juin: 6, jul: 7, juil: 7, juillet: 7,
    aug: 8, aou: 8, aout: 8, sep: 9, sept: 9, septembre: 9, oct: 10, octobre: 10, nov: 11, novembre: 11, dec: 12, decembre: 12 };
  function relZ(n) { return ("0" + n).slice(-2); }
  function relSansAccent(x) { return String(x == null ? "" : x).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function relDate(x) {
    if (x instanceof Date && !isNaN(x)) return x.getFullYear() + "-" + relZ(x.getMonth() + 1) + "-" + relZ(x.getDate());
    if (typeof x === "number" && x > 30000 && x < 80000) { var d = new Date(Math.round((x - 25569) * 864e5)); return d.getUTCFullYear() + "-" + relZ(d.getUTCMonth() + 1) + "-" + relZ(d.getUTCDate()); }
    var t = String(x == null ? "" : x).trim(), m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/);
    if (m) return (m[3].length === 2 ? "20" + m[3] : m[3]) + "-" + relZ(+m[2]) + "-" + relZ(+m[1]);
    m = relSansAccent(t).match(/^(\d{1,2})[\s,.\-]+([a-z]{3,9})\.?[\s,.\-]+(\d{4})\b/);
    if (m && MOIS_REL[m[2]]) return m[3] + "-" + relZ(MOIS_REL[m[2]]) + "-" + relZ(+m[1]);
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + "-" + m[2] + "-" + m[3];
    return "";
  }
  function relNombre(x) {
    if (typeof x === "number") return isNaN(x) ? null : x;
    var t = String(x == null ? "" : x).replace(/[\s  ]/g, "");
    if (!t || !/^-?\(?[\d.,]+\)?-?$/.test(t) || !/\d/.test(t)) return null;
    var neg = /^-|-$|^\(/.test(t); t = t.replace(/[()\-]/g, "");
    var lc = t.lastIndexOf(","), ld = t.lastIndexOf(".");
    if (lc >= 0 && ld >= 0) t = lc > ld ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
    else if (lc >= 0) t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
    else if (ld >= 0 && /^\d{1,3}(\.\d{3}){2,}$/.test(t)) t = t.replace(/\./g, "");
    var n = parseFloat(t); return isNaN(n) ? null : (neg ? -n : n);
  }
  // Tableau (lignes de cellules) : repère l'en-tête Débit / Crédit, puis une opération par ligne datée ; libellé sur plusieurs lignes recollé.
  function relDepuisTableau(rows) {
    var h = -1, C = {};
    for (var i = 0; i < Math.min(rows.length, 80) && h < 0; i++) {
      var r = (rows[i] || []).map(relSansAccent), di = -1, ci = -1;
      r.forEach(function (x, j) { x = x.trim(); if (di < 0 && /^(debit|retrait|sortie|montant debit)/.test(x)) di = j; if (ci < 0 && /^(credit|depot|entree|versement|montant credit)/.test(x)) ci = j; });
      if (di >= 0 && ci >= 0) {
        h = i; C.debit = di; C.credit = ci; C.date = -1; C.lib = -1; C.solde = -1;
        r.forEach(function (x, j) { if (C.date < 0 && /date/.test(x)) C.date = j; if (C.lib < 0 && /descr|libell|remarq|transaction|detail|narrat|intitul|operation/.test(x) && !/date/.test(x)) C.lib = j; if (C.solde < 0 && /solde|balance/.test(x)) C.solde = j; });
      }
    }
    if (h < 0) throw new Error("en-tête « Débit / Crédit » introuvable");
    if (C.date < 0) C.date = 0;
    var L = [], cur = null, prec = null;
    // Cellules fusionnées : un montant n'est pas toujours sous son en-tête → colonne la plus proche ; sens confirmé par le solde (solde précédent ± montant).
    function proche(j) { var best = null, e = Infinity; ["debit", "credit", "solde"].forEach(function (k) { if (C[k] >= 0 && Math.abs(C[k] - j) < e) { e = Math.abs(C[k] - j); best = k; } }); return { k: best, e: e }; }
    rows.slice(h + 1).forEach(function (r) {
      r = r || []; var d = relDate(r[C.date]), lib = C.lib >= 0 ? String(r[C.lib] == null ? "" : r[C.lib]).replace(/\s+/g, " ").trim() : "";
      var N = []; r.forEach(function (x, j) { if (j === C.date || j === C.lib) return; var v = relNombre(x); if (v !== null && x !== "" && (typeof x === "number" || RE_MONTANT.test(String(x).trim()))) N.push({ j: j, v: v }); });
      var so = null, mts = [];
      N.forEach(function (n) { var p = proche(n.j); if (p.k === "solde" && so === null) so = n.v; else mts.push({ v: n.v, k: p.k, e: p.e, j: n.j }); });
      if (so === null && mts.length > 1) { mts.sort(function (a, b) { return a.j - b.j; }); so = mts.pop().v; }
      var de = 0, cr = 0;
      if (mts.length) {
        var m = mts[0], v = Math.abs(m.v);
        if (prec !== null && so !== null && Math.abs(prec + v - so) <= 1) cr = v;
        else if (prec !== null && so !== null && Math.abs(prec - v - so) <= 1) de = v;
        else if (m.k === "credit" && Math.abs(C.credit - m.j) < Math.abs(C.debit - m.j)) cr = v; else de = v;
      }
      if (!d && !mts.length && so !== null) { prec = so; return; }   // report / solde d'ouverture
      if (d && (de || cr)) { cur = { d: d, lib: lib, debit: de, credit: cr, solde: so }; L.push(cur); if (so !== null) prec = so; }
      else if (!d && lib && !de && !cr && cur && !/^\*\*|capital|page \d|^total/i.test(lib)) cur.lib = (cur.lib + " " + lib).trim();
      else if (!d && !lib && !de && !cr) cur = null;
    });
    return L;
  }
  // Mots positionnés d'un PDF [{s, x, w, y (haut→bas), p}] : lignes, colonnes d'après l'en-tête (Débit, Crédit, Solde), une opération par ligne datée.
  var RE_MONTANT = /^-?\(?\d{1,3}(?:[,.\s\u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?\)?-?$|^-?\d+[.,]\d{2}$|^-?\d{1,3}$/;
  function relDepuisMots(mots) {
    var L = [], cur = null, C = null, P = {};
    mots.forEach(function (m) { (P[m.p] = P[m.p] || []).push(m); });
    Object.keys(P).sort(function (a, b) { return a - b; }).forEach(function (pg) {
      var lignes = [], prevY = null;
      P[pg].sort(function (a, b) { return a.y - b.y || a.x - b.x; }).forEach(function (m) { var l = lignes.filter(function (z) { return Math.abs(z.y - m.y) < 5; })[0]; if (!l) { l = { y: m.y, t: [] }; lignes.push(l); } l.t.push(m); });
      lignes.sort(function (a, b) { return a.y - b.y; }).forEach(function (l) {
        l.t.sort(function (a, b) { return a.x - b.x; });
        var txt = l.t.map(function (t) { return t.s; }).join(" "), n = relSansAccent(txt);
        if (/(debit|retrait)/.test(n) && /(credit|depot)/.test(n) && /(solde|balance)/.test(n)) {
          C = {}; l.t.forEach(function (t) { var k = relSansAccent(t.s), cx = t.x + t.w / 2;
            if (/^(debit|retrait)/.test(k)) C.debit = cx; else if (/^(credit|depot)/.test(k)) C.credit = cx; else if (/^(solde|balance)/.test(k)) C.solde = cx;
            else if (/^(descr|libell|remarq|transac|operation)/.test(k) && C.lib === undefined) C.lib = t.x;
            if (/^date/.test(k) && C.date === undefined) C.date = t.x; if (/^(valeur|date|l.operation)/.test(k)) C.datex = Math.max(C.datex || 0, t.x + t.w); });
          C.lim = Math.min(C.debit, C.credit, C.solde) - 70; cur = null; prevY = l.y; return;
        }
        if (!C || C.debit === undefined || C.credit === undefined) return;
        var d = relDate(txt), nums = { debit: null, credit: null, solde: null }, mots2 = [], nbDates = 0;
        l.t.forEach(function (t) {
          var cx = t.x + t.w / 2, mt = RE_MONTANT.test(t.s);
          if (mt && cx >= C.lim) {   // montant : colonne la plus proche (le plus proche de l'en-tête si plusieurs)
            var best = null, e = Infinity; ["debit", "credit", "solde"].forEach(function (k) { if (C[k] !== undefined && Math.abs(C[k] - cx) < e) { e = Math.abs(C[k] - cx); best = k; } });
            if (best && e < 80 && (nums[best] === null || e < nums[best + "E"])) { nums[best] = t.s; nums[best + "E"] = e; } return;
          }
          if (cx >= C.lim && relNombre(t.s) !== null) return;
          if (relDate(t.s) && nbDates < 3 && t.x < (C.datex || C.lim) + 40) { nbDates++; return; }
          mots2.push(t.s);
        });
        var de = relNombre(nums.debit), cr = relNombre(nums.credit), so = relNombre(nums.solde), lib = mots2.join(" ").replace(/\s+/g, " ").trim();
        if (d && (de || cr)) { cur = { d: d, lib: lib, debit: Math.abs(de || 0), credit: Math.abs(cr || 0), solde: so }; L.push(cur); }
        else if (!d && cur && lib && de === null && cr === null && so === null && prevY !== null && l.y - prevY < 26 && l.t[0].x >= (C.datex || 0) - 5 && l.t[0].x < C.lim) cur.lib = (cur.lib + " " + lib).trim();
        else if (!d) cur = null;
        prevY = l.y;
      });
    });
    return L;
  }
  // .xlsx = archive ZIP : lecture sans bibliothèque (DecompressionStream) de la 1re feuille.
  function relLireXlsx(buf) {
    var u = new Uint8Array(buf), dv = new DataView(buf), eocd = -1;
    for (var i = u.length - 22; i >= Math.max(0, u.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(new Error("fichier Excel illisible (ancien format .xls ? enregistrez-le en .xlsx)"));
    var n = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true), F = {};
    for (var k = 0; k < n; k++) {
      var meth = dv.getUint16(off + 10, true), csz = dv.getUint32(off + 20, true), nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lo = dv.getUint32(off + 42, true);
      var nom = new TextDecoder().decode(u.subarray(off + 46, off + 46 + nl));
      F[nom] = { meth: meth, csz: csz, lo: lo }; off += 46 + nl + el + cl;
    }
    function lire(nom) {
      var f = F[nom]; if (!f) return Promise.resolve("");
      var lnl = dv.getUint16(f.lo + 26, true), lel = dv.getUint16(f.lo + 28, true), data = u.subarray(f.lo + 30 + lnl + lel, f.lo + 30 + lnl + lel + f.csz);
      if (f.meth === 0) return Promise.resolve(new TextDecoder().decode(data));
      var ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter(); w.write(data); w.close();
      return new Response(ds.readable).arrayBuffer().then(function (b) { return new TextDecoder().decode(b); });
    }
    var feuille = Object.keys(F).filter(function (x) { return /^xl\/worksheets\/sheet\d*\.xml$/.test(x); }).sort()[0];
    if (!feuille) return Promise.reject(new Error("aucune feuille dans le fichier Excel"));
    return Promise.all([lire("xl/sharedStrings.xml"), lire(feuille)]).then(function (x) {
      var dp = new DOMParser(), ss = [], sx = x[0] ? dp.parseFromString(x[0], "application/xml") : null;
      if (sx) Array.prototype.forEach.call(sx.getElementsByTagName("si"), function (si) { ss.push(Array.prototype.map.call(si.getElementsByTagName("t"), function (t) { return t.textContent; }).join("")); });
      var sh = dp.parseFromString(x[1], "application/xml"), rows = [];
      Array.prototype.forEach.call(sh.getElementsByTagName("row"), function (r) {
        var ri = (+r.getAttribute("r") || rows.length + 1) - 1, ligne = [];
        Array.prototype.forEach.call(r.getElementsByTagName("c"), function (c) {
          var ref = c.getAttribute("r") || "", col = 0, mm = ref.match(/^[A-Z]+/); if (mm) for (var q = 0; q < mm[0].length; q++) col = col * 26 + mm[0].charCodeAt(q) - 64; col--;
          var t = c.getAttribute("t"), vEl = c.getElementsByTagName("v")[0], v = vEl ? vEl.textContent : "";
          if (t === "s") v = ss[+v] || ""; else if (t === "inlineStr") v = Array.prototype.map.call(c.getElementsByTagName("t"), function (z) { return z.textContent; }).join("");
          else if (v !== "" && !isNaN(+v) && t !== "str") v = +v;
          ligne[col < 0 ? ligne.length : col] = v;
        });
        rows[ri] = ligne;
      });
      return rows.map(function (r) { return r || []; });
    });
  }
  function relLireCsv(txt) {
    var sep = (txt.split("\n")[0].match(/;/g) || []).length > (txt.split("\n")[0].match(/,/g) || []).length ? ";" : (txt.indexOf("\t") >= 0 ? "\t" : ",");
    return txt.split(/\r?\n/).map(function (l) { var out = [], cur = "", q = false; for (var i = 0; i < l.length; i++) { var ch = l[i]; if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; });
  }
  var LIB_PDF = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js", LIB_PDFW = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  function relLirePdf(buf) {
    var charger = window.pdfjsLib ? Promise.resolve() : new Promise(function (ok, ko) { var sc = document.createElement("script"); sc.src = LIB_PDF; sc.onload = ok; sc.onerror = function () { ko(new Error("lecteur PDF indisponible (réseau nécessaire)")); }; document.head.appendChild(sc); });
    return charger.then(function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIB_PDFW;
      return window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (doc) {
      var mots = [], P = [];
      for (var i = 1; i <= doc.numPages; i++) P.push(doc.getPage(i).then(function (pg) { var vp = pg.getViewport({ scale: 1 }), no = pg.pageNumber;
        return pg.getTextContent().then(function (tc) { tc.items.forEach(function (it) { var s = String(it.str || "").trim(); if (!s) return;
          // mots séparés (une même chaîne peut contenir date + libellé)
          var x = it.transform[4], y = vp.height - it.transform[5], w = it.width || s.length * 4.5, cw = w / Math.max(1, it.str.length), pos = 0;
          String(it.str).split(/(\s{2,})/).forEach(function (part) { if (/^\s+$/.test(part) || !part) { pos += part.length; return; } var t = part.trim(); if (t) mots.push({ s: t, x: x + pos * cw, w: part.length * cw, y: y, p: no }); pos += part.length; });
        }); }); }));
      return Promise.all(P).then(function () {
        var L = relDepuisMots(mots), p1 = mots.filter(function (w) { return w.p === 1; }).sort(function (a, b) { return Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x; });
        var txt = "", y0 = null; p1.forEach(function (w) { txt += (y0 !== null && Math.abs(w.y - y0) > 4 ? "\n" : " ") + w.s; y0 = w.y; });
        L.numero = relNumeroCompte(txt); return L; });
    });
  }
  // N° de compte imprimé dans l'en-tête du relevé (après « Numéro de compte », « Compte n° », RIB, IBAN…), sinon 1re suite de 10 à 24 chiffres.
  function relNumeroCompte(txt) {
    txt = String(txt || "");
    var m = txt.match(/(?:num[ée]ro\s*(?:de\s*)?compte|n[°o]\s*(?:de\s*)?compte|compte\s*n[°o]|account\s*(?:no|number|n°)|\bRIB\b|\bIBAN\b)\s*[:.]?\s*([A-Z]{0,4}\d[\d \t-]{8,34}\d)/i)
      || txt.match(/\b(\d{10,24})\b/);
    return m ? m[1].replace(/[^0-9A-Z]/gi, "").toUpperCase() : "";
  }
  function relLireFichier(file) {
    var nom = String(file.name || "").toLowerCase();
    return file.arrayBuffer().then(function (buf) {
      var u = new Uint8Array(buf, 0, 4);
      if (u[0] === 0x25 && u[1] === 0x50) return relLirePdf(buf);                      // %PDF
      if (u[0] === 0x50 && u[1] === 0x4b) return relLireXlsx(buf).then(function (rows) { var L = relDepuisTableau(rows); L.numero = relNumeroCompte(rows.slice(0, 40).map(function (r) { return (r || []).join(" "); }).join("\n")); return L; });   // PK (xlsx, même nommé .xls)
      if (u[0] === 0xd0 && u[1] === 0xcf) throw new Error("ancien format Excel (.xls 97-2003) : ouvrez-le et enregistrez-le en .xlsx, ou envoyez le PDF");
      var txt = new TextDecoder().decode(buf), L2 = relDepuisTableau(relLireCsv(txt)); L2.numero = relNumeroCompte(txt.split("\n").slice(0, 40).join("\n")); return L2;
    });
  }

  /* ---------- 🔎 Audit bancaire (relevé Excel / PDF ↔ Base) et 💵 audit de caisse ---------- */
  var AUD = { vue: "", compte: "", lignes: null, fichier: "", res: null, msg: "" };
  // Solde Base (à la date du solde du relevé) mis à jour sans nouvelle comparaison.
  function audMajSolde(R, delta) { if (R.soldeBase === null || R.soldeBase === undefined || !delta) return; R.soldeBase += delta; R.ecart = Math.round((R.soldeReleve - R.soldeBase) * 100) / 100; }
  function audCoupe(R) { return R.soldeAu ? new Date(R.soldeAu + "T12:00:00").getTime() + 86400000 : 0; }
  // Écriture créée depuis une anomalie du relevé : la ligne passe tout de suite en « pointées » (au lieu d'attendre une nouvelle comparaison).
  // Fichier → base64 (copie du relevé gardée dans Drive) ; au-delà de 8 Mo, pas de copie.
  function audLireBase64(f) {
    return new Promise(function (ok) { if (!f || f.size > 8 * 1024 * 1024) return ok({ data: "", mime: "" });
      var rd = new FileReader(); rd.onload = function () { var s = String(rd.result || ""); ok({ data: s.substring(s.indexOf(",") + 1), mime: f.type || "" }); }; rd.onerror = function () { ok({ data: "", mime: "" }); }; rd.readAsDataURL(f); });
  }
  function audEcritureCreee(dm) {
    var c = AUD.creation; if (!c || !dm || Math.abs((+dm.montant || 0) - Math.abs(c.x.montant)) > 1) return;   // une autre demande : rien
    AUD.creation = null; if (AUD.res !== c.R) return;
    var R = c.R, x = c.x;
    R.anomalies = R.anomalies.filter(function (z) { return z !== x; });
    if (R.soldeAu && x.d <= R.soldeAu) audMajSolde(R, x.montant);
    R.pointees.push({ i: x.i, d: x.d, lib: x.lib, montant: x.montant, base: "➕ écriture créée" });
    (R.associees = R.associees || []).push(x.d + " · " + x.lib.substring(0, 60) + " · " + gnf(x.montant) + " → ➕ écriture créée dans Base");
  }
  function afficherAudit(vue) {
    if (vue !== undefined) { AUD.vue = vue; AUD.msg = ""; }
    var T = S.treso || { comptes: [] }, B = T.comptes.filter(function (c) { return c.type === "Banque" && !c.perso; }), Cs = T.comptes.filter(function (c) { return c.type === "Caisse"; });
    $("titre").textContent = AUD.vue === "caisse" ? "Audit de caisse" : AUD.vue === "regles" ? "Prélèvements récurrents" : AUD.vue === "liste" ? "Historique des audits" : AUD.vue === "hebdo" ? "Relevés de la semaine" : "Audit bancaire";
    var h = "";
    if (AUD.vue === "caisse") {
      h = "<div class='carte pleine'><h3>💵 Audit de caisse</h3><label>Caisse</label><select id='acC'>" + optsM(Cs.map(function (c) { return c.nom; }), AUD.compte, "— choisir —") + "</select><div class='info' id='acS'></div>" +
        "<label>Montant compté</label><input id='acM' inputmode='decimal' placeholder='Total des billets et pièces'><label>Commentaire</label><input id='acCm'>" +
        "<button class='bouton' id='acOk'>✅ Enregistrer le comptage</button><div class='info'>L'écart avec le solde de Base est calculé ; un écart est signalé à Walid et au DG.</div></div>";
      $("vueListe").innerHTML = h; montrer("vueListe");
      var maj = function () { var c = Cs.filter(function (x) { return x.nom === $("acC").value; })[0]; $("acS").textContent = c ? "Solde de Base : " + gnf(c.solde) + " " + c.devise : ""; };
      $("acC").onchange = maj; maj();
      $("acOk").onclick = function () {
        if (!$("acC").value || $("acM").value.trim() === "") { alert("⛔ Caisse et montant compté."); return; }
        api({ api: "audit", op: "caisse", compte: $("acC").value, montant: $("acM").value, commentaire: $("acCm").value.trim() }).then(function (r) { alert(r.titre + "\n" + r.message); afficherTreso(); },
          function (e) { alert("⛔ " + e.message); });
      };
      return;
    }
    if (AUD.vue === "regles") {
      $("vueListe").innerHTML = "<div class='carte pleine'><h3>⚙️ Prélèvements récurrents</h3><p class='info'>⏳ Chargement…</p></div>"; montrer("vueListe");
      api({ api: "audit", op: "regles" }).then(function (r) {
        var R = r.regles, ed = AUD.edit || null;
        var h2 = "<div class='carte pleine'><h3>⚙️ Prélèvements récurrents</h3><div class='info'>Une ligne du relevé dont le libellé contient ce texte est inscrite d'office dans Base (opération constatée) et n'est plus une anomalie.</div>" +
          R.map(function (x, i) { return "<div style='border-top:1px solid var(--bord);padding:6px 0;" + (x.actif ? "" : "opacity:.5") + "'><b>« " + esc(x.motif) + " »</b> · " + esc(x.sens) + " → " + esc(x.op) + " · " + esc(x.cat) + (x.compte ? " · " + esc(x.compte) : " · tous les comptes") +
            (r.direction ? " <button class='bouton second' data-rge='" + i + "' style='width:auto;display:inline-block;padding:2px 8px'>✏️</button>" : "") + "</div>"; }).join("") + "</div>";
        if (r.direction) h2 += "<div class='carte pleine'><h3>" + (ed ? "✏️ Modifier « " + esc(ed.motif) + " »" : "➕ Nouvelle règle") + "</h3><label>Le libellé contient</label><input id='rgM' value='" + esc(ed ? ed.motif : AUD.motif || "") + "' placeholder='ex. Frais UDIRECT'>" +
          "<div class='ligne'><div><label>Sens</label><select id='rgS'>" + optsM(["Débit", "Crédit", "Les deux"], ed ? ed.sens : "Débit") + "</select></div><div><label>Opération</label><select id='rgO'>" + optsM(r.ops, ed ? ed.op : "Prelevement bancaire") + "</select></div></div>" +
          "<div class='ligne'><div><label>Catégorie</label><select id='rgC'>" + optsM(r.categories, ed ? ed.cat : "AUTRE") + "</select></div><div><label>Compte (vide = tous)</label><select id='rgK'>" + optsM(B.map(function (c) { return c.nom; }), ed ? ed.compte : "", "— tous —") + "</select></div></div>" +
          "<div class='ligne'><button class='bouton' id='rgOk'>💾 Enregistrer</button>" + (ed ? "<button class='bouton second' id='rgDel'>🗑️ Supprimer</button><button class='bouton second' id='rgX'>Annuler</button>" : "") + "</div></div>";
        $("vueListe").innerHTML = h2;
        Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-rge]"), function (b) { b.onclick = function () { AUD.edit = R[+b.getAttribute("data-rge")]; afficherAudit(); }; });
        if ($("rgX")) $("rgX").onclick = function () { AUD.edit = null; afficherAudit(); };
        if ($("rgDel")) $("rgDel").onclick = function () { if (!confirm("Supprimer la règle « " + ed.motif + " » ?")) return; api({ api: "audit", op: "regle", ancien: ed.motif, supprimer: true }).then(function () { AUD.edit = null; afficherAudit(); }, function (e) { alert("⛔ " + e.message); }); };
        if ($("rgOk")) $("rgOk").onclick = function () {
          api({ api: "audit", op: "regle", ancien: ed ? ed.motif : "", motif: $("rgM").value, sens: $("rgS").value, opc: $("rgO").value, cat: $("rgC").value, compte: $("rgK").value }).then(function (x) { AUD.edit = null; AUD.motif = ""; alert("✅ " + x.message); afficherAudit(); },
            function (e) { alert("⛔ " + e.message); });
        };
      }, function (e) { $("vueListe").innerHTML = "<div class='carte'><p class='info'>⛔ " + esc(e.message) + "</p></div>"; });
      return;
    }
    if (AUD.vue === "hebdo") {   // 📥 Relevés de la semaine : un dépôt par compte bancaire ; audit automatique quand tout est là
      $("vueListe").innerHTML = "<div class='carte pleine'><h3>📥 Relevés de la semaine</h3><p class='info'>⏳ Chargement…</p></div>"; montrer("vueListe");
      var dessinerH = function (E) {
        var nOk = E.comptes.filter(function (c) { return c.depot; }).length;
        var fr = function (s) { return String(s || "").split("-").reverse().join("/"); }, AF = E.comptes.filter(function (c) { return !c.aJour; }), duMin = AF.map(function (c) { return c.auditDu; }).filter(String).sort()[0];
        nOk = E.comptes.filter(function (c) { return c.depot || c.aJour; }).length;
        var h = "<div class='carte pleine'><h3>📥 Audit bancaire · période à auditer " + (duMin ? "du " + fr(duMin) + " " : "") + "jusqu'au samedi " + fr(E.semaine) + "</h3><div class='info'>La semaine en cours sera demandée samedi prochain. " + nOk + " / " + E.comptes.length + " compte(s) traité(s)." +
          (E.enCours ? " ⏳ Audit automatique en cours (rapport par notification)." : E.dernierAuto ? " Dernier audit automatique : " + dateCourte(E.dernierAuto) + "." : "") +
          " Dès que tous les relevés sont déposés, l'audit se lance seul en arrière-plan.</div>" +
          "<button class='bouton second' id='ahGo' style='width:auto;margin:6px 0 0'" + (E.comptes.some(function (c) { return c.depot && c.depot.statut === "Déposé"; }) ? "" : " disabled") + ">▶️ Lancer l'audit automatique maintenant</button></div>";
        h += E.comptes.map(function (c, i) { var d = c.depot, st = !d ? "⏳ à déposer" : d.statut === "Sans relevé" ? "⏭️ sans relevé" : d.statut === "Déposé" ? "📄 déposé, en attente d'audit" : d.statut === "Erreur" ? "⛔ erreur" : "✅ " + d.statut.toLowerCase();
          if (!d && c.aJour) st = "✅ à jour (audité jusqu'au " + fr(String(c.auditDu ? (function () { var x = new Date(c.auditDu + "T12:00:00"); x.setDate(x.getDate() - 1); return x.toISOString().slice(0, 10); })() : "")) + ")";
          return "<div class='carte'><div class='ligne' style='justify-content:space-between'><b>🏦 " + esc(c.nom) + "</b><span class='info' style='margin:0'>" + st + "</span></div>" +
            (!c.aJour ? "<div class='info' style='margin:2px 0'>📅 À auditer : " + (c.auditDu ? "du " + fr(c.auditDu) : "depuis le début de Base") + " au " + fr(c.auditAu) + "</div>" : "") +
            (d ? "<div class='info' style='margin:2px 0'>" + (d.du ? "du " + esc(d.du) + " au " + esc(d.au) + " · " : "") + (d.agent ? esc(d.agent) + " · " + dateCourte(d.le) : "") + (d.lien ? " · <a href='" + esc(d.lien) + "' target='_blank' rel='noopener'>📎 copie</a>" : "") + (d.resultat ? "<br>" + esc(d.resultat) : "") + "</div>" : "") +
            "<div class='ligne' style='gap:6px;flex-wrap:wrap'><label class='bouton" + (d || c.aJour ? " second" : "") + "' style='width:auto;flex:0 0 auto;margin:0;cursor:pointer'>📎 " + (d && d.statut !== "Sans relevé" ? "Remplacer" : "Déposer") + " le relevé<input type='file' data-ahf='" + i + "' accept='.xlsx,.xls,.csv,.pdf,application/pdf' style='display:none'></label>" +
            (!d && !c.aJour ? "<button class='bouton second' data-ahp='" + i + "' style='width:auto;flex:0 0 auto;margin:0'>⏭️ Pas de relevé</button>" : "") +
            (d && d.statut !== "Sans relevé" ? "<button class='bouton second' data-aho='" + i + "' style='width:auto;flex:0 0 auto;margin:0'>🔎 Ouvrir l'audit</button>" : "") + "</div><div class='info' id='ahM" + i + "'></div></div>"; }).join("");
        $("vueListe").innerHTML = h; montrer("vueListe");
        var envoyerH = function (q, ok) { api(Object.assign({ api: "audit" }, q), 240000).then(function (r) {
          if (r.confirmerNumero) { if (confirm(r.titre + "\n\n" + r.message)) envoyerH(Object.assign({}, q, { confirmeNumero: true }), ok); else dessinerH(E); return; }
          if (!r.ok) { alert("⛔ " + (r.titre || "") + "\n" + (r.message || "")); return; } if (r.message) alert("✅ " + r.message); dessinerH(r); if (ok) ok(r); }, function (e) { alert("⛔ " + e.message); }); };
        $("ahGo").onclick = function () { if (confirm("Lancer maintenant l'audit automatique des relevés déposés ?")) envoyerH({ op: "lancer" }); };
        Array.prototype.forEach.call(document.querySelectorAll("[data-ahp]"), function (b) { b.onclick = function () { var c = E.comptes[+b.getAttribute("data-ahp")]; if (confirm(c.nom + " : pas de relevé cette semaine ?")) envoyerH({ op: "passer", compte: c.nom }); }; });
        Array.prototype.forEach.call(document.querySelectorAll("[data-aho]"), function (b) { b.onclick = function () { var c = E.comptes[+b.getAttribute("data-aho")];
          b.disabled = true; b.textContent = "⏳…";
          api({ api: "audit", op: "lignesDepot", compte: c.nom }, 120000).then(function (r) { if (!r.ok) { alert("⛔ " + r.message); b.disabled = false; return; }
            AUD.compte = c.nom; AUD.lignes = r.lignes; AUD.fichier = r.fichier; AUD.fichierData = null; AUD.depuisDepot = true; AUD.lien = (c.depot && c.depot.lien) || ""; AUD.res = null; afficherAudit("banque"); if ($("abGo")) $("abGo").click(); }, function (e) { alert("⛔ " + e.message); b.disabled = false; }); }; });
        Array.prototype.forEach.call(document.querySelectorAll("[data-ahf]"), function (inp) { inp.onchange = function () {
          var i = +inp.getAttribute("data-ahf"), c = E.comptes[i], f = inp.files[0]; if (!f) return;
          $("ahM" + i).textContent = "⏳ Lecture de " + f.name + "…";
          Promise.all([relLireFichier(f), audLireBase64(f)]).then(function (x) {
            var L = x[0]; if (!L.length) throw new Error("aucune opération reconnue dans ce fichier");
            $("ahM" + i).textContent = "⏳ Envoi de " + L.length + " ligne(s)…";
            envoyerH({ op: "deposer", compte: c.nom, lignes: L, numero: L.numero || "", fichier: f.name, fichierData: x[1].data, mime: x[1].mime });
          }).catch(function (e) { $("ahM" + i).textContent = "⛔ " + e.message; });
        }; });
      };
      api({ api: "audit", op: "hebdo" }, 60000).then(function (r) { if (!r.ok) { $("vueListe").innerHTML = "<div class='carte'><p class='info'>⛔ " + esc(r.message || "") + "</p></div>"; return; } dessinerH(r); },
        function (e) { $("vueListe").innerHTML = "<div class='carte'><p class='info'>⛔ " + esc(e.message) + " (réseau nécessaire)</p></div>"; });
      return;
    }
    if (AUD.vue === "liste") {
      $("vueListe").innerHTML = "<div class='carte pleine'><h3>📋 Historique des audits</h3><p class='info'>⏳ Chargement…</p></div>"; montrer("vueListe");
      api({ api: "audit", op: "liste" }).then(function (r) {
        $("vueListe").innerHTML = "<div class='carte pleine'><h3>📋 Historique des audits</h3>" + (r.audits.map(function (a) {
          var ec = +a.ecart || 0;
          if (a.type === "Association") return "<div style='border-top:1px solid var(--bord);padding:6px 0'><b>🔗 " + esc(a.compte) + "</b> · " + dateCourte(a.date) + " · " + esc(a.agent) +
            "<div class='info' style='margin:0'>Association relevé ↔ Base · " + esc(a.com) + "</div></div>";
          return "<div style='border-top:1px solid var(--bord);padding:6px 0'><b>" + (a.type === "Caisse" ? "💵 " : "🏦 ") + esc(a.compte) + "</b> · " + dateCourte(a.date) + " · " + esc(a.agent) +
            "<div class='info' style='margin:0'>" + (a.type === "Banque" ? "Relevé du " + esc(a.du) + " au " + esc(a.au) + " · " + (a.pointees || 0) + " pointée(s) · " + (a.anomalies || 0) + " anomalie(s) · " + (a.recurrents || 0) + " récurrent(s) · " : "") +
            (a.solde !== "" ? (a.type === "Caisse" ? "compté " : "solde relevé ") + gnf(a.solde) + " · Base " + gnf(a.base) + " · " : "") + "<b style='color:" + (ec ? "#c62828" : "#2e7d32") + "'>écart " + gnf(ec) + "</b>" + (a.com ? " · " + esc(a.com) : "") + (a.lien ? " · <a href='" + esc(a.lien) + "' target='_blank' rel='noopener'>📎 copie du relevé</a>" : "") + "</div></div>";
        }).join("") || "<p class='info'>Aucun audit.</p>") + "</div>";
      }, function (e) { $("vueListe").innerHTML = "<div class='carte'><p class='info'>⛔ " + esc(e.message) + "</p></div>"; });
      return;
    }
    // Audit bancaire
    var R = AUD.res;
    h = "<div class='carte pleine'><h3>🔎 Audit bancaire</h3><label>Compte bancaire</label><select id='abC'>" + optsM(B.map(function (c) { return c.nom; }), AUD.compte, "— choisir —") + "</select>" +
      "<label>Relevé de la banque (Excel .xlsx conseillé, ou PDF)</label><input id='abF' type='file' accept='.xlsx,.xls,.csv,.pdf,application/pdf'>" +
      "<div class='info' id='abI'>" + (AUD.lignes ? "📄 " + esc(AUD.fichier) + " : " + AUD.lignes.length + " ligne(s) lue(s), du " + esc(AUD.lignes.reduce(function (m, l) { return !m || l.d < m ? l.d : m; }, "")) + " au " + esc(AUD.lignes.reduce(function (m, l) { return l.d > m ? l.d : m; }, "")) +
        " · débits " + gnf(AUD.lignes.reduce(function (t, l) { return t + l.debit; }, 0)) + " · crédits " + gnf(AUD.lignes.reduce(function (t, l) { return t + l.credit; }, 0)) : esc(AUD.msg || "Le fichier est lu sur l'appareil ; seules les lignes (date, libellé, montants) sont envoyées.")) + "</div>" +
      "<button class='bouton' id='abGo'" + (AUD.lignes ? "" : " disabled") + ">🔎 Comparer avec Base</button></div>";
    if (R) {
      var dv = R.devise || "";
      h += "<div class='carte pleine'><h3>Résultat · " + esc(R.compte) + "</h3>" + (R.avertissement ? "<div class='carte ko' style='margin:0 0 6px;padding:8px'>⚠️ " + esc(R.avertissement) + "</div>" : "") + (R.lien ? "<div class='info' style='margin:0 0 4px'>📎 <a href='" + esc(R.lien) + "' target='_blank' rel='noopener'>Copie du relevé gardée dans Drive</a></div>" : "") + "<table>" +
        (R.associees && R.associees.length ? "<tr><td colspan='2' style='background:rgba(46,125,50,.12)'>✔️ <b>Résolues dans cette session (" + R.associees.length + ")</b><br><small>" + R.associees.map(esc).join("<br>") + "</small></td></tr>" : "") +
        "<tr><td>Période comparée</td><td class='v'>" + esc(R.du) + " → " + esc(R.au) + " (" + R.nb + " lignes" + (R.ignorees ? ", " + R.ignorees + " antérieures au début de Base ignorées" : "") + ")</td></tr>" +
        (R.alignees ? "<tr><td colspan='2' class='info'>📅 " + R.alignees + " date(s) de Base alignée(s) sur le relevé</td></tr>" : "") +
        "<tr><td>✅ Pointées (dans Base)</td><td class='v'>" + R.pointees.length + "</td></tr><tr><td>🔁 Prélèvements récurrents</td><td class='v'>" + R.recurrents.length + "</td></tr>" +
        "<tr><td>⚠️ Sur le relevé, absentes de Base</td><td class='v'><b style='color:" + (R.anomalies.length ? "#c62828" : "#2e7d32") + "'>" + R.anomalies.length + "</b></td></tr>" +
        "<tr><td>❓ Dans Base, absentes du relevé</td><td class='v'><b style='color:" + (R.absents.some(function (x) { return !x.apres; }) ? "#e65100" : "#2e7d32") + "'>" + R.absents.filter(function (x) { return !x.apres; }).length + "</b></td></tr>" +
        (R.soldeReleve !== null ? "<tr style='border-top:2px solid var(--bord)'><td><b>Solde relevé au " + esc(R.soldeAu.split("-").reverse().join("/")) + "</b></td><td class='v'><b>" + gnf(R.soldeReleve) + " " + esc(dv) + "</b></td></tr>" +
          "<tr><td><b>Solde Base au " + esc(R.soldeAu.split("-").reverse().join("/")) + "</b></td><td class='v'><b>" + (R.soldeBase === null ? "—" : gnf(R.soldeBase) + " " + esc(dv)) + "</b></td></tr>" +
          "<tr><td><b>Écart</b></td><td class='v'><b style='color:" + (Math.abs(R.ecart || 0) > 0.5 ? "#c62828" : "#2e7d32") + "'>" + (R.ecart === null ? "—" : gnf(R.ecart)) + "</b></td></tr>" : "") + "</table></div>";
      if (R.recurrents.length) h += "<div class='carte pleine'><h3>🔁 Prélèvements récurrents (" + R.recurrents.length + ")</h3><div class='info'>À inscrire d'office dans Base (opération constatée). Total " + gnf(R.recurrents.reduce(function (t, x) { return t + x.montant; }, 0)) + ".</div>" +
        "<button class='bouton' id='abIns'>✍️ Inscrire les lignes cochées dans Base</button><details><summary class='info' style='cursor:pointer'>Voir / décocher les lignes</summary>" + R.recurrents.map(function (x, i) { return "<label style='font-weight:400;display:flex;gap:8px;border-top:1px solid var(--bord);padding:4px 0'><input type='checkbox' class='abR' data-i='" + i + "' checked style='width:auto'><span style='flex:1'>" + esc(x.d) + " · " + esc(x.lib) + " <small class='info'>(" + esc(x.regle) + " → " + esc(x.cat) + ")</small></span><b>" + gnf(x.montant) + "</b></label>"; }).join("") +
        "</details></div>";
      // 🧩 Regroupements : proposés par le serveur + manuel (cases à cocher, totaux égaux)
      function lgR(x) { return "<div style='display:flex;gap:6px;font-size:13px'><span class='info' style='margin:0;white-space:nowrap'>" + esc(x.d.split("-").reverse().join("/").slice(0, 5)) + "</span><span style='flex:1'>" + esc(x.lib.substring(0, 80)) + "</span><b style='white-space:nowrap'>" + gnf(x.montant) + "</b></div>"; }
      function lgB(z) { return "<div style='display:flex;gap:6px;font-size:13px'><span class='info' style='margin:0;white-space:nowrap'>" + jourFr(z.date).slice(0, 5) + "</span><span style='flex:1'>" + esc(z.lib.substring(0, 80)) + "</span><b style='white-space:nowrap'>" + gnf(z.montant) + "</b></div>"; }
      if ((R.groupes || []).length) h += "<div class='carte pleine'><h3>🧩 Regroupements proposés (" + R.groupes.length + ")</h3><div class='info'>Totaux égaux entre lignes du relevé et lignes de Base. Valider : la date dans Base devient la plus récente du relevé.</div>" +
        R.groupes.map(function (g, i) { return "<div style='border-top:1px solid var(--bord);padding:6px 0'><div class='info' style='margin:0'>Relevé</div>" + g.rel.map(lgR).join("") + "<div class='info' style='margin:2px 0 0'>= Base</div>" + g.bases.map(lgB).join("") +
          "<div class='ligne' style='gap:6px'><button class='bouton' data-gv='" + i + "' style='width:auto;flex:0 0 auto;padding:4px 10px;margin:4px 0 0'>✅ Valider</button><button class='bouton second' data-gx='" + i + "' style='width:auto;flex:0 0 auto;padding:4px 10px;margin:4px 0 0'>✕ Rejeter</button></div></div>"; }).join("") + "</div>";
      h += "<div class='carte pleine'><div class='ligne' style='justify-content:space-between;align-items:center'><b>🧩 Regroupement manuel</b><button class='bouton second' id='abGm' style='width:auto;flex:0 0 auto;padding:4px 10px;margin:0'>" + (AUD.grpMan ? "Fermer" : "Ouvrir") + "</button></div>" +
        (AUD.grpMan ? "<div class='info'>Cochez les lignes du relevé et de Base qui forment la même opération (au moins 2 d'un côté). Les totaux doivent être égaux. Erreur de la banque (débit puis crédit) : cochez seulement les lignes du relevé dont le total est nul → 🔄 Neutraliser.</div>" +
          "<b style='font-size:13px'>Relevé (non pointées)</b>" + R.anomalies.concat(R.recurrents).sort(function (a, b) { return a.d < b.d ? -1 : 1; }).map(function (x) { return "<label style='font-weight:400;display:flex;gap:6px;align-items:flex-start'><input type='checkbox' class='abMR' data-i='" + x.i + "' style='width:auto;margin-top:3px'>" + lgR(x).replace("<div style='display:flex", "<div style='flex:1;display:flex") + "</label>"; }).join("") +
          "<b style='font-size:13px;display:block;margin-top:6px'>Base (absentes du relevé)</b>" + R.absents.map(function (z) { return "<label style='font-weight:400;display:flex;gap:6px;align-items:flex-start'><input type='checkbox' class='abMB' data-k='" + z.k + "' style='width:auto;margin-top:3px'>" + lgB(z).replace("<div style='display:flex", "<div style='flex:1;display:flex") + "</label>"; }).join("") +
          "<div id='abMT' class='info' style='font-weight:700'></div><button class='bouton' id='abMOk' disabled>✅ Valider le regroupement</button>" : "") + "</div>";
      if (R.anomalies.length) h += "<div class='carte pleine'><h3>⚠️ Sur le relevé, absentes de Base (" + R.anomalies.length + ")</h3>" +
        R.anomalies.map(function (x, i) { return "<div style='border-top:1px solid var(--bord);padding:6px 0'><div class='ligne' style='justify-content:space-between'><span>" + esc(x.d) + " · " + esc(x.lib) + "</span><b style='flex:0;white-space:nowrap;color:" + (x.montant < 0 ? "#c62828" : "#2e7d32") + "'>" + gnf(x.montant) + "</b></div>" +
          (function () {   // 🔗 correspondance probable (même montant, date différente)
            var b = x.prop !== undefined ? R.absents.filter(function (z) { return z.k === x.prop; })[0] : null;
            return b ? "<div style='margin:4px 0;padding:6px 8px;border-radius:8px;background:rgba(46,125,50,.12)'>🔗 <b>Correspondance probable</b> : " + jourFr(b.date) + " · " + esc(b.lib) + " · " + gnf(b.montant) +
              "<br><button class='bouton' data-abp='" + i + "' data-k='" + b.k + "' style='width:auto;padding:4px 10px;margin:4px 0 0'>✅ Associer (date Base " + jourFr(b.date) + " → " + esc(x.d.split("-").reverse().join("/")) + ")</button></div>" : "";
          })() +
          "<div class='ligne' style='gap:6px;flex-wrap:wrap'><button class='bouton second' data-abc='" + i + "' style='width:auto;flex:0 0 auto;padding:4px 10px;margin:0'>➕ Créer l'écriture</button><button class='bouton second' data-abr='" + i + "' style='width:auto;flex:0 0 auto;padding:4px 10px;margin:0'>🔁 En faire un récurrent</button>" +
          (R.absents.some(function (z) { return (z.montant < 0) === (x.montant < 0); }) ? "<button class='bouton second' data-aba='" + i + "' style='width:auto;flex:0 0 auto;padding:4px 10px;margin:0'>🔗 Associer…</button>" : "") + "</div>" +
          (AUD.assoc === i ? (function () {
            var L = R.absents.filter(function (z) { return (z.montant < 0) === (x.montant < 0); }).sort(function (a, b) { return Math.abs(Math.abs(a.montant) - Math.abs(x.montant)) - Math.abs(Math.abs(b.montant) - Math.abs(x.montant)) || Math.abs(a.date - new Date(x.d).getTime()) - Math.abs(b.date - new Date(x.d).getTime()); });
            return "<div class='carte' style='margin:6px 0;background:var(--fond)'><label>Ligne de Base correspondante (dans Base, absente du relevé)</label><select id='abAsS'>" + L.map(function (z) {
              return "<option value='" + z.k + "'>" + (Math.abs(Math.abs(z.montant) - Math.abs(x.montant)) <= 1 ? "= " : "≠ ") + jourFr(z.date) + " · " + esc(z.lib.substring(0, 70)) + " · " + gnf(z.montant) + "</option>"; }).join("") + "</select>" +
              "<div class='ligne' style='gap:6px'><button class='bouton' id='abAsOk' data-i='" + i + "'>✅ Associer et corriger la date</button><button class='bouton second' id='abAsX'>Annuler</button></div></div>";
          })() : "") + "</div>"; }).join("") + "</div>";
      var ABv = R.absents.filter(function (x) { return !x.apres; }), ABa = R.absents.filter(function (x) { return x.apres; });
      function lgAbs(x) { return "<div style='border-top:1px solid var(--bord);padding:4px 0;display:flex;gap:6px'><span class='info' style='margin:0'>" + jourFr(x.date) + "</span><span style='flex:1'>" + esc(x.lib) + "</span><b>" + gnf(x.montant) + "</b></div>"; }
      if (ABv.length) h += "<div class='carte pleine'><h3>❓ Dans Base, absentes du relevé (" + ABv.length + ")</h3><div class='info'>Opération pas encore passée en banque, mauvais compte ou montant différent : à vérifier.</div>" + ABv.map(lgAbs).join("") + "</div>";
      if (ABa.length) h += "<details class='carte pleine'><summary><b>🕒 Saisies dans Base après la fin du relevé (" + ABa.length + ")</b></summary><div class='info'>Datées après le " + esc(R.au.split("-").reverse().join("/")) + " : normales si l'opération n'est pas encore passée en banque ; sinon associez-les à leur ligne du relevé (🔗).</div>" + ABa.map(lgAbs).join("") + "</details>";
      if (R.pointees.length) h += "<details class='carte pleine'><summary><b>✅ Lignes pointées (" + R.pointees.length + ")</b></summary>" + R.pointees.map(function (x) { return "<div style='border-top:1px solid var(--bord);padding:3px 0;font-size:13px'>" + esc(x.d) + " · " + esc(x.lib) + " · <b>" + gnf(x.montant) + "</b><div class='info' style='margin:0'>↔ " + esc(x.base) + "</div></div>"; }).join("") + "</details>";
    }
    $("vueListe").innerHTML = h; montrer("vueListe");
    $("abC").onchange = function () { AUD.compte = this.value; AUD.res = null; };
    $("abF").onchange = function () {
      var f = this.files[0]; if (!f) return; AUD.res = null; AUD.lignes = null; AUD.fichier = f.name; AUD.fichierData = null; AUD.lien = ""; AUD.msg = "⏳ Lecture de " + f.name + "…"; $("abI").textContent = AUD.msg;
      audLireBase64(f).then(function (b) { AUD.fichierData = b.data; AUD.mime = b.mime; });
      relLireFichier(f).then(function (L) { if (!L.length) throw new Error("aucune opération reconnue dans ce fichier"); AUD.lignes = L; AUD.numero = L.numero || ""; AUD.depuisDepot = false; afficherAudit(); },
        function (e) { AUD.msg = "⛔ " + e.message; afficherAudit(); });
    };
    $("abGo").onclick = function () {
      if (!AUD.compte) { alert("⛔ Choisissez le compte bancaire du relevé."); return; }
      $("abGo").disabled = true; $("abGo").textContent = "⏳ Mise à jour du compte depuis Base, puis comparaison…";
      var yA = window.scrollY;
      api({ api: "audit", op: "analyser", compte: AUD.compte, fichier: AUD.fichier, lignes: AUD.lignes, fichierData: AUD.fichierData || "", mime: AUD.mime || "", numero: AUD.numero || "", confirmeNumero: !!AUD.confirmeNumero, sansControle: !!AUD.depuisDepot }, 300000).then(function (r) {
        AUD.confirmeNumero = false;
        if (r && r.confirmerNumero) { if (confirm(r.titre + "\n\n" + r.message)) { AUD.confirmeNumero = true; $("abGo").disabled = false; $("abGo").click(); } else afficherAudit(); return; } if (r && r.ok) { if (r.lien) { AUD.lien = r.lien; AUD.fichierData = null; } else if (AUD.lien) r.lien = AUD.lien; } AUD.res = r; afficherAudit(); if (AUD.garderPos) window.scrollTo(0, yA); AUD.garderPos = false; },
        function (e) { alert("⛔ " + e.message); afficherAudit(); });
    };
    if (R && $("abIns")) $("abIns").onclick = function () {
      var ch = Array.prototype.filter.call(document.querySelectorAll(".abR"), function (c) { return c.checked; }).map(function (c) { return R.recurrents[+c.getAttribute("data-i")]; });
      if (!ch.length || !confirm("Inscrire " + ch.length + " prélèvement(s) dans Base (" + R.compte + ") ?")) return;
      api({ api: "audit", op: "inscrire", compte: R.compte, choix: ch }, 180000).then(function (r) { alert("✅ " + r.titre + "\n" + r.message); $("abGo").click(); }, function (e) { alert("⛔ " + e.message); });
    };
    if (R) {
      Array.prototype.forEach.call(document.querySelectorAll("[data-abc]"), function (b) { b.onclick = function () { var x = R.anomalies[+b.getAttribute("data-abc")];
        AUD.creation = { x: x, R: R };
        var ouvrir = function () {   // tout pré-rempli : société du compte, compte, opération, montant, date du relevé, objet, catégorie proposée
          var cF = ((S.fin && S.fin.comptes) || []).concat((S.treso && S.treso.comptes) || []).filter(function (c) { return String(c.nom).toUpperCase() === String(R.compte).toUpperCase() && c.societe; })[0];
          formulaireFin({ type: "Opération constatée", op: x.montant < 0 ? "Prelevement bancaire" : "Credit bancaire", societe: cF ? cF.societe : "", compte: R.compte, devise: R.devise || (cF && cF.devise) || "GNF", montant: Math.abs(x.montant),
            objet: "Relevé : " + x.lib.substring(0, 150), categorie: x.catSug || "", dateEffet: new Date(x.d + "T12:00:00").getTime() }); };
        if (S.fin) ouvrir(); else rafraichirFin().then(ouvrir, function () { alert("⛔ Finances indisponible (réseau)."); }); }; });
      if ($("abAl")) $("abAl").onclick = function () {
        var DC = R.pointees.filter(function (x) { return x.decale && x.bd; });
        if (!confirm("Mettre dans Base la date du relevé pour " + DC.length + " ligne(s) pointée(s) (heure de saisie conservée) ?")) return;
        $("abAl").disabled = true; $("abAl").textContent = "⏳ Alignement…";
        api({ api: "audit", op: "aligner", compte: R.compte, lignes: DC.map(function (x) { return { d: x.d, bd: x.bd, bm: x.bm, lib: x.lib }; }) }, 180000).then(function (r) {
          if (!r.titre) { alert("⛔ Le script installé ne connaît pas encore cette opération : collez la dernière version du script."); return; }
          alert((r.ok ? "✅ " : "⛔ ") + r.titre + "\n" + (r.message || "").split("\n").slice(0, 15).join("\n"));
          AUD.garderPos = true; setTimeout(function () { $("abGo").click(); }, 4000);   // la feuille du compte se recalcule
        }, function (e) { alert("⛔ " + e.message); afficherAudit(); });
      };
      function associer(x, b) {
        var ecartMt = Math.abs(Math.abs(b.montant) - Math.abs(x.montant)) > 1;
        if (!confirm("Associer :\n• relevé " + x.d + " · " + x.lib.substring(0, 60) + " · " + gnf(x.montant) + "\n• Base " + jourFr(b.date) + " · " + b.lib.substring(0, 60) + " · " + gnf(b.montant) +
          "\n\nLa date de la ligne dans Base devient " + x.d.split("-").reverse().join("/") + " (le relevé fait foi)." + (ecartMt ? "\n\n⚠️ Montants différents : seul la date est corrigée." : ""))) return;
        api({ api: "audit", op: "associer", compte: R.compte, baseDate: b.date, baseMontant: b.montant, releveDate: x.d, releveLib: x.lib }, 200000).then(function (r) {
          if (!r.titre) { alert("⛔ Le script installé ne connaît pas encore l'association : collez la dernière version du script dans BASE et PRODUCTION, puis Nouvelle version du web app."); return; }
          if (!r.ok) { alert("⛔ " + r.titre + "\n" + (r.message || "")); return; }
          // Résultat appliqué tout de suite (la feuille du compte peut mettre quelques secondes à se recalculer) : la paire passe en pointées.
          R.anomalies = R.anomalies.filter(function (z) { return z !== x; });
          R.absents = R.absents.filter(function (z) { return z.k !== b.k; });
          if (!r.deja && R.soldeAu) { var cp = audCoupe(R); if (x.d <= R.soldeAu && b.date > cp) audMajSolde(R, b.montant); else if (x.d > R.soldeAu && b.date <= cp) audMajSolde(R, -b.montant); }
          R.anomalies.forEach(function (z) { if (z.prop === b.k) delete z.prop; if (z.cands) z.cands = z.cands.filter(function (k) { return k !== b.k; }); });
          R.pointees.push({ i: x.i, d: x.d, lib: x.lib, montant: x.montant, base: "🔗 " + b.lib + " (date " + jourFr(b.date) + " → " + x.d.split("-").reverse().join("/") + ")" });
          (R.associees = R.associees || []).push(x.d + " · " + x.lib.substring(0, 60) + " · " + gnf(x.montant) + " ↔ Base ligne " + r.ligne + (r.deja ? " (déjà à la bonne date)" : " : " + r.avant + " → " + r.apres));
          AUD.assoc = null; var y = window.scrollY; afficherAudit("banque"); window.scrollTo(0, y);
          alert("✅ " + r.titre + "\n" + r.message + "\n\nLa paire est passée dans « Lignes pointées » ; solde Base et écart mis à jour.");
        }, function (e) { alert("⛔ " + e.message); });
      }
      // 🧩 validation d'un regroupement (proposé ou manuel)
      function regrouper(rel, bases, g) {
        var sR = rel.reduce(function (s, x) { return s + x.montant; }, 0), sB = bases.reduce(function (s, z) { return s + z.montant; }, 0), dC = rel.map(function (x) { return x.d; }).sort().pop();
        if (!confirm(bases.length ? "Regrouper " + rel.length + " ligne(s) du relevé (" + gnf(sR) + ") avec " + bases.length + " ligne(s) de Base (" + gnf(sB) + ") ?\n\nDate dans Base : " + dC.split("-").reverse().join("/") + " (la plus récente du relevé)."
          : "Neutraliser " + rel.length + " ligne(s) du relevé (débit et crédit de la banque, total " + gnf(sR) + ") ? Rien n'est écrit dans Base.")) return;
        api({ api: "audit", op: "regrouper", compte: R.compte, rel: rel.map(function (x) { return { d: x.d, debit: x.debit, credit: x.credit, lib: x.lib }; }), bases: bases.map(function (z) { return { bd: z.date, bm: z.montant }; }) }, 200000).then(function (r) {
          if (!r.titre) { alert("⛔ Le script installé ne connaît pas encore le regroupement : collez la dernière version du script."); return; }
          if (!r.ok) { alert("⛔ " + r.titre + "\n" + (r.message || "")); return; }
          var iS = rel.map(function (x) { return x.i; }), kS = bases.map(function (z) { return z.k; });
          R.anomalies = R.anomalies.filter(function (x) { return iS.indexOf(x.i) < 0; }); R.recurrents = R.recurrents.filter(function (x) { return iS.indexOf(x.i) < 0; });
          R.absents = R.absents.filter(function (z) { return kS.indexOf(z.k) < 0; }); if (g) R.groupes = R.groupes.filter(function (y) { return y !== g; });
          R.anomalies.forEach(function (z) { if (kS.indexOf(z.prop) >= 0) delete z.prop; });
          if (R.soldeAu) { var cp = audCoupe(R); bases.forEach(function (z) { if (dC <= R.soldeAu && z.date > cp) audMajSolde(R, z.montant); else if (dC > R.soldeAu && z.date <= cp) audMajSolde(R, -z.montant); }); }
          var txt = bases.length ? "🧩 " + bases.map(function (z) { return z.lib; }).join(" + ") : "🔄 Neutralisé (débit et crédit de la banque)";
          rel.forEach(function (x) { R.pointees.push({ i: x.i, d: x.d, lib: x.lib, montant: x.montant, base: txt }); });
          (R.associees = R.associees || []).push(!bases.length ? "🔄 " + rel.length + " ligne(s) neutralisée(s) (erreur de la banque)" : "🧩 " + rel.length + " ligne(s) du relevé (" + gnf(sR) + ") ↔ " + bases.length + " ligne(s) de Base · date " + dC.split("-").reverse().join("/"));
          var y = window.scrollY; afficherAudit("banque"); window.scrollTo(0, y);
          alert("✅ " + r.titre + "\n" + r.message);
        }, function (e) { alert("⛔ " + e.message); });
      }
      Array.prototype.forEach.call(document.querySelectorAll("[data-gv]"), function (b) { b.onclick = function () { var g = R.groupes[+b.getAttribute("data-gv")]; regrouper(g.rel, g.bases, g); }; });
      Array.prototype.forEach.call(document.querySelectorAll("[data-gx]"), function (b) { b.onclick = function () { var g = R.groupes[+b.getAttribute("data-gx")];
        R.groupes = R.groupes.filter(function (y) { return y !== g; }); R.anomalies = R.anomalies.concat(g.rel); R.absents = R.absents.concat(g.bases);
        var y = window.scrollY; afficherAudit("banque"); window.scrollTo(0, y); }; });
      if ($("abGm")) $("abGm").onclick = function () { AUD.grpMan = !AUD.grpMan; var y = window.scrollY; afficherAudit("banque"); window.scrollTo(0, y); };
      function selMan() {
        var tous = R.anomalies.concat(R.recurrents);
        var rel = Array.prototype.filter.call(document.querySelectorAll(".abMR"), function (c) { return c.checked; }).map(function (c) { var i = +c.getAttribute("data-i"); return tous.filter(function (x) { return x.i === i; })[0]; });
        var bases = Array.prototype.filter.call(document.querySelectorAll(".abMB"), function (c) { return c.checked; }).map(function (c) { var k = +c.getAttribute("data-k"); return R.absents.filter(function (z) { return z.k === k; })[0]; });
        return { rel: rel, bases: bases };
      }
      Array.prototype.forEach.call(document.querySelectorAll(".abMR, .abMB"), function (c) { c.onchange = function () {
        var s = selMan(), sR = s.rel.reduce(function (t, x) { return t + x.montant; }, 0), sB = s.bases.reduce(function (t, z) { return t + z.montant; }, 0);
        var neutre = !s.bases.length && s.rel.length >= 2, ok = s.rel.length && (neutre || (s.bases.length && s.rel.length + s.bases.length >= 3)) && Math.abs(sR - sB) <= 1;
        $("abMT").innerHTML = "Relevé " + s.rel.length + " ligne(s) : " + gnf(sR) + " · Base " + s.bases.length + " ligne(s) : " + gnf(sB) + " · " + (ok ? "<span style='color:#2e7d32'>✅ totaux égaux</span>" : "<span style='color:#c62828'>écart " + gnf(sR - sB) + "</span>");
        $("abMOk").disabled = !ok; $("abMOk").textContent = neutre ? "🔄 Neutraliser (erreur de la banque : débit + crédit)" : "✅ Valider le regroupement"; }; });
      if ($("abMOk")) $("abMOk").onclick = function () { var s = selMan(); regrouper(s.rel, s.bases, null); };
      Array.prototype.forEach.call(document.querySelectorAll("[data-abp]"), function (b) { b.onclick = function () {
        var x = R.anomalies[+b.getAttribute("data-abp")], k = +b.getAttribute("data-k"); associer(x, R.absents.filter(function (z) { return z.k === k; })[0]); }; });
      Array.prototype.forEach.call(document.querySelectorAll("[data-aba]"), function (b) { b.onclick = function () { var i = +b.getAttribute("data-aba"); AUD.assoc = AUD.assoc === i ? null : i; var y = window.scrollY; afficherAudit("banque"); window.scrollTo(0, y); }; });
      if ($("abAsX")) $("abAsX").onclick = function () { AUD.assoc = null; var y = window.scrollY; afficherAudit("banque"); window.scrollTo(0, y); };
      if ($("abAsOk")) $("abAsOk").onclick = function () { var x = R.anomalies[+$("abAsOk").getAttribute("data-i")], k = +$("abAsS").value; associer(x, R.absents.filter(function (z) { return z.k === k; })[0]); };
      Array.prototype.forEach.call(document.querySelectorAll("[data-abr]"), function (b) { b.onclick = function () { var x = R.anomalies[+b.getAttribute("data-abr")];
        AUD.motif = x.lib.replace(/\s*-?\s*Ref No.*$/i, "").replace(/\d{6,}/g, "").trim().substring(0, 40); AUD.edit = null; afficherAudit("regles"); }; });
    }
  }
  /* ---------- 🕘 Aperçus : 5 dernières opérations (repliable, sans encombrer) ---------- */
  var APC = {};   // cache des aperçus serveur (clé → {t, r})
  function apercuBloc(id, titre, corps, ouvert) {
    return "<details class='apercu' data-ap='" + id + "'" + (ouvert ? " open" : "") + " style='margin:6px 0;border:1px dashed var(--bord);border-radius:10px;padding:4px 10px;font-size:13px'>" +
      "<summary style='cursor:pointer;color:var(--cuivre)'>🕘 " + esc(titre) + "</summary><div style='padding:4px 0'>" + corps + "</div></details>";
  }
  function apercuLignes(L, dev) {
    if (!L.length) return "<div class='info' style='margin:0'>Aucune opération.</div>";
    return L.map(function (l) { var dv = l.dev || dev; return "<div style='display:flex;gap:6px;border-top:1px solid var(--bord);padding:3px 0'><span class='info' style='margin:0;white-space:nowrap'>" + (l.date ? jourFr(l.date).slice(0, 5) : "") + "</span>" +
      "<span style='flex:1;overflow:hidden;text-overflow:ellipsis'>" + esc(l.lib) + "</span>" + (l.montant !== undefined && l.montant !== "" ? "<b style='white-space:nowrap;color:" + (l.montant < 0 ? "#c62828" : "#2e7d32") + "'>" + (l.montant > 0 ? "+" : l.montant < 0 ? "−" : "") + gnf(Math.abs(l.montant)) + (dv ? " " + esc(dv) : "") + "</b>" : "") + "</div>"; }).join("");
  }
  function apercuEtat(id) { var el = $(id); return el && el.querySelector("details") && el.querySelector("details").open; }
  // Comptes : caisses consultables, banques Walid / DG (le serveur décide) ; chargé à l'ouverture du bandeau.
  function apercuCompte(id, nom, lib) {
    var el = $(id); if (!el) return;
    if (!nom) { el.innerHTML = ""; el.dataset.k = ""; return; }
    if (el.dataset.k === nom) return;
    el.dataset.k = nom;
    var c = APC["c:" + nom];
    el.innerHTML = apercuBloc(id, "5 dernières opérations · " + nom + (c && c.r && !c.r.interdit ? " · solde " + gnf(c.r.solde) + " " + (c.r.devise || "") : ""), c && c.r ? (c.r.interdit ? "<div class='info' style='margin:0'>Compte non consultable.</div>" : apercuLignes(c.r.lignes, c.r.devise)) : "<div class='info' style='margin:0'>Touchez pour charger…</div>");
    if (c && c.r && c.r.interdit) { el.innerHTML = ""; return; }
    var d = el.querySelector("details");
    d.ontoggle = function () {
      if (!d.open || (c && c.r && Date.now() - c.t < 120000)) return;
      d.querySelector("div").innerHTML = "<div class='info' style='margin:0'>⏳ Chargement…</div>";
      api({ api: "apercu", quoi: "compte", nom: nom }).then(function (r) {
        APC["c:" + nom] = { t: Date.now(), r: r };
        if (r.interdit) { el.innerHTML = ""; return; }
        d.querySelector("summary").textContent = "🕘 5 dernières opérations · " + nom + " · solde " + gnf(r.solde) + " " + (r.devise || "");
        d.querySelector("div").innerHTML = apercuLignes(r.lignes, r.devise);
      }, function (e) { d.querySelector("div").innerHTML = "<div class='info' style='margin:0'>⛔ " + esc(e.message) + " (réseau nécessaire)</div>"; });
    };
  }
  // Données déjà sur l'appareil (Finances, Commercial) : affichées tout de suite.
  function apercuLocal(id, L, titre) {
    var el = $(id); if (!el) return;
    if (!L) { el.innerHTML = ""; el.dataset.k = ""; return; }
    var k = titre + "|" + L.length; if (el.dataset.k === k) return; el.dataset.k = k;
    var ouv = apercuEtat(id);
    el.innerHTML = apercuBloc(id, titre + " (" + Math.min(5, L.length) + ")", apercuLignes(L.slice(0, 5), ""), ouv);
  }
  function apercuServeur(id, cle, corps, titre, rendu) {
    var el = $(id); if (!el) return;
    if (!cle) { el.innerHTML = ""; el.dataset.k = ""; return; }
    if (el.dataset.k === cle) return; el.dataset.k = cle;
    var c = APC[cle];
    el.innerHTML = apercuBloc(id, titre, c ? rendu(c.r) : "<div class='info' style='margin:0'>Touchez pour charger…</div>");
    var d = el.querySelector("details");
    d.ontoggle = function () {
      if (!d.open || (c && Date.now() - c.t < 120000)) return;
      d.querySelector("div").innerHTML = "<div class='info' style='margin:0'>⏳ Chargement…</div>";
      corps.api = "apercu";
      api(corps).then(function (r) { c = APC[cle] = { t: Date.now(), r: r }; d.querySelector("div").innerHTML = rendu(r); },
        function (e) { d.querySelector("div").innerHTML = "<div class='info' style='margin:0'>⛔ " + esc(e.message) + " (réseau nécessaire)</div>"; });
    };
  }
  function apercuFinListe(filtre) {
    var F = S.fin; if (!F) return [];
    return F.demandes.filter(filtre).sort(function (a, b) { return (b.execute || b.date) - (a.execute || a.date); }).map(function (d) {
      return { date: d.execute || d.date, lib: d.no + " · " + (d.objet || d.motifRH || d.type) + " · " + d.statut, montant: -(+d.montant || 0), dev: d.devise };
    });
  }
  /* ---------- ❓ Aide : manuel d'utilisation (aide.js + images aide/*.jpg), recherche, filtré par droits ---------- */
  var AIDE = { ctx: "", rub: "", q: "", fiche: "" };
  var AIDE_TUILE = { scan: "atelier", manuel: "atelier", journal: "atelier", avancement: "atelier", planif: "planif", magasins: "magasins", stockval: "magasins",
    finances: "finances", treso: "treso", rh: "rh", commercial: "commercial", repartition: "repartition", missions: "missions" };
  var AIDE_RUBS = [["base", "📱", "Démarrer & appareil"], ["atelier", "📷", "Atelier"], ["planif", "🗂️", "Planification"], ["magasins", "🏬", "Magasins"], ["finances", "💰", "Finances"],
    ["treso", "🏦", "Trésorerie"], ["rh", "👥", "RH"], ["commercial", "🤝", "Commercial"], ["repartition", "📊", "Répartition"], ["missions", "🎯", "Missions"], ["notifs", "🔔", "Notifications"]];
  function chargerAide() {
    if (window.AIDE_FICHES) return Promise.resolve();
    return new Promise(function (ok, ko) { var sc = document.createElement("script"); sc.src = "aide.js"; sc.onload = function () { ok(); }; sc.onerror = function () { ko(new Error("manuel indisponible (réseau nécessaire la 1re fois)")); }; document.head.appendChild(sc); });
  }
  function aideTags() {
    var d = (S.formulaires && S.formulaires.droits) || {}, nom = String((S.agent && S.agent.nom) || "").toUpperCase(), T = { tous: 1 };
    if (S.agent) T.agent = 1;
    ["planif", "stock", "finances", "rh", "commercial", "treso", "comptable"].forEach(function (k) { if (d[k]) T[k] = 1; });
    if (d.validation) { T.direction = 1; T.finances = 1; }
    if (d.validation === "DG" || nom === "DG") { ["planif", "stock", "finances", "rh", "commercial", "treso", "comptable", "direction", "dg", "dirNom"].forEach(function (k) { T[k] = 1; }); }
    if (nom === "DG" || nom === "WALID") T.dirNom = 1;
    return T;
  }
  function aideNorm(x) { return String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/<[^>]+>/g, " "); }
  function aideVisibles() { var T = aideTags(); return (window.AIDE_FICHES || []).filter(function (f) { return (f.droits || ["tous"]).some(function (k) { return T[k]; }); }); }
  function afficherAide(rub, fiche) {
    $("titre").textContent = "Aide";
    if (rub !== undefined) { AIDE.rub = rub || ""; AIDE.fiche = fiche || ""; AIDE.q = ""; }
    $("vueListe").innerHTML = "<div class='carte'><h3>❓ Aide</h3><p class='info'>⏳ Chargement du manuel…</p></div>"; montrer("vueListe");
    chargerAide().then(dessinerAide, function (e) { $("vueListe").innerHTML = "<div class='carte'><h3>❓ Aide</h3><p class='info'>⛔ " + esc(e.message) + "</p></div>"; });
  }
  function dessinerAide() {
    var V = aideVisibles(), f = AIDE.fiche ? V.filter(function (x) { return x.id === AIDE.fiche; })[0] : null;
    if (f) { ficheAide(f, V); return; }
    var mots = aideNorm(AIDE.q).split(/\s+/).filter(String);
    var L = V.filter(function (x) { if (AIDE.rub && !mots.length && x.rub !== AIDE.rub) return false;
      if (!mots.length) return true; var t = aideNorm(x.titre + " " + x.mots + " " + x.intro + " " + (x.etapes || []).join(" ") + " " + (x.notes || []).join(" "));
      return mots.every(function (m) { return t.indexOf(m) >= 0; }); });
    if (mots.length) L.sort(function (a, b) { function sc(x) { var t = aideNorm(x.titre + " " + x.mots); return mots.filter(function (m) { return t.indexOf(m) >= 0; }).length; } return sc(b) - sc(a); });
    var nR = {}; V.forEach(function (x) { nR[x.rub] = (nR[x.rub] || 0) + 1; });
    var h = "<div class='carte pleine'><h3>❓ Aide — manuel DuoCore</h3><input id='aiQ' placeholder='🔎 Rechercher : billet, facture, scanner, clôturer…' value='" + esc(AIDE.q) + "' style='font-size:16px'>" +
      "<div class='ligne' style='flex-wrap:wrap;gap:6px;margin-top:8px'><button class='bouton " + (AIDE.rub ? "second" : "") + "' data-ar='' style='width:auto;flex:0 0 auto;padding:6px 10px;margin:0'>Tout (" + V.length + ")</button>" +
      AIDE_RUBS.filter(function (r) { return nR[r[0]]; }).map(function (r) { return "<button class='bouton " + (AIDE.rub === r[0] ? "" : "second") + "' data-ar='" + r[0] + "' style='width:auto;flex:0 0 auto;padding:6px 10px;margin:0'>" + r[1] + " " + r[2] + " (" + nR[r[0]] + ")</button>"; }).join("") + "</div>" +
      (mots.length && AIDE.rub ? "<div class='info'>Recherche dans tout le manuel.</div>" : "") + "</div>";
    h += L.map(function (x) { var r = AIDE_RUBS.filter(function (y) { return y[0] === x.rub; })[0] || ["", "📄", ""];
      return "<div class='carte' data-af='" + esc(x.id) + "' style='cursor:pointer'><b>" + r[1] + " " + esc(x.titre) + "</b><div class='info'>" + esc(x.intro || "") + (x.img ? " 🖼️" : "") + "</div></div>"; }).join("") ||
      "<p class='info' style='padding:0 4px'>Aucune fiche ne correspond. Essayez un autre mot (ex. « paiement », « stock »).</p>";
    $("vueListe").innerHTML = h;
    var q = $("aiQ"); q.oninput = function () { AIDE.q = q.value; var pos = q.selectionStart; dessinerAide(); var q2 = $("aiQ"); q2.focus(); try { q2.setSelectionRange(pos, pos); } catch (e) {} };
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-ar]"), function (b) { b.onclick = function () { AIDE.rub = b.getAttribute("data-ar"); dessinerAide(); }; });
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-af]"), function (b) { b.onclick = function () { AIDE.fiche = b.getAttribute("data-af"); dessinerAide(); window.scrollTo(0, 0); }; });
  }
  function ficheAide(f, V) {
    var r = AIDE_RUBS.filter(function (y) { return y[0] === f.rub; })[0] || ["", "📄", ""];
    var voir = (f.voir || []).map(function (id) { return V.filter(function (x) { return x.id === id; })[0]; }).filter(Boolean);
    var h = "<div class='carte pleine'><div class='ligne' style='justify-content:space-between'><div class='info' style='margin:0'>" + r[1] + " " + esc(r[2]) + "</div><button class='bouton second' id='aiL' style='width:auto;flex:0 0 auto;margin:0'>‹ Liste</button></div>" +
      "<h3 style='margin-top:8px'>" + esc(f.titre) + "</h3><div class='info'>" + esc(f.qui || "") + "</div>" + (f.intro ? "<p>" + esc(f.intro) + "</p>" : "") +
      (f.img ? "<img src='aide/" + esc(f.img) + ".jpg?v=" + esc(window.AIDE_IMG_V || "1") + "' alt='' loading='lazy' style='max-width:100%;border-radius:10px;border:1px solid var(--bord);margin:6px 0' onerror=\"this.style.display='none'\">" : "") +
      "<ol style='padding-left:22px;line-height:1.55'>" + (f.etapes || []).map(function (e) { return "<li style='margin:6px 0'>" + e + "</li>"; }).join("") + "</ol>" +
      ((f.notes || []).length ? "<div style='margin-top:8px'>" + f.notes.map(function (n) { return "<div class='info' style='margin:6px 0;font-size:14px'>" + n + "</div>"; }).join("") + "</div>" : "") +
      (voir.length ? "<div style='margin-top:10px'><b>Voir aussi</b>" + voir.map(function (x) { return "<div data-af='" + esc(x.id) + "' style='cursor:pointer;color:var(--cuivre);margin:4px 0'>→ " + esc(x.titre) + "</div>"; }).join("") + "</div>" : "") + "</div>";
    $("vueListe").innerHTML = h;
    $("aiL").onclick = function () { AIDE.fiche = ""; dessinerAide(); };
    Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-af]"), function (b) { b.onclick = function () { AIDE.fiche = b.getAttribute("data-af"); dessinerAide(); window.scrollTo(0, 0); }; });
  }
  function afficherNotifs() {
    lire("notifs").then(function (L) {
      L = L || [];
      $("titre").textContent = "Notifications";
      var A = aResoudre(), nm = A.filter(function (x) { return x.moi; }).length;
      var ong = "<div class='onglets' style='margin-top:8px'><button data-cl='resoudre' class='" + (CLOCHE.onglet === "resoudre" ? "actif" : "") + "'>À résoudre (" + A.length + (nm ? " · 👉 " + nm : "") + ")</button><button data-cl='recues' class='" + (CLOCHE.onglet === "recues" ? "actif" : "") + "'>Reçues</button></div>";
      if (CLOCHE.onglet === "resoudre") {
        $("vueListe").innerHTML = "<div class='carte pleine'><h3>🔔 Notifications</h3>" + ong + "<div class='info'>Opérations en cours (données du téléphone) : une ligne disparaît quand l'opération est close. 👉 = action attendue de vous.</div></div>" +
          (function () {
            var GR = groupesNotifs(A), IT = CLOCHE.items = [];
            function carteN(x, retrait) { IT.push(x); var i = IT.length - 1;
              return "<div data-ar='" + i + "' style='cursor:pointer;margin:8px 12px 8px " + (retrait ? 34 : 12) + "px;padding:12px 14px;border-radius:12px;background:var(--fond);border:1px solid var(--bord)" + (x.moi ? ";border-left:4px solid var(--cuivre)" : "") + "'>" +
                "<div style='font-weight:700'>" + (x.moi ? "👉 " : "") + esc(x.t) + "</div><div class='info' style='margin:4px 0 0'>" + esc(x.s) + "</div>" + (x.cb ? cbBoutons(i) : "") + (x.mis ? misBoutons(i, x.mis) : "") + "</div>"; }
            function ouvert(k, def) { return CLOCHE.ouv[k] !== undefined ? CLOCHE.ouv[k] : def; }
            return GR.map(function (g) {
              var o = ouvert(g.rub, g.moi > 0);
              return "<div class='carte pleine' style='padding:0;overflow:hidden;margin-bottom:14px" + (g.moi ? ";border-color:var(--cuivre)" : "") + "'><div data-gr='" + g.rub + "' data-def='" + (g.moi > 0 ? 1 : 0) + "' style='cursor:pointer;padding:14px 16px'><div class='ligne' style='justify-content:space-between'><b style='font-size:16px'>" + (o ? "▼ " : "▶ ") + g.rub + " " + esc(g.lib) + "</b>" +
                "<b style='flex:0;white-space:nowrap'>" + g.n + (g.moi ? " · 👉 " + g.moi : "") + "</b></div></div>" +
                (o ? g.E.map(function (e) {
                  var ke = g.rub + "|" + e.et, oe = ouvert(ke, e.moi > 0 || g.E.length === 1);
                  return "<div style='border-top:1px solid var(--bord);padding-bottom:4px'><div data-gr='" + esc(ke) + "' data-def='" + (e.moi > 0 || g.E.length === 1 ? 1 : 0) + "' style='cursor:pointer;padding:10px 16px'><div class='ligne' style='justify-content:space-between'><b style='color:var(--cuivre)'>" + (oe ? "▾ " : "▸ ") + esc(e.et) + "</b>" +
                    "<span class='info' style='flex:0;white-space:nowrap;margin:0'>" + e.n + (e.moi ? " · 👉 " + e.moi : "") + "</span></div></div>" +
                    (oe ? e.L.map(function (x) {
                      if (!x.enfants) return carteN(x);
                      var kg = "s|" + x.t, os = !!CLOCHE.ouv[kg];
                      return "<div data-gr='" + esc(kg) + "' data-def='0' style='cursor:pointer;margin:8px 12px;padding:12px 14px;border-radius:12px;background:var(--fond);border:1px solid var(--bord)" + (x.moi ? ";border-left:4px solid var(--cuivre)" : "") + "'>" +
                        "<div style='font-weight:700'>" + (os ? "▼ " : "▶ ") + (x.moi ? "👉 " : "") + "🧾 " + esc(x.t) + "</div><div class='info' style='margin:4px 0 0'>" + esc(x.s) + "</div></div>" +
                        (os ? x.enfants.map(function (c) { return carteN(c, true); }).join("") : "");
                    }).join("") : "") + "</div>";
                }).join("") : "") + "</div>";
            }).join("") || "<p class='info' style='padding:0 4px'>Rien à résoudre. 🎉</p>";
          })();
        montrer("vueListe");
        Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-ar]"), function (el) { el.onclick = function () { CLOCHE.items[+el.getAttribute("data-ar")].ouvrir(); }; });
        cbLierBoutons($("vueListe"), CLOCHE.items.map(function (x) { return x.cb; }), function () { afficherNotifs(); });
        misLierBoutons($("vueListe"), CLOCHE.items.map(function (x) { return x.mis; }), function () { afficherNotifs(); });
        Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-gr]"), function (el) { el.onclick = function () { var k = el.getAttribute("data-gr");
          var cur = CLOCHE.ouv[k] !== undefined ? CLOCHE.ouv[k] : el.getAttribute("data-def") === "1"; CLOCHE.ouv[k] = !cur; afficherNotifs(); }; });
        Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-cl]"), function (b) { b.onclick = function () { CLOCHE.onglet = b.getAttribute("data-cl"); afficherNotifs(); }; });
        return;
      }
      $("vueListe").innerHTML = "<div class='carte pleine'><h3>🔔 Notifications</h3>" + ong + "<div class='info'>Reçues sur cet appareil (30 derniers jours). Touchez pour ouvrir l'opération.</div>" +
        (L.some(function (x) { return !x.lu; }) ? "<button class='bouton second' id='ntTout'>✓ Tout marquer comme lu</button>" : "") + "</div>" +
        (L.map(function (x, i) {
          return "<div class='carte' data-nt='" + i + "' style='cursor:pointer" + (x.lu ? ";opacity:.6" : ";border-color:var(--cuivre)") + "'><div class='ligne' style='justify-content:space-between'><b>" + (x.lu ? "" : "● ") + esc(x.titre) + "</b>" +
            "<span class='info' style='flex:0;white-space:nowrap'>" + dateCourte(x.recu) + "</span></div><div>" + esc(x.texte) + "</div></div>";
        }).join("") || "<p class='info' style='padding:0 4px'>Aucune notification.</p>");
      montrer("vueListe");
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-cl]"), function (b) { b.onclick = function () { CLOCHE.onglet = b.getAttribute("data-cl"); afficherNotifs(); }; });
      if ($("ntTout")) $("ntTout").onclick = function () { L.forEach(function (x) { x.lu = true; }); ecrire("notifs", L).then(majCloche).then(afficherNotifs); };
      Array.prototype.forEach.call($("vueListe").querySelectorAll("[data-nt]"), function (el) { el.onclick = function () { var x = L[+el.getAttribute("data-nt")]; ouvrirDepuisNotif({ vue: x.vue, id: x.id }); }; });
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
      var cadreSc = PL.id ? $("plCadre") : $("cadre"); if (!PL.id && $("lotAp")) $("lotAp").style.display = "none";
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
  /* ‹ Retour : revient à l'écran précédent (pile de navigation), l'accueil seulement en bout de pile.
     Les formulaires sont transitoires : après un envoi, ‹ ne rouvre pas le formulaire vide. */
  var NAV_ECRANS = ["afficherListe", "afficherFinances", "ouvrirDemandeFin", "formulaireFin", "afficherSoldes", "afficherSuiviAchats", "afficherRH", "ouvrirEvRH", "ficheRH", "formulaireEvRH", "formulaireSalaireRH", "formulaireDepartRH", "formulaireNouvelRH", "afficherPaieRH", "afficherCom", "ficheContratCom", "ficheFactureCom", "ficheClientCom", "formulaireContratCom", "formulaireBdcCom", "formulaireDocCom", "formulaireEncCom", "formulaireRelanceCom", "afficherMis", "ficheMis", "formulaireMis", "afficherFournisseurs", "ficheFourMere", "formulaireFourMere", "formulaireCompteFour", "afficherInterco", "ficheFournisseur", "afficherTreso", "ficheTreso", "afficherJournal", "afficherAvancement", "afficherStockVal", "afficherMagasins", "afficherRepartition", "afficherFiches", "ouvrirFormulaire", "afficherNotifs"];
  var NAV_FN = {};
  NAV_FN.afficherListe = afficherListe;
  NAV_FN.afficherFinances = afficherFinances;
  NAV_FN.ouvrirDemandeFin = ouvrirDemandeFin;
  NAV_FN.formulaireFin = formulaireFin;
  NAV_FN.afficherSoldes = afficherSoldes;
  NAV_FN.afficherSuiviAchats = afficherSuiviAchats;
  NAV_FN.afficherRH = afficherRH;
  NAV_FN.ouvrirEvRH = ouvrirEvRH;
  NAV_FN.ficheRH = ficheRH;
  NAV_FN.formulaireEvRH = formulaireEvRH;
  NAV_FN.formulaireSalaireRH = formulaireSalaireRH;
  NAV_FN.formulaireDepartRH = formulaireDepartRH;
  NAV_FN.formulaireNouvelRH = formulaireNouvelRH;
  NAV_FN.afficherPaieRH = afficherPaieRH;
  NAV_FN.afficherCom = afficherCom;
  NAV_FN.ficheContratCom = ficheContratCom;
  NAV_FN.ficheFactureCom = ficheFactureCom;
  NAV_FN.ficheClientCom = ficheClientCom;
  NAV_FN.formulaireContratCom = formulaireContratCom;
  NAV_FN.formulaireBdcCom = formulaireBdcCom;
  NAV_FN.formulaireDocCom = formulaireDocCom;
  NAV_FN.formulaireEncCom = formulaireEncCom;
  NAV_FN.formulaireRelanceCom = formulaireRelanceCom;
  NAV_FN.afficherMis = afficherMis;
  NAV_FN.ficheMis = ficheMis;
  NAV_FN.formulaireMis = formulaireMis;
  NAV_FN.afficherFournisseurs = afficherFournisseurs;
  NAV_FN.ficheFourMere = ficheFourMere;
  NAV_FN.formulaireFourMere = formulaireFourMere;
  NAV_FN.formulaireCompteFour = formulaireCompteFour;
  NAV_FN.afficherInterco = afficherInterco;
  NAV_FN.ficheFournisseur = ficheFournisseur;
  NAV_FN.afficherTreso = afficherTreso;
  NAV_FN.ficheTreso = ficheTreso;
  NAV_FN.afficherJournal = afficherJournal;
  NAV_FN.afficherAvancement = afficherAvancement;
  NAV_FN.afficherStockVal = afficherStockVal;
  NAV_FN.afficherMagasins = afficherMagasins;
  NAV_FN.afficherRepartition = afficherRepartition;
  NAV_FN.afficherFiches = afficherFiches;
  NAV_FN.ouvrirFormulaire = ouvrirFormulaire;
  NAV_FN.afficherNotifs = afficherNotifs;
  NAV_ECRANS.forEach(function (n) { NAV_FN[n] = navEnvelopper(n, NAV_FN[n]); });
  afficherListe = NAV_FN.afficherListe;
  afficherFinances = NAV_FN.afficherFinances;
  ouvrirDemandeFin = NAV_FN.ouvrirDemandeFin;
  formulaireFin = NAV_FN.formulaireFin;
  afficherSoldes = NAV_FN.afficherSoldes;
  afficherSuiviAchats = NAV_FN.afficherSuiviAchats;
  afficherRH = NAV_FN.afficherRH;
  ouvrirEvRH = NAV_FN.ouvrirEvRH;
  ficheRH = NAV_FN.ficheRH;
  formulaireEvRH = NAV_FN.formulaireEvRH;
  formulaireSalaireRH = NAV_FN.formulaireSalaireRH;
  formulaireDepartRH = NAV_FN.formulaireDepartRH;
  formulaireNouvelRH = NAV_FN.formulaireNouvelRH;
  afficherPaieRH = NAV_FN.afficherPaieRH;
  afficherCom = NAV_FN.afficherCom;
  ficheContratCom = NAV_FN.ficheContratCom;
  ficheFactureCom = NAV_FN.ficheFactureCom;
  ficheClientCom = NAV_FN.ficheClientCom;
  formulaireContratCom = NAV_FN.formulaireContratCom;
  formulaireBdcCom = NAV_FN.formulaireBdcCom;
  formulaireDocCom = NAV_FN.formulaireDocCom;
  formulaireEncCom = NAV_FN.formulaireEncCom;
  formulaireRelanceCom = NAV_FN.formulaireRelanceCom;
  afficherMis = NAV_FN.afficherMis;
  ficheMis = NAV_FN.ficheMis;
  formulaireMis = NAV_FN.formulaireMis;
  afficherFournisseurs = NAV_FN.afficherFournisseurs;
  ficheFourMere = NAV_FN.ficheFourMere;
  formulaireFourMere = NAV_FN.formulaireFourMere;
  formulaireCompteFour = NAV_FN.formulaireCompteFour;
  afficherInterco = NAV_FN.afficherInterco;
  ficheFournisseur = NAV_FN.ficheFournisseur;
  afficherTreso = NAV_FN.afficherTreso;
  ficheTreso = NAV_FN.ficheTreso;
  afficherJournal = NAV_FN.afficherJournal;
  afficherAvancement = NAV_FN.afficherAvancement;
  afficherStockVal = NAV_FN.afficherStockVal;
  afficherMagasins = NAV_FN.afficherMagasins;
  afficherRepartition = NAV_FN.afficherRepartition;
  afficherFiches = NAV_FN.afficherFiches;
  ouvrirFormulaire = NAV_FN.ouvrirFormulaire;
  afficherNotifs = NAV_FN.afficherNotifs;

  $("btnNotifs").onclick = function () { AIDE.ctx = "notifs"; afficherNotifs(); };
  $("btnAide").onclick = function () { afficherAide($("vueAccueil").style.display === "block" ? "" : AIDE.ctx); };
  $("btnRetour").onclick = function () {
    if (FM_OUVERT && $("vueLot").style.display !== "none" && !S.lotOuvert) { var id = FM_OUVERT; FM_OUVERT = null; ouvrirSaisieBDC(id); return; }
    FM_OUVERT = null;
    if ($("vueListe").style.display !== "none" && NAV.pile.length) NAV.pile.pop();   // l'écran affiché est le haut de la pile
    var e = NAV.pile[NAV.pile.length - 1];
    if (!e) { montrer("vueAccueil"); return; }
    NAV.retour = true;
    try { NAV_FN[e.n].apply(null, e.a); } finally { NAV.retour = false; }
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

  Promise.all(["url", "donnees", "gabarit", "gv", "file", "envoyes", "aCorriger", "recents", "derniereSync", "agent", "formulaires", "planif", "planifLocal", "affichage", "fin", "rh", "com", "mis", "treso", "stockv", "journal"].map(lire)).then(function (v) {
    S.journal = v[20] || [];
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
    setTimeout(majCloche, 1200);
    verifierMajAuDemarrage();
    document.addEventListener("visibilitychange", function () { if (!document.hidden) majCloche(); });
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
