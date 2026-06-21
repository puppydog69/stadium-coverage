import * as dotenv from "dotenv";
import * as path from "path";
import { getIsochroneHexes } from "./isochrone.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const CANDIDATES = [
  { name: "Midtown Manhattan, NYC", lat: 40.7549, lon: -73.984 },
  { name: "Times Square, NYC",      lat: 40.758,  lon: -73.9855 },
  { name: "Downtown Phoenix, AZ",   lat: 33.4484, lon: -112.074 },
];

console.log(`Testing getIsochroneHexes — 15-min driving, H3 res-8\n`);
console.log(`${"Location".padEnd(30)} ${"Hexes".padStart(6)}  ${"~km²".padStart(6)}`);
console.log("-".repeat(50));

for (const { name, lat, lon } of CANDIDATES) {
  try {
    const hexIds = await getIsochroneHexes(lat, lon, 15, "driving");
    const areakm2 = (hexIds.length * 0.737).toFixed(1); // res-8 hex ≈ 0.737 km²
    console.log(`${name.padEnd(30)} ${String(hexIds.length).padStart(6)}  ${areakm2.padStart(6)} km²`);
  } catch (err) {
    console.error(`${name.padEnd(30)} ERROR: ${(err as Error).message}`);
  }
}

console.log("\nDone.");
