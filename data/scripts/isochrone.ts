import fetch from "node-fetch";
import * as h3 from "h3-js";

const H3_RESOLUTION = 8;

export type IsochroneProfile = "driving" | "walking" | "cycling";

export async function getIsochroneHexes(
  lat: number,
  lon: number,
  minutes: number,
  profile: IsochroneProfile = "driving"
): Promise<string[]> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("MAPBOX_TOKEN not set in environment");

  const url =
    `https://api.mapbox.com/isochrone/v1/mapbox/${profile}/${lon},${lat}` +
    `?contours_minutes=${minutes}&polygons=true&access_token=${token}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mapbox API error ${res.status}: ${body}`);
  }

  const geojson = (await res.json()) as GeoJSON.FeatureCollection;
  const feature = geojson.features[0];

  if (!feature) {
    throw new Error(
      `Mapbox returned no polygon for (${lat}, ${lon}) at ${minutes} min ${profile}`
    );
  }

  const geometry = feature.geometry as GeoJSON.Polygon;
  if (!geometry?.coordinates?.[0]?.length) {
    throw new Error(
      `Mapbox returned an empty polygon for (${lat}, ${lon}) at ${minutes} min ${profile}`
    );
  }

  // GeoJSON coords are [lng, lat]; h3 expects [lat, lng]
  const outerRing: [number, number][] = geometry.coordinates[0].map(
    ([lng, lat]) => [lat, lng]
  );

  return h3.polygonToCellsExperimental(
    [outerRing],
    H3_RESOLUTION,
    h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping
  );
}
