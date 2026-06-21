import * as fs from "fs";
import * as path from "path";
import { selectOptimalLocations } from "../../src/lib/optimizer.ts";
import type { Candidate, SelectedCandidate } from "../../src/lib/optimizer.ts";

// ---------------------------------------------------------------------------
// Synthetic test
//
// Population map:
//   h1=100  h2=200  h3=300  h4=500  h5=50  h6=50  h7=400  h8=450
//
// Candidates:
//   A (driving): [h1,h2,h3]  raw=600
//   B (driving): [h2,h4]     raw=700
//   C (driving): [h5,h6]     raw=100
//   D (driving): [h1,h7]     raw=500
//   E (transit): [h8]        raw=450
//
// Greedy N=5, transitWeight=1 (weight irrelevant, same as driving):
//   Round 1: B=700 > A=600 > D=500 > E=450 > C=100  → pick B
//            covered={h2,h4}
//   Round 2: A=h1+h3=400, C=100, D=h1+h7=500, E=450 → pick D
//            covered={h2,h4,h1,h7}
//   Round 3: A=h3=300, C=100, E=450                  → pick E
//            covered={h2,h4,h1,h7,h8}
//   Round 4: A=h3=300, C=100                          → pick A
//            covered={…,h3}; A incremental=300 (h1,h2 already covered)
//   Round 5: C=100                                     → pick C
//
// Expected order: B(700) D(500) E(450) A(300) C(100)
//
// Greedy N=5, transitWeight=2 (E is transit → score=450×2=900):
//   Round 1: E=900 > B=700 > A=600 > D=500 > C=100   → pick E
//            covered={h8}
//   Round 2: B=700 > A=600 > D=500 > C=100             → pick B
//            covered={h8,h2,h4}
//   Round 3: D=h1+h7=500 > A=h1+h2+h3... wait h2 covered: A=h1+h3=400, C=100 → pick D
//            covered={h8,h2,h4,h1,h7}
//   Round 4: A=h3=300 > C=100                           → pick A
//   Round 5: C=100
//
// Expected order: E(450) B(700) D(500) A(300) C(100)
// ---------------------------------------------------------------------------

const POP: Record<string, number> = {
  h1: 100, h2: 200, h3: 300, h4: 500,
  h5: 50,  h6: 50,  h7: 400, h8: 450,
};

function makeCand(
  name: string,
  hexIds: string[],
  mode: string = "driving",
): Candidate {
  const population = hexIds.reduce((s, h) => s + (POP[h] ?? 0), 0);
  return { name, state: "XX", lat: 0, lon: 0, hexCount: hexIds.length, population, hexIds, mode };
}

const SYNTH: Candidate[] = [
  makeCand("A", ["h1", "h2", "h3"]),
  makeCand("B", ["h2", "h4"]),
  makeCand("C", ["h5", "h6"]),
  makeCand("D", ["h1", "h7"]),
  makeCand("E", ["h8"], "transit"),
];

let passed = 0;
let failed = 0;

function assert(label: string, got: SelectedCandidate[], expectedNames: string[], expectedPops: number[]) {
  const names = got.map(r => r.name);
  const pops  = got.map(r => r.incrementalPopulation);
  const nameOk = JSON.stringify(names) === JSON.stringify(expectedNames);
  const popOk  = JSON.stringify(pops)  === JSON.stringify(expectedPops);

  if (nameOk && popOk) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    if (!nameOk) console.error(`    order:  got ${JSON.stringify(names)}, want ${JSON.stringify(expectedNames)}`);
    if (!popOk)  console.error(`    pops:   got ${JSON.stringify(pops)},  want ${JSON.stringify(expectedPops)}`);
    failed++;
  }
}

console.log("\n=== Synthetic tests ===\n");

// Test 1: transitWeight=1 (transit multiplier has no effect)
assert(
  "transitWeight=1 → B D E A C",
  selectOptimalLocations(SYNTH, POP, 5, 1),
  ["B", "D", "E", "A", "C"],
  [700, 500, 450, 300, 100],
);

// Test 2: transitWeight=2 → E jumps to first
assert(
  "transitWeight=2 → E B D A C",
  selectOptimalLocations(SYNTH, POP, 5, 2),
  ["E", "B", "D", "A", "C"],
  [450, 700, 500, 300, 100],
);

// Test 3: N<len — only top 3 returned
const top3 = selectOptimalLocations(SYNTH, POP, 3, 1);
assert(
  "N=3 → B D E (only 3 results)",
  top3,
  ["B", "D", "E"],
  [700, 500, 450],
);

// Test 4: ranks are 1-based and sequential
const ranksOk = top3.every((r, i) => r.rank === i + 1);
if (ranksOk) { console.log("  ✓ ranks are 1-based sequential"); passed++; }
else          { console.error("  ✗ ranks wrong:", top3.map(r => r.rank)); failed++; }

// Test 5: empty candidates → empty result
const empty = selectOptimalLocations([], POP, 5, 1);
if (empty.length === 0) { console.log("  ✓ empty input → empty output"); passed++; }
else                    { console.error("  ✗ empty input returned:", empty); failed++; }

// Test 6: N=0 → empty result
const zero = selectOptimalLocations(SYNTH, POP, 0, 1);
if (zero.length === 0) { console.log("  ✓ N=0 → empty output"); passed++; }
else                   { console.error("  ✗ N=0 returned:", zero); failed++; }

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Real data run
// ---------------------------------------------------------------------------
console.log("=== Real data (candidates.json, N=10, transitWeight=1) ===\n");

const CAND_PATH = path.resolve(process.cwd(), "data/candidates.json");
const POP_PATH  = path.resolve(process.cwd(), "data/population-r8.json");

if (!fs.existsSync(CAND_PATH) || !fs.existsSync(POP_PATH)) {
  console.log("  Skipping real-data run (files not found).");
  process.exit(0);
}

const candidates = JSON.parse(fs.readFileSync(CAND_PATH, "utf8")) as Candidate[];
const popLookup  = JSON.parse(fs.readFileSync(POP_PATH,  "utf8")) as Record<string, number>;

console.log(`  Loaded ${candidates.length} candidates, ${Object.keys(popLookup).length.toLocaleString()} hex entries.\n`);

const results = selectOptimalLocations(candidates, popLookup, 10, 1);

let cumulativePop = 0;
console.log("  Rank  Candidate                                    Incremental Pop   Cumulative Pop");
console.log("  ─────────────────────────────────────────────────────────────────────────────────");
for (const r of results) {
  cumulativePop += r.incrementalPopulation;
  const rankStr  = String(r.rank).padStart(4);
  const nameStr  = r.name.padEnd(44);
  const incStr   = r.incrementalPopulation.toLocaleString().padStart(15);
  const cumStr   = cumulativePop.toLocaleString().padStart(15);
  console.log(`  ${rankStr}  ${nameStr} ${incStr}  ${cumStr}`);
}
