from flask import Flask, render_template, jsonify, request
import networkx as nx
import pickle

app = Flask(__name__)

# Load the pre-processed graph and stops data
GRAPH_PATH = "munich_graph.gpickle"

print("Loading transit graph...")
with open(GRAPH_PATH, "rb") as f:
    G = pickle.load(f)
print("Graph loaded.")

# Limit to stops that participate in at least one edge
connected_nodes = {n for n, deg in G.degree() if deg > 0}

# Build a lightweight stop list for the UI from the graph itself
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
    """Convert numeric strings to int to match graph node types."""
    try:
        return int(raw_id)
    except (TypeError, ValueError):
        return raw_id

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
