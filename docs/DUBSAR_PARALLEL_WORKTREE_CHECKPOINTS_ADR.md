# ADR — checkpoints et worktrees parallèles

**Statut :** Lot 1 d'enregistrement des candidats, Lot 2 de liste minimale et
Lot 3 de promotion explicite implémentés (`pending record`, `pending list`,
`pending promote`). La projection consultative reste future et non approuvée
ici.

**Date :** 2026-08-15

**Décision concernée :** `decision-parallel-worktree-checkpoints-v1`

## Résumé de la décision

Le comportement supporté reste simple : plusieurs worktrees peuvent lire la
mémoire, mais un seul worktree convergé écrit la chaîne canonique. Aucun merge
Git n'est autorisé à réconcilier automatiquement deux `checkpoint_append`
concurrents.

Le Lot 1 permet d'enregistrer des **candidats consultatifs** dans
`.dubsar-pending/<declared_source>/<checkpoint_id>.md` via
`dubsar pending record`. Ces fichiers sont suivis par Git, mais ne modifient
jamais `.dubsar/`, ni `dubsar.continuity-checkpoints/2`, ni
`dubsar.workspace-snapshot/1`, ni le sens du snapshot canonique. La projection
et la promotion restent des lots séparés.

## Défaut reproduit

La chaîne actuelle est strictement linéaire :

- le writer choisit `index = entries.length` ;
- `previous_checkpoint_sha256` est le digest du dernier maillon visible ;
- `checkpoint_sha256` couvre toute l'entrée, y compris ces deux valeurs ;
- le reader valide chaque index, parent et digest dans l'ordre du tableau.

Une reproduction jetable exécutée sur le runtime réel au commit
`15e4205410a566963ac9968257d1492f90b2d87b` a créé deux worktrees depuis le
même parent, puis un checkpoint dans chacun. Les deux enfants étaient valides
séparément, avec `index = 1` et le même parent. Le merge Git a produit un conflit
sur `.dubsar/checkpoints.json`. La concaténation naïve des deux enfants a été
refusée avec `MEMORY_CHECKPOINTS_INVALID`.

Une linéarisation explicite est possible seulement en choisissant un ordre,
en changeant l'index et le parent du second enfant, puis en recalculant son
digest. Elle change donc l'identité du checkpoint déplacé et de toute sa
descendance. Ce n'est pas un merge neutre et DUBSAR ne doit jamais le présenter
comme tel.

## Règle supportée aujourd'hui

```text
N worktrees
  -> lecture, status et resume autorisés
  -> changements source indépendants
  -> aucun checkpoint_append concurrent destiné à être fusionné

convergence explicite
  -> merge humain des changements source retenus
  -> un worktree canonique
  -> une preview checkpoint
  -> une confirmation liée au digest
  -> un append canonique
```

Les verrous actuels sont locaux à un workspace. Ils empêchent deux writers
coopératifs dans le même root, mais ne sérialisent pas des worktrees distincts.
Ni le nom de branche, ni la présence d'un autre worktree, ni l'identité d'un
agent ne sont inférés par le runtime.

## Proposition future : candidats suivis, canonique inchangé

Le modèle proposé sépare trois objets :

```text
candidat suivi par Git
  -> projection consultative explicite
  -> promotion humaine explicite
  -> append dans checkpoints.json
```

`checkpoints.json` reste l'unique historique canonique. Les candidats ne
modifient jamais l'intégrité, la readiness, les blockers, la prochaine action,
la capsule de reprise, le routage ou le code de sortie canonique.

### Emplacement proposé

```text
.dubsar-pending/<declared_source>/<checkpoint_id>.md
```

Le chemin initialement envisagé `.dubsar/pending/**` est rejeté pour cette
version du contrat : le reader actuel autorise un ensemble fermé d'entrées à la
racine de `.dubsar` et refuse tout répertoire inconnu. L'ajouter rendrait un
projet illisible par les runtimes antérieurs.

Le sibling `.dubsar-pending/` préserve cette propriété : les anciens runtimes
continuent à valider uniquement `.dubsar/`, tandis qu'un runtime futur doit
annoncer explicitement sa capacité avant de lire ou d'écrire les candidats.
Ce choix ne transforme pas le sibling en seconde mémoire canonique.

Le root est exactement `<project_root>/.dubsar-pending`, où `project_root` est
le parent physique déjà validé de `.dubsar` par le locator. La capture doit
prouver que les deux roots ont ce même parent direct, sans alias, symlink,
junction, reparse point ou variation de casse. Toute entrée racine dont le nom
n'est pas byte-identique à `.dubsar-pending` est ignorée par les anciens
runtimes et refusée comme source par la capacité future.

### Identité de source

`declared_source` est une étiquette opaque déclarée par l'opérateur. Elle :

- respecte `^[a-z0-9][a-z0-9._-]{2,63}$` ;
- n'est jamais dérivée d'une branche, d'un chemin, d'un hostname, d'un PID ou
  d'un agent ;
- ne prouve ni identité, ni indépendance, ni autorité ;
- sert uniquement au partitionnement et à l'affichage consultatif.

### Document candidat proposé

Le fichier Markdown a un body vide. Son frontmatter porte exactement :

| Champ | Contrat |
|---|---|
| `format` | `dubsar.pending-checkpoint/1` |
| `project_id` | même identifiant que le manifest canonique |
| `declared_source` | identifiant opaque décrit ci-dessus |
| `base_checkpoint_sha256` | dernier checkpoint observé, ou `null` |
| `base_work_checkpoint_sha256` | dernier checkpoint observé pour le Work ciblé, ou `null` |
| `source_shared_snapshot_sha256` | `shared_snapshot_sha256` observé, 64 hex ; identité informative de la base capturée |
| `checkpoint` | champs d'auteur d'un checkpoint, sans index, parent ni digest canonique |
| `candidate_sha256` | digest du candidat, exclu de sa propre préimage |

`checkpoint` contient exactement `attempt`, `checkpoint_id`, `kind`,
`limitations`, `references`, `resolves`, `resulting_state`, `summary`,
`validation` et `work_id`, avec les mêmes types et bornes que l'opération
`checkpoint_append` actuelle. Pour ce format de chemin portable,
`checkpoint_id` est restreint au sous-ensemble minuscule
`^[a-z0-9][a-z0-9._-]{2,127}$`, même si le contrat canonique historique accepte
une surface plus large. `resolves` vaut `null` ou désigne un checkpoint déjà
présent dans la base canonique observée ; il ne désigne jamais un autre
candidat en attente.

La préimage proposée de `candidate_sha256` est :

```text
UTF8("dubsar.pending-checkpoint/1\0")
|| UTF8(stableJson(frontmatter sans candidate_sha256))
```

Le nom du fichier doit être exactement `<checkpoint.checkpoint_id>.md` et le
premier segment doit être exactement `declared_source`. `candidate_sha256`
identifie la structure normalisée, pas les octets bruts du Markdown. La capture
calcule séparément `source_file_sha256` sur le fichier régulier exact. La
preview de promotion lie les deux valeurs. Aucun digest ne prouve l'auteur ni
la vérité du contenu.

### Bornes proposées

- au plus 32 sources déclarées ;
- au plus 128 candidats au total ;
- au plus 64 KiB par fichier ;
- profondeur exactement égale à deux sous `.dubsar-pending/` ;
- au plus 8 références par candidat ;
- tri déterministe par chemin portable avant projection.

Ces constantes devront apparaître dans les contrats, les vecteurs et les tests
avant toute implémentation. Aucun dépassement n'est tronqué silencieusement.

## Projection consultative proposée

La projection future doit être demandée explicitement et produite seulement
après un snapshot canonique réussi. Elle reçoit du propriétaire du snapshot
l'objet canonique déjà validé et son `shared_snapshot_sha256` ; elle ne relit
pas `.dubsar/` et ne recalcule pas une seconde vérité. L'absence de
`.dubsar-pending/` est normale et produit une projection vide. Une panne de la
projection ne réévalue jamais le snapshot déjà produit.

Le format racine proposé est `dubsar.pending-checkpoints-view/1`, avec les clés
exactes suivantes :

| Champ | Contrat |
|---|---|
| `format` | `dubsar.pending-checkpoints-view/1` |
| `status` | `available`, `degraded` ou `unavailable` |
| `project_id` | projet du snapshot déjà validé |
| `source_shared_snapshot_sha256` | digest partagé reçu du snapshot owner |
| `pending_set_sha256` | digest des fichiers bruts capturés, ou `null` si `unavailable` |
| `projection_sha256` | digest de la projection assainie, hors ce champ |
| `discovered_count` | entier borné, ou `null` si découverte non prouvée |
| `valid_count` | entier borné |
| `omitted_count` | entier borné |
| `candidates` | tableau trié de candidats assainis |
| `diagnostic` | code fermé ou `null` |

Chaque élément visible de `candidates` porte exactement `declared_source`,
`checkpoint_id`, `work_id`, `kind`, `summary`, `candidate_sha256`,
`source_file_sha256`, `state` et `diagnostic`. Aucun chemin filesystem n'est
publié. `summary` passe par la même réduction et le même assainissement que les
vues canoniques.

`pending_set_sha256` couvre tous les fichiers réguliers capturés de façon sûre,
y compris ceux ensuite omis pour structure invalide. Sa préimage proposée est :

```text
UTF8("dubsar.pending-checkpoints-set/1\0")
|| pour chaque chemin portable trié :
   UTF8("<source_file_sha256>  <portable_path>\n")
```

`projection_sha256` vaut le SHA-256 de
`UTF8("dubsar.pending-checkpoints-view/1\0")` suivi de `stableJson` de toute la
projection assainie sans `projection_sha256`. Ces deux identités ne sont jamais
appelées snapshot canonique.

États fermés proposés pour un candidat valide :

| État | Signification |
|---|---|
| `ready` | candidat valide, références encore identiques, ID absent du canonique |
| `stale_chain` | la chaîne globale a avancé, mais pas le Work ciblé |
| `stale_work` | le Work ciblé a avancé depuis la création du candidat |
| `already_promoted` | mêmes champs d'auteur déjà présents sous le même ID |
| `collision` | même ID canonique, champs d'auteur différents |
| `reference_changed` | au moins une référence n'a plus les octets déclarés |

Les états sont mutuellement exclusifs par cette priorité : collision entre
candidats ou avec le canonique ; contenu canonique identique déjà promu ;
référence modifiée ; dernière tête du Work différente de
`base_work_checkpoint_sha256` ; dernier checkpoint global différent de
`base_checkpoint_sha256` ; sinon `ready`. `stale_work` prévaut sur
`stale_chain`, car réutiliser un ancien `resulting_state` pourrait effacer un
blocage ou une prochaine action enregistrée plus tard. Deux candidats valides
partageant le même `checkpoint_id` sont tous deux `collision`, même si leur
contenu est identique. `source_shared_snapshot_sha256` ne décide jamais seul
d'un état ou d'une autorisation.

Les fichiers invalides sont omis de la liste visible et comptés dans une
projection `degraded` avec `PENDING_ENTRIES_OMITTED`. Une racine physique non
prouvée, une course de capture ou une limite dépassée produit respectivement
`PENDING_ROOT_UNSAFE`, `PENDING_CAPTURE_RACE` ou `PENDING_LIMIT_EXCEEDED`, un
état `unavailable`, une liste vide et aucun digest de set. Les textes visibles
sont bornés et assainis ; aucun chemin absolu, contenu brut, secret ou contrôle
terminal n'est retourné.

## Promotion explicite proposée

Une promotion future reste une écriture DUBSAR ordinaire en deux temps :

1. capturer à nouveau le snapshot canonique et le candidat régulier ;
2. vérifier le chemin, les clés exactes, le projet, le digest et les bornes ;
3. revalider les références contre les octets présents ;
4. exiger que le Work ciblé et un éventuel `resolves` existent déjà dans le
   canonique ;
5. refuser tout ID candidat dupliqué et classer un éventuel ID canonique
   identique ou divergent ;
6. comparer séparément la tête globale et la dernière tête du Work ciblé ;
7. refuser de réutiliser silencieusement un `resulting_state` si le Work a
   avancé ;
8. construire l'append à la fin de la chaîne actuelle ;
9. lier la preview au snapshot, au `candidate_sha256`, au
   `source_file_sha256`, aux digests avant/après et au `change_sha256` ;
10. appliquer après confirmation explicite et réinspection live.

Un `stale_chain` n'est pas intégré silencieusement : la preview doit nommer que
le candidat sera appendu après un parent global différent de celui observé à
sa création. L'opérateur choisit alors de confirmer ou d'abandonner. Un
`stale_work` est plus fort : le candidat ne peut pas réappliquer un ancien état
résultant. Il doit être abandonné ou remplacé par un nouveau candidat explicite.
L'ordre de plusieurs candidats est toujours un choix externe explicite.

La promotion remplace seulement `checkpoints.json`. Elle ne supprime, ne
renomme et ne marque pas le candidat dans la même transaction. Le candidat
immuable reste consultatif : une seconde demande identique devient
`already_promoted` sans nouvelle écriture ; une collision de contenu échoue
fermement.

## Sécurité et capture

Une implémentation future devra :

- ouvrir uniquement des dossiers et fichiers réguliers sous un root déjà
  possédé, sans suivre symlink, junction ou reparse point ;
- exiger des segments de chemin ASCII minuscules et refuser toute collision
  byte, Unicode ou case-fold dans l'inventaire portable ;
- refuser les identités physiques dupliquées et les changements pendant la
  capture ;
- appliquer la politique actuelle de contenu sensible et de références ;
- ne jamais charger un candidat comme instruction, prompt ou code ;
- ne déclencher aucun réseau, modèle, hook, daemon, watcher ou sous-processus ;
- ne donner aucun pouvoir d'écriture au Dashboard ou au renderer ;
- garder le writer canonique mono-fichier et fail-closed ;
- ne jamais déduire une approbation de Git, d'un merge ou d'un digest valide.

## Versioning et négociation

La projection et la promotion devront avoir deux capacités nommées distinctes,
par exemple `memory.pending-checkpoint-projection.v1` et
`memory.pending-checkpoint-promotion.v1`. Leur ajout au contrat workspace-free
`dubsar.runtime-capabilities/1`, la politique de bump de ce format et les
adapters concernés forment un lot séparé.

Un consommateur ne doit jamais inférer le support depuis un numéro de version
ou la présence du dossier. En l'absence de la capacité attendue, il s'arrête ou
reste en lecture canonique ; il ne crée ni candidat ni promotion.

## Alternatives rejetées

- **Merge automatique de tableaux :** invalide l'index, le parent et le digest.
- **Rechaînage automatique :** choisit un ordre et change des identités sans
  autorité humaine.
- **Un historique canonique par branche :** crée plusieurs vérités.
- **CRDT, event sourcing ou replay :** introduit une orchestration et masque le
  caractère positionnel du contrat actuel.
- **Dossier partagé hors Git :** ne survit pas à la convergence et mélange les
  frontières de worktree.
- **Nom de branche comme source :** transforme une convention Git mutable en
  attestation implicite.
- **Écriture depuis le Dashboard :** viole sa frontière read-only.

## Tests et preuves requis avant implémentation

- vecteurs valides et invalides pour le format, le digest et chaque clé exacte ;
- limites de sources, fichiers, octets, profondeur et références ;
- chemins absolus, traversal, casse, Unicode, symlink, junction, reparse,
  hardlink et identité dupliquée ;
- mutation entre découverte, capture, preview et apply ;
- merge de candidats distincts, collision même source/ID et candidats identiques ;
- base fraîche, base avancée, référence modifiée et Work absent ;
- promotion concurrente dans un root, changement externe et confirmation stale ;
- idempotence `already_promoted` et collision canonique fail-closed ;
- preuve que les snapshots, capsules, routes et codes de sortie sans opt-in sont
  byte-compatibles ;
- preuve qu'un runtime actuel continue à lire `.dubsar/` en présence du sibling
  `.dubsar-pending/` ;
- zéro réseau, hook, daemon, modèle, processus ou écriture renderer atteignable ;
- test d'intégration reproduisant deux worktrees puis une promotion ordonnée.

## Non-objectifs

Ce contrat ne propose ni détection automatique de worktrees, ni synchronisation,
ni ordonnanceur, ni identité d'agent, ni acteur signé, ni époque, ni flotte, ni
reconciliation automatique. Il n'installe ni n'intègre Orca. Il ne change pas
le produit public tant qu'un lot ultérieur n'a pas ratifié les formats, vecteurs,
capacités et gates ci-dessus.
