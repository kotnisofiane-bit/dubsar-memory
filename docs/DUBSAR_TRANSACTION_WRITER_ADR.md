# ADR — Writer transactionnel local mono-fichier

**Statut :** proposition revue, non approuvée pour implémentation
**Date :** 2026-08-10
**Décision concernée :** `decision-transaction-writer-v1`

## Décision proposée

Le premier writer DUBSAR remplace exactement **un fichier JSON canonique
existant et allowlisté** par ChangeSet. Il reste dans un package séparé du core
read-only et ne crée aucune capacité d'écriture dans le serveur, le renderer ou
la CLI de consultation.

Le v1 vise quatre propriétés bornées :

1. les octets proposés, prévisualisés, confirmés et écrits sont identiques ;
2. deux writers DUBSAR coopératifs ne peuvent pas committer simultanément ;
3. la cible visible est un fichier complet ancien ou un fichier complet nouveau
   sur une combinaison plateforme/filesystem explicitement validée ;
4. après un crash de processus, un recovery explicite classe l'état sans
   écraser un contenu inconnu.

Ce v1 ne promet ni transaction multi-fichier, ni prévention absolue d'un writer
non coopératif, ni authentification cryptographique de la présence humaine, ni
durabilité après coupure de courant sous Windows.

## Pourquoi le multi-fichier est différé

Les quatre documents projet et les cinq documents audit ont des invariants
croisés. Plusieurs `rename` individuels laisseraient nécessairement un état
mixte en cas de crash. Un marqueur transitoire ne suffit pas non plus : un
reader peut commencer avant sa création et finir après sa suppression.

Un futur protocole multi-fichier exigerait une génération persistante, un
journal write-ahead, une politique readers/writer commune et une récupération
formalisée. Ce serait une nouvelle décision d'architecture, pas une extension
implicite du v1.

Les workflows actuels peuvent progresser par transitions mono-fichier dont
chaque état intermédiaire reste valide : enregistrer la preuve avant de clore
un lot, ou sélectionner un candidat avant de remplacer son contrat. Toute
transition qui ne peut pas préserver les invariants avec un seul fichier est
refusée.

## Frontières et autorité

```text
snapshot read-only immuable
        |
        v
PreparedChangeSet en mémoire
        |
        v
preview locale inerte + confirmation explicite
        |
        v
package writer à capacité séparée
        |
        v
un remplacement canonique allowlisté
```

- `dubsar-operator-core` reste sans mutateur filesystem. Il peut seulement
  détecter un marqueur transactionnel et refuser une reprise non réconciliée.
- `dubsar-workbench-server` et l'interface web restent strictement read-only.
- Le writer possède son propre entrypoint et son propre profil dans le gate de
  capacités. Le binaire read-only existant ne l'importe pas.
- Aucun agent, reviewer, reçu ou modèle ne constitue une confirmation. Une
  saisie TTY directe est une friction d'intention, pas une preuve d'identité ;
  l'autorité humaine reste procédurale et appartient au host.
- Il n'existe ni `--yes`, ni confirmation par pipe, variable d'environnement,
  fichier de configuration, reçu de review ou API réseau.

## Contrat `dubsar.changeset/1`

Un ChangeSet lie, par un SHA-256 domain-separated et déterministe :

- la version du format et de la politique writer ;
- le domaine `project` ou `audit` et le marqueur attendu ;
- le digest du snapshot de base et le digest prospectif complet ;
- un unique chemin relatif issu de l'allowlist canonique du domaine ;
- l'identité physique observée, l'ancien digest et l'ancienne taille ;
- le nouveau digest et la nouvelle taille ;
- la version du validateur et le résultat prospectif attendu.

Le timestamp, le PID, le chemin absolu et l'identifiant runtime aléatoire ne
font pas partie du digest déterministe. Les nouveaux octets sont produits une
fois, copiés dans un `Buffer` privé borné à 1 MiB, validés avec l'ensemble du
workspace prospectif, puis réutilisés sans recalcul pour le staging et le
commit.

La preview terminal affiche seulement le domaine, la cible relative, les
tailles, les digests ancien/nouveau, le digest du ChangeSet et une différence
locale bornée. Elle neutralise C0, C1, ESC/CSI/OSC, retour chariot, backspace,
bidi et séparateurs Unicode. Aucun texte de workspace ne devient une commande,
un prompt ou un contexte HTML actif.

## State machine

```text
IDLE
  -> INTENT_ACQUIRED
  -> TEMP_SYNCED
  -> PRECOMMIT_VERIFIED
  -> rename(temp, target) réussi       # commit point
  -> COMMITTED_UNRECEIPTED
  -> COMPLETE
```

Le marqueur-intent est créé exclusivement avec `open(..., "wx")`. Son contenu
est borné et metadata-only : identifiant runtime, ChangeSet, cible relative,
nom du temp, digests et tailles. Son existence bloque les autres writers et
fait signaler `RECOVERY_REQUIRED` aux readers DUBSAR concernés. Il n'est jamais
supprimé automatiquement parce qu'un PID semble mort ou qu'un délai est écoulé.

Le temp est créé dans le même workspace avec un nom imprévisible et `wx`, écrit
intégralement, synchronisé via un handle writable, fermé, relu et rehashé. Le
writer reprend ensuite un snapshot complet et exige le même digest de base,
l'identité attendue et l'ancien digest observable immédiatement avant le
commit.

Le retour réussi de `rename(temp, target)` est le seul commit point. Le reçu
metadata-only vient ensuite ; il est une preuve secondaire et non une partie
atomique du commit. Une absence de reçu n'annule donc pas un target au nouveau
digest.

## Recovery explicite

Lorsqu'un marqueur existe, le diagnostic est read-only et n'infère aucun succès
depuis le journal seul :

| Target observé | Temp | Interprétation | Action autorisable |
|---|---|---|---|
| ancien digest | absent ou nouveau digest | commit non effectué | abandon explicite et nettoyage |
| nouveau digest | absent | commit effectué, reçu possiblement absent | finalisation explicite |
| autre digest | quelconque | mutation externe ou corruption | arrêt fermé, aucune suppression |
| illisible, lien, identité inattendue | quelconque | frontière non prouvée | arrêt fermé, résolution humaine |

Le v1 ne conserve pas de backup automatique et ne propose pas d'undo. Avant le
commit, abandonner signifie supprimer seulement le temp confirmé et le marqueur
possédé. Après le commit, récupérer signifie vérifier le nouveau digest,
réévaluer le workspace complet, écrire éventuellement un reçu `recovered`, puis
retirer le marqueur. Toute suppression ou finalisation exige une nouvelle
autorisation explicite ; aucune récupération stale n'est automatique.

## Garanties et exclusions

| Propriété | Position v1 |
|---|---|
| Octets preview/commit identiques | exigée et testable |
| Sérialisation de writers DUBSAR | exigée via lock coopératif |
| Visibilité complète ancien/nouveau d'un fichier | exigée seulement sur matrice prouvée |
| Crash du processus avant/après commit | récupération explicite exigée |
| Mutation externe observable | échec fermé |
| Course non coopérative dans la dernière fenêtre pathname | hors garantie de prévention |
| Présence humaine face à un processus du même compte OS | non authentifiée |
| Coupure de courant/durabilité du nom sous Windows | non garantie par Node pur |
| Dossier réseau, cloud-sync, placeholder ou reparse non maîtrisé | unsupported |
| Root/admin ou processus malveillant du même utilisateur | hors isolation |

La documentation Node précise que les opérations Promise ne sont ni
synchronisées ni thread-safe, que le flag exclusif peut être peu fiable sur un
filesystem réseau, et que `FileHandle.sync()` dépend de l'OS et du device :
[Node.js fs](https://nodejs.org/download/release/latest-v22.x/docs/api/fs.html).
POSIX spécifie l'atomicité de `rename` :
[The Open Group](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html).
Windows documente le remplacement et les erreurs liées aux droits/handles,
mais la propriété retenue reste soumise au test de conformance :
[MoveFileEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa).

Le probe local Windows a confirmé `sync()` sur un fichier writable et un
remplacement de destination, mais `sync()` sur le dossier parent a échoué avec
`EPERM`. Ce résultat suffit à exclure une promesse de power-loss durability ;
il ne certifie pas NTFS en général.

## Plateformes et runtime

Node 20 est EOL depuis le 24 mars 2026. Le writer ne sera déclaré supporté que
sur les lignes Node 22 et 24 encore maintenues :
[calendrier Node.js](https://nodejs.org/en/about/previous-releases).

Avant de clore le lot, la matrice minimale est :

- Windows 11 et Windows Server sur NTFS, Node 22 et 24 ;
- Ubuntu sur ext4, Node 22 et 24 ;
- macOS sur APFS, Node 22 et 24 avant toute distribution multi-hôte.

Chaque couple reste `unsupported` tant que les tests réels de lock, temp,
file-sync, rename, permissions, handles ouverts, crash et recovery ne sont pas
verts. Les ACL, ownership et attributs doivent être comparés avant/après ; si
le remplacement ne préserve pas la politique déclarée, le writer s'arrête
avant mutation ou cette plateforme reste hors support.

## Tests et gates avant approbation du lot

- au moins cent terminaisons réelles de subprocess réparties avant, pendant et
  après chaque opération persistante, par domaine et plateforme supportée ;
- `ENOSPC`, `EACCES`, `EPERM`, cible ouverte, temp verrouillé et cleanup refusé
  à chaque frontière ;
- deux writers coopératifs, lock incomplet, lock stale et absence totale
  d'auto-break ;
- substitution de cible ou parent par symlink, junction, hardlink, autre inode
  byte-identique et path case-alias ;
- mutation externe avant la dernière vérification et état inconnu au recovery ;
- previews avec contrôles terminal, bidi, faux prompts et charges maximales ;
- refus des pipes, redirections, flags d'auto-confirmation et appels sans TTY ;
- gate AST writer exact : modules atteignables, bindings, modes d'ouverture,
  chemins, mutateurs et ordre autorisés ; aucun relâchement du core, report,
  serveur ou CLI read-only ;
- zéro cible absente, tronquée ou différente de `{ancien, nouveau confirmé}` ;
- diagnostic de recovery borné, sans chemin absolu, contenu brut ou secret
  ajouté aux logs et reçus.

## Alternatives

- **Journal multi-fichier : différé.** Nécessite génération persistante et
  protocole de readers ; pas une évolution transparente.
- **SQLite sidecar : rejeté.** Sa transaction ne peut pas englober un rename
  JSON. SQLite n'est pertinent que s'il devient l'autorité canonique, ce qui
  constitue une migration distincte.
- **Git : rejeté comme moteur.** Tous les workspaces ne sont pas Git et un
  working tree n'est pas une transaction applicative.
- **Helper natif : différé.** Il peut améliorer `ReplaceFileW`, flush de
  directory ou ACL par OS, mais ajoute packaging et supply-chain sans résoudre
  l'atomicité multi-fichier.
- **Backup automatique : rejeté au v1.** Il duplique des octets canoniques
  potentiellement sensibles et introduit un second protocole de rollback. Le
  v1 récupère uniquement par classification ancien/nouveau.

## Réconciliation des revues

Architecture, sécurité et fiabilité ont rejeté le draft initial pour les mêmes
raisons : CAS non coopératif improuvable, transaction multi-JSON non atomique,
confirmation humaine non authentifiable et durabilité plateforme-dépendante.
Leur réduction mono-fichier est retenue.

Gemini 3.6 Flash a utilement détaillé les états avant/après `rename`, les échecs
Windows `EACCES`/`EPERM`, `ENOSPC` au commit et le caractère secondaire du reçu.
Ses propositions d'auto-nettoyage d'un lock stale, de timestamp dans le digest
et d'API acceptant un chemin absolu sont rejetées : elles casseraient
respectivement l'autorité humaine, le déterminisme et la frontière de chemins.

## Gate humain restant

Cette ADR autorise seulement la correction du contrat. Avant toute
implémentation, une personne doit approuver explicitement le contrat draft
révisé et accepter ses garanties limitées, en particulier : mono-fichier,
writers coopératifs, absence d'undo, exclusion des dossiers synchronisés et
absence de power-loss durability prouvée sous Windows.
