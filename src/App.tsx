import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection, Point } from 'geojson';
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
const SOURCE_RAIL       = 'rail-overlay';
const LAYER_RAIL        = 'rail-lines';

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

interface ScenariosFile {
  scenarios: Record<string, ScenarioEntry[]>;
  hexidChunks?: number;
}


interface DotProps {
  name: string; state: string; population: number; hexCount: number;
  selected: boolean; rank: number; incrementalPopulation: number; color: string;
}

type ResultRow = ScenarioEntry & { rank: number; color: string; };

type Radius = 15 | 30 | 45 | 60 | 90 | 120;

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
    // Cycle through palette by rank; only skip if blocked by a nearby venue
    const preferred = palette[i % palette.length];
    const color = blocked.has(preferred)
      ? (palette.find(p => !blocked.has(p)) ?? preferred)
      : preferred;
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


function emptyFC(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function modePrefix(transitOn: boolean): string {
  return transitOn ? 'transit' : 'drive';
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
    `<span style="opacity:.6">Pop: ${props.population.toLocaleString()}</span>`
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function App() {
  const containerRef      = useRef<HTMLDivElement>(null);
  const mapRef            = useRef<maplibregl.Map | null>(null);
  const popupRef          = useRef<maplibregl.Popup | null>(null);
  const slimCandidatesRef = useRef<SlimCandidate[] | null>(null);
  const scenariosRef      = useRef<Record<string, ScenarioEntry[]> | null>(null);
  const workerRef         = useRef<Worker | null>(null);
  const mapReadyRef       = useRef(false);
  const paramsRef         = useRef({ N: 20, transitOn: false });
  const hexIdsKeyRef      = useRef('');

  const [N, setN]                 = useState(20);
  const [transitOn, setTransitOn] = useState(false);
  const [radius, setRadius]       = useState<Radius>(60);
  const [results, setResults]     = useState<ResultRow[]>([]);
  const [loading, setLoading]     = useState(false);
  const [hexLoading, setHexLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Push current results to the map dots layer
  const pushDots = useCallback((rows: ResultRow[]) => {
    const map   = mapRef.current;
    const cands = slimCandidatesRef.current;
    if (!map || !cands || !mapReadyRef.current) return;
    (map.getSource(SOURCE_DOTS) as maplibregl.GeoJSONSource).setData(buildDotGeoJSON(cands, rows));
  }, []);

  // Ask worker to build & push hex GeoJSON (off main thread)
  const pushHexes = useCallback((rows: ResultRow[], key: string) => {
    const worker = workerRef.current;
    if (!worker) return;
    worker.postMessage({
      type: 'render',
      key,
      selected: rows.map(r => ({ name: r.name, color: r.color, rank: r.rank })),
    });
  }, []);

  // Slice scenarios and update leaderboard + dots (instant — no hex rendering)
  const updateLeaderboard = useCallback((n: number, transit: boolean) => {
    const scenarios = scenariosRef.current;
    if (!scenarios) return null;
    const key    = transit ? 'transit' : 'off';
    const all    = scenarios[key] ?? [];
    const sliced = all.slice(0, n);
    const colorMap = assignColors(sliced, PALETTE);
    const rows = sliced.map((s, i) => ({ ...s, rank: i + 1, color: colorMap.get(s.name) ?? PALETTE[0] }));
    setResults(rows);
    pushDots(rows);
    return rows;
  }, [pushDots]);

  // Load a new mode+radius combination: scenarios first (instant), hexids via worker (background)
  const loadMode = useCallback((r: Radius, transit: boolean) => {
    const prefix = modePrefix(transit);
    const key    = `${prefix}-${r}`;

    setLoading(true);
    setHexLoading(true);
    setLoadError(null);
    setResults([]);
    hexIdsKeyRef.current = key;

    const map = mapRef.current;
    if (map && mapReadyRef.current) {
      (map.getSource(SOURCE_HEXES) as maplibregl.GeoJSONSource).setData(emptyFC());
    }

    // 1. Fetch scenarios (tiny — instant leaderboard)
    fetch(`/precomputed-${key}.json`)
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<ScenariosFile>; })
      .then(data => {
        scenariosRef.current = data.scenarios;
        setLoading(false);
        const { N: n, transitOn: t } = paramsRef.current;
        updateLeaderboard(n, t);

        // 2. Tell worker to fetch + cache hexids, then render when done
        const chunks = data.hexidChunks ?? 1;
        workerRef.current?.postMessage({ type: 'load', key, chunks });
      })
      .catch(err => {
        setLoading(false);
        setHexLoading(false);
        setLoadError(`${r}-min data unavailable`);
        console.error(err);
      });
  }, [updateLeaderboard]);

  // N slider change — update leaderboard+dots instantly, re-render hexes if loaded
  useEffect(() => {
    paramsRef.current = { N, transitOn };
    const rows = updateLeaderboard(N, transitOn);
    if (rows && !hexLoading) pushHexes(rows, hexIdsKeyRef.current);
  }, [N, updateLeaderboard, pushHexes, transitOn, hexLoading]);

  // Toggle rail overlay visibility with transit
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    map.setLayoutProperty(LAYER_RAIL, 'visibility', transitOn ? 'visible' : 'none');
  }, [transitOn]);

  // Radius or transit toggle — reload files
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    paramsRef.current = { N, transitOn };
    if (!mapReadyRef.current) return;
    loadMode(radius, transitOn);
  }, [radius, transitOn, loadMode]);

  // Initialize worker once
  useEffect(() => {
    const worker = new Worker(new URL('./hexWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'loaded') {
        // Worker has hexids cached — now render current leaderboard
        if (msg.key !== hexIdsKeyRef.current) return;
        setHexLoading(false);
        const { N: n, transitOn: t } = paramsRef.current;
        const scenarios = scenariosRef.current;
        if (!scenarios) return;
        const scenKey = t ? 'transit' : 'off';
        const all = scenarios[scenKey] ?? [];
        const sliced = all.slice(0, n);
        const colorMap = assignColors(sliced, PALETTE);
        const rows = sliced.map((s, i) => ({ ...s, rank: i + 1, color: colorMap.get(s.name) ?? PALETTE[0] }));
        pushHexes(rows, msg.key);
      }
      if (msg.type === 'geojson') {
        if (msg.key !== hexIdsKeyRef.current) return;
        const map = mapRef.current;
        if (map && mapReadyRef.current) {
          (map.getSource(SOURCE_HEXES) as maplibregl.GeoJSONSource).setData(msg.geojson);
        }
      }
      if (msg.type === 'error') {
        setHexLoading(false);
        console.error('Worker error:', msg.error);
      }
    };

    return () => { worker.terminate(); workerRef.current = null; };
  }, [pushHexes]);

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
      // Load both in parallel — scenarios is tiny so it resolves first
      const [slimRes, scenRes] = await Promise.all([
        fetch('/candidates-slim.json'),
        fetch('/precomputed-drive-60.json'),
      ]);
      const slim: SlimCandidate[]  = await slimRes.json();
      const scenData: ScenariosFile = await scenRes.json();

      slimCandidatesRef.current = slim;
      scenariosRef.current      = scenData.scenarios;

      // Rail overlay (OpenRailwayMap) — shown when transit is on
      map.addSource(SOURCE_RAIL, {
        type: 'raster',
        tiles: ['https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenRailwayMap contributors',
      });
      map.addLayer({
        id: LAYER_RAIL,
        type: 'raster',
        source: SOURCE_RAIL,
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.55 },
      });

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
      hexIdsKeyRef.current = 'drive-60';

      // Show leaderboard immediately from scenarios
      const { N: n, transitOn: t } = paramsRef.current;
      updateLeaderboard(n, t);

      // Worker fetches + caches hexids, posts 'loaded' when ready → triggers render
      setHexLoading(true);
      workerRef.current?.postMessage({ type: 'load', key: 'drive-60', chunks: 1 });
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current      = null;
      mapReadyRef.current = false;
    };
  }, [updateLeaderboard, pushHexes]);

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
              <input type="range" min={5} max={50} step={1} value={N}
                onChange={e => setN(Number(e.target.value))} />
            </div>

            <div className="ctrl-label">
              <div className="ctrl-label-row">
                <span>{transitOn ? 'Commute time' : 'Drive time'}</span>
                {loading && <span className="ctrl-loading">loading…</span>}
                {!loading && hexLoading && <span className="ctrl-loading">loading map…</span>}
              </div>
              <div className="radius-group">
                {([15, 30, 45, 60, 90, 120] as Radius[]).map(r => (
                  <button key={r}
                    className={`radius-btn${radius === r ? ' active' : ''}`}
                    disabled={loading}
                    onClick={() => setRadius(r)}>
                    {r} min
                  </button>
                ))}
              </div>
              {loadError && <span className="soon-note" style={{ color: '#f87171' }}>{loadError}</span>}
            </div>

            <div className="ctrl-label">
              <label className="toggle-row">
                <input type="checkbox" checked={transitOn}
                  onChange={e => setTransitOn(e.target.checked)} />
                <span className="toggle-label">Public transit</span>
              </label>
              {transitOn && (
                <div className="transit-note">
                  Expands coverage using real public transit routes
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
