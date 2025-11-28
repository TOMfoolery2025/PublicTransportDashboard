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
# Optional offset when using older snapshots
DEPARTURES_DAYS_AGO = int(os.getenv("DEPARTURES_DAYS_AGO", "0"))


def fetch_departures(stop_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    url = f"{DEPARTURES_API_BASE}/{stop_id}"
    params = {}
    if DEPARTURES_DAYS_AGO > 0:
        params["days_ago"] = DEPARTURES_DAYS_AGO
    try:
        res = requests.get(url, params=params, timeout=8)
        res.raise_for_status()
        data = res.json() or []
        departures = []
        for item in data[:limit]:
            departures.append({
                "route_short_name": item.get("route_short_name"),
                "trip_id": item.get("trip_id"),
                "departure_timestamp": item.get("departure_timestamp"),
                "delay": item.get("delay", 0),
            })
        return departures
    except Exception as exc:
        print(f"Departures fetch failed for stop {stop_id}: {exc}")
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

        # Minimal info; departures handled client-side.
        payload = {
            "stop_id": str(stop.get("stop_id")),
            "stop_name": stop.get("stop_name"),
            "lat": lat,
            "lon": lon,
            "distance_from_center_m": distance_from_center,
        }
        return jsonify(payload)

    @bp.route("/api/departures/<stop_id>")
    def departures_proxy(stop_id):
        data = fetch_departures(stop_id)
        return jsonify(data)

    app.register_blueprint(bp)
