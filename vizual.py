import zipfile
import pandas as pd
import folium
from folium.plugins import MarkerCluster
import geopandas as gpd
import osmnx as ox
from shapely.geometry import Point

GTFS_ZIP_PATH = "gtfw-data-stops-trips.zip"  # change if your file has another name

# --- Get the boundary of Munich from OpenStreetMap ---
print("Fetching Munich boundary from OpenStreetMap...")
munich_boundary = ox.geocode_to_gdf("München, Germany")
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
stops_map = gpd.sjoin(stops_gdf, munich_boundary, how="inner", predicate="within")

print(f"Processing {len(stops_map)} stops found within Munich.")
if stops_map.empty:
    raise ValueError("No stops with coordinates found within the Munich boundary.")

# --- Identify routes that operate entirely within Munich ---
print("Identifying routes operating entirely within Munich...")

# 1. Filter out train routes (route_type 0: Tram, 1: Subway, 2: Rail)
train_route_types = [0, 1, 2]
non_train_route_ids = routes[~routes['route_type'].isin(train_route_types)]['route_id'].unique()
non_train_trip_ids = set(trips[trips['route_id'].isin(non_train_route_ids)]['trip_id'])

# 2. Find all trips that have at least one stop OUTSIDE Munich
munich_stop_ids = set(stops_map['stop_id'])
stops_outside_munich = stops_with_coords[~stops_with_coords['stop_id'].isin(munich_stop_ids)]
stops_outside_munich_ids = set(stops_outside_munich['stop_id'])
trips_with_stops_outside = set(stop_times[stop_times['stop_id'].isin(stops_outside_munich_ids)]['trip_id'])

# 3. The relevant trips are non-train trips that are NOT in the set of trips with outside stops
relevant_trip_ids = list(non_train_trip_ids - trips_with_stops_outside)

# This is the final set of trips to be displayed
trips_in_munich = trips[trips['trip_id'].isin(relevant_trip_ids)]
print(f"Found {len(trips_in_munich)} non-train trips operating entirely within Munich.")


# --- Compute center of map ---
center_lat = stops_map["stop_lat"].mean()
center_lon = stops_map["stop_lon"].mean()

print(f"Map center at lat={center_lat}, lon={center_lon}")
# --- Create Leaflet map via folium ---
m = folium.Map(
    location=[center_lat, center_lon],
    zoom_start=12,
    tiles="CartoDB positron",
    attr='&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="http://cartodb.com/attributions">CartoDB</a>'
)

# --- Draw routes on the map ---
print("Drawing routes on the map...")
route_color = "#003366"  # A dark blue color for routes
route_weight = 1.5
route_opacity = 0.8

if has_shapes:
    # Method 1: Use shapes.txt if it exists (more accurate)
    relevant_shape_ids = trips_in_munich['shape_id'].dropna().unique()
    route_shapes = shapes[shapes['shape_id'].isin(relevant_shape_ids)]
    print(f"Found {len(relevant_shape_ids)} route shapes to draw from shapes.txt.")

    route_shapes = route_shapes.sort_values(by=['shape_pt_sequence'])
    for _, group in route_shapes.groupby('shape_id'):
        shape_points = group[['shape_pt_lat', 'shape_pt_lon']].values.tolist()
        folium.PolyLine(
            locations=shape_points,
            color=route_color,
            weight=route_weight,
            opacity=route_opacity
        ).add_to(m)
else:
    # Method 2: Fallback to connecting stops if shapes.txt is missing
    print("Drawing routes by connecting stops for each trip.")
    trip_stops = stop_times[stop_times['trip_id'].isin(relevant_trip_ids)].merge(
        stops_with_coords, on='stop_id', how='inner'
    )
    trip_stops = trip_stops.sort_values(['trip_id', 'stop_sequence'])

    unique_routes = trip_stops.groupby('trip_id')['stop_id'].apply(list).drop_duplicates()
    print(f"Found {len(unique_routes)} unique stop sequences to draw.")

    for trip_id in unique_routes.index:
        stop_sequence = trip_stops[trip_stops['trip_id'] == trip_id]
        if len(stop_sequence) > 1:
            line_points = stop_sequence[['stop_lat', 'stop_lon']].values.tolist()
            folium.PolyLine(
                locations=line_points,
                color=route_color,
                weight=route_weight,
                opacity=route_opacity
            ).add_to(m)


print("Created base map and added routes.")
# Create a MarkerCluster layer with clustering disabled at zoom level 12
marker_cluster = MarkerCluster(
    options={'disableClusteringAtZoom': 12}
).add_to(m)

print("Created marker cluster, now adding stops.")
# Add markers to the cluster layer
for _, row in stops_map.iterrows():
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

print(f"Map saved to {output_path}")
print("Open it in a browser (or use VSCode's HTML preview).")
