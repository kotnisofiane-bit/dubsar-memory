# Copilot — surface `dubsar-memory` (profil documentation)

La politique Copilot canonique vit dans `kotnisofiane-bit/dubsar-platform`,
fichiers `delivery-control/COPILOT_POLICY.md` et
`delivery-control/copilot-policy-matrix.json`. Ce fichier est un pointeur
local. Il ne remplace pas cette politique, ne recopie ni le registre, ni les
pins, ni des SHA observés, et n’est pas une admission canonique.

Ce dépôt applique le profil **documentation**.

## Autorisé

- lecture du dépôt ;
- pré-revue ;
- détection de dérive documentaire ;
- propositions documentaires bornées.

## Interdit

- merge ;
- approbation finale ou GO ;
- déploiement (Cloudflare ou autre) ;
- secrets, PAT, permissions, rulesets ou réglages GitHub ;
- modification de pins, contrats, ADR ou frontières de sécurité ;
- admissions canoniques (y compris promotion mémoire / `pending promote`) ;
- création autonome de branche ou de PR tant qu’un E2E Copilot distinct n’est
  pas qualifié.

## Place dans le gate

Cursor reste l’exécutant principal. Copilot est une couche secondaire de
lecture et de relecture. Il n’entre pas dans le gate
**Work → Cursor → GitHub → audit Work → GO humain**.

`AGENTS.md`, les règles Cursor et les capsules DUBSAR ne sont pas une
politique Copilot.

## Preuves

Distinguer **fait**, **inférence** et **non vérifiable**. Un fichier présent
dans le dépôt ne prouve aucune activation UI GitHub/Copilot.
