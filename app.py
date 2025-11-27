import os
import zipfile
import pandas as pd
from flask import Flask, render_template, jsonify, request
import networkx as nx
from neo4j import GraphDatabase
from dotenv import load_dotenv

app = Flask(__name__)

load_dotenv()

GTFS_ZIP_PATH = os.getenv("GTFS_ZIP_PATH", "gtfw-data-stops-trips.zip")
TRAIN_ROUTE_TYPES = {0, 1, 2}


def load_non_train_route_ids(zip_path):
    """Read routes.txt to identify non-train route IDs (as strings)."""
    with zipfile.ZipFile(zip_path, "r") as z:
        with z.open("routes.txt") as f:
            routes = pd.read_csv(f, dtype={"route_id": str})
    return routes[~routes["route_type"].isin(TRAIN_ROUTE_TYPES)]["route_id"].unique().tolist()


def fetch_graph_from_neo4j(route_ids):
    """Load stops and edges from Neo4j filtered by the provided route IDs."""
    uri = os.getenv("NEO4J_URI")
    user = os.getenv("NEO4J_USER")
    password = os.getenv("NEO4J_PASSWORD")
    if not all([uri, user, password]):
        raise RuntimeError("NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD must be set in the environment.")

    driver = GraphDatabase.driver(uri, auth=(user, password), encrypted=False)

    def get_stops(tx):
        query = """
        MATCH (s:Stop)
        RETURN toString(s.stop_id) AS stop_id, s.name AS stop_name, s.lat AS stop_lat, s.lon AS stop_lon
        """
        return [record.data() for record in tx.run(query)]

    def get_edges(tx, route_ids):
        query = """
        MATCH (r:Route)-[:HAS_TRIP]->(t:Trip)-[:HAS_STOP_TIME]->(st1:StopTime)-[:NEXT]->(st2:StopTime)
        WHERE r.route_id IN $route_ids
        RETURN DISTINCT toString(st1.stop_id) AS source, toString(st2.stop_id) AS target
        """
        return [record.data() for record in tx.run(query, route_ids=route_ids)]

    with driver.session() as session:
        stops_data = session.execute_read(get_stops)
        edges_data = session.execute_read(get_edges, route_ids=route_ids)

    driver.close()
    return stops_data, edges_data


def build_graph(stops_data, edges_data):
    """Construct a NetworkX graph from stop and edge records."""
    G = nx.Graph()
    for stop in stops_data:
        lat, lon = stop.get("stop_lat"), stop.get("stop_lon")
        if pd.isna(lat) or pd.isna(lon):
            continue
        G.add_node(
            stop["stop_id"],
            name=stop.get("stop_name", str(stop["stop_id"])),
            pos=(lat, lon),
        )

    for edge in edges_data:
        u = edge.get("source")
        v = edge.get("target")
        if u in G and v in G:
            G.add_edge(u, v)

    return G


print("Loading route filters from GTFS zip...")
NON_TRAIN_ROUTE_IDS = load_non_train_route_ids(GTFS_ZIP_PATH)
print(f"Non-train routes: {len(NON_TRAIN_ROUTE_IDS)}")

print("Fetching stops and edges from Neo4j...")
stops_data, edges_data = fetch_graph_from_neo4j(NON_TRAIN_ROUTE_IDS)
print(f"Fetched {len(stops_data)} stops and {len(edges_data)} edges.")

G = build_graph(stops_data, edges_data)
connected_nodes = {n for n, deg in G.degree() if deg > 0}

stops_list = sorted(
    [
        {
            "stop_id": stop_id,
            "stop_name": data.get("name", str(stop_id)),
            "lat": data.get("pos", (None, None))[0],
            "lon": data.get("pos", (None, None))[1],
        }
        for stop_id, data in G.nodes(data=True)
        if stop_id in connected_nodes
    ],
    key=lambda s: s["stop_name"],
)


def normalize_stop_id(raw_id):
    """Normalize stop IDs to string to match graph node types."""
    if raw_id is None:
        return None
    return str(raw_id)

@app.route('/')
def index():
    """
    Renders the main page with the map and controls.
    """
    # Default center on Munich; client will refine bounds after loading
    munich_center = [48.1351, 11.5820]
    return render_template('index.html', stops=stops_list, center=munich_center)


@app.route('/api/path')
def get_path():
    """
    Compute the shortest path between two stops on the server graph.
    Returns an ordered list of coordinates for Leaflet.
    """
    start_id = normalize_stop_id(request.args.get("start"))
    end_id = normalize_stop_id(request.args.get("end"))

    if not start_id or not end_id:
        return jsonify({"error": "start and end are required"}), 400

    try:
        stop_sequence = nx.shortest_path(G, source=start_id, target=end_id)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return jsonify({"error": "No path found"}), 404

    coords = []
    for stop_id in stop_sequence:
        node = G.nodes[stop_id]
        lat, lon = node.get("pos", (None, None))
        coords.append(
            {
                "stop_id": stop_id,
                "stop_name": node.get("name", str(stop_id)),
                "lat": lat,
                "lon": lon,
            }
        )

    return jsonify({"path": coords})


@app.route('/api/network')
def get_network():
    """
    Return all stops and edges with coordinates for drawing the bus network.
    """
    stops = [
        {
            "stop_id": stop_id,
            "stop_name": data.get("name", str(stop_id)),
            "lat": data.get("pos", (None, None))[0],
            "lon": data.get("pos", (None, None))[1],
        }
        for stop_id, data in G.nodes(data=True)
        if stop_id in connected_nodes
    ]

    edges = []
    for u, v in G.edges():
        u_node = G.nodes[u]
        v_node = G.nodes[v]
        u_pos = u_node.get("pos")
        v_pos = v_node.get("pos")
        if not u_pos or not v_pos:
            continue
        if u not in connected_nodes or v not in connected_nodes:
            continue
        edges.append(
            {
                "from": u,
                "to": v,
                "coords": [(u_pos[0], u_pos[1]), (v_pos[0], v_pos[1])],
            }
        )

    return jsonify({"stops": stops, "edges": edges})

if __name__ == '__main__':
    app.run(debug=True)
