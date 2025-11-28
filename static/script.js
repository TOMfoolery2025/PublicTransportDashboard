document.addEventListener('DOMContentLoaded', () => {
    const stops = window.STOP_DATA || [];
    const startInput = document.getElementById('start-stop');
    const endInput = document.getElementById('end-stop');
    const startResults = document.getElementById('start-results');
    const endResults = document.getElementById('end-results');
    const statusEl = document.getElementById('status');
    const routeSummary = document.getElementById('route-summary');
    const findPathBtn = document.getElementById('find-path-btn');

    const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(window.DEFAULT_CENTER || [48.1351, 11.5820], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    // Store selected stops
    let selectedStart = null;
    let selectedEnd = null;

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

    // Search function for stops
    function searchStops(query, maxResults = 10) {
        if (!query || query.length < 2) return [];
        
        const lowerQuery = query.toLowerCase();
        return stops
            .filter(stop => 
                stop.stop_name.toLowerCase().includes(lowerQuery) ||
                stop.stop_id.toLowerCase().includes(lowerQuery)
            )
            .slice(0, maxResults);
    }

    // Display search results
    function showResults(input, results, resultsContainer, onSelect) {
        resultsContainer.innerHTML = '';
        
        if (results.length === 0 && input.value.length >= 2) {
            const noResult = document.createElement('div');
            noResult.className = 'autocomplete-item';
            noResult.textContent = 'No stops found';
            resultsContainer.appendChild(noResult);
            return;
        }
        
        results.forEach(stop => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.innerHTML = `
                <strong>${stop.stop_name}</strong>
                <small>ID: ${stop.stop_id}</small>
            `;
            item.addEventListener('click', () => {
                input.value = stop.stop_name;
                resultsContainer.innerHTML = '';
                onSelect(stop);
            });
            resultsContainer.appendChild(item);
        });
    }

    // Setup autocomplete for an input
    function setupAutocomplete(input, resultsContainer, onSelect) {
        let currentResults = [];
        
        input.addEventListener('input', (e) => {
            const query = e.target.value;
            currentResults = searchStops(query);
            showResults(input, currentResults, resultsContainer, onSelect);
        });
        
        input.addEventListener('focus', () => {
            if (input.value.length >= 2) {
                currentResults = searchStops(input.value);
                showResults(input, currentResults, resultsContainer, onSelect);
            }
        });
        
        // Hide results when clicking outside
        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !resultsContainer.contains(e.target)) {
                resultsContainer.innerHTML = '';
            }
        });
        
        // Keyboard navigation
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' && currentResults.length > 0) {
                e.preventDefault();
                const firstItem = resultsContainer.querySelector('.autocomplete-item');
                if (firstItem) firstItem.focus();
            }
        });
    }

    // Initialize autocomplete for both inputs
    setupAutocomplete(startInput, startResults, (stop) => {
        selectedStart = stop;
        updateButtonState();
    });
    
    setupAutocomplete(endInput, endResults, (stop) => {
        selectedEnd = stop;
        updateButtonState();
    });

    // Update button state based on selection
    function updateButtonState() {
        if (selectedStart && selectedEnd) {
            findPathBtn.disabled = false;
        } else {
            findPathBtn.disabled = true;
        }
    }

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

    const prepareLegLayer = async (leg) => {
        const points = leg.points;
        const latLngs = points.map(p => [p.lat, p.lon]);

        let color = MODE_COLORS[leg.mode] || MODE_COLORS['Bus'];
        if (leg.mode.includes("Bus")) color = MODE_COLORS['Bus'];
        if (leg.mode.includes("Tram")) color = MODE_COLORS['Tram'];

        if (leg.mode === 'WALK') {
            const line = L.polyline(latLngs, {
                color: '#666', weight: 5, dashArray: '5, 12', opacity: 0.8
            });
            return [line, points[0]];
        }

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

        const line = L.polyline(latLngs, { color: color, weight: 6, opacity: 0.9 });
        return [line, points[0]];
    };

    const handleRoute = async () => {
        if (!selectedStart || !selectedEnd) {
            setStatus('Please select both start and destination stops', 'error');
            return;
        }

        // Clear previous
        activeLayers.forEach(l => map.removeLayer(l));
        activeLayers = [];

        setStatus('Routing...', 'idle');
        findPathBtn.textContent = 'Calculating...';
        findPathBtn.disabled = true;

        try {
            const res = await fetch(`/api/path?start=${encodeURIComponent(selectedStart.stop_id)}&end=${encodeURIComponent(selectedEnd.stop_id)}`);
            const data = await res.json();

            if (data.legs) {
                setStatus('Drawing map...', 'idle');

                const promises = data.legs.map(leg => prepareLegLayer(leg));
                const results = await Promise.all(promises);

                results.forEach(([layer, startPoint], index) => {
                    layer.addTo(map);
                    activeLayers.push(layer);

                    const marker = L.circleMarker([startPoint.lat, startPoint.lon], {
                        radius: 4, color: '#000', fillColor: '#fff', fillOpacity: 1
                    }).addTo(map).bindTooltip(data.legs[index].mode);
                    activeLayers.push(marker);
                });

                const lastLeg = data.legs[data.legs.length-1];
                const lastPt = lastLeg.points[lastLeg.points.length-1];
                L.circleMarker([lastPt.lat, lastPt.lon], {
                    radius: 6, color: '#000', fillColor: '#000', fillOpacity: 1
                }).addTo(map).bindTooltip("End");

                setStatus(`Route found!`, 'success');

                const allPts = data.legs.flatMap(l => l.points.map(p => [p.lat, p.lon]));
                map.fitBounds(allPts, { padding: [50, 50] });

                routeSummary.innerHTML = data.legs.map(l =>
                    `<div><strong>${l.mode}</strong> (${l.route || ''}): ${l.points.length-1} stops</div>`
                ).join('');
                routeSummary.classList.remove('hidden');
            } else if (data.error) {
                setStatus(data.error, 'error');
            }
        } catch (e) {
            console.error(e);
            setStatus('Error finding path', 'error');
        } finally {
            findPathBtn.disabled = false;
            findPathBtn.textContent = 'Draw route';
        }
    };

    findPathBtn.addEventListener('click', handleRoute);
    updateButtonState(); // Initialize button state
});