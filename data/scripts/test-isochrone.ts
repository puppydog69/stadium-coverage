import * as dotenv from "dotenv";
import fetch from "node-fetch";
import * as h3 from "h3-js";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const LAT = 40.7549;
const LON = -73.984;
const MINUTES = 15;
const PROFILE = "driving";
const H3_RESOLUTION = 8;

async function main() {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("MAPBOX_TOKEN not set in .env");

  const url =
    `https://api.mapbox.com/isochrone/v1/mapbox/${PROFILE}/${LON},${LAT}` +
    `?contours_minutes=${MINUTES}&polygons=true&access_token=${token}`;

  console.log(`\n--- REQUEST ---`);
  console.log(`Profile:  mapbox/${PROFILE}`);
  console.log(`Contour:  ${MINUTES} minutes`);
  console.log(`URL:      ${url}\n`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox API error: ${res.status} ${await res.text()}`);

  const geojson = (await res.json()) as GeoJSON.FeatureCollection;

  console.log(`--- RAW RESPONSE (first 5 and last 5 coordinates) ---`);
  const polygon = geojson.features[0];
  if (!polygon) throw new Error("No polygon returned from Mapbox");

  const rawCoords = (polygon.geometry as GeoJSON.Polygon).coordinates[0];
  console.log(`Total coordinate pairs: ${rawCoords.length}`);
  console.log(`First 5 [lng, lat]:`, rawCoords.slice(0, 5));
  console.log(`Last  5 [lng, lat]:`, rawCoords.slice(-5));

  // GeoJSON is [lng, lat]; h3 wants [lat, lng]
  const h3Polygon: [number, number][] = rawCoords.map(([lng, lat]) => [lat, lng]);

  const lats = h3Polygon.map(([lat]) => lat);
  const lngs = h3Polygon.map(([, lng]) => lng);
  console.log(`\n--- BOUNDING BOX (after coord swap to [lat,lng]) ---`);
  console.log(`  lat: ${Math.min(...lats).toFixed(4)} → ${Math.max(...lats).toFixed(4)}`);
  console.log(`  lng: ${Math.min(...lngs).toFixed(4)} → ${Math.max(...lngs).toFixed(4)}`);

  // containmentOverlapping: any hex touching the polygon interior (vs center-only default)
  const hexIds = h3.polygonToCellsExperimental(
    [h3Polygon],
    H3_RESOLUTION,
    h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping
  );

  console.log(`\nH3 resolution-${H3_RESOLUTION} hexagons inside catchment: ${hexIds.length}`);

  const hexCenters = hexIds.map((id) => h3.cellToLatLng(id));
  const hexLats = hexCenters.map(([lat]) => lat);
  const hexLngs = hexCenters.map(([, lng]) => lng);
  console.log(`\n--- HEX BOUNDING BOX (cell centers) ---`);
  console.log(`  lat: ${Math.min(...hexLats).toFixed(4)} → ${Math.max(...hexLats).toFixed(4)}`);
  console.log(`  lng: ${Math.min(...hexLngs).toFixed(4)} → ${Math.max(...hexLngs).toFixed(4)}`);
  console.log(`  (isochrone bbox was lat 40.7259→40.8049, lng -74.0500→-73.9233)`);

  console.log("\nHex IDs:", hexIds);

  const output = {
    center: { lat: LAT, lon: LON },
    profile: PROFILE,
    minutes: MINUTES,
    h3Resolution: H3_RESOLUTION,
    hexCount: hexIds.length,
    hexIds,
  };

  const outPath = path.resolve(process.cwd(), "data/test-output.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResult saved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
