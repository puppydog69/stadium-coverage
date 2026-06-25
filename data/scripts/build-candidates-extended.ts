/**
 * Build candidates-30.json and candidates-60.json using the same 326 lat/lon
 * points from public/candidates.json, querying the Mapbox Isochrone API at
 * 30-min and 60-min driving radii. Saves incrementally; safe to interrupt and
 * resume — already-completed entries are skipped.
 *
 * Usage:
 *   node --experimental-strip-types data/scripts/build-candidates-extended.ts
 *
 * Requires MAPBOX_TOKEN in .env and data/population-r8.json.
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getIsochroneHexes } from "./isochrone.ts";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const DELAY_MS   = 350; // ~2.8 req/s — safely under Mapbox rate limits
const SAVE_EVERY = 25;
const POP_PATH   = path.resolve(process.cwd(), "data/population-r8.json");
const SRC_PATH   = path.resolve(process.cwd(), "public/candidates.json");

interface Candidate {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; population: number; hexIds: string[];
}

function outPath(minutes: number) {
  return path.resolve(process.cwd(), `public/candidates-${minutes}.json`);
}

function save(results: Candidate[], minutes: number) {
  const sorted = [...results].sort((a, b) => b.population - a.population);
  fs.writeFileSync(outPath(minutes), JSON.stringify(sorted, null, 2));
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function buildForRadius(
  sources: Candidate[],
  lookup: Record<string, number>,
  minutes: number,
) {
  const out = outPath(minutes);
  const completed = new Map<string, Candidate>();

  if (fs.existsSync(out)) {
    const prev = JSON.parse(fs.readFileSync(out, "utf8")) as Candidate[];
    for (const r of prev) completed.set(r.name, r);
    console.log(`[${minutes}min] Resuming: ${completed.size} / ${sources.length} already done.`);
  } else {
    console.log(`[${minutes}min] Starting fresh — ${sources.length} candidates to process.`);
  }

  const todo = sources.filter(c => !completed.has(c.name));
  if (todo.length === 0) {
    console.log(`[${minutes}min] All done — nothing to do.\n`);
    save([...completed.values()], minutes);
    return;
  }

  console.log(`[${minutes}min] ${todo.length} remaining.\n`);
  let batchCount = 0;

  for (let i = 0; i < todo.length; i++) {
    const { name, state, lat, lon } = todo[i];
    try {
      const hexIds = await getIsochroneHexes(lat, lon, minutes, "driving");
      const population = hexIds.reduce((sum, id) => sum + (lookup[id] ?? 0), 0);
      completed.set(name, { name, state, lat, lon, hexCount: hexIds.length, population, hexIds });
    } catch (err) {
      console.error(`  ERROR [${name}]: ${(err as Error).message}`);
      // Save empty entry so we don't retry on resume (avoids infinite loops on bad coords)
      completed.set(name, { name, state, lat, lon, hexCount: 0, population: 0, hexIds: [] });
    }

    batchCount++;
    const totalDone = completed.size;
    const total = sources.length;

    if (batchCount % 10 === 0 || i === todo.length - 1) {
      const last = completed.get(name)!;
      const pct = ((totalDone / total) * 100).toFixed(0);
      console.log(
        `[${minutes}min] [${totalDone}/${total} ${pct}%] ${name.padEnd(42)} ` +
        `${last.hexCount} hexes  ${last.population.toLocaleString().padStart(10)}`
      );
    }

    if (batchCount % SAVE_EVERY === 0) {
      save([...completed.values()], minutes);
      console.log(`  → Checkpoint saved (${completed.size} entries).`);
    }

    if (i < todo.length - 1) await sleep(DELAY_MS);
  }

  save([...completed.values()], minutes);
  const sizeMB = (fs.statSync(out).size / 1_048_576).toFixed(1);
  console.log(`\n[${minutes}min] Complete. ${completed.size} candidates → ${out} (${sizeMB} MB)\n`);

  const results = [...completed.values()].sort((a, b) => b.population - a.population);
  console.log(`Top 5 by ${minutes}-min population:`);
  results.slice(0, 5).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name.padEnd(42)} ${r.population.toLocaleString().padStart(11)}`);
  });
  console.log();
}

async function main() {
  if (!process.env.MAPBOX_TOKEN) {
    console.error("MAPBOX_TOKEN not set in .env");
    process.exit(1);
  }

  console.log("Loading source candidates and population lookup...");
  const sources: Candidate[] = JSON.parse(fs.readFileSync(SRC_PATH, "utf8"));
  const lookup: Record<string, number> = JSON.parse(fs.readFileSync(POP_PATH, "utf8"));
  console.log(`${sources.length} source candidates, ${Object.keys(lookup).length.toLocaleString()} hex entries.\n`);

  // Process 30-min first, then 60-min
  await buildForRadius(sources, lookup, 30);
  await buildForRadius(sources, lookup, 60);

  console.log("All radii complete.");
}

main().catch(err => { console.error(err); process.exit(1); });
