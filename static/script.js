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

    // Format distance for display
    function formatDistance(meters) {
        if (meters < 1000) {
            return Math.round(meters) + ' m';
        } else {
            return (meters / 1000).toFixed(1) + ' km';
        }
    }

    // Calculate distance of a polyline in meters
    function calculatePolylineDistance(latLngs) {
        let totalDistance = 0;
        for (let i = 1; i < latLngs.length; i++) {
            const prev = latLngs[i-1];
            const curr = latLngs[i];
            
            // Haversine formula for distance calculation
            const R = 6371000; // Earth's radius in meters
            const dLat = (curr[0] - prev[0]) * Math.PI / 180;
            const dLon = (curr[1] - prev[1]) * Math.PI / 180;
            const a = 
                Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(prev[0] * Math.PI / 180) * Math.cos(curr[0] * Math.PI / 180) * 
                Math.sin(dLon/2) * Math.sin(dLon/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            totalDistance += R * c;
        }
        return totalDistance;
    }

    // Calculate a point perpendicular to the line at a given percentage
    function calculateOffsetPoint(start, end, percentage, offsetDistance) {
        // Convert offset distance from meters to degrees (approximate)
        const offsetDegrees = offsetDistance / 111000; // Rough conversion

        // Calculate the direction vector
        const dx = end[1] - start[1];
        const dy = end[0] - start[0];

        // Calculate perpendicular vector (rotate 90 degrees)
        const perpX = -dy;
        const perpY = dx;

        // Normalize
        const length = Math.sqrt(perpX * perpX + perpY * perpY);
        const normX = perpX / length;
        const normY = perpY / length;

        // Calculate the point along the line
        const alongX = start[1] + dx * percentage;
        const alongY = start[0] + dy * percentage;

        // Apply offset
        return [
            alongY + normY * offsetDegrees,
            alongX + normX * offsetDegrees
        ];
    }

    const MODE_COLORS = {
        'U-Bahn': '#0065AE', // MVG Blue
        'S-Bahn': '#4EBE3F', // MVG Green
        'Tram':   '#E30613', // MVG Red
        'Bus':    '#582C83', // Purple
        'WALK':   '#777777'  // Gray
    };

    const prepareLegLayer = async (leg, legIndex, allLegs) => {
        const points = leg.points;
        const latLngs = points.map(p => [p.lat, p.lon]);

        let color = MODE_COLORS[leg.mode] || MODE_COLORS['Bus'];
        if (leg.mode.includes("Bus")) color = MODE_COLORS['Bus'];
        if (leg.mode.includes("Tram")) color = MODE_COLORS['Tram'];
        if (leg.mode.includes("U-Bahn")) color = MODE_COLORS['U-Bahn'];
        if (leg.mode.includes("S-Bahn")) color = MODE_COLORS['S-Bahn'];

        let line = null;
        let distance = 0;
        let routeGeometry = [];

        // Get destination stop name for this leg
        const destinationStop = points[points.length - 1];
        const destinationName = destinationStop.name || `Stop ${destinationStop.id}`;

        // 1. Walking: Use OSRM walking profile for realistic pedestrian routes
        if (leg.mode === 'WALK') {
            try {
                const osrmCoords = points.map(p => `${p.lon},${p.lat}`).join(';');
                // Use 'walking' profile instead of 'driving' for pedestrian routes
                const url = `https://router.project-osrm.org/route/v1/walking/${osrmCoords}?overview=full&geometries=polyline`;
                
                const res = await fetch(url);
                const data = await res.json();

                if(data.routes && data.routes.length > 0) {
                    routeGeometry = decodePolyline(data.routes[0].geometry, 5);
                    distance = data.routes[0].distance; // Distance in meters from OSRM
                    line = L.polyline(routeGeometry, {
                        color: '#666', 
                        weight: 5, 
                        dashArray: '5, 12', 
                        opacity: 0.8,
                        className: 'walking-route'
                    });
                }
            } catch(e) {
                console.warn("OSRM walking failed, using straight line", e);
                // Fallback to straight line if OSRM fails
                routeGeometry = latLngs;
                distance = calculatePolylineDistance(latLngs);
                line = L.polyline(latLngs, {
                    color: '#666', 
                    weight: 5, 
                    dashArray: '5, 12', 
                    opacity: 0.8,
                    className: 'walking-route'
                });
            }
        }

        // 2. STRATEGY: RAILS AND TRAMS (Straight Line - No OSRM)
        // We moved Tram here to prevent loops!
        else if (leg.mode.includes("U-Bahn") || leg.mode.includes("S-Bahn") || leg.mode.includes("Tram")) {
            // Force straight lines
            routeGeometry = latLngs;
            distance = calculatePolylineDistance(latLngs);

            line = L.polyline(latLngs, {
                color: color,
                weight: 7,
                opacity: 1.0,
                lineCap: 'square', // Transit map style
                className: 'transit-route'
            });
        }

        // 3. STRATEGY: BUS ONLY (Use OSRM Driving)
        else {
            try {
                const osrmCoords = points.map(p => `${p.lon},${p.lat}`).join(';');
                const url = `https://router.project-osrm.org/route/v1/driving/${osrmCoords}?overview=full&geometries=polyline`;

                const res = await fetch(url);
                const data = await res.json();

                if(data.routes && data.routes.length > 0) {
                    routeGeometry = decodePolyline(data.routes[0].geometry, 5);
                    distance = data.routes[0].distance;
                    line = L.polyline(routeGeometry, { 
                        color: color, 
                        weight: 6, 
                        opacity: 0.9,
                        className: 'transit-route'
                    });
                }
            } catch(e) {
                console.warn("OSRM driving failed, using straight line", e);
                routeGeometry = latLngs;
                distance = calculatePolylineDistance(latLngs);
                line = L.polyline(latLngs, { 
                    color: color, 
                    weight: 6, 
                    opacity: 0.9,
                    className: 'transit-route'
                });
            }
        }

        // Create distance label
        let label = null;
        if (routeGeometry.length > 0) {
            // Calculate a point that's offset from the path
            let labelPoint;
            if (routeGeometry.length >= 2) {
                // Use 40% along the path and offset by ~20 meters
                const start = routeGeometry[0];
                const end = routeGeometry[routeGeometry.length - 1];
                labelPoint = calculateOffsetPoint(start, end, 0.4, 20);
            } else {
                // Fallback to midpoint if we don't have enough points
                const midIndex = Math.floor(routeGeometry.length / 2);
                labelPoint = routeGeometry[midIndex];
            }

            let labelText = '';
            if (leg.mode === 'WALK') {
                labelText = `Walk: ${formatDistance(distance)} to ${destinationName}`;
            } else {
                labelText = `${leg.route || leg.mode}: ${formatDistance(distance)} to ${destinationName}`;
            }

            // Create a custom div icon for the label
            // Create a custom div icon for the label
            label = L.marker(labelPoint, {
                icon: L.divIcon({
                    className: 'route-label',
                    html: `<div class="route-label-inner">${labelText}</div>`,
                    iconSize: [200, 35], // Increased from [160, 30] to accommodate longer text
                    iconAnchor: [100, 17]
                }),
                interactive: false,
                zIndexOffset: 1000
            });
        }

        return {
            line: line,
            startPoint: points[0],
            label: label,
            distance: distance,
            mode: leg.mode,
            route: leg.route,
            destinationName: destinationName,
            points: points
        };
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

                // Calculate total distance
                const totalDistance = results.reduce((sum, result) => sum + result.distance, 0);
                
                results.forEach((result, index) => {
                    if(result.line) {
                        result.line.addTo(map);
                        activeLayers.push(result.line);
                    }
                    if (result.label) {
                        result.label.addTo(map);
                        activeLayers.push(result.label);
                    }

                    // Add transition markers (only for transit modes)
                    if (result.mode !== 'WALK') {
                        const marker = L.circleMarker([result.startPoint.lat, result.startPoint.lon], {
                            radius: 4, 
                            color: '#000', 
                            fillColor: '#fff', 
                            fillOpacity: 1
                        }).addTo(map).bindTooltip(`${result.mode} to ${result.destinationName}`);
                        activeLayers.push(marker);
                    }
                });

                // Add start and end markers
                const startMarker = L.circleMarker([selectedStart.lat, selectedStart.lon], {
                    radius: 8,
                    color: '#000',
                    fillColor: '#4CAF50',
                    fillOpacity: 1,
                    weight: 2
                }).addTo(map).bindTooltip(`Start: ${selectedStart.stop_name}`, { permanent: false, direction: 'top' });
                activeLayers.push(startMarker);

                const endMarker = L.circleMarker([selectedEnd.lat, selectedEnd.lon], {
                    radius: 8,
                    color: '#000',
                    fillColor: '#F44336',
                    fillOpacity: 1,
                    weight: 2
                }).addTo(map).bindTooltip(`End: ${selectedEnd.stop_name}`, { permanent: false, direction: 'top' });
                activeLayers.push(endMarker);

                setStatus(`Route found! Total distance: ${formatDistance(totalDistance)}`, 'success');

                // Fit bounds to show entire route with padding
                const allPts = data.legs.flatMap(l => l.points.map(p => [p.lat, p.lon]));
                const bounds = L.latLngBounds(allPts);
                map.fitBounds(bounds, { padding: [60, 60] });

                // Update route summary
                routeSummary.innerHTML = `
                    <div class="route-summary-header">
                        <strong>Total Distance: ${formatDistance(totalDistance)}</strong>
                    </div>
                    ${results.map((result, index) => {
                        const leg = data.legs[index];
                        if (result.mode === 'WALK') {
                            return `<div class="route-leg">
                                <span class="leg-mode walk">🚶 Walk</span>
                                <span class="leg-details">${formatDistance(result.distance)} to ${result.destinationName}</span>
                            </div>`;
                        } else {
                            return `<div class="route-leg">
                                <span class="leg-mode transit">${getTransportIcon(result.mode)} ${result.mode}${result.route ? ` ${result.route}` : ''}</span>
                                <span class="leg-details">${formatDistance(result.distance)} to ${result.destinationName}</span>
                            </div>`;
                        }
                    }).join('')}
                `;
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

    // Helper function to get transport icons
    function getTransportIcon(mode) {
        const icons = {
            'U-Bahn': '🚇',
            'S-Bahn': '🚆',
            'Tram': '🚋',
            'Bus': '🚌'
        };
        return icons[mode] || '🚗';
    }

    findPathBtn.addEventListener('click', handleRoute);
    updateButtonState(); // Initialize button state
});