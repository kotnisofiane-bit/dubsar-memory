# Contrat local `dubsar.tickets/1`

`dubsar.tickets/1` est le registre personnel, local et déterministe de **DUBSAR My Work**. Il complète les Work existants sans modifier `dubsar.work/1`.

## Identité et stockage

Les identifiants affichés sont alloués séquentiellement de `DUB-001` à `DUB-999`. Le compteur et les tickets sont conservés dans `.dubsar/tickets.json`; la lecture d'un registre absent retourne une vue vide en mémoire et ne crée aucun fichier. Un ticket peut référencer un `work_id` existant.

## Écritures

Création, transition et activité passent par le même moteur pour la CLI et le canal Dashboard :

1. `previewTicketChange` calcule la conséquence et `change_sha256` sans écrire ;
2. l'utilisateur confirme cette empreinte exacte ;
3. `applyTicketChange` recalcule l'aperçu depuis l'état courant et refuse une empreinte obsolète avant publication atomique.

La CLI accepte `dubsar tickets list|create|transition|activity`. Les opérations d'écriture sont fournies dans un fichier de proposition, jamais comme commande arbitraire issue du Dashboard.

## États et preuves

États : Backlog, To Do, In Progress, In Review, Blocked, Paused, Done, Cancelled, Duplicate. `Duplicate` exige la cible d'un autre ticket. Sortir de Done, Cancelled ou Duplicate exige `reopen_confirmed: true` lors d'une action distincte et confirmée.

Le passage à Done exige une preuve structurée `github_merge` réellement vérifiée : URL de pull request GitHub, indicateur `merged`, indicateur `verified` et SHA de commit de fusion. Un rapport textuel d'agent n'est jamais accepté.

## Activité

Chaque entrée possède un index enregistré strictement croissant et un digest incluant le digest précédent. Le registre conserve au plus 200 entrées par ticket. L'interface décrit cet ordre comme un **ordre enregistré**, jamais comme une chronologie en l'absence de date fiable provenant de la source.

## Sécurité et limites

Le registre est local. Le serveur Workbench reste exclusivement sur IPv4 loopback, sans CORS large, chemin libre ni accès sortant. Les vues Resume, Memory et Graph demeurent disponibles dans la section Advanced.
