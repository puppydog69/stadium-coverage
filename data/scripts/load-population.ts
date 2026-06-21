import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";

const DATA_DIR = path.resolve(process.cwd(), "data");
const GZ_PATH = path.join(DATA_DIR, "kontur_population_US.gpkg.gz");
const GPKG_PATH = path.join(DATA_DIR, "kontur_population_US.gpkg");
const OUT_PATH = path.join(DATA_DIR, "population-r8.json");
const S3_URL =
  "https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_US_20231101.gpkg.gz";

// --- Download ---
if (!fs.existsSync(GPKG_PATH) && !fs.existsSync(GZ_PATH)) {
  console.log(`Downloading US Kontur Population (~294 MB compressed)...`);
  const dl = spawnSync(
    "curl",
    ["-L", "--progress-bar", "-o", GZ_PATH, S3_URL],
    { stdio: "inherit" }
  );
  if (dl.status !== 0) throw new Error("Download failed");
  console.log("Download complete.");
} else {
  console.log(
    fs.existsSync(GPKG_PATH)
      ? `GeoPackage already present, skipping download.`
      : `Archive already present, skipping download.`
  );
}

// --- Decompress ---
if (!fs.existsSync(GPKG_PATH)) {
  console.log(`Decompressing ${path.basename(GZ_PATH)}...`);
  execSync(`gunzip -k "${GZ_PATH}"`);
  console.log(`Decompressed to ${path.basename(GPKG_PATH)}.`);
}

// --- Inspect schema ---
console.log(`\nOpening GeoPackage with better-sqlite3...`);
const db = new Database(GPKG_PATH, { readonly: true });
db.defaultSafeIntegers(true); // return BigInt for 64-bit ints

const GPKG_INTERNAL = new Set([
  "gpkg_contents", "gpkg_geometry_columns", "gpkg_spatial_ref_sys",
  "gpkg_extensions", "gpkg_tile_matrix", "gpkg_tile_matrix_set",
  "sqlite_sequence", "rtree_population_geom",
  "rtree_population_geom_node", "rtree_population_geom_parent",
  "rtree_population_geom_rowid",
]);

const allTables = (
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
).map((r) => r.name);

// gpkg_contents is the authoritative list of feature/tile tables in a GeoPackage
const featureTables = (
  db.prepare("SELECT table_name FROM gpkg_contents WHERE data_type='features'").all() as {
    table_name: string;
  }[]
).map((r) => r.table_name);

console.log("All tables:", allTables);
console.log("Feature table(s) from gpkg_contents:", featureTables);

const tableName = featureTables[0];
if (!tableName) throw new Error("No feature table found in gpkg_contents");

const cols = (
  db.prepare(`PRAGMA table_info("${tableName}")`).all() as {
    name: string;
    type: string;
  }[]
);
console.log(
  `\nColumns in "${tableName}":`,
  cols.map((c) => `${c.name} (${c.type})`)
);

// Locate h3 and population columns by name
const h3Col = cols.find((c) => c.name.toLowerCase() === "h3")?.name;
const popCol = cols.find((c) => c.name.toLowerCase().includes("pop"))?.name;

if (!h3Col) throw new Error("No 'h3' column found — column names: " + cols.map(c => c.name).join(", "));
if (!popCol) throw new Error("No population column found — column names: " + cols.map(c => c.name).join(", "));

console.log(`\nUsing columns: h3="${h3Col}", population="${popCol}"`);

// --- Sample a row to check h3 type ---
const sample = db
  .prepare(`SELECT "${h3Col}", "${popCol}" FROM "${tableName}" LIMIT 1`)
  .get() as Record<string, unknown>;
console.log("Sample raw row:", sample);

// --- Build lookup ---
console.log(`\nReading all rows (population > 0)...`);
const t0 = Date.now();

const rows = db
  .prepare(
    `SELECT "${h3Col}" AS h3, "${popCol}" AS pop FROM "${tableName}" WHERE "${popCol}" > 0`
  )
  .all() as { h3: string | bigint; pop: number | bigint }[];

console.log(`Read ${rows.length.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const lookup: Record<string, number> = {};
for (const row of rows) {
  // h3 may be stored as BigInt (INT8) or text — handle both
  const hexId =
    typeof row.h3 === "bigint"
      ? row.h3.toString(16)
      : String(row.h3);
  const pop =
    typeof row.pop === "bigint" ? Number(row.pop) : Math.round(row.pop as number);
  lookup[hexId] = pop;
}

// --- Save ---
console.log(`\nWriting ${OUT_PATH}...`);
const t1 = Date.now();
fs.writeFileSync(OUT_PATH, JSON.stringify(lookup));
const fileSizeBytes = fs.statSync(OUT_PATH).size;
const fileSizeMB = (fileSizeBytes / 1_048_576).toFixed(1);
console.log(`Wrote in ${((Date.now() - t1) / 1000).toFixed(1)}s — ${fileSizeMB} MB`);

// --- Sanity check ---
const hexIds = Object.keys(lookup);
console.log(`\nTotal hexes with population > 0: ${hexIds.length.toLocaleString()}`);

console.log("\nSample (5 hex IDs → population):");
hexIds.slice(0, 5).forEach((id) => {
  console.log(`  ${id}  →  ${lookup[id].toLocaleString()}`);
});

db.close();
