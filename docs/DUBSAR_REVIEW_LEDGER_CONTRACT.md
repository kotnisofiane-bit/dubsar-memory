# DUBSAR Review Ledger — contrat consultatif read-only

**Statut :** contrat documentaire v1 du lot `lot-review-ledger-contract-v1` ;
comportement runtime non implémenté par ce lot.

**Date :** 2026-08-10

**Autorité :** `local_preparation_record`. Ce document prépare une
implémentation locale ; il ne constitue ni une approbation, ni une preuve de
release, ni un résultat d'audit, ni une certification.

## Décision

Le Review Ledger sera une projection consultative séparée du read model
canonique. Il lira, à la demande uniquement, les reçus immuables
`dubsar.review-receipt/1`, puis produira un objet compagnon fermé :
`dubsar.review-ledger-view/1`.

Le chemin reste unidirectionnel :

```text
octets canoniques capturés ──> dubsar.workbench-view/1 ──> vérité locale affichée
              │
              └── appel explicite ──> reçus validés ──> dubsar.review-ledger-view/1
                                                        │
                                                        └── consultatif seulement
```

Le Ledger n'est jamais une deuxième vérité. Une objection présente seulement
dans un reçu ne modifie jamais `integrity`, `readiness`, les blockers, la
prochaine action, les octets du read model canonique ou son code de sortie. Une
promotion humaine explicite dans les JSON canoniques reste le seul moyen de
rendre une conclusion bloquante.

## Invariants non négociables

1. `dubsar.workbench-view/1`, `dubsar.workspace-snapshot/1` et les JSON
   canoniques ne changent pas pour porter le Ledger.
2. Les reçus et leurs recorders restent inchangés. Le Ledger n'écrit aucun reçu
   et n'importe pas les recorders comme runtime.
3. Le snapshot canonique est produit avant toute lecture de `reviews/**`. Une
   panne du Ledger ne peut donc pas empêcher ou réévaluer le résultat canonique
   déjà produit.
4. `canonical_digest_match` signifie exclusivement l'égalité de deux digests
   SHA-256 de racines canoniques calculées sur les octets bruts. Il ne signifie
   jamais authenticité, approbation, validité sémantique, indépendance du
   reviewer ou couverture des artefacts.
5. Le rôle et l'isolation sont toujours étiquetés `declared_role` et
   `declared_isolation`. Aucune attestation n'est inférée.
6. Une réconciliation conserve les reçus originaux et leur objection. Elle ne
   s'appelle jamais « résolution » et ne masque aucune entrée.
7. Le Core réduit et assainit les champs avant toute sortie JSON, terminal ou
   HTML. Les renderers appliquent ensuite un échappement de défense en
   profondeur, sans recalculer de verdict.
8. Aucun chemin absolu, lien actif, contenu brut de reçu, secret, donnée
   personnelle détectée, prompt, transcript ou sortie de provider n'est
   retourné.
9. Aucun accès réseau, modèle, reviewer, mémoire personnelle, preuve référencée
   ou backend n'est déclenché par la consultation.
10. Les états fermés sont `available`, `degraded` et `unavailable`. Ils restent
    consultatifs et ne changent aucun code de sortie canonique.

## Parcours opérateur retenu

Le parcours futur est explicite et réversible :

```text
dubsar reviews [--json] [--start <path>] [--domain project|audit]
dubsar report --reviews [--json] [--start <path>] [--domain project|audit]
dubsar ui --reviews [--json] [--start <path>] [--domain project|audit]
```

- `reviews` produit uniquement le compagnon consultatif, après une inspection
  canonique réussie.
- `report --reviews` compose le read model canonique et le compagnon dans un
  nouveau rapport explicitement identifié.
- `ui --reviews` transporte exactement ce rapport déjà rendu dans le serveur
  loopback existant ; le serveur ne relit rien et ne change pas.
- Sans `--reviews`, `report` et `ui` restent byte-compatibles avec leur
  comportement actuel.
- `locate`, `status`, `resume`, `validate` et `doctor` n'énumèrent jamais
  `reviews/**`.

L'absence du dossier `reviews` est une situation normale : elle produit un
Ledger `available`, vide, avec un digest d'ensemble valide et des compteurs à
zéro.

## Les quatre identités à ne pas confondre

| Champ | Porte sur | Usage | N'implique pas |
|---|---|---|---|
| `canonical_root_sha256` | Octets des fichiers JSON canoniques requis | Fraîcheur d'un reçu | Artefacts complets, validité métier |
| `snapshot_sha256` | Snapshot Workbench complet ; pour l'audit, inclut les artefacts capturés | Identité de la vue canonique affichée | Fraîcheur d'un reçu |
| `receipt_set_sha256` | Octets bruts du sous-ensemble de reçus capturés et validés | Identité de l'ensemble consultatif disponible | Authenticité des auteurs ou exhaustivité si l'état est `unavailable` |
| `projection_sha256` | Tous les champs visibles assainis du compagnon, hors sa propre valeur | Identité de la projection consultative | Identité des octets bruts ou approbation |

Pour un projet, les deux premières valeurs peuvent coïncider aujourd'hui parce
que son snapshot ne contient que les fichiers canoniques. Leurs significations
restent néanmoins distinctes. Pour un audit, un changement d'artefact peut
modifier `snapshot_sha256` sans modifier `canonical_root_sha256`; la fraîcheur
des reçus reste alors inchangée.

Le propriétaire unique de ces identités reste la capture Workbench :
`snapshotWorkspace` dans `packages/dubsar-operator-core/src/snapshot.mjs`, avec
la primitive héritée `rootDigest(entries)` de
`packages/dubsar-operator-core/src/contracts.mjs`. Le lot Core étendra le
résultat interne de cette capture — pas `dubsar.workspace-snapshot/1` — pour
calculer une seule fois :

- `canonical_root_sha256 = rootDigest(canonical_entries)` ;
- `snapshot_sha256 = rootDigest(all_snapshot_entries)`, comme aujourd'hui.

Le module Ledger reçoit exactement deux paramètres internes : le locator opaque
`workspaceRoot`, déjà possédé par le caller et jamais sérialisé, puis un objet
gelé aux quatre clés `domain`, `context_id`, `canonical_root_sha256` et
`snapshot_sha256`. Il ne reçoit ni octets ni entrées canoniques. Celui-ci ne
relit pas les JSON canoniques, ne recompose pas une racine et n'importe aucune
fonction de recorder. Il lit uniquement les reçus du Ledger et compare leurs
racines déclarées à la valeur canonique reçue ; il n'est pas un second
vérificateur de la capture canonique. L'algorithme hérité n'est ni renommé ni
normalisé. Des fixtures projet et audit doivent prouver que la racine canonique
produite sur les noms canoniques fermés est byte-identique aux racines émises
par les deux recorders v1 ; un écart arrête l'implémentation au lieu de migrer ou
de réinterpréter les anciens reçus.

## Format compagnon fermé

### Objet racine

`dubsar.review-ledger-view/1` possède exactement ces clés :

| Clé | Type | Règle |
|---|---|---|
| `format` | string | Valeur exacte `dubsar.review-ledger-view/1` |
| `authority` | string | Valeur exacte `local_preparation_record` |
| `producer` | object | Identité locale bornée du producteur |
| `source` | object | Domaine et identités canoniques |
| `ledger` | object | Disponibilité, ensemble et diagnostics |
| `reviews` | array | Projections assainies des reçus valides |
| `privacy` | object | Compteurs de réduction |
| `projection_sha256` | string | 64 hex minuscules ; exclu de sa propre préimage |

Les clés inconnues sont refusées. Aucune extension silencieuse n'est permise ;
une évolution exige un nouveau format.

### `producer`

Clés exactes : `name`, `version`. Les deux sont des strings ASCII non vides,
respectivement limitées à 128 et 64 octets UTF-8. Elles identifient le
producteur local, pas une provenance de release.

### `source`

| Clé | Type | Règle |
|---|---|---|
| `domain` | string | `project` ou `audit` |
| `id` | string ou null | ID public sûr ; null si réduction nécessaire |
| `canonical_root_sha256` | string | 64 hex minuscules, racine canonique capturée |
| `snapshot_sha256` | string | 64 hex minuscules, snapshot complet déjà produit |

Un ID public brut doit respecter
`^[a-z0-9][a-z0-9._-]{2,127}$` et les règles de réduction sensible. Sinon il est
remplacé par `null` ; aucune table de correspondance n'est persistée.

### `ledger`

Clés exactes : `status`, `receipt_set_sha256`, `discovered_count`,
`valid_count`, `omitted_count`, `diagnostics`.

- `status` vaut `available`, `degraded` ou `unavailable`.
- `receipt_set_sha256` est un digest 64 hex pour `available` et `degraded`, et
  `null` pour `unavailable`.
- Les trois compteurs sont des entiers sûrs positifs ou nuls quand
  l'énumération est complète. Ils valent tous `null` quand elle ne l'est pas.
- `discovered_count` compte les fichiers candidats dont la présence et les
  métadonnées ont été capturées, y compris invalides ou oversized ;
  `valid_count` compte les reçus projetés ; `omitted_count` vaut exactement
  `discovered_count - valid_count`. L'invariant s'applique à `available` et
  `degraded`.
- `diagnostics` est trié par `code`, sans doublon. Chaque objet possède
  exactement `code` et `severity`.

Codes fermés et sévérités :

| Code | Sévérité | État minimal |
|---|---|---|
| `REVIEW_ENTRY_INVALID` | `warning` | `degraded` |
| `REVIEW_ENTRY_TOO_LARGE` | `warning` | `degraded` |
| `REVIEW_ENTRY_JSON_LIMIT_EXCEEDED` | `warning` | `degraded` |
| `REVIEW_PATH_UNSAFE` | `error` | `unavailable` |
| `REVIEW_STRUCTURE_UNSAFE` | `error` | `unavailable` |
| `REVIEW_PLATFORM_IDENTITY_UNAVAILABLE` | `error` | `unavailable` |
| `REVIEW_DISCOVERY_LIMIT_EXCEEDED` | `error` | `unavailable` |
| `REVIEW_LEDGER_SIZE_LIMIT_EXCEEDED` | `error` | `unavailable` |
| `REVIEW_CAPTURE_RACE` | `error` | `unavailable` |
| `REVIEW_TIME_LIMIT_EXCEEDED` | `error` | `unavailable` |
| `REVIEW_MEMORY_LIMIT_EXCEEDED` | `error` | `unavailable` |
| `REVIEW_PROJECTION_LIMIT_EXCEEDED` | `error` | `unavailable` |

Un diagnostic ne contient ni chemin, ni texte source, ni exception brute. Le
nombre d'occurrences omises est porté par `omitted_count`.

### Une entrée de `reviews`

Chaque objet possède exactement :

```text
decision_id
receipt_id
receipt_type
declared_role
declared_isolation
advisory
input_canonical_root_sha256
resulting_canonical_root_sha256
input_canonical_digest_match
resulting_canonical_digest_match
findings
alternatives
limitations
reviewed_receipts
```

Règles :

- `decision_id`, `receipt_id` et `finding_id` sont soit les IDs ASCII validés,
  soit des labels de réduction déterministes (`~d000001`, `~r000001`,
  `~f000001`)
  si leur affichage révèle une forme sensible. Le préfixe `~` est interdit par
  la grammaire des IDs bruts : le namespace réduit ne peut donc pas collisionner
  avec une valeur source. Les références de réconciliation utilisent les mêmes
  labels réduits.
- `receipt_type` vaut `domain-review`, `challenge` ou `reconciliation`.
- `declared_role` et `declared_isolation` reprennent les enums validés du reçu,
  sans attestation.
- `advisory` vaut toujours `true`.
- Les deux racines sont des digests ; `resulting_canonical_root_sha256` est null
  hors réconciliation.
- `input_canonical_digest_match` est un booléen d'égalité brute.
- `resulting_canonical_digest_match` est null hors réconciliation, sinon un
  booléen distinct.
- `findings`, `alternatives`, `limitations` et `reviewed_receipts` préservent
  leur ordre source après validation et réduction.
- Les tuples bruts `(decision_id, receipt_id)` sont uniques. Les entrées sont
  triées par ces deux champs selon leurs octets ASCII avant réduction ;
  l'unicité interdit tout tie-breaker implicite.

Chaque finding possède exactement `finding_id`, `severity`, `summary` et
`evidence_refs`, avec un `finding_id` unique dans son reçu. Les références
restent du texte réduit, ne deviennent jamais des liens et ne sont jamais
déréférencées.

### `privacy`

Clés exactes : `redacted_fields`, `truncated_fields`, `omitted_fields`. Ce sont
des entiers sûrs positifs ou nuls. Ils décrivent seulement les transformations
de la projection ; ils ne prouvent pas que les sources sont exemptes de secrets
ou de données personnelles.

Les labels de réduction ne constituent ni anonymisation, ni pseudonymisation
cryptographique, ni garantie d'intraçabilité. Ils minimisent seulement
l'affichage dans cette projection locale. Leur déterminisme sert la
reproductibilité du digest ; une personne ayant accès aux reçus bruts peut
retrouver les IDs sources.

## Validation des reçus existants

Le Core futur réimplémente une validation de lecture compatible avec les deux
recorders v1, sans les importer et sans les modifier. Une entrée valide doit
notamment respecter :

- des octets UTF-8 valides sans BOM, aucun nom de membre JSON dupliqué et aucune
  surrogate Unicode non appariée ; ces contrôles précèdent la conversion en
  objet JavaScript afin d'éviter les sémantiques « last key wins » ;
- les quinze clés exactes de `dubsar.review-receipt/1` ;
- `context_kind` égal à `project-mission` ou `audit-case` selon le domaine, et
  `context_id` égal à l'ID canonique courant ;
- les IDs ASCII `^[a-z0-9][a-z0-9._-]{2,63}$` ;
- les enums de type, rôle, isolation et sévérité existants ;
- `advisory: true`, digests 64 hex et tableaux bornés à 50 éléments ;
- les combinaisons rôle/isolation propres aux challenges, domain reviews et
  réconciliations ;
- l'égalité byte-for-byte entre le dossier `<decision_id>` et le
  `decision_id` interne, puis entre le stem `<receipt_id>` et le `receipt_id`
  interne ; aucun case fold, normalisation Unicode ou alias de plateforme ;
- l'unicité du tuple `(decision_id, receipt_id)` et des `finding_id` dans un
  reçu ;
- pour une réconciliation, chaque `reviewed_receipts` résout exactement un reçu
  original non-réconciliation du même `decision_id` et du même
  `input_root_sha256` ;
- l'absence de clé supplémentaire, référence absolue, traversée, URL dans une
  référence de preuve ou motif de credential déjà refusé par les recorders.

Une incompatibilité de contrat rend seulement cette entrée invalide et le
Ledger `degraded`, si l'ensemble des fichiers a tout de même été énuméré et
capturé de façon sûre. Elle ne rend pas le workspace canonique invalide.

## Découverte et checkpoint de capture

Le parcours futur est strictement local et borné :

1. Recevoir `workspaceRoot` et l'objet gelé à quatre clés défini ci-dessus ;
   aucune entrée canonique n'est transmise au Ledger.
2. Valider le type et la présence de ces identités, puis les utiliser telles
   quelles ; le Ledger ne dérive et ne recompose aucune racine canonique.
3. Examiner seulement `reviews/<decision_id>/<receipt_id>.json`, profondeur
   exacte de deux niveaux sous `reviews`.
4. Prouver que la racine, ses ancêtres, les dossiers de décision et les fichiers
   sont internes, non liés, non reparse-like et non aliasés physiquement. Un
   hardlink ou une identité physique dupliquée est refusé. Si la plateforme ne
   permet pas la preuve requise, l'état est `unavailable`.
5. Exiger que chaque segment de chemin round-trip byte-for-byte sur la
   plateforme. Un nom réservé, tronqué, normalisé, case-collisionné ou autrement
   ambigu rend la structure `unavailable`.
6. Énumérer en streaming, profondeur par profondeur, sans matérialiser l'arbre.
   Compter et charger au plus `limite + 1` entrées, vérifier le timeout et le
   budget mémoire à chaque entrée, puis arrêter immédiatement sur le premier
   dépassement. La mémoire d'énumération reste `O(limite)`. EOF n'est requis
   pour prouver la complétude que si aucun plafond n'a été dépassé. Un niveau,
   type ou nom inattendu rend la structure `unavailable`; aucun parcours
   récursif n'est permis.
7. Capturer les métadonnées bornées de tous les candidats admissibles avant de
   choisir un sous-ensemble. Un fichier individuel au-dessus de 262144 octets
   est compté puis omis. Sa taille déclarée ne consomme pas le budget d'octets
   bruts agrégés puisqu'il n'est jamais lu ; seules ses métadonnées bornées
   consomment les budgets d'énumération et de mémoire. Une limite globale portant
   sur les candidats retenus annule tout le set.
8. Ouvrir chaque candidat retenu en lecture seule par handle stable.
9. Vérifier identité, taille et marqueur de modification avant et après lecture.
   Toute course annule tout le Ledger et produit `unavailable`.
10. Hasher les octets bruts capturés, parser et valider les objets, puis réduire
   les champs en mémoire.
11. Revalider le checkpoint de répertoire avant publication. Une mutation annule
   les données partielles.
12. Calculer séparément le digest du sous-ensemble validé et celui de la
    projection assainie.

Le dossier `reviews` manquant équivaut à une énumération complète de zéro
fichier. Un fichier régulier individuel malformé ou trop grand peut être omis
avec un état `degraded` si sa présence, son identité et la complétude de
l'ensemble sont prouvées. Une limite globale, une structure ambiguë ou une
course produit `unavailable`, sans sous-ensemble partiel.

## Limites numériques v1

| Limite | Valeur | Dépassement |
|---|---:|---|
| Profondeur sous `reviews` | exactement 2 | `unavailable` |
| Dossiers de décision | 64 | `unavailable` |
| Fichiers candidats | 256 | `unavailable` |
| Octets par reçu | 262144 | entrée omise, `degraded` |
| Octets bruts agrégés des candidats retenus | 8388608 | `unavailable` |
| Profondeur JSON par reçu | 16 | entrée omise, `degraded` |
| Nœuds JSON par reçu | 4096 | entrée omise, `degraded` |
| Nœuds JSON agrégés | 65536 | `unavailable` |
| Éléments d'un tableau de reçu | 50 | entrée invalide, `degraded` |
| Octets UTF-8 d'un champ affiché | 8192 | troncature sûre |
| Octets UTF-8 de la projection | 524288 | enveloppe `unavailable` bornée |
| Temps monotone acquisition + projection | 5000 ms | `unavailable` |
| Budget mémoire logique comptabilisé | 16777216 octets | `unavailable` |

Le budget mémoire logique est vérifié comme un **pic par phase**, avant chaque
allocation contrôlée. Sa base persistante additionne `128 × dossiers de
décision énumérés`, `256 × métadonnées de fichiers candidats`, les octets de la
projection déjà retenue, les records de préimage et `192 ×` chaque entrée des
indexes de tri, d'unicité, de réduction d'ID et de lignée, plus les octets UTF-8
des clés et labels de ces indexes. Pour le reçu courant, le pic ajoute le Buffer
brut, `2 × raw_byte_length` pour la string source UTF-16, encore
`2 × raw_byte_length` pour les strings du parse tree, `96 ×` le plafond de
nœuds JSON, puis les temporaires de réduction et de framing. Ces réservations
conservatrices couvrent ASCII, scalars astrals et escapes JSON avant décodage.

Les reçus sont traités séquentiellement. Buffer brut, string source, parse tree
et temporaires du reçu sont libérés avant le suivant ; seuls projection réduite,
digests et indexes bornés persistent. La charge estimée de la phase suivante est
refusée avant lecture ou allocation si son pic dépasserait 16777216 octets. Ce
modèle borne les représentations contrôlées et leurs coexistences ; il ne
prétend pas plafonner exactement le RSS ou les allocations internes non
observables du moteur JavaScript.

Le timeout utilise une horloge monotone et n'interrompt jamais le chemin
canonique déjà terminé. Les tests de performance devront nommer leur plateforme
et traiter une mesure indisponible comme limitation, pas comme preuve verte.

## États fermés

| Situation | État | Digest de set | Contenu |
|---|---|---|---|
| Dossier absent ou énumération complète, zéro entrée invalide | `available` | Digest du set, même vide | Toutes les entrées valides |
| Énumération complète et sûre, au moins une entrée individuelle invalide ou trop grande | `degraded` | Digest du sous-ensemble validé | Seulement les entrées valides + diagnostic borné |
| Complétude, sûreté, identité, course ou limite globale non prouvée | `unavailable` | `null` | Aucune entrée partielle |

Une projection `unavailable` reste un objet valide : elle porte les identités
canoniques déjà connues, des compteurs null, un diagnostic fermé, une liste
`reviews` vide, ses compteurs de confidentialité et son propre digest. Si même
cette enveloppe dépasse le budget, le caller retourne une erreur de programmation
ou de configuration ; il ne remplace jamais le résultat canonique.

## Préimages déterministes

Les vecteurs normatifs sont dans
`docs/DUBSAR_REVIEW_LEDGER_VECTORS.json`. Le fichier est UTF-8 sans BOM, LF,
avec newline finale. Tous les digests sont SHA-256 et hex minuscules.

### `receipt_set_sha256`

Préimage binaire :

```text
UTF8("dubsar.review-ledger-receipt-set/1") || 0x00
|| UTF8("<content_sha256>  <portable_path>\n")
|| ...
```

Les records validés sont triés par comparaison ordinale des octets ASCII de
`portable_path`. Le chemin est toujours
`reviews/<decision_id>/<receipt_id>.json`, avec `/`, sans préfixe absolu. Le
digest de contenu porte sur les octets exacts capturés. Le set vide contient
uniquement le domaine préfixé par NUL.

Les reçus invalides ne participent pas au set `degraded`. Pour
`unavailable`, aucune préimage de set n'est publiée, car la complétude n'est pas
établie.

### `projection_sha256`

Préimage binaire :

```text
UTF8("dubsar.review-ledger-projection/1") || 0x00
|| UTF8("<type>\t<schema_path>\t<byte_length>\t<value_utf8_hex>\n")
|| ...
```

Types fermés : `object`, `array`, `string`, `integer`, `boolean`, `null`.

- `object` et `null` ont une valeur vide et une longueur zéro.
- `array` porte son nombre d'éléments en décimal canonique.
- `integer` n'a ni signe `+`, ni zéro initial, sauf la valeur `0`.
- `boolean` porte `true` ou `false`.
- `string` porte ses octets UTF-8 exacts après réduction.
- Les indexes de tableau sont décimaux, zéro-based, sur six chiffres.
- Le chemin racine est `$`; les clés du schéma fermé suivent avec `/`.

L'ordre est celui des clés décrit dans ce document, en profondeur d'abord. Les
objets ne dépendent donc pas de l'ordre d'insertion d'un serializer. Les arrays
de diagnostics et de reviews sont déjà triés selon leurs règles ; les arrays
internes à un reçu préservent l'ordre validé. `$/projection_sha256` est l'unique
champ exclu. Après calcul, sa valeur doit être exactement le digest obtenu.

Aucun `JSON.stringify`, `ConvertTo-Json`, tri locale-aware, séparateur de
plateforme, timestamp ou chemin absolu n'entre dans ces préimages.

## Réconciliations et lignée

Une réconciliation est une entrée consultative supplémentaire :

- elle référence directement un ou plusieurs reçus originaux non
  `reconciliation` du même `decision_id` ;
- les reçus référencés ont le même `input_root_sha256` ;
- les originaux restent affichés dans leur ordre déterministe ;
- aucune traversée transitive, fermeture de graphe ou inférence chronologique
  n'est réalisée ;
- `input_canonical_digest_match` compare la racine historique d'entrée à la
  racine canonique courante ;
- `resulting_canonical_digest_match` compare séparément la racine résultante à
  la racine canonique courante.

Même le couple `false / true` signifie seulement « entrée historique différente,
résultat byte-identique au canon courant ». Il ne signifie ni que l'objection a
été comprise, ni qu'elle a été corrigée, ni que le changement est sûr.

## Réduction, confidentialité et rendu inerte

La réduction intervient dans le Core avant de construire la projection :

1. Valider d'abord IDs, enums, digests, types et tailles.
2. Transformer déterministement les IDs sensibles en labels ordinaux locaux et
   réécrire les références directes avec la même table éphémère.
3. Pour chaque champ libre, remplacer le champ entier par un token ASCII fermé
   si un motif couvert est détecté :
   `[REDACTED:CREDENTIAL_SHAPED]`, `[REDACTED:PERSONAL_DATA_SHAPED]`,
   `[REDACTED:PRIVATE_PATH]`, `[REDACTED:URI_LIKE]`,
   `[REDACTED:ACTIVE_CONTENT]` ou `[REDACTED:CONTROL_OR_BIDI]`.
4. Les classes couvertes incluent les motifs credential des recorders, les
   affectations de secrets, les formes évidentes d'email/téléphone/adresse
   réseau, les chemins absolus ou UNC, les schémas d'URI, les tags ou embeds
   HTML/Markdown, ESC/C0/C1/DEL, séparateurs de ligne et contrôles bidi.
5. Après réduction, tronquer à 8192 octets UTF-8 sur une frontière de scalar
   Unicode et ajouter le suffixe ASCII `[TRUNCATED]` dans le même budget.
6. Incrémenter exactement les compteurs `privacy` correspondants.

La classification v1 est fermée et s'applique dans cet ordre ; le premier match
remplace le champ entier :

1. `CONTROL_OR_BIDI` : tout scalar C0, C1 ou DEL, `U+2028`, `U+2029`,
   `U+061C`, `U+200E`, `U+200F`, `U+202A`–`U+202E` ou
   `U+2066`–`U+2069` ;
2. `CREDENTIAL_SHAPED` : les motifs déjà refusés par les recorders, une
   affectation des noms `password`, `secret`, `client_secret`, `api_key`,
   `access_token`, `refresh_token`, `session_token`, `private_key` ou
   `connection_string`, ou un token ASCII contigu de 24 caractères ou plus dans
   `[A-Za-z0-9_-]` ;
3. `PERSONAL_DATA_SHAPED` : présence de `@`, d'une adresse IPv4 en quatre
   groupes décimaux, ou d'au moins sept chiffres ASCII dans le champ après
   retrait des séparateurs ;
4. `URI_LIKE` : sous-chaîne ASCII
   `[A-Za-z][A-Za-z0-9+.-]{1,31}:` ;
5. `PRIVATE_PATH` : présence de `/` ou `\\`, y compris forme drive ou UNC ;
6. `ACTIVE_CONTENT` : présence de l'un des scalars `<`, `>`, `` ` ``, `[`,
   `]`, `(`, `)`, `!` ou `&`.

Les digests et enums validés ne passent pas dans ce classifieur. Un
`evidence_refs` classifié est supprimé de son array et incrémente
`omitted_fields`; les autres champs libres reçoivent le token fermé. Aucune
normalisation Unicode, décodage d'entité, interprétation Markdown ou
désobfuscation n'est tenté. Les patterns ci-dessus sont donc exactement la
couverture revendiquée, pas une preuve d'absence générale.

Ce filtrage est volontairement conservateur et son scope est fermé. Il ne peut
pas prouver l'absence générale d'un secret ou d'une donnée personnelle ; un test
regex vert ne doit jamais être formulé ainsi.

Cette politique privilégie la minimisation à la précision des commentaires :
une référence technique libre peut être remplacée ou omise. La projection reste
donc un index consultatif, pas un substitut aux reçus locaux. Un futur format
pourrait ajouter un locator relatif typé et strictement validé ; v1 ne déduit
jamais qu'un texte libre est sûr parce qu'il paraît technique.

La sortie JSON ne contient déjà que les champs réduits. Le terminal force une
ligne par valeur et n'interprète aucun contrôle. Le renderer HTML échappe chaque
valeur comme texte, ne crée ni lien, ni image, ni embed, ni attribut issu d'un
reçu. `evidence_refs` reste du texte et n'est jamais ouvert.

## Transport CLI et codes de sortie

### `reviews`

- Sortie humaine : résumé toujours étiqueté « Advisory Review Ledger », état,
  digests bornés, compteurs, puis entrées réduites.
- Sortie `--json` : un seul `dubsar.review-ledger-view/1` avec newline finale.
- Code `0` : inspection canonique réussie, y compris Ledger `available`,
  `degraded` ou `unavailable`.
- Code `1` : erreur canonique existante, arguments invalides ou faute interne de
  programmation/configuration empêchant même une enveloppe bornée.

Un reçu stale, invalide, absent, trop grand ou indisponible ne produit donc pas
un code canonique non nul.

### Rapport composite explicite

`report --reviews` utilise un nouveau manifeste
`dubsar.review-ledger-report/1`, distinct de
`dubsar.workbench-report/1`. Ses clés, types et nullabilités exacts sont :

| Clé | Type | Valeur/règle |
|---|---|---|
| `format` | string | `dubsar.review-ledger-report/1` |
| `authority` | string | `local_preparation_record` |
| `renderer` | object | Clés exactes `name`, `version`, strings ASCII bornées |
| `source_snapshot_sha256` | string | 64 hex |
| `source_canonical_root_sha256` | string | 64 hex |
| `canonical_view_format` | string | `dubsar.workbench-view/1` |
| `review_ledger_format` | string | `dubsar.review-ledger-view/1` |
| `receipt_set_sha256` | string ou null | Null uniquement si Ledger `unavailable` |
| `review_projection_sha256` | string | 64 hex |
| `review_presentation` | string | `full` ou `summary-only` |
| `bytes` | integer | 1 à 2097152 |
| `sha256` | string | Digest des octets HTML composites exacts |

Les quatre identités restent séparées. Le manifeste historique et les octets du
rapport sans option restent inchangés.

`ui --reviews` retourne un nouvel envelope fermé
`dubsar.review-ledger-ui-session/1` :

| Clé | Type | Valeur/règle |
|---|---|---|
| `format` | string | `dubsar.review-ledger-ui-session/1` |
| `status` | string | `ready` |
| `authority` | string | `local_preparation_record` |
| `url` | string | URL loopback éphémère, jamais persistée dans le Ledger |
| `snapshot_sha256` | string | 64 hex |
| `canonical_root_sha256` | string | 64 hex |
| `receipt_set_sha256` | string ou null | Même nullabilité que le compagnon |
| `review_projection_sha256` | string | 64 hex |
| `review_presentation` | string | `full` ou `summary-only` |

Il transmet le Buffer HTML composite au serveur existant. Route, bind loopback,
CSP, timeouts, admission, limite de 2 MiB et cycle de vie du serveur restent
inchangés.

Le renderer canonique existant produit d'abord sa présentation complète selon
son comportement inchangé. Le compagnon ne retranche, ne tronque ni ne remplace
aucun octet canonique et ne peut donc masquer un blocker. Le budget restant est
calculé **après** échappement HTML et avant transport :
`2097152 - canonical_html_bytes`. Sur ce reste, 4096 octets sont réservés au
shell consultatif, à la bande et au marqueur de réduction ; au plus 524288
octets supplémentaires accueillent des entrées complètes, dans l'ordre
déterministe de `reviews`. Le renderer peut construire ce Buffer borné en
mémoire ; le streaming concerne la découverte des reçus, pas le transport HTML.

Si la présentation canonique complète ne laisse pas les 4096 octets obligatoires,
la commande opt-in échoue explicitement avec
`REVIEW_PRESENTATION_BUDGET_UNAVAILABLE`, ne produit aucun composite et renvoie
vers la commande canonique inchangée plus `dubsar reviews --json`. Le lot report/UI
ne peut être activé sans une fixture de frontière prouvant que chaque blocker
canonique reste présent byte-for-byte sous pression. Une entrée consultative
dont les détails échappés dépassent le
solde est sautée, puis le renderer essaie les suivantes ; il ne publie jamais
une entrée partielle. Si au moins une entrée est sautée, `review_presentation`
vaut `summary-only` et le marqueur exact indique
`<rendered_count>/<valid_count> avis affichés — <render_omitted_count> masqués par le budget de rendu`.
La bande consultative et les compteurs d'acquisition restent présents dans tout
composite produit. Une seule entrée volumineuse ne peut donc pas effacer les
autres avis qui tiennent dans le budget. `summary-only` réduit exclusivement le
consultatif. Le Ledger, ses digests et son état ne sont pas recalculés pour cette
décision de rendu.

## Présentation report/UI

Le rapport composite contient une bande toujours visible, avec une copie fermée
par état :

| État | Copie exacte |
|---|---|
| `available` | `Advisory Review Ledger — available — <valid_count> validé(s), 0 omis — ne modifie pas l'état canonique` |
| `degraded` | `Advisory Review Ledger — degraded — <valid_count> validé(s), <omitted_count> omis — données consultatives partielles` |
| `unavailable` | `Advisory Review Ledger — unavailable — comptage indisponible — aucune donnée partielle publiée — <DIAGNOSTIC_CODE>` |

La copie `unavailable` n'affiche jamais `0`, `null` ou un compteur inféré.
Si `review_presentation` vaut `summary-only`, la bande `available` ou `degraded`
ajoute la copie exacte :
`Rendu consultatif réduit — <rendered_count>/<valid_count> avis affichés — <render_omitted_count> masqués par le budget — canonique intact — projection assainie complète disponible via dubsar reviews --json`.

Les détails bornés utilisent uniquement un élément natif `<details>` avec un
`<summary>` visible ; aucun script n'est ajouté. Chaque entrée montre :

- rôle et isolation **déclarés** ;
- racine d'entrée et booléen de match ;
- racine résultante et booléen séparé pour une réconciliation ;
- findings nommés « advisory review finding » ;
- alternatives, limitations et lignée directe ;
- jamais le mot `resolved` comme état calculé.

Si le Ledger est `unavailable`, le rapport canonique est tout de même rendu et
la bande affiche exactement la copie `unavailable` fermée ci-dessus, diagnostic
compris. Les détails n'ajoutent aucun contenu partiel.

Les labels d'interprétation sont également fermés :

| Situation | Label visible |
|---|---|
| Blocker issu du read model | `Blocage canonique — affecte readiness` |
| Reçu dont l'entrée matche | `Avis consultatif — mêmes octets canoniques` |
| Reçu dont l'entrée diffère | `Avis consultatif historique — octets canoniques différents` |
| Réconciliation avec résultat matching | `Réconciliation déclarée — résultat byte-identique au canon actuel — objection conservée` |

Le test humain du lot report/UI présentera sur une même page quatre éléments :
un blocker canonique, un avis matching, une objection historique originale et
la réconciliation directement liée qui conserve cette objection. Sans aide et
en moins de 60 secondes, la personne doit classer correctement les quatre,
identifier lequel peut affecter `readiness` et confirmer que la réconciliation
n'efface pas l'objection. Toute erreur ou dépassement est un échec du critère,
pas une observation facultative.

## Matrice de compatibilité

| Surface actuelle | Sans opt-in Review Ledger | Avec opt-in futur | Invariant |
|---|---|---|---|
| JSON canoniques | Inchangés | Inchangés | Source de vérité unique |
| `dubsar.workspace-snapshot/1` | Inchangé | Déjà produit avant le Ledger | Pas de reçu dans le snapshot |
| `dubsar.workbench-view/1` | Byte-identique | Input séparé du compagnon | Aucun champ conditionnel |
| `locate/status/resume/validate/doctor` | Byte-identiques | Aucun opt-in prévu | Aucune énumération de reviews |
| `report` | HTML et manifeste `/1` inchangés | `report --reviews`, manifeste séparé | Pas de dérive silencieuse |
| `ui` | Session et Buffer inchangés | `ui --reviews`, envelope séparé | Serveur transport-only inchangé |
| Reçus et recorders | Inchangés | Lecture compatible seulement | Aucune écriture |
| Writer | Hors chemin | Hors chemin | Aucune autorité de mutation |
| Réseau, MCP, backend, modèle | Aucun | Aucun | Local read-only |

## Vecteurs et critères d'acceptation futurs

Le format `dubsar.review-ledger-contract-vectors/1` est fermé. L'objet racine
possède exactement `format`, `authority`, `encoding`, `preimage_contracts`,
`digest_vectors`, `projection_vectors`, `future_behavior_cases` et
`limitations`.

| Objet | Cardinalité | Clés exactes |
|---|---:|---|
| `encoding` | 1 | `document_encoding`, `line_endings`, `final_newline`, `binary_encoding`, `canary_policy` |
| `preimage_contracts[]` | exactement 2 | `name`, `format`, `domain_prefix_utf8_hex`, `record_order`, `record_grammar`, `self_exclusion`, `notes` |
| `digest_vectors[]` | 1 à 64 | `vector_id`, `preimage_contract`, `records`, `expected_preimage_utf8_hex`, `expected_sha256`, `assertions` |
| `digest_vectors[].records[]` | 0 à 256 | `portable_path`, `content_utf8_hex`, `content_sha256` |
| `projection_vectors[]` | 1 à 64 | `vector_id`, `scenario`, `projection`, `expected_preimage_utf8_hex`, `expected_projection_sha256`, `assertions` |
| `future_behavior_cases[]` | 1 à 128 | `case_id`, `input_class`, `expected_ledger_status`, `expected_diagnostic_codes`, `expected_canonical_effect`, `expected_projection_effect`, `inert_canary_utf8_hex` |

Les types et contraintes mécaniques sont également fermés :

- à la racine, `format` et `authority` sont les strings exactes
  `dubsar.review-ledger-contract-vectors/1` et `local_preparation_record` ; les
  six autres propriétés ont exactement les types object/array annoncés ; le
  fichier complet fait au plus 262144 octets UTF-8 sans BOM, LF, avec une seule
  newline finale ;
- `encoding` porte quatre strings exactes — `UTF-8 without BOM`, `LF`,
  `lowercase hexadecimal` et la politique canary présente dans le vecteur —
  puis le booléen exact `final_newline: true` ;
- `preimage_contracts` contient, dans cet ordre, exactement un objet nommé
  `receipt_set_sha256` puis un objet nommé `projection_sha256`. `format` et
  `domain_prefix_utf8_hex` valent respectivement le format `/1` concerné et ses
  octets UTF-8 suivis de `00`. `record_order` et `record_grammar` sont des strings
  non vides de 8192 octets au plus. `self_exclusion` vaut exactement `[]` pour le
  set et `["$/projection_sha256"]` pour la projection ;
- `vector_id` et `case_id` suivent explicitement
  `^[a-z0-9][a-z0-9-]{2,63}$` et sont uniques globalement entre les trois arrays
  de cas/vecteurs ;
- `digest_vectors[].preimage_contract` vaut exactement `receipt_set_sha256` et
  référence l'unique contrat de ce nom. Chaque record possède un
  `portable_path` unique conforme à
  `^reviews/[a-z0-9][a-z0-9._-]{2,63}/[a-z0-9][a-z0-9._-]{2,63}\.json$`, un
  `content_utf8_hex` hex minuscule pair décodant au plus 262144 octets et un
  `content_sha256` égal au SHA-256 de ces octets. Le préimage attendu décodé est
  exactement celui du framing trié et `expected_sha256` est son SHA-256 ;
- pour `projection_vectors`, `scenario` est une string non vide de 8192 octets
  au plus, `projection` suit exactement le schéma compagnon fermé,
  `expected_preimage_utf8_hex` décode vers le framing byte-exact de cette
  projection et `expected_projection_sha256` est son SHA-256 ;
- pour `future_behavior_cases`, `input_class` et
  `expected_projection_effect` sont des strings non vides de 8192 octets au
  plus, `expected_ledger_status` appartient à
  `available|degraded|unavailable`, `expected_canonical_effect` vaut exactement
  `none`, et `expected_diagnostic_codes` contient de 0 à 32 codes uniques,
  ordonnés comme la table diagnostique fermée de ce contrat ;
  `inert_canary_utf8_hex` est null ou un hex minuscule pair décodant au plus
  8192 octets ;
- `assertions`, `notes` et `limitations` contiennent de 1 à 32 strings non vides
  de 8192 octets UTF-8 au plus ; `self_exclusion` suit sa valeur exacte
  ci-dessus.

Tout hex est minuscule et pair ; tout SHA-256 possède 64 caractères. Toute clé,
type, référence, enum, unicité, longueur ou cardinalité différente invalide le
fichier de vecteurs.

`digest_vectors` teste seulement le framing byte-exact avec de petits octets
inertes explicitement **non reçus**. `projection_vectors` teste la sémantique
visible et peut porter un token 64-hex de set synthétique ; ce token ne prétend
pas provenir des octets de framing. Seul un futur test runtime combinant capture,
validation et framing pourra établir ce lien. Les deux catégories ne sont donc
jamais réutilisées l'une comme preuve de l'autre.

Le fichier `DUBSAR_REVIEW_LEDGER_VECTORS.json` couvre :

- set vide, contenu muté et ordre d'entrée inversé ;
- projection vide, match canonique, mismatch historique et réconciliation ;
- sous-ensemble `degraded` après entrée malformée ;
- enveloppe `unavailable` pour racine unsafe ;
- changement de snapshot d'audit avec le même reçu matching, la même racine
  canonique et le même token de set ;
- cas futurs malformé, unsafe, oversized, limites de nombre, taille, temps,
  mémoire et projection ;
- reçu valide conservé malgré un autre fichier arbitrairement oversized, sans
  charger ce dernier dans le budget brut ;
- identité chemin/contenu, collisions de normalisation, finding dupliqué,
  référence de réconciliation ambiguë et labels réduits sans collision ;
- pics mémoire séparés pour ASCII, scalars astrals et JSON fortement échappé ;
- expansion HTML menant à une présentation `summary-only` sans altérer le
  Ledger, plus pression canonique refusant le composite sans retirer de blocker ;
- canaries actives encodées de façon inerte et descriptions sensibles sans
  spécimen concret.

Le lot Core devra transformer ces cas documentaires en fixtures exécutables et
ajouter les adversariaux propres à chaque plateforme. Une correspondance de
digest ne suffira pas : les tests devront aussi prouver la capture sur handle
stable, l'absence de relecture canonique, l'absence d'écriture/réseau/processus,
la réduction avant sortie et l'invariance exacte des commandes existantes.

## Réconciliation des revues de ce contrat

### Position Codex avant revue finale

La séparation en compagnon opt-in est retenue parce qu'elle garde une unique
vérité canonique, rend les échecs consultatifs fail-open vis-à-vis de la vue déjà
produite et évite une migration de format. Le digest de set porte sur les octets
bruts validés ; le digest de projection porte sur tous les champs visibles
assainis. Les limites globales échouent fermées sans sous-ensemble, tandis qu'une
entrée individuelle invalide peut être omise seulement après preuve de
complétude.

### Résultat des reviewers et du challenger

Les premières passes produit, architecture et sécurité ont refusé le draft sur
des points matériels : snapshot audit sans reçu commun, copie opérateur
ambiguë, propriété canonique contradictoire, carriers et schéma de vecteurs
incomplets, découverte non réellement streaming, identité/lignée insuffisamment
fermées et budgets mémoire/HTML contournables. Le contrat et les vecteurs ont
été corrigés sur chacun de ces points. Les passes finales indépendantes rendent
toutes trois **GO documentaire sans finding matériel** ; elles ne transforment
pas ces attentes en preuve runtime.

Le challenger Gemini a utilement montré qu'un fallback HTML tout-ou-rien
permettait à une entrée volumineuse de masquer les autres avis et que des labels
déterministes pouvaient donner une fausse impression d'anonymat. La décision
retenue rend donc les omissions à la frontière d'entrées complètes avec compteurs
visibles et décrit les labels uniquement comme réduction d'affichage
reproductible. Son objection selon laquelle le Ledger devrait revérifier les
octets canoniques n'est pas retenue : la capture Workbench reste l'unique
propriétaire de leur identité et le Ledger n'est explicitement pas un second
vérificateur. Sa proposition de conserver davantage de références techniques
est différée à un futur locator relatif typé ; v1 conserve la minimisation
fermée et reconnaît sa perte d'information. Enfin, les deux digests restent des
identités locales reproductibles, pas une attestation ni un mécanisme d'audit
hors hôte.

Aucun prompt, transcript, raisonnement caché, sortie brute, signature ou
attestation de reviewer ou de provider n'est persisté.

## Limites et exclusions

- Ce lot crée uniquement ce contrat et ses vecteurs. Il n'implémente aucune
  acquisition, validation, sanitization, commande, UI ou preuve de sécurité.
- Les cas `future_behavior_cases` sont des attentes, pas des tests exécutés.
- Aucun reçu réel, donnée personnelle, secret, chemin local, URL, prompt ou
  sortie de provider n'est inclus.
- Le Ledger ne prouve pas l'identité ou l'indépendance d'un reviewer.
- Aucun commit, publication, déploiement, release, backend, MCP, writer ou
  modification du serveur n'est autorisé par ce document.
- La provenance Workbench et la revue humaine de release restent hors de ce lot
  et peuvent maintenir l'état global non release-ready même si tous les vecteurs
  documentaires sont reproductibles.
