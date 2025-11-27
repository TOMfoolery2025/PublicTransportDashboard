document.addEventListener('DOMContentLoaded', () => {
    const stops = window.STOP_DATA || [];
    const startSelect = document.getElementById('start-stop');
    const endSelect = document.getElementById('end-stop');
    const statusEl = document.getElementById('status');
    const routeSummary = document.getElementById('route-summary');
    const findPathBtn = document.getElementById('find-path-btn');

    const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(window.DEFAULT_CENTER || [48.1351, 11.5820], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CartoDB'
    }).addTo(map);

    // Fit map to known stop bounds if coordinates exist
    const coords = stops.filter(s => s.lat && s.lon).map(s => [s.lat, s.lon]);
    if (coords.length) {
        map.fitBounds(coords, { padding: [30, 30] });
    }

    let pathLayer = null;
    let startMarker = null;
    let endMarker = null;
    let networkLayer = null;
    let stopMarkers = null;

    const setStatus = (message = '', type = 'idle') => {
        statusEl.textContent = message;
        statusEl.className = `status status--${type}`;
    };

    const renderSummary = path => {
        if (!path || !path.length) {
            routeSummary.classList.add('hidden');
            return;
        }
        const start = path[0];
        const end = path[path.length - 1];
        routeSummary.innerHTML = `
            <div><strong>From:</strong> ${start.stop_name}</div>
            <div><strong>To:</strong> ${end.stop_name}</div>
            <div><strong>Stops:</strong> ${path.length}</div>
        `;
        routeSummary.classList.remove('hidden');
    };

    const drawRoute = path => {
        const latLngs = path.map(p => [p.lat, p.lon]);

        if (pathLayer) pathLayer.remove();
        if (startMarker) startMarker.remove();
        if (endMarker) endMarker.remove();

        pathLayer = L.polyline(latLngs, { color: '#5cf0c0', weight: 6, opacity: 0.85 }).addTo(map);
        startMarker = L.circleMarker(latLngs[0], { radius: 8, color: '#5cf0c0', fillColor: '#0f172a', fillOpacity: 1 }).addTo(map).bindTooltip('Start', { permanent: true, direction: 'right' });
        endMarker = L.circleMarker(latLngs[latLngs.length - 1], { radius: 8, color: '#7bd7ff', fillColor: '#0f172a', fillOpacity: 1 }).addTo(map).bindTooltip('End', { permanent: true, direction: 'right' });

        map.fitBounds(pathLayer.getBounds(), { padding: [20, 20] });
        renderSummary(path);
    };

    const drawNetwork = (network) => {
        if (networkLayer) networkLayer.remove();
        if (stopMarkers) stopMarkers.remove();

        const edges = network.edges || [];
        const stops = network.stops || [];

        networkLayer = L.layerGroup();
        edges.forEach(edge => {
            if (!edge.coords) return;
            L.polyline(edge.coords, {
                color: '#2a3f6e',
                weight: 1,
                opacity: 0.35,
                interactive: false,
            }).addTo(networkLayer);
        });

        stopMarkers = L.layerGroup();
        stops.forEach(s => {
            if (!s.lat || !s.lon) return;
            L.circleMarker([s.lat, s.lon], {
                radius: 3,
                color: 'transparent',
                fillColor: '#1b2f5b',
                fillOpacity: 0.9,
                weight: 0,
            }).bindTooltip(s.stop_name, { direction: 'top', offset: [0, -4], opacity: 0.8 }).addTo(stopMarkers);
        });

        networkLayer.addTo(map);
        stopMarkers.addTo(map);
    };

    const loadNetwork = async () => {
        setStatus('', 'idle');
        try {
            const res = await fetch('/api/network');
            const data = await res.json();
            drawNetwork(data);
            setStatus('', 'idle');
        } catch (err) {
            console.error(err);
            setStatus('', 'error');
        }
    };

    const handleRoute = async () => {
        const startId = startSelect.value;
        const endId = endSelect.value;

        if (!startId || !endId) {
        setStatus('', 'error');
        return;
    }
    if (startId === endId) {
        setStatus('', 'error');
        return;
    }

    setStatus('', 'idle');
    findPathBtn.disabled = true;
    findPathBtn.textContent = 'Drawing...';

        try {
            const res = await fetch(`/api/path?start=${encodeURIComponent(startId)}&end=${encodeURIComponent(endId)}`);
            if (!res.ok) throw new Error('No path found');
            const data = await res.json();
            drawRoute(data.path);
            setStatus('', 'success');
        } catch (err) {
            console.error(err);
            setStatus('', 'error');
            renderSummary(null);
        } finally {
            findPathBtn.disabled = false;
            findPathBtn.textContent = 'Draw route';
        }
    };

    loadNetwork();
    findPathBtn.addEventListener('click', handleRoute);
});
