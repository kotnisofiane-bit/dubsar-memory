# ADR — Pilote Workbench web local éphémère

Statut : accepté pour un pilote local non publié
Date : 2026-08-10

## Décision

Le premier conteneur visuel du DUBSAR Workbench sera un serveur HTTP Node.js en avant-plan, lié exclusivement à `127.0.0.1` sur un port choisi par le système.

Ce lot ne crée pas un frontend métier. La CLI inspecte le workspace et rend une seule fois le rapport HTML autonome existant avant l'ouverture du port. Le serveur reçoit uniquement une copie bornée de ces octets et les transporte sur une route de session imprévisible. Il ne connaît ni le workspace, ni ses chemins, ni les formats projet/audit.

Cette décision fait passer le web local de « candidat après mesures » à « pilote réversible ». Elle ne sélectionne pas un conteneur de distribution définitif et n'autorise ni publication, ni déploiement, ni mutation.

## Pourquoi maintenant

Le noyau read-only, la CLI et le renderer statique sont déjà disponibles et vérifiés. Un transport loopback minimal permet de tester l'intérêt d'une vraie surface visuelle commune à Codex, Claude et Cursor sans réintroduire Tauri, le Core historique, le Backend ou une logique métier frontend.

## Frontière retenue

```text
workspace
   -> snapshot borné unique
   -> dubsar.workbench-view/1
   -> HTML autonome borné
   -> Buffer immuable
   -> 127.0.0.1:0 / route-capacité GET unique
   -> navigateur
```

- Une seule route HTML; aucune API, asset, JavaScript, health route ou mutation.
- Aucun fichier temporaire et aucun lancement automatique du navigateur.
- Jeton aléatoire 256 bits par processus, durée absolue de 30 minutes, inactivité de 5 minutes.
- Admission stricte par Host, origine si présente et Fetch Metadata.
- Réponses et erreurs bornées, sans logs de requête ni données privées.
- Gate statique spécialisé : le listener loopback entrant n'élargit pas les capacités réseau du core, du renderer ou des autres commandes CLI.

Le jeton d'URL peut apparaître dans l'historique du navigateur. Ce risque est accepté pour ce pilote local et réduit par le caractère éphémère, `no-store`, `no-referrer`, l'absence de lancement automatique et l'invalidation à l'arrêt. Ce mécanisme protège contre une page web distante et les accès accidentels; il ne prétend pas isoler un processus malveillant exécuté sous le même compte OS.

## Alternatives écartées

- `file://` temporaire : plus simple côté réseau, mais ajoute une écriture, un artefact à nettoyer, des différences navigateur et généralement un subprocess pour l'ouverture.
- Tauri ou WebView natif : packaging, signatures, IPC et maintenance disproportionnés pour prouver la valeur de la vue.
- Extension IDE : ne fournit pas une surface commune aux différents hôtes.
- Frontend JavaScript avec API JSON : duplique la frontière de validation et agrandit inutilement les surfaces XSS, CORS et de divergence.
- Serveur « burn-on-load » : réduit la réutilisation du jeton, mais rend rafraîchissement et diagnostic fragiles; les deux TTL bornés gardent le pilote compréhensible.

## Conditions de réexamen

La décision est réexaminée si le pilote ne réduit pas le temps de reprise ou les erreurs par rapport à la CLI, si un besoin de protection contre le même utilisateur OS apparaît, ou si l'interface exige des mutations. Dans ces cas, arrêter le serveur ne laisse aucun état à migrer.

## Revue et réconciliation

Les revues architecture, sécurité et fiabilité ont d'abord rendu un NO-GO conditionnel, dû au contrat trop large et non mesurable. Le contrat approuvé ferme leurs objections : transport-only, route unique, valeurs de timeout et de capacité, durée absolue, arrêt forcé, gate réseau séparé et tests adversariaux.

Gemini 3.6 Flash a proposé `file://`, un serveur à consommation unique et la suppression du gate AST. Cette première décision conservait un serveur foreground réutilisable pour la CLI. Elle est partiellement supersédée le 2026-08-10 pour le launcher multi-projet : celui-ci réutilise désormais une API séparée, à consommation unique, qui ferme le listener après la remise des octets à Chrome. Le serveur foreground existant et le gate AST restent inchangés; `file://` demeure un fallback explicite.
