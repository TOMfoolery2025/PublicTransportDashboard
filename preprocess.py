import zipfile
import pandas as pd
import geopandas as gpd
import osmnx as ox
from shapely.geometry import Point
import networkx as nx
from tqdm import tqdm
import pickle

GTFS_ZIP_PATH = "gtfw-data-stops-trips.zip"
GRAPH_OUTPUT_PATH = "munich_graph.gpickle"
STOPS_OUTPUT_PATH = "munich_stops.pkl"

def create_transit_graph():
    """
    Loads GTFS data, filters for non-train routes within Munich,
    and builds a NetworkX graph of the transit system.
    Saves the graph and a list of stops to disk.
    """
    print("Fetching Munich boundary from OpenStreetMap...")
    munich_boundary = ox.geocode_to_gdf("München, Germany")
    print("Boundary fetched.")

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
    print("GTFS data loaded.")

    stops_with_coords = stops.dropna(subset=["stop_lat", "stop_lon"])
    geometry = [Point(xy) for xy in zip(stops_with_coords['stop_lon'], stops_with_coords['stop_lat'])]
    stops_gdf = gpd.GeoDataFrame(stops_with_coords, geometry=geometry, crs="EPSG:4326")

    print("Filtering stops within Munich boundary...")
    stops_in_munich = gpd.sjoin(stops_gdf, munich_boundary, how="inner", predicate="within")
    print(f"Found {len(stops_in_munich)} stops within Munich.")

    print("Identifying non-train trips...")
    train_route_types = [0, 1, 2]
    non_train_route_ids = routes[~routes['route_type'].isin(train_route_types)]['route_id'].unique()
    relevant_trip_ids = list(trips[trips['route_id'].isin(non_train_route_ids)]['trip_id'])

    print("Building knowledge graph...")
    G = nx.Graph()
    for _, stop in stops_in_munich.iterrows():
        G.add_node(stop['stop_id'], name=stop['stop_name'], pos=(stop['stop_lat'], stop['stop_lon']))

    trip_stops_sorted = stop_times[stop_times['trip_id'].isin(relevant_trip_ids)].sort_values('stop_sequence')
    for _, trip_group in tqdm(trip_stops_sorted.groupby('trip_id'), desc="Building graph edges"):
        stop_ids = trip_group['stop_id'].tolist()
        for i in range(len(stop_ids) - 1):
            if G.has_node(stop_ids[i]) and G.has_node(stop_ids[i+1]):
                G.add_edge(stop_ids[i], stop_ids[i+1])

    print(f"Graph built with {G.number_of_nodes()} nodes and {G.number_of_edges()} edges.")

    # Save the graph and stops data
    with open(GRAPH_OUTPUT_PATH, "wb") as f:
        pickle.dump(G, f, pickle.HIGHEST_PROTOCOL)
    print(f"Graph saved to {GRAPH_OUTPUT_PATH}")

    # Save the stops for the dropdown menu
    stops_for_frontend = stops_in_munich[['stop_id', 'stop_name']].sort_values('stop_name')
    stops_for_frontend.to_pickle(STOPS_OUTPUT_PATH)
    print(f"Stops list saved to {STOPS_OUTPUT_PATH}")

if __name__ == "__main__":
    create_transit_graph()

