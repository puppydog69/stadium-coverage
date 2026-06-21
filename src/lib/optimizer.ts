export interface Candidate {
  name: string;
  state: string;
  lat: number;
  lon: number;
  hexCount: number;
  population: number;
  hexIds: string[];
  mode?: string; // "driving" | "transit" | "walking" | etc.
}

export interface SelectedCandidate extends Candidate {
  rank: number;
  incrementalPopulation: number; // actual new population covered (unweighted)
}

/**
 * Greedy set-cover optimizer: repeatedly picks the candidate that adds the
 * most new weighted population to the covered set.
 *
 * transitWeight multiplies a candidate's incremental score (not the returned
 * incrementalPopulation) when its mode is "transit".
 */
export function selectOptimalLocations(
  candidates: Candidate[],
  popLookup: Record<string, number>,
  N: number,
  transitWeight: number = 1,
): SelectedCandidate[] {
  const covered = new Set<string>();
  // Use index-keyed map so we can delete without mutating the input array.
  const remaining = new Map<number, Candidate>(candidates.map((c, i) => [i, c]));
  const selected: SelectedCandidate[] = [];

  const rounds = Math.min(N, candidates.length);

  for (let rank = 1; rank <= rounds; rank++) {
    let bestKey = -1;
    let bestScore = -1;
    let bestIncremental = 0;

    for (const [key, c] of remaining) {
      let incrementalPop = 0;
      for (const hex of c.hexIds) {
        if (!covered.has(hex)) {
          incrementalPop += popLookup[hex] ?? 0;
        }
      }

      const weight = c.mode === "transit" ? transitWeight : 1;
      const score = incrementalPop * weight;

      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
        bestIncremental = incrementalPop;
      }
    }

    if (bestKey === -1) break;

    const best = remaining.get(bestKey)!;
    for (const hex of best.hexIds) covered.add(hex);
    remaining.delete(bestKey);

    selected.push({ ...best, rank, incrementalPopulation: bestIncremental });
  }

  return selected;
}
