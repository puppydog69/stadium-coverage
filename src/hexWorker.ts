import * as h3 from 'h3-js';
import type { FeatureCollection, Feature } from 'geojson';

interface SelectedVenue {
  name: string;
  color: string;
  rank: number;
}

interface LoadMsg {
  type: 'load';
  key: string;
  chunks: number;
}

interface RenderMsg {
  type: 'render';
  key: string;
  selected: SelectedVenue[];
}

type InMsg = LoadMsg | RenderMsg;

const store: Record<string, Record<string, string[]>> = {};

async function loadHexIds(key: string, chunks: number): Promise<void> {
  if (store[key]) return;

  const fetches = chunks === 1
    ? [fetch(`/precomputed-${key}-hexids.json`).then(r => r.json())]
    : Array.from({ length: chunks }, (_, i) =>
        fetch(`/precomputed-${key}-hexids-${i}.json`).then(r => r.json())
      );

  const parts = await Promise.all(fetches);
  const merged: Record<string, string[]> = {};
  for (const p of parts) Object.assign(merged, p.hexIds);
  store[key] = merged;
}

function buildGeoJSON(key: string, selected: SelectedVenue[]): FeatureCollection {
  const hexIds = store[key] ?? {};
  const features: Feature[] = [];

  for (const s of selected) {
    const ids = hexIds[s.name] ?? [];
    if (ids.length === 0) continue;
    try {
      const compact = h3.compactCells(ids);
      const coords = h3.cellsToMultiPolygon(compact, true) as [number, number][][][];
      if (coords.length === 0) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: coords },
        properties: { color: s.color, rank: s.rank, name: s.name },
      });
    } catch {
      // skip degenerate venue
    }
  }

  return { type: 'FeatureCollection', features };
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;

  if (msg.type === 'load') {
    try {
      await loadHexIds(msg.key, msg.chunks);
      self.postMessage({ type: 'loaded', key: msg.key });
    } catch (err) {
      self.postMessage({ type: 'error', key: msg.key, error: String(err) });
    }
  }

  if (msg.type === 'render') {
    const geojson = buildGeoJSON(msg.key, msg.selected);
    self.postMessage({ type: 'geojson', key: msg.key, geojson });
  }
};
