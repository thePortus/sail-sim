/**
 * Client mirror of the server's faction definitions (server/factions.js). The four colonial nations own towns
 * and crew NPC merchants; each has a signature colour used by the reputation readout, the minimap town markers,
 * the NPC nameplate, and the dock/trader header. Keep ids + colours in sync with the server.
 */
export interface FactionDef { id: string; name: string; color: string; }

export const FACTIONS: FactionDef[] = [
  { id: 'english', name: 'English', color: '#cc2b2b' },  // Red
  { id: 'french',  name: 'French',  color: '#2f6fd0' },  // Blue
  { id: 'spanish', name: 'Spanish', color: '#e8c33a' },  // Yellow
  { id: 'dutch',   name: 'Dutch',   color: '#e07b2a' },  // Orange
];

const byId = new Map(FACTIONS.map((f) => [f.id, f]));

export function factionDef(id?: string | null): FactionDef | null { return id ? (byId.get(id) ?? null) : null; }
export function factionColor(id?: string | null): string { return (id && byId.get(id)?.color) || '#9a9a9a'; }
export function factionName(id?: string | null): string { return (id && byId.get(id)?.name) || 'Unaligned'; }

// ── Reputation ladder ──────────────────────────────────────────────────────────
// Player standing per nation runs −100…+100 (server REP_CLAMP). The UI shows a 12-rung emotional gradation
// (Hated → Beloved) instead of a bare number; the exact value is surfaced on hover. `tone` colours the label.
export type RepTone = 'pos' | 'neg' | 'neutral';
const REP_LADDER: { min: number; label: string; tone: RepTone }[] = [
  { min:  85, label: 'Beloved',    tone: 'pos' },      // 12
  { min:  65, label: 'Honored',    tone: 'pos' },      // 11
  { min:  45, label: 'Respected',  tone: 'pos' },      // 10
  { min:  25, label: 'Liked',      tone: 'pos' },      //  9
  { min:  10, label: 'Accepted',   tone: 'pos' },      //  8
  { min:  -9, label: 'Neutral',    tone: 'neutral' },  //  7  (straddles 0)
  { min: -25, label: 'Wary',       tone: 'neg' },      //  6
  { min: -40, label: 'Disliked',   tone: 'neg' },      //  5
  { min: -55, label: 'Hostile',    tone: 'neg' },      //  4
  { min: -70, label: 'Despised',   tone: 'neg' },      //  3
  { min: -88, label: 'Loathed',    tone: 'neg' },      //  2
];
const REP_HATED: { min: number; label: string; tone: RepTone } = { min: -Infinity, label: 'Hated', tone: 'neg' };  // 1

/** Map a standing value to its gradation rung (label + tone). 12 rungs from Hated to Beloved. */
export function reputationTier(v: number): { label: string; tone: RepTone } {
  for (const t of REP_LADDER) { if (v >= t.min) { return t; } }
  return REP_HATED;
}

// ── Inter-faction relations (Diplomacy module) — mirror of server/diplomacy.js states ──
export type Relation = 'war' | 'peace' | 'alliance';
export function relationLabel(r?: string | null): string { return r === 'war' ? 'War' : r === 'alliance' ? 'Alliance' : 'Peace'; }
export function relationColor(r?: string | null): string { return r === 'war' ? '#f85149' : r === 'alliance' ? '#3fb950' : '#8a8a8a'; }
export function relationIcon(r?: string | null): string { return r === 'war' ? '⚔' : r === 'alliance' ? '⚜' : '·'; }
