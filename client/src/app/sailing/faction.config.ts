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
