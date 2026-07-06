/**
 * Pre-compute optimizer results for all radius × transit scenarios.
 * Outputs two files per combination:
 *   - precomputed-{mode}-{r}.json         → scenarios + chunk count (tiny, instant UI)
 *   - precomputed-{mode}-{r}-hexids.json  → hexIds (or chunked as -hexids-0.json, -hexids-1.json, ...)
 *
 * Hexids files are chunked at 45MB each to stay under GitHub's 100MB hard limit.
 *
 * Usage:
 *   node --experimental-strip-types data/scripts/precompute.ts [radii...]
 *   e.g. node --experimental-strip-types data/scripts/precompute.ts 45 120 150
 */

import { readFileSync, writeFileSync, existsSync, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { selectOptimalLocations } from '../../src/lib/optimizer.ts';
import type { Candidate } from '../../src/lib/optimizer.ts';

const N_MAX = 100;
const CHUNK_BYTES = 45 * 1024 * 1024; // 45MB per chunk

interface SlimCandidate {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; population: number;
}

interface ScenarioEntry {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; incrementalPopulation: number;
}

// Write a large array to disk as streaming JSON to avoid V8 string length limit
async function writeJsonStream(filePath: string, obj: unknown) {
  const json = JSON.stringify(obj);
  writeFileSync(filePath, json);
  const kb = Math.round(json.length / 1024);
  const label = kb >= 1024 ? `${(kb/1024).toFixed(1)}MB` : `${kb}KB`;
  console.log(`  → ${filePath} (${label})`);
}

// Save hexIds split into chunks to stay under GitHub's file size limit
function saveHexidsChunked(prefix: string, hexIds: Record<string, string[]>): number {
  const entries = Object.entries(hexIds);
  const chunks: Array<Record<string, string[]>> = [{}];

  for (const [name, ids] of entries) {
    const approxSize = ids.reduce((s, id) => s + id.length + 3, 2);
    const lastChunk = chunks[chunks.length - 1];
    const lastSize = JSON.stringify(lastChunk).length;
    if (lastSize + approxSize > CHUNK_BYTES && Object.keys(lastChunk).length > 0) {
      chunks.push({});
    }
    chunks[chunks.length - 1][name] = ids;
  }

  if (chunks.length === 1) {
    const json = JSON.stringify({ hexIds: chunks[0] });
    writeFileSync(`${prefix}-hexids.json`, json);
    const kb = Math.round(json.length / 1024);
    console.log(`  → ${prefix}-hexids.json (${kb >= 1024 ? `${(kb/1024).toFixed(1)}MB` : `${kb}KB`})`);
  } else {
    for (let i = 0; i < chunks.length; i++) {
      const json = JSON.stringify({ hexIds: chunks[i] });
      writeFileSync(`${prefix}-hexids-${i}.json`, json);
      const kb = Math.round(json.length / 1024);
      console.log(`  → ${prefix}-hexids-${i}.json (${kb >= 1024 ? `${(kb/1024).toFixed(1)}MB` : `${kb}KB`})`);
    }
  }

  return chunks.length;
}

function popFile(radius: number): string {
  if (radius === 15) return 'data/hex-pop.json';
  if (radius === 30) return 'data/hex-pop-30.json';
  if (radius === 60) return 'data/hex-pop-60.json';
  return 'data/population-r8.json'; // all other radii: full lookup
}

function candFile(radius: number): string {
  return radius === 15 ? 'public/candidates.json' : `data/candidates-${radius}.json`;
}

async function processRadius(radius: number, mode: 'drive' | 'transit') {
  const isTransit = mode === 'transit';
  const src = isTransit ? `data/candidates-transit-${radius}.json` : candFile(radius);
  const pop = isTransit && radius > 60 ? 'data/population-r8.json' : popFile(radius);

  if (!existsSync(src)) throw new Error(`Missing ${src} — run data generation first`);

  const tag = `[${mode}-${radius}min]`;
  process.stdout.write(`${tag} Loading...`);
  const candidates: Candidate[] = JSON.parse(readFileSync(src, 'utf8'));
  const popLookup: Record<string, number> = JSON.parse(readFileSync(pop, 'utf8'));
  process.stdout.write(` Computing...`);

  const selected = selectOptimalLocations(candidates, popLookup, N_MAX, 1);
  const scenarioKey = isTransit ? 'transit' : 'off';

  const scenarios: Record<string, ScenarioEntry[]> = {
    [scenarioKey]: selected.map(s => ({
      name: s.name, state: s.state, lat: s.lat, lon: s.lon,
      hexCount: s.hexCount, incrementalPopulation: s.incrementalPopulation,
    })),
  };

  const hexIds: Record<string, string[]> = {};
  for (const s of selected) hexIds[s.name] = s.hexIds;

  console.log(` done (${selected.length} selected)`);

  const prefix = `public/precomputed-${mode}-${radius}`;
  const chunks = saveHexidsChunked(prefix, hexIds);
  writeJsonStream(`${prefix}.json`, { scenarios, hexidChunks: chunks });
}

async function main() {
  const args = process.argv.slice(2).map(Number).filter(n => n > 0);
  const allRadii = [10, 15, 30, 45, 60, 90, 120];
  const radii = args.length > 0 ? args : allRadii;

  if (!args.length) {
    // Full run: rebuild candidates-slim too
    console.log('Building candidates-slim.json...');
    const base: Candidate[] = JSON.parse(readFileSync('public/candidates.json', 'utf8'));
    const slim: SlimCandidate[] = base.map(({ name, state, lat, lon, hexCount, population }) =>
      ({ name, state, lat, lon, hexCount, population })
    );
    writeFileSync('public/candidates-slim.json', JSON.stringify(slim));
    console.log(`  → public/candidates-slim.json (${Math.round(JSON.stringify(slim).length/1024)}KB)`);
  }

  for (const r of radii) {
    await processRadius(r, 'drive');
    await processRadius(r, 'transit');
  }

  console.log('\nAll done.');
}

main().catch(err => { console.error(err); process.exit(1); });
