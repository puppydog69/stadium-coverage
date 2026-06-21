import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as h3 from 'h3-js';
import { selectOptimalLocations } from './lib/optimizer';
import type { Candidate, SelectedCandidate } from './lib/optimizer';
import './App.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAP_STYLE     = 'https://demotiles.maplibre.org/style.json';
const SOURCE_DOTS   = 'candidates';
const SOURCE_HEXES  = 'hexes';
const LAYER_HEX_FILL   = 'hex-fill';
const LAYER_HEX_STROKE = 'hex-stroke';
const LAYER_UNSELECTED = 'unselected-circle';
const LAYER_SELECTED   = 'selected-circle';

// 12 perceptually distinct colors for candidate regions
const PALETTE = [
  '#e03131', // red
  '#1971c2', // blue
  '#2f9e44', // green
  '#9c36b5', // purple
  '#f08c00', // amber
  '#0c8599', // teal
  '#c2255c', // pink
  '#5c940d', // lime
  '#e67700', // orange
  '#1098ad', // cyan
  '#6741d9', // violet
  '#d9480f', // deep orange
];

// Two selected candidates sharing hexes (or within ~300 km) should use different colors.
const NEARBY_KM = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DotProps {
  name: string;
  state: string;
  population: number;
  hexCount: number;
  selected: boolean;
  rank: number;
  incrementalPopulation: number;
  color: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function assignColors(selected: SelectedCandidate[], palette: string[]): Map<string, string> {
  const colorMap = new Map<string, string>();
  for (const s of selected) {
    const blocked = new Set<string>();
    for (const other of selected) {
      const c = colorMap.get(other.name);
      if (!c) continue;
      if (haversineKm(s.lat, s.lon, other.lat, other.lon) < NEARBY_KM) {
        blocked.add(c);
      }
    }
    const color = palette.find(p => !blocked.has(p)) ?? palette[s.rank % palette.length];
    colorMap.set(s.name, color);
  }
  return colorMap;
}

function buildDotGeoJSON(
  candidates: Candidate[],
  selected: SelectedCandidate[],
  colorMap: Map<string, string>,
): GeoJSON.FeatureCollection {
  const selMap = new Map(selected.map(s => [s.name, s]));
  return {
    type: 'FeatureCollection',
    features: candidates.map(c => {
      const sel = selMap.get(c.name);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: {
          name: c.name,
          state: c.state,
          population: c.population,
          hexCount: c.hexCount,
          selected: sel !== undefined,
          rank: sel?.rank ?? 0,
          incrementalPopulation: sel?.incrementalPopulation ?? 0,
          color: sel ? (colorMap.get(c.name) ?? PALETTE[0]) : '#94a3b8',
        } satisfies DotProps,
      };
    }),
  };
}

function buildHexGeoJSON(
  selected: SelectedCandidate[],
  colorMap: Map<string, string>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const s of selected) {
    const color = colorMap.get(s.name) ?? PALETTE[0];
    for (const hexId of s.hexIds) {
      const boundary = h3.cellToBoundary(hexId); // [[lat, lng], ...]
      const ring: [number, number][] = boundary.map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]); // close GeoJSON ring
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { color, rank: s.rank, name: s.name },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function tooltipHTML(props: DotProps): string {
  if (props.selected) {
    return (
      `<strong>#${props.rank} – ${props.name}</strong><br/>` +
      `State: ${props.state}<br/>` +
      `<em>New pop covered: <strong>${props.incrementalPopulation.toLocaleString()}</strong></em><br/>` +
      `Total 15-min pop: ${props.population.toLocaleString()}<br/>` +
      `Hex count: ${props.hexCount}`
    );
  }
  return (
    `<strong>${props.name}</strong><br/>` +
    `State: ${props.state}<br/>` +
    `15-min pop: ${props.population.toLocaleString()}<br/>` +
    `Hex count: ${props.hexCount}`
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Radius = 15 | 30 | 60;

export default function App() {
  const containerRef  = useRef<HTMLDivElement>(null);
  const mapRef        = useRef<maplibregl.Map | null>(null);
  const popupRef      = useRef<maplibregl.Popup | null>(null);
  const candidatesRef = useRef<Candidate[] | null>(null);
  const popLookupRef  = useRef<Record<string, number> | null>(null);
  const mapReadyRef   = useRef(false);
  const paramsRef     = useRef({ N: 20, transitOn: false });

  const [N, setN]               = useState(20);
  const [transitOn, setTransitOn] = useState(false);
  const [radius, setRadius]     = useState<Radius>(15);
  const [summary, setSummary]   = useState({ count: 0, totalPop: 0 });

  // Run optimizer and push updated GeoJSON to both map sources
  const runAndUpdate = useCallback((n: number, transit: boolean) => {
    const map      = mapRef.current;
    const cands    = candidatesRef.current;
    const popLookup = popLookupRef.current;
    if (!map || !cands || !popLookup || !mapReadyRef.current) return;

    const tagged   = cands.map(c => ({ ...c, mode: transit ? 'transit' : 'driving' }));
    const selected = selectOptimalLocations(tagged, popLookup, n, transit ? 2 : 1);
    const totalPop = selected.reduce((s, r) => s + r.incrementalPopulation, 0);
    setSummary({ count: selected.length, totalPop });

    const colorMap = assignColors(selected, PALETTE);
    (map.getSource(SOURCE_DOTS) as maplibregl.GeoJSONSource)
      .setData(buildDotGeoJSON(cands, selected, colorMap));
    (map.getSource(SOURCE_HEXES) as maplibregl.GeoJSONSource)
      .setData(buildHexGeoJSON(selected, colorMap));
  }, []);

  // Keep params ref current; re-run optimizer on N or transit change
  useEffect(() => {
    paramsRef.current = { N, transitOn };
    runAndUpdate(N, transitOn);
  }, [N, transitOn, runAndUpdate]);

  // Initialize map (runs once)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [-96, 38],
      zoom: 3.8,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', async () => {
      const [candRes, popRes] = await Promise.all([
        fetch('/candidates.json'),
        fetch('/hex-pop.json'),
      ]);
      const candidates: Candidate[]           = await candRes.json();
      const popLookup: Record<string, number> = await popRes.json();
      candidatesRef.current = candidates;
      popLookupRef.current  = popLookup;

      // --- Hex polygon source (bottom layer) ---
      map.addSource(SOURCE_HEXES, { type: 'geojson', data: emptyFC() });

      map.addLayer({
        id: LAYER_HEX_FILL,
        type: 'fill',
        source: SOURCE_HEXES,
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.45,
        },
      });

      map.addLayer({
        id: LAYER_HEX_STROKE,
        type: 'line',
        source: SOURCE_HEXES,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 0.4,
          'line-opacity': 0.6,
        },
      });

      // --- Dot source (top layers) ---
      map.addSource(SOURCE_DOTS, {
        type: 'geojson',
        data: buildDotGeoJSON(candidates, [], new Map()),
      });

      map.addLayer({
        id: LAYER_UNSELECTED,
        type: 'circle',
        source: SOURCE_DOTS,
        filter: ['!=', ['get', 'selected'], true],
        paint: {
          'circle-radius': 4,
          'circle-color': '#94a3b8',
          'circle-stroke-width': 1,
          'circle-stroke-color': '#fff',
          'circle-opacity': 0.55,
        },
      });

      map.addLayer({
        id: LAYER_SELECTED,
        type: 'circle',
        source: SOURCE_DOTS,
        filter: ['==', ['get', 'selected'], true],
        paint: {
          'circle-radius': 9,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
          'circle-opacity': 1,
        },
      });

      // Unified hover: selected dot > unselected dot > no feature
      map.on('mousemove', e => {
        const sel   = map.queryRenderedFeatures(e.point, { layers: [LAYER_SELECTED] });
        const unsel = map.queryRenderedFeatures(e.point, { layers: [LAYER_UNSELECTED] });
        const f = sel[0] ?? unsel[0];
        if (!f) {
          map.getCanvas().style.cursor = '';
          popupRef.current?.remove();
          return;
        }
        map.getCanvas().style.cursor = 'pointer';
        const props  = f.properties as DotProps;
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 10,
        })
          .setLngLat(coords)
          .setHTML(tooltipHTML(props))
          .addTo(map);
      });

      map.on('click', e => {
        const sel   = map.queryRenderedFeatures(e.point, { layers: [LAYER_SELECTED] });
        const unsel = map.queryRenderedFeatures(e.point, { layers: [LAYER_UNSELECTED] });
        const f = sel[0] ?? unsel[0];
        if (!f) return;
        const props  = f.properties as DotProps;
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(coords)
          .setHTML(tooltipHTML(props))
          .addTo(map);
      });

      // First optimizer run
      mapReadyRef.current = true;
      const { N: n, transitOn: t } = paramsRef.current;
      runAndUpdate(n, t);
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current    = null;
      mapReadyRef.current = false;
    };
  }, [runAndUpdate]);

  return (
    <>
      <div ref={containerRef} id="map" />

      <div id="panel">
        <div className="panel-title">Stadium Coverage Optimizer</div>

        <label className="panel-label">
          Venues: <strong>{N}</strong>
          <input
            type="range"
            min={5} max={50} step={1}
            value={N}
            onChange={e => setN(Number(e.target.value))}
          />
        </label>

        <div className="panel-label">
          <span>Drive time</span>
          <div className="radius-group">
            {([15, 30, 60] as Radius[]).map(r => (
              <button
                key={r}
                className={`radius-btn${radius === r ? ' active' : ''}${r !== 15 ? ' soon' : ''}`}
                disabled={r !== 15}
                onClick={() => setRadius(r)}
                title={r !== 15 ? 'Coming soon — precomputing isochrones' : `${r}-min drive`}
              >
                {r} min{r !== 15 ? ' *' : ''}
              </button>
            ))}
          </div>
          {radius !== 15 && (
            <span className="soon-note">* 30 / 60-min data coming soon</span>
          )}
        </div>

        <label className="panel-label toggle-row">
          <input
            type="checkbox"
            checked={transitOn}
            onChange={e => setTransitOn(e.target.checked)}
          />
          Transit bonus (2×)
        </label>

        {summary.count > 0 && (
          <div className="panel-summary">
            <div>Selected: <strong>{summary.count}</strong> venues</div>
            <div>Pop covered: <strong>{summary.totalPop.toLocaleString()}</strong></div>
          </div>
        )}

        <div className="panel-legend">
          <span className="dot dot-palette" /> Selected
          &nbsp;&nbsp;
          <span className="dot dot-unselected" /> Candidate
        </div>
      </div>
    </>
  );
}
