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

    const baseLayers = {
        "Light": L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap'
        }),
        "Dark": L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap'
        }),
        "OSM": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors'
        })
    };
    const map = L.map('map', { zoomControl: true, preferCanvas: true, layers: [baseLayers["Light"]] }).setView(window.DEFAULT_CENTER || [48.1351, 11.5820], 12);
    L.control.layers(baseLayers, {}, { position: 'bottomright', collapsed: false }).addTo(map);

    // Store selected stops/locations
    let selectedStart = null;
    let selectedEnd = null;
    let activeSelection = 'start';
    let startMarker = null;
    let endMarker = null;
    let hasBuiltRoute = false;
    let transportRouteActive = false;
    let mapPinMode = null;

    // Initial stop dots (only show after a zoom threshold to keep map clean)
    const STOP_VISIBILITY_ZOOM = 15;
    const stopsLayer = L.layerGroup();
    if (stops.length > 0) {
        stops.forEach(s => {
            const marker = L.circleMarker([s.lat, s.lon], {
                radius: 3,
                color: '#000',
                weight: 1.2,
                fillColor: '#fff',
                fillOpacity: 0.9
            }).bindTooltip(s.stop_name);
            marker.on('click', () => openStopPopup(s, marker));
            marker.addTo(stopsLayer);
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
    let activeRouteLayer = null;

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

    // Create custom draggable pin icons
    const createPinIcon = (color) => {
        const svg = `
        <svg xmlns='http://www.w3.org/2000/svg' width='24' height='36' viewBox='0 0 24 36'>
            <path d='M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z'
                  fill='${color}' stroke='#ffffff' stroke-width='2'/>
            <path d='M12 34L6 22h12l-6 12z' fill='${color}' stroke='#ffffff' stroke-width='1.5'/>
        </svg>`;
        return L.icon({
            iconUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
            iconSize: [24, 36],
            iconAnchor: [12, 36],
            tooltipAnchor: [0, -30],
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
            shadowSize: [41, 41],
            shadowAnchor: [12, 41]
        });
    };

    const startPinIcon = createPinIcon('#12784f');
    const endPinIcon = createPinIcon('#b12a2a');

    function setMarker(type, location) {
        const latLng = [location.lat, location.lon];
        const tooltipText = type === 'start'
            ? `Start: ${location.label || location.stop_name || 'Pinned start'}`
            : `End: ${location.label || location.stop_name || 'Pinned destination'}`;

        const markerOptions = {
            icon: type === 'start' ? startPinIcon : endPinIcon,
            keyboard: false,
            draggable: true,
            autoPan: true,
            autoPanPadding: [50, 50]
        };

        const marker = L.marker(latLng, markerOptions)
            .addTo(map)
            .bindTooltip(tooltipText, { permanent: false, direction: 'top' })
            .on('dragstart', function() {
                this.setZIndexOffset(1000);
                setStatus(`Dragging ${type} point...`, 'idle');
            })
            .on('drag', function(e) {
                const pos = e.target.getLatLng();
                e.target.setTooltipContent(`${type === 'start' ? 'Start' : 'End'}: (${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)})`);
            })
            .on('dragend', function(e) {
                const marker = e.target;
                const newPosition = marker.getLatLng();
                
                // Update the selected location
                const updatedLocation = {
                    ...(type === 'start' ? selectedStart : selectedEnd),
                    lat: newPosition.lat,
                    lon: newPosition.lng,
                    label: `Pinned location (${newPosition.lat.toFixed(5)}, ${newPosition.lng.toFixed(5)})`,
                    source: 'pin'
                };
                
                if (type === 'start') {
                    selectedStart = updatedLocation;
                    startInput.value = selectedStart.label;
                } else {
                    selectedEnd = updatedLocation;
                    endInput.value = selectedEnd.label;
                }
                
                marker.setZIndexOffset(0);
                marker.setTooltipContent(`${type === 'start' ? 'Start' : 'End'}: ${updatedLocation.label}`);
                
                // Only update status - no automatic route recalculation
                setStatus(`${type === 'start' ? 'Start' : 'End'} point moved. Click "Draw route" to recalculate.`, 'idle');
                updateButtonState();
            });

        if (type === 'start') {
            if (startMarker) map.removeLayer(startMarker);
            startMarker = marker;
        } else {
            if (endMarker) map.removeLayer(endMarker);
            endMarker = marker;
        }
        
        return marker;
    }

    function clearRouteOverlays() {
        if (activeRouteLayer) {
            map.removeLayer(activeRouteLayer);
            activeRouteLayer = null;
        }
        if (activeLayers && activeLayers.length) {
            activeLayers.forEach(l => {
                if (map.hasLayer(l)) map.removeLayer(l);
            });
            activeLayers = [];
        }
        // Don't remove the markers, only clear the route
        if (routeSummary) {
            routeSummary.innerHTML = '';
            routeSummary.classList.add('hidden');
        }
        updateButtonState();
        hasBuiltRoute = false;
        transportRouteActive = false;
        setStatus('Cleared route overlay and pins', 'idle');
    }

    function clearTransportRoute() {
        if (activeRouteLayer) {
            map.removeLayer(activeRouteLayer);
            activeRouteLayer = null;
        }
        transportRouteActive = false;
    }

    function clearConstructedRoute() {
        if (activeLayers && activeLayers.length) {
            activeLayers.forEach(l => {
                if (map.hasLayer(l)) map.removeLayer(l);
            });
            activeLayers = [];
        }
        if (startMarker) {
            map.removeLayer(startMarker);
            startMarker = null;
        }
        if (endMarker) {
            map.removeLayer(endMarker);
            endMarker = null;
        }
        if (routeSummary) {
            routeSummary.innerHTML = '';
            routeSummary.classList.add('hidden');
        }
        hasBuiltRoute = false;
        updateButtonState();
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
        transportRouteActive = false;
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
        // If a route (constructed or transport) is active, clear it and pins
        if (hasBuiltRoute || transportRouteActive) {
            clearRouteOverlays();
            return;
        }

        // Only handle pin placement if in pin mode
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

    // Function to clear the route overlay only (keep pins)
    function clearRouteOverlay() {
        if (activeRouteLayer) {
            map.removeLayer(activeRouteLayer);
            activeRouteLayer = null;
        }
        if (activeLayers && activeLayers.length) {
            activeLayers.forEach(l => {
                if (map.hasLayer(l)) map.removeLayer(l);
            });
            activeLayers = [];
        }
        if (routeSummary) {
            routeSummary.innerHTML = '';
            routeSummary.classList.add('hidden');
        }
        hasBuiltRoute = false;
        setStatus('Cleared route overlay', 'idle');
    }

    // Add keyboard shortcut for clearing route (Escape key)
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            clearRouteOverlay();
        }
    });


    
    map.on('click', handleMapClick);

    function minutesUntil(timeStr) {
        if (!timeStr) return null;
        const parts = timeStr.split(':').map(Number);
        if (parts.length < 2) return null;
        const now = new Date();
        const target = new Date(now);
        target.setHours(parts[0], parts[1], parts[2] || 0, 0);
        let diffMs = target - now;
        if (diffMs < 0) diffMs += 24 * 60 * 60 * 1000; // wrap to next day if passed
        return Math.round(diffMs / 60000);
    }

    function minutesUntilTimestamp(ts, delay = 0) {
        if (!ts) return null;
        const targetMs = (Number(ts) + Number(delay || 0)) * 1000;
        let diffMs = targetMs - Date.now();
        return Math.round(diffMs / 60000);
    }

    function formatMinutes(mins) {
        if (mins == null) return '';
        if (mins < 1) return 'now';
        if (mins < 90) return `${mins} min`;
        return `${(mins / 60).toFixed(1)} h`;
    }

    function formatTimeFromTimestamp(ts, delay = 0) {
        if (!ts) return '';
        const d = new Date((Number(ts) + Number(delay || 0)) * 1000);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function guessModeFromRouteName(name) {
        if (!name) return 'Bus';
        const upper = String(name).toUpperCase();
        if (upper.startsWith('U')) return 'U-Bahn';
        if (upper.startsWith('S')) return 'S-Bahn';
        if (upper.includes('TRAM')) return 'Tram';
        // Simple heuristic: low numbers often tram, else bus
        const num = parseInt(upper.replace(/\\D/g, ''), 10);
        if (!isNaN(num) && num > 0 && num <= 30) return 'Tram';
        return 'Bus';
    }

    function modeToColor(mode) {
        let color = MODE_COLORS[mode] || MODE_COLORS['Bus'];
        if (mode && mode.includes("Bus")) color = MODE_COLORS['Bus'];
        if (mode && mode.includes("Tram")) color = MODE_COLORS['Tram'];
        if (mode && mode.includes("U-Bahn")) color = MODE_COLORS['U-Bahn'];
        if (mode && mode.includes("S-Bahn")) color = MODE_COLORS['S-Bahn'];
        return color;
    }

    function addStopMarkersToLayer(stops, color) {
        if (!stops || !stops.length || !activeRouteLayer) return;
        stops.forEach(s => {
            const lat = s.lat ?? s.stop_lat;
            const lon = s.lon ?? s.stop_lon;
            if (lat == null || lon == null) return;
            const marker = L.circleMarker([lat, lon], {
                radius: 3,
                color: color,
                weight: 1.2,
                fillColor: '#fff',
                fillOpacity: 0.9
            }).bindTooltip(s.name || s.stop_name || s.id || s.stop_id || 'Stop');
            marker.on('click', () => openStopPopup({
                stop_id: s.id || s.stop_id,
                stop_name: s.name || s.stop_name,
                lat,
                lon
            }, marker));
            marker.addTo(activeRouteLayer);
        });
    }

    async function openStopPopup(stop, marker) {
        const stopName = stop.stop_name || stop.name || 'Stop';
        const stopId = stop.stop_id || stop.id;
        let departures = [];

        try {
            const depRes = await fetch(`/api/departures/${encodeURIComponent(stopId)}`);
            if (depRes.ok) {
                const depData = await depRes.json();
                departures = Array.isArray(depData) ? depData : [];
            }
        } catch (err) {
            console.warn('Departures fetch failed', err);
        }

        const grouped = departures.reduce((acc, d) => {
            const key = d.route_short_name || 'Route';
            const mode = guessModeFromRouteName(key);
            if (!acc[key]) acc[key] = { times: [], trip_id: d.trip_id, mode };
            const mins = minutesUntilTimestamp(d.departure_timestamp, d.delay || 0);
            acc[key].times.push({ mins });
            if (!acc[key].trip_id && d.trip_id) acc[key].trip_id = d.trip_id;
            if (!acc[key].mode) acc[key].mode = mode;
            return acc;
        }, {});

        const departuresHtml = Object.keys(grouped).length
            ? Object.entries(grouped).map(([route, payload]) => `
                <div class="stop-popup__departure-group">
                    <button class="route-link route-link--${(payload.mode || 'bus').toLowerCase().replace(/\\s+/g,'-')}" data-route="${route}" data-trip="${payload.trip_id || ''}">${route}</button>
                    <div class="stop-popup__times">${
                        payload.times
                            .sort((a, b) => (a.mins ?? 1e9) - (b.mins ?? 1e9))
                            .slice(0, 3)
                                .map((t, idx) => {
                                    const text = formatMinutes(t.mins);
                                    const cls = idx === 0 ? 'time-pill time-pill--highlight' : 'time-pill';
                                    return `<span class="${cls}">${text}</span>`;
                                }).join('')
                    }</div>
                </div>
            `).join('')
            : '<div class="stop-popup__meta">Departures unavailable</div>';

        const html = `
            <div class="stop-popup">
                <div class="stop-popup__name">${stopName}</div>
                <div class="stop-popup__section">
                    <div class="stop-popup__section-title">Upcoming departures:</div>
                    ${departuresHtml}
                </div>
            </div>
        `;
        marker.bindPopup(html, { closeButton: true }).openPopup();
    }

    async function drawRouteByName(routeName) {
        try {
            if (activeRouteLayer) {
                map.removeLayer(activeRouteLayer);
                activeRouteLayer = null;
            }
            
            const res = await fetch(`/api/route/${encodeURIComponent(routeName)}`);
            const data = await res.json();
            if (!res.ok || !data.segments || !data.segments.length) {
                setStatus(`No geometry for route ${routeName}`, 'error');
                return;
            }

            // Determine mode/color
            const routeMode = guessModeFromRouteName(routeName);
            const routeColor = modeToColor(routeMode);
            // Determine if this is a bus route (we'll assume buses follow roads, others get straight lines)
            const isBusRoute = routeMode === 'Bus' || routeName.match(/^\d/) || routeName.toLowerCase().includes('bus');
            
            if (isBusRoute) {
                // For bus routes, use OSRM to get proper road geometry
                clearConstructedRoute();
                await drawRouteWithOSRM(routeName, data.segments, data.stops || [], routeColor);
            } else {
                // For rail routes (U-Bahn, S-Bahn, Tram), use straight lines
                clearConstructedRoute();
                await drawRouteStraight(routeName, data.segments, data.stops || [], routeColor);
            }
        } catch (err) {
            console.warn('Failed to draw route', err);
            setStatus(`Failed to draw route ${routeName}`, 'error');
        }
    }

    async function drawRouteWithOSRM(routeName, segments, stops, color) {
        try {
            // Extract all unique coordinates from segments
            const allCoords = [];
            segments.forEach(seg => {
                allCoords.push([seg.from.lat, seg.from.lon]);
                allCoords.push([seg.to.lat, seg.to.lon]);
            });

            // Remove duplicates (simple approach - in production you might want more sophisticated deduplication)
            const uniqueCoords = Array.from(new Set(allCoords.map(JSON.stringify))).map(JSON.parse);
            
            // Sort coordinates to create a logical route order (nearest neighbor approach)
            const sortedCoords = sortCoordinatesByProximity(uniqueCoords);
            
            if (sortedCoords.length < 2) {
                await drawRouteStraight(routeName, segments);
                return;
            }

            // Convert to OSRM format: "lon,lat;lon,lat;..."
            const osrmCoords = sortedCoords.map(coord => `${coord[1]},${coord[0]}`).join(';');
            const url = `https://routing.openstreetmap.de/routed-car/route/v1/driving/${osrmCoords}?overview=full&geometries=polyline`;

            const res = await fetch(url);
            const data = await res.json();

            if (data.routes && data.routes.length > 0) {
                const routeGeometry = decodePolyline(data.routes[0].geometry, 5);
                activeRouteLayer = L.layerGroup();
                L.polyline(routeGeometry, {
                    color: color,
                    weight: 6,
                    opacity: 0.9,
                    className: 'bus-route-line'
                }).addTo(activeRouteLayer);
                addStopMarkersToLayer(stops, color);
                activeRouteLayer.addTo(map);

                // Fit bounds to the OSRM route
                if (routeGeometry.length) {
                    map.fitBounds(routeGeometry, { padding: [40, 40] });
                }
                transportRouteActive = true;
                setStatus(`Showing bus route ${routeName} (following roads)`, 'success');
            } else {
                // Fallback to straight lines if OSRM fails
                console.warn('OSRM failed, falling back to straight lines');
                await drawRouteStraight(routeName, segments, stops, color);
            }
        } catch (error) {
            console.warn('OSRM routing failed, using straight lines', error);
            await drawRouteStraight(routeName, segments, stops, color);
        }
    }

    async function drawRouteStraight(routeName, segments, stops, color) {
        const polylines = segments.map(seg => {
            return [[seg.from.lat, seg.from.lon], [seg.to.lat, seg.to.lon]];
        });
        
        activeRouteLayer = L.layerGroup();
        polylines.forEach(coords => {
            L.polyline(coords, {
                color: color || '#e53935',
                weight: 4,
                opacity: 0.9
            }).addTo(activeRouteLayer);
        });
        addStopMarkersToLayer(stops, color || '#e53935');
        activeRouteLayer.addTo(map);
        
        const allPts = polylines.flat();
        if (allPts.length) {
            map.fitBounds(allPts, { padding: [40, 40] });
        }
        transportRouteActive = true;
        setStatus(`Showing route ${routeName}`, 'success');
    }

    async function drawTripRoute(tripId, routeName) {
        try {
            if (activeRouteLayer) {
                map.removeLayer(activeRouteLayer);
                activeRouteLayer = null;
            }
            
            const res = await fetch(`/api/trip_stops/${encodeURIComponent(tripId)}`);
            const data = await res.json();
            if (!res.ok || !data.stops || !data.stops.length) {
                // fallback to route name if trip fails
                if (routeName) {
                    await drawRouteByName(routeName);
                } else {
                    setStatus(`No stops found for trip ${tripId}`, 'error');
                }
                return;
            }

            const coords = data.stops.map(s => [s.lat, s.lon]);
            const routeMode = guessModeFromRouteName(routeName || '');
            const routeColor = modeToColor(routeMode);
            const isBusRoute = routeMode === 'Bus' || (routeName && (routeName.match(/^\d/) || routeName.toLowerCase().includes('bus')));

            if (isBusRoute && coords.length >= 2) {
                // For bus trips, use OSRM
                clearConstructedRoute();
                await drawTripWithOSRM(tripId, routeName, coords, data.stops, routeColor);
            } else {
                // For rail trips, use straight lines
                activeRouteLayer = L.layerGroup();
                L.polyline(coords, {
                    color: routeColor,
                    weight: 5,
                    opacity: 0.9
                }).addTo(activeRouteLayer);
                addStopMarkersToLayer(data.stops, routeColor);
                activeRouteLayer.addTo(map);
                
                if (coords.length) {
                    map.fitBounds(coords, { padding: [40, 40] });
                }
                transportRouteActive = true;
                setStatus(`Showing trip ${tripId}${routeName ? ` (${routeName})` : ''}`, 'success');
            }
        } catch (err) {
            console.warn('Failed to draw trip', err);
            setStatus(`Failed to draw trip ${tripId}`, 'error');
        }
    }

    async function drawTripWithOSRM(tripId, routeName, coords, stops, color) {
        try {
            // Convert to OSRM format
            const osrmCoords = coords.map(coord => `${coord[1]},${coord[0]}`).join(';');
            const url = `https://routing.openstreetmap.de/routed-car/route/v1/driving/${osrmCoords}?overview=full&geometries=polyline`;

            const res = await fetch(url);
            const data = await res.json();

            if (data.routes && data.routes.length > 0) {
                const routeGeometry = decodePolyline(data.routes[0].geometry, 5);
                activeRouteLayer = L.layerGroup();
                L.polyline(routeGeometry, {
                    color: color,
                    weight: 6,
                    opacity: 0.9,
                    className: 'bus-route-line'
                }).addTo(activeRouteLayer);
                addStopMarkersToLayer(stops, color);
                activeRouteLayer.addTo(map);

                if (routeGeometry.length) {
                    map.fitBounds(routeGeometry, { padding: [40, 40] });
                }
                setStatus(`Showing bus trip ${tripId} (${routeName}) following roads`, 'success');
            } else {
                // Fallback to straight lines
                activeRouteLayer = L.layerGroup();
                L.polyline(coords, {
                    color: color,
                    weight: 5,
                    opacity: 0.9
                }).addTo(activeRouteLayer);
                addStopMarkersToLayer(stops, color);
                activeRouteLayer.addTo(map);
                
                if (coords.length) {
                    map.fitBounds(coords, { padding: [40, 40] });
                }
                setStatus(`Showing bus trip ${tripId} (${routeName})`, 'success');
            }
        } catch (error) {
            console.warn('OSRM routing failed, using straight lines', error);
            // Fallback to straight lines
            activeRouteLayer = L.layerGroup();
            L.polyline(coords, {
                color: color,
                weight: 5,
                opacity: 0.9
            }).addTo(activeRouteLayer);
            addStopMarkersToLayer(stops, color);
            activeRouteLayer.addTo(map);
            
            if (coords.length) {
                map.fitBounds(coords, { padding: [40, 40] });
            }
            setStatus(`Showing bus trip ${tripId} (${routeName})`, 'success');
        }
    }

    // Helper function to sort coordinates by proximity (nearest neighbor)
    function sortCoordinatesByProximity(coords) {
        if (coords.length <= 2) return coords;
        
        const sorted = [coords[0]];
        const remaining = [...coords.slice(1)];
        
        while (remaining.length > 0) {
            const lastCoord = sorted[sorted.length - 1];
            let nearestIndex = 0;
            let nearestDistance = Number.MAX_VALUE;
            
            for (let i = 0; i < remaining.length; i++) {
                const distance = calculateDistance(lastCoord, remaining[i]);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestIndex = i;
                }
            }
            
            sorted.push(remaining[nearestIndex]);
            remaining.splice(nearestIndex, 1);
        }
        
        return sorted;
    }

    // Helper function to calculate distance between two coordinates
    function calculateDistance(coord1, coord2) {
        const R = 6371000; // Earth's radius in meters
        const dLat = (coord2[0] - coord1[0]) * Math.PI / 180;
        const dLon = (coord2[1] - coord1[1]) * Math.PI / 180;
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(coord1[0] * Math.PI / 180) * Math.cos(coord2[0] * Math.PI / 180) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }   

    map.on('popupopen', (e) => {
        const popupEl = e.popup.getElement();
        if (!popupEl) return;
        const links = popupEl.querySelectorAll('.route-link');
        links.forEach(link => {
            link.addEventListener('click', (evt) => {
                evt.preventDefault();
                const routeName = link.dataset.route;
                const tripId = link.dataset.trip;
                if (tripId) {
                    drawTripRoute(tripId, routeName);
                } else if (routeName) {
                    drawRouteByName(routeName);
                }
            });
        });
    });

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

    function hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    const handleRoute = async () => {
        if (!selectedStart || !selectedEnd) {
            setStatus('Please select both start and destination locations', 'error');
            return;
        }

        // Hide any transport route currently shown
        clearTransportRoute();

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
                        const startMarker = L.circleMarker([result.startPoint.lat, result.startPoint.lon], {
                            radius: 4, 
                            color: '#000', 
                            fillColor: '#fff', 
                            fillOpacity: 1
                        }).addTo(map).bindTooltip(`${result.mode} to ${result.destinationName}`);
                        activeLayers.push(startMarker);

                        const endPt = result.points[result.points.length - 1];
                        const endMarker = L.circleMarker([endPt.lat, endPt.lon], {
                            radius: 4,
                            color: '#000',
                            fillColor: '#fff',
                            fillOpacity: 1
                        }).addTo(map).bindTooltip(`Arrive: ${result.destinationName}`);
                        activeLayers.push(endMarker);
                    }
                });

                setStatus(`Route found! Total distance: ${formatDistance(totalDistance)}`, 'success');

                // Fit bounds to show entire route with padding
                const allPts = data.legs.flatMap(l => l.points.map(p => [p.lat, p.lon]));
                const bounds = L.latLngBounds(allPts);
                map.fitBounds(bounds, { padding: [60, 60] });

                // Update route summary
                // Update route summary with full color matching
                routeSummary.innerHTML = `
                    <div class="route-summary-header">
                        <strong>Total Distance: ${formatDistance(totalDistance)}</strong>
                    </div>
                    ${results.map((result, index) => {
                        const leg = data.legs[index];
                        const color = MODE_COLORS[result.mode] || MODE_COLORS['Bus'];
                        const bgColor = hexToRgba(color, 0.15); // Convert to rgba for background
                        
                        if (result.mode === 'WALK') {
                            return `<div class="route-leg">
                                <span class="leg-mode walk" style="color: ${color}; background: ${bgColor}; border-left: 3px solid ${color};">🚶 Walk</span>
                                <span class="leg-details">${formatDistance(result.distance)} to ${result.destinationName}</span>
                            </div>`;
                        } else {
                            return `<div class="route-leg">
                                <span class="leg-mode transit" style="color: ${color}; background: ${bgColor}; border-left: 3px solid ${color};">${getTransportIcon(result.mode)} ${result.mode}${result.route ? ` ${result.route}` : ''}</span>
                                <span class="leg-details">${formatDistance(result.distance)} to ${result.destinationName}</span>
                            </div>`;
                        }
                    }).join('')}
                `;
                routeSummary.classList.remove('hidden');
                hasBuiltRoute = true;
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
