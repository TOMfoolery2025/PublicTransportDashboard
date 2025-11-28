import heapq
import os
from flask import Flask, render_template, jsonify, request
from neo4j import GraphDatabase
from dotenv import load_dotenv
from geopy.distance import geodesic
import requests
from bus_stop_widget import register_bus_stop_widget


app = Flask(__name__)
load_dotenv()

# --- CONFIGURATION ---
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")
NEO4J_DB = "gtfs"
STOPS_API_URL = "https://civiguild.com/api/stops"

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


def ensure_gds_graph_exists():
    graph_name = "munich_transit"
    try:
        with driver.session() as session:
            # 1. Drop the old graph so we can re-project without 'gds_weight'
            session.run("CALL gds.graph.drop($name, false)", name=graph_name)

            print(f"Projecting GDS Graph '{graph_name}' (Standard Weights)...")

            # 2. Project using standard 'weight' only
            session.run("""
                        CALL gds.graph.project(
                        $name,
                        'Stop',
                        {
                          TRANSIT_ROUTE: {
                                           type:        'TRANSIT_ROUTE',
                                           properties:  'weight',
                                           orientation: 'NATURAL'
                                         },
                          WALK:          {
                                           type:        'WALK',
                                           properties:  'weight',
                                           orientation: 'NATURAL'
                                         }
                        }
                        )
                        """, name=graph_name)
            print(f"Graph '{graph_name}' projected successfully.")

    except Exception as e:
        print(f"Warning: Could not project GDS graph. Error: {e}")


# Call immediately
ensure_gds_graph_exists()

# --- CACHE STOPS ---
# We load these once at startup.
# IMPORTANT: We use the exact keys your 'index.html' expects ("stop_id", "stop_name").
def load_all_stops():
    print(f"Fetching stops from {STOPS_API_URL}...")
    try:
        # Request data from your external server
        response = requests.get(STOPS_API_URL)
        response.raise_for_status()  # Check for 200 OK

        raw_data = response.json()

        # Transform the data to match what index.html expects
        clean_data = []
        for item in raw_data:
            # Your JSON uses 'stop_lat', but frontend might expect 'lat'.
            # We map it here.
            clean_data.append({
                "stop_id": str(item.get("stop_id")),  # Convert to string for HTML value safety
                "stop_name": item.get("stop_name"),
                "lat": item.get("stop_lat"),
                "lon": item.get("stop_lon")
            })

        print(f"Cached {len(clean_data)} stops from API.")
        return clean_data

    except Exception as e:
        print(f"Error fetching stops from API: {e}")
        # Return empty list or fallback to local file if you have one
        return []


# Load immediately on start
all_stops = load_all_stops()
register_bus_stop_widget(app, all_stops)


def find_nearest_stop(lat, lon):
    """Return the closest stop from the cached list with its distance."""
    closest = None
    closest_distance = float("inf")

    for stop in all_stops:
        try:
            dist = geodesic((lat, lon), (float(stop['lat']), float(stop['lon']))).meters
        except Exception:
            continue

        if dist < closest_distance:
            closest_distance = dist
            closest = {
                "stop_id": stop["stop_id"],
                "name": stop.get("stop_name") or stop.get("name"),
                "lat": float(stop["lat"]),
                "lon": float(stop["lon"]),
                "distance": dist,
            }

    return closest


def build_legs_from_hops(hops):
    """
    PASS 1: Basic Merging (Identical adjacent modes)
    PASS 2: Smart Merging (Absorb small walks between identical routes)
    """
    if not hops: return []

    # --- PASS 1: Basic Grouping ---
    raw_legs = []
    current_leg = None

    for hop in hops:
        # Normalize Mode
        mode = "Bus"
        if hop['mode'] == 'WALK':
            mode = 'WALK'
        elif hop['route']:
            rn = str(hop['route']).upper()
            if rn.startswith('U'):
                mode = 'U-Bahn'
            elif rn.startswith('S'):
                mode = 'S-Bahn'
            elif 'TRAM' in rn or (rn.isdigit() and int(rn) < 40):
                mode = 'Tram'

        route_label = hop['route'] if mode != 'WALK' else 'Walk'
        node_data = hop['e']

        if current_leg is None:
            current_leg = {
                "mode": mode,
                "route": route_label,
                "points": [hop['s'], hop['e']]
            }
            continue

        should_merge = False
        if mode == 'WALK' and current_leg['mode'] == 'WALK':
            should_merge = True
        elif mode == current_leg['mode'] and route_label == current_leg.get('route'):
            should_merge = True

        if should_merge:
            current_leg['points'].append(node_data)
        else:
            raw_legs.append(current_leg)
            current_leg = {
                "mode": mode,
                "route": route_label,
                "points": [current_leg['points'][-1], node_data]
            }
    if current_leg: raw_legs.append(current_leg)

    # --- PASS 2: ABSORB SMALL WALKS (Leg Smoothing) ---
    # We look for pattern: [Transit A] -> [Walk < 200m] -> [Transit A]
    # We merge this into a single [Transit A] leg.

    smoothed_legs = []
    i = 0
    while i < len(raw_legs):
        current = raw_legs[i]

        # Check if we can bridge over the NEXT leg
        if i + 2 < len(raw_legs):
            next_leg = raw_legs[i + 1]
            after_next = raw_legs[i + 2]

            # Pattern Check:
            # 1. Current is Transit
            # 2. Next is WALK
            # 3. After_Next is SAME Transit Route
            if (current['mode'] != 'WALK' and
                    next_leg['mode'] == 'WALK' and
                    after_next['mode'] == current['mode'] and
                    after_next['route'] == current['route']):

                # Check walk distance (heuristic)
                # Calculate simple distance of the walk leg
                walk_pts = next_leg['points']
                try:
                    dist = geodesic(
                        (walk_pts[0]['lat'], walk_pts[0]['lon']),
                        (walk_pts[-1]['lat'], walk_pts[-1]['lon'])
                    ).meters
                except:
                    dist = 9999

                if dist < 300:  # Bridge gaps smaller than 300m
                    # MERGE ALL THREE
                    # We just concatenate the points: Current + Walk + After
                    # Note: Points overlap at edges, so we slice
                    merged_points = current['points'] + next_leg['points'][1:] + after_next['points'][1:]
                    current['points'] = merged_points

                    # Skip the next two legs since we consumed them
                    i += 2

        smoothed_legs.append(current)
        i += 1

    return smoothed_legs


def add_walk_leg_helper(existing_legs, walk_points, to_start=True):
    # (Same helper as before)
    if not walk_points: return existing_legs
    try:
        dist = geodesic((walk_points[0]["lat"], walk_points[0]["lon"]),
                        (walk_points[-1]["lat"], walk_points[-1]["lon"])).meters
        if dist < 5: return existing_legs
    except:
        pass

    walk_leg = {"mode": "WALK", "route": "Walk", "points": walk_points}
    if existing_legs:
        if to_start and existing_legs[0]["mode"] == "WALK":
            existing_legs[0]["points"] = walk_points[:1] + existing_legs[0]["points"]
            return existing_legs
        if not to_start and existing_legs[-1]["mode"] == "WALK":
            existing_legs[-1]["points"] = existing_legs[-1]["points"] + walk_points[-1:]
            return existing_legs
    return [walk_leg] + existing_legs if to_start else existing_legs + [walk_leg]

@app.route('/')
def index():
    # Center map on Munich
    munich_center = [48.1351, 11.5820]
    return render_template('index.html', stops=all_stops, center=munich_center)


@app.route('/api/path')
def get_path():
    start_id = request.args.get("start")
    end_id = request.args.get("end")

    # [Standard coordinate handling]
    start_lat = request.args.get("start_lat", type=float)
    start_lon = request.args.get("start_lon", type=float)
    end_lat = request.args.get("end_lat", type=float)
    end_lon = request.args.get("end_lon", type=float)
    start_label = request.args.get("start_label")
    end_label = request.args.get("end_label")

    start_point = None
    end_point = None
    nearest_start = None
    nearest_end = None

    if start_lat is not None and start_lon is not None:
        start_point = {"lat": start_lat, "lon": start_lon, "name": start_label or "Start"}
        nearest_start = find_nearest_stop(start_lat, start_lon)
        start_id = nearest_start["stop_id"] if nearest_start else None

    if end_lat is not None and end_lon is not None:
        end_point = {"lat": end_lat, "lon": end_lon, "name": end_label or "Destination"}
        nearest_end = find_nearest_stop(end_lat, end_lon)
        end_id = nearest_end["stop_id"] if nearest_end else None

    if not start_id or not end_id:
        return jsonify({"error": "Start and End required"}), 400

    print(f"--- Calculating Optimal Path (Smart Merging) ---")

    # CONFIGURATION
    K_PATHS = 50
    BOARDING_PENALTY = 0  # 5 mins (Wait time)
    TRANSFER_PENALTY = 600  # 10 mins (Line change)
    WALKING_FACTOR = 0.2

    # --- 1. CANDIDATE GENERATION ---
    query_candidates = """
    MATCH (source:Stop {stop_id: $start_id}), (target:Stop {stop_id: $end_id})
    CALL gds.shortestPath.yens.stream('munich_transit', {
        sourceNode: source,
        targetNode: target,
        k: $k,
        relationshipWeightProperty: 'weight'
    })
    YIELD path
    RETURN [n in nodes(path) | n.stop_id] as node_ids
    """

    # --- 2. DETAILS LOOKUP ---
    query_details = """
    UNWIND range(0, size($node_ids)-2) as i
    MATCH (a:Stop {stop_id: $node_ids[i]}), (b:Stop {stop_id: $node_ids[i+1]})
    MATCH (a)-[r]-(b)
    RETURN 
        i,
        a.stop_id as s_id, a.name as s_name, a.lat as s_lat, a.lon as s_lon,
        b.stop_id as e_id, b.name as e_name, b.lat as e_lat, b.lon as e_lon,
        collect({
            type: type(r),
            route: r.route_name,
            weight: r.weight 
        }) as options
    ORDER BY i
    """

    best_legs = None
    best_score = float('inf')
    best_stats = {}
    best_path_idx = -1

    try:
        with driver.session() as session:
            candidates_result = session.run(query_candidates, start_id=start_id, end_id=end_id, k=K_PATHS)
            candidates = [rec["node_ids"] for rec in candidates_result]

            if not candidates:
                return jsonify({"error": "No path found"}), 404

            print(f"Evaluating {len(candidates)} candidate paths...")

            for path_idx, node_ids in enumerate(candidates):
                details_result = session.run(query_details, node_ids=node_ids)
                hops = list(details_result)

                # State Tracking
                current_route_name = "START"
                last_transit_route = None  # Remembers route even across walks

                path_score = 0
                processed_hops = []

                # Debug Counters
                real_transfers = 0
                pure_travel_time = 0

                for hop in hops:
                    options = hop['options']
                    selected_option = None

                    # --- SMART STICKINESS ---
                    # 1. Try to stick to current route (immediate)
                    if current_route_name not in ["START", "Walk"]:
                        for opt in options:
                            if opt['route'] == current_route_name:
                                selected_option = opt
                                break

                    # 2. If currently walking, try to stick to LAST transit route (re-boarding same bus)
                    if not selected_option and current_route_name == "Walk" and last_transit_route:
                        for opt in options:
                            if opt['route'] == last_transit_route:
                                selected_option = opt
                                break

                    if not selected_option:
                        sorted_opts = sorted(options, key=lambda x: x['weight'] if x['weight'] is not None else 9999)
                        selected_option = sorted_opts[0]

                        # --- SCORING ---
                        target_type = selected_option['type']
                        target_route = selected_option['route']

                        is_transit = (target_type != "WALK")

                        # A) Boarding: Start -> Bus
                        if current_route_name == "START" and is_transit:
                            path_score += BOARDING_PENALTY

                        # B) Transfer/Re-board: Walk -> Bus OR Bus A -> Bus B
                        elif current_route_name != "START" and is_transit:
                            # Are we getting back on the same bus we just walked from?
                            if target_route == last_transit_route:
                                pass  # Free re-boarding (same line)
                            else:
                                # It is a new line
                                if last_transit_route is None:
                                    # Walk -> Bus (First bus after start walk)
                                    path_score += BOARDING_PENALTY
                                else:
                                    # Bus A -> ... -> Bus B
                                    path_score += TRANSFER_PENALTY
                                    real_transfers += 1

                    # --- UPDATE STATE ---
                    if selected_option['type'] != "WALK":
                        current_route_name = selected_option['route']
                        last_transit_route = selected_option['route']
                    else:
                        current_route_name = "Walk"
                        # Do NOT clear last_transit_route here! (Allows bridging gaps)

                    raw_weight = selected_option['weight'] or 0
                    pure_travel_time += raw_weight

                    if selected_option['type'] == "WALK":
                        path_score += (raw_weight * WALKING_FACTOR)
                    else:
                        path_score += raw_weight

                    processed_hops.append({
                        "s": {"id": hop['s_id'], "name": hop['s_name'], "lat": hop['s_lat'], "lon": hop['s_lon']},
                        "e": {"id": hop['e_id'], "name": hop['e_name'], "lat": hop['e_lat'], "lon": hop['e_lon']},
                        "mode": selected_option['type'],
                        "route": selected_option['route'],
                        "weight": raw_weight
                    })

                if path_idx < 50:
                    print(
                        f"Path {path_idx}: Time={int(pure_travel_time / 60)}m, Transfers={real_transfers}, Score={int(path_score)}")

                if path_score < best_score:
                    best_score = path_score
                    best_legs = build_legs_from_hops(processed_hops)  # Uses new merging logic
                    best_path_idx = path_idx
                    best_stats = {"time": int(pure_travel_time / 60), "transfers": real_transfers,
                                  "score": int(path_score)}

            print("--------------------------------------------------")
            print(f"🏆 SELECTED WINNER: Path {best_path_idx}")
            print(f"   Score:     {best_stats.get('score')}")
            print(f"   Time:      {best_stats.get('time')} min")
            print(f"   Transfers: {best_stats.get('transfers')}")
            print("--------------------------------------------------")

            if start_point and nearest_start:
                pts = [{"lat": start_point["lat"], "lon": start_point["lon"], "name": start_point["name"]},
                       {"lat": nearest_start["lat"], "lon": nearest_start["lon"], "name": nearest_start.get("name")}]
                best_legs = add_walk_leg_helper(best_legs, pts, True)

            if end_point and nearest_end:
                pts = [{"lat": nearest_end["lat"], "lon": nearest_end["lon"], "name": nearest_end.get("name")},
                       {"lat": end_point["lat"], "lon": end_point["lon"], "name": end_point["name"]}]
                best_legs = add_walk_leg_helper(best_legs, pts, False)

            return jsonify({"legs": best_legs, "debug_score": best_score})

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# [Helpers build_legs_from_hops and add_walk_leg_helper remain the same]

@app.route('/api/network')
def get_network():
    """
    Restores the 'network' view.
    NOTE: We return ALL stops, but we keep 'edges' empty by default.
    Drawing 300,000+ lines (the real network) will freeze your browser instantly.
    """
    return jsonify({
        "stops": all_stops,
        "edges": [],  # Intentionally empty for performance
        "routes": []  # Intentionally empty for performance
    })


@app.route('/api/trip_stops/<trip_id>')
def get_trip_stops(trip_id):
    """
    Fetch ordered stops for a given trip_id from the external API.
    """
    url = f"https://civiguild.com/api/trips/allStops/{trip_id}"
    try:
        res = requests.get(url, timeout=5)
        res.raise_for_status()
        data = res.json() or []
        stops = sorted(data, key=lambda s: s.get("sequence", 0))
        formatted = [
            {
                "sequence": s.get("sequence"),
                "stop_id": s.get("stop_id"),
                "stop_name": s.get("stop_name"),
                "lat": s.get("stop_lat"),
                "lon": s.get("stop_lon"),
            }
            for s in stops
        ]
        if not formatted:
            return jsonify({"stops": [], "message": "No stops found"}), 404
        return jsonify({"stops": formatted})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/route/<route_name>')
def get_route_by_name(route_name):
    """
    Return edges for a given route name so the frontend can display its shape.
    We return simple segments between stops that share the same route_name
    plus the unique stops for drawing markers.
    """
    query = """
    MATCH (a:Stop)-[r:TRANSIT_ROUTE {route_name: $route_name}]-(b:Stop)
    RETURN DISTINCT a.stop_id AS from_id, a.lat AS from_lat, a.lon AS from_lon,
                    b.stop_id AS to_id, b.lat AS to_lat, b.lon AS to_lon,
                    collect(DISTINCT {id: a.stop_id, name: a.name, lat: a.lat, lon: a.lon}) AS stops_a,
                    collect(DISTINCT {id: b.stop_id, name: b.name, lat: b.lat, lon: b.lon}) AS stops_b
    """
    try:
        with driver.session() as session:
            result = session.run(query, route_name=route_name)
            segments = []
            stops_set = {}
            for record in result:
                segments.append({
                    "from": {
                        "id": record["from_id"],
                        "lat": record["from_lat"],
                        "lon": record["from_lon"]
                    },
                    "to": {
                        "id": record["to_id"],
                        "lat": record["to_lat"],
                        "lon": record["to_lon"]
                    }
                })
                for s in record.get("stops_a", []):
                    stops_set[str(s["id"])] = s
                for s in record.get("stops_b", []):
                    stops_set[str(s["id"])] = s
        if not segments:
            return jsonify({"segments": [], "route_name": route_name, "message": "No segments found"}), 404
        return jsonify({"segments": segments, "route_name": route_name, "stops": list(stops_set.values())})
    except Exception as e:
        return jsonify({"error": str(e)}), 500



if __name__ == '__main__':
    app.run(debug=True, port=8080)
