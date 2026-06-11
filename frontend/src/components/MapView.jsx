import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { useExploreStore } from '../store'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

// 0.25, 0.5, 1, and 2 mile radius rings
const RING_RADII_METERS = [402, 805, 1609, 3218]
const RING_COLORS = ['#14B8A6', '#38BDF8', '#F59E0B', '#F87171']

function circleGeoJSON(lng, lat, radiusMeters, segments = 64) {
  const coords = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI
    const dx = (radiusMeters / 111320) * Math.cos(angle) / Math.cos(lat * Math.PI / 180)
    const dy = (radiusMeters / 111320) * Math.sin(angle)
    coords.push([lng + dx, lat + dy])
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } }
}

export default function MapView() {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)

  const { mapCenter, mapZoom } = useExploreStore()

  // 1. Initialize Map (once)
  useEffect(() => {
    if (mapRef.current) return

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/navigation-night-v1',
      center: [-84.3880, 33.7490],
      zoom: 12,
      pitch: 60,
      bearing: -17.6,
      attributionControl: false,
      logoPosition: 'bottom-left'
    })

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right')
    mapRef.current = map

    map.on('load', () => {
      // Belt-and-suspenders: if the container gained size after init, resize now.
      map.resize()

      const layers = map.getStyle().layers;
      const labelLayerId = layers.find(l => l.type === 'symbol' && l.layout['text-field'])?.id;

      // --- 3D BUILDINGS ---
      map.addLayer({
        'id': '3d-buildings',
        'source': 'composite',
        'source-layer': 'building',
        'filter': ['==', 'extrude', 'true'],
        'type': 'fill-extrusion',
        'minzoom': 14,
        'paint': {
          'fill-extrusion-color': '#1E293B',
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': ['get', 'min_height'],
          'fill-extrusion-opacity': 0.8
        }
      }, labelLayerId);

      // --- DEMOGRAPHIC BUFFER RINGS ---
      map.addSource('rings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })

      RING_COLORS.forEach((color, i) => {
        map.addLayer({ id: `ring-fill-${i}`, type: 'fill', source: 'rings', filter: ['==', ['get', 'ringIndex'], i], paint: { 'fill-color': color, 'fill-opacity': 0.25 } }, '3d-buildings')
        map.addLayer({ id: `ring-line-${i}`, type: 'line', source: 'rings', filter: ['==', ['get', 'ringIndex'], i], paint: { 'line-color': color, 'line-width': 2, 'line-opacity': 0.9 } }, '3d-buildings')
      })
    })

    return () => { map.remove(); mapRef.current = null }
  }, [])

  // 2. ResizeObserver — fixes the "map renders in left half only" bug.
  //
  // When the map initializes inside a container that was display:none
  // at the time (the splash screen hiding the workspace), Mapbox sets
  // its canvas to the container's then-dimensions (often 0×0 or narrow).
  // When the workspace later becomes visible, the container gains real
  // dimensions but the canvas stays at the original size — the map is
  // drawn in a fraction of the available space.
  //
  // The observer watches the parent container and calls map.resize()
  // whenever its dimensions change, which reflows the canvas to the
  // full available area.
  useEffect(() => {
    if (!mapContainerRef.current) return

    const ro = new ResizeObserver(() => {
      if (mapRef.current) mapRef.current.resize()
    })
    ro.observe(mapContainerRef.current)

    return () => ro.disconnect()
  }, [])

  // 3. Fly-To and Pin Drop Logic
  useEffect(() => {
    if (!mapRef.current || !mapCenter) return;

    const lng = parseFloat(mapCenter[0]);
    const lat = parseFloat(mapCenter[1]);

    if (isNaN(lng) || isNaN(lat)) return;

    mapRef.current.flyTo({
      center: [lng, lat],
      zoom: mapZoom || 16.5,
      duration: 3000,
      essential: true
    });

    if (markerRef.current) {
      markerRef.current.setLngLat([lng, lat]);
    } else {
      markerRef.current = new mapboxgl.Marker({ color: "#14B8A6" })
        .setLngLat([lng, lat])
        .addTo(mapRef.current);
    }

    if (mapRef.current.getSource('rings')) {
      const ringFeatures = RING_RADII_METERS.map((r, i) => ({
        ...circleGeoJSON(lng, lat, r),
        properties: { ringIndex: i }
      }))
      mapRef.current.getSource('rings').setData({ type: 'FeatureCollection', features: ringFeatures })
    }

  }, [mapCenter, mapZoom])

  return <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
}
