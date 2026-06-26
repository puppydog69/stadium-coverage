/**
 * Pre-compute optimizer results for all radius × transit scenarios.
 * Outputs two files per combination to keep browser loads small:
 *   - precomputed-{mode}-{r}.json      → scenarios only (<150KB) — loads first, instant UI
 *   - precomputed-{mode}-{r}-hexids.json → hexIds only (big) — loads in background for map
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

function save(filePath: string, data: unknown) {
  const json = JSON.stringify(data);
  writeFileSync(filePath, json);
  const kb = (json.length / 1024).toFixed(0);
  console.log(`  → ${filePath} (${Number(kb) >= 1024 ? (Number(kb)/1024).toFixed(1)+'MB' : kb+'KB'})`);
}

async function processDrivingRadius(radius: 15 | 30 | 60 | 90 | 120 | 150) {
  const candFile = radius === 15 ? 'public/candidates.json' : `data/candidates-${radius}.json`;
  const popFile  = radius === 15 ? 'data/hex-pop.json'      : `data/hex-pop-${radius}.json`;

  console.log(`\n[drive-${radius}min] Loading...`);
  const candidates: Candidate[] = JSON.parse(readFileSync(candFile, 'utf8'));
  const popLookup: Record<string, number> = JSON.parse(readFileSync(popFile, 'utf8'));
  process.stdout.write(`[drive-${radius}min] Computing...`);

  const selected = selectOptimalLocations(candidates, popLookup, N_MAX, 1);

  const scenarios: Record<string, ScenarioEntry[]> = {
    off: selected.map(s => ({
      name: s.name, state: s.state, lat: s.lat, lon: s.lon,
      hexCount: s.hexCount, incrementalPopulation: s.incrementalPopulation,
    })),
  };
  const hexIds: Record<string, string[]> = {};
  for (const s of selected) hexIds[s.name] = s.hexIds;

  console.log(` done (${selected.length} selected)`);
  save(`public/precomputed-drive-${radius}.json`, { scenarios });
  save(`public/precomputed-drive-${radius}-hexids.json`, { hexIds });
}

async function processUnionRadius(radius: 15 | 30 | 60 | 90 | 120 | 150) {
  const unionFile = `data/candidates-union-${radius}.json`;
  if (!existsSync(unionFile)) throw new Error(`Missing ${unionFile}`);

  console.log(`\n[transit-${radius}min] Loading...`);
  const candidates: Candidate[] = JSON.parse(readFileSync(unionFile, 'utf8'));
  const popLookup: Record<string, number> = JSON.parse(readFileSync('data/population-r8.json', 'utf8'));
  process.stdout.write(`[transit-${radius}min] Computing...`);

  const selected = selectOptimalLocations(candidates, popLookup, N_MAX, 1);

  const scenarios: Record<string, ScenarioEntry[]> = {
    transit: selected.map(s => ({
      name: s.name, state: s.state, lat: s.lat, lon: s.lon,
      hexCount: s.hexCount, incrementalPopulation: s.incrementalPopulation,
    })),
  };
  const hexIds: Record<string, string[]> = {};
  for (const s of selected) hexIds[s.name] = s.hexIds;

  console.log(` done (${selected.length} selected)`);
  save(`public/precomputed-transit-${radius}.json`, { scenarios });
  save(`public/precomputed-transit-${radius}-hexids.json`, { hexIds });
}

async function main() {
  console.log('Building candidates-slim.json...');
  const base: Candidate[] = JSON.parse(readFileSync('public/candidates.json', 'utf8'));
  const slim: SlimCandidate[] = base.map(({ name, state, lat, lon, hexCount, population }) =>
    ({ name, state, lat, lon, hexCount, population })
  );
  save('public/candidates-slim.json', slim);

  for (const radius of [15, 30, 60, 90, 120, 150] as const) {
    await processDrivingRadius(radius);
    await processUnionRadius(radius);
  }

  console.log('\nAll done.');
}

main().catch(err => { console.error(err); process.exit(1); });
