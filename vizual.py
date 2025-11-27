import os
import zipfile
import pandas as pd
import folium
from folium.plugins import MarkerCluster
import geopandas as gpd
import osmnx as ox
from shapely.geometry import Point
import networkx as nx
from tqdm import tqdm
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

# --- Configuration ---
GTFS_ZIP_PATH = "/Users/sergey/PycharmProjects/tomfoolery-hackathon/gtfw-data-stops-trips.zip"  # Ensure this path is correct
# Check credentials
driver = GraphDatabase.driver(os.getenv("NEO4J_URI"), auth=(os.getenv("NEO4J_USER"), os.getenv("NEO4J_PASSWORD")), encrypted=False)

# --- Get the boundary of Munich from OpenStreetMap ---
print("Fetching Munich boundary from OpenStreetMap...")
munich_boundary = ox.geocode_to_gdf("München, Germany")
print("Boundary fetched.")

# --- Load Supplementary Data from Archive ---
print("Loading supplementary GTFS data from zip file...")
with zipfile.ZipFile(GTFS_ZIP_PATH, "r") as z:
    with z.open("routes.txt") as f:
        # Load routes and ensure route_id is string to match Neo4j
        routes = pd.read_csv(f, dtype={'route_id': str})

    with z.open("stops.txt") as f:
        # Load stops and ensure stop_id is string
        stops = pd.read_csv(f, dtype={'stop_id': str})

    with z.open("trips.txt") as f:
        trips = pd.read_csv(f, dtype={'route_id': str, 'trip_id': str, 'shape_id': str})

    try:
        with z.open("shapes.txt") as f:
            shapes = pd.read_csv(f, dtype={'shape_id': str})
        has_shapes = True
        print("Found shapes.txt.")
    except KeyError:
        shapes = None
        has_shapes = False
        print("Warning: 'shapes.txt' not found. Routes will be drawn by connecting stops.")

# --- Filter Route IDs (Non-Train) ---
# Filter out train routes (types 0, 1, 2 typically)
train_route_types = [0, 1, 2]
non_train_routes = routes[~routes['route_type'].isin(train_route_types)]
valid_route_ids = non_train_routes['route_id'].unique().tolist()
print(f"Identified {len(valid_route_ids)} non-train routes.")

# --- Fetch Data from Neo4j ---
print("Fetching graph data from Neo4j...")


def get_stops(tx):
    query = """
    MATCH (s:Stop)
    RETURN toString(s.stop_id) AS stop_id, s.name AS stop_name, s.lat AS stop_lat, s.lon AS stop_lon
    """
    result = tx.run(query)
    return [record.data() for record in result]


def get_edges(tx, route_ids):
    # Retrieve edges (NEXT) between StopTimes, linking back to Stop IDs
    # Note: We cast IDs to string in the query or ensure match
    query = """
    MATCH (r:Route)-[:HAS_TRIP]->(t:Trip)-[:HAS_STOP_TIME]->(st1:StopTime)-[:NEXT]->(st2:StopTime)
    WHERE r.route_id IN $route_ids
    RETURN DISTINCT toString(st1.stop_id) AS source, toString(st2.stop_id) AS target
    """
    result = tx.run(query, route_ids=route_ids)
    return [record.data() for record in result]


def get_unique_route_sequences(tx, route_ids):
    query = """
    MATCH (r:Route)-[:HAS_TRIP]->(t:Trip)-[:HAS_STOP_TIME]->(st:StopTime)
    WHERE r.route_id IN $route_ids
    RETURN t.trip_id AS trip_id, toString(st.stop_id) AS stop_id, st.sequence AS sequence
    ORDER BY t.trip_id, st.sequence
    """
    result = tx.run(query, route_ids=route_ids)
    return [record.data() for record in result]


with driver.session() as session:
    # 1. Fetch Stops
    print("Querying stops...")
    stops_data = session.execute_read(get_stops)
    stops_df = pd.DataFrame(stops_data)

    # 2. Fetch Edges
    print("Querying edges...")
    # Pass valid_route_ids. They are already strings from the pd.read_csv dtype argument.
    edges_data = session.execute_read(get_edges, valid_route_ids)

    # Create DataFrame with explicit columns to prevent KeyError if empty
    edges_df = pd.DataFrame(edges_data, columns=['source', 'target'])

    # 3. Fetch Sequences (fallback for drawing)
    trip_sequences_data = []
    if not has_shapes:
        print("Querying trip sequences for route drawing...")
        trip_sequences_data = session.execute_read(get_unique_route_sequences, valid_route_ids)

driver.close()

print(f"Fetched {len(stops_df)} stops and {len(edges_df)} edges from Neo4j.")

if edges_df.empty:
    print("WARNING: No edges were returned from Neo4j. The graph will be unconnected.")
    print("Possible reasons: Route IDs mismatch (string vs int), or no data for the selected routes.")

# --- Spatial Filtering ---
if stops_df.empty:
    # Fallback if Neo4j returned no stops (shouldn't happen if DB is populated)
    print("Warning: No stops found in Neo4j. Falling back to GTFS stops.txt.")
    stops_with_coords = stops[["stop_id", "stop_name", "stop_lat", "stop_lon"]].dropna()
    stops_df = stops_with_coords
else:
    # Ensure columns match
    stops_df['stop_id'] = stops_df['stop_id'].astype(str)

# Create GeoDataFrame
geometry = [Point(xy) for xy in zip(stops_df['stop_lon'], stops_df['stop_lat'])]
stops_gdf = gpd.GeoDataFrame(stops_df, geometry=geometry, crs="EPSG:4326")

# Filter stops within Munich
print("Filtering stops within Munich boundary...")
stops_map = gpd.sjoin(stops_gdf, munich_boundary, how="inner", predicate="within")
valid_stop_ids = set(stops_map['stop_id'].astype(str))

print(f"Processing {len(stops_map)} stops found within Munich.")
if stops_map.empty:
    raise ValueError("No stops with coordinates found within the Munich boundary.")

# --- Build Knowledge Graph with NetworkX ---
print("Building knowledge graph...")
G = nx.Graph()

# Add Nodes
for _, row in stops_map.iterrows():
    G.add_node(str(row['stop_id']), name=row['stop_name'], pos=(row['stop_lat'], row['stop_lon']))

# Add Edges
# Ensure edge IDs are strings
edges_df['source'] = edges_df['source'].astype(str)
edges_df['target'] = edges_df['target'].astype(str)

# Filter edges to ensure both source and target are in Munich
edges_in_munich = edges_df[
    edges_df['source'].isin(valid_stop_ids) &
    edges_df['target'].isin(valid_stop_ids)
    ]

print(f"Adding {len(edges_in_munich)} valid edges to the graph...")
for _, row in tqdm(edges_in_munich.iterrows(), total=len(edges_in_munich), desc="Adding edges"):
    G.add_edge(row['source'], row['target'])

print(f"Graph built with {G.number_of_nodes()} nodes and {G.number_of_edges()} edges.")

# --- Query the Knowledge Graph for a path ---
has_path = False
# --- DEFINE YOUR START AND END POINTS HERE ---
# Ensure these IDs exist in your data and are Strings
START_STOP_ID = "369800"  # Beethovenplatz
END_STOP_ID = "419473"  # Westerlandanger
# -----------------------------------------

if str(START_STOP_ID) in G and str(END_STOP_ID) in G:
    try:
        print(f"Finding shortest path between stop ID {START_STOP_ID} and {END_STOP_ID}...")
        shortest_path_stop_ids = nx.shortest_path(G, source=str(START_STOP_ID), target=str(END_STOP_ID))
        path_coords = [G.nodes[stop_id]['pos'] for stop_id in shortest_path_stop_ids]
        has_path = True
        print(f"Path found with {len(shortest_path_stop_ids)} stops.")
    except nx.NetworkXNoPath:
        print(f"No path found between {START_STOP_ID} and {END_STOP_ID}.")
else:
    print(
        f"Start or End stop not found in the graph (Munich area). Start: {START_STOP_ID in G}, End: {END_STOP_ID in G}")

# --- Map Visualization ---
center_lat = stops_map["stop_lat"].mean()
center_lon = stops_map["stop_lon"].mean()

m = folium.Map(
    location=[center_lat, center_lon],
    zoom_start=12,
    tiles="CartoDB positron",
    attr='&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="http://cartodb.com/attributions">CartoDB</a>'
)

print("Drawing routes on the map...")
route_color = "#003366"
route_weight = 1.5
route_opacity = 0.8

if has_shapes:
    boundary_polygon = munich_boundary.union_all()

    relevant_trips = trips[trips['route_id'].isin(valid_route_ids)]
    relevant_shape_ids = relevant_trips['shape_id'].dropna().unique()

    route_shapes = shapes[shapes['shape_id'].isin(relevant_shape_ids)].sort_values(by=['shape_id', 'shape_pt_sequence'])
    grouped_shapes = route_shapes.groupby('shape_id')

    for shape_id, group in tqdm(grouped_shapes, desc="Drawing routes from shapes"):
        # Quick bounding box check or sampling could speed this up
        if group.empty: continue

        geometry = [Point(xy) for xy in zip(group['shape_pt_lon'], group['shape_pt_lat'])]
        shape_gdf = gpd.GeoDataFrame(group, geometry=geometry, crs="EPSG:4326")

        # Check if the shape is at least partially in Munich or fully
        # checking .all() for strictness, or .any() for looseness
        if shape_gdf.within(boundary_polygon).any():
            shape_points = group[['shape_pt_lat', 'shape_pt_lon']].values.tolist()
            folium.PolyLine(locations=shape_points, color=route_color, weight=route_weight,
                            opacity=route_opacity).add_to(m)
else:
    stop_coords = stops_df.set_index('stop_id')[['stop_lat', 'stop_lon']].to_dict('index')

    print("Identifying unique route patterns from Neo4j data...")
    seq_df = pd.DataFrame(trip_sequences_data)
    if not seq_df.empty:
        seq_df['stop_id'] = seq_df['stop_id'].astype(str)
        trip_stop_sequences = seq_df.groupby('trip_id')['stop_id'].apply(tuple)
        unique_routes = set(trip_stop_sequences)

        routes_in_munich = [
            route for route in unique_routes
            if all(stop_id in valid_stop_ids for stop_id in route)
        ]

        for stop_sequence in tqdm(routes_in_munich, desc="Drawing unique routes"):
            line_points = []
            for stop_id in stop_sequence:
                if stop_id in stop_coords:
                    coord = stop_coords[stop_id]
                    line_points.append([coord['stop_lat'], coord['stop_lon']])

            if len(line_points) > 1:
                folium.PolyLine(
                    locations=line_points,
                    color=route_color,
                    weight=route_weight,
                    opacity=route_opacity
                ).add_to(m)

# --- Draw the queried path ---
if has_path:
    print("Drawing shortest path...")
    folium.PolyLine(
        locations=path_coords,
        color='green',
        weight=5,
        opacity=1.0,
        tooltip='Shortest Path'
    ).add_to(m)

# --- Add Markers ---
marker_cluster = MarkerCluster(options={'disableClusteringAtZoom': 12}).add_to(m)
for _, row in tqdm(stops_map.iterrows(), total=len(stops_map), desc="Adding stop markers"):
    folium.CircleMarker(
        location=[row["stop_lat"], row["stop_lon"]],
        radius=2,
        popup=f'{row["stop_name"]} (ID: {row["stop_id"]})',
        color="red",
        fill=True,
        fill_color="red",
        fill_opacity=0.6,
    ).add_to(marker_cluster)

# Save to HTML
output_path = "gtfs_map_with_routes.html"
m.save(output_path)
print(f"Map saved to {output_path}.")