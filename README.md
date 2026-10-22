# prim-mcp — itinéraires IDF pour Claude

Serveur MCP (HTTP, stateless) qui expose l'API PRIM d'Île-de-France Mobilités à Claude :
itinéraires temps réel avec lignes imposées / évitées, heure d'arrivée max, prochains passages
et info trafic (perturbations, travaux, grèves).

## Outils exposés

| Outil | Rôle | API PRIM |
|---|---|---|
| `plan_journey` | Itinéraire + horaires temps réel + retards + perturbations des lignes empruntées | Navitia `journeys`, `places`, `pt_objects` + Info Trafic |
| `traffic_info` | Perturbations / grèves sur des lignes, maintenant → +N heures | Messages Info Trafic (requête globale) |
| `next_departures` | Prochains passages temps réel à un arrêt, filtrables par ligne | Navitia `departures` |
| `search_places` | Lever une ambiguïté sur une adresse / gare | Navitia `places` |

Sur le portail PRIM, vérifie que ton jeton a bien accès à l'API Navitia (calcul d'itinéraires)
et à « Messages Info Trafic – requête globale ».

## Installation

```bash
cp .env.example .env      # puis renseigne PRIM_API_KEY et MCP_SECRET
openssl rand -hex 32      # pour générer MCP_SECRET
npm install
npm run dev               # ou : npm run build && npm start
```

### Déploiement (Docker Compose + Traefik)

Le service rejoint le réseau externe `infra-network` et est exposé par Traefik via les labels
sur `prim.home.leodubosclard.com` (à adapter dans `docker-compose.yml`).

```bash
git clone git@github.com:leodubosclard/prim-mcp.git && cd prim-mcp
cp .env.example .env    # PRIM_API_KEY, MCP_SECRET
docker compose up -d --build
```

Mise à jour : `git pull && docker compose up -d --build` — logs : `docker compose logs -f prim-mcp`.

## Brancher dans Claude

Ajoute un connecteur personnalisé dans les réglages de Claude avec l'URL
`https://prim.home.leodubosclard.com/mcp/<MCP_SECRET>`, puis active-le dans la conversation.
Le secret dans l'URL empêche des inconnus de consommer ton quota PRIM : traite cette URL comme un mot de passe.

## Exemples

> Je veux partir du 53 boulevard Voltaire à Asnières et arriver à Saint-Lazare au plus tard à 8h50
> en prenant le 277 ou le 238 puis la ligne L.

→ `plan_journey` avec `datetime_represents: "arrival"`, `datetime: "08:50"`,
`allowed_lines: ["Bus 277", "Bus 238", "Transilien L"]`.

> Y a-t-il une grève prévue sur la L ou le RER A cette semaine ? → `traffic_info` (`horizon_hours: 168`)

> Prochains 238 à l'arrêt Voltaire ? → `next_departures`

## Bon à savoir

- **Lignes** : toujours préciser le mode (« Bus 277 », « Transilien L ») ; un code seul comme « L »
  peut correspondre à plusieurs lignes, elles sont alors toutes autorisées.
- **`allowed_lines`** restreint aux seules lignes listées (la marche reste possible). L'ordre
  « bus puis train » n'est pas imposé, mais Navitia ne proposera pas d'autre combinaison.
- **Grèves (best effort)** : deux sources sont croisées, les perturbations renvoyées par Navitia
  sur chaque tronçon et l'API Info Trafic. `likely_strike` est une détection par mots-clés
  (grève, mouvement social, préavis…). Les plans de transport en cas de grève sont parfois publiés
  tard ou partiellement : si rien n'est signalé, ça ne garantit pas l'absence de grève.
- **Quotas** : l'API Info Trafic a un quota journalier serré pour les jetons récents ;
  elle est mise en cache (`DISRUPTIONS_CACHE_SECONDS`, 120 s par défaut).
- Toutes les heures sont en heure de Paris.
