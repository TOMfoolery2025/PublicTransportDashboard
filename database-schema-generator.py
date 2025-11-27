import sqlite3

schema = """
CREATE TABLE IF NOT EXISTS Stops (
    stop_id INTEGER PRIMARY KEY,
    stop_name TEXT NOT NULL,
    parent_station INTEGER,
    stop_lat REAL NOT NULL,
    stop_lon REAL NOT NULL,
    location_type TEXT,
    platform_code TEXT,
    FOREIGN KEY(parent_station) REFERENCES Stops(stop_id)
);
CREATE INDEX IF NOT EXISTS idx_parent_station ON Stops(parent_station);
CREATE INDEX IF NOT EXISTS idx_stop_lat ON Stops(stop_lat);
CREATE INDEX IF NOT EXISTS idx_stop_lon ON Stops(stop_lon);

CREATE TABLE IF NOT EXISTS Agency(  
    agency_id INTEGER PRIMARY KEY,
    agency_name TEXT NOT NULL,
    agency_url TEXT NOT NULL,
    agency_timezone TEXT NOT NULL,
    agency_lang TEXT
);
    
    
CREATE TABLE IF NOT EXISTS Routes(
    route_id INTEGER PRIMARY KEY,
    route_short_name TEXT,
    route_long_name TEXT,
    agency_id INTEGER,
    route_type INTEGER NOT NULL,
    route_color TEXT,
    route_text_color TEXT,
    FOREIGN KEY(agency_id) REFERENCES Agency(agency_id)
);
  
CREATE TABLE IF NOT EXISTS Trips \
(
    route_id   INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    trip_id    INTEGER NOT NULL,
    PRIMARY KEY (trip_id),
    FOREIGN KEY(route_id) REFERENCES Routes(route_id)
);

CREATE TABLE IF NOT EXISTS StopTimes (
    trip_id INTEGER NOT NULL,
    arrival_time TEXT NOT NULL,
    departure_time TEXT NOT NULL,
    stop_id INTEGER NOT NULL,
    stop_sequence INTEGER NOT NULL,
    pickup_type INTEGER,
    drop_off_type INTEGER,
    FOREIGN KEY(stop_id) REFERENCES Stops(stop_id),
    FOREIGN KEY(trip_id) REFERENCES Trips(trip_id)
);
CREATE INDEX IF NOT EXISTS idx_stop_id ON StopTimes(stop_id);
CREATE INDEX IF NOT EXISTS idx_trip_id ON StopTimes(trip_id);
    

"""
#route_id,service_id,trip_id
#route_long_name,route_short_name,agency_id,route_type,route_id,route_color,route_text_color

# Init Schema
with sqlite3.connect('data/transport.sqlite') as conn:
    cursor = conn.cursor()
    cursor.executescript(schema)
    conn.commit()