"""
Lightweight bus stop info widget.

Registers a small API endpoint to return details for a stop so the frontend
can open a popup when a stop marker is clicked.
"""
from flask import Blueprint, jsonify
from geopy.distance import geodesic


def register_bus_stop_widget(app, stops_cache):
    """
    Attach a /api/stops/<stop_id> endpoint that returns basic stop info.

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

        payload = {
            "stop_id": str(stop.get("stop_id")),
            "stop_name": stop.get("stop_name"),
            "lat": lat,
            "lon": lon,
            "distance_from_center_m": distance_from_center,
        }
        return jsonify(payload)

    app.register_blueprint(bp)
