import zipfile
import pandas as pd
import folium
from folium.plugins import MarkerCluster
import geopandas as gpd
import osmnx as ox
from shapely.geometry import Point
import networkx as nx
from tqdm import tqdm

GTFS_ZIP_PATH = "gtfw-data-stops-trips.zip"  # change if your file has another name

# --- Get the boundary of Munich from OpenStreetMap ---
print("Fetching Munich boundary from OpenStreetMap...")
city = ox.geocode_to_gdf("München, Germany")
municipality = ox.geocode_to_gdf("Landkreis München, Germany")
combined = gpd.GeoDataFrame(geometry=[city.unary_union.union(municipality.unary_union)], crs="EPSG:4326")
boundary_polygon = combined.unary_union
print("Boundary fetched.")

# --- Load GTFS data from ZIP ---
print("Loading GTFS data from zip file...")
with zipfile.ZipFile(GTFS_ZIP_PATH, "r") as z:
    with z.open("stops.txt") as f:
        stops = pd.read_csv(f)
    with z.open("trips.txt") as f:
        trips = pd.read_csv(f)
    with z.open("stop_times.txt") as f:
        stop_times = pd.read_csv(f)
    with z.open("routes.txt") as f:
        routes = pd.read_csv(f)
    # shapes.txt is optional, so handle its absence
    try:
        with z.open("shapes.txt") as f:
            shapes = pd.read_csv(f)
        has_shapes = True
        print("Found shapes.txt.")
    except KeyError:
        shapes = None
        has_shapes = False
        print("Warning: 'shapes.txt' not found. Routes will be drawn by connecting stops.")
print("GTFS data loaded.")

# Filter to columns we need & drop rows without coordinates
stops_with_coords = stops[["stop_id", "stop_name", "stop_lat", "stop_lon"]].dropna(
    subset=["stop_lat", "stop_lon"]
)

# --- Create a GeoDataFrame from the stops DataFrame ---
geometry = [Point(xy) for xy in zip(stops_with_coords['stop_lon'], stops_with_coords['stop_lat'])]
stops_gdf = gpd.GeoDataFrame(stops_with_coords, geometry=geometry, crs="EPSG:4326")

# --- Filter for stops that are within the Munich boundary ---
print("Filtering stops within Munich boundary...")
stops_map = gpd.sjoin(stops_gdf, boundary_polygon, how="inner", predicate="within")

print(f"Processing {len(stops_map)} stops found within Munich.")
if stops_map.empty:
    raise ValueError("No stops with coordinates found within the Munich boundary.")

# --- Identify relevant trips for the graph (non-train) ---
print("Identifying non-train trips for graph construction...")
train_route_types = [0, 1, 2]
non_train_route_ids = routes[~routes['route_type'].isin(train_route_types)]['route_id'].unique()
# We consider all non-train trips; the graph building will filter edges to be within Munich.
relevant_trip_ids = list(trips[trips['route_id'].isin(non_train_route_ids)]['trip_id'])
trips_in_munich = trips[trips['trip_id'].isin(relevant_trip_ids)]
print(f"Found {len(trips_in_munich)} non-train trips to process for the graph.")

# --- Build Knowledge Graph with NetworkX ---
print("Building knowledge graph from stops and trips...")
G = nx.Graph()

# Add stops as nodes with their attributes
for _, stop in stops_map.iterrows():
    G.add_node(stop['stop_id'], name=stop['stop_name'], pos=(stop['stop_lat'], stop['stop_lon']))

# Add edges between consecutive stops for each trip
trip_stops_sorted = stop_times[stop_times['trip_id'].isin(relevant_trip_ids)].sort_values('stop_sequence')
for _, trip_group in tqdm(trip_stops_sorted.groupby('trip_id'), desc="Building graph edges"):
    stop_ids = trip_group['stop_id'].tolist()
    for i in range(len(stop_ids) - 1):
        # Ensure both stops are in our graph (i.e., within Munich) before adding an edge
        if G.has_node(stop_ids[i]) and G.has_node(stop_ids[i + 1]):
            G.add_edge(stop_ids[i], stop_ids[i + 1])
print(f"Graph built with {G.number_of_nodes()} nodes and {G.number_of_edges()} edges.")

# --- Query the Knowledge Graph for a path ---
has_path = False
try:
    # --- DEFINE YOUR START AND END POINTS HERE ---
    START_STOP_ID = 369800  # Beethovenplatz
    END_STOP_ID = 419473  # Westerlandanger
    # -----------------------------------------

    print(f"Finding shortest path between stop ID {START_STOP_ID} and {END_STOP_ID}...")
    shortest_path_stop_ids = nx.shortest_path(G, source=START_STOP_ID, target=END_STOP_ID)
    path_coords = [G.nodes[stop_id]['pos'] for stop_id in shortest_path_stop_ids]
    has_path = True
    print(f"Path found with {len(shortest_path_stop_ids)} stops.")
except (nx.NetworkXNoPath, nx.NodeNotFound) as e:
    print(f"Could not find a path between the specified stops: {e}")

# --- Compute center of map ---
center_lat = stops_map["stop_lat"].mean()
center_lon = stops_map["stop_lon"].mean()

# --- Create Leaflet map via folium ---
m = folium.Map(
    location=[center_lat, center_lon],
    zoom_start=12,
    tiles="CartoDB positron",
    attr='&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="http://cartodb.com/attributions">CartoDB</a>'
)

# --- Draw all routes on the map ---
print("Drawing all routes on the map...")
route_color = "#003366"
route_weight = 1.5
route_opacity = 0.8
if has_shapes:
    # Get the single polygon geometry for Munich for efficient checking
    boundary_polygon = boundary_polygon.unary_union
    relevant_shape_ids = trips_in_munich['shape_id'].dropna().unique()
    route_shapes = shapes[shapes['shape_id'].isin(relevant_shape_ids)].sort_values(by=['shape_pt_sequence'])

    # Group all shapes by their ID to process them one by one
    grouped_shapes = route_shapes.groupby('shape_id')

    for shape_id, group in tqdm(grouped_shapes, desc="Drawing routes from shapes"):
        # Create a GeoDataFrame for the points of the current shape
        geometry = [Point(xy) for xy in zip(group['shape_pt_lon'], group['shape_pt_lat'])]
        shape_gdf = gpd.GeoDataFrame(group, geometry=geometry, crs="EPSG:4326")

        # Check if all points of the shape are within the Munich boundary
        if shape_gdf.within(boundary_polygon).all():
            shape_points = group[['shape_pt_lat', 'shape_pt_lon']].values.tolist()
            folium.PolyLine(locations=shape_points, color=route_color, weight=route_weight,
                            opacity=route_opacity).add_to(m)
else:
    # Create a mapping from stop_id to coordinates for quick lookup
    stop_coords = stops_with_coords.set_index('stop_id')[['stop_lat', 'stop_lon']].to_dict('index')
    # Create a set of stop IDs within Munich for efficient filtering
    munich_stop_ids = set(stops_map['stop_id'])

    # Efficiently find unique routes
    print("Identifying unique route patterns...")
    trip_stop_sequences = trip_stops_sorted.groupby('trip_id')['stop_id'].apply(list)
    unique_routes = set(map(tuple, trip_stop_sequences))
    print(f"Found {len(unique_routes)} unique routes.")

    # Filter for routes where all stops are within Munich
    routes_in_munich = [
        route for route in unique_routes
        if all(stop_id in munich_stop_ids for stop_id in route)
    ]
    print(f"Found {len(routes_in_munich)} unique routes completely within Munich to draw.")

    # Iterate over the filtered unique routes and draw them
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

# --- Draw the queried path on the map ---
if has_path:
    print("Drawing shortest path on the map...")
    folium.PolyLine(
        locations=path_coords,
        color='green',
        weight=5,
        opacity=1.0,
        tooltip='Shortest Path'
    ).add_to(m)

# --- Add stop markers to the map ---
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
print(f"Saving map to {output_path}...")
m.save(output_path)
print("Map saved.")
