# MaxMaps (Rust API + Leaflet UI)

## 1) Project Overview
Munich MaxMaps is a transit exploration tool built around a Rust Rocket API backed by Neo4j/SQLite, plus a Leaflet UI. It exposes GTFS-derived stop, route, and departure data, and the UI lets users pin start/end locations, build transit routes, and inspect upcoming departures, individual transport lines or find public transport vehicles on map in real-time. A lightweight Flask shell is  used to serve the UI and compute paths via Neo4j; the Rust service is the primary data backend.

Key features
- GTFS/Neo4j-powered stops and routes served via Rust/Rocket.
- Departures (scheduled/live) and trip stop sequences from SQLite + civiguild.
- Leaflet UI: address search, pin start/end, mode-colored legs with distance/time estimates, route summaries.
- Stop popups with grouped departures; click a route number to draw that line (with stops). Mutual exclusion between “constructed” (user) and “transport” routes.
- Multiple basemaps, zoom-gated stop rendering for performance.

Tech stack
- Backend: Rust, Neo4j, SQLite. Flask (Python) remains as a UI/pathfinding shell.
- Frontend: Leaflet + JS/CSS, HTML template.
- External services: civiguild (stops, departures, trip stops), Nominatim (geocoding), OSRM (bus geometry), Carto/OSM tiles.

Knowledge graph usage
- Neo4j stores the transit knowledge graph: Stop nodes with geocoordinates and stop metadata; relationships for transit links (`TRANSIT_ROUTE`) and walking links (`WALK`). Route segments for a given `route_name` are queried directly from this graph.
- Pathfinding (Flask shell) runs Neo4j `shortestPath` over the graph, then post-processes legs (merge walks, add connectors, simplify geometry).
- Rust endpoints read from Neo4j for stop listings and can be extended to serve graph-driven routes; SQLite holds GTFS tabular data that complements the graph.

## 2) Architecture Overview
Layers
- Rust API (`api/src`): Rocket routes for agency, stops, departures, trip stop sequences; uses SQLite (GTFS tables) and Neo4j (stop graph). Live updates stored in DashMap.
- UI/pathfinding shell (`app.py`): Flask routes for UI, Neo4j shortestPath, route geometry, trip stops proxy, minimal stop info.
- Frontend (`templates/index.html`, `static/script.js`, `static/style.css`): Leaflet map, search/pins, routing render, popups, basemap control. Stop popups and departures are rendered client-side in JS.
- Data: Neo4j transit graph (Stop nodes, `TRANSIT_ROUTE`/`WALK` edges). SQLite GTFS for Rocket endpoints. civiguild for departures and trip stops.

Configuration & secrets
- Rust: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`; Rocket database `transport` configured via `ROCKET_DATABASES` for SQLite; optional live update settings.
- Flask: same Neo4j vars; `DEPARTURES_DAYS_AGO`, `DEPARTURES_API_BASE` for legacy use.

## 3) Routing & Request Flow
Rust (Rocket) routes (`api/src/endpoints.rs`)
- `GET /agency/<id>` — agency from SQLite.
- `GET /stops` — all stops (Neo4j).
- `GET /stops/<id>` — stop details from SQLite.
- `GET /departures/<stop_id>` — departures (timestamp + delay) from live store/SQLite.
- `GET /trips/allStops/<trip_id>` — ordered stop sequence for a trip from SQLite.

Flask shell routes (`app.py`)
- `/` — serves UI with cached stops.
- `/api/path` — Neo4j `shortestPath` over `TRANSIT_ROUTE|WALK`, merges legs, adds walk connectors.
- `/api/trip_stops/<trip_id>` — proxies civiguild trip stops.
- `/api/route/<route_name>` — Neo4j segments + stops for a route.
- `/api/stops/<stop_id>` — minimal stop metadata (departures handled in JS directly from civiguild).

Frontend flow
- Constructed route: start/end (search or pin) → `/api/path` → legs drawn; map click clears constructed route/pins once built.
- Transport route: click stop popup route → civiguild trip stops or `/api/route/<name>` → draw line + stops; clears constructed route first; map click clears.
- Departures: JS fetches civiguild `departures/<stop_id>`, groups by route, shows minutes only.

Middleware: None explicit beyond Rocket/Flask defaults; per-route try/except.

## 4) API Documentation (key)
Rust (Rocket)
- `GET /agency/<id>` → 200 JSON or 404.  
  Example: `curl http://localhost:8000/agency/1`
- `GET /stops` → 200 JSON array of `{stop_id, stop_name, stop_lat, stop_lon}`.  
  Example: `curl http://localhost:8000/stops`
- `GET /stops/<id>` → 200 JSON stop info or 404.  
  Example: `curl http://localhost:8000/stops/17651`
- `GET /departures/<stop_id>` → 200 JSON array of `{route_short_name, trip_id, departure_timestamp, delay, live}`.  
  Example: `curl http://localhost:8000/departures/17651`
- `GET /trips/allStops/<trip_id>` → 200 JSON array of ordered stops.  
  Example: `curl http://localhost:8000/trips/allStops/17651`

Flask (UI/helper)
- `GET /api/path?start=<stop_id>&end=<stop_id>[&start_lat&start_lon&end_lat&end_lon]`
- `GET /api/route/<route_name>`
- `GET /api/trip_stops/<trip_id>`
- `GET /api/stops/<stop_id>`

Frontend-only calls
- civiguild departures: `https://civiguild.com/api/departures/<stop_id>`
- Nominatim search; OSRM routing for bus geometry.

## 5) Code Structure & File Roles
```
.
├─ api/
│  └─ src/
│     ├─ main.rs          # Rocket launch: DB pool, Neo4j graph, live update store, mounts endpoints
│     ├─ endpoints.rs     # Routes for agency, stops, departures, trip stops; uses SQLite + Neo4j
│     ├─ liveupdates.rs   # Live update store (DashMap), listener scaffolding
├─ app.py                 # Flask shell: serves UI, pathfinding via Neo4j, route segments, trip stops proxy
├─ static/
│  ├─ script.js           # Leaflet UI: search/pins, routing render, popups, transport routes, clearing logic
│  └─ style.css           # Styling for layout, map controls, popups, pins
├─ templates/
│  └─ index.html          # HTML shell; injects stop cache and map center
├─ requirements.txt       # Python deps for Flask shell
└─ README.md / README(5).md
```

## 6) How to Run Locally
Rust API
1) Prereqs: Rust toolchain, Neo4j running, SQLite GTFS DB configured. Env: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `ROCKET_DATABASES` for SQLite `transport`.
2) From `api/`:
```bash
cargo run
```
3) API on Rocket default port (e.g., 8000).

Flask + UI shell
1) Prereqs: Python 3.10+, Neo4j populated, internet for civiguild/Nominatim/OSRM.
2) Install:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```
3) Env:
```
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=yourpassword
DEPARTURES_DAYS_AGO=0
DEPARTURES_API_BASE=https://civiguild.com/api/departures
```
4) Run UI:
```bash
python app.py
```
5) Open `http://localhost:8080`.

## 7) Build, Deployment & Environments
- Rust: `cargo build --release`; deploy Rocket with Neo4j + SQLite access; configure env vars and `ROCKET_DATABASES`.
- Flask shell: run under WSGI (gunicorn/uwsgi) if retained; ensure Neo4j/env vars.
- Static assets served directly; no bundler. No explicit env profiles; rely on env vars.

## 8) Data Storage & Integrations
Storage
- Neo4j: stop graph with `stop_id`, `name`, `lat`, `lon`; `TRANSIT_ROUTE`/`WALK` edges. Used by Rust and Flask.
- SQLite: GTFS tables (Agency, Stops, Routes, Trips, StopTimes) for Rocket endpoints and departures.
- In-memory: DashMap for live departures (Rust).

Integrations
- civiguild: stops (cached in Python), departures (frontend direct), trip stops (Flask proxy), live data for Rust.
- Nominatim: geocoding (frontend).
- OSRM: bus routing geometry (frontend).
- Carto/OSM: basemap tiles.

#

