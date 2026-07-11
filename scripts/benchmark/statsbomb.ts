/**
 * StatsBomb Open Data fetcher.
 * Downloads JSON from the public GitHub raw endpoint and caches to disk.
 * Pitch coords: 120 (length) x 80 (width).  Forward = increasing-x in the possessing team's direction.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, 'cache');
const BASE_URL = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data';

// StatsBomb pitch dimensions
export const SB_PITCH_LENGTH = 120;
export const SB_PITCH_WIDTH = 80;

// ── Types (minimal; only fields we actually use) ────────────────────────────

export interface SBCompetition {
  competition_id: number;
  season_id: number;
  competition_name: string;
  season_name: string;
}

export interface SBMatch {
  match_id: number;
  competition: { competition_id: number; competition_name: string };
  season: { season_id: number; season_name: string };
  home_team: { home_team_name: string };
  away_team: { away_team_name: string };
  match_date: string;
}

export interface SBVec {
  x: number;
  y: number;
}

export interface SBPassEvent {
  id: string;
  index: number;
  type: { name: string };
  play_pattern: { name: string };
  team: { name: string };
  location: [number, number]; // [x, y]
  pass: {
    length: number;
    angle: number; // radians; 0 = right (+x), pi/2 = up (+y)
    end_location: [number, number];
    outcome?: { name: string }; // absent = complete
    height?: { name: string };
    cross?: boolean;
  };
}

export interface SBCarryEvent {
  id: string;
  index: number;
  type: { name: string };
  play_pattern: { name: string };
  team: { name: string };
  location: [number, number];
  carry: {
    end_location: [number, number];
  };
}

export interface SBShotEvent {
  id: string;
  index: number;
  type: { name: string };
  play_pattern: { name: string };
  team: { name: string };
  location: [number, number];
  shot: {
    outcome: { name: string };
    technique?: { name: string };
  };
}

export type SBEvent = SBPassEvent | SBCarryEvent | SBShotEvent | { type: { name: string }; play_pattern: { name: string }; team: { name: string }; index: number; id: string; location?: [number, number] };

// ── Cache helpers ────────────────────────────────────────────────────────────

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFilePath(key: string): string {
  // sanitise key for filename
  return path.join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
}

async function fetchJson<T>(url: string, cacheKey: string): Promise<T | null> {
  ensureCacheDir();
  const file = cacheFilePath(cacheKey);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  }

  let data: T | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      console.error(`  [fetch] HTTP ${res.status} for ${url}`);
      return null;
    }
    data = (await res.json()) as T;
    fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
  } catch (err) {
    console.error(`  [fetch] Failed to fetch ${url}: ${(err as Error).message}`);
    return null;
  }
  return data;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function fetchCompetitions(): Promise<SBCompetition[] | null> {
  return fetchJson<SBCompetition[]>(`${BASE_URL}/competitions.json`, 'competitions');
}

export async function fetchMatches(competitionId: number, seasonId: number): Promise<SBMatch[] | null> {
  return fetchJson<SBMatch[]>(
    `${BASE_URL}/matches/${competitionId}/${seasonId}.json`,
    `matches_${competitionId}_${seasonId}`,
  );
}

export async function fetchEvents(matchId: number): Promise<SBEvent[] | null> {
  return fetchJson<SBEvent[]>(
    `${BASE_URL}/events/${matchId}.json`,
    `events_${matchId}`,
  );
}

// ── Match selection helpers ──────────────────────────────────────────────────

/**
 * Pick ~5 matches from the FIFA World Cup 2018 (competition 43 / season 3).
 * Falls back to any available competition if that season isn't present.
 */
export async function selectRepresentativeMatches(targetCount = 5): Promise<{ matches: SBMatch[]; competitionName: string; seasonName: string }> {
  const competitions = await fetchCompetitions();
  if (!competitions) {
    return { matches: [], competitionName: 'unknown', seasonName: 'unknown' };
  }

  // Prefer FIFA World Cup 2018
  const wc2018 = competitions.find(
    (c) => c.competition_id === 43 && c.season_id === 3,
  );
  const target = wc2018 ?? competitions[0];

  const matches = await fetchMatches(target.competition_id, target.season_id);
  if (!matches || matches.length === 0) {
    return { matches: [], competitionName: target.competition_name, seasonName: target.season_name };
  }

  // Sort by match_date descending (latest first) and take targetCount
  const sorted = [...matches].sort((a, b) => b.match_date.localeCompare(a.match_date));
  const selected = sorted.slice(0, targetCount);

  return {
    matches: selected,
    competitionName: target.competition_name,
    seasonName: target.season_name,
  };
}
