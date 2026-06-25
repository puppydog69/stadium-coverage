import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as h3 from 'h3-js';
import type { Feature, FeatureCollection, Point } from 'geojson';
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
  '#ff4d6d',
  '#00d2ff',
  '#ffe94d',
  '#7c3aff',
  '#00e5a0',
  '#ff8c00',
  '#e040fb',
  '#00bfff',
  '#ff6b35',
  '#39ff14',
  '#ff1493',
  '#00fff5',
];

const NEARBY_KM = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlimCandidate {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; population: number;
}

interface ScenarioEntry {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; incrementalPopulation: number;
}

interface PrecomputedData {
  hexIds: Record<string, string[]>;
  scenarios: Record<string, ScenarioEntry[]>;
}

interface DotProps {
  name: string; state: string; population: number; hexCount: number;
  selected: boolean; rank: number; incrementalPopulation: number; color: string;
}

type ResultRow = ScenarioEntry & { rank: number; color: string; };

type Radius = 15 | 30 | 60;

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

function assignColors(entries: ScenarioEntry[], palette: string[]): Map<string, string> {
  const colorMap = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    const s = entries[i];
    const blocked = new Set<string>();
    for (let j = 0; j < i; j++) {
      const c = colorMap.get(entries[j].name);
      if (!c) continue;
      if (haversineKm(s.lat, s.lon, entries[j].lat, entries[j].lon) < NEARBY_KM) {
        blocked.add(c);
      }
    }
    const color = palette.find(p => !blocked.has(p)) ?? palette[i % palette.length];
    colorMap.set(s.name, color);
  }
  return colorMap;
}

function buildDotGeoJSON(
  candidates: SlimCandidate[],
  selected: ResultRow[],
): FeatureCollection {
  const selMap = new Map(selected.map((s, i) => [s.name, { ...s, rank: i + 1 }]));
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
          color: sel ? sel.color : '#7b90b0',
        } satisfies DotProps,
      };
    }),
  };
}

function buildHexGeoJSON(
  selected: ResultRow[],
  hexIds: Record<string, string[]>,
): FeatureCollection {
  const features: Feature[] = [];
  for (const s of selected) {
    const ids = hexIds[s.name] ?? [];
    for (const hexId of ids) {
      const boundary = h3.cellToBoundary(hexId);
      const ring: [number, number][] = boundary.map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { color: s.color, rank: s.rank, name: s.name },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function emptyFC(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function scenarioKey(transitOn: boolean, mult: number): string {
  return transitOn ? `on-${mult}` : 'off';
}

function tooltipHTML(props: DotProps): string {
  if (props.selected) {
    return (
      `<strong>#${props.rank} – ${props.name}</strong><br/>` +
      `${props.state} &nbsp;·&nbsp; ${props.hexCount} hexes<br/>` +
      `<span style="color:#a5b4fc">+${props.incrementalPopulation.toLocaleString()} new pop</span>`
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

export default function App() {
  const containerRef       = useRef<HTMLDivElement>(null);
  const mapRef             = useRef<maplibregl.Map | null>(null);
  const popupRef           = useRef<maplibregl.Popup | null>(null);
  const slimCandidatesRef  = useRef<SlimCandidate[] | null>(null);
  const precomputedRef     = useRef<PrecomputedData | null>(null);
  const mapReadyRef        = useRef(false);
  const paramsRef          = useRef({ N: 20, transitOn: false, transitMult: 2 });

  const [N, setN]                   = useState(20);
  const [transitOn, setTransitOn]   = useState(false);
  const [transitMult, setTransitMult] = useState(2);
  const [radius, setRadius]         = useState<Radius>(15);
  const [results, setResults]       = useState<ResultRow[]>([]);
  const [radiusLoading, setRadiusLoading] = useState(false);
  const [radiusError, setRadiusError]     = useState<string | null>(null);

  // Look up the right scenario from precomputed data and push to map
  const runAndUpdate = useCallback((n: number, transit: boolean) => {
    const map        = mapRef.current;
    const cands      = slimCandidatesRef.current;
    const precomp    = precomputedRef.current;
    if (!map || !cands || !precomp || !mapReadyRef.current) return;

    const key      = scenarioKey(transit, paramsRef.current.transitMult);
    const all      = precomp.scenarios[key] ?? [];
    const sliced   = all.slice(0, n);
    const colorMap = assignColors(sliced, PALETTE);
    const rows     = sliced.map((s, i) => ({ ...s, rank: i + 1, color: colorMap.get(s.name) ?? PALETTE[0] }));

    setResults(rows);
    (map.getSource(SOURCE_DOTS) as maplibregl.GeoJSONSource).setData(buildDotGeoJSON(cands, rows));
    (map.getSource(SOURCE_HEXES) as maplibregl.GeoJSONSource).setData(buildHexGeoJSON(rows, precomp.hexIds));
  }, []);

  // Re-run whenever N, transit toggle, or multiplier changes
  useEffect(() => {
    paramsRef.current = { N, transitOn, transitMult };
    runAndUpdate(N, transitOn);
  }, [N, transitOn, transitMult, runAndUpdate]);

  // Reload precomputed file when radius changes (skip initial mount)
  const isFirstRadiusRender = useRef(true);
  useEffect(() => {
    if (isFirstRadiusRender.current) { isFirstRadiusRender.current = false; return; }
    if (!mapReadyRef.current) return;

    setRadiusLoading(true);
    setRadiusError(null);
    setResults([]);

    fetch(`/precomputed-${radius}.json`)
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<PrecomputedData>; })
      .then(data => {
        precomputedRef.current = data;
        const map = mapRef.current;
        if (map) (map.getSource(SOURCE_HEXES) as maplibregl.GeoJSONSource).setData(emptyFC());
        const { N: n, transitOn: t } = paramsRef.current;
        runAndUpdate(n, t);
      })
      .catch(() => setRadiusError(`${radius}-min data unavailable`))
      .finally(() => setRadiusLoading(false));
  }, [radius, runAndUpdate]);

  // Initialize map once
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
      const [slimRes, preRes] = await Promise.all([
        fetch('/candidates-slim.json'),
        fetch('/precomputed-15.json'),
      ]);
      const slim: SlimCandidate[]    = await slimRes.json();
      const precomp: PrecomputedData = await preRes.json();
      slimCandidatesRef.current  = slim;
      precomputedRef.current     = precomp;

      map.addSource(SOURCE_HEXES, { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: LAYER_HEX_FILL, type: 'fill', source: SOURCE_HEXES,
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.38 } });
      map.addLayer({ id: LAYER_HEX_STROKE, type: 'line', source: SOURCE_HEXES,
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.9, 'line-blur': 2 } });

      map.addSource(SOURCE_DOTS, { type: 'geojson', data: buildDotGeoJSON(slim, []) });

      map.addLayer({ id: LAYER_SEL_GLOW, type: 'circle', source: SOURCE_DOTS,
        filter: ['==', ['get', 'selected'], true],
        paint: { 'circle-radius': 20, 'circle-color': ['get', 'color'], 'circle-opacity': 0.12, 'circle-blur': 1 } });

      map.addLayer({ id: LAYER_UNSELECTED, type: 'circle', source: SOURCE_DOTS,
        filter: ['!=', ['get', 'selected'], true],
        paint: { 'circle-radius': 4, 'circle-color': '#7b90b0',
          'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(255,255,255,0.35)', 'circle-opacity': 0.85 } });

      map.addLayer({ id: LAYER_SELECTED, type: 'circle', source: SOURCE_DOTS,
        filter: ['==', ['get', 'selected'], true],
        paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'],
          'circle-stroke-width': 2, 'circle-stroke-color': 'rgba(255,255,255,0.85)', 'circle-opacity': 1 } });

      map.on('mousemove', e => {
        const sel   = map.queryRenderedFeatures(e.point, { layers: [LAYER_SELECTED] });
        const unsel = map.queryRenderedFeatures(e.point, { layers: [LAYER_UNSELECTED] });
        const f = sel[0] ?? unsel[0];
        if (!f) { map.getCanvas().style.cursor = ''; popupRef.current?.remove(); return; }
        map.getCanvas().style.cursor = 'pointer';
        const props  = f.properties as DotProps;
        const coords = (f.geometry as Point).coordinates as [number, number];
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })
          .setLngLat(coords).setHTML(tooltipHTML(props)).addTo(map);
      });

      map.on('click', e => {
        const sel   = map.queryRenderedFeatures(e.point, { layers: [LAYER_SELECTED] });
        const unsel = map.queryRenderedFeatures(e.point, { layers: [LAYER_UNSELECTED] });
        const f = sel[0] ?? unsel[0];
        if (!f) return;
        new maplibregl.Popup({ offset: 10 })
          .setLngLat((f.geometry as Point).coordinates as [number, number])
          .setHTML(tooltipHTML(f.properties as DotProps)).addTo(map);
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

  let cum = 0;
  const resultsWithCum = results.map(r => { cum += r.incrementalPopulation; return { ...r, cumulative: cum }; });

  return (
    <>
      <div ref={containerRef} id="map" />
      <div id="panel">
        <div className="panel-header">
          <div className="panel-title">Stadium Coverage</div>
          <div className="panel-subtitle">US Population Optimizer</div>
          <div className="legend-row" style={{ marginTop: 10 }}>
            <div className="legend-item"><span className="dot dot-palette" />Selected</div>
            <div className="legend-item"><span className="dot dot-unselected" />Candidate</div>
          </div>
        </div>

        <div className="panel-body">
          <div className="controls-section">
            <div className="ctrl-label">
              <div className="ctrl-label-row">
                <span>Venues</span>
                <span className="ctrl-value">{N}</span>
              </div>
              <input type="range" min={5} max={100} step={1} value={N}
                onChange={e => setN(Number(e.target.value))} />
            </div>

            <div className="ctrl-label">
              <div className="ctrl-label-row">
                <span>{transitOn ? 'Commute time' : 'Drive time'}</span>
                {radiusLoading && <span className="ctrl-loading">loading…</span>}
              </div>
              <div className="radius-group">
                {([15, 30, 60] as Radius[]).map(r => (
                  <button key={r}
                    className={`radius-btn${radius === r ? ' active' : ''}`}
                    disabled={radiusLoading}
                    onClick={() => setRadius(r)}>
                    {r} min
                  </button>
                ))}
              </div>
              {radiusError && <span className="soon-note" style={{ color: '#f87171' }}>{radiusError}</span>}
            </div>

            <div className="ctrl-label">
              <label className="toggle-row">
                <input type="checkbox" checked={transitOn}
                  onChange={e => setTransitOn(e.target.checked)} />
                <span className="toggle-label">Transit bonus</span>
              </label>
              {transitOn && (
                <div className="transit-mult">
                  <div className="transit-mult-row">
                    <span className="transit-mult-label">Multiplier</span>
                    <span className="ctrl-value">{transitMult}×</span>
                  </div>
                  <input type="range" min={1.5} max={5} step={0.5} value={transitMult}
                    onChange={e => setTransitMult(Number(e.target.value))} />
                  <div className="transit-mult-ticks">
                    <span>1.5×</span><span>2×</span><span>2.5×</span><span>3×</span>
                    <span>3.5×</span><span>4×</span><span>4.5×</span><span>5×</span>
                  </div>
                </div>
              )}
            </div>
          </div>

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
