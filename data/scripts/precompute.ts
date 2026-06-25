/**
 * Pre-compute optimizer results for all radius × transit scenarios.
 * Run once at build time; outputs are served as static JSON to the browser.
 *
 * Outputs:
 *   public/candidates-slim.json   — 326 candidates without hexIds (for dot markers)
 *   public/precomputed-15.json    — all 9 transit scenarios for 15-min driving
 *   public/precomputed-30.json    — all 9 transit scenarios for 30-min driving
 *   public/precomputed-60.json    — all 9 transit scenarios for 60-min driving
 *
 * Usage:
 *   node --experimental-strip-types data/scripts/precompute.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { selectOptimalLocations } from '../../src/lib/optimizer.ts';
import type { Candidate } from '../../src/lib/optimizer.ts';

const N_MAX    = 100;
const MULTIPLES = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

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

function scenarioKey(transit: boolean, mult: number): string {
  return transit ? `on-${mult}` : 'off';
}

function tagTransit(candidates: Candidate[]): Candidate[] {
  const densities = candidates.map(c => c.population / Math.max(c.hexCount, 1));
  const threshold = [...densities].sort((a, b) => b - a)[Math.floor(densities.length / 3)];
  return candidates.map((c, i) => ({
    ...c,
    mode: densities[i] >= threshold ? 'transit' : 'driving',
  }));
}

async function processRadius(radius: 15 | 30 | 60): Promise<PrecomputedFile> {
  const candFile = radius === 15 ? 'public/candidates.json' : `public/candidates-${radius}.json`;
  const popFile  = radius === 15 ? 'public/hex-pop.json'    : `public/hex-pop-${radius}.json`;

  console.log(`\n[${radius}min] Loading candidates...`);
  const candidates: Candidate[] = JSON.parse(readFileSync(candFile, 'utf8'));
  console.log(`[${radius}min] Loading population lookup...`);
  const popLookup: Record<string, number> = JSON.parse(readFileSync(popFile, 'utf8'));
  console.log(`[${radius}min] ${candidates.length} candidates, ${Object.keys(popLookup).length.toLocaleString()} hex entries.`);

  const tagged = tagTransit(candidates);

  const scenarioDefs = [
    { transit: false, mult: 1 },
    ...MULTIPLES.map(m => ({ transit: true, mult: m })),
  ];

  const hexIds: Record<string, string[]> = {};
  const scenarios: Record<string, ScenarioEntry[]> = {};

  for (const { transit, mult } of scenarioDefs) {
    const key = scenarioKey(transit, mult);
    process.stdout.write(`[${radius}min] Computing ${key}...`);

    const selected = selectOptimalLocations(tagged, popLookup, N_MAX, transit ? mult : 1);

    scenarios[key] = selected.map(s => ({
      name: s.name,
      state: s.state,
      lat: s.lat,
      lon: s.lon,
      hexCount: s.hexCount,
      incrementalPopulation: s.incrementalPopulation,
    }));

    // Collect hexIds once per candidate (deduplicated across scenarios)
    for (const s of selected) {
      if (!hexIds[s.name]) hexIds[s.name] = s.hexIds;
    }

    console.log(` done (${selected.length} selected, ${Object.keys(hexIds).length} unique candidates)`);
  }

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

  // Pre-compute each radius
  for (const radius of [15, 30, 60] as const) {
    const data = await processRadius(radius);
    const json = JSON.stringify(data);
    writeFileSync(`public/precomputed-${radius}.json`, json);
    const mb = (json.length / 1_048_576).toFixed(1);
    const uniqueCands = Object.keys(data.hexIds).length;
    console.log(`\n[${radius}min] Saved precomputed-${radius}.json (${mb} MB, ${uniqueCands} unique candidates)`);
  }

  console.log('\nAll done.');
}

main().catch(err => { console.error(err); process.exit(1); });
