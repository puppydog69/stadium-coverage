/**
 * Build transit-only isochrone candidates: for each venue, fetch the
 * public_transport isochrone from TravelTime (walking + buses + rail —
 * no cars). Population is computed from the transit hex set only.
 *
 * Outputs:
 *   data/candidates-transit-15.json
 *   data/candidates-transit-30.json
 *   data/candidates-transit-45.json
 *   data/candidates-transit-60.json
 *   data/candidates-transit-90.json
 *   data/candidates-transit-120.json
 *
 * Supports resume-on-interrupt — already completed candidates are skipped.
 *
 * Usage:
 *   node --experimental-strip-types data/scripts/build-candidates-union.ts [radii...]
 *   e.g. node --experimental-strip-types data/scripts/build-candidates-union.ts 45 90
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getTransitIsochroneHexes } from "./transit-isochrone.ts";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const DELAY_MS   = 400;  // ~2.5 req/s — TravelTime free tier allows 10/s
const SAVE_EVERY = 20;

interface Candidate {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; population: number; hexIds: string[];
}

function outPath(minutes: number) {
  return path.resolve(process.cwd(), `data/candidates-transit-${minutes}.json`);
}

function save(results: Candidate[], minutes: number) {
  const sorted = [...results].sort((a, b) => b.population - a.population);
  fs.writeFileSync(outPath(minutes), JSON.stringify(sorted, null, 2));
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function buildTransit(
  sources: Candidate[],
  popLookup: Record<string, number>,
  minutes: number,
) {
  const out = outPath(minutes);
  const completed = new Map<string, Candidate>();

  if (fs.existsSync(out)) {
    const prev = JSON.parse(fs.readFileSync(out, "utf8")) as Candidate[];
    for (const r of prev) completed.set(r.name, r);
    console.log(`[transit-${minutes}min] Resuming: ${completed.size} / ${sources.length} done.`);
  } else {
    console.log(`[transit-${minutes}min] Starting fresh — ${sources.length} candidates.`);
  }

  const todo = sources.filter(c => !completed.has(c.name));
  if (todo.length === 0) {
    console.log(`[transit-${minutes}min] Already complete.\n`);
    save([...completed.values()], minutes);
    return;
  }

  console.log(`[transit-${minutes}min] ${todo.length} remaining.\n`);
  let batch = 0;

  for (let i = 0; i < todo.length; i++) {
    const src = todo[i];

    let hexIds: string[] = [];
    try {
      hexIds = await getTransitIsochroneHexes(src.lat, src.lon, minutes);
    } catch (err) {
      console.error(`  TRANSIT ERROR [${src.name}]: ${(err as Error).message}`);
    }

    const population = hexIds.reduce((sum, h) => sum + (popLookup[h] ?? 0), 0);

    completed.set(src.name, {
      name: src.name, state: src.state, lat: src.lat, lon: src.lon,
      hexCount: hexIds.length, population, hexIds,
    });

    batch++;
    const total = sources.length;
    const done  = completed.size;

    if (batch % 10 === 0 || i === todo.length - 1) {
      const pct = ((done / total) * 100).toFixed(0);
      console.log(
        `[transit-${minutes}min] [${done}/${total} ${pct}%] ${src.name.padEnd(42)} ` +
        `transit:${hexIds.length}  pop:${population.toLocaleString()}`
      );
    }

    if (batch % SAVE_EVERY === 0) {
      save([...completed.values()], minutes);
      console.log(`  → Checkpoint saved (${done}).`);
    }

    if (i < todo.length - 1) await sleep(DELAY_MS);
  }

  save([...completed.values()], minutes);
  const mb = (fs.statSync(out).size / 1_048_576).toFixed(1);
  console.log(`\n[transit-${minutes}min] Done → ${out} (${mb} MB)\n`);
}

async function main() {
  if (!process.env.TRAVELTIME_APP_ID) {
    console.error("TRAVELTIME_APP_ID not set"); process.exit(1);
  }

  const args = process.argv.slice(2).map(Number).filter(n => n > 0);
  const allRadii = [15, 30, 45, 60, 90, 120];
  const radii = args.length > 0 ? args : allRadii;

  console.log("Loading population lookup...");
  const popLookup: Record<string, number> =
    JSON.parse(fs.readFileSync("data/population-r8.json", "utf8"));
  console.log(`${Object.keys(popLookup).length.toLocaleString()} hex entries loaded.\n`);

  for (const minutes of radii) {
    const srcFile = minutes === 15
      ? "public/candidates.json"
      : `data/candidates-${minutes}.json`;
    if (!fs.existsSync(srcFile)) { console.warn(`Skipping ${minutes}min — ${srcFile} missing`); continue; }
    const sources: Candidate[] = JSON.parse(fs.readFileSync(srcFile, "utf8"));
    await buildTransit(sources, popLookup, minutes);
  }

  console.log("All transit radii complete.");
}

main().catch(err => { console.error(err); process.exit(1); });
