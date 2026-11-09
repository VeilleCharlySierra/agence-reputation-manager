# Agence Reputation Manager

Plateforme de veille e-réputation pour agences de communication, opérée par Viral SARL.
Chaque agence reçoit sa propre plateforme (nom, logo, couleurs) reliée au socle de collecte Viral.

- `index.html` : la plateforme (page unique, hébergée sur GitHub Pages).
- `supabase/functions/gerer-utilisateur/` : création et gestion des comptes.
- Base Supabase : projet `agence-reputation-manager` (séparé de la veille CIE).

## Rôles

| Rôle | Voit | Peut faire |
| --- | --- | --- |
| Super administrateur Viral | Tout, journal compris | Tout, y compris l'image de marque |
| Administrateur Viral | Tout sauf le journal | Paramétrage, image de marque, comptes d'agence |
| Administrateur agence | Tous les clients de l'agence | Clients, marques, termes, comptes, critères (à la hausse) |
| Utilisateur agence | Les clients qui lui sont attribués | Suivre, épingler, points d'attention |
| Utilisateur client | Son seul client | Consulter |

## Changer d'agence (rebranding)

L'image de marque se règle dans Administration › Image de marque (comptes Viral uniquement) :
nom de la plateforme, nom de l'agence, couleurs et logo. Aucune modification de code n'est nécessaire.
