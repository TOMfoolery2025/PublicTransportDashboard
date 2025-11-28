import os
from flask import Flask, render_template, jsonify, request
from neo4j import GraphDatabase
from dotenv import load_dotenv
from geopy.distance import geodesic


app = Flask(__name__)
load_dotenv()

# --- CONFIGURATION ---
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")
NEO4J_DB = "gtfs"

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


# --- CACHE STOPS ---
# We load these once at startup.
# IMPORTANT: We use the exact keys your 'index.html' expects ("stop_id", "stop_name").
def load_all_stops():
    print("Loading stops from Neo4j...")
    query = """
    MATCH (s:Stop) 
    RETURN s.stop_id AS stop_id, s.name AS stop_name, s.lat AS lat, s.lon AS lon
    ORDER BY s.name
    """
    with driver.session() as session:
        result = session.run(query)
        data = [record.data() for record in result]
    print(f"Cached {len(data)} stops.")
    return data


# Load immediately on start
all_stops = load_all_stops()


@app.route('/')
def index():
    # Center map on Munich
    munich_center = [48.1351, 11.5820]
    return render_template('index.html', stops=all_stops, center=munich_center)


@app.route('/api/path')
def get_path():
    start_id = request.args.get("start")
    end_id = request.args.get("end")

    if not start_id or not end_id:
        return jsonify({"error": "start and end are required"}), 400

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
                        start_point = current_final["points"][0]
                        end_point = next_leg["points"][-1]
                        current_final["points"] = [start_point, end_point]
                    else:
                        final_legs.append(current_final)
                        current_final = next_leg

                final_legs.append(current_final)

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