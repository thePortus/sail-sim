'use strict';

/**
 * Faction definitions (Factions module).
 *
 * Four colonial nations own towns and crew NPC merchant ships. PLAYERS are factionless but hold per-faction
 * reputation (a later module). Each faction has a signature colour that drives the minimap town markers, the
 * dock/trader UI, and the NPC ship nameplate. Town faction (+ contested borders) is assigned at terrain-build
 * time in data/town-layout.mjs and baked into the manifest; this module is the shared source of truth for the
 * id list + colours, required by both the CommonJS server and (via default import) the ESM build pipeline.
 */

const FACTIONS = [
  { id: 'english', name: 'English', adjective: 'English', color: '#cc2b2b' },  // Red
  { id: 'french',  name: 'French',  adjective: 'French',  color: '#2f6fd0' },  // Blue
  { id: 'spanish', name: 'Spanish', adjective: 'Spanish', color: '#e8c33a' },  // Yellow
  { id: 'dutch',   name: 'Dutch',   adjective: 'Dutch',   color: '#e07b2a' },  // Orange
];

const byId = new Map(FACTIONS.map((f) => [f.id, f]));

function factionById(id) { return byId.get(id) || null; }
function factionIds() { return FACTIONS.map((f) => f.id); }
function factionColor(id) { return byId.get(id) ? byId.get(id).color : '#9a9a9a'; }
function factionName(id) { return byId.get(id) ? byId.get(id).name : 'Unaligned'; }
function isFaction(id) { return byId.has(id); }

module.exports = { FACTIONS, factionById, factionIds, factionColor, factionName, isFaction };
