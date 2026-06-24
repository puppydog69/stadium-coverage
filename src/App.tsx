import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as h3 from 'h3-js';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { selectOptimalLocations } from './lib/optimizer';
import type { Candidate, SelectedCandidate } from './lib/optimizer';
import './App.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAP_STYLE     = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const SOURCE_DOTS   = 'candidates';
const SOURCE_HEXES  = 'hexes';
const LAYER_HEX_FILL    = 'hex-fill';
const LAYER_HEX_STROKE  = 'hex-stroke';
const LAYER_SEL_GLOW    = 'selected-glow';
const LAYER_UNSELECTED  = 'unselected-circle';
const LAYER_SELECTED    = 'selected-circle';

const US_POPULATION = 335_000_000;

const PALETTE = [
  '#818cf8', // indigo
  '#34d399', // emerald
  '#f472b6', // pink
  '#fb923c', // orange
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#4ade80', // green
  '#f87171', // red
  '#facc15', // yellow
  '#60a5fa', // blue
  '#e879f9', // fuchsia
  '#2dd4bf', // teal
];

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

type ResultRow = SelectedCandidate & { color: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPop(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return n.toLocaleString();
}

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
): FeatureCollection {
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
          color: sel ? (colorMap.get(c.name) ?? PALETTE[0]) : '#334155',
        } satisfies DotProps,
      };
    }),
  };
}

function buildHexGeoJSON(
  selected: SelectedCandidate[],
  colorMap: Map<string, string>,
): FeatureCollection {
  const features: Feature[] = [];
  for (const s of selected) {
    const color = colorMap.get(s.name) ?? PALETTE[0];
    for (const hexId of s.hexIds) {
      const boundary = h3.cellToBoundary(hexId); // [[lat, lng], ...]
      const ring: [number, number][] = boundary.map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { color, rank: s.rank, name: s.name },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function emptyFC(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function tooltipHTML(props: DotProps): string {
  if (props.selected) {
    return (
      `<strong>#${props.rank} – ${props.name}</strong><br/>` +
      `${props.state} &nbsp;·&nbsp; ${props.hexCount} hexes<br/>` +
      `<span style="color:#a5b4fc">+${props.incrementalPopulation.toLocaleString()} new</span><br/>` +
      `<span style="opacity:.6">15-min reach: ${props.population.toLocaleString()}</span>`
    );
  }
  return (
    `<strong>${props.name}</strong><br/>` +
    `${props.state} &nbsp;·&nbsp; ${props.hexCount} hexes<br/>` +
    `<span style="opacity:.6">15-min pop: ${props.population.toLocaleString()}</span>`
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
  const [results, setResults]   = useState<ResultRow[]>([]);

  const runAndUpdate = useCallback((n: number, transit: boolean) => {
    const map       = mapRef.current;
    const cands     = candidatesRef.current;
    const popLookup = popLookupRef.current;
    if (!map || !cands || !popLookup || !mapReadyRef.current) return;

    const tagged   = cands.map(c => ({ ...c, mode: transit ? 'transit' : 'driving' }));
    const selected = selectOptimalLocations(tagged, popLookup, n, transit ? 2 : 1);
    const colorMap = assignColors(selected, PALETTE);

    setResults(selected.map(s => ({ ...s, color: colorMap.get(s.name) ?? PALETTE[0] })));

    (map.getSource(SOURCE_DOTS) as maplibregl.GeoJSONSource)
      .setData(buildDotGeoJSON(cands, selected, colorMap));
    (map.getSource(SOURCE_HEXES) as maplibregl.GeoJSONSource)
      .setData(buildHexGeoJSON(selected, colorMap));
  }, []);

  useEffect(() => {
    paramsRef.current = { N, transitOn };
    runAndUpdate(N, transitOn);
  }, [N, transitOn, runAndUpdate]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [-96, 38],
      zoom: 3.8,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    map.on('load', async () => {
      const [candRes, popRes] = await Promise.all([
        fetch('/candidates.json'),
        fetch('/hex-pop.json'),
      ]);
      const candidates: Candidate[]           = await candRes.json();
      const popLookup: Record<string, number> = await popRes.json();
      candidatesRef.current = candidates;
      popLookupRef.current  = popLookup;

      // Hex polygon layers (bottom)
      map.addSource(SOURCE_HEXES, { type: 'geojson', data: emptyFC() });

      map.addLayer({
        id: LAYER_HEX_FILL,
        type: 'fill',
        source: SOURCE_HEXES,
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.3,
        },
      });

      // Glowing hex border via line-blur
      map.addLayer({
        id: LAYER_HEX_STROKE,
        type: 'line',
        source: SOURCE_HEXES,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.5,
          'line-opacity': 0.9,
          'line-blur': 2,
        },
      });

      // Dot source
      map.addSource(SOURCE_DOTS, {
        type: 'geojson',
        data: buildDotGeoJSON(candidates, [], new Map()),
      });

      // Soft glow halo behind selected dots
      map.addLayer({
        id: LAYER_SEL_GLOW,
        type: 'circle',
        source: SOURCE_DOTS,
        filter: ['==', ['get', 'selected'], true],
        paint: {
          'circle-radius': 20,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.12,
          'circle-blur': 1,
        },
      });

      map.addLayer({
        id: LAYER_UNSELECTED,
        type: 'circle',
        source: SOURCE_DOTS,
        filter: ['!=', ['get', 'selected'], true],
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#334155',
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(255,255,255,0.12)',
          'circle-opacity': 0.6,
        },
      });

      map.addLayer({
        id: LAYER_SELECTED,
        type: 'circle',
        source: SOURCE_DOTS,
        filter: ['==', ['get', 'selected'], true],
        paint: {
          'circle-radius': 8,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(255,255,255,0.85)',
          'circle-opacity': 1,
        },
      });

      // Unified hover: selected takes priority over unselected
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
        const coords = (f.geometry as Point).coordinates as [number, number];
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
        const coords = (f.geometry as Point).coordinates as [number, number];
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(coords)
          .setHTML(tooltipHTML(props))
          .addTo(map);
      });

      mapReadyRef.current = true;
      const { N: n, transitOn: t } = paramsRef.current;
      runAndUpdate(n, t);
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current      = null;
      mapReadyRef.current = false;
    };
  }, [runAndUpdate]);

  // Derived stats
  const totalPop = results.reduce((s, r) => s + r.incrementalPopulation, 0);
  const usPct    = totalPop > 0 ? ((totalPop / US_POPULATION) * 100).toFixed(1) : '—';
  const avgPop   = results.length > 0 ? Math.round(totalPop / results.length) : 0;
  const best     = results[0];
  const worst    = results[results.length - 1];

  // Cumulative population for leaderboard
  let cum = 0;
  const resultsWithCum = results.map(r => {
    cum += r.incrementalPopulation;
    return { ...r, cumulative: cum };
  });

  return (
    <>
      <div ref={containerRef} id="map" />

      <div id="panel">
        <div className="panel-header">
          <div className="panel-title">Stadium Coverage</div>
          <div className="panel-subtitle">US Population Optimizer</div>
          <div className="legend-row" style={{ marginTop: 10 }}>
            <div className="legend-item">
              <span className="dot dot-palette" />
              Selected
            </div>
            <div className="legend-item">
              <span className="dot dot-unselected" />
              Candidate
            </div>
          </div>
        </div>

        <div className="panel-body">
          {/* Controls */}
          <div className="controls-section">
            <div className="ctrl-label">
              <div className="ctrl-label-row">
                <span>Venues</span>
                <span className="ctrl-value">{N}</span>
              </div>
              <input
                type="range"
                min={5} max={50} step={1}
                value={N}
                onChange={e => setN(Number(e.target.value))}
              />
            </div>

            <div className="ctrl-label">
              <div className="ctrl-label-row">
                <span>Drive time</span>
              </div>
              <div className="radius-group">
                {([15, 30, 60] as Radius[]).map(r => (
                  <button
                    key={r}
                    className={`radius-btn${radius === r ? ' active' : ''}`}
                    disabled={r !== 15}
                    onClick={() => setRadius(r)}
                    title={r !== 15 ? 'Coming soon' : `${r}-min drive`}
                  >
                    {r} min
                  </button>
                ))}
              </div>
              {radius !== 15 && (
                <span className="soon-note">30 / 60-min data coming soon</span>
              )}
            </div>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={transitOn}
                onChange={e => setTransitOn(e.target.checked)}
              />
              <span className="toggle-label">Transit bonus (2×)</span>
            </label>
          </div>

          {/* Stats grid */}
          {results.length > 0 && (
            <div className="stats-section">
              <div className="stats-heading">Coverage Stats</div>
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-value">{fmtPop(totalPop)}</div>
                  <div className="stat-label">Pop covered</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{usPct}%</div>
                  <div className="stat-label">of US pop</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{fmtPop(avgPop)}</div>
                  <div className="stat-label">Avg / venue</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ fontSize: 11, color: '#a5b4fc', paddingTop: 2 }}>
                    {best ? best.name.split('–')[0].trim() : '—'}
                  </div>
                  <div className="stat-label">Best pick</div>
                </div>
              </div>
              {worst && worst !== best && (
                <div style={{ fontSize: 10, color: 'rgba(180,190,220,0.35)', textAlign: 'right', marginTop: -2 }}>
                  Least efficient: {worst.name} (+{fmtPop(worst.incrementalPopulation)})
                </div>
              )}
            </div>
          )}

          {/* Leaderboard */}
          {resultsWithCum.length > 0 && (
            <div className="lb-section">
              <div className="lb-heading">Ranked Selections</div>
              <div className="lb-list">
                {resultsWithCum.map(r => (
                  <div className="lb-row" key={r.name}>
                    <div className="lb-accent" style={{ background: r.color }} />
                    <span className="lb-rank">#{r.rank}</span>
                    <div className="lb-info">
                      <span className="lb-name">{r.name}</span>
                      <div className="lb-meta">
                        <span className="lb-state">{r.state}</span>
                        <span className="lb-hexcount">{r.hexCount}⬡</span>
                      </div>
                    </div>
                    <div className="lb-pops">
                      <span className="lb-incr">+{fmtPop(r.incrementalPopulation)}</span>
                      <span className="lb-cum">{fmtPop(r.cumulative)} cum</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
