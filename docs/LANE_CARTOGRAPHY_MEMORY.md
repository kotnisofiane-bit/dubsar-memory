# Cartographie — voie mémoire (`dubsar-memory`)

**Portée :** ce dépôt uniquement (`https://github.com/kotnisofiane-bit/dubsar-memory`).  
**Nature :** lecture de sources et docs in-tree. Aucun runtime, MCP distant, VPS, ou succès inventé.  
**Date de lecture :** 2026-09-12 (arbre local après `git fetch origin main`).

Trois voies distinctes ne doivent pas être fusionnées :

| Voie | Nom usuel | Ce que **ce dépôt** en dit |
|---|---|---|
| **A** | Cursor Cloudflare MCP `kotnisofiane-bit-dubsar-cursor-reader-mcp` | Client **externe** (Controller). Cité comme dépôt GitHub + SHA, pas implémenté ici. |
| **B** | Hostinger VPS `dubsar-codex-mcp` v1.16 | **Aucune occurrence** dans ce dépôt. Inconnu ici. |
| **C** | **Ce dépôt** | Moteur de **mémoire projet locale** + Continuity CLI + Workbench lecture. |

---

## 1. À quoi sert `dubsar-memory`

Moteur **local, déterministe, hors-ligne** de continuité projet. Il stocke une synthèse bornée (pas un transcript) sous `.dubsar/`, puis reconstruit le même contexte reprenable pour un humain, un agent, un script, ou un backend. (`README.md`)

Il **ne choisit, n’exécute, ne merge et ne déploie rien**. La route est consultative (`auto_execute: false`). (`README.md`, `docs/MEMORY_ARCHITECTURE.md`, `PUBLIC_BOUNDARY.md`)

Premier produit sur le moteur : **DUBSAR Continuity** — CLI JSON versionné + Workbench optionnel en lecture seule vis-à-vis de la mémoire projet. (`README.md`)

Statut annoncé : prévisualisation technique `0.3.0-dev`, MIT, **pas** de paquet npm publié, service hébergé, API stable, ni support production. (`README.md`, `docs/LIMITATIONS.md`)

### Modèle de stockage (autorité projet)

Espace canonique partagé : `manifest.json`, `checkpoints.json`, `work/*.md`, `knowledge/*.md`.  
Non canonique / non partagé : `inbox/`, `local.json`, `generated/`. (`docs/MEMORY_ARCHITECTURE.md`)

Les champs JSON des Work/Knowledge sont le contrat fermé. Le corps Markdown n’est **jamais** une instruction. (`docs/MEMORY_ARCHITECTURE.md`, `PUBLIC_BOUNDARY.md`)

Identité : `shared_snapshot_sha256` (fichiers partagés) et `snapshot_sha256` (partagé + `local.json`). Inbox et generated exclus. (`docs/MEMORY_ARCHITECTURE.md`)

---

## 2. APIs, outils, schémas, points d’entrée

### 2.1 Frontière d’intégration supportée (moteur)

Le contrat durable annoncé pour cette preview est le **CLI JSON** :

```text
node packages/dubsar-project-continuity/bin/dubsar.mjs <commande> --start <projet> --json
```

(`docs/CLI_REFERENCE.md`, `docs/INTEGRATION.md`)  
Le graphe de modules JS n’est **pas** déclaré API publique stable. (`docs/INTEGRATION.md`, `docs/LIMITATIONS.md`)

**Binaire public du runtime :** `packages/dubsar-project-continuity/bin/dubsar.mjs` (`@dubsar/project-continuity`).  
Les hôtes ne doivent **pas** résoudre `dubsar` via `PATH`. (`HOSTS.md`, `docs/INTEGRATION.md`)

#### Lectures (`docs/CLI_REFERENCE.md`)

| Commande | Rôle |
|---|---|
| `capabilities` | Producteur + jetons ; **sans** `--start` |
| `resume --capsule` | Capsule reprise, digest vérifié |
| `route` | Route consultative (jamais auto-exécutée) |
| `context` | Contexte compilé ; écriture seulement avec `--write` |
| `history` | Continuité en ordre d’append |
| `work list` / `knowledge list` / `knowledge show` | Inventaire |
| `inbox list` | Notes locales, aperçus bornés |
| `precedents` | Correspondances **exactes** seulement |
| `lots` | Compatibilité anciens workspaces |
| `pending list` | Candidats sous `.dubsar-pending/` ; **n’écrit pas** |

#### Écritures explicites (preview puis `--apply --expected-change <change_sha256>`)

`init`, `bootstrap`, `work create|select|status`, `inbox add|promote`, `knowledge retire`, `checkpoint`, `pending record`, `pending promote`, `context --write`, `migrate --to-memory-vnext`, `close` (TTY). (`docs/CLI_REFERENCE.md`, `packages/dubsar-project-continuity/README.md`)

Tickets My Work via le **launcher** (pas le runtime mémoire) : `tickets create|transition|activity`, `tickets attach-cursor-launch|fail-cursor-launch`. Pas d’appel MCP dans ces verbes. (`docs/CLI_REFERENCE.md`)

#### Jetons `dubsar.runtime-capabilities/1`

Déclarés dans `packages/dubsar-project-continuity/runtime/cli.mjs` (`RUNTIME_CAPABILITIES`) :

- `memory.atomic-bootstrap.v1`
- `memory.pending-checkpoint-list.v1`
- `memory.pending-checkpoint-promotion.v1`
- `memory.pending-checkpoint-record.v1`
- `memory.reference-freshness.v1`
- `memory.resume-capsule.v4`
- `memory.route.v2`
- `memory.workspace-vnext.v1`
- `write.preview-apply.v1`

Formats cités : `dubsar.resume-capsule/3` (session-open observé) / docs capsule v4 token ; `dubsar.memory-route/2` ; `dubsar.pending-checkpoints-list/1` ; propositions `dubsar.memory-init-proposal/1`, `dubsar.memory-bootstrap-proposal/1`, `dubsar.memory-change-proposal/1`, `dubsar.pending-checkpoint-proposal/1`. Vérifier le champ `format` à l’exécution plutôt que d’inférer depuis le numéro de paquet. (`docs/INTEGRATION.md`)

#### Ponts Cursor Cloud **de ce dépôt** (pas la voie A)

Ce ne sont **pas** des verbes CLI du runtime. (`docs/CLI_REFERENCE.md`)

```text
node tools/cursor-cloud/install.mjs
node tools/cursor-cloud/open-session.mjs --start .
node tools/cursor-cloud/record-pending.mjs --start . --contract <contrat> --proposal <json hors projet>
```

Ils résolvent `bin/dubsar.mjs` depuis le checkout. `open-session` est lecture. `record-pending` n’écrit que `.dubsar-pending/` si le contrat de lot a `authorize_pending_checkpoint: true`. Ils ne lancent **pas** d’agent Cursor. (`.cursor/rules/dubsar-memory-cursor-cloud.mdc`, `HOSTS.md`)

#### Adapters hôtes (skills, pas le cœur)

- `resume-project-context`
- `checkpoint-project-context`

dans `packages/dubsar-project-continuity/skills/`. Codex / Claude / Cursor optionnels. (`HOSTS.md`, `docs/INTEGRATION.md`)

### 2.2 Workbench (projection, pas autorité)

Packages : `dubsar-operator-cli`, `dubsar-operator-core`, `dubsar-workbench-server`, `dubsar-workbench-launcher`, `dubsar-workbench-report`.  
Serveur : loopback `127.0.0.1`, une page HTML déjà rendue, pas d’API métier ni réseau sortant. (`packages/dubsar-workbench-server/README.md`, `docs/WORKBENCH.md`)  
N’écrit pas `.dubsar/`, n’exécute pas `route`. (`README.md`)

### 2.3 MCP **dans ce dépôt** (pas le moteur, pas A)

`PUBLIC_BOUNDARY.md` et `docs/MEMORY_ARCHITECTURE.md` listent les **serveurs MCP** comme **hors produit / non-feature** du format mémoire.  
Pourtant le monorepo contient `packages/dubsar-my-work-mcp` (privé, `0.1.0-dev`) : stdio local pour ChatGPT Work. (`README.md`, `docs/MY_WORK_MCP.md`)

Entrée : `node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs`  
CLI machine : `connect`, `status`. (`docs/MY_WORK_MCP.md`)

Outils MCP locaux (`packages/dubsar-my-work-mcp/src/tools.mjs`, `TOOL_NAMES`) :

| Outil | Mutation |
|---|---|
| `list_tickets` | non |
| `get_ticket` | non |
| `prepare_cursor_mission` | ticket local + arguments Controller, **sans** réseau |
| `launch_cursor_mission` | un ticket + **un** `tools/call` Controller |
| `continue_cursor_mission` | un run Controller, **sans** nouvel agent |
| `attach_cursor_receipt` | reçu local |
| `sync_cursor_status` | mapping Cursor/GitHub déjà existant |

Ce MCP **n’expose pas** les noms d’outils du Controller. Il **appelle** le Controller distant (voie A) : `create_dubsar_work_cursor_agent` et `create_dubsar_work_cursor_agent_run`. (`docs/MY_WORK_MCP.md`, `packages/dubsar-my-work-mcp/src/mission-args.mjs`)

OAuth : `~/.dubsar/my-work-controller/credentials.json` ou `DUBSAR_MY_WORK_CONFIG_DIR`. Jamais dans le git. (`docs/MY_WORK_MCP.md`)  
Le runtime Continuity **n’a pas** de client réseau. (`docs/INTEGRATION.md`, `SECURITY.md`)

### 2.4 Adapter Codex Workbench (pas B)

`packages/dubsar-codex-workbench` : plugin Codex **dans ce repo**. Skills `resume-dubsar-workbench`, `launch-dubsar-work`, `sync-dubsar-work`.  
`CAPABILITIES.json` : `mcp: frozen_cursor_controller_launch`, `remote_mutation: bounded_cursor_agent_creation`.  
Ce n’est **pas** `dubsar-codex-mcp` VPS, **pas** Herdr, **pas** Codex CLI machine. Aucune citation de ces noms ici.

`launch-dubsar-work` documente l’amont lecture : dépôt `kotnisofiane-bit/kotnisofiane-bit-dubsar-cursor-reader-mcp` SHA `9ea48ce17735b6585cf5816060afc4345b1a50cf` (PR26 `90a35ac…`). (`packages/dubsar-codex-workbench/skills/launch-dubsar-work/SKILL.md`)

### 2.5 Autres packages

| Package | Rôle déclaré |
|---|---|
| `dubsar-personal-memory` | Mémoire perso opt-in, racine OS séparée, **aucune** autorité projet |
| `dubsar-audit-readiness` | Historique gelé, pas produit actif (`PUBLIC_BOUNDARY.md`) |
| `integrations/spec-kit/` | Extension Spec Kit ; autorité `.specify/` vs `.dubsar/` séparée |

### 2.6 Ce que ce dépôt n’expose pas

- Liste complète des outils Worker Cloudflare (voie A) : seulement les **deux** noms d’outils Controller cités plus haut.
- Tout outil, schéma, ou version de `dubsar-codex-mcp` / Herdr / controller VPS (voie B).
- Daemon, Git hook, embeddings, recherche sémantique, multi-tenant. (`docs/LIMITATIONS.md`)

---

## 3. Ce que cette voie ne peut **jamais** faire

D’après les contrats **in-tree** (pas une opinion) :

| Interdit / hors scope | Source |
|---|---|
| Exécuter `route`, Plan/Goal, reviewer, sous-agent | `docs/MEMORY_ARCHITECTURE.md`, `PUBLIC_BOUNDARY.md` |
| Prouver merge, déploiement, conformité, vérité | `docs/LIMITATIONS.md` |
| Ingestion de transcripts, embeddings, appel modèle | `README.md`, `docs/LIMITATIONS.md` |
| Identité projet = branche Git ; hooks ; daemon | `docs/MEMORY_ARCHITECTURE.md` |
| Écrire `AGENTS.md`, `CLAUDE.md`, règles Cursor, hooks | `PUBLIC_BOUNDARY.md`, règle Cursor Cloud |
| `pending record` / `open-session` = promotion canonique | ADR worktrees, `docs/CLI_REFERENCE.md`, `HOSTS.md` |
| Lancer un agent Cursor **depuis le runtime Continuity** | Le runtime n’a pas de client réseau (`docs/INTEGRATION.md`) |
| Être le Worker Cloudflare Cloud Agents API | Implémentation absente ; seulement citations SHA vers un **autre** repo |
| Être le MCP VPS Codex / Herdr | **Zéro** fichier ne nomme `dubsar-codex-mcp`, Herdr, ou un VPS Hostinger |

**Nuance honnête :** `launch_cursor_mission` et le skill `launch-dubsar-work` **peuvent** déclencher **une** création d’agent **via A**, si credentials Controller et réseau sont configurés **hors** du moteur. Ce n’est **pas** « la mémoire a lancé un agent ». C’est un client optionnel qui **forward** un contrat vers A. Un ACK de plumbing (stdio MCP, OAuth `status`, `tools/call` soumis) n’est **pas** un OK mémoire ni un OK agent.

`prepare_cursor_mission` et `tickets attach-cursor-launch` sont de la persistance locale. (`docs/CLI_REFERENCE.md`, `docs/MY_WORK_MCP.md`)

---

## 4. Un vrai OK **mémoire seule**

Règle Sofiane : **OK ≠ ACK de tuyauterie**.

### Est un OK mémoire

1. Inspection live du workspace : contrats `.dubsar/` valides, chemins sûrs, `integrity` cohérente avec les octets. (`docs/MEMORY_ARCHITECTURE.md`)
2. Lectures : `format` reconnu, exit `0`, digest de capsule / snapshot **recalculé** égal à celui déclaré (`capsule_sha256`, `snapshot_sha256`). (`docs/CLI_REFERENCE.md`, `docs/INTEGRATION.md`)
3. Écriture : preview → humain confirme **exactement** `change_sha256` → apply → réinspection ; un fichier canonique (ou publish atomique `init`/`bootstrap`/`migrate` selon le verbe). Digest périmé = rejet, pas retry magique. (`docs/CLI_REFERENCE.md`)
4. Référence « verified » : les **octets locaux** au moment du checkpoint matchent le digest enregistré. Ce n’est **pas** « le code est juste / mergé / déployé ». (`docs/LIMITATIONS.md`)
5. `pending record` OK = fichier sous `.dubsar-pending/<source>/<id>.md` seulement. **Pas** une entrée `checkpoints.json`. (`docs/DUBSAR_PARALLEL_WORKTREE_CHECKPOINTS_ADR.md`)
6. `pending promote` OK = **une** entrée append dans `checkpoints.json` après preview, fichier pending inchangé. Interdit aux ponts Cursor Cloud de ce repo. (`HOSTS.md`, règle Cursor Cloud)
7. `route` OK = document `dubsar.memory-route/2` avec `auto_execute: false`. **Exécuter** la recommandation n’est jamais un OK mémoire.

`readiness: ready` = évaluation locale des **enregistrements** (sélection Work, blockers enregistrés, etc.). Ce n’est pas « le lot logiciel est fini ». Session-open `status: ready` = le pont a lu ; `state.readiness: not_ready` peut coexister (observé sur ce checkout : mémoire vide / pas de Work choisi).

### N’est **pas** un OK mémoire

- `capabilities --json` (identité runtime, pas d’état projet)
- `npm test` / CI vert / merge d’implémentation (`HOSTS.md` sur LOT-MEM-002)
- `open-session.mjs` qui imprime une capsule
- fichier pending `cp-lot-mem-002.md`
- `connect` / `status` My Work MCP
- `launch_cursor_mission` qui a soumis un `tools/call`
- URL d’agent Cursor, PR GitHub, job Cloudflare
- n’importe quoi sur un VPS Codex (non décrit ici)

LOT-MEM-002 : source mergée + qualify technique ≠ admission humaine, ≠ `pending promote`, ≠ déploiement. (`HOSTS.md`)

---

## 5. Lien avec A et B — citations seulement

### Voie A — Cursor Cloudflare MCP / Controller

**Dans ce dépôt, A est un amont nommé, pas un package.**

- Skill : « Read-only upstream: `kotnisofiane-bit/kotnisofiane-bit-dubsar-cursor-reader-mcp` » + SHA `9ea48ce17735b6585cf5816060afc4345b1a50cf`. (`packages/dubsar-codex-workbench/skills/launch-dubsar-work/SKILL.md`)
- Vecteurs : `"controller_repository": "https://github.com/kotnisofiane-bit/kotnisofiane-bit-dubsar-cursor-reader-mcp"` (`packages/dubsar-my-work-mcp/vectors/controller-*.json`)
- Outils Controller **appelés** (pas exposés en My Work) : `create_dubsar_work_cursor_agent`, `create_dubsar_work_cursor_agent_run`. (`docs/MY_WORK_MCP.md`, `mission-args.mjs`)
- Docs My Work : reçus `dubsar.cursor-launch-receipt/1` / `dubsar.cursor-run-receipt/1` ; observation Codex du Controller, **cette session n’a pas lu** le repo privé. (`docs/MY_WORK_MCP.md`)

**Non inventé ici :** que A soit un Worker Cloudflare, Cloud Agents API, ou le nom MCP Cursor `…-cursor-reader-mcp`. Ce repo ne décrit pas l’implémentation Worker. Il dit seulement « Controller » + ces tools + ce SHA.

Les ponts `tools/cursor-cloud/*` **consomment** la CLI mémoire **dans** un agent Cursor déjà lancé. Ils ne **sont pas** A.

### Voie B — VPS `dubsar-codex-mcp` / Herdr / Codex CLI machine

Recherche in-tree des chaînes `dubsar-codex-mcp`, `codex-controller`, `Herdr`, Hostinger VPS : **aucun hit**.

Présent avec « Codex » : adapters marketplace Continuity (`HOSTS.md`) et `packages/dubsar-codex-workbench` (skills Workbench + lancement **Controller A**).  
**Ne pas** identifier ce package avec B.

Relation C↔B : **non documentée** dans ce dépôt. Inconnu.

### Voie C — ce dépôt

Cœur : `.dubsar/` + `@dubsar/project-continuity`.  
Workbench = vue.  
My Work MCP / launch skill = **clients optionnels vers A**, en tension avec `PUBLIC_BOUNDARY.md` (« MCP servers … excluded »). Cartographier la tension, ne pas la résoudre.

---

## Inconnus et tensions documentaires

1. **Voie B** : absence totale de source ici.
2. **Surface réelle de A** au-delà des deux tools + SHA : non vérifiable sans lire A.
3. **Produit vs monorepo :** `PUBLIC_BOUNDARY.md` / `SECURITY.md` / `MEMORY_ARCHITECTURE.md` (« no MCP server ») vs `packages/dubsar-my-work-mcp` et README qui le documentent. Frontière « public engine » vs « package privé in-tree » non tranchée par un seul fichier.
4. Index `docs/README.md` (engineering) dit encore que le design candidate/promotion worktrees « is not implemented » ; l’ADR et le CLI décrivent Lots 1–3 implémentés. Préférer ADR + `CLI_REFERENCE.md`.
5. Capsule : token `memory.resume-capsule.v4` vs format session `dubsar.resume-capsule/3` — versions de **contrats différents** ; ne pas les conflater sans le JSON réel.

---

## Verdict (une phrase)

**C** = mémoire projet locale déterministe (CLI / `.dubsar/` / Workbench RO) ; **A** = Controller Cursor nommé ailleurs, seulement *appelé* par un MCP/skill optionnel ; **B** = hors de ce dépôt. Un OK C est un snapshot/digest/preview-apply (ou pending explicitement borné). Ce n’est jamais un ACK stdio, un `tools/call`, un agent Cursor, ou un MCP VPS.
