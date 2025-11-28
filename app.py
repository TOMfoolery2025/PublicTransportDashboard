import os
from flask import Flask, render_template, jsonify, request
from neo4j import GraphDatabase
from dotenv import load_dotenv
from geopy.distance import geodesic
import requests


app = Flask(__name__)
load_dotenv()

# --- CONFIGURATION ---
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")
NEO4J_DB = "gtfs"
STOPS_API_URL = "https://civiguild.com/api/stops"

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


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


@app.route('/')
def index():
    # Center map on Munich
    munich_center = [48.1351, 11.5820]
    return render_template('index.html', stops=all_stops, center=munich_center)


@app.route('/api/path')
def get_path():
    start_id = request.args.get("start")
    end_id = request.args.get("end")

    # Optional coordinates coming from geocoded addresses or map clicks
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
        message = "start and end are required"
        if (start_point and not start_id) or (end_point and not end_id):
            message = "No nearby transit stop found for the provided locations"
        return jsonify({"error": message}), 400

    query = """
    MATCH (start:Stop {stop_id: $start_id}), (end:Stop {stop_id: $end_id})
    MATCH path = shortestPath((start)-[:TRANSIT_ROUTE|WALK*]-(end))
    RETURN path
    """

    try:
        with driver.session() as session:
            result = session.run(query, start_id=start_id, end_id=end_id).single()

            if not result:
                return jsonify({"error": "No path found"}), 404

            path = result["path"]
            legs = []

            def get_data(node):
                return {
                    "lat": node.get('lat') or node.get('stop_lat'),
                    "lon": node.get('lon') or node.get('stop_lon'),
                    "name": node.get('name'),
                    "id": node.get('stop_id')
                }

            nodes = path.nodes
            relationships = path.relationships

            # --- PASS 1: INITIAL GROUPING ---
            current_leg = {"mode": "START", "route": "", "points": [get_data(nodes[0])]}

            for i, rel in enumerate(relationships):
                rel_type = rel.type
                node_data = get_data(nodes[i + 1])

                if rel_type == "WALK":
                    new_mode = "WALK"
                    route_label = "Walk"
                else:
                    new_mode = rel.get("type", "Bus")
                    route_label = rel.get("route_name", "")

                should_merge = False
                # Merge if same mode AND same route name
                if new_mode == "WALK" and current_leg["mode"] == "WALK":
                    should_merge = True
                elif new_mode == current_leg["mode"] and route_label == current_leg.get("route"):
                    should_merge = True

                if should_merge:
                    current_leg["points"].append(node_data)
                else:
                    if current_leg["mode"] != "START": legs.append(current_leg)
                    current_leg = {"mode": new_mode, "route": route_label,
                                   "points": [current_leg["points"][-1], node_data]}

            legs.append(current_leg)

            # --- PASS 2: CONVERT SHORT RIDES TO WALK ---
            legs_pass_2 = [l for l in legs if l["mode"] != "START"]

            for leg in legs_pass_2:
                # If it's a short hop (2 points) and NOT already a walk
                if leg["mode"] != "WALK" and len(leg["points"]) == 2:
                    p1 = leg["points"][0]
                    p2 = leg["points"][1]
                    try:
                        dist = geodesic((p1['lat'], p1['lon']), (p2['lat'], p2['lon'])).meters
                        if dist < 500:
                            leg["mode"] = "WALK"
                            leg["route"] = "Walk"
                    except:
                        pass

            # --- PASS 3: FINAL MERGE & SIMPLIFY ---
            final_legs = []
            if legs_pass_2:
                current_final = legs_pass_2[0]

                for i in range(1, len(legs_pass_2)):
                    next_leg = legs_pass_2[i]

                    # MERGE LOGIC
                    if current_final["mode"] == "WALK" and next_leg["mode"] == "WALK":
                        # CRITICAL FIX: Simplify geometry!
                        # Instead of A->B->C, just do A->C
                        start_pt = current_final["points"][0]
                        end_pt = next_leg["points"][-1]
                        current_final["points"] = [start_pt, end_pt]
                    else:
                        final_legs.append(current_final)
                        current_final = next_leg

                final_legs.append(current_final)

            # Prepend/append walk legs for off-network start/end points
            def add_walk_leg(existing_legs, walk_points, to_start=True):
                if not walk_points:
                    return existing_legs

                # Skip microscopic movements
                try:
                    leg_dist = geodesic(
                        (walk_points[0]["lat"], walk_points[0]["lon"]),
                        (walk_points[-1]["lat"], walk_points[-1]["lon"])
                    ).meters
                    if leg_dist < 5:
                        return existing_legs
                except Exception:
                    pass

                walk_leg = {"mode": "WALK", "route": "Walk", "points": walk_points}

                if existing_legs:
                    if to_start and existing_legs[0]["mode"] == "WALK":
                        existing_legs[0]["points"] = walk_points[:1] + existing_legs[0]["points"]
                        return existing_legs
                    if not to_start and existing_legs[-1]["mode"] == "WALK":
                        existing_legs[-1]["points"] = existing_legs[-1]["points"] + walk_points[-1:]
                        return existing_legs

                if to_start:
                    return [walk_leg] + existing_legs
                return existing_legs + [walk_leg]

            if start_point and nearest_start:
                start_walk_points = [
                    {"lat": start_point["lat"], "lon": start_point["lon"], "name": start_point.get("name", "Start")},
                    {"lat": nearest_start["lat"], "lon": nearest_start["lon"], "name": nearest_start.get("name"), "id": nearest_start.get("stop_id")},
                ]
                final_legs = add_walk_leg(final_legs, start_walk_points, to_start=True)

            if end_point and nearest_end:
                end_walk_points = [
                    {"lat": nearest_end["lat"], "lon": nearest_end["lon"], "name": nearest_end.get("name"), "id": nearest_end.get("stop_id")},
                    {"lat": end_point["lat"], "lon": end_point["lon"], "name": end_point.get("name", "Destination")},
                ]
                final_legs = add_walk_leg(final_legs, end_walk_points, to_start=False)

            return jsonify({"legs": final_legs})

    except Exception as e:
        print(f"Error: {e}")
        return jsonify({"error": str(e)}), 500

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



if __name__ == '__main__':
    app.run(debug=True)
