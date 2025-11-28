document.addEventListener('DOMContentLoaded', () => {
    const stops = window.STOP_DATA || [];
    const startInput = document.getElementById('start-stop');
    const endInput = document.getElementById('end-stop');
    const startPinBtn = document.getElementById('start-pin-btn');
    const endPinBtn = document.getElementById('end-pin-btn');
    const startResults = document.getElementById('start-results');
    const endResults = document.getElementById('end-results');
    const statusEl = document.getElementById('status');
    const routeSummary = document.getElementById('route-summary');
    const findPathBtn = document.getElementById('find-path-btn');

    const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(window.DEFAULT_CENTER || [48.1351, 11.5820], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    // Store selected stops/locations
    let selectedStart = null;
    let selectedEnd = null;
    let activeSelection = 'start';
    let startMarker = null;
    let endMarker = null;
    let mapPinMode = null;

    // Initial stop dots (only show after a zoom threshold to keep map clean)
    const STOP_VISIBILITY_ZOOM = 15;
    const stopsLayer = L.layerGroup();
    if (stops.length > 0) {
        stops.forEach(s => {
            L.circleMarker([s.lat, s.lon], {
                radius: 2,
                color: '#444',
                weight: 0.5,
                fillColor: '#fff',
                fillOpacity: 0.5
            }).bindTooltip(s.stop_name).addTo(stopsLayer);
        });
    }
    const updateStopVisibility = () => {
        if (map.getZoom() >= STOP_VISIBILITY_ZOOM) {
            if (!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer);
        } else {
            if (map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
        }
    };
    map.on('zoomend', updateStopVisibility);
    updateStopVisibility();

    let activeLayers = [];
    let currentHoverTooltip = null;

    const setStatus = (msg, type) => {
        statusEl.textContent = msg;
        statusEl.className = `status status--${type}`;
    };

    // Search helpers
    function searchStops(query, maxResults = 3) {
        if (!query || query.length < 2) return [];
        const lowerQuery = query.toLowerCase();
        return stops
            .filter(stop => 
                stop.stop_name.toLowerCase().includes(lowerQuery) ||
                stop.stop_id.toLowerCase().includes(lowerQuery)
            )
            .slice(0, maxResults)
            .map(stop => ({
                label: stop.stop_name,
                subtitle: `Transit stop • ${stop.stop_id}`,
                lat: stop.lat,
                lon: stop.lon,
                stop_id: stop.stop_id,
                source: 'stop'
            }));
    }

    const MUNICH_BOUNDS = {
        west: 10.7,
        east: 12.3,
        north: 48.6,
        south: 47.8
    };

    function isWithinMunich(lat, lon) {
        return (
            lat <= MUNICH_BOUNDS.north &&
            lat >= MUNICH_BOUNDS.south &&
            lon >= MUNICH_BOUNDS.west &&
            lon <= MUNICH_BOUNDS.east
        );
    }

    async function geocodePlaces(query, maxResults = 5) {
        if (!query || query.length < 3) return [];
        try {
            const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${maxResults}&countrycodes=de&bounded=1&viewbox=${MUNICH_BOUNDS.west},${MUNICH_BOUNDS.north},${MUNICH_BOUNDS.east},${MUNICH_BOUNDS.south}&q=${encodeURIComponent(query)}`;
            const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
            const data = await res.json();
            return (data || [])
                .filter(place => {
                    const lat = parseFloat(place.lat);
                    const lon = parseFloat(place.lon);
                    return isWithinMunich(lat, lon);
                })
                .map(place => ({
                    label: place.display_name,
                    subtitle: place.type ? place.type.replace(/_/g, ' ') : 'Address',
                    lat: parseFloat(place.lat),
                    lon: parseFloat(place.lon),
                    source: 'address'
                }));
        } catch (e) {
            console.warn('Geocoding failed', e);
            return [];
        }
    }

    async function searchLocations(query) {
        const [geocoded, stopMatches] = await Promise.all([
            geocodePlaces(query),
            Promise.resolve(searchStops(query))
        ]);
        return [...geocoded, ...stopMatches];
    }

    // Display search results
    function showResults(input, results, resultsContainer, onSelect) {
        resultsContainer.innerHTML = '';
        
        if (results.length === 0 && input.value.length >= 3) {
            const noResult = document.createElement('div');
            noResult.className = 'autocomplete-item';
            noResult.textContent = 'No places found';
            resultsContainer.appendChild(noResult);
            return;
        }
        
        results.forEach(item => {
            const resultEl = document.createElement('div');
            resultEl.className = 'autocomplete-item';
            resultEl.innerHTML = `
                <strong>${item.label}</strong>
                ${item.subtitle ? `<small>${item.subtitle}</small>` : ''}
            `;
            resultEl.addEventListener('click', () => {
                input.value = item.label;
                resultsContainer.innerHTML = '';
                onSelect(item);
            });
            resultsContainer.appendChild(resultEl);
        });
    }

    // Setup autocomplete for an input
    function setupAutocomplete(input, resultsContainer, onSelect) {
        let currentResults = [];
        let debounceHandle = null;
        
        const performSearch = async (query) => {
            currentResults = await searchLocations(query);
            showResults(input, currentResults, resultsContainer, onSelect);
        };
        
        input.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            clearTimeout(debounceHandle);

            if (query.length < 3) {
                resultsContainer.innerHTML = '';
                currentResults = [];
                return;
            }

            debounceHandle = setTimeout(() => performSearch(query), 250);
        });
        
        input.addEventListener('focus', () => {
            if (input.value.trim().length >= 3) {
                performSearch(input.value.trim());
            }
            activeSelection = input.id === 'start-stop' ? 'start' : 'end';
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

    function setMarker(type, location) {
        const latLng = [location.lat, location.lon];
        const markerOptions = {
            radius: 8,
            color: '#000',
            fillOpacity: 1,
            weight: 2
        };
        if (type === 'start') {
            if (startMarker) map.removeLayer(startMarker);
            startMarker = L.circleMarker(latLng, { ...markerOptions, fillColor: '#4CAF50' })
                .addTo(map)
                .bindTooltip(`Start: ${location.label || location.stop_name || 'Pinned start'}`);
        } else {
            if (endMarker) map.removeLayer(endMarker);
            endMarker = L.circleMarker(latLng, { ...markerOptions, fillColor: '#F44336' })
                .addTo(map)
                .bindTooltip(`End: ${location.label || location.stop_name || 'Pinned destination'}`);
        }
    }

    function setSelection(type, location) {
        const parsed = {
            ...location,
            lat: parseFloat(location.lat),
            lon: parseFloat(location.lon)
        };

        if (type === 'start') {
            selectedStart = parsed;
            startInput.value = location.label || location.stop_name || startInput.value;
            setMarker('start', parsed);
            activeSelection = 'end';
        } else {
            selectedEnd = parsed;
            endInput.value = location.label || location.stop_name || endInput.value;
            setMarker('end', parsed);
            activeSelection = 'start';
        }
        updateButtonState();
    }

    // Initialize autocomplete for both inputs
    setupAutocomplete(startInput, startResults, (location) => {
        setSelection('start', location);
        mapPinMode = null;
    });
    
    setupAutocomplete(endInput, endResults, (location) => {
        setSelection('end', location);
        mapPinMode = null;
    });

    // Update button state based on selection
    function updateButtonState() {
        if (
            selectedStart && selectedEnd &&
            selectedStart.lat != null && selectedStart.lon != null &&
            selectedEnd.lat != null && selectedEnd.lon != null
        ) {
            findPathBtn.disabled = false;
        } else {
            findPathBtn.disabled = true;
        }
    }

    function handleMapClick(e) {
        if (!mapPinMode) return;
        const target = mapPinMode;
        const location = {
            label: `Pinned location (${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)})`,
            lat: e.latlng.lat,
            lon: e.latlng.lng,
            source: 'pin'
        };
        setSelection(target, location);
        setStatus(`Pinned ${target} location on map`, 'idle');
        mapPinMode = null;
    }

    map.on('click', handleMapClick);

    startPinBtn.addEventListener('click', () => {
        mapPinMode = 'start';
        activeSelection = 'start';
        setStatus('Click on the map to set start point', 'idle');
    });

    endPinBtn.addEventListener('click', () => {
        mapPinMode = 'end';
        activeSelection = 'end';
        setStatus('Click on the map to set destination', 'idle');
    });

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

        // Create tooltip text
        let tooltipText = '';
        if (leg.mode === 'WALK') {
            tooltipText = `Walk: ${formatDistance(distance)} to ${destinationName}`;
        } else {
            tooltipText = `${leg.route || leg.mode}: ${formatDistance(distance)} to ${destinationName}`;
        }

        // 1. Walking: Use OSRM walking profile for realistic pedestrian routes
        if (leg.mode === 'WALK') {
            try {
                const osrmCoords = points.map(p => `${p.lon},${p.lat}`).join(';');
                // Use 'walking' profile instead of 'driving' for pedestrian routes
                const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${osrmCoords}?overview=full&geometries=polyline`;
                
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
                const url = `https://routing.openstreetmap.de/routed-car/route/v1/driving/${osrmCoords}?overview=full&geometries=polyline`;

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

        // Update tooltip text with actual distance
        if (leg.mode === 'WALK') {
            tooltipText = `Walk: ${formatDistance(distance)} to ${destinationName}`;
        } else {
            tooltipText = `${leg.route || leg.mode}: ${formatDistance(distance)} to ${destinationName}`;
        }

        // Add hover tooltip to the line
        if (line) {
            line.bindTooltip(tooltipText, {
                sticky: true,
                direction: 'top',
                className: 'path-tooltip',
                opacity: 0.9
            });

            // Add hover effects
            line.on('mouseover', function(e) {
                this.setStyle({
                    weight: this.options.weight + 2,
                    opacity: 1.0
                });
                if (!L.Browser.ie && !L.Browser.opera) {
                    this.bringToFront();
                }
            });

            line.on('mouseout', function(e) {
                this.setStyle({
                    weight: this.options.weight - 2,
                    opacity: this.options.opacity
                });
            });
        }

        return {
            line: line,
            startPoint: points[0],
            distance: distance,
            mode: leg.mode,
            route: leg.route,
            destinationName: destinationName,
            points: points
        };
    };

    const handleRoute = async () => {
        if (!selectedStart || !selectedEnd) {
            setStatus('Please select both start and destination locations', 'error');
            return;
        }

        // Clear previous route layers (keep pinned markers)
        activeLayers = activeLayers.filter(l => l !== startMarker && l !== endMarker);
        activeLayers.forEach(l => map.removeLayer(l));
        activeLayers = [];

        setStatus('Routing...', 'idle');
        findPathBtn.textContent = 'Calculating...';
        findPathBtn.disabled = true;

        try {
            const params = new URLSearchParams();
            if (selectedStart.stop_id) params.set('start', selectedStart.stop_id);
            if (selectedEnd.stop_id) params.set('end', selectedEnd.stop_id);
            if (selectedStart.lat != null && selectedStart.lon != null) {
                params.set('start_lat', selectedStart.lat);
                params.set('start_lon', selectedStart.lon);
            }
            if (selectedEnd.lat != null && selectedEnd.lon != null) {
                params.set('end_lat', selectedEnd.lat);
                params.set('end_lon', selectedEnd.lon);
            }
            if (selectedStart.label) params.set('start_label', selectedStart.label);
            if (selectedEnd.label) params.set('end_label', selectedEnd.label);

            const res = await fetch(`/api/path?${params.toString()}`);
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
