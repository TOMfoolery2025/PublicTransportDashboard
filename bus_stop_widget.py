"""
Lightweight bus stop info widget.

Registers a small API endpoint to return details (and departures) for a stop so
the frontend can open a popup when a stop marker is clicked.
"""
import os
from typing import List, Dict, Any
import requests
from flask import Blueprint, jsonify
from geopy.distance import geodesic


DEPARTURES_API_BASE = os.getenv("DEPARTURES_API_BASE", "https://civiguild.com/api/departures")
# If your data snapshot is a couple of days old, shift queries back so the API
# returns departures relative to that date.
DEPARTURES_DAYS_AGO = int(os.getenv("DEPARTURES_DAYS_AGO", "2"))


def fetch_departures(stop_id: str, limit: int = 5) -> List[Dict[str, Any]]:
    url = f"{DEPARTURES_API_BASE}/{stop_id}"
    attempts = []
    # First try with the time-shifted day (helps when data is frozen a few days back)
    primary_params = {}
    if DEPARTURES_DAYS_AGO > 0:
        primary_params["days_ago"] = DEPARTURES_DAYS_AGO
    attempts.append(primary_params)
    # Fallback: try without params to at least show something
    attempts.append({})

    for params in attempts:
        try:
            res = requests.get(url, params=params, timeout=5)
            res.raise_for_status()
            data = res.json() or []
            if not data:
                continue
            departures = []
            for item in data[:limit]:
                departures.append({
                    "route_short_name": item.get("route_short_name"),
                    "departure_time": item.get("departure_time"),
                    "trip_id": item.get("trip_id"),
                })
            if departures:
                return departures
        except Exception:
            continue
    return []


def register_bus_stop_widget(app, stops_cache):
    """
    Attach a /api/stops/<stop_id> endpoint that returns basic stop info and
    upcoming departures pulled from the public API.

    The endpoint uses the cached stops passed in (list of dicts) to avoid extra
    database work and includes a small hint about how far the stop is from the
    city center to show something useful in the popup.
    """
    bp = Blueprint("bus_stop_widget", __name__)

    # Precompute a simple lookup for speed
    stop_by_id = {str(s["stop_id"]): s for s in stops_cache}
    center = (48.1351, 11.5820)  # Munich center for a quick distance fact

    @bp.route("/api/stops/<stop_id>")
    def stop_info(stop_id):
        stop = stop_by_id.get(str(stop_id))
        if not stop:
            return jsonify({"error": "Stop not found"}), 404

        lat = float(stop.get("lat"))
        lon = float(stop.get("lon"))
        distance_from_center = None
        try:
            distance_from_center = geodesic((lat, lon), center).meters
        except Exception:
            pass

        departures = fetch_departures(stop_id)

        payload = {
            "stop_id": str(stop.get("stop_id")),
            "stop_name": stop.get("stop_name"),
            "lat": lat,
            "lon": lon,
            "distance_from_center_m": distance_from_center,
            "departures": departures,
        }
        return jsonify(payload)

    app.register_blueprint(bp)
