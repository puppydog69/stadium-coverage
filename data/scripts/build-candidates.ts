import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getIsochroneHexes } from "./isochrone.ts";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const argMin = process.argv.slice(2).map(Number).find(n => n > 0);
const MINUTES = argMin ?? 15;
const DELAY_MS = 300;
const SAVE_EVERY = 50;
const OUT_PATH = MINUTES === 15
  ? path.resolve(process.cwd(), "public/candidates.json")
  : path.resolve(process.cwd(), `data/candidates-${MINUTES}.json`);
const POP_PATH = path.resolve(process.cwd(), "data/population-r8.json");

interface Candidate { name: string; state: string; lat: number; lon: number; }
interface Result extends Candidate { hexCount: number; population: number; hexIds: string[]; }

// ---------------------------------------------------------------------------
// ~330 candidate locations with national coverage.
// Multiple sub-areas per dense metro; at least one point per state.
// ---------------------------------------------------------------------------
const CANDIDATES: Candidate[] = [
  // --- New York City (NY) ---
  { name: "NYC – Midtown Manhattan",       state: "NY", lat: 40.7549,  lon: -73.9840 },
  { name: "NYC – Lower Manhattan",         state: "NY", lat: 40.7128,  lon: -74.0059 },
  { name: "NYC – Upper West Side",         state: "NY", lat: 40.7870,  lon: -73.9754 },
  { name: "NYC – Upper East Side",         state: "NY", lat: 40.7736,  lon: -73.9566 },
  { name: "NYC – Harlem",                  state: "NY", lat: 40.8116,  lon: -73.9465 },
  { name: "NYC – Washington Heights",      state: "NY", lat: 40.8448,  lon: -73.9340 },
  { name: "NYC – Astoria, Queens",         state: "NY", lat: 40.7721,  lon: -73.9303 },
  { name: "NYC – Flushing, Queens",        state: "NY", lat: 40.7676,  lon: -73.8330 },
  { name: "NYC – Jamaica, Queens",         state: "NY", lat: 40.6943,  lon: -73.8065 },
  { name: "NYC – Williamsburg, Brooklyn",  state: "NY", lat: 40.7081,  lon: -73.9571 },
  { name: "NYC – Crown Heights, Brooklyn", state: "NY", lat: 40.6694,  lon: -73.9442 },
  { name: "NYC – Bay Ridge, Brooklyn",     state: "NY", lat: 40.6354,  lon: -74.0233 },
  { name: "NYC – South Bronx",             state: "NY", lat: 40.8168,  lon: -73.9065 },
  { name: "NYC – North Bronx",             state: "NY", lat: 40.8773,  lon: -73.8789 },
  { name: "NYC – Staten Island",           state: "NY", lat: 40.5795,  lon: -74.1502 },
  { name: "NYC – Yonkers",                 state: "NY", lat: 40.9312,  lon: -73.8988 },
  { name: "NYC – Jersey City",             state: "NJ", lat: 40.7178,  lon: -74.0431 },
  { name: "NYC – Newark",                  state: "NJ", lat: 40.7357,  lon: -74.1724 },
  { name: "Albany NY",                     state: "NY", lat: 42.6526,  lon: -73.7562 },
  { name: "Syracuse NY",                   state: "NY", lat: 43.0481,  lon: -76.1474 },
  { name: "Buffalo NY",                    state: "NY", lat: 42.8864,  lon: -78.8784 },
  { name: "Rochester NY",                  state: "NY", lat: 43.1566,  lon: -77.6088 },

  // --- Los Angeles (CA) ---
  { name: "LA – Downtown",                 state: "CA", lat: 34.0522,  lon: -118.2437 },
  { name: "LA – Hollywood",                state: "CA", lat: 34.0928,  lon: -118.3287 },
  { name: "LA – Westwood / UCLA",          state: "CA", lat: 34.0635,  lon: -118.4452 },
  { name: "LA – Santa Monica",             state: "CA", lat: 34.0195,  lon: -118.4912 },
  { name: "LA – Koreatown",                state: "CA", lat: 34.0581,  lon: -118.3005 },
  { name: "LA – East LA",                  state: "CA", lat: 34.0235,  lon: -118.1722 },
  { name: "LA – Compton",                  state: "CA", lat: 33.8958,  lon: -118.2201 },
  { name: "LA – Pasadena",                 state: "CA", lat: 34.1478,  lon: -118.1445 },
  { name: "LA – Long Beach",               state: "CA", lat: 33.7701,  lon: -118.1937 },
  { name: "LA – Burbank",                  state: "CA", lat: 34.1808,  lon: -118.3090 },
  { name: "LA – Van Nuys",                 state: "CA", lat: 34.1870,  lon: -118.4498 },
  { name: "LA – Inglewood",                state: "CA", lat: 33.9617,  lon: -118.3531 },
  { name: "LA – Anaheim",                  state: "CA", lat: 33.8366,  lon: -117.9143 },
  { name: "LA – Glendale",                 state: "CA", lat: 34.1425,  lon: -118.2551 },
  { name: "LA – Torrance",                 state: "CA", lat: 33.8358,  lon: -118.3406 },
  { name: "LA – Pomona",                   state: "CA", lat: 34.0553,  lon: -117.7500 },
  { name: "LA – Ontario",                  state: "CA", lat: 34.0633,  lon: -117.6509 },
  { name: "LA – Lancaster / Palmdale",     state: "CA", lat: 34.6868,  lon: -118.1542 },
  { name: "LA – Oxnard",                   state: "CA", lat: 34.1975,  lon: -119.1771 },

  // --- San Francisco Bay Area (CA) ---
  { name: "Bay Area – Downtown SF",        state: "CA", lat: 37.7749,  lon: -122.4194 },
  { name: "Bay Area – Mission District",   state: "CA", lat: 37.7599,  lon: -122.4148 },
  { name: "Bay Area – Oakland",            state: "CA", lat: 37.8044,  lon: -122.2712 },
  { name: "Bay Area – Berkeley",           state: "CA", lat: 37.8716,  lon: -122.2727 },
  { name: "Bay Area – San Jose",           state: "CA", lat: 37.3382,  lon: -121.8863 },
  { name: "Bay Area – Fremont",            state: "CA", lat: 37.5485,  lon: -121.9886 },
  { name: "Bay Area – Daly City",          state: "CA", lat: 37.6879,  lon: -122.4702 },
  { name: "Bay Area – Richmond",           state: "CA", lat: 37.9358,  lon: -122.3478 },
  { name: "Bay Area – Walnut Creek",       state: "CA", lat: 37.9101,  lon: -122.0652 },
  { name: "Bay Area – San Mateo",          state: "CA", lat: 37.5630,  lon: -122.3255 },
  { name: "Bay Area – Sunnyvale",          state: "CA", lat: 37.3688,  lon: -122.0363 },
  { name: "Bay Area – Hayward",            state: "CA", lat: 37.6688,  lon: -122.0808 },
  { name: "Bay Area – Concord",            state: "CA", lat: 37.9779,  lon: -122.0311 },
  { name: "Bay Area – Vallejo",            state: "CA", lat: 38.1041,  lon: -122.2566 },
  { name: "Bay Area – Santa Rosa",         state: "CA", lat: 38.4404,  lon: -122.7141 },

  // --- Other California ---
  { name: "Sacramento – Downtown",         state: "CA", lat: 38.5816,  lon: -121.4944 },
  { name: "Sacramento – Elk Grove",        state: "CA", lat: 38.4088,  lon: -121.3716 },
  { name: "Fresno – Downtown",             state: "CA", lat: 36.7378,  lon: -119.7871 },
  { name: "Bakersfield – Downtown",        state: "CA", lat: 35.3733,  lon: -119.0187 },
  { name: "Riverside CA",                  state: "CA", lat: 33.9533,  lon: -117.3961 },
  { name: "Stockton CA",                   state: "CA", lat: 37.9577,  lon: -121.2908 },
  { name: "Modesto CA",                    state: "CA", lat: 37.6391,  lon: -120.9969 },
  { name: "Visalia CA",                    state: "CA", lat: 36.3302,  lon: -119.2921 },
  { name: "Salinas CA",                    state: "CA", lat: 36.6777,  lon: -121.6555 },
  { name: "Santa Barbara CA",              state: "CA", lat: 34.4208,  lon: -119.6982 },
  { name: "San Bernardino CA",             state: "CA", lat: 34.1083,  lon: -117.2898 },
  { name: "San Diego – Downtown",          state: "CA", lat: 32.7157,  lon: -117.1611 },
  { name: "San Diego – Mission Valley",    state: "CA", lat: 32.7677,  lon: -117.1502 },
  { name: "San Diego – Chula Vista",       state: "CA", lat: 32.6401,  lon: -117.0842 },
  { name: "San Diego – Escondido",         state: "CA", lat: 33.1192,  lon: -117.0864 },

  // --- Chicago (IL) ---
  { name: "Chicago – The Loop",            state: "IL", lat: 41.8827,  lon: -87.6233 },
  { name: "Chicago – Lincoln Park",        state: "IL", lat: 41.9214,  lon: -87.6513 },
  { name: "Chicago – Wicker Park",         state: "IL", lat: 41.9088,  lon: -87.6781 },
  { name: "Chicago – Hyde Park",           state: "IL", lat: 41.8023,  lon: -87.5972 },
  { name: "Chicago – Rogers Park",         state: "IL", lat: 41.9764,  lon: -87.6625 },
  { name: "Chicago – Evanston",            state: "IL", lat: 42.0451,  lon: -87.6877 },
  { name: "Chicago – Oak Park",            state: "IL", lat: 41.8850,  lon: -87.7845 },
  { name: "Chicago – Cicero",              state: "IL", lat: 41.8456,  lon: -87.7539 },
  { name: "Chicago – Naperville",          state: "IL", lat: 41.7508,  lon: -88.1535 },
  { name: "Chicago – Aurora",              state: "IL", lat: 41.7606,  lon: -88.3201 },
  { name: "Chicago – Gary IN",             state: "IN", lat: 41.5934,  lon: -87.3464 },
  { name: "Rockford IL",                   state: "IL", lat: 42.2711,  lon: -89.0940 },
  { name: "Springfield IL",                state: "IL", lat: 39.7817,  lon: -89.6501 },
  { name: "Peoria IL",                     state: "IL", lat: 40.6936,  lon: -89.5890 },

  // --- Houston (TX) ---
  { name: "Houston – Downtown",            state: "TX", lat: 29.7604,  lon: -95.3698 },
  { name: "Houston – Midtown",             state: "TX", lat: 29.7366,  lon: -95.3752 },
  { name: "Houston – Galleria",            state: "TX", lat: 29.7363,  lon: -95.4613 },
  { name: "Houston – Southwest",           state: "TX", lat: 29.6697,  lon: -95.4980 },
  { name: "Houston – Pasadena TX",         state: "TX", lat: 29.6911,  lon: -95.2091 },
  { name: "Houston – Sugar Land",          state: "TX", lat: 29.6197,  lon: -95.6349 },
  { name: "Houston – The Woodlands",       state: "TX", lat: 30.1658,  lon: -95.4613 },
  { name: "Houston – Pearland",            state: "TX", lat: 29.5636,  lon: -95.2860 },

  // --- Dallas / Fort Worth (TX) ---
  { name: "DFW – Downtown Dallas",         state: "TX", lat: 32.7767,  lon: -96.7970 },
  { name: "DFW – Uptown Dallas",           state: "TX", lat: 32.7990,  lon: -96.8022 },
  { name: "DFW – Fort Worth Downtown",     state: "TX", lat: 32.7555,  lon: -97.3308 },
  { name: "DFW – Irving",                  state: "TX", lat: 32.8140,  lon: -96.9489 },
  { name: "DFW – Plano",                   state: "TX", lat: 33.0198,  lon: -96.6989 },
  { name: "DFW – Garland",                 state: "TX", lat: 32.9126,  lon: -96.6389 },
  { name: "DFW – Arlington TX",            state: "TX", lat: 32.7357,  lon: -97.1081 },
  { name: "DFW – McKinney",                state: "TX", lat: 33.1972,  lon: -96.6397 },
  { name: "DFW – Denton",                  state: "TX", lat: 33.2148,  lon: -97.1331 },

  // --- Other Texas ---
  { name: "Austin TX – Downtown",          state: "TX", lat: 30.2672,  lon: -97.7431 },
  { name: "Austin TX – South Austin",      state: "TX", lat: 30.2200,  lon: -97.7700 },
  { name: "San Antonio TX – Downtown",     state: "TX", lat: 29.4241,  lon: -98.4936 },
  { name: "San Antonio TX – North",        state: "TX", lat: 29.5490,  lon: -98.4690 },
  { name: "El Paso TX",                    state: "TX", lat: 31.7619,  lon: -106.4850 },
  { name: "Corpus Christi TX",             state: "TX", lat: 27.8006,  lon: -97.3964 },
  { name: "Laredo TX",                     state: "TX", lat: 27.5306,  lon: -99.4803 },
  { name: "McAllen TX",                    state: "TX", lat: 26.2034,  lon: -98.2300 },
  { name: "Lubbock TX",                    state: "TX", lat: 33.5779,  lon: -101.8552 },
  { name: "Amarillo TX",                   state: "TX", lat: 35.2220,  lon: -101.8313 },
  { name: "Waco TX",                       state: "TX", lat: 31.5493,  lon: -97.1467 },
  { name: "Beaumont TX",                   state: "TX", lat: 30.0802,  lon: -94.1266 },

  // --- Miami / South Florida (FL) ---
  { name: "Miami – Downtown",              state: "FL", lat: 25.7617,  lon: -80.1918 },
  { name: "Miami – Miami Beach",           state: "FL", lat: 25.7907,  lon: -80.1300 },
  { name: "Miami – Coral Gables",          state: "FL", lat: 25.7215,  lon: -80.2684 },
  { name: "Miami – Hialeah",               state: "FL", lat: 25.8576,  lon: -80.2781 },
  { name: "Miami – North Miami",           state: "FL", lat: 25.8897,  lon: -80.1868 },
  { name: "Miami – Fort Lauderdale",       state: "FL", lat: 26.1224,  lon: -80.1373 },
  { name: "Miami – West Palm Beach",       state: "FL", lat: 26.7153,  lon: -80.0534 },
  { name: "Miami – Boca Raton",            state: "FL", lat: 26.3683,  lon: -80.1289 },

  // --- Other Florida ---
  { name: "Tampa – Downtown",              state: "FL", lat: 27.9506,  lon: -82.4572 },
  { name: "Tampa – St. Petersburg",        state: "FL", lat: 27.7676,  lon: -82.6403 },
  { name: "Tampa – Clearwater",            state: "FL", lat: 27.9659,  lon: -82.8001 },
  { name: "Orlando – Downtown",            state: "FL", lat: 28.5383,  lon: -81.3792 },
  { name: "Orlando – Kissimmee",           state: "FL", lat: 28.2920,  lon: -81.4076 },
  { name: "Jacksonville FL",               state: "FL", lat: 30.3322,  lon: -81.6557 },
  { name: "Tallahassee FL",                state: "FL", lat: 30.4518,  lon: -84.2807 },
  { name: "Cape Coral FL",                 state: "FL", lat: 26.5629,  lon: -81.9495 },
  { name: "Gainesville FL",                state: "FL", lat: 29.6516,  lon: -82.3248 },
  { name: "Pensacola FL",                  state: "FL", lat: 30.4213,  lon: -87.2169 },

  // --- Philadelphia (PA / NJ) ---
  { name: "Philly – Center City",          state: "PA", lat: 39.9526,  lon: -75.1652 },
  { name: "Philly – West Philadelphia",    state: "PA", lat: 39.9552,  lon: -75.2254 },
  { name: "Philly – North Philadelphia",   state: "PA", lat: 39.9897,  lon: -75.1458 },
  { name: "Philly – South Philadelphia",   state: "PA", lat: 39.9188,  lon: -75.1619 },
  { name: "Philly – Camden NJ",            state: "NJ", lat: 39.9259,  lon: -75.1196 },
  { name: "Philly – Allentown PA",         state: "PA", lat: 40.6023,  lon: -75.4714 },
  { name: "Pittsburgh – Downtown",         state: "PA", lat: 40.4406,  lon: -79.9959 },
  { name: "Pittsburgh – Mt. Lebanon",      state: "PA", lat: 40.3748,  lon: -80.0612 },
  { name: "Erie PA",                       state: "PA", lat: 42.1292,  lon: -80.0851 },

  // --- Atlanta (GA) ---
  { name: "Atlanta – Downtown",            state: "GA", lat: 33.7490,  lon: -84.3880 },
  { name: "Atlanta – Midtown",             state: "GA", lat: 33.7839,  lon: -84.3830 },
  { name: "Atlanta – Buckhead",            state: "GA", lat: 33.8403,  lon: -84.3853 },
  { name: "Atlanta – Decatur",             state: "GA", lat: 33.7748,  lon: -84.2963 },
  { name: "Atlanta – Sandy Springs",       state: "GA", lat: 33.9304,  lon: -84.3733 },
  { name: "Atlanta – Marietta",            state: "GA", lat: 33.9526,  lon: -84.5499 },
  { name: "Augusta GA",                    state: "GA", lat: 33.4735,  lon: -82.0105 },
  { name: "Savannah GA",                   state: "GA", lat: 32.0809,  lon: -81.0912 },
  { name: "Columbus GA",                   state: "GA", lat: 32.4610,  lon: -84.9877 },

  // --- Washington DC area ---
  { name: "DC – Downtown",                 state: "DC", lat: 38.9072,  lon: -77.0369 },
  { name: "DC – Capitol Hill",             state: "DC", lat: 38.8899,  lon: -76.9979 },
  { name: "DC – Georgetown",               state: "DC", lat: 38.9060,  lon: -77.0632 },
  { name: "DC – Arlington VA",             state: "VA", lat: 38.8816,  lon: -77.0910 },
  { name: "DC – Alexandria VA",            state: "VA", lat: 38.8048,  lon: -77.0469 },
  { name: "DC – Bethesda MD",              state: "MD", lat: 38.9847,  lon: -77.0947 },
  { name: "DC – Silver Spring MD",         state: "MD", lat: 38.9940,  lon: -77.0309 },
  { name: "DC – Tysons VA",                state: "VA", lat: 38.9175,  lon: -77.2307 },
  { name: "Baltimore – Downtown",          state: "MD", lat: 39.2904,  lon: -76.6122 },
  { name: "Baltimore – Towson",            state: "MD", lat: 39.4015,  lon: -76.6019 },

  // --- Boston (MA) ---
  { name: "Boston – Downtown",             state: "MA", lat: 42.3601,  lon: -71.0589 },
  { name: "Boston – Cambridge",            state: "MA", lat: 42.3736,  lon: -71.1097 },
  { name: "Boston – Somerville",           state: "MA", lat: 42.3876,  lon: -71.0995 },
  { name: "Boston – Quincy",               state: "MA", lat: 42.2529,  lon: -71.0023 },
  { name: "Boston – Newton",               state: "MA", lat: 42.3370,  lon: -71.2092 },
  { name: "Boston – Lowell",               state: "MA", lat: 42.6334,  lon: -71.3162 },
  { name: "Boston – Brockton",             state: "MA", lat: 42.0834,  lon: -71.0184 },
  { name: "Boston – Lynn",                 state: "MA", lat: 42.4668,  lon: -70.9495 },
  { name: "Worcester MA",                  state: "MA", lat: 42.2626,  lon: -71.8023 },
  { name: "Springfield MA",                state: "MA", lat: 42.1015,  lon: -72.5898 },

  // --- Seattle (WA) ---
  { name: "Seattle – Downtown",            state: "WA", lat: 47.6062,  lon: -122.3321 },
  { name: "Seattle – Capitol Hill",        state: "WA", lat: 47.6254,  lon: -122.3215 },
  { name: "Seattle – Bellevue",            state: "WA", lat: 47.6101,  lon: -122.2015 },
  { name: "Seattle – Tacoma",              state: "WA", lat: 47.2529,  lon: -122.4443 },
  { name: "Seattle – Redmond",             state: "WA", lat: 47.6740,  lon: -122.1215 },
  { name: "Seattle – Everett",             state: "WA", lat: 47.9790,  lon: -122.2021 },
  { name: "Seattle – Renton",              state: "WA", lat: 47.4799,  lon: -122.2171 },
  { name: "Spokane WA",                    state: "WA", lat: 47.6587,  lon: -117.4260 },

  // --- Denver (CO) ---
  { name: "Denver – Downtown",             state: "CO", lat: 39.7392,  lon: -104.9903 },
  { name: "Denver – Aurora",               state: "CO", lat: 39.7294,  lon: -104.8319 },
  { name: "Denver – Lakewood",             state: "CO", lat: 39.7047,  lon: -105.0814 },
  { name: "Denver – Westminster",          state: "CO", lat: 39.8366,  lon: -105.0372 },
  { name: "Denver – Arvada",               state: "CO", lat: 39.8028,  lon: -105.0875 },
  { name: "Denver – Thornton",             state: "CO", lat: 39.8680,  lon: -104.9719 },
  { name: "Colorado Springs",              state: "CO", lat: 38.8339,  lon: -104.8214 },
  { name: "Fort Collins CO",               state: "CO", lat: 40.5853,  lon: -105.0844 },
  { name: "Pueblo CO",                     state: "CO", lat: 38.2544,  lon: -104.6091 },

  // --- Minneapolis / St. Paul (MN) ---
  { name: "MSP – Downtown Minneapolis",    state: "MN", lat: 44.9778,  lon: -93.2650 },
  { name: "MSP – St. Paul",                state: "MN", lat: 44.9537,  lon: -93.0900 },
  { name: "MSP – Bloomington",             state: "MN", lat: 44.8408,  lon: -93.3477 },
  { name: "MSP – Brooklyn Park",           state: "MN", lat: 45.0941,  lon: -93.3727 },
  { name: "MSP – Plymouth",                state: "MN", lat: 45.0105,  lon: -93.4555 },

  // --- Phoenix / Scottsdale (AZ) ---
  { name: "Phoenix – Downtown",            state: "AZ", lat: 33.4484,  lon: -112.0740 },
  { name: "Phoenix – Tempe",               state: "AZ", lat: 33.4255,  lon: -111.9400 },
  { name: "Phoenix – Mesa",                state: "AZ", lat: 33.4152,  lon: -111.8315 },
  { name: "Phoenix – Scottsdale",          state: "AZ", lat: 33.4942,  lon: -111.9261 },
  { name: "Phoenix – Glendale AZ",         state: "AZ", lat: 33.5387,  lon: -112.1860 },
  { name: "Phoenix – Chandler",            state: "AZ", lat: 33.3062,  lon: -111.8413 },
  { name: "Phoenix – Gilbert",             state: "AZ", lat: 33.3528,  lon: -111.7890 },
  { name: "Phoenix – Peoria AZ",           state: "AZ", lat: 33.5806,  lon: -112.2374 },
  { name: "Tucson – Downtown",             state: "AZ", lat: 32.2226,  lon: -110.9747 },
  { name: "Flagstaff AZ",                  state: "AZ", lat: 35.1983,  lon: -111.6513 },

  // --- Las Vegas (NV) ---
  { name: "Las Vegas – The Strip",         state: "NV", lat: 36.1147,  lon: -115.1728 },
  { name: "Las Vegas – Downtown",          state: "NV", lat: 36.1699,  lon: -115.1398 },
  { name: "Las Vegas – Henderson",         state: "NV", lat: 36.0395,  lon: -114.9817 },
  { name: "Las Vegas – North LV",          state: "NV", lat: 36.1989,  lon: -115.1175 },
  { name: "Reno NV",                       state: "NV", lat: 39.5296,  lon: -119.8138 },

  // --- Portland OR ---
  { name: "Portland – Downtown",           state: "OR", lat: 45.5231,  lon: -122.6765 },
  { name: "Portland – Beaverton",          state: "OR", lat: 45.4871,  lon: -122.8037 },
  { name: "Portland – Gresham",            state: "OR", lat: 45.5023,  lon: -122.4301 },
  { name: "Eugene OR",                     state: "OR", lat: 44.0521,  lon: -123.0868 },
  { name: "Salem OR",                      state: "OR", lat: 44.9429,  lon: -123.0351 },

  // --- Detroit (MI) ---
  { name: "Detroit – Downtown",            state: "MI", lat: 42.3314,  lon: -83.0458 },
  { name: "Detroit – Dearborn",            state: "MI", lat: 42.3223,  lon: -83.1763 },
  { name: "Detroit – Warren",              state: "MI", lat: 42.4775,  lon: -83.0277 },
  { name: "Detroit – Ann Arbor",           state: "MI", lat: 42.2808,  lon: -83.7430 },
  { name: "Grand Rapids MI",               state: "MI", lat: 42.9634,  lon: -85.6681 },
  { name: "Lansing MI",                    state: "MI", lat: 42.7325,  lon: -84.5555 },

  // --- Ohio ---
  { name: "Columbus – Downtown",           state: "OH", lat: 39.9612,  lon: -82.9988 },
  { name: "Columbus – Short North",        state: "OH", lat: 39.9840,  lon: -83.0019 },
  { name: "Cleveland – Downtown",          state: "OH", lat: 41.4993,  lon: -81.6944 },
  { name: "Cleveland – Parma",             state: "OH", lat: 41.3845,  lon: -81.7296 },
  { name: "Cincinnati OH",                 state: "OH", lat: 39.1031,  lon: -84.5120 },
  { name: "Toledo OH",                     state: "OH", lat: 41.6639,  lon: -83.5552 },
  { name: "Dayton OH",                     state: "OH", lat: 39.7589,  lon: -84.1916 },
  { name: "Akron OH",                      state: "OH", lat: 41.0814,  lon: -81.5190 },

  // --- Indiana ---
  { name: "Indianapolis – Downtown",       state: "IN", lat: 39.7684,  lon: -86.1581 },
  { name: "Indianapolis – Carmel",         state: "IN", lat: 39.9784,  lon: -86.1180 },
  { name: "Fort Wayne IN",                 state: "IN", lat: 41.0793,  lon: -85.1394 },
  { name: "South Bend IN",                 state: "IN", lat: 41.6764,  lon: -86.2520 },
  { name: "Evansville IN",                 state: "IN", lat: 37.9716,  lon: -87.5711 },

  // --- Missouri ---
  { name: "St. Louis – Downtown",          state: "MO", lat: 38.6270,  lon: -90.1994 },
  { name: "St. Louis – Clayton",           state: "MO", lat: 38.6492,  lon: -90.3327 },
  { name: "KC – Downtown MO",              state: "MO", lat: 39.0997,  lon: -94.5786 },
  { name: "KC – Overland Park KS",         state: "KS", lat: 38.9822,  lon: -94.6708 },
  { name: "Springfield MO",                state: "MO", lat: 37.2090,  lon: -93.2923 },

  // --- North Carolina ---
  { name: "Charlotte – Uptown",            state: "NC", lat: 35.2271,  lon: -80.8431 },
  { name: "Charlotte – South Charlotte",   state: "NC", lat: 35.1076,  lon: -80.8501 },
  { name: "Raleigh – Downtown",            state: "NC", lat: 35.7796,  lon: -78.6382 },
  { name: "Durham NC",                     state: "NC", lat: 35.9940,  lon: -78.8986 },
  { name: "Greensboro NC",                 state: "NC", lat: 36.0726,  lon: -79.7920 },
  { name: "Winston-Salem NC",              state: "NC", lat: 36.0999,  lon: -80.2442 },
  { name: "Fayetteville NC",               state: "NC", lat: 35.0527,  lon: -78.8784 },

  // --- Virginia ---
  { name: "Richmond VA",                   state: "VA", lat: 37.5407,  lon: -77.4360 },
  { name: "Virginia Beach",                state: "VA", lat: 36.8529,  lon: -75.9780 },
  { name: "Norfolk VA",                    state: "VA", lat: 36.8508,  lon: -76.2859 },
  { name: "Chesapeake VA",                 state: "VA", lat: 36.7682,  lon: -76.2875 },

  // --- Tennessee ---
  { name: "Nashville – Downtown",          state: "TN", lat: 36.1627,  lon: -86.7816 },
  { name: "Nashville – Brentwood",         state: "TN", lat: 35.9987,  lon: -86.7828 },
  { name: "Memphis – Downtown",            state: "TN", lat: 35.1495,  lon: -90.0490 },
  { name: "Memphis – Germantown",          state: "TN", lat: 35.0870,  lon: -89.8101 },
  { name: "Knoxville TN",                  state: "TN", lat: 35.9606,  lon: -83.9207 },
  { name: "Chattanooga TN",                state: "TN", lat: 35.0456,  lon: -85.3097 },

  // --- Louisiana ---
  { name: "New Orleans – Downtown",        state: "LA", lat: 29.9511,  lon: -90.0715 },
  { name: "New Orleans – Metairie",        state: "LA", lat: 29.9965,  lon: -90.1548 },
  { name: "Baton Rouge LA",                state: "LA", lat: 30.4515,  lon: -91.1871 },
  { name: "Shreveport LA",                 state: "LA", lat: 32.5252,  lon: -93.7502 },

  // --- Wisconsin ---
  { name: "Milwaukee – Downtown",          state: "WI", lat: 43.0389,  lon: -87.9065 },
  { name: "Milwaukee – Waukesha",          state: "WI", lat: 43.0117,  lon: -88.2315 },
  { name: "Madison WI",                    state: "WI", lat: 43.0731,  lon: -89.4012 },
  { name: "Green Bay WI",                  state: "WI", lat: 44.5192,  lon: -88.0198 },

  // --- Utah ---
  { name: "SLC – Downtown",               state: "UT",  lat: 40.7608,  lon: -111.8910 },
  { name: "SLC – Provo",                  state: "UT",  lat: 40.2338,  lon: -111.6585 },
  { name: "SLC – Ogden",                  state: "UT",  lat: 41.2230,  lon: -111.9738 },

  // --- New Mexico ---
  { name: "Albuquerque – Downtown",        state: "NM", lat: 35.0853,  lon: -106.6504 },
  { name: "Santa Fe NM",                   state: "NM", lat: 35.6869,  lon: -105.9378 },

  // --- New England (CT, RI, NH, VT, ME) ---
  { name: "Hartford CT",                   state: "CT", lat: 41.7658,  lon: -72.6851 },
  { name: "New Haven CT",                  state: "CT", lat: 41.3083,  lon: -72.9279 },
  { name: "Bridgeport CT",                 state: "CT", lat: 41.1792,  lon: -73.1894 },
  { name: "Providence RI",                 state: "RI", lat: 41.8240,  lon: -71.4128 },
  { name: "Manchester NH",                 state: "NH", lat: 42.9956,  lon: -71.4548 },
  { name: "Burlington VT",                 state: "VT", lat: 44.4759,  lon: -73.2121 },
  { name: "Portland ME",                   state: "ME", lat: 43.6591,  lon: -70.2568 },

  // --- Mid-Atlantic (DE, MD) ---
  { name: "Wilmington DE",                 state: "DE", lat: 39.7447,  lon: -75.5484 },

  // --- Kansas / Nebraska / Iowa / Oklahoma ---
  { name: "Wichita KS",                    state: "KS", lat: 37.6872,  lon: -97.3301 },
  { name: "Lincoln NE",                    state: "NE", lat: 40.8136,  lon: -96.7026 },
  { name: "Omaha – Downtown",              state: "NE", lat: 41.2565,  lon: -95.9345 },
  { name: "Des Moines IA",                 state: "IA", lat: 41.5868,  lon: -93.6250 },
  { name: "Cedar Rapids IA",               state: "IA", lat: 41.9779,  lon: -91.6656 },
  { name: "Davenport IA",                  state: "IA", lat: 41.5236,  lon: -90.5776 },
  { name: "Oklahoma City",                 state: "OK", lat: 35.4676,  lon: -97.5164 },
  { name: "Tulsa OK",                      state: "OK", lat: 36.1540,  lon: -95.9928 },

  // --- Kentucky ---
  { name: "Louisville KY",                 state: "KY", lat: 38.2527,  lon: -85.7585 },
  { name: "Lexington KY",                  state: "KY", lat: 38.0406,  lon: -84.5037 },

  // --- Alabama ---
  { name: "Birmingham AL",                 state: "AL", lat: 33.5186,  lon: -86.8104 },
  { name: "Huntsville AL",                 state: "AL", lat: 34.7298,  lon: -86.5861 },
  { name: "Montgomery AL",                 state: "AL", lat: 32.3613,  lon: -86.2791 },
  { name: "Mobile AL",                     state: "AL", lat: 30.6954,  lon: -88.0399 },

  // --- Mississippi ---
  { name: "Jackson MS",                    state: "MS", lat: 32.2988,  lon: -90.1848 },
  { name: "Gulfport MS",                   state: "MS", lat: 30.3674,  lon: -89.0928 },

  // --- Arkansas ---
  { name: "Little Rock AR",                state: "AR", lat: 34.7465,  lon: -92.2896 },
  { name: "Fayetteville AR",               state: "AR", lat: 36.0626,  lon: -94.1574 },
  { name: "Fort Smith AR",                 state: "AR", lat: 35.3859,  lon: -94.3985 },

  // --- South Carolina ---
  { name: "Charleston SC",                 state: "SC", lat: 32.7765,  lon: -79.9311 },
  { name: "Columbia SC",                   state: "SC", lat: 34.0007,  lon: -81.0348 },
  { name: "Greenville SC",                 state: "SC", lat: 34.8526,  lon: -82.3940 },

  // --- West Virginia ---
  { name: "Charleston WV",                 state: "WV", lat: 38.3498,  lon: -81.6326 },
  { name: "Huntington WV",                 state: "WV", lat: 38.4192,  lon: -82.4452 },

  // --- Idaho ---
  { name: "Boise ID",                      state: "ID", lat: 43.6150,  lon: -116.2023 },
  { name: "Meridian ID",                   state: "ID", lat: 43.6120,  lon: -116.3915 },
  { name: "Twin Falls ID",                 state: "ID", lat: 42.5558,  lon: -114.4609 },

  // --- Montana ---
  { name: "Billings MT",                   state: "MT", lat: 45.7833,  lon: -108.5007 },
  { name: "Missoula MT",                   state: "MT", lat: 46.8721,  lon: -113.9940 },
  { name: "Great Falls MT",                state: "MT", lat: 47.4996,  lon: -111.3008 },

  // --- North / South Dakota ---
  { name: "Fargo ND",                      state: "ND", lat: 46.8772,  lon: -96.7898 },
  { name: "Bismarck ND",                   state: "ND", lat: 46.8083,  lon: -100.7837 },
  { name: "Sioux Falls SD",                state: "SD", lat: 43.5446,  lon: -96.7311 },
  { name: "Rapid City SD",                 state: "SD", lat: 44.0805,  lon: -103.2310 },

  // --- Wyoming ---
  { name: "Cheyenne WY",                   state: "WY", lat: 41.1400,  lon: -104.8202 },
  { name: "Casper WY",                     state: "WY", lat: 42.8501,  lon: -106.3252 },

  // --- Alaska / Hawaii ---
  { name: "Anchorage AK",                  state: "AK", lat: 61.2181,  lon: -149.9003 },
  { name: "Honolulu HI",                   state: "HI", lat: 21.3069,  lon: -157.8583 },
];

// ---------------------------------------------------------------------------

function save(results: Result[]) {
  const sorted = [...results].sort((a, b) => b.population - a.population);
  fs.writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2));
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // --- Load population lookup ---
  console.log("Loading population lookup...");
  const lookup: Record<string, number> = JSON.parse(fs.readFileSync(POP_PATH, "utf8"));
  console.log(`Loaded ${Object.keys(lookup).length.toLocaleString()} hex entries.\n`);

  // --- Resume: load already-completed results ---
  const completed = new Map<string, Result>();
  if (fs.existsSync(OUT_PATH)) {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, "utf8")) as Result[];
    for (const r of prev) completed.set(r.name, r);
    console.log(`Resuming: ${completed.size} candidates already done.\n`);
  }

  // Enrich existing entries with state field if missing
  for (const c of CANDIDATES) {
    const existing = completed.get(c.name);
    if (existing && !existing.state) {
      completed.set(c.name, { ...existing, state: c.state });
    }
  }

  const todo = CANDIDATES.filter((c) => !completed.has(c.name));
  const total = CANDIDATES.length;
  console.log(`${todo.length} remaining of ${total} total candidates.\n`);

  if (todo.length === 0) {
    console.log("All candidates already processed.");
    save([...completed.values()]);
    return;
  }

  let doneThisBatch = 0;
  for (let i = 0; i < todo.length; i++) {
    const { name, state, lat, lon } = todo[i];
    try {
      const hexIds = await getIsochroneHexes(lat, lon, MINUTES, "driving");
      const population = hexIds.reduce((sum, id) => sum + (lookup[id] ?? 0), 0);
      completed.set(name, { name, state, lat, lon, hexCount: hexIds.length, population, hexIds });
    } catch (err) {
      console.error(`  ERROR [${name}]: ${(err as Error).message}`);
      completed.set(name, { name, state, lat, lon, hexCount: 0, population: 0, hexIds: [] });
    }

    doneThisBatch++;
    const totalDone = completed.size;

    if (doneThisBatch % 20 === 0 || i === todo.length - 1) {
      const last = completed.get(name)!;
      console.log(
        `[${totalDone}/${total}] ${name} — ${last.hexCount} hexes, pop ${last.population.toLocaleString()}`
      );
    }

    if (doneThisBatch % SAVE_EVERY === 0) {
      save([...completed.values()]);
      console.log(`  → Saved checkpoint (${completed.size} total).`);
    }

    if (i < todo.length - 1) await sleep(DELAY_MS);
  }

  save([...completed.values()]);
  const sizeMB = (fs.statSync(OUT_PATH).size / 1_048_576).toFixed(1);
  console.log(`\nDone. ${completed.size} candidates → ${OUT_PATH} (${sizeMB} MB)`);

  const results = [...completed.values()].sort((a, b) => b.population - a.population);
  console.log(`\nTop 10 by ${MINUTES}-min driving population:`);
  results.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name.padEnd(40)} ${r.population.toLocaleString().padStart(10)}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
