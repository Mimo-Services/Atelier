/* Manuel DuoCore : fiches d aide (❓). Images : aide/<img>.jpg */
window.AIDE_IMG_V = "KL";
window.AIDE_FICHES = [
 {
  "id": "base-aide",
  "rub": "base",
  "titre": "Utiliser l'aide",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde.",
  "mots": "aide manuel mode emploi utiliser comment chercher recherche question bouton point interrogation help notice",
  "intro": "L'aide explique chaque tâche de DuoCore, étape par étape. Vous ne voyez que les fiches qui concernent vos droits.",
  "etapes": [
   "Touchez le bouton <b>❓</b>, en haut de l'écran à côté de la cloche 🔔. Depuis une rubrique (Finances, RH…), l'aide s'ouvre directement sur les fiches de cette rubrique.",
   "Écrivez quelques mots dans la recherche, par exemple « dépense caisse » ou « billet ».",
   "Les accents ne sont pas obligatoires : « depense » trouve aussi « dépense ».",
   "Touchez une fiche pour l'ouvrir.",
   "Suivez les étapes dans l'ordre. Les mots en <b>gras</b> sont écrits exactement comme sur l'écran.",
   "Touchez <b>‹ Liste</b> pour revenir à la liste, ou <b>‹</b> en haut à gauche pour quitter l'aide."
  ],
  "notes": [
   "💡 En bas d'une fiche, « Voir aussi » mène aux tâches proches.",
   "💡 Le texte de l'aide marche aussi sans réseau ; les images se téléchargent la 1re fois que vous ouvrez la fiche."
  ],
  "voir": [
   "base-tuiles",
   "base-connexion"
  ],
  "img": "base-aide"
 },
 {
  "id": "base-tuiles",
  "rub": "base",
  "titre": "Comprendre les tuiles de l'accueil",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde. Chacun voit seulement les tuiles de ses droits.",
  "mots": "accueil tuiles icones menu ecran principal boutons atelier gestion appareil badge chiffre rouge orange pastille",
  "intro": "L'accueil montre des tuiles rangées en trois parties : Atelier, Gestion et Appareil. Un chiffre sur une tuile indique ce qui vous attend.",
  "etapes": [
   "<b>Atelier</b> : <b>📷 Scanner une fiche</b>, <b>🔢 Lot sans QR</b>, <b>🧾 Journal Prod</b>, <b>📊 État d'avancement</b> et <b>🗂️ Planification</b>.",
   "<b>Gestion</b> : <b>🏬 Magasins</b>, <b>💰 Finances</b>, <b>👥 RH</b>, <b>🤝 Commercial</b>, <b>🏦 Trésorerie</b>, <b>📊 Répartition</b> et <b>🎯 Missions</b>.",
   "<b>Appareil</b> : <b>🔐 Saisies</b> (se connecter), <b>⏳ En attente</b>, <b>⛔ À corriger</b>, <b>⇅ Synchronisation</b> et <b>⚙️ Réglages</b>.",
   "Un chiffre rouge veut dire : action attendue de vous. Un chiffre orange : saisies pas encore envoyées.",
   "En haut : <b>🔔</b> pour ce qui reste à résoudre, <b>⟳</b> pour synchroniser, <b>☰</b> pour les réglages.",
   "La pastille <b>En ligne</b> / <b>Hors ligne</b> indique si le téléphone a du réseau.",
   "Tout en bas, la date des données du téléphone est affichée."
  ],
  "notes": [
   "💡 Une tuile manque ? Vous n'avez pas ce droit. Demandez au DG de cocher la rubrique dans « Accès App ».",
   "💡 Les tuiles Gestion n'apparaissent qu'après la connexion."
  ],
  "img": "base-tuiles",
  "voir": [
   "base-connexion",
   "base-hors-ligne",
   "nt-a-resoudre"
  ]
 },
 {
  "id": "base-connexion",
  "rub": "base",
  "titre": "Se connecter sur ce téléphone",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout agent inscrit dans « Accès App » avec un code personnel.",
  "mots": "connexion connecter login se connecter nom code pin mot de passe identifiant saisies compte agent",
  "intro": "La connexion donne accès aux rubriques de gestion (Finances, RH, Missions…). Le scan de l'atelier marche sans connexion.",
  "etapes": [
   "Touchez la tuile <b>🔐 Saisies</b> (ou <b>☰</b> puis <b>Se connecter</b>).",
   "Dans <b>Nom</b>, choisissez votre nom.",
   "Dans <b>Code personnel</b>, tapez votre code (PIN).",
   "Touchez <b>Se connecter</b>.",
   "Les tuiles de vos rubriques apparaissent sur l'accueil."
  ],
  "notes": [
   "⚠️ Le réseau est obligatoire pour se connecter.",
   "⚠️ « Nom ou code personnel incorrect » : vérifiez le code. En cas d'oubli, demandez au DG.",
   "💡 Première fois sur ce téléphone ? Le DG doit l'autoriser avec un code : voir la fiche suivante."
  ],
  "img": "base-connexion",
  "voir": [
   "base-appareil-code-dg",
   "base-changer-agent"
  ]
 },
 {
  "id": "base-appareil-code-dg",
  "rub": "base",
  "titre": "Autoriser un nouveau téléphone (code du DG)",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout agent qui se connecte pour la première fois sur un appareil.",
  "mots": "premiere connexion nouveau telephone appareil autoriser code dg otp 6 chiffres email mail securite changer de telephone",
  "intro": "Pour la sécurité, chaque nouveau téléphone doit être autorisé par le DG. Le DG reçoit un code à 6 chiffres par e-mail.",
  "etapes": [
   "L'écran <b>🔐 Première connexion sur cet appareil</b> s'ouvre tout seul.",
   "Vérifiez <b>Utilisateur</b> et <b>PIN</b>.",
   "Touchez <b>📧 Demander le code au DG</b>.",
   "Appelez le DG : il vous lit le code reçu par e-mail.",
   "Tapez-le dans <b>Code reçu par le DG (6 chiffres)</b>.",
   "Touchez <b>✅ Valider</b>. Le message « ✅ Appareil autorisé » s'affiche, puis l'accueil."
  ],
  "notes": [
   "⚠️ Le code est valable 15 minutes. Passé ce délai, touchez <b>Renvoyer un code</b>.",
   "⚠️ Le réseau est obligatoire.",
   "💡 Des saisies faites avant l'autorisation restent gardées sur le téléphone. Elles partiront après."
  ],
  "voir": [
   "base-connexion"
  ]
 },
 {
  "id": "base-changer-agent",
  "rub": "base",
  "titre": "Changer d'agent (se déconnecter)",
  "droits": [
   "agent"
  ],
  "qui": "Qui : l'agent connecté, quand quelqu'un d'autre doit utiliser le téléphone.",
  "mots": "deconnexion deconnecter changer agent utilisateur sortir quitter logout autre personne",
  "intro": "Permet de laisser le téléphone à un autre agent.",
  "etapes": [
   "Touchez <b>☰</b> (Réglages).",
   "Dans la carte <b>Agent connecté</b>, touchez <b>Changer d'agent</b>.",
   "Si des saisies sont en attente, confirmez : elles partiront quand même.",
   "L'autre agent se connecte avec son nom et son code."
  ],
  "notes": [
   "💡 Les données des rubriques sont effacées du téléphone. Elles reviennent à la prochaine connexion (réseau nécessaire)."
  ],
  "voir": [
   "base-connexion"
  ]
 },
 {
  "id": "base-installer",
  "rub": "base",
  "titre": "Installer DuoCore sur l'écran d'accueil",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde, une seule fois par téléphone.",
  "mots": "installer installation icone ecran accueil raccourci application iphone android chrome safari partager",
  "intro": "Installée, DuoCore s'ouvre comme une application et marche sans réseau. Sur iPhone, c'est obligatoire pour les notifications.",
  "etapes": [
   "Ouvrez le lien de DuoCore dans Chrome (Android) ou Safari (iPhone).",
   "Android : touchez <b>⋮</b> puis <b>Installer l'application</b> (ou <b>Ajouter à l'écran d'accueil</b>).",
   "iPhone : touchez <b>Partager</b> puis <b>Sur l'écran d'accueil</b>.",
   "Ouvrez ensuite DuoCore depuis la nouvelle icône."
  ],
  "notes": [
   "💡 Ensuite, connectez-vous et activez les notifications."
  ],
  "voir": [
   "base-connexion",
   "base-notifs-activer"
  ]
 },
 {
  "id": "base-hors-ligne",
  "rub": "base",
  "titre": "Travailler sans réseau",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde.",
  "mots": "hors ligne sans reseau pas de reseau internet connexion coupee lent offline garde sur le telephone envoi automatique refaire",
  "intro": "Sans réseau, vos saisies sont gardées sur le téléphone. Elles partent toutes seules quand le réseau revient, avec l'heure de la saisie.",
  "etapes": [
   "Faites votre saisie normalement.",
   "Si le réseau manque, le message <b>📥 Gardée sur le téléphone</b> s'affiche.",
   "La pastille en haut indique <b>⏳ n en attente</b>.",
   "Continuez à travailler. L'envoi se fait tout seul dès que le réseau revient.",
   "Pour vérifier, ouvrez la tuile <b>⏳ En attente</b> : elle doit indiquer « rien »."
  ],
  "notes": [
   "⚠️ NE REFAITES PAS LA SAISIE : elle serait comptée deux fois.",
   "⚠️ Ces écrans demandent le réseau : Journal Prod, État d'avancement, Trésorerie, Fournisseurs, Inter-sociétés, Magasins, Répartition, les PDF et les pièces jointes.",
   "💡 Si le logo tourne plus de 30 secondes, touchez <b>Annuler l'attente</b> : la saisie continue ou reste gardée.",
   "💡 Un envoi refusé plus tard par le serveur va dans <b>⛔ À corriger</b>."
  ],
  "voir": [
   "base-en-attente",
   "base-a-corriger"
  ]
 },
 {
  "id": "base-en-attente",
  "rub": "base",
  "titre": "Voir et envoyer les saisies en attente",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde.",
  "mots": "en attente file attente envoyer maintenant pas parti saisie bloquee envoi forcer pendant",
  "intro": "La tuile « En attente » liste ce qui n'est pas encore parti au serveur.",
  "etapes": [
   "Touchez la tuile <b>⏳ En attente</b> (ou la pastille <b>⏳ n en attente</b> en haut).",
   "Chaque carte montre la saisie, le nombre d'essais et la dernière erreur.",
   "Avec du réseau, touchez <b>Envoyer maintenant</b>.",
   "Quand tout est parti, la tuile indique « rien »."
  ],
  "notes": [
   "⚠️ Ne refaites pas ces saisies.",
   "💡 « en attente de la mise à jour de l'app » : installez la mise à jour. « en attente du code de connexion (DG) » : faites autoriser le téléphone."
  ],
  "voir": [
   "base-hors-ligne",
   "base-maj",
   "base-appareil-code-dg"
  ]
 },
 {
  "id": "base-a-corriger",
  "rub": "base",
  "titre": "Traiter une saisie refusée (À corriger)",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde.",
  "mots": "a corriger refuse refus erreur rejet saisie refusee rien enregistre corriger effacer",
  "intro": "Quand le serveur refuse une saisie faite hors ligne, rien n'est enregistré. Elle s'affiche dans « À corriger ».",
  "etapes": [
   "Touchez la tuile <b>⛔ À corriger</b>.",
   "Lisez le motif du refus sur la carte.",
   "Déclaration d'atelier : touchez <b>Ouvrir le lot</b> et refaites la bonne déclaration.",
   "Saisie de BDC : touchez <b>Reprendre la saisie</b>.",
   "Autre cas : refaites la saisie correcte dans la rubrique.",
   "Touchez ensuite <b>Vu, effacer</b>."
  ],
  "notes": [
   "⚠️ N'effacez pas avant d'avoir refait la bonne saisie."
  ],
  "voir": [
   "base-hors-ligne"
  ]
 },
 {
  "id": "base-sync",
  "rub": "base",
  "titre": "Mettre à jour les données (synchroniser)",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde.",
  "mots": "synchroniser synchronisation sync actualiser rafraichir recharger donnees a jour fleche tourner",
  "intro": "La synchronisation envoie ce qui attend et recharge les dernières données (lots, demandes, missions…).",
  "etapes": [
   "Touchez <b>⟳</b> en haut de l'écran, ou la tuile <b>⇅ Synchronisation</b>.",
   "Le bouton affiche <b>⏳</b> pendant l'opération.",
   "La tuile indique ensuite l'heure de la dernière synchronisation."
  ],
  "notes": [
   "💡 Elle se fait aussi toute seule : les données de l'atelier toutes les 15 minutes, les rubriques toutes les 5 minutes.",
   "💡 Un lot introuvable ou une donnée ancienne ? Synchronisez avec du réseau."
  ],
  "voir": [
   "base-hors-ligne"
  ]
 },
 {
  "id": "base-notifs-activer",
  "rub": "base",
  "titre": "Activer les notifications sur ce téléphone",
  "droits": [
   "agent"
  ],
  "qui": "Qui : tout agent connecté, sur chacun de ses appareils.",
  "mots": "notifications notification alerte push activer sonnerie message recevoir firebase test",
  "intro": "Les notifications vous préviennent quand une demande vous attend, quand elle est validée, etc.",
  "etapes": [
   "Connectez-vous d'abord.",
   "Touchez <b>☰</b> (Réglages).",
   "Dans la carte <b>🔔 Notifications</b>, touchez <b>Activer sur cet appareil</b>.",
   "Acceptez quand le téléphone demande l'autorisation.",
   "Le message « ✅ Actives sur cet appareil » s'affiche.",
   "Touchez <b>Envoyer une notification de test</b> pour vérifier."
  ],
  "notes": [
   "⚠️ Sur iPhone : installez d'abord DuoCore sur l'écran d'accueil.",
   "⚠️ « Notifications bloquées » : autorisez-les dans les réglages du téléphone ou du navigateur.",
   "💡 Faites-le sur chaque appareil que vous utilisez."
  ],
  "voir": [
   "base-installer",
   "nt-recues"
  ]
 },
 {
  "id": "base-affichage",
  "rub": "base",
  "titre": "Choisir l'affichage (téléphone ou PC) et le thème",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde.",
  "mots": "affichage mode pc tablette telephone ecran grand theme sombre clair nuit jour couleur",
  "intro": "DuoCore s'adapte à la taille de l'écran. Vous pouvez forcer le mode PC / tablette ou le mode téléphone.",
  "etapes": [
   "Touchez <b>☰</b> (Réglages).",
   "Dans <b>Mode</b>, choisissez <b>Automatique</b>, <b>Téléphone</b> ou <b>PC / tablette</b>.",
   "Dans <b>Thème</b>, choisissez <b>🌙 Nuit (sombre)</b> ou <b>☀️ Jour (clair)</b>.",
   "Le bouton ☀️ / 🌙 en haut change aussi le thème."
  ],
  "notes": [
   "💡 La saisie complète des BDC (Planification) demande le mode PC / tablette."
  ],
  "voir": [
   "pl-pc"
  ]
 },
 {
  "id": "base-serveur",
  "rub": "base",
  "titre": "Renseigner l'adresse du serveur",
  "droits": [
   "tous"
  ],
  "qui": "Qui : la personne qui installe l'application, sur demande du DG.",
  "mots": "adresse serveur url lien exec script google configuration version",
  "intro": "L'adresse du serveur est normalement déjà réglée. Ne la changez que si le DG vous le demande.",
  "etapes": [
   "Touchez <b>☰</b> (Réglages).",
   "Collez l'adresse dans <b>Adresse du serveur (…/exec)</b>.",
   "Touchez <b>Enregistrer</b>. Le message « ✅ Adresse enregistrée » s'affiche.",
   "En bas, la ligne « Application … · serveur … » donne les versions."
  ],
  "notes": [
   "⚠️ L'adresse commence par https://script.google.com/ et finit par /exec."
  ]
 },
 {
  "id": "base-maj",
  "rub": "base",
  "titre": "Installer une mise à jour obligatoire",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde, quand l'écran de mise à jour s'affiche.",
  "mots": "mise a jour maj nouvelle version obligatoire update installer bloque mettre a jour",
  "intro": "Quand une nouvelle version est exigée, aucune saisie n'est possible avant de l'installer. Vos saisies en attente sont gardées.",
  "etapes": [
   "L'écran <b>⬆️ Mise à jour obligatoire</b> s'affiche.",
   "Vérifiez que le téléphone a du réseau.",
   "Touchez <b>⬆️ Mettre à jour</b>.",
   "Attendez la fin de la barre (Téléchargement, Installation, Redémarrage).",
   "L'app redémarre et affiche <b>✅ DuoCore est à jour</b> avec les nouveautés.",
   "Touchez <b>OK</b>. Les saisies en attente partent toutes seules."
  ],
  "notes": [
   "⚠️ Ne refaites pas les saisies gardées : elles partiront après la mise à jour.",
   "💡 Ça ne marche pas ? Voir la fiche « App bloquée sur Mise à jour obligatoire »."
  ],
  "voir": [
   "base-maj-bloque"
  ]
 },
 {
  "id": "base-maj-bloque",
  "rub": "base",
  "titre": "Que faire si l'app est bloquée sur Mise à jour obligatoire",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tout le monde.",
  "mots": "bloque bloquee mise a jour obligatoire ne marche pas echec reste coince ancienne version effacer donnees ctrl maj r",
  "intro": "Si le bouton ne suffit pas, suivez ces étapes dans l'ordre. Elles sont aussi sous <b>Instructions si le bouton ne suffit pas</b>.",
  "etapes": [
   "Vérifiez le réseau, touchez <b>⬆️ Mettre à jour</b> et attendez la fin de la barre.",
   "Fermez complètement DuoCore (applications récentes, balayez DuoCore), puis rouvrez-la.",
   "Sur PC : sur la page DuoCore, appuyez sur <b>Ctrl + Maj + R</b>.",
   "Sur iPhone : supprimez l'icône, rouvrez le lien dans Safari, puis <b>Partager</b> › <b>Sur l'écran d'accueil</b>.",
   "Sur Android, en dernier recours : Chrome › ⋮ › Paramètres › Paramètres des sites › Toutes les données › site DuoCore › <b>Effacer</b>. Reconnectez-vous ensuite.",
   "Rien ne change après 15 minutes ? Prévenez le DG : la version n'est peut-être pas encore publiée."
  ],
  "notes": [
   "⚠️ Effacer les données supprime les saisies en attente. Regardez d'abord la tuile <b>⏳ En attente</b>.",
   "⚠️ Pendant le blocage, rien n'est envoyé au serveur."
  ],
  "voir": [
   "base-maj",
   "base-en-attente"
  ]
 },
 {
  "id": "at-scanner",
  "rub": "atelier",
  "titre": "Scanner la fiche d'un lot",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tous les opérateurs. Pas besoin de se connecter.",
  "mots": "scanner scan qr code fiche lot camera declarer production atelier flasher photo",
  "intro": "Le scan du QR code de la fiche ouvre la page de déclaration du lot.",
  "etapes": [
   "Sur l'accueil, touchez <b>📷 Scanner une fiche</b>.",
   "Placez le QR code de la fiche dans le cadre.",
   "La page de déclaration du lot s'ouvre toute seule.",
   "Vérifiez le BDC, la clé du lot et la désignation en haut.",
   "Remplissez la déclaration selon votre étape (voir les fiches suivantes), puis touchez <b>Valider</b>.",
   "Lisez le message, puis touchez <b>OK</b>."
  ],
  "notes": [
   "⚠️ « QR code non reconnu » : ce n'est pas une fiche de lot. Vérifiez la feuille.",
   "⚠️ « Caméra indisponible » : autorisez la caméra, ou utilisez <b>🔢 Lot sans QR</b>.",
   "💡 Le scan marche sans réseau. La déclaration est gardée et part plus tard."
  ],
  "voir": [
   "at-sans-qr",
   "at-alerte-lot",
   "at-lot-introuvable"
  ]
 },
 {
  "id": "at-sans-qr",
  "rub": "atelier",
  "titre": "Ouvrir un lot sans QR code",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tous les opérateurs.",
  "mots": "lot sans qr code manuel choisir bdc lot qr abime dechire illisible camera cassee derniers lots",
  "intro": "Si le QR code est abîmé ou si la caméra ne marche pas, choisissez le lot dans une liste.",
  "etapes": [
   "Sur l'accueil, touchez <b>🔢 Lot sans QR</b>.",
   "Dans <b>BDC</b>, choisissez le bon de commande.",
   "Dans <b>Lot</b>, choisissez la clé du lot.",
   "Touchez <b>Ouvrir le lot</b>.",
   "Déclarez comme après un scan."
  ],
  "notes": [
   "💡 La carte <b>Derniers lots ouverts</b> permet de rouvrir un lot récent en un toucher."
  ],
  "voir": [
   "at-scanner"
  ]
 },
 {
  "id": "at-alerte-lot",
  "rub": "atelier",
  "titre": "Comprendre « Lot déjà terminé » ou « Lot précédent non commencé »",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tous les opérateurs.",
  "mots": "attention lot deja termine fini lot precedent non commence mauvais qr ouvrir quand meme forcer",
  "intro": "Avant d'ouvrir la déclaration, DuoCore vérifie le lot. Ce message signale souvent un mauvais QR code.",
  "etapes": [
   "Lisez le message de la page <b>Attention</b>.",
   "Vérifiez la fiche : est-ce le bon lot ?",
   "Si c'est une erreur, touchez <b>Retour (scanner le bon QR code)</b>.",
   "Si vous êtes sûr, touchez <b>Ouvrir quand même la déclaration</b>."
  ],
  "notes": [
   "⚠️ En cas de doute, demandez au chef d'atelier avant de forcer."
  ],
  "voir": [
   "at-scanner"
  ]
 },
 {
  "id": "at-lot-introuvable",
  "rub": "atelier",
  "titre": "Le lot n'est pas sur le téléphone",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tous les opérateurs.",
  "mots": "lot introuvable absent pas trouve inconnu nouveau lot donnees anciennes mettre a jour",
  "intro": "Un lot tout récent peut manquer sur le téléphone. Il faut recharger les données.",
  "etapes": [
   "La page <b>Lot introuvable</b> s'affiche.",
   "Avec du réseau, touchez <b>🔄 Mettre à jour les données (réseau)</b>.",
   "Si le lot n'arrive toujours pas, touchez <b>Ouvrir la page en ligne</b>.",
   "Sinon, touchez <b>Retour</b> et prévenez le planificateur."
  ],
  "notes": [],
  "voir": [
   "base-sync"
  ]
 },
 {
  "id": "at-operateurs",
  "rub": "atelier",
  "titre": "Choisir le ou les opérateurs",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tous les opérateurs.",
  "mots": "operateur operateurs equipe nom choisir plusieurs une seule personne qui a fait",
  "intro": "Chaque déclaration indique qui a fait le travail. Selon l'étape, on choisit une personne ou toute l'équipe.",
  "etapes": [
   "En bas de la déclaration, ouvrez <b>Opérateur</b> (ou <b>Opérateur(s)</b>).",
   "Une seule personne pour : Montage, Fourniture papier, Façonnage, Découpe intermédiaire, Découpe de finition et la validation du BAR.",
   "Pour les autres étapes, cochez toute l'équipe présente.",
   "Touchez <b>Valider</b>."
  ],
  "notes": [
   "⚠️ « Choisissez au moins un opérateur. » ou « Une seule personne pour cette tâche. » : corrigez le choix.",
   "💡 Le téléphone retient le dernier choix."
  ]
 },
 {
  "id": "at-montage",
  "rub": "atelier",
  "titre": "Déclarer le Montage",
  "droits": [
   "tous"
  ],
  "qui": "Qui : l'opérateur du montage.",
  "mots": "montage valider monte montage realise valide case cocher etape",
  "intro": "Le Montage se déclare une seule fois, avec une case à cocher, sans quantité.",
  "etapes": [
   "Scannez la fiche du lot.",
   "Dans <b>Poste / Étape</b>, choisissez <b>Montage</b>.",
   "Cochez <b>Montage réalisé et validé</b>.",
   "Dans <b>Opérateur</b>, choisissez une seule personne.",
   "Touchez <b>Valider</b>, puis <b>OK</b>."
  ],
  "notes": [
   "⚠️ Bloqué si l'étape d'avant n'a encore rien produit. Lisez le message en rouge.",
   "💡 Le Montage ne se déclare qu'une fois par lot."
  ],
  "voir": [
   "at-scanner",
   "at-operateurs"
  ]
 },
 {
  "id": "at-fourniture-papier",
  "rub": "atelier",
  "titre": "Déclarer une fourniture de papier",
  "droits": [
   "tous"
  ],
  "qui": "Qui : la personne qui fournit le papier au lot.",
  "mots": "fourniture papier feuilles donner papier quantite tranche reste a fournir deja fourni",
  "intro": "La fourniture papier se déclare avec une quantité, en une ou plusieurs fois.",
  "etapes": [
   "Scannez la fiche du lot.",
   "Dans <b>Poste / Étape</b>, choisissez <b>Fourniture papier</b>.",
   "Lisez le message : « Déjà fourni : X. Reste à fournir : Y. ».",
   "Tapez la quantité dans <b>Quantité de ce passage</b>.",
   "Choisissez une seule personne dans <b>Opérateur</b>.",
   "Touchez <b>Valider</b>, puis <b>OK</b>."
  ],
  "notes": [
   "💡 Vous pouvez fournir en plusieurs fois : chaque déclaration s'ajoute."
  ],
  "voir": [
   "at-sortie-stock"
  ]
 },
 {
  "id": "at-ctp",
  "rub": "atelier",
  "titre": "Déclarer la plaque CTP (Impression)",
  "droits": [
   "tous"
  ],
  "qui": "Qui : l'équipe machine (Impression).",
  "mots": "plaque ctp plaques impression machine debut cycle passage",
  "intro": "Sur machine, le cycle commence par la plaque CTP, puis le Calage, le BAR, les Pointages et la Fin.",
  "etapes": [
   "Scannez la fiche du lot.",
   "Dans <b>Poste / Étape</b>, choisissez <b>Impression</b>.",
   "Si on vous le demande, choisissez le <b>Passage (machine)</b>.",
   "Dans <b>Type d'événement</b>, choisissez <b>Plaque CTP</b>.",
   "Si des plaques sont sorties du stock, remplissez <b>Sortie de stock</b> (article et quantité).",
   "Choisissez les opérateurs, puis touchez <b>Valider</b>."
  ],
  "notes": [
   "💡 Les articles CTP ne sont proposés qu'avec « Plaque CTP ».",
   "💡 La Numérotation n'a pas de plaque CTP : commencez par le Calage."
  ],
  "voir": [
   "at-calage",
   "at-sortie-stock"
  ]
 },
 {
  "id": "at-calage",
  "rub": "atelier",
  "titre": "Déclarer le Calage",
  "droits": [
   "tous"
  ],
  "qui": "Qui : l'équipe machine (Impression, Numérotation).",
  "mots": "calage caler reglage machine impression numerotation",
  "intro": "Le Calage vient après la plaque CTP (ou en premier pour la Numérotation).",
  "etapes": [
   "Scannez la fiche du lot.",
   "Choisissez l'étape (<b>Impression</b> ou <b>Numérotation</b>) et le passage.",
   "Dans <b>Type d'événement</b>, choisissez <b>Calage</b>.",
   "Choisissez les opérateurs.",
   "Touchez <b>Valider</b>, puis <b>OK</b>."
  ],
  "notes": [],
  "voir": [
   "at-ctp",
   "at-bar"
  ]
 },
 {
  "id": "at-bar",
  "rub": "atelier",
  "titre": "Valider le Bon à rouler (BAR)",
  "droits": [
   "tous"
  ],
  "qui": "Qui : la personne qui valide le BAR (une seule).",
  "mots": "bar bon a rouler valider demarrer debut machine impression numerotation",
  "intro": "Le BAR autorise le tirage. Sa validation enregistre aussi le Début automatiquement.",
  "etapes": [
   "Scannez la fiche du lot.",
   "Choisissez l'étape et le passage.",
   "Dans <b>Type d'événement</b>, choisissez <b>BAR — Bon à rouler</b>.",
   "Cochez <b>Bon à rouler validé</b>.",
   "Choisissez une seule personne dans <b>Opérateur</b>.",
   "Touchez <b>Valider</b>, puis <b>OK</b>."
  ],
  "notes": [
   "💡 Pas besoin de déclarer « Début » ensuite : c'est fait."
  ],
  "voir": [
   "at-pointage-machine"
  ]
 },
 {
  "id": "at-pointage-machine",
  "rub": "atelier",
  "titre": "Pointer une quantité sur machine",
  "droits": [
   "tous"
  ],
  "qui": "Qui : l'équipe machine (Impression, Numérotation).",
  "mots": "pointage pointer quantite produite compter tirage machine passage impression numerotation feuilles",
  "intro": "Le pointage enregistre la quantité produite. On peut pointer plusieurs fois par passage.",
  "etapes": [
   "Scannez la fiche du lot.",
   "Choisissez l'étape et le <b>Passage (machine)</b>.",
   "Dans <b>Type d'événement</b>, choisissez <b>Pointage</b>.",
   "Tapez la quantité dans <b>Quantité de ce passage</b>.",
   "Choisissez l'équipe dans <b>Opérateur(s)</b>.",
   "Touchez <b>Valider</b>, puis <b>OK</b>."
  ],
  "notes": [
   "⚠️ La quantité ne peut pas dépasser ce que l'étape d'avant a produit, ni la quantité planifiée.",
   "⚠️ Le passage 2 n'est possible que si le passage 1 a déjà pointé une quantité."
  ],
  "voir": [
   "at-fin-machine",
   "at-bar"
  ]
 },
 {
  "id": "at-fin-machine",
  "rub": "atelier",
  "titre": "Terminer un passage machine (Fin)",
  "droits": [
   "tous"
  ],
  "qui": "Qui : l'équipe machine.",
  "mots": "fin terminer finir passage machine solder reliquat cloturer etape",
  "intro": "La Fin clôt le passage et solde automatiquement le reste.",
  "etapes": [
   "Scannez la fiche du lot.",
   "Choisissez l'étape et le passage.",
   "Dans <b>Type d'événement</b>, choisissez <b>Fin</b>.",
   "Choisissez l'équipe.",
   "Touchez <b>Valider</b>, puis <b>OK</b>."
  ],
  "notes": [
   "⚠️ Après la Fin, plus de pointage sur ce passage. Vérifiez avant de valider."
  ],
  "voir": [
   "at-pointage-machine"
  ]
 },
 {
  "id": "at-manuelle",
  "rub": "atelier",
  "titre": "Déclarer une étape manuelle (Début, Pointage, Fin)",
  "droits": [
   "tous"
  ],
  "qui": "Qui : les opérateurs des étapes sans machine (façonnage, découpe, assemblage, emballage…).",
  "mots": "etape manuelle debut pointage fin faconnage decoupe assemblage emballage hologramme gaufrage finition",
  "intro": "Les étapes manuelles suivent l'ordre : Début, un ou plusieurs Pointages, puis Fin.",
  "etapes": [
   "Scannez la fiche du lot.",
   "Dans <b>Poste / Étape</b>, choisissez votre étape.",
   "Dans <b>Type d'événement</b>, choisissez <b>Début</b> au démarrage.",
   "Pendant le travail, choisissez <b>Pointage</b> et tapez la <b>Quantité de ce passage</b>.",
   "À la fin, choisissez <b>Fin</b> : le reste est soldé automatiquement.",
   "Choisissez les opérateurs, puis touchez <b>Valider</b>."
  ],
  "notes": [
   "⚠️ Début et Fin ne se déclarent qu'une fois.",
   "⚠️ Une seule personne pour Façonnage, Découpe intermédiaire et Découpe de finition."
  ],
  "voir": [
   "at-operateurs",
   "at-incident"
  ]
 },
 {
  "id": "at-incident",
  "rub": "atelier",
  "titre": "Signaler un incident",
  "droits": [
   "tous"
  ],
  "qui": "Qui : tous les opérateurs.",
  "mots": "incident panne probleme arret casse defaut signaler erreur machine",
  "intro": "L'incident note un problème sur le lot. Aucune quantité n'est comptée.",
  "etapes": [
   "Scannez la fiche du lot.",
   "Choisissez l'étape concernée.",
   "Dans <b>Type d'événement</b>, choisissez <b>Incident</b>.",
   "Choisissez les opérateurs.",
   "Touchez <b>Valider</b>, puis <b>OK</b>.",
   "Prévenez aussi le chef d'atelier."
  ],
  "notes": []
 },
 {
  "id": "at-sortie-stock",
  "rub": "atelier",
  "titre": "Sortir de la matière pendant la déclaration",
  "droits": [
   "tous"
  ],
  "qui": "Qui : les opérateurs qui consomment de la matière (encre, plaques, hologramme, emballage…).",
  "mots": "sortie stock matiere consommee article encre plaque hologramme emballage fourniture declaration",
  "intro": "Dans la déclaration, vous pouvez indiquer la matière utilisée pour ce lot (jusqu'à 3 articles).",
  "etapes": [
   "Ouvrez la déclaration du lot et remplissez l'étape et l'événement.",
   "Dans <b>Sortie de stock (facultatif : matière consommée pour ce lot)</b>, choisissez l'article.",
   "Tapez la quantité à côté.",
   "Ajoutez un 2e ou un 3e article si besoin.",
   "Touchez <b>Valider</b>."
  ],
  "notes": [
   "⚠️ Un message signale si le stock est insuffisant.",
   "💡 Impression, Hologramme / Gaufrage et Emballage : même si l'événement est bloqué, la sortie seule peut être envoyée (« Seule la sortie de fourniture sera enregistrée. »)."
  ],
  "voir": [
   "mg-sortie-m2s"
  ]
 },
 {
  "id": "at-journal",
  "rub": "atelier",
  "titre": "Vérifier les scans (Journal Prod)",
  "droits": [
   "agent"
  ],
  "qui": "Qui : tout agent connecté. Réseau obligatoire.",
  "mots": "journal prod scans verifier controle anomalie operateur total production historique declarations",
  "intro": "Le Journal Prod liste les déclarations faites, avec les anomalies, et le total par opérateur.",
  "etapes": [
   "Touchez la tuile <b>🧾 Journal Prod</b>.",
   "Choisissez la période dans <b>Du</b> et <b>Au</b> (par défaut : hier et aujourd'hui).",
   "Filtrez si besoin par opérateur, par étape, ou cherchez un lot, un BDC ou un article.",
   "Cochez <b>anomalies seulement</b> pour voir les problèmes.",
   "Touchez <b>👷 Total par opérateur</b> pour voir les quantités par personne."
  ],
  "notes": [
   "💡 Trop de lignes ? Réduisez la période (400 cartes affichées au plus)."
  ],
  "img": "at-journal",
  "voir": [
   "at-avancement"
  ]
 },
 {
  "id": "at-avancement",
  "rub": "atelier",
  "titre": "Suivre l'avancement des BDC",
  "droits": [
   "agent"
  ],
  "qui": "Qui : tout agent connecté. Réseau obligatoire.",
  "mots": "etat avancement suivi bdc lots pourcentage termine en cours restant production retard",
  "intro": "Cet écran montre où en est chaque BDC et chaque lot, étape par étape.",
  "etapes": [
   "Touchez la tuile <b>📊 État d'avancement</b>.",
   "Cherchez un BDC, un lot ou un article dans la recherche.",
   "Touchez une ligne BDC (▶) pour l'ouvrir.",
   "Touchez un lot pour voir son détail et son dernier événement.",
   "Cochez <b>afficher les lots terminés</b> ou <b>afficher les BDC terminés</b> si besoin."
  ],
  "notes": [
   "💡 ✓ = étape finie, ● = en cours, ○ = à faire."
  ],
  "img": "at-avancement",
  "voir": [
   "at-journal",
   "pl-consulter"
  ]
 },
 {
  "id": "pl-consulter",
  "rub": "planif",
  "titre": "Consulter les BDC ouverts (téléphone)",
  "droits": [
   "planif"
  ],
  "qui": "Qui : les planificateurs.",
  "mots": "planification bdc ouverts liste suivi bdc consulter lignes feuilles meres telephone",
  "intro": "Sur téléphone, la Planification montre les BDC ouverts en lecture, la publication et les fiches.",
  "etapes": [
   "Touchez la tuile <b>🗂️ Planification</b>.",
   "Cherchez le BDC ou le client.",
   "Touchez le BDC pour ouvrir son suivi.",
   "Consultez <b>📝 Lignes</b>, <b>🧱 Feuilles mères</b>, <b>📤 Publication</b> et <b>🧾 Fiches</b>."
  ],
  "notes": [
   "💡 La saisie des lignes, des feuilles mères et des scénarios se fait en mode PC / tablette.",
   "💡 « ⏳ saisie en attente d'envoi » : votre saisie n'est pas encore partie."
  ],
  "voir": [
   "pl-pc",
   "pl-publier",
   "pl-fiches"
  ]
 },
 {
  "id": "pl-pc",
  "rub": "planif",
  "titre": "Ouvrir l'espace de planification sur PC / tablette",
  "droits": [
   "planif"
  ],
  "qui": "Qui : les planificateurs, sur un grand écran.",
  "mots": "planification pc tablette ordinateur grand ecran onglets lignes feuilles meres scenarios publication fiches",
  "intro": "Sur PC ou tablette, la Planification affiche la liste des BDC à gauche et des onglets de travail à droite.",
  "etapes": [
   "Ouvrez DuoCore sur un PC ou une tablette (ou <b>☰</b> › Mode <b>PC / tablette</b>).",
   "Touchez la tuile <b>🗂️ Planification</b>.",
   "Choisissez un BDC dans la liste de gauche.",
   "Utilisez les onglets <b>📝 Lignes</b>, <b>🧱 Feuilles mères</b>, <b>🧩 Scénarios</b>, <b>📤 Publication</b> et <b>🧾 Fiches</b>."
  ],
  "notes": [
   "💡 Tout se fait aussi hors ligne : les saisies partent à la synchronisation."
  ],
  "voir": [
   "pl-lignes",
   "pl-feuille-mere",
   "pl-scenario"
  ]
 },
 {
  "id": "pl-lignes",
  "rub": "planif",
  "titre": "Saisir les lignes d'un BDC (Saisi BDC)",
  "droits": [
   "planif"
  ],
  "qui": "Qui : les planificateurs (mode PC / tablette).",
  "mots": "saisi bdc saisir lignes articles quantite format papier feuillets carnet numero depart abreviation statut prod excel coller",
  "intro": "On saisit ici les articles du BDC, puis on les envoie dans Statut Prod.",
  "etapes": [
   "Planification › choisissez le BDC › onglet <b>📝 Lignes</b>.",
   "Remplissez si besoin <b>Format fini commun</b> (ex. 148x210), <b>Papier commun</b> et <b>Feuillets / carnet pour tous</b>.",
   "Pour chaque article, remplissez une ligne : nom, quantité, n° de départ, abréviation, format…",
   "Touchez <b>➕ Ligne</b> pour ajouter un article.",
   "Vérifiez le total : « Total saisi : X / Qté globale : Y ✔ ».",
   "Touchez <b>💾 Enregistrer</b>, ou <b>✅ Enregistrer et envoyer dans Statut Prod</b>.",
   "Attendez le message (jusqu'à 2 minutes)."
  ],
  "notes": [
   "💡 Copiez des lignes depuis Excel et collez-les dans une case « Article » : plusieurs lignes sont créées d'un coup.",
   "⚠️ Le format fini est obligatoire pour l'envoi dans Statut Prod.",
   "💡 Cochez « Comp. » pour un composant non facturé : il n'entre pas dans le total."
  ],
  "voir": [
   "pl-hausse",
   "pl-feuille-mere"
  ]
 },
 {
  "id": "pl-hausse",
  "rub": "planif",
  "titre": "Confirmer une hausse de quantité",
  "droits": [
   "planif"
  ],
  "qui": "Qui : les planificateurs.",
  "mots": "hausse quantite augmentation plus motif montant bdc confirmer",
  "intro": "Si les quantités saisies dépassent celles du BDC, DuoCore demande de confirmer.",
  "etapes": [
   "La carte <b>⚠️ Hausse de quantité</b> s'affiche.",
   "Choisissez <b>Garder le montant actuel du BDC</b> ou <b>Nouveau montant</b> (et tapez-le).",
   "Écrivez le <b>Motif (obligatoire)</b>.",
   "Touchez à nouveau <b>💾 Enregistrer</b> ou <b>✅ Enregistrer et envoyer dans Statut Prod</b>."
  ],
  "notes": [],
  "voir": [
   "pl-lignes"
  ]
 },
 {
  "id": "pl-feuille-mere",
  "rub": "planif",
  "titre": "Créer ou modifier une feuille mère",
  "droits": [
   "planif"
  ],
  "qui": "Qui : les planificateurs (mode PC / tablette).",
  "mots": "feuille mere papier format machine imposition editeur creer modifier supprimer",
  "intro": "La feuille mère décrit le papier et la machine pour chaque groupe de format.",
  "etapes": [
   "Enregistrez et envoyez d'abord les lignes du BDC dans Statut Prod.",
   "Ouvrez l'onglet <b>🧱 Feuilles mères</b> (ou <b>🧱 Feuille mère</b> sous les lignes).",
   "Remplissez l'éditeur.",
   "Enregistrez. La mention « ⏳ sur cet appareil » s'affiche jusqu'à l'envoi."
  ],
  "notes": [
   "⚠️ « Éditeur indisponible » : synchronisez (⟳) avec du réseau.",
   "⚠️ « Aucun format fini pour ce BDC » : envoyez d'abord la saisie BDC."
  ],
  "voir": [
   "pl-lignes",
   "pl-scenario"
  ]
 },
 {
  "id": "pl-scenario",
  "rub": "planif",
  "titre": "Calculer et retenir un scénario de montage",
  "droits": [
   "planif"
  ],
  "qui": "Qui : les planificateurs (mode PC / tablette).",
  "mots": "scenario montage imposition calculer retenir poses lettres",
  "intro": "Le scénario calcule les impositions. Une fois retenu, le serveur donne les lettres.",
  "etapes": [
   "Vérifiez qu'il existe une feuille mère pour chaque groupe de format.",
   "Ouvrez l'onglet <b>🧩 Scénarios</b>.",
   "Lancez le calcul et comparez les propositions.",
   "Touchez <b>Retenir</b> sur le bon scénario.",
   "Synchronisez : les lettres des impositions arrivent du serveur."
  ],
  "notes": [
   "⚠️ La première ouverture demande le réseau.",
   "💡 Un nouveau « Retenir » remplace le précédent."
  ],
  "voir": [
   "pl-feuille-mere",
   "pl-publier"
  ]
 },
 {
  "id": "pl-publier",
  "rub": "planif",
  "titre": "Publier les impositions",
  "droits": [
   "planif"
  ],
  "qui": "Qui : les planificateurs.",
  "mots": "publier publication impositions tirage production envoyer atelier lettre",
  "intro": "La publication envoie les impositions en production.",
  "etapes": [
   "Ouvrez l'onglet <b>📤 Publication</b> (ou la carte <b>📤 Publication des impositions</b> sur téléphone).",
   "Cochez les impositions à publier.",
   "Touchez <b>📤 Publier les impositions cochées</b>, puis confirmez.",
   "Touchez <b>⟳</b> après une minute pour voir l'état <b>✅ Publiée</b>."
  ],
  "notes": [
   "⚠️ « BAT non validé » : faites d'abord valider le BAT.",
   "💡 « ⛔ Refusé — … » : lisez le motif, corrigez, puis republiez."
  ],
  "voir": [
   "pl-fiches"
  ]
 },
 {
  "id": "pl-fiches",
  "rub": "planif",
  "titre": "Imprimer ou partager les fiches (Montage, atelier)",
  "droits": [
   "planif"
  ],
  "qui": "Qui : les planificateurs.",
  "mots": "fiches imprimer partager pdf fiche montage fiche atelier refaire whatsapp drive",
  "intro": "Les fiches PDF sont gardées sur l'appareil pour les ouvrir sans réseau.",
  "etapes": [
   "Ouvrez l'onglet <b>🧾 Fiches</b> du BDC.",
   "Touchez <b>👁 Voir</b> ou <b>🖨️ Imprimer</b> (sur téléphone : <b>👁 Ouvrir</b>).",
   "Touchez <b>📤 Partager</b> pour l'envoyer.",
   "Pour régénérer la Fiche Montage, touchez <b>🔄 Refaire la Fiche Montage</b> (30 s à 1 min)."
  ],
  "notes": [
   "💡 « ↻ version plus récente au serveur » : synchronisez pour l'avoir."
  ],
  "voir": [
   "pl-publier"
  ]
 },
 {
  "id": "mg-stock",
  "rub": "magasins",
  "titre": "Consulter le stock d'un magasin",
  "droits": [
   "stock",
   "dirNom"
  ],
  "qui": "Qui : les magasiniers (droit Stock), le DG et WALID. Réseau obligatoire.",
  "mots": "magasin stock quantite article valeur cump inventaire consulter combien reste",
  "intro": "Chaque magasin affiche sa valeur et la liste de ses articles.",
  "etapes": [
   "Touchez la tuile <b>🏬 Magasins</b>.",
   "Regardez la valeur de chaque magasin (en GNF) et sa société.",
   "Touchez un magasin pour voir le tableau Article / Qté / CUMP / Valeur."
  ],
  "notes": [
   "💡 Le magasin marqué « magasin de la production » est celui de M2S."
  ],
  "voir": [
   "mg-sortie-m2s",
   "mg-autre-magasin"
  ]
 },
 {
  "id": "mg-sortie-m2s",
  "rub": "magasins",
  "titre": "Déclarer une sortie de stock M2S",
  "droits": [
   "stock"
  ],
  "qui": "Qui : les magasiniers (droit Stock).",
  "mots": "sortie stock m2s sortir article magasin production formulaire hors production consommation",
  "intro": "Pour sortir un article du magasin de la production en dehors d'une déclaration d'atelier.",
  "etapes": [
   "Touchez <b>🏬 Magasins</b> puis <b>📦 Sortie Stock M2S</b>.",
   "Touchez <b>➕ Nouvelle sortie de stock</b>.",
   "Remplissez chaque page, puis touchez <b>Suivant ▶</b>.",
   "Sur la dernière page, touchez <b>Vérifier et envoyer</b>.",
   "Relisez le résumé, puis touchez <b>Envoyer</b>.",
   "La sortie est « En attente » de validation par WALID ou le DG."
  ],
  "notes": [
   "⚠️ Le stock ne baisse qu'après la validation.",
   "💡 Une longue liste a un filtre « 🔎 Filtrer la liste… » : tapez le début du nom."
  ],
  "voir": [
   "mg-modifier-sortie",
   "mg-valider-sortie"
  ]
 },
 {
  "id": "mg-valider-sortie",
  "rub": "magasins",
  "titre": "Valider ou refuser une sortie de stock",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : WALID ou le DG (un seul suffit). Réseau obligatoire.",
  "mots": "valider sortie stock refuser renvoyer correction motif en attente magasin",
  "intro": "Une sortie M2S n'entre dans le stock qu'après votre validation.",
  "etapes": [
   "Ouvrez <b>🏬 Magasins</b> › <b>📦 Sortie Stock M2S</b> (ou touchez la ligne dans <b>🔔</b>).",
   "Lisez la sortie « En attente ».",
   "Touchez <b>✅ Valider</b>.",
   "Pour refuser ou renvoyer, écrivez d'abord le <b>Motif</b>.",
   "Puis touchez <b>↩️ Retour pour correction</b> ou <b>⛔ Refuser</b>."
  ],
  "notes": [
   "💡 Une sortie saisie par vous-même est validée d'office."
  ],
  "voir": [
   "mg-sortie-m2s"
  ]
 },
 {
  "id": "mg-modifier-sortie",
  "rub": "magasins",
  "titre": "Modifier ou annuler sa sortie de stock",
  "droits": [
   "stock"
  ],
  "qui": "Qui : l'auteur de la sortie, tant qu'elle est « En attente » ou « À corriger ». Réseau obligatoire.",
  "mots": "modifier corriger annuler sortie stock quantite projet erreur",
  "intro": "Vous pouvez corriger la quantité ou le projet avant la validation.",
  "etapes": [
   "Ouvrez <b>🏬 Magasins</b> › <b>📦 Sortie Stock M2S</b>.",
   "Trouvez votre sortie.",
   "Changez <b>Quantité de sortie</b> ou <b>Projet</b>.",
   "Touchez <b>✏️ Modifier</b> (ou <b>✏️ Corriger et renvoyer</b>).",
   "Pour l'annuler, touchez <b>Annuler</b>."
  ],
  "notes": []
 },
 {
  "id": "mg-autre-magasin",
  "rub": "magasins",
  "titre": "Sortir un article d'un autre magasin",
  "droits": [
   "stock",
   "dirNom"
  ],
  "qui": "Qui : droit Stock, DG ou WALID. Réseau obligatoire.",
  "mots": "sortie autre magasin chantier depot article projet affectation sortir",
  "intro": "Pour les magasins autres que celui de la production (chantiers, dépôts…).",
  "etapes": [
   "Touchez <b>🏬 Magasins</b> puis <b>📤 Sortie (autre magasin)</b>.",
   "Choisissez le <b>Magasin</b>, puis l'<b>Article</b> (la quantité disponible s'affiche).",
   "Tapez la <b>Quantité</b>.",
   "Remplissez <b>Projet / affectation</b> et <b>Motif</b>.",
   "Touchez <b>📤 Envoyer la sortie</b>."
  ],
  "notes": [
   "⚠️ « Stock insuffisant » : la quantité dépasse le disponible."
  ],
  "voir": [
   "mg-sortie-m2s"
  ]
 },
 {
  "id": "mg-transfert",
  "rub": "magasins",
  "titre": "Transférer un article entre magasins",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG ou WALID. Réseau obligatoire.",
  "mots": "transfert transferer deplacer article magasin depuis vers",
  "intro": "Déplace un article d'un magasin vers un autre.",
  "etapes": [
   "Touchez <b>🏬 Magasins</b> puis <b>🔁 Transfert</b>.",
   "Choisissez <b>Depuis</b> et <b>Vers</b>.",
   "Choisissez l'<b>Article</b> et tapez la <b>Quantité</b>.",
   "Écrivez le <b>Motif</b>.",
   "Touchez <b>🔁 Transférer</b>."
  ],
  "notes": []
 },
 {
  "id": "mg-creer",
  "rub": "magasins",
  "titre": "Créer un magasin",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG ou WALID. Réseau obligatoire.",
  "mots": "creer nouveau magasin depot chantier societe projet",
  "intro": "Un magasin appartient à une société et, si besoin, à un projet.",
  "etapes": [
   "Touchez <b>🏬 Magasins</b> puis <b>➕ Nouveau magasin</b>.",
   "Choisissez la <b>Société</b> (AB, M2S ou CASAFINO).",
   "Remplissez le <b>Projet</b> si besoin.",
   "Le nom est facultatif (par défaut « Société · Projet »).",
   "Touchez <b>✅ Créer le magasin</b>."
  ],
  "notes": []
 },
 {
  "id": "fin-consulter",
  "rub": "finances",
  "titre": "Consulter les demandes Finances",
  "droits": [
   "finances",
   "direction",
   "comptable"
  ],
  "qui": "Qui : droit Finances. Chacun voit ses demandes ; Walid, le DG et le comptable voient tout.",
  "mots": "finances demandes liste a traiter mes demandes toutes rechercher statut suivi paiement",
  "intro": "La tuile Finances liste les demandes de paiement et leur statut.",
  "etapes": [
   "Touchez la tuile <b>💰 Finances</b>.",
   "Onglet <b>À traiter</b> : tout ce qui n'est pas clos. <b>👉</b> signale ce qui vous attend.",
   "Onglet <b>Mes demandes</b> : vos demandes.",
   "Onglet <b>Toutes</b> (Walid, DG, comptable) : tout.",
   "Cherchez par n°, fournisseur ou objet.",
   "Touchez une demande pour ouvrir sa fiche."
  ],
  "notes": [
   "💡 Statuts : En attente Walid → En attente DG → À exécuter → Exécutée.",
   "💡 « ⏳ action en attente d'envoi » : votre action n'est pas encore partie."
  ],
  "img": "fin-consulter",
  "voir": [
   "fin-fiche",
   "fin-depense-caisse"
  ]
 },
 {
  "id": "fin-fiche",
  "rub": "finances",
  "titre": "Lire la fiche d'une demande",
  "droits": [
   "finances",
   "direction",
   "comptable"
  ],
  "qui": "Qui : droit Finances.",
  "mots": "fiche demande detail pieces preuves historique validation photo voir facture",
  "intro": "La fiche montre tout le détail : montant, compte, validations, pièces et historique.",
  "etapes": [
   "Dans <b>💰 Finances</b>, touchez une demande.",
   "Lisez le tableau : montant, objet, compte, validations Walid et DG.",
   "Touchez 📄 ou 🖼️ dans <b>Pièces</b> ou <b>Preuves</b> pour voir un document.",
   "En bas, lisez l'<b>Historique</b>.",
   "Les boutons d'action dépendent du statut et de votre rôle."
  ],
  "notes": [
   "⚠️ Les pièces jointes demandent le réseau."
  ],
  "voir": [
   "fin-consulter"
  ]
 },
 {
  "id": "fin-depense-caisse",
  "rub": "finances",
  "titre": "Déclarer une dépense de caisse",
  "droits": [
   "finances"
  ],
  "qui": "Qui : tout agent avec le droit Finances.",
  "mots": "depense caisse especes achat petit argent cash recu reçu frais payer liquide",
  "intro": "Pour une dépense payée en espèces depuis une caisse. Elle passe par la validation avant d'être payée.",
  "etapes": [
   "Touchez <b>💰 Finances</b> puis <b>➕ Nouvelle demande</b>.",
   "Dans <b>Type</b>, choisissez <b>Dépense de caisse</b>.",
   "Choisissez la <b>Devise de l'opération</b>. Hors GNF, le taux de change est obligatoire.",
   "Choisissez la <b>Société (payeuse)</b> et la <b>Caisse</b>.",
   "Remplissez <b>Objet</b>, <b>Montant</b> et <b>Catégorie (trésorerie)</b>.",
   "Ajoutez le reçu avec <b>📷 Photo</b> ou <b>📎 Fichier</b> (facultatif).",
   "Touchez <b>📤 Envoyer la demande</b>, puis confirmez.",
   "Validation : Walid seul sous 5 000 000 GNF, sinon Walid puis le DG."
  ],
  "notes": [
   "💡 Le fournisseur est facultatif. « Pour le compte de » sert si une autre société doit rembourser.",
   "💡 Catégorie Fourniture Locale ou Importée : un bloc Achat s'ouvre (article, magasin, quantité).",
   "💡 Après validation, clôturez avec « 🧾 Clôturer : paiement effectué » (justificatif facultatif)."
  ],
  "img": "fin-depense-caisse",
  "voir": [
   "fin-cloturer",
   "fin-corriger",
   "fin-achat"
  ]
 },
 {
  "id": "fin-paiement-rh",
  "rub": "finances",
  "titre": "Demander un paiement RH (avance, prime, salaire)",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances (souvent l'agent RH).",
  "mots": "paiement rh avance salaire prime prise en charge medicale personnel employe payer acompte",
  "intro": "Pour payer un membre du personnel : avance, prime, prise en charge, salaire.",
  "etapes": [
   "Touchez <b>💰 Finances</b> › <b>➕ Nouvelle demande</b> (ou RH › fiche agent › <b>💰 Paiement</b>).",
   "Dans <b>Type</b>, choisissez <b>Paiement RH</b>.",
   "Choisissez le <b>Personnel</b> et le <b>Motif</b>.",
   "Pour un salaire, choisissez le <b>Mois du salaire</b>.",
   "Choisissez le <b>Mode de paiement</b> (Espèces ou Virement) et la caisse ou le compte.",
   "Tapez le <b>Montant</b>. Si la devise diffère de celle du salaire, remplissez l'<b>Équivalent</b>.",
   "Touchez <b>📤 Envoyer la demande</b>.",
   "Validation : Walid seul en espèces sous 5 000 000 GNF, sinon Walid puis le DG."
  ],
  "notes": [
   "💡 La catégorie est mise automatiquement.",
   "💡 Pour un virement, remplissez le bénéficiaire."
  ],
  "voir": [
   "rh-personnel",
   "rh-paie"
  ]
 },
 {
  "id": "fin-mouvement",
  "rub": "finances",
  "titre": "Enregistrer un mouvement de trésorerie (retrait, versement, virement)",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances.",
  "mots": "mouvement tresorerie retrait versement virement transfert caisse banque compte deposer retirer cheque",
  "intro": "Pour déplacer de l'argent entre caisses et comptes bancaires, ou faire un virement.",
  "etapes": [
   "Touchez <b>💰 Finances</b> › <b>➕ Nouvelle demande</b>.",
   "Dans <b>Type</b>, choisissez <b>Mouvement de trésorerie</b>.",
   "Dans <b>Mouvement</b>, choisissez : Retrait, Versement, Virement, Remise chèque, Transfert entre caisses ou Remboursement inter-sociétés.",
   "Choisissez le compte de départ, puis le compte d'arrivée.",
   "Tapez le <b>Montant</b>. Si l'arrivée est dans une autre devise, remplissez le montant reçu.",
   "Retrait : ajoutez la photo du chèque (obligatoire).",
   "Touchez <b>📤 Envoyer la demande</b>."
  ],
  "notes": [
   "💡 Virement sans compte d'arrivée = bénéficiaire externe : remplissez le bénéficiaire et la catégorie.",
   "💡 Vers la caisse d'une autre société : c'est une avance inscrite dans 🔁 Inter-sociétés.",
   "💡 Retrait, Versement, Virement : Walid puis DG. Transfert entre caisses sous 5 000 000 GNF : Walid seul."
  ],
  "img": "fin-mouvement",
  "voir": [
   "fin-remise-cheque",
   "fin-inter-societes"
  ]
 },
 {
  "id": "fin-remise-cheque",
  "rub": "finances",
  "titre": "Déclarer une remise de chèque",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances.",
  "mots": "remise cheque deposer cheque banque cheque tire remis beneficiaire photo",
  "intro": "Pour un chèque de nos comptes déposé sur un autre de nos comptes ou remis à un bénéficiaire.",
  "etapes": [
   "Touchez <b>💰 Finances</b> › <b>➕ Nouvelle demande</b>.",
   "<b>Type</b> : <b>Mouvement de trésorerie</b>. <b>Mouvement</b> : <b>Remise chèque</b>.",
   "Choisissez <b>Chèque tiré sur</b>, puis <b>Remis sur (ou bénéficiaire)</b>.",
   "Tapez le <b>Montant</b>.",
   "Prenez la photo du chèque avec <b>📷 Photo</b> (obligatoire).",
   "Touchez <b>📤 Envoyer la demande</b>."
  ],
  "notes": [
   "⚠️ Un chèque reçu d'un client se déclare dans 🤝 Commercial (encaissement), pas ici.",
   "💡 Vers un de nos comptes sous 5 000 000 GNF : Walid seul. Vers un bénéficiaire externe : Walid puis DG."
  ],
  "voir": [
   "fin-mouvement",
   "com-encaissement"
  ]
 },
 {
  "id": "fin-operation-constatee",
  "rub": "finances",
  "titre": "Enregistrer une opération constatée (prélèvement, crédit)",
  "droits": [
   "direction",
   "comptable"
  ],
  "qui": "Qui : Walid, le DG ou le comptable.",
  "mots": "operation constatee prelevement bancaire credit bancaire placement frais banque releve sans validation",
  "intro": "Pour une opération déjà passée par la banque. Pas de validation : elle est inscrite dans Base tout de suite.",
  "etapes": [
   "Touchez <b>💰 Finances</b> › <b>➕ Nouvelle demande</b>.",
   "Dans <b>Type</b>, choisissez <b>Opération constatée</b>.",
   "Choisissez l'opération : Prélèvement bancaire, Crédit bancaire ou Placement bancaire.",
   "Choisissez le compte bancaire, le montant et la catégorie.",
   "Touchez <b>📒 Enregistrer</b>."
  ],
  "notes": []
 },
 {
  "id": "fin-achat",
  "rub": "finances",
  "titre": "Déclarer un achat fournisseur",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances.",
  "mots": "achat fournisseur facture acheter fourniture stock charge prestation payer plus tard comptant article magasin",
  "intro": "Pour un achat, avec ou sans facture, payé tout de suite ou plus tard. Un achat de stock alimente le Suivi Achats.",
  "etapes": [
   "Touchez <b>💰 Finances</b> › <b>🏭 Fournisseurs</b>, ouvrez le fournisseur, puis <b>➕ Demande</b>.",
   "<b>Type</b> : <b>Achat fournisseur</b>.",
   "Choisissez <b>Pièce</b> (Avec facture / Sans facture) et <b>Paiement</b> (Payé maintenant / À payer plus tard).",
   "Choisissez la <b>Destination</b> : Stock (local ou importé) ou Charge.",
   "Choisissez la <b>Société bénéficiaire</b> et le projet si besoin.",
   "Avec facture : tapez la <b>Réf. de la facture</b>. À payer plus tard : l'<b>Échéance</b>.",
   "Stock : remplissez le bloc <b>📦 Achat</b> (magasin, article, quantité).",
   "Tapez le <b>Montant</b>, ajoutez la photo, puis <b>📤 Envoyer la demande</b>."
  ],
  "notes": [
   "⚠️ Avec facture : la photo de la facture est obligatoire.",
   "💡 À payer plus tard : Walid puis DG valident la facture. Elle se règle ensuite avec « Règlement fournisseur ».",
   "💡 Société payeuse différente : la dette va dans 🔁 Inter-sociétés."
  ],
  "voir": [
   "fin-reglement",
   "fin-fournisseurs",
   "fin-suivi-achats"
  ]
 },
 {
  "id": "fin-reglement",
  "rub": "finances",
  "titre": "Régler une ou plusieurs factures fournisseur",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances.",
  "mots": "reglement regler payer facture fournisseur plusieurs factures groupe tranche reste a payer cheque virement",
  "intro": "Pour payer des factures déjà enregistrées, en entier ou en partie.",
  "etapes": [
   "Ouvrez <b>🏭 Fournisseurs</b>, puis le fournisseur, puis <b>➕ Demande</b>.",
   "<b>Type</b> : <b>Règlement fournisseur</b>. <b>Règlement</b> : <b>Factures à régler</b>.",
   "Cochez les factures. En GNF, le reste est prérempli. Changez le montant pour payer une partie.",
   "Vérifiez le total sous la liste.",
   "Choisissez le <b>Mode de paiement</b> (Espèces, Chèque, Virement) et le compte.",
   "Chèque : ajoutez la photo du chèque (obligatoire).",
   "Touchez <b>📤 Envoyer la demande</b>."
  ],
  "notes": [
   "⚠️ Des factures en devises différentes se règlent séparément.",
   "💡 Plusieurs factures = un règlement groupé : une validation, un paiement, une preuve.",
   "💡 Virement : toujours Walid puis DG. Espèces ou chèque sous 5 000 000 GNF : Walid seul."
  ],
  "voir": [
   "fin-avance-fournisseur",
   "fin-cloturer"
  ]
 },
 {
  "id": "fin-avance-fournisseur",
  "rub": "finances",
  "titre": "Verser une avance à un fournisseur",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances.",
  "mots": "avance fournisseur acompte sans facture payer avant",
  "intro": "Pour payer un fournisseur avant de recevoir sa facture.",
  "etapes": [
   "Ouvrez <b>🏭 Fournisseurs</b>, puis le fournisseur, puis <b>➕ Demande</b>.",
   "<b>Type</b> : <b>Règlement fournisseur</b>. <b>Règlement</b> : <b>Avance (sans facture)</b>.",
   "Choisissez la <b>Société bénéficiaire de l'avance</b> et le projet si besoin.",
   "Tapez le <b>Montant</b>, le mode et le compte.",
   "Touchez <b>📤 Envoyer la demande</b>."
  ],
  "notes": [
   "💡 Quand la facture arrive, imputez l'avance dessus."
  ],
  "voir": [
   "fin-imputer-avance"
  ]
 },
 {
  "id": "fin-imputer-avance",
  "rub": "finances",
  "titre": "Imputer une avance sur une facture",
  "droits": [
   "finances"
  ],
  "qui": "Qui : l'auteur de l'avance, Walid ou le DG.",
  "mots": "imputer imputation avance facture rattacher deduire solder",
  "intro": "L'avance déjà payée compte comme règlement de la facture. Aucun nouveau paiement.",
  "etapes": [
   "Ouvrez la demande d'avance exécutée.",
   "Dans la carte <b>🔗 Avance : imputation sur facture</b>, choisissez la <b>Facture non soldée</b>.",
   "Vérifiez le <b>Montant</b> (prérempli au maximum).",
   "Touchez <b>🔗 Imputer sur la facture</b>."
  ],
  "notes": [
   "💡 Pour annuler une imputation, touchez <b>Retirer</b>."
  ],
  "voir": [
   "fin-avance-fournisseur"
  ]
 },
 {
  "id": "fin-valider",
  "rub": "finances",
  "titre": "Valider, renvoyer ou refuser une demande",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid et le DG.",
  "mots": "valider validation refuser renvoyer correction approuver accord walid dg decision demande",
  "intro": "Walid valide d'abord ; le DG valide ensuite au-delà de 5 000 000 GNF et pour les opérations bancaires.",
  "etapes": [
   "Ouvrez la demande (onglet <b>À traiter</b> 👉, 🔔 ou la notification <b>💰 Demande à valider</b>).",
   "Vérifiez le montant, l'objet et les pièces.",
   "Touchez <b>✅ Valider</b>.",
   "Pour renvoyer ou refuser, écrivez d'abord le <b>Commentaire</b>.",
   "Puis touchez <b>↩️ Retour pour correction</b> ou <b>⛔ Refuser</b>.",
   "Le demandeur est notifié."
  ],
  "notes": [
   "💡 Le DG peut valider avant Walid : sa décision suffit.",
   "💡 Règlement groupé : la décision vaut pour toutes les factures du groupe.",
   "💡 Les salaires du mois se valident en une fois dans RH › Paie du mois."
  ],
  "img": "fin-valider",
  "voir": [
   "fin-modifier-direction",
   "rh-paie"
  ]
 },
 {
  "id": "fin-cloturer",
  "rub": "finances",
  "titre": "Clôturer un paiement (paiement effectué)",
  "droits": [
   "finances"
  ],
  "qui": "Qui : le demandeur, Walid ou le DG. Salaire automatique : direction, comptable ou RH.",
  "mots": "cloturer cloture paiement effectue execute paye preuve recu photo talon avis virement",
  "intro": "Une fois l'argent remis, on clôture avec la preuve. La demande est alors écrite dans Base.",
  "etapes": [
   "Ouvrez la demande « À exécuter ».",
   "Dans la carte <b>Paiement effectué</b>, ajoutez la preuve avec <b>📷 Photo</b> ou <b>📎 Fichier</b>.",
   "Changez la date d'effet seulement si le paiement a eu lieu un autre jour.",
   "Touchez <b>🧾 Clôturer : paiement effectué</b>.",
   "La demande passe « Exécutée », elle est écrite dans Base et le demandeur reçoit « 🧾 Paiement effectué »."
  ],
  "notes": [
   "⚠️ Photo obligatoire (reçu, talon de chèque, avis de virement), sauf Dépense de caisse, Retrait et Transfert entre caisses.",
   "⚠️ Salaire automatique : choisissez aussi le mode et le compte payeur.",
   "⚠️ « Écriture dans Base impossible » : prévenez le comptable pour la saisie à la main."
  ],
  "img": "fin-cloturer",
  "voir": [
   "fin-valider"
  ]
 },
 {
  "id": "fin-corriger",
  "rub": "finances",
  "titre": "Corriger, modifier ou annuler sa demande",
  "droits": [
   "finances"
  ],
  "qui": "Qui : le demandeur.",
  "mots": "corriger modifier annuler demande erreur renvoyer a corriger retour correction",
  "intro": "Vous pouvez corriger votre demande si elle est renvoyée, ou la modifier avant toute validation.",
  "etapes": [
   "Ouvrez votre demande.",
   "Statut « À corriger » : lisez le commentaire, puis touchez <b>✏️ Corriger et renvoyer</b>.",
   "Statut « En attente Walid » sans validation : touchez <b>✏️ Modifier ma demande (avant validation)</b>.",
   "Le formulaire se rouvre prérempli. Corrigez, puis envoyez.",
   "Pour annuler, touchez <b>Annuler la demande</b>."
  ],
  "notes": [
   "💡 Les pièces déjà jointes sont gardées."
  ]
 },
 {
  "id": "fin-modifier-direction",
  "rub": "finances",
  "titre": "Modifier une demande (Walid / DG)",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid ou le DG avant validation ; le DG seul après validation, si rien n'est payé.",
  "mots": "modifier demande direction changer montant compte categorie objet walid dg",
  "intro": "La direction peut corriger directement une demande. Le changement est tracé et le demandeur est notifié.",
  "etapes": [
   "Ouvrez la demande.",
   "Touchez <b>✏️ Modifier (Walid/DG)</b>.",
   "Changez ce qu'il faut : montant, compte, catégorie, objet, date…",
   "Écrivez le <b>Motif de la modification</b>.",
   "Touchez <b>💾 Enregistrer la modification</b>."
  ],
  "notes": [
   "💡 La devise ne peut pas être changée."
  ],
  "voir": [
   "fin-proposer-dg"
  ]
 },
 {
  "id": "fin-proposer-dg",
  "rub": "finances",
  "titre": "Proposer au DG une modification ou une annulation",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid, pour une demande déjà validée (« À exécuter »).",
  "mots": "proposer proposition modification annulation accord dg walid changer operation",
  "intro": "Après validation, seul le DG peut changer une demande. Walid lui propose le changement.",
  "etapes": [
   "Ouvrez la demande « À exécuter ».",
   "Dans <b>Changer l'opération (accord du DG)</b>, touchez <b>✏️ Demander une modification</b> ou <b>🗑️ Demander l'annulation</b>.",
   "Remplissez les changements et le motif.",
   "Touchez <b>📤 Envoyer la proposition au DG</b>.",
   "Le paiement est suspendu jusqu'à la réponse du DG."
  ],
  "notes": [
   "💡 La pièce jointe ne change pas. Pour une nouvelle pièce : demandez l'annulation, puis refaites la demande."
  ],
  "voir": [
   "fin-decider-proposition"
  ]
 },
 {
  "id": "fin-decider-proposition",
  "rub": "finances",
  "titre": "Accepter ou refuser une proposition de Walid",
  "droits": [
   "dg"
  ],
  "qui": "Qui : le DG.",
  "mots": "proposition walid accepter refuser modification annulation dg decider",
  "intro": "Le DG décide des changements proposés par Walid sur une demande validée.",
  "etapes": [
   "Ouvrez la demande (🔔 « Proposition à décider »).",
   "Lisez le tableau Avant / Proposé, ou la demande d'annulation.",
   "Touchez <b>✅ Accepter</b>.",
   "Pour refuser, écrivez le commentaire, puis <b>⛔ Refuser</b>."
  ],
  "notes": [
   "💡 Annulation acceptée : <b>🔁 Refaire la demande (nouvelle pièce)</b> rouvre le formulaire."
  ],
  "voir": [
   "fin-proposer-dg"
  ]
 },
 {
  "id": "fin-execution-directe",
  "rub": "finances",
  "titre": "Saisir et exécuter directement une opération (DG)",
  "droits": [
   "dg"
  ],
  "qui": "Qui : le DG.",
  "mots": "dg execution directe preuve paiement immediat valide d office",
  "intro": "Une saisie du DG est validée d'office. Avec la preuve jointe, elle est exécutée tout de suite.",
  "etapes": [
   "Faites la demande comme d'habitude.",
   "Dans <b>💳 Exécution directe (DG)</b>, joignez la preuve du paiement.",
   "Touchez <b>📤 Envoyer la demande</b>.",
   "Avec preuve : « Exécutée » et écrite dans Base. Sans preuve : elle reste « À exécuter »."
  ],
  "notes": [
   "💡 Une dépense de caisse du DG est exécutée même sans preuve."
  ]
 },
 {
  "id": "fin-fournisseurs",
  "rub": "finances",
  "titre": "Rechercher un fournisseur ou un prestataire",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances. Réseau nécessaire la première fois.",
  "mots": "fournisseurs prestataires liste rechercher solde du avance compte societe projet",
  "intro": "La liste des fournisseurs montre le solde de chacun : rouge = on lui doit, bleu = avance.",
  "etapes": [
   "Touchez <b>💰 Finances</b> puis <b>🏭 Fournisseurs</b>.",
   "Tapez le nom dans la recherche.",
   "Filtrez par société ou par projet si besoin.",
   "Touchez un fournisseur pour ouvrir sa fiche."
  ],
  "notes": [
   "💡 Cochez « afficher les comptes désactivés et les projets achevés » pour tout voir."
  ],
  "voir": [
   "fin-fournisseur-creer",
   "fin-releve-fournisseur"
  ]
 },
 {
  "id": "fin-fournisseur-creer",
  "rub": "finances",
  "titre": "Créer un fournisseur ou un prestataire",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances.",
  "mots": "creer nouveau fournisseur prestataire raison sociale nif rib tva telephone",
  "intro": "Un fournisseur a un ou plusieurs comptes (un par société et par projet).",
  "etapes": [
   "Ouvrez <b>🏭 Fournisseurs</b> puis <b>➕ Nouveau fournisseur / prestataire</b>.",
   "Remplissez la <b>Raison sociale</b> et la <b>Société bénéficiaire du 1er compte</b> (obligatoire).",
   "Choisissez le <b>Type</b> et cochez la TVA si besoin.",
   "Ajoutez le téléphone, le NIF et le RIB si vous les avez.",
   "Touchez <b>Créer le fournisseur</b>."
  ],
  "notes": [
   "💡 Si le nom existe déjà, sa fiche s'ouvre pour lui ajouter un compte."
  ],
  "voir": [
   "fin-fournisseur-compte"
  ]
 },
 {
  "id": "fin-fournisseur-compte",
  "rub": "finances",
  "titre": "Ajouter ou modifier un compte fournisseur",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances (suppression : DG ou WALID).",
  "mots": "compte fournisseur ajouter societe projet modifier desactiver supprimer",
  "intro": "Chaque compte relie un fournisseur à une société et à un projet.",
  "etapes": [
   "Ouvrez la fiche du fournisseur.",
   "Pour ajouter : touchez <b>➕ Nouveau compte</b>, choisissez la société et le projet, puis <b>Créer le compte</b>.",
   "Pour modifier : ouvrez le compte, puis <b>✏️ Modifier le compte</b>.",
   "Décochez <b>compte actif</b> pour ne plus le proposer dans les demandes."
  ],
  "notes": [
   "⚠️ Un compte ne peut être supprimé que s'il n'a aucune demande."
  ]
 },
 {
  "id": "fin-releve-fournisseur",
  "rub": "finances",
  "titre": "Voir le relevé d'un fournisseur (PDF)",
  "droits": [
   "finances"
  ],
  "qui": "Qui : droit Finances. Réseau obligatoire.",
  "mots": "releve fournisseur compte pdf solde facture paye du periode",
  "intro": "Le relevé montre les factures et paiements d'un compte fournisseur sur une période.",
  "etapes": [
   "Ouvrez la fiche du fournisseur, puis touchez un compte.",
   "Choisissez la période <b>Du</b> / <b>Au</b>.",
   "Lisez le solde, le facturé, le payé et le reste dû.",
   "Touchez <b>📄 Relevé PDF</b> pour l'imprimer ou l'envoyer."
  ],
  "notes": []
 },
 {
  "id": "fin-projet-acheve",
  "rub": "finances",
  "titre": "Marquer un projet achevé ou le rouvrir",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid ou le DG.",
  "mots": "projet acheve termine fini rouvrir masquer comptes fournisseurs",
  "intro": "Les comptes d'un projet achevé ne sont plus proposés dans les demandes.",
  "etapes": [
   "Ouvrez <b>🏭 Fournisseurs</b>.",
   "Choisissez le projet dans le filtre.",
   "Touchez <b>✅ Marquer le projet « … » achevé</b> (ou <b>↩️ Rouvrir le projet</b>)."
  ],
  "notes": [
   "💡 Un compte qui a encore un solde à régler reste visible."
  ]
 },
 {
  "id": "fin-inter-societes",
  "rub": "finances",
  "titre": "Consulter et régler les dettes entre sociétés",
  "droits": [
   "direction",
   "comptable"
  ],
  "qui": "Qui : Walid, le DG (actions) et le comptable (lecture). Réseau obligatoire.",
  "mots": "inter societes dette ab m2s casafino doit remboursement compensation apport",
  "intro": "Quand une société paie pour une autre, une dette est notée ici.",
  "etapes": [
   "Touchez <b>💰 Finances</b> puis <b>🔁 Inter-sociétés</b>.",
   "Lisez « X doit à Y » et le détail par paire.",
   "Pour rembourser par un vrai paiement : <b>💸 Remboursement (mouvement)</b>.",
   "Pour compenser sans paiement : <b>⚖️ Compensation / apport</b>, choisissez les deux sociétés, le montant et un commentaire, puis <b>Enregistrer</b>."
  ],
  "notes": [
   "💡 Le commentaire est obligatoire pour une compensation."
  ],
  "voir": [
   "fin-mouvement"
  ]
 },
 {
  "id": "fin-soldes",
  "rub": "finances",
  "titre": "Consulter les soldes fournisseurs",
  "droits": [
   "direction",
   "comptable"
  ],
  "qui": "Qui : Walid, le DG et le comptable.",
  "mots": "soldes fournisseurs reste a payer echu dettes total",
  "intro": "Montre ce qui reste à payer à chaque fournisseur, et ce qui est échu.",
  "etapes": [
   "Touchez <b>💰 Finances</b> puis <b>📊 Soldes</b>.",
   "Lisez « Reste à payer » et la part échue.",
   "Touchez une facture pour l'ouvrir. ⚠️ = échéance dépassée."
  ],
  "notes": [
   "💡 Les soldes des caisses et banques sont dans la tuile 🏦 Trésorerie."
  ]
 },
 {
  "id": "fin-export",
  "rub": "finances",
  "titre": "Exporter le mois (Excel)",
  "droits": [
   "direction",
   "comptable"
  ],
  "qui": "Qui : Walid, le DG et le comptable. Réseau obligatoire.",
  "mots": "export exporter mois excel xlsx classeur comptabilite drive",
  "intro": "Crée un classeur Excel des opérations du mois.",
  "etapes": [
   "Touchez <b>💰 Finances</b> puis <b>📤 Export du mois</b>.",
   "Tapez le mois (ex. 2026-10).",
   "Attendez (jusqu'à 3 minutes).",
   "Partagez ou téléchargez le fichier ; ouvrez-le aussi dans Google Drive si besoin."
  ],
  "notes": []
 },
 {
  "id": "fin-suivi-achats",
  "rub": "finances",
  "titre": "Mettre à jour le suivi d'un achat",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG et WALID.",
  "mots": "suivi achats tracking livraison livre quantite livree cloture entree stock",
  "intro": "Suit un achat de stock : tracking, livraison, entrée en stock.",
  "etapes": [
   "Touchez <b>💰 Finances</b> puis <b>📦 Suivi des achats</b>.",
   "Touchez l'achat.",
   "Remplissez seulement ce qui change : tracking, date et quantité livrée, statut.",
   "Statut « Clôturé » : indiquez l'entrée en stock et la quantité.",
   "Touchez <b>💾 Enregistrer</b>."
  ],
  "notes": [
   "⚠️ Le comptable voit le bouton, mais l'enregistrement est réservé au DG et à WALID."
  ],
  "voir": [
   "fin-achat"
  ]
 },
 {
  "id": "tr-soldes",
  "rub": "treso",
  "titre": "Consulter les soldes des caisses et banques",
  "droits": [
   "treso",
   "dirNom"
  ],
  "qui": "Qui : le DG et WALID (tous les comptes) ; les autres, leurs comptes seulement. Réseau obligatoire.",
  "mots": "tresorerie solde caisse banque compte combien argent disponible a payer a recevoir",
  "intro": "Montre le solde de chaque caisse et compte bancaire, et ce qui reste à payer.",
  "etapes": [
   "Touchez la tuile <b>🏦 Trésorerie</b>.",
   "Regardez les groupes <b>Caisses</b> et <b>Comptes bancaires</b>.",
   "Lisez le solde, ce qui est à payer, à recevoir et « Après paiements ».",
   "Touchez un compte pour voir son relevé."
  ],
  "notes": [
   "💡 « En validation » n'est pas encore compté dans le solde."
  ],
  "voir": [
   "tr-releve"
  ]
 },
 {
  "id": "tr-releve",
  "rub": "treso",
  "titre": "Voir le relevé d'un compte (PDF)",
  "droits": [
   "treso",
   "dirNom"
  ],
  "qui": "Qui : les agents qui ont accès au compte. Réseau obligatoire.",
  "mots": "releve compte caisse banque pdf periode operations imprimer telecharger",
  "intro": "Le relevé liste les opérations du compte et les engagements en cours.",
  "etapes": [
   "Dans <b>🏦 Trésorerie</b>, touchez le compte.",
   "Choisissez la période <b>Du</b> / <b>Au</b>.",
   "Lisez les cartes <b>Engagements DuoCore</b> et <b>Relevé</b>.",
   "Touchez <b>📄 Relevé PDF</b> pour l'imprimer ou l'envoyer."
  ],
  "notes": [
   "💡 Sans période, les 400 dernières opérations s'affichent."
  ]
 },
 {
  "id": "rh-personnel",
  "rub": "rh",
  "titre": "Consulter le personnel et la fiche d'un agent",
  "droits": [
   "rh",
   "direction"
  ],
  "qui": "Qui : l'agent RH, Walid et le DG.",
  "mots": "rh personnel employe agent fiche salaire paie conges mouvements historique",
  "intro": "La fiche d'un agent montre son salaire, sa paie, ses paiements, ses congés et ses mouvements.",
  "etapes": [
   "Touchez la tuile <b>👥 RH</b>.",
   "Onglet <b>Personnel</b> : cherchez l'agent.",
   "Touchez l'agent pour ouvrir sa fiche.",
   "Choisissez le mois dans <b>🧾 Paie</b> pour voir le détail.",
   "Consultez <b>💰 Paiements</b>, <b>🗓️ Congés et absences</b> et <b>📒 Mouvements</b>."
  ],
  "notes": [
   "💡 Heure sup = salaire / 26 / 8 ; heure d'absence = salaire / 26 / 4.",
   "💡 L'onglet <b>Historique</b> liste les salaires de base, arrivées et départs."
  ],
  "img": "rh-personnel",
  "voir": [
   "rh-evenement",
   "fin-paiement-rh"
  ]
 },
 {
  "id": "rh-evenement",
  "rub": "rh",
  "titre": "Saisir un événement RH (heures sup, absence, prélèvement)",
  "droits": [
   "rh",
   "direction"
  ],
  "qui": "Qui : l'agent RH, Walid et le DG.",
  "mots": "evenement rh heure sup heures supplementaires absence prelevement conge maladie conge autorise retenue",
  "intro": "Les événements comptent pour la paie du mois de la date d'effet.",
  "etapes": [
   "Touchez <b>👥 RH</b> puis <b>➕ Événement : heures, absence, congé, prélèvement</b>.",
   "Choisissez l'<b>Agent</b> et le <b>Type</b>.",
   "Tapez le nombre d'heures, de jours ou le montant.",
   "Vérifiez la <b>Date d'effet</b>.",
   "Ajoutez un commentaire, puis touchez <b>📤 Envoyer</b>.",
   "Walid valide, puis c'est inscrit dans Base."
  ],
  "notes": [
   "💡 Saisi par Walid ou le DG : validé et inscrit dans Base tout de suite.",
   "💡 Renvoyé pour correction ? Ouvrez-le dans l'onglet <b>Événements</b> : <b>✏️ Corriger et renvoyer</b>, ou <b>Annuler cet événement</b>."
  ],
  "voir": [
   "rh-valider-evenement"
  ]
 },
 {
  "id": "rh-valider-evenement",
  "rub": "rh",
  "titre": "Valider ou refuser un événement RH",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid et le DG.",
  "mots": "valider evenement rh refuser renvoyer correction heures absence",
  "intro": "Un événement validé est inscrit dans Base et compte pour la paie.",
  "etapes": [
   "Ouvrez l'onglet <b>Événements</b> (ou 🔔 « Événement RH à valider »).",
   "Touchez l'événement.",
   "Touchez <b>✅ Valider (inscrit dans Base)</b>.",
   "Pour refuser ou renvoyer : écrivez le commentaire, puis <b>↩️ Retour pour correction</b> ou <b>⛔ Refuser</b>."
  ],
  "notes": []
 },
 {
  "id": "rh-salaire",
  "rub": "rh",
  "titre": "Changer le salaire de base",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid et le DG.",
  "mots": "salaire base augmentation changer nouveau salaire",
  "intro": "Le nouveau salaire s'applique à partir du mois choisi.",
  "etapes": [
   "Ouvrez la fiche de l'agent.",
   "Touchez <b>💵 Salaire de base</b>.",
   "Tapez le <b>Nouveau salaire</b> et choisissez <b>À partir de</b>.",
   "Touchez <b>Enregistrer</b>."
  ],
  "notes": [
   "💡 Un mois passé recalcule la paie ; un mois futur s'applique le 1er du mois."
  ]
 },
 {
  "id": "rh-depart",
  "rub": "rh",
  "titre": "Enregistrer le départ d'un agent",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid et le DG.",
  "mots": "depart demission fin contrat licenciement quitter agent parti",
  "intro": "Le salaire passe à zéro le mois suivant le dernier mois payé.",
  "etapes": [
   "Ouvrez la fiche de l'agent.",
   "Touchez <b>🚪 Départ</b>.",
   "Choisissez le <b>Dernier mois de salaire</b> et écrivez le motif.",
   "Touchez <b>Enregistrer le départ</b>."
  ],
  "notes": []
 },
 {
  "id": "rh-nouvel-agent",
  "rub": "rh",
  "titre": "Créer un nouvel agent",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid et le DG.",
  "mots": "nouvel agent embauche recrutement nouveau salarie employe creer",
  "intro": "Ajoute une personne au personnel avec son salaire.",
  "etapes": [
   "Touchez <b>👥 RH</b> puis <b>👤 Nouvel agent</b>.",
   "Tapez le <b>Nom</b> en majuscules.",
   "Tapez le <b>Salaire de base</b>, choisissez la <b>Devise</b> et le mois <b>À partir de</b>.",
   "Ajoutez le RIB et le titulaire si besoin.",
   "Touchez <b>Enregistrer</b>."
  ],
  "notes": []
 },
 {
  "id": "rh-paie",
  "rub": "rh",
  "titre": "Préparer et valider la paie du mois",
  "droits": [
   "rh",
   "direction"
  ],
  "qui": "Qui : l'agent RH (lecture), Walid et le DG (génération et validation).",
  "mots": "paie salaires mois generer valider net a payer bulletin salaire mensuel",
  "intro": "Les demandes de salaire sont créées le 1er du mois à 8 h. Walid puis le DG les valident, puis on paie.",
  "etapes": [
   "Touchez <b>👥 RH</b>, onglet <b>Paie du mois</b>.",
   "Choisissez le <b>Mois</b>.",
   "Vérifiez le net de chaque agent.",
   "Walid / DG : touchez <b>⚙️ Générer / mettre à jour les demandes de salaire</b> si besoin.",
   "Walid / DG : touchez <b>✅ Valider les n salaire(s) en attente</b>.",
   "Ensuite, clôturez chaque paiement dans 💰 Finances avec la preuve."
  ],
  "notes": [
   "⚠️ « Net à compléter » : l'équivalent manque dans Base.",
   "💡 Un refus va dans <b>⛔ À corriger</b>."
  ],
  "voir": [
   "fin-cloturer",
   "fin-valider"
  ]
 },
 {
  "id": "rh-conge",
  "rub": "rh",
  "titre": "Saisir un congé",
  "droits": [
   "rh",
   "direction"
  ],
  "qui": "Qui : l'agent RH ou Walid saisissent ; le DG valide.",
  "mots": "conge conges vacances absence repos jours solde saisir demande",
  "intro": "Droit : 30 jours par 12 mois (2,5 jours par mois), en une ou plusieurs fois.",
  "etapes": [
   "Touchez <b>👥 RH</b>, onglet <b>🏖️ Congés & billets</b>.",
   "Touchez <b>➕ Congé</b>.",
   "Choisissez le <b>Personnel</b> : son solde s'affiche.",
   "Choisissez le <b>Premier jour</b> et le <b>Dernier jour</b>.",
   "Ajoutez un commentaire, puis touchez <b>✅ Enregistrer</b>.",
   "Le congé est « En attente DG ». Le DG est notifié."
  ],
  "notes": [
   "⚠️ « dépasse le solde » : vérifiez avec le DG.",
   "⚠️ Deux congés qui se chevauchent sont refusés."
  ],
  "img": "rh-conge",
  "voir": [
   "rh-valider-conge",
   "rh-billet",
   "rh-cycle"
  ]
 },
 {
  "id": "rh-billet",
  "rub": "rh",
  "titre": "Enregistrer un billet d'avion",
  "droits": [
   "rh",
   "direction"
  ],
  "qui": "Qui : l'agent RH, Walid et le DG.",
  "mots": "billet avion voyage vol aller retour tunis conakry compagnie depart retour ticket",
  "intro": "Chaque agent expatrié a un billet aller-retour, valable 11 mois.",
  "etapes": [
   "Onglet <b>🏖️ Congés & billets</b>, touchez <b>✈️ Billet d'avion</b>.",
   "Choisissez le <b>Personnel</b>. Remplissez la <b>Compagnie</b>, le <b>N° du billet</b> et <b>Émis le</b>.",
   "Choisissez <b>✈️ Aller vers</b> (Tunis, Conakry ou Autre) et la <b>Date de départ</b> (obligatoire).",
   "<b>↩️ Retour vers</b> : Conakry si l'aller va ailleurs ; sinon choisissez la ville.",
   "Date de retour : laissez vide si le retour est ouvert.",
   "Ajoutez le billet (photo ou PDF) : obligatoire.",
   "<b>💸 Paiement du billet</b> : <b>À payer</b> ou <b>Déjà payé</b>.",
   "Touchez <b>✅ Enregistrer</b>."
  ],
  "notes": [
   "💡 « À payer » ouvre ensuite la demande Finances, déjà remplie.",
   "⚠️ Un message prévient si le retour dépasse la validité du billet."
  ],
  "img": "rh-billet",
  "voir": [
   "rh-modifier-retour",
   "fin-paiement-rh"
  ]
 },
 {
  "id": "rh-cycle",
  "rub": "rh",
  "titre": "Définir le début du cycle de congés",
  "droits": [
   "rh",
   "direction"
  ],
  "qui": "Qui : l'agent RH, Walid et le DG.",
  "mots": "cycle droits conges debut embauche retour report jours solde",
  "intro": "Le solde de congés se calcule à partir du début du cycle.",
  "etapes": [
   "Onglet <b>🏖️ Congés & billets</b>, touchez <b>⚙️ Droits (début du cycle)</b>.",
   "Choisissez la personne.",
   "Indiquez le <b>Début du cycle</b> (embauche ou dernier retour).",
   "Ajoutez un report de jours si besoin, puis enregistrez."
  ],
  "notes": []
 },
 {
  "id": "rh-valider-conge",
  "rub": "rh",
  "titre": "Valider ou refuser un congé ou un billet",
  "droits": [
   "dg"
  ],
  "qui": "Qui : le DG.",
  "mots": "valider conge billet refuser dg en attente",
  "intro": "Les congés et billets saisis par RH ou Walid attendent la validation du DG.",
  "etapes": [
   "Ouvrez le congé ou le billet (calendrier, liste ou 🔔).",
   "Vérifiez les dates.",
   "Touchez <b>✅ Valider</b>.",
   "Pour refuser, écrivez le motif, puis <b>⛔ Refuser</b>."
  ],
  "notes": [
   "💡 Un élément validé ne peut être annulé que par le DG."
  ]
 },
 {
  "id": "rh-modifier-retour",
  "rub": "rh",
  "titre": "Modifier la date de retour d'un billet",
  "droits": [
   "rh",
   "direction"
  ],
  "qui": "Qui : l'agent RH, Walid et le DG.",
  "mots": "modifier retour billet changer date vol reporter",
  "intro": "Si la date de retour change, enregistrez le nouveau billet.",
  "etapes": [
   "Ouvrez le billet validé.",
   "Touchez <b>↩️ Modifier le retour</b>.",
   "Choisissez la <b>Nouvelle date de retour</b> et écrivez la raison.",
   "Ajoutez le billet modifié : obligatoire.",
   "Touchez <b>↩️ Enregistrer le nouveau retour</b>."
  ],
  "notes": [
   "💡 Billet pas encore payé ? Touchez <b>💸 Demande Finances (paiement du billet)</b>."
  ]
 },
 {
  "id": "rh-alertes-voyage",
  "rub": "rh",
  "titre": "Traiter les alertes congés et voyages (Confirmé / Vu)",
  "droits": [
   "rh",
   "direction"
  ],
  "qui": "Qui : l'agent RH, Walid et le DG.",
  "mots": "alertes voyage conge depart retour confirmer confirme vu validite billet a surveiller",
  "intro": "La carte « ⚠️ À surveiller » rappelle les départs, retours et billets à vérifier.",
  "etapes": [
   "Ouvrez l'onglet <b>🏖️ Congés & billets</b> (ou 🔔).",
   "Lisez les alertes de la carte <b>⚠️ À surveiller</b>.",
   "Le voyage est sûr ? Touchez <b>✅ Confirmé</b> : l'alerte disparaît pour tout le monde.",
   "Juste lu ? Touchez <b>👍 Vu</b> : l'alerte est cachée sur ce téléphone jusqu'à l'étape 7 jours."
  ],
  "notes": [
   "💡 « Confirmé » revient si la date change."
  ],
  "voir": [
   "nt-agir"
  ]
 },
 {
  "id": "rh-pr-fiche",
  "rub": "rh",
  "titre": "Créer ou modifier un prestataire (fiche)",
  "droits": [
   "direction"
  ],
  "qui": "Qui : Walid et le DG.",
  "mots": "prestataire nouveau fiche ahmed honoraire caisse fixe tnd duree periode mission reparateur",
  "intro": "Un prestataire vient en mission régulière (ex. : réparateur de machines). Sa fiche fixe l'honoraire et le rythme.",
  "etapes": [
   "Touchez <b>👥 RH</b>, onglet <b>🔧 Prestataires</b>.",
   "Touchez <b>➕ Nouveau prestataire</b> (ou <b>✏️ Fiche</b>).",
   "Remplissez le <b>Nom</b> (différent du personnel), le <b>Métier</b>, l'<b>Honoraire par mission (TND)</b> et la <b>Caisse fixe (TND)</b>.",
   "Remplissez la <b>Durée d'une mission</b> et <b>Une mission tous les (jours)</b>.",
   "Choisissez la <b>Société bénéficiaire</b>.",
   "Touchez <b>✅ Enregistrer</b>."
  ],
  "notes": [
   "💡 Exemple : Ahmed, 10 jours tous les 60 jours, 7 000 TND par mission, caisse fixe 2 000 TND."
  ],
  "voir": [
   "rh-pr-planifier"
  ],
  "img": "rh-pr-fiche"
 },
 {
  "id": "rh-pr-planifier",
  "rub": "rh",
  "titre": "Planifier la mission d'un prestataire",
  "droits": [
   "rh",
   "direction",
   "comptable"
  ],
  "qui": "Qui : l'agent RH, Walid, le DG ou le comptable.",
  "mots": "planifier mission prestataire ahmed arrivee depart conakry date vol",
  "intro": "La mission va de l'arrivée à Conakry au départ.",
  "etapes": [
   "Onglet <b>🔧 Prestataires</b>, touchez <b>➕ Planifier une mission</b>.",
   "Vérifiez <b>Arrivée à Conakry (jour du vol)</b> : proposée d'après la dernière mission.",
   "Le <b>Départ</b> est calculé avec la durée. Corrigez si besoin.",
   "Touchez <b>✅ Planifier</b>.",
   "Saisissez le billet dans <b>🏖️ Congés & billets</b>."
  ],
  "notes": [
   "💡 Pour changer les dates : <b>✏️ Modifier les dates</b>. Pour annuler : <b>🗑️ Annuler la mission</b>."
  ],
  "voir": [
   "rh-pr-cloturer",
   "rh-billet"
  ]
 },
 {
  "id": "rh-pr-cloturer",
  "rub": "rh",
  "titre": "Clôturer la mission d'un prestataire (rapport)",
  "droits": [
   "rh",
   "direction",
   "comptable"
  ],
  "qui": "Qui : l'agent RH, Walid, le DG ou le comptable.",
  "mots": "cloturer mission prestataire ahmed rapport travaux programme prochaine depenses caisse honoraire",
  "intro": "À la fin de la mission, on note le rapport et les comptes. La mission suivante est planifiée toute seule.",
  "etapes": [
   "Ouvrez la mission, touchez <b>📝 Clôturer : rapport et comptes</b>.",
   "Vérifiez les dates.",
   "Écrivez les <b>Travaux réalisés (rapport)</b> : obligatoire.",
   "Écrivez le <b>Programme de la prochaine mission</b> et sa date.",
   "Vérifiez l'<b>Honoraire</b> et tapez les <b>Dépenses de la caisse (TND)</b>.",
   "Ajoutez le rapport signé et les reçus si vous les avez.",
   "Touchez <b>✅ Clôturer la mission</b>."
  ],
  "notes": [
   "💡 « À payer » = honoraire + dépenses. DuoCore propose ensuite de préparer le paiement."
  ],
  "img": "rh-pr-cloturer",
  "voir": [
   "rh-pr-payer"
  ]
 },
 {
  "id": "rh-pr-payer",
  "rub": "rh",
  "titre": "Payer un prestataire (TND, USD, espèces ou virement)",
  "droits": [
   "rh",
   "direction",
   "comptable"
  ],
  "qui": "Qui : l'agent RH, Walid, le DG ou le comptable, avec le droit Finances.",
  "mots": "payer prestataire ahmed paiement tnd usd euro virement especes taux change honoraire caisse",
  "intro": "Le paiement d'un prestataire passe par une demande Finances préparée depuis la mission.",
  "etapes": [
   "Ouvrez la mission clôturée.",
   "Touchez <b>💸 Préparer le paiement</b>.",
   "Vérifiez le <b>Montant à régler (TND)</b>.",
   "Choisissez <b>Payé en</b> (USD, EURO ou TND) et tapez le taux.",
   "Choisissez le <b>Mode</b> : Virement ou Espèces.",
   "Touchez <b>💸 Préparer la demande Finances</b>, vérifiez puis envoyez.",
   "Une fois la demande exécutée, le montant est déduit du reste dû."
  ],
  "notes": [
   "💡 Virement : mouvement de trésorerie (catégorie Prestation). Espèces : dépense de caisse.",
   "⚠️ Ne refaites pas une demande pour un montant déjà demandé."
  ],
  "img": "rh-pr-payer",
  "voir": [
   "fin-mouvement",
   "fin-depense-caisse"
  ]
 },
 {
  "id": "com-consulter",
  "rub": "commercial",
  "titre": "Consulter contrats, devis, factures et clients",
  "droits": [
   "commercial",
   "direction",
   "comptable"
  ],
  "qui": "Qui : droit Commercial, Walid, le DG et le comptable (lecture).",
  "mots": "commercial contrats factures devis clients bdc production livre facture encaisse du",
  "intro": "La tuile Commercial regroupe contrats, devis, factures, clients et suivi de production.",
  "etapes": [
   "Touchez la tuile <b>🤝 Commercial</b>.",
   "Choisissez un onglet : <b>Contrats</b>, <b>Devis</b>, <b>Factures</b>, <b>Clients</b> ou <b>BDC & production</b>.",
   "Cherchez un client, un projet ou un n°.",
   "Touchez une carte pour ouvrir la fiche."
  ],
  "notes": [
   "💡 Les barres montrent commandé / livré et facturé / encaissé.",
   "💡 La fiche d'un contrat liste ses BDC, factures et BL (📄 pour ouvrir le PDF). Cochez « afficher les contrats clos » pour les retrouver."
  ],
  "img": "com-consulter",
  "voir": [
   "com-regimes",
   "com-facture"
  ]
 },
 {
  "id": "com-regimes",
  "rub": "commercial",
  "titre": "Comprendre les régimes de facturation (TVA)",
  "droits": [
   "commercial",
   "direction",
   "comptable"
  ],
  "qui": "Qui : tous ceux qui font des devis ou des factures.",
  "mots": "regime tva administration prive exonere ttc ht precompte armp net a payer taxe 18",
  "intro": "Les prix se saisissent toujours en HT. Le régime calcule le net à payer.",
  "etapes": [
   "<b>Administration</b> : facture en TTC, moins le précompte (50 % de la TVA), moins l'ARMP (0,6 %). Aucun HT n'est affiché.",
   "<b>Privé</b> : HT + TVA 18 % = TTC.",
   "<b>Exonéré</b> (BCRG, Défense, statut spécial…) : HT seul, « Exonéré de TVA ».",
   "Le <b>Net à payer</b> s'affiche sous les lignes avant l'envoi."
  ],
  "notes": [
   "💡 Le régime vient du client. On peut le changer pour une seule facture."
  ],
  "voir": [
   "com-facture",
   "com-regime-client"
  ]
 },
 {
  "id": "com-devis",
  "rub": "commercial",
  "titre": "Établir un devis",
  "droits": [
   "commercial",
   "direction"
  ],
  "qui": "Qui : droit Commercial, Walid et le DG. Réseau nécessaire pour le PDF.",
  "mots": "devis proforma offre prix proposition client pdf validite 30 jours",
  "intro": "Le devis donne un PDF numéroté DV-AAAA-NNN, valable 30 jours par défaut. Il n'est pas écrit dans Base.",
  "etapes": [
   "Touchez <b>🤝 Commercial</b> puis <b>📝 Devis</b>.",
   "Choisissez le <b>Client</b> (ou <b>✏️ Autre client</b>).",
   "Écrivez l'<b>Objet</b>. Vérifiez la <b>Société</b>, le <b>Régime</b> et la <b>Devise</b>.",
   "Pour chaque ligne : désignation, quantité, <b>Prix unitaire HT</b>. <b>➕ Ligne</b> pour en ajouter.",
   "Vérifiez la <b>Validité (jours)</b> et le net à payer.",
   "Touchez <b>📤 Émettre le devis (PDF)</b>, puis ouvrez le PDF."
  ],
  "notes": [
   "⚠️ Prix unitaire HT obligatoire sur chaque ligne.",
   "💡 Un devis expiré affiche « expiré le … »."
  ],
  "img": "com-devis",
  "voir": [
   "com-regimes"
  ]
 },
 {
  "id": "com-contrat",
  "rub": "commercial",
  "titre": "Créer un contrat",
  "droits": [
   "commercial",
   "direction"
  ],
  "qui": "Qui : droit Commercial, Walid et le DG.",
  "mots": "contrat nouveau client projet marche commande montant immatriculation",
  "intro": "Le contrat est la base des livraisons et des factures.",
  "etapes": [
   "Touchez <b>🤝 Commercial</b> puis <b>📄 Contrat</b>.",
   "Choisissez le <b>Client</b> (ou <b>➕ Nouveau client</b> avec nom, code et régime).",
   "Choisissez le <b>Projet</b> (ou <b>➕ Nouveau projet</b>).",
   "Choisissez le <b>Compte bénéficiaire</b>.",
   "<b>Le contrat recevra-t-il des BDC ?</b> : Non (le contrat est la commande) ou Oui.",
   "Choisissez le <b>Prix</b> : montant global HT, ou prix unitaire HT × quantité. Choisissez la devise.",
   "Touchez <b>📤 Enregistrer</b>."
  ],
  "notes": [
   "💡 Le n° du contrat arrive dans la minute (synchronisez)."
  ],
  "voir": [
   "com-bdc",
   "com-bl"
  ]
 },
 {
  "id": "com-bdc",
  "rub": "commercial",
  "titre": "Ajouter un BDC à un contrat",
  "droits": [
   "commercial",
   "direction"
  ],
  "qui": "Qui : droit Commercial, Walid et le DG.",
  "mots": "bdc bon de commande ajouter contrat commande nouveau",
  "intro": "Pour un contrat qui reçoit des bons de commande.",
  "etapes": [
   "Touchez <b>🤝 Commercial</b> puis <b>🛒 BDC</b> (ou depuis la fiche du contrat).",
   "Choisissez le <b>Contrat</b>.",
   "Remplissez le prix et la date.",
   "Touchez <b>📤 Enregistrer</b>."
  ],
  "notes": [
   "💡 Les articles du BDC se saisissent ensuite dans 🗂️ Planification (Saisi BDC)."
  ],
  "voir": [
   "pl-lignes"
  ]
 },
 {
  "id": "com-bl",
  "rub": "commercial",
  "titre": "Émettre un bon de livraison (BL)",
  "droits": [
   "commercial",
   "direction"
  ],
  "qui": "Qui : droit Commercial, Walid et le DG.",
  "mots": "bl bon de livraison livrer livraison pdf reste a livrer",
  "intro": "Le BL reprend les lignes du BDC avec le reste à livrer.",
  "etapes": [
   "Touchez <b>🤝 Commercial</b> puis <b>📦 BL</b>.",
   "Choisissez le <b>Contrat</b>, puis le <b>Bon de commande</b> s'il y en a.",
   "Vérifiez les quantités proposées. Mettez 0 pour une ligne non livrée.",
   "Remplissez la <b>Date</b> et <b>Livré à</b> (lieu, réceptionnaire).",
   "Touchez <b>📤 Émettre le BL (PDF)</b>."
  ],
  "notes": [
   "💡 <b>➕ Ligne libre</b> ajoute une ligne hors BDC."
  ],
  "voir": [
   "com-facture"
  ]
 },
 {
  "id": "com-facture",
  "rub": "commercial",
  "titre": "Émettre une facture",
  "droits": [
   "commercial",
   "direction"
  ],
  "qui": "Qui : droit Commercial, Walid et le DG.",
  "mots": "facture facturer emettre pdf regime echeance client tva net a payer",
  "intro": "La facture est écrite dans Base, donne un PDF et une notification « 🧾 Facture émise ».",
  "etapes": [
   "Touchez <b>🤝 Commercial</b> puis <b>🧾 Facture</b>.",
   "Choisissez le <b>Contrat</b> et le <b>Bon de commande</b>.",
   "Vérifiez le <b>Régime de la facture</b> (modifiable pour cette facture seulement).",
   "Vérifiez les quantités (livré non facturé). <b>↺ Quantités = commandé − déjà facturé</b> si besoin.",
   "Choisissez l'<b>Échéance de paiement</b>.",
   "Vérifiez le net à payer, puis touchez <b>📤 Émettre la facture (PDF)</b>."
  ],
  "notes": [
   "⚠️ Prix unitaire obligatoire sur chaque ligne.",
   "💡 « Délai habituel » = délai de la société (30 jours par défaut)."
  ],
  "img": "com-facture",
  "voir": [
   "com-regimes",
   "com-encaissement",
   "com-ouvrir-facture"
  ]
 },
 {
  "id": "com-encaissement",
  "rub": "commercial",
  "titre": "Enregistrer l'encaissement d'une facture",
  "droits": [
   "commercial",
   "direction"
  ],
  "qui": "Qui : droit Commercial, Walid et le DG.",
  "mots": "encaissement encaisser paye recouvrement reglement client cheque client virement recu",
  "intro": "Quand le client a payé toute la facture, enregistrez l'encaissement. Il est écrit dans Base.",
  "etapes": [
   "Touchez <b>🤝 Commercial</b> puis <b>💵 Encaissement</b> (ou fiche facture › <b>💵 Encaissée</b>).",
   "Choisissez la <b>Facture (payée en entier)</b>.",
   "Le compte crédité s'affiche.",
   "Tapez la <b>Date réelle d'encaissement</b> (celle du relevé bancaire).",
   "Touchez <b>💵 Enregistrer l'encaissement</b>."
  ],
  "notes": [
   "💡 Un chèque client se déclare ici, pas dans Finances.",
   "⚠️ « Déjà recouvrée » : l'encaissement est déjà enregistré."
  ],
  "img": "com-encaissement",
  "voir": [
   "com-retards"
  ]
 },
 {
  "id": "com-ouvrir-facture",
  "rub": "commercial",
  "titre": "Ouvrir une facture : PDF, partage, échéance",
  "droits": [
   "commercial",
   "direction",
   "comptable"
  ],
  "qui": "Qui : droit Commercial (le comptable en lecture).",
  "mots": "ouvrir facture pdf partager envoyer whatsapp echeance changer date paiement",
  "intro": "La fiche d'une facture permet de l'envoyer et de changer son échéance.",
  "etapes": [
   "Onglet <b>Factures</b>, touchez la facture.",
   "Touchez <b>📄 Ouvrir le PDF</b> ou <b>📤 Partager</b>.",
   "Pour changer l'échéance : choisissez dans <b>📅 Échéance de paiement</b>, puis <b>Enregistrer</b>.",
   "Touchez <b>Contrat …</b> pour ouvrir le contrat."
  ],
  "notes": [
   "💡 « Aucune » échéance = jamais en retard.",
   "💡 Facture saisie avant DuoCore : pas de PDF."
  ],
  "voir": [
   "com-relance"
  ]
 },
 {
  "id": "com-relance",
  "rub": "commercial",
  "titre": "Noter une relance client",
  "droits": [
   "commercial",
   "direction"
  ],
  "qui": "Qui : droit Commercial, Walid et le DG.",
  "mots": "relance relancer client impaye appel visite courrier email whatsapp compte rendu",
  "intro": "Gardez la trace des relances d'une facture impayée.",
  "etapes": [
   "Ouvrez la facture.",
   "Touchez <b>📞 Noter une relance</b>.",
   "Choisissez le <b>Mode</b> (Appel, Visite, Courrier, E-mail, WhatsApp).",
   "Écrivez le <b>Compte rendu</b>.",
   "Vérifiez la <b>Prochaine relance</b> (dans 7 jours), puis <b>Enregistrer</b>."
  ],
  "notes": []
 },
 {
  "id": "com-retards",
  "rub": "commercial",
  "titre": "Suivre les factures en retard",
  "droits": [
   "commercial",
   "direction",
   "comptable"
  ],
  "qui": "Qui : droit Commercial, Walid, le DG et le comptable.",
  "mots": "retard factures en retard impayes echeance depassee recouvrement",
  "intro": "Le chiffre « ⏰ » sur la tuile compte les factures en retard.",
  "etapes": [
   "Touchez <b>🤝 Commercial</b>, onglet <b>Factures</b>.",
   "Choisissez le filtre <b>⏰ En retard</b>.",
   "Touchez une facture pour relancer ou noter l'encaissement."
  ],
  "notes": [
   "💡 Elles sont aussi dans 🔔 « Factures en retard »."
  ],
  "voir": [
   "com-relance",
   "com-encaissement"
  ]
 },
 {
  "id": "com-regime-client",
  "rub": "commercial",
  "titre": "Changer le régime d'un client",
  "droits": [
   "commercial",
   "direction"
  ],
  "qui": "Qui : droit Commercial, Walid et le DG.",
  "mots": "regime client changer tva administration prive exonere",
  "intro": "Le régime du client s'applique à ses prochaines factures.",
  "etapes": [
   "Onglet <b>Clients</b>, touchez le client.",
   "Choisissez le nouveau <b>Régime des factures</b>.",
   "Confirmez."
  ],
  "notes": [
   "💡 Les factures déjà émises ne changent pas."
  ]
 },
 {
  "id": "rep-evenements",
  "rub": "repartition",
  "titre": "Créer et clôturer un événement de recouvrement",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG et WALID. Réseau obligatoire.",
  "mots": "repartition evenement recouvrement grouper reglements cloturer rouvrir degrouper",
  "intro": "Un événement regroupe des règlements reçus pour calculer les parts de chacun.",
  "etapes": [
   "Touchez la tuile <b>📊 Répartition</b>, onglet <b>📅 Événements</b>.",
   "Touchez <b>➕ Nouvel événement</b>.",
   "Cochez au moins deux règlements, puis <b>✅ Créer l'événement</b>.",
   "Touchez un événement pour voir le dû et le versé par bénéficiaire.",
   "Quand tout est réglé, touchez <b>🔒 Clôturer l'événement</b>."
  ],
  "notes": [
   "💡 <b>↩️ Rouvrir</b> et <b>✂️ Dégrouper</b> défont une erreur.",
   "💡 Après une modification, touchez <b>🔄 Recalculer</b>."
  ],
  "img": "rep-evenements",
  "voir": [
   "rep-rattacher",
   "rep-payer"
  ]
 },
 {
  "id": "rep-rattacher",
  "rub": "repartition",
  "titre": "Rattacher un versement à un événement",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG et WALID.",
  "mots": "rattacher versement sans evenement lier hors contrat",
  "intro": "Un versement sans événement apparaît dans la carte « ⚠️ versement(s) sans événement ».",
  "etapes": [
   "Onglet <b>📅 Événements</b>, trouvez le versement.",
   "Touchez <b>🔗</b>.",
   "Choisissez l'<b>Événement</b> (ou « Hors contrat ») et le <b>Type</b>.",
   "Touchez <b>✅ Enregistrer</b>."
  ],
  "notes": []
 },
 {
  "id": "rep-factures",
  "rub": "repartition",
  "titre": "Voir le calcul d'une facture (cascade)",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG et WALID.",
  "mots": "factures cascade calcul ht marge benefice reserve previsionnel",
  "intro": "Chaque facture montre le calcul du montant jusqu'au bénéfice libre.",
  "etapes": [
   "Onglet <b>🧾 Factures</b>.",
   "Choisissez une facture réglée ou prévisionnelle.",
   "Lisez la cascade : Montant, HT, … jusqu'au Bénéfice libre.",
   "Touchez ✕ pour fermer."
  ],
  "notes": [
   "💡 L'onglet <b>⚖️ Balances</b> montre l'amortissement du stock et les réserves (lecture seule)."
  ]
 },
 {
  "id": "rep-payer",
  "rub": "repartition",
  "titre": "Payer une commission",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG et WALID.",
  "mots": "commission payer beneficiaire demarcheur emna tresor attribution versement",
  "intro": "Le paiement d'une commission passe par une demande Finances préparée ici.",
  "etapes": [
   "Onglet <b>💼 Commissions</b>, touchez le bénéficiaire.",
   "Dans <b>💸 Payer</b>, choisissez l'<b>Événement</b> et tapez le <b>Montant</b>.",
   "Choisissez <b>Payé par</b> (virement, chèque ou caisse) et la <b>Société</b>.",
   "Touchez <b>💸 Préparer la demande Finances</b>, vérifiez puis envoyez.",
   "Une fois exécuté, le versement est rattaché tout seul à l'événement."
  ],
  "notes": [
   "⚠️ Ouvrez 💰 Finances au moins une fois avant."
  ],
  "voir": [
   "fin-cloturer"
  ]
 },
 {
  "id": "rep-parametres",
  "rub": "repartition",
  "titre": "Régler les paramètres de répartition",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG et WALID.",
  "mots": "parametres taux demarchage fiscal emna plafond stock fdr charges ao",
  "intro": "Les taux se règlent par contrat et par facture. Une case vide reprend la valeur du dessus.",
  "etapes": [
   "Onglet <b>⚙️ Paramètres</b>.",
   "Changez un paramètre général, puis touchez 💾.",
   "Dans l'arbre « Contrats et factures », changez les taux d'une ligne.",
   "Touchez <b>💾 Enregistrer la ligne</b>. Le recalcul prend environ 1 minute."
  ],
  "notes": []
 },
 {
  "id": "mi-consulter",
  "rub": "missions",
  "titre": "Voir ses missions et le calendrier",
  "droits": [
   "agent"
  ],
  "qui": "Qui : tout agent connecté.",
  "mots": "missions taches travail a faire calendrier echeance retard mes missions",
  "intro": "Les missions sont les tâches confiées à l'équipe, avec une échéance.",
  "etapes": [
   "Touchez la tuile <b>🎯 Missions</b>.",
   "Onglet <b>Mes missions</b> : ce qui vous est confié. <b>Confiées</b> : ce que vous avez donné.",
   "Regardez le calendrier : vert = à venir, orange = priorité haute, rouge = en retard.",
   "Touchez <b>🗓️ Vue mois</b> pour changer de vue.",
   "Touchez une mission pour l'ouvrir."
  ],
  "notes": [
   "💡 Le chiffre de la tuile compte vos missions du jour ou en retard.",
   "💡 DG et WALID : l'onglet <b>Équipe</b> montre la charge de chaque agent (attente, en cours, à clôturer, retard)."
  ],
  "img": "mi-consulter",
  "voir": [
   "mi-avancer",
   "mi-creer"
  ]
 },
 {
  "id": "mi-creer",
  "rub": "missions",
  "titre": "Créer une mission",
  "droits": [
   "agent"
  ],
  "qui": "Qui : tout agent connecté.",
  "mots": "creer mission nouvelle tache confier assigner echeance priorite recurrence etapes",
  "intro": "Confiez une tâche à une ou plusieurs personnes. Elles sont notifiées.",
  "etapes": [
   "Touchez <b>🎯 Missions</b> puis <b>➕ Nouvelle mission</b>.",
   "Écrivez le <b>Titre</b> et la <b>Description</b>.",
   "Cochez les personnes dans <b>Assignée à</b>.",
   "Choisissez l'<b>Échéance</b>, la <b>Priorité</b> et la <b>Récurrence</b> si besoin.",
   "Ajoutez des étapes : tapez dans <b>Nouvelle étape</b>, puis ➕.",
   "Touchez <b>📤 Créer et notifier</b>."
  ],
  "notes": [
   "💡 Une mission récurrente se recrée toute seule après la clôture."
  ],
  "voir": [
   "mi-modifier"
  ]
 },
 {
  "id": "mi-avancer",
  "rub": "missions",
  "titre": "Avancer une mission et la signaler terminée",
  "droits": [
   "agent"
  ],
  "qui": "Qui : les personnes assignées.",
  "mots": "avancer mission commencer en cours cocher etape commentaire terminee signaler fini",
  "intro": "Indiquez que vous commencez, cochez les étapes, puis signalez la fin.",
  "etapes": [
   "Ouvrez la mission.",
   "Touchez <b>▶ Je commence (en cours)</b>.",
   "Cochez les étapes faites.",
   "Ajoutez un commentaire si besoin, puis <b>💬 Ajouter le commentaire</b>.",
   "À la fin, touchez <b>✅ Signaler terminée (à clôturer)</b>.",
   "Le DG ou WALID clôture ensuite la mission."
  ],
  "notes": [
   "💡 Depuis 🔔, <b>✅ Fait</b> signale aussi la mission terminée."
  ],
  "img": "mi-avancer",
  "voir": [
   "mi-cloturer",
   "nt-agir"
  ]
 },
 {
  "id": "mi-cloturer",
  "rub": "missions",
  "titre": "Clôturer, renvoyer ou annuler une mission",
  "droits": [
   "dirNom"
  ],
  "qui": "Qui : le DG et WALID.",
  "mots": "cloturer mission terminee valider renvoyer pas terminee annuler",
  "intro": "Une mission signalée terminée attend votre clôture (onglet « À clôturer »).",
  "etapes": [
   "Onglet <b>À clôturer</b>, ouvrez la mission.",
   "Vérifiez les étapes et les commentaires.",
   "Touchez <b>🏁 Clôturer : terminée</b>.",
   "Pas terminée ? Écrivez un commentaire, puis <b>↩️ Retour (pas terminée)</b>.",
   "Pour l'abandonner : écrivez la raison, puis <b>⛔ Annuler</b>."
  ],
  "notes": [
   "💡 Le DG peut aussi clôturer depuis 🔔 avec <b>✅ Valider (clôturer)</b>. WALID clôture depuis la fiche de la mission."
  ]
 },
 {
  "id": "mi-modifier",
  "rub": "missions",
  "titre": "Modifier une mission",
  "droits": [
   "agent"
  ],
  "qui": "Qui : le créateur de la mission, le DG ou WALID.",
  "mots": "modifier mission changer echeance titre personnes",
  "intro": "Changez l'échéance, les personnes ou les étapes d'une mission.",
  "etapes": [
   "Ouvrez la mission.",
   "Touchez <b>✏️ Modifier</b>.",
   "Changez ce qu'il faut.",
   "Écrivez la raison du changement, puis <b>Enregistrer</b>."
  ],
  "notes": []
 },
 {
  "id": "nt-a-resoudre",
  "rub": "notifs",
  "titre": "Voir ce qui reste à résoudre (🔔)",
  "droits": [
   "agent"
  ],
  "qui": "Qui : tout agent connecté.",
  "mots": "notifications cloche a resoudre en attente a faire taches alertes badge",
  "intro": "La cloche 🔔 rassemble tout ce qui attend une action, rubrique par rubrique.",
  "etapes": [
   "Touchez <b>🔔</b> en haut de l'écran.",
   "Onglet <b>À résoudre</b> : <b>👉</b> marque ce qui attend votre action.",
   "Touchez un groupe (💰 Finances, 👥 RH, 📦 Magasins, 🎯 Missions, 🤝 Commercial) pour l'ouvrir.",
   "Touchez une ligne pour ouvrir l'opération."
  ],
  "notes": [
   "💡 Une ligne disparaît quand l'opération est close."
  ],
  "img": "nt-a-resoudre",
  "voir": [
   "nt-agir",
   "nt-recues"
  ]
 },
 {
  "id": "nt-agir",
  "rub": "notifs",
  "titre": "Répondre depuis 🔔 (Fait, Confirmé, Vu)",
  "droits": [
   "agent"
  ],
  "qui": "Qui : tout agent connecté.",
  "mots": "fait confirme vu cacher alerte mission voyage conge valider cloturer",
  "intro": "Certaines alertes se traitent sans ouvrir l'opération.",
  "etapes": [
   "Mission : <b>✅ Fait</b> la signale terminée (le DG valide ensuite).",
   "Mission : <b>👍 Vu</b> cache l'alerte pour la journée, sur ce téléphone.",
   "Mission à clôturer (DG) : <b>✅ Valider (clôturer)</b>.",
   "Voyage ou congé : <b>✅ Confirmé</b> la cache pour tout le monde (elle revient si la date change).",
   "Voyage ou congé : <b>👍 Vu</b> la cache sur ce téléphone jusqu'à l'étape 7 jours."
  ],
  "notes": [
   "💡 WALID clôture une mission depuis sa fiche (🎯 Missions)."
  ],
  "img": "nt-agir",
  "voir": [
   "rh-alertes-voyage",
   "mi-avancer"
  ]
 },
 {
  "id": "nt-recues",
  "rub": "notifs",
  "titre": "Relire les notifications reçues",
  "droits": [
   "agent"
  ],
  "qui": "Qui : tout agent connecté.",
  "mots": "notifications recues historique lues non lues relire anciennes",
  "intro": "Les notifications des 30 derniers jours sont gardées sur le téléphone.",
  "etapes": [
   "Touchez <b>🔔</b>, onglet <b>Reçues</b>.",
   "● = non lue. Touchez une notification pour ouvrir l'opération.",
   "Touchez <b>✓ Tout marquer comme lu</b> pour tout effacer des non lues."
  ],
  "notes": [
   "💡 Toucher une notification du téléphone ouvre directement l'écran concerné. Titre avec ⏳ : attendez la synchronisation."
  ]
 }
];
