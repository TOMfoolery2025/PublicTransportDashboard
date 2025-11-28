document.addEventListener('DOMContentLoaded', () => {
    const stops = window.STOP_DATA || [];
    const startSelect = document.getElementById('start-stop');
    const endSelect = document.getElementById('end-stop');
    const statusEl = document.getElementById('status');
    const routeSummary = document.getElementById('route-summary');
    const findPathBtn = document.getElementById('find-path-btn');

    const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(window.DEFAULT_CENTER || [48.1351, 11.5820], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    // Initial Dots
    if (stops.length > 0) {
        stops.forEach(s => {
            L.circleMarker([s.lat, s.lon], {
                radius: 2, color: '#444', weight: 0.5, fillColor: '#fff', fillOpacity: 0.5
            }).addTo(map).bindTooltip(s.stop_name);
        });
    }

    let activeLayers = [];

    const setStatus = (msg, type) => {
        statusEl.textContent = msg;
        statusEl.className = `status status--${type}`;
    };

    function decodePolyline(str, precision) {
        var index = 0, lat = 0, lng = 0, coordinates = [], shift = 0, result = 0, byte = null, latitude_change, longitude_change, factor = Math.pow(10, precision || 5);
        while (index < str.length) {
            byte = null; shift = 0; result = 0;
            do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
            latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
            shift = result = 0;
            do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
            longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lat += latitude_change; lng += longitude_change;
            coordinates.push([lat / factor, lng / factor]);
        }
        return coordinates;
    }

    const MODE_COLORS = {
        'U-Bahn': '#0065AE',
        'S-Bahn': '#4EBE3F',
        'Tram':   '#E30613',
        'Bus':    '#582C83',
        'WALK':   '#777777'
    };

    // --- NEW: PREPARE DATA IN PARALLEL ---
    const prepareLegLayer = async (leg) => {
        const points = leg.points;
        const latLngs = points.map(p => [p.lat, p.lon]);

        let color = MODE_COLORS[leg.mode] || MODE_COLORS['Bus'];
        if (leg.mode.includes("Bus")) color = MODE_COLORS['Bus'];
        if (leg.mode.includes("Tram")) color = MODE_COLORS['Tram'];

        // 1. Walking: Simple Dashed Line (No API call needed)
        if (leg.mode === 'WALK') {
            const line = L.polyline(latLngs, {
                color: '#666', weight: 5, dashArray: '5, 12', opacity: 0.8
            });
            // Return the layer and the marker
            return [line, points[0]];
        }

        // 2. Transit: Fetch OSRM in background
        try {
            const osrmCoords = points.map(p => `${p.lon},${p.lat}`).join(';');
            const url = `https://router.project-osrm.org/route/v1/driving/${osrmCoords}?overview=full`;

            const res = await fetch(url);
            const data = await res.json();

            if(data.routes && data.routes.length > 0) {
                 const decoded = decodePolyline(data.routes[0].geometry, 5);
                 const line = L.polyline(decoded, { color: color, weight: 6, opacity: 0.9 });
                 return [line, points[0]];
            }
        } catch(e) {
            console.warn("OSRM failed, using straight line");
        }

        // Fallback
        const line = L.polyline(latLngs, { color: color, weight: 6, opacity: 0.9 });
        return [line, points[0]];
    };

    const handleRoute = async () => {
        const startId = startSelect.value;
        const endId = endSelect.value;
        if (!startId || !endId) return;

        // Clear previous
        activeLayers.forEach(l => map.removeLayer(l));
        activeLayers = [];

        setStatus('Routing...', 'idle');
        findPathBtn.textContent = 'Calculating...';
        findPathBtn.disabled = true;

        try {
            // 1. Get Legs from Python
            const res = await fetch(`/api/path?start=${encodeURIComponent(startId)}&end=${encodeURIComponent(endId)}`);
            const data = await res.json();

            if (data.legs) {
                setStatus('Drawing map...', 'idle');

                // 2. PARALLEL PROCESSING: Fire all requests at once
                const promises = data.legs.map(leg => prepareLegLayer(leg));
                const results = await Promise.all(promises);

                // 3. Render everything instantly
                results.forEach(([layer, startPoint], index) => {
                    layer.addTo(map);
                    activeLayers.push(layer);

                    // Add Transition Markers
                    const marker = L.circleMarker([startPoint.lat, startPoint.lon], {
                        radius: 4, color: '#000', fillColor: '#fff', fillOpacity: 1
                    }).addTo(map).bindTooltip(data.legs[index].mode);
                    activeLayers.push(marker);
                });

                // 4. Add Final Destination Marker
                const lastLeg = data.legs[data.legs.length-1];
                const lastPt = lastLeg.points[lastLeg.points.length-1];
                L.circleMarker([lastPt.lat, lastPt.lon], {
                    radius: 6, color: '#000', fillColor: '#000', fillOpacity: 1
                }).addTo(map).bindTooltip("End");


                setStatus(`Route found!`, 'success');

                // Fit bounds
                const allPts = data.legs.flatMap(l => l.points.map(p => [p.lat, p.lon]));
                map.fitBounds(allPts, { padding: [50, 50] });

                routeSummary.innerHTML = data.legs.map(l =>
                    `<div><strong>${l.mode}</strong> (${l.route || ''}): ${l.points.length-1} stops</div>`
                ).join('');
                routeSummary.classList.remove('hidden');
            }
        } catch (e) {
            console.error(e);
            setStatus('No path found.', 'error');
        } finally {
            findPathBtn.disabled = false;
            findPathBtn.textContent = 'Draw route';
        }
    };

    findPathBtn.addEventListener('click', handleRoute);
});