/**
 * TravelTime public_transport isochrone → H3 hex IDs.
 * Uses a fixed Tuesday 9am ET departure time so results are comparable
 * across all 326 candidates (peak weekday transit).
 */

import fetch from "node-fetch";
import * as h3 from "h3-js";

const H3_RESOLUTION = 8;

// Always use next Tuesday at 13:00 UTC (9am ET) — weekday peak, within TravelTime's 2-week window
function nextTuesdayISO(): string {
  const d = new Date();
  d.setUTCHours(13, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun, 2=Tue
  const daysUntilTuesday = (2 - day + 7) % 7 || 7; // always at least 1 day ahead
  d.setUTCDate(d.getUTCDate() + daysUntilTuesday);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const DEPARTURE_TIME = nextTuesdayISO();

interface TTShape {
  shell: Array<{ lat: number; lng: number }>;
  holes: Array<Array<{ lat: number; lng: number }>>;
}

interface TTResult {
  search_id: string;
  shapes: TTShape[];
}

interface TTResponse {
  results: TTResult[];
}

export async function getTransitIsochroneHexes(
  lat: number,
  lon: number,
  minutes: number,
): Promise<string[]> {
  const appId  = process.env.TRAVELTIME_APP_ID;
  const apiKey = process.env.TRAVELTIME_API_KEY;
  if (!appId || !apiKey) throw new Error("TRAVELTIME_APP_ID / TRAVELTIME_API_KEY not set");

  const res = await fetch("https://api.traveltimeapp.com/v4/time-map", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Application-Id": appId,
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      departure_searches: [{
        id: "venue",
        coords: { lat, lng: lon },
        departure_time: DEPARTURE_TIME,
        travel_time: minutes * 60,
        transportation: { type: "public_transport" },
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TravelTime API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as TTResponse;
  const shapes = data.results?.[0]?.shapes ?? [];

  if (shapes.length === 0) return [];

  // Each shape is a polygon (shell + holes). Convert shell to H3 hex IDs
  // and union all shapes (TravelTime can return a MultiPolygon result).
  const hexSet = new Set<string>();

  for (const shape of shapes) {
    // TravelTime returns {lat, lng} — h3 expects [lat, lng]
    const outerRing: [number, number][] = shape.shell.map(p => [p.lat, p.lng]);
    if (outerRing.length < 3) continue;

    const cells = h3.polygonToCellsExperimental(
      [outerRing],
      H3_RESOLUTION,
      h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
    );
    for (const c of cells) hexSet.add(c);
  }

  return [...hexSet];
}
