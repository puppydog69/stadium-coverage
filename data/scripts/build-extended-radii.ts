/**
 * Build driving + transit union candidates for radii not yet generated.
 * Runs Mapbox isochrone then TravelTime transit for each radius sequentially.
 *
 * Usage:
 *   node --experimental-strip-types data/scripts/build-extended-radii.ts
 *
 * Pass specific radii as args to run only those:
 *   node --experimental-strip-types data/scripts/build-extended-radii.ts 120 150
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getTransitIsochroneHexes, getDrivingIsochroneHexesTT } from "./transit-isochrone.ts";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const DELAY_MS   = 380;
const SAVE_EVERY = 25;

interface Candidate {
  name: string; state: string; lat: number; lon: number;
  hexCount: number; population: number; hexIds: string[];
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function drivingPath(min: number) { return `data/candidates-${min}.json`; }
function unionPath(min: number)   { return `data/candidates-union-${min}.json`; }

async function buildDriving(minutes: number, popLookup: Record<string, number>) {
  const out = drivingPath(minutes);
  const sources: Candidate[] = JSON.parse(fs.readFileSync("public/candidates.json", "utf8"));
  const completed = new Map<string, Candidate>();

  if (fs.existsSync(out)) {
    for (const r of JSON.parse(fs.readFileSync(out, "utf8")) as Candidate[]) completed.set(r.name, r);
    console.log(`[drive-${minutes}min] Resuming: ${completed.size}/${sources.length}`);
  } else {
    console.log(`[drive-${minutes}min] Starting fresh: ${sources.length} candidates`);
  }

  const todo = sources.filter(c => !completed.has(c.name));
  if (todo.length === 0) { console.log(`[drive-${minutes}min] Already complete.\n`); return; }

  for (let i = 0; i < todo.length; i++) {
    const { name, state, lat, lon } = todo[i];
    try {
      // Mapbox only supports up to 60-min; use TravelTime driving for longer radii
      const hexIds = await getDrivingIsochroneHexesTT(lat, lon, minutes);
      const population = hexIds.reduce((sum, id) => sum + (popLookup[id] ?? 0), 0);
      completed.set(name, { name, state, lat, lon, hexCount: hexIds.length, population, hexIds });
    } catch (err) {
      console.error(`  ERROR [${name}]: ${(err as Error).message}`);
      completed.set(name, { name, state, lat, lon, hexCount: 0, population: 0, hexIds: [] });
    }

    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      const r = completed.get(name)!;
      const pct = ((completed.size / sources.length) * 100).toFixed(0);
      console.log(`[drive-${minutes}min] [${completed.size}/${sources.length} ${pct}%] ${name.padEnd(42)} ${r.hexCount} hexes`);
    }
    if ((i + 1) % SAVE_EVERY === 0) {
      fs.writeFileSync(out, JSON.stringify([...completed.values()].sort((a, b) => b.population - a.population)));
    }
    if (i < todo.length - 1) await sleep(DELAY_MS);
  }

  fs.writeFileSync(out, JSON.stringify([...completed.values()].sort((a, b) => b.population - a.population)));
  console.log(`[drive-${minutes}min] Done → ${out}\n`);
}

async function buildUnion(minutes: number, popLookup: Record<string, number>) {
  const srcFile = minutes === 15 ? "public/candidates.json" : drivingPath(minutes);
  const sources: Candidate[] = JSON.parse(fs.readFileSync(srcFile, "utf8"));
  const out = unionPath(minutes);
  const completed = new Map<string, Candidate>();

  if (fs.existsSync(out)) {
    for (const r of JSON.parse(fs.readFileSync(out, "utf8")) as Candidate[]) completed.set(r.name, r);
    console.log(`[union-${minutes}min] Resuming: ${completed.size}/${sources.length}`);
  } else {
    console.log(`[union-${minutes}min] Starting fresh: ${sources.length} candidates`);
  }

  const todo = sources.filter(c => !completed.has(c.name));
  if (todo.length === 0) { console.log(`[union-${minutes}min] Already complete.\n`); return; }

  for (let i = 0; i < todo.length; i++) {
    const src = todo[i];
    const drivingHexes = new Set<string>(src.hexIds);
    let transitHexes: string[] = [];
    try {
      transitHexes = await getTransitIsochroneHexes(src.lat, src.lon, minutes);
    } catch (err) {
      console.error(`  TRANSIT ERROR [${src.name}]: ${(err as Error).message}`);
    }

    const unionSet = new Set<string>(drivingHexes);
    for (const h of transitHexes) unionSet.add(h);
    const hexIds = [...unionSet];
    const population = hexIds.reduce((sum, h) => sum + (popLookup[h] ?? 0), 0);
    completed.set(src.name, { name: src.name, state: src.state, lat: src.lat, lon: src.lon, hexCount: hexIds.length, population, hexIds });

    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      const pct = ((completed.size / sources.length) * 100).toFixed(0);
      const r = completed.get(src.name)!;
      console.log(`[union-${minutes}min] [${completed.size}/${sources.length} ${pct}%] ${src.name.padEnd(42)} drive:${drivingHexes.size}+transit:${transitHexes.length}→${r.hexCount}`);
    }
    if ((i + 1) % SAVE_EVERY === 0) {
      fs.writeFileSync(out, JSON.stringify([...completed.values()].sort((a, b) => b.population - a.population)));
    }
    if (i < todo.length - 1) await sleep(DELAY_MS);
  }

  fs.writeFileSync(out, JSON.stringify([...completed.values()].sort((a, b) => b.population - a.population)));
  const mb = (fs.statSync(out).size / 1_048_576).toFixed(1);
  console.log(`[union-${minutes}min] Done → ${out} (${mb} MB)\n`);
}

async function main() {
  const allRadii = [90, 120, 150];
  const args = process.argv.slice(2).map(Number).filter(n => n > 0);
  const radii = args.length > 0 ? args : allRadii;

  console.log(`Building radii: ${radii.join(', ')} min\n`);

  const popLookup: Record<string, number> = JSON.parse(fs.readFileSync("data/population-r8.json", "utf8"));
  console.log(`${Object.keys(popLookup).length.toLocaleString()} hex entries loaded.\n`);

  for (const r of radii) {
    if (r !== 15) await buildDriving(r, popLookup);
    await buildUnion(r, popLookup);
  }

  console.log("All extended radii complete. Now run precompute.ts.");
}

main().catch(err => { console.error(err); process.exit(1); });
