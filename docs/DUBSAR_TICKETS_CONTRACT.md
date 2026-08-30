# Contrat local `dubsar.tickets/1`

`dubsar.tickets/1` est le registre personnel, local et déterministe de **DUBSAR My Work**. Il complète les Work existants sans modifier `dubsar.work/1`.

## Identité et stockage

Les identifiants affichés sont alloués séquentiellement de `DUB-001` à `DUB-999`. Les tickets restent dans `.dubsar/tickets.json` de leur projet, tandis que le launcher conserve le compteur mono-utilisateur global dans `ticket-allocations.json`, à côté de son registre de projets. Deux projets ne peuvent donc pas recevoir le même identifiant, y compris après redémarrage. La lecture d'un registre absent retourne une vue vide en mémoire et ne crée aucun fichier. Un ticket peut référencer un `work_id` existant.

## Écritures

Création, transition et activité passent par le même moteur pour la CLI et le canal Dashboard :

1. `previewTicketChange` calcule la conséquence et `change_sha256` sans écrire ;
2. l'utilisateur confirme cette empreinte exacte ;
3. `applyTicketChange` recalcule l'aperçu depuis l'état courant et refuse une empreinte obsolète avant publication atomique.

La CLI du launcher accepte `tickets list|create|transition|activity|attach-cursor-launch|fail-cursor-launch`. Les opérations d'écriture sont fournies dans un fichier de proposition, jamais comme commande arbitraire issue du Dashboard.

### Lancement Cursor borné

`attach-cursor-launch` vise un ticket existant. Une seule publication atomique conserve le reçu Controller exact : `receipt_version` (`dubsar.cursor-launch-receipt/1` ou `dubsar.cursor-run-receipt/1`), `target_repository_url`, `contract_fingerprint`, `repository_refs`, `ticket_id`, `agent_id`, `run_id`, `source_url`, `status` et `bounds`, puis place le ticket `In Progress`. Le dépôt cible est une URL GitHub HTTPS complète, chaque référence est exactement `{repository_url, starting_sha}`, et l'empreinte est exactement `sha256:` suivi de 64 caractères hexadécimaux minuscules. Le reçu doit porter le même `ticket_id`; l'ancien schéma local `format`/`target_repository`/hex64 est refusé. `fail-cursor-launch` ne crée aucun identifiant d'agent : il ajoute seulement une activité bornée avec un code, conserve le résumé comme blocage et place atomiquement le ticket `Blocked`.

Ces opérations ne contactent aucun MCP. L'orchestrateur doit d'abord appliquer et relire la création du ticket, puis appeler une seule fois le Controller, comparer `ticket_id` et le `contract_fingerprint` obtenu par la canonicalisation exacte du Controller, préfixe `sha256:` inclus, et enfin prévisualiser/appliquer l'attachement. My Work ne fait qu'afficher le reçu local. Aucun secret n'appartient au registre.

## États et preuves

États : Backlog, To Do, In Progress, In Review, Blocked, Paused, Done, Cancelled, Duplicate. `Duplicate` exige la cible d'un autre ticket. Sortir de Done, Cancelled ou Duplicate exige `reopen_confirmed: true` lors d'une action distincte et confirmée.

Le passage à Done reçoit seulement une déclaration `github_claim`. Le moteur n'accorde aucune autorité à ses booléens et échoue si aucun observer de confiance n'est injecté. Cet observer doit corroborer exactement le dépôt, la PR, le SHA de fusion et l'identifiant du ticket sous l'autorité `trusted_github_observer`; toute divergence est refusée. Aucun accès réseau n'existe dans le moteur pur et un rapport textuel d'agent n'est jamais accepté.

## Activité

Chaque entrée possède un index enregistré strictement croissant et un digest incluant le digest précédent. Le registre conserve au plus 200 entrées par ticket. L'interface décrit cet ordre comme un **ordre enregistré**, jamais comme une chronologie en l'absence de date fiable provenant de la source.

## Sécurité et limites

Le registre est local. Le serveur Workbench reste exclusivement sur IPv4 loopback, sans CORS large, chemin libre ni accès sortant. Son canal d'action accepte uniquement deux routes de capability same-origin (`tickets/preview/` et `tickets/apply/`), des corps JSON bornés et le projet d'une allowlist construite par le launcher. My Work fournit groupes d'état, recherche, filtres projet/état, fiche détaillée, aperçu et confirmation. Le français est la langue initiale et l'anglais est sélectionnable. Les vues Resume, Memory et Graph demeurent disponibles dans la section Advanced.

Le lancement public sans `--start`, utilisé par le raccourci standard, agrège les tickets de tous les projets du registre sûr et route chaque écriture par son `project_id`. Les créations globales sont sérialisées par un verrou local exclusif; une confirmation concurrente devenue obsolète est refusée sans doublon ni allocation partielle. Après `apply`, le reçu transporte la nouvelle projection agrégée pour rafraîchir My Work.

La frontière GitHub demeure volontairement **non raccordée** : sans observer de confiance injecté, `Done` échoue fermé. Le lot de lancement ne fait ni polling Cursor/GitHub, ni webhook, ni transition automatique vers In Review ou Done.

## Récupération du verrou d'allocation

Le verrou global est un document borné `dubsar.ticket-allocation-lock/1` contenant une identité aléatoire et une lease locale exacte de 30 secondes. Une lease non expirée est considérée active et n'est jamais supprimée ni volée. Après expiration, un récupérateur doit d'abord acquérir atomiquement `ticket-allocations.recovery.lock`, relire et comparer exactement le verrou observé, puis déplacer l'ancien verrou avant de publier le sien. Un second récupérateur échoue donc occupé. Un verrou malformé, surdimensionné, symbolique, hardlinké ou dont le temps ne peut être interprété échoue fermé. La récupération ne lit ni n'expose son contenu dans les diagnostics.
