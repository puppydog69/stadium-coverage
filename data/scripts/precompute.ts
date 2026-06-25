/**
 * Pre-compute optimizer results for all radius × transit scenarios.
 * Run once at build time; outputs are served as static JSON to the browser.
 *
 * Outputs:
 *   public/candidates-slim.json         — 326 candidates without hexIds (for dot markers)
 *   public/precomputed-15.json          — driving-only optimizer for 15-min radius
 *   public/precomputed-30.json          — driving-only optimizer for 30-min radius
 *   public/precomputed-60.json          — driving-only optimizer for 60-min radius
 *   public/precomputed-union-15.json    — driving+transit union for 15-min radius
 *   public/precomputed-union-30.json    — driving+transit union for 30-min radius
 *   public/precomputed-union-60.json    — driving+transit union for 60-min radius
 *
 * Usage:
 *   node --experimental-strip-types data/scripts/precompute.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { selectOptimalLocations } from '../../src/lib/optimizer.ts';
import type { Candidate } from '../../src/lib/optimizer.ts';

const N_MAX = 100;

interface SlimCandidate {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; population: number;
}

interface ScenarioEntry {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; incrementalPopulation: number;
}

interface PrecomputedFile {
  hexIds: Record<string, string[]>;
  scenarios: Record<string, ScenarioEntry[]>;
}

async function processDrivingRadius(radius: 15 | 30 | 60): Promise<PrecomputedFile> {
  const candFile = radius === 15 ? 'public/candidates.json' : `public/candidates-${radius}.json`;
  const popFile  = radius === 15 ? 'public/hex-pop.json'    : `public/hex-pop-${radius}.json`;

  console.log(`\n[driving-${radius}min] Loading candidates...`);
  const candidates: Candidate[] = JSON.parse(readFileSync(candFile, 'utf8'));
  const popLookup: Record<string, number> = JSON.parse(readFileSync(popFile, 'utf8'));
  console.log(`[driving-${radius}min] ${candidates.length} candidates, ${Object.keys(popLookup).length.toLocaleString()} hex entries.`);

  process.stdout.write(`[driving-${radius}min] Computing 'off'...`);
  const selected = selectOptimalLocations(candidates, popLookup, N_MAX, 1);

  const hexIds: Record<string, string[]> = {};
  const scenarios: Record<string, ScenarioEntry[]> = {};

  scenarios['off'] = selected.map(s => ({
    name: s.name, state: s.state, lat: s.lat, lon: s.lon,
    hexCount: s.hexCount, incrementalPopulation: s.incrementalPopulation,
  }));
  for (const s of selected) {
    if (!hexIds[s.name]) hexIds[s.name] = s.hexIds;
  }

  console.log(` done (${selected.length} selected)`);
  return { hexIds, scenarios };
}

async function processUnionRadius(radius: 15 | 30 | 60): Promise<PrecomputedFile> {
  const unionFile = `public/candidates-union-${radius}.json`;
  if (!existsSync(unionFile)) {
    throw new Error(`Missing ${unionFile} — run build-candidates-union.ts first`);
  }

  // Union candidates were built with full population-r8.json — use it here too
  console.log(`\n[union-${radius}min] Loading union candidates...`);
  const candidates: Candidate[] = JSON.parse(readFileSync(unionFile, 'utf8'));
  console.log(`[union-${radius}min] Loading population lookup...`);
  const popLookup: Record<string, number> = JSON.parse(readFileSync('data/population-r8.json', 'utf8'));
  console.log(`[union-${radius}min] ${candidates.length} candidates, ${Object.keys(popLookup).length.toLocaleString()} hex entries.`);

  process.stdout.write(`[union-${radius}min] Computing 'transit'...`);
  const selected = selectOptimalLocations(candidates, popLookup, N_MAX, 1);

  const hexIds: Record<string, string[]> = {};
  const scenarios: Record<string, ScenarioEntry[]> = {};

  scenarios['transit'] = selected.map(s => ({
    name: s.name, state: s.state, lat: s.lat, lon: s.lon,
    hexCount: s.hexCount, incrementalPopulation: s.incrementalPopulation,
  }));
  for (const s of selected) {
    if (!hexIds[s.name]) hexIds[s.name] = s.hexIds;
  }

  console.log(` done (${selected.length} selected)`);
  return { hexIds, scenarios };
}

async function main() {
  // Build slim candidates file (no hexIds — just for dot markers)
  console.log('Building candidates-slim.json...');
  const base: Candidate[] = JSON.parse(readFileSync('public/candidates.json', 'utf8'));
  const slim: SlimCandidate[] = base.map(({ name, state, lat, lon, hexCount, population }) =>
    ({ name, state, lat, lon, hexCount, population })
  );
  writeFileSync('public/candidates-slim.json', JSON.stringify(slim));
  console.log(`candidates-slim.json: ${slim.length} candidates, ${(JSON.stringify(slim).length / 1024).toFixed(0)} KB`);

  // Driving-only precomputed files
  for (const radius of [15, 30, 60] as const) {
    const data = await processDrivingRadius(radius);
    const json = JSON.stringify(data);
    writeFileSync(`public/precomputed-${radius}.json`, json);
    const mb = (json.length / 1_048_576).toFixed(1);
    console.log(`\n[driving-${radius}min] Saved precomputed-${radius}.json (${mb} MB)`);
  }

  // Union (driving+transit) precomputed files
  for (const radius of [15, 30, 60] as const) {
    const data = await processUnionRadius(radius);
    const json = JSON.stringify(data);
    writeFileSync(`public/precomputed-union-${radius}.json`, json);
    const mb = (json.length / 1_048_576).toFixed(1);
    console.log(`\n[union-${radius}min] Saved precomputed-union-${radius}.json (${mb} MB)`);
  }

  console.log('\nAll done.');
}

main().catch(err => { console.error(err); process.exit(1); });
