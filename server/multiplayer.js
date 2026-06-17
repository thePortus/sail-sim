'use strict';

const { WebSocketServer } = require('ws');
const jwt    = require('jsonwebtoken');
const config = require('./config/db.config');
const db   = require('./models');
const User = db.User;
const { fn, col, where } = db.Sequelize;

// Above this many connected players, suppress join/leave chat announcements to
// avoid spamming a crowded harbour.
const JOIN_LEAVE_MAX_PLAYERS = 30;

// When a PLAYER is sunk, this fraction of their CARGO (not gold) spills into a floating crate at the wreck —
// a real but RECOVERABLE penalty: anyone can scoop it, including the owner once they respawn and sail back.
const PLAYER_WRECK_LOOT = 0.5;

/**
 * Sailing multiplayer WebSocket server.
 *
 * Protocol (all messages are JSON):
 *
 *   Server → client on connect:
 *     { type: 'welcome',  id: string }
 *     { type: 'snapshot', players: PlayerState[] }
 *     { type: 'wave_state', windBearing, windSpeed, beaufort, t }
 *     { type: 'friend_update', myFriends: string[], mutuals: string[] }
 *
 *   Client → server (~100 ms):
 *     { type: 'update', x, z, heading, speed, sailState, vesselName, vesselSlug, callsign }
 *
 *   Server → other clients on update:
 *     { type: 'update', id, x, z, heading, speed, sailState, vesselName, vesselSlug, callsign }
 *
 *   Client → server (friend toggle):
 *     { type: 'friend_toggle', callsign: string }
 *
 *   Server → client (friend state):
 *     { type: 'friend_update', myFriends: string[], mutuals: string[] }
 *
 *   Server → all clients on weather tick (~5 s):
 *     { type: 'wave_state', windBearing, windSpeed, beaufort, t }
 *
 *   Server → all remaining on disconnect:
 *     { type: 'leave', id }
 */

// ── Server-authoritative weather state ────────────────────────────────────────
// Single source of truth shared with the admin REST controller (weather-state.js),
// so every client — and every admin override — sees identical conditions.
const weatherState = require('./weather-state');

// ── Server-authoritative ship-to-ship combat ─────────────────────────────────
const combat = require('./combat');
const movement = require('./movement');
const moveConst = require('./movement-constants');
const terrainMask = require('./terrain-mask');
const economy = require('./economy');
const npc = require('./npc');
const squadron = require('./squadron');
const salvage = require('./salvage');
const factions = require('./factions');
const diplomacy = require('./diplomacy');
const { getVesselDef, crewFor } = require('./controllers/vessels.controller');

/**
 * Split a command argument string into a target callsign and the remaining text.
 * Callsigns containing spaces must be wrapped in double quotes; an unquoted target
 * is the first whitespace-delimited token. Returns null if no target is present.
 *   '"Red Sail" hello there' → { target: 'Red Sail', rest: 'hello there' }
 *   'Solo hello there'       → { target: 'Solo',      rest: 'hello there' }
 *   '"Red Sail"'             → { target: 'Red Sail', rest: '' }
 */
function parseTargetAndRest(input) {
  const s = String(input).trim();
  if (!s) return null;
  if (s[0] === '"') {
    const end = s.indexOf('"', 1);
    if (end === -1) return null;                         // unterminated quote
    return { target: s.slice(1, end).trim(), rest: s.slice(end + 1).trim() };
  }
  const sp = s.indexOf(' ');
  if (sp === -1) return { target: s, rest: '' };
  return { target: s.slice(0, sp).trim(), rest: s.slice(sp + 1).trim() };
}

function currentWaveState() {
  return weatherState.snapshot();
}

// ── Friend helpers ────────────────────────────────────────────────────────────

/** Parse the JSON friends column safely. */
function parseFriends(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw) || []; } catch { return []; }
}

/**
 * From the in-memory players Map, compute which of `myFriends` are mutual
 * (i.e. also have `myCallsign` in THEIR in-memory friends list).
 * Only considers currently-connected players.
 */
function computeMutuals(myCallsign, myFriends, playersMap) {
  const mutuals = [];
  for (const [, p] of playersMap) {
    if (!p.state?.callsign || p.state.callsign === myCallsign) continue;
    const theirCallsign = p.state.callsign;
    if (myFriends.includes(theirCallsign) && (p.friends || []).includes(myCallsign)) {
      mutuals.push(theirCallsign);
    }
  }
  return mutuals;
}

/** Send a friend_update message to a specific WS connection. */
function sendFriendUpdate(ws, myFriends, mutuals) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'friend_update', myFriends, mutuals }));
  }
}

/** Send a system chat line to one connection (shown as ⚓ System in the client). */
function sysReply(ws, text) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'chat', chatType: 'system', from: '⚓ System', text }));
  }
}

/** True if a player entry's VERIFIED token role (from the signed JWT — unspoofable) is staff. */
function isStaff(p) { return !!(p && p.auth && (p.auth.role === 'Owner' || p.auth.role === 'Admin')); }

/** Find an open-water spot near (x,z): ring-search outward (skipping the player's own cell) for the first
 *  cell that isn't land. Returns {x,z} or null if nothing within range. Used by /teleporto to drop the
 *  admin beside a target without grounding them. (terrain-mask fails open → returns the first ring if the
 *  heightfield is unavailable, which is fine — open sea.) */
function findWaterNear(x, z, startR = 70, maxR = 1200) {
  for (let r = startR; r <= maxR; r += 40) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const wx = x + Math.cos(ang) * r, wz = z + Math.sin(ang) * r;
      if (!terrainMask.isOnLand(wx, wz)) return { x: wx, z: wz };
    }
  }
  return null;
}

/**
 * Handle a /promote or /demote chat command. The WS layer is unauthenticated, so we
 * verify the SENDER's privilege from the DB (by their callsign) rather than trusting
 * the client. Rules: sender must be Owner/Admin; the Owner's role is immutable; you
 * can't change your own role. Replies to the sender (and notifies the target if online).
 */
async function handleRoleCommand(senderId, senderCallsign, targetCallsign, newRole, players) {
  const senderEntry = players.get(senderId);
  const reply = (t) => sysReply(senderEntry?.ws, t);

  if (!targetCallsign) { reply('Usage: /promote "<callsign>"  or  /demote "<callsign>"'); return; }
  if (targetCallsign === senderCallsign) { reply('You cannot change your own role.'); return; }

  try {
    const sender = await User.findOne({ where: { callsign: senderCallsign }, attributes: ['role'] });
    const senderRole = sender?.role;
    if (senderRole !== 'Owner' && senderRole !== 'Admin') {
      reply('Only an Owner or Admin may promote or demote players.');
      return;
    }

    const target = await User.findOne({ where: { callsign: targetCallsign }, attributes: ['id', 'callsign', 'role'] });
    if (!target) { reply(`No player found with callsign "${targetCallsign}".`); return; }
    if (target.role === 'Owner') { reply("The Owner's role cannot be changed."); return; }
    if (target.role === newRole) { reply(`"${target.callsign}" is already ${newRole === 'Admin' ? 'an Admin' : 'a regular user'}.`); return; }

    await User.update({ role: newRole }, { where: { id: target.id } });

    const verb = newRole === 'Admin' ? 'promoted' : 'demoted';
    reply(`"${target.callsign}" has been ${verb} to ${newRole === 'Admin' ? 'Admin' : 'regular user'}.`);

    // Notify the target if they're online.
    for (const [, p] of players) {
      if (p.state?.callsign === target.callsign && p.ws.readyState === 1) {
        sysReply(p.ws, `You have been ${verb} to ${newRole === 'Admin' ? 'Admin' : 'a regular user'} by ${senderCallsign}.`);
        break;
      }
    }
  } catch (err) {
    reply('Could not change role (server error).');
  }
}

/**
 * Disconnect every live connection belonging to `targetCallsign` (a hard kick),
 * notifying the kicked client and removing its ghost vessel for everyone.
 */
function disconnectCallsign(targetCallsign, reason, players) {
  let kicked = 0;
  for (const [pid, p] of [...players]) {
    if (p.state?.callsign !== targetCallsign) continue;
    if (p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ type: 'kicked', reason }));
      p.ws.close(4002, 'kicked');
    }
    players.delete(pid);
    const leave = JSON.stringify({ type: 'leave', id: pid });
    for (const [, q] of players) {
      if (q.ws.readyState === 1) q.ws.send(leave);
    }
    kicked++;
  }
  return kicked;
}

/**
 * Handle /kick, /ban, /unban. Verifies the SENDER is Owner/Admin from the DB.
 * /kick disconnects the target's current session(s). /ban also sets the persistent
 * banned flag (blocks future login); /unban clears it. The Owner is immune.
 */
async function handleModCommand(senderId, senderCallsign, action, targetCallsign, players) {
  const senderEntry = players.get(senderId);
  const reply = (t) => sysReply(senderEntry?.ws, t);

  if (!targetCallsign) { reply(`Usage: /${action} "<callsign>"`); return; }
  if (targetCallsign === senderCallsign) { reply(`You cannot ${action} yourself.`); return; }

  try {
    // Authorise the SENDER from the DB (they're a logged-in real account).
    const sender = await User.findOne({ where: { callsign: senderCallsign }, attributes: ['role'] });
    if (sender?.role !== 'Owner' && sender?.role !== 'Admin') {
      reply('Only an Owner or Admin may kick or ban players.');
      return;
    }

    // Find the target by ONLINE presence first — that's the source of truth for who's
    // actually connected. A DB row may or may not exist (and the persistent ban needs
    // it), but kicking only needs the live connection.
    const isOnline = [...players.values()].some(p => p.state?.callsign === targetCallsign);
    // Case-insensitive, trimmed match so /ban and /unban resolve the same account even
    // if the admin typed different casing than the stored callsign.
    const dbTarget = await User.findOne({
      where: where(fn('LOWER', col('callsign')), targetCallsign.trim().toLowerCase()),
      attributes: ['id', 'callsign', 'role'],
    });

    if (!isOnline && !dbTarget) {
      reply(`No player found with callsign "${targetCallsign}".`);
      return;
    }
    if (dbTarget?.role === 'Owner') { reply('The Owner cannot be kicked or banned.'); return; }

    if (action === 'unban') {
      if (!dbTarget) { reply(`No account found for "${targetCallsign}" to unban.`); return; }
      const [affected] = await User.update({ banned: false }, { where: { id: dbTarget.id } });
      console.log(`[WS] /unban ${targetCallsign}: rows affected = ${affected}`);
      reply(affected
        ? `"${targetCallsign}" has been unbanned and may log in again.`
        : `"${targetCallsign}" was not banned (no change).`);
      return;
    }

    if (action === 'ban') {
      if (dbTarget) {
        await User.update({ banned: true }, { where: { id: dbTarget.id } });
      }
      const n = disconnectCallsign(targetCallsign, 'You have been banned.', players);
      if (dbTarget) {
        reply(`"${targetCallsign}" has been banned${n ? ' and disconnected' : ''}.`);
      } else {
        reply(`"${targetCallsign}" was disconnected, but no account exists to ban permanently.`);
      }
      return;
    }

    // action === 'kick'
    const n = disconnectCallsign(targetCallsign, 'You have been kicked by an administrator.', players);
    reply(n ? `"${targetCallsign}" has been kicked.` : `"${targetCallsign}" is not currently online.`);
  } catch (err) {
    console.error(`[WS] /${action} failed:`, err.message);
    reply(`Could not complete that action: ${err.message}`);
  }
}

/**
 * Handle /reloadassets. Owner/Admin only. Broadcasts a cache-bust signal to every
 * connected client so they re-fetch edited vessel GLBs (?v=<version>) and rebuild
 * remote vessels live; each client's own ship updates on its next refresh.
 */
async function handleReloadAssets(senderId, senderCallsign, players) {
  const senderEntry = players.get(senderId);
  const reply = (t) => sysReply(senderEntry?.ws, t);

  try {
    const sender = await User.findOne({ where: { callsign: senderCallsign }, attributes: ['role'] });
    if (sender?.role !== 'Owner' && sender?.role !== 'Admin') {
      reply('Only an Owner or Admin may reload assets.');
      return;
    }

    const version = Date.now();
    const signal = JSON.stringify({ type: 'reload_assets', version });
    let n = 0;
    for (const [, p] of players) {
      if (p.ws.readyState === 1) { p.ws.send(signal); n++; }
    }
    // System notice so everyone sees why vessels just re-rendered.
    const notice = JSON.stringify({
      type: 'chat', chatType: 'system', from: '⚓ System',
      text: `${senderCallsign} reloaded vessel assets.`,
    });
    for (const [, p] of players) {
      if (p.ws.readyState === 1) p.ws.send(notice);
    }
    console.log(`[WS] /reloadassets by ${senderCallsign}: v${version} → ${n} client(s)`);
  } catch (err) {
    console.error('[WS] /reloadassets failed:', err.message);
    reply(`Could not reload assets: ${err.message}`);
  }
}

/**
 * Load a player's friends from the DB by callsign, populate in-memory,
 * then send them their current friend_update (including online mutuals).
 * Also nudges any already-connected mutual friend so THEIR mutuals refresh.
 */
async function loadAndBroadcastFriends(id, callsign, playersMap) {
  try {
    const user = await User.findOne({ where: { callsign }, attributes: ['friends'] });
    const friends = parseFriends(user?.friends);

    const entry = playersMap.get(id);
    if (!entry) return;
    entry.friends = friends;

    // Send this player their friend state
    const mutuals = computeMutuals(callsign, friends, playersMap);
    sendFriendUpdate(entry.ws, friends, mutuals);

    // Any connected player whose mutual status changes because this player came online
    for (const [pid, p] of playersMap) {
      if (pid === id || !p.state?.callsign) continue;
      if ((p.friends || []).includes(callsign)) {
        const theirMutuals = computeMutuals(p.state.callsign, p.friends, playersMap);
        sendFriendUpdate(p.ws, p.friends, theirMutuals);
      }
    }
  } catch (err) {
    console.warn('[WS] loadAndBroadcastFriends error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authenticate a websocket upgrade with the same JWT the REST API uses. Browsers can't set custom
 * headers on a WebSocket, so the client passes the token as a query param: wss://host/?token=<jwt>.
 * Returns the verified identity { userId, callsign, role } or null if the token is missing/invalid/
 * expired (the caller closes the socket with a 4401 the client maps to "re-login"). The callsign +
 * role come straight from the signed token payload, so they cannot be spoofed by the client.
 */
function verifyWsToken(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) return null;
    const decoded = jwt.verify(token, config.JWT_SECRET);
    const d = decoded && decoded.data;
    if (!d || d.id == null) return null;
    return { userId: d.id, callsign: String(d.callsign ?? '').slice(0, 32), role: d.role };
  } catch {
    return null;   // bad signature / expired / malformed
  }
}

/**
 * Persist a player's AUTHORITATIVE pose to their user row. The position comes from the validated
 * movement stream (p.authPose), keyed by the verified userId — NOT from anything the client can write
 * — so a tampered client can't fake its saved location. Stamps the current MAP_VERSION so a later
 * map re-bake makes the save stale (see player-location.controller getLocation). Fire-and-forget.
 */
async function savePlayerLocation(p) {
  if (!p || !p.auth || p.auth.userId == null || !p.authPose) return;
  try {
    await User.update(
      {
        lastX: p.authPose.x, lastZ: p.authPose.z, lastHeading: p.authPose.heading,
        lastVesselSlug: (p.state && p.state.vesselSlug) || 'sloop',
        lastCallsign: String(p.auth.callsign || '').slice(0, 16) || null,
        lastMapVersion: moveConst.MAP_VERSION,
        locationSavedAt: new Date(),
      },
      { where: { id: p.auth.userId } },
    );
  } catch (err) {
    console.warn('[WS] savePlayerLocation failed:', err.message);
  }
}

// ── Town Economy: persistence + wallet/market messaging ──────────────────────
/** Safe-parse a player's tradeLedger TEXT column → array. */
function parseLedger(text) {
  if (!text) return [];
  try { const a = JSON.parse(text); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** Safe-parse the marketLedger TEXT column → { mapVersion, towns } or null. */
function parseMarketLedger(text) {
  if (!text) return null;
  try { const o = JSON.parse(text); return (o && typeof o === 'object') ? o : null; } catch { return null; }
}

/** Persist a player's purse + hold + transaction log + discovery ledger to their user row (keyed by the
 *  verified userId). Trades call this inline (money safety); the 30 s loop + disconnect call it as a backstop. */
async function saveEconomyState(p) {
  if (!p || !p.auth || p.auth.userId == null) return;
  try {
    await User.update(
      {
        gold: p.gold | 0, cargo: JSON.stringify(p.cargo || {}), tradeLedger: JSON.stringify(p.tradeLedger || []),
        marketLedger: JSON.stringify({ mapVersion: moveConst.MAP_VERSION, towns: p.ledger || {} }),
        factionRep: JSON.stringify(p.factionRep || factions.defaultRep()),
        ship: p.ship || 'pinnace',
      },
      { where: { id: p.auth.userId } },
    );
  } catch (err) {
    console.warn('[WS] saveEconomyState failed:', err.message);
  }
}

/** Safe-parse the persisted combatState TEXT column → object or null. */
function parseCombat(text) {
  if (!text) return null;
  try { const o = JSON.parse(text); return (o && typeof o === 'object') ? o : null; } catch { return null; }
}

/** Persist a player's hull damage (per-zone HP + vessel + map version) so it survives logout/restart.
 *  The mapVersion stamp makes the save stale after a map re-bake → full hull on the new map. */
async function saveCombatState(p) {
  if (!p || !p.auth || p.auth.userId == null || !p.combat) return;
  try {
    const upd = { combatState: JSON.stringify({ zones: p.combat.zones, slug: p.combat.slug, mapVersion: moveConst.MAP_VERSION }) };
    if (typeof p.crew === 'number') upd.crew = p.crew | 0;   // Crew resource persists alongside hull damage
    await User.update(upd, { where: { id: p.auth.userId } });
  } catch (err) {
    console.warn('[WS] saveCombatState failed:', err.message);
  }
}

/** Load a player's purse + hold + persistent hull damage from the DB, restore them in memory, and send the
 *  wallet + the (restored or fresh) hull state. Damage is restored UNLESS its map version is stale (new map →
 *  full hull) or the saved hull is sunk (rescue to full — never log in sunk). */
async function loadAndSendWallet(id, p, players) {
  if (!p || !p.auth || p.auth.userId == null) return;
  try {
    const u = await User.findOne({ where: { id: p.auth.userId }, attributes: ['gold', 'cargo', 'tradeLedger', 'combatState', 'marketLedger', 'factionRep', 'ship', 'crew'] });
    if (!u) return;
    p.gold = (u.gold == null) ? economy.STARTING_GOLD : (u.gold | 0);
    p.cargo = economy.parseCargo(u.cargo);
    p.tradeLedger = parseLedger(u.tradeLedger);
    // Owned vessel — map-independent. The 'update' handler forces the broadcast slug to this, so a client
    // can't sail a hull it doesn't own. capacity/physics derive from it too.
    p.ship = (u.ship && getVesselDef(u.ship)) ? u.ship : 'pinnace';
    if (p.state) p.state.vesselSlug = p.ship;

    // Crew resource — clamp the saved count to the owned vessel's complement (NULL → full). crewWound is the
    // in-memory fractional-casualty accumulator (grapeshot), never persisted (a partial wound heals on relog).
    p.maxCrew = crewFor(p.ship);
    p.crew = (u.crew == null) ? p.maxCrew : Math.max(0, Math.min(p.maxCrew, u.crew | 0));
    p.crewWound = 0;

    // Faction reputation — persists across maps (it's the player's standing, not the world's). Normalized so a
    // newly-added nation always appears at neutral.
    let rep = null; try { rep = JSON.parse(u.factionRep || 'null'); } catch { /* corrupt → neutral */ }
    p.factionRep = factions.normalizeRep(rep);

    // Discovery ledger — restore only if it belongs to the current map (else a new map starts undiscovered).
    const ml = parseMarketLedger(u.marketLedger);
    p.ledger = (ml && ml.mapVersion === moveConst.MAP_VERSION && ml.towns && typeof ml.towns === 'object') ? ml.towns : {};

    const saved = parseCombat(u.combatState);
    if (saved && saved.mapVersion === moveConst.MAP_VERSION && saved.zones) {
      const restored = combat.restoreCombatState(saved.slug || 'sloop', saved.zones);
      if (!restored.sunk) p.combat = restored;   // keep battle damage; never restore a sunk hull
    }

    sendWallet(p);
    p.ws.send(JSON.stringify({ type: 'ledger', towns: p.ledger }));   // the player's discovered-towns ledger
    // Broadcast the current hull (restored damage or fresh) so the player's HUD and everyone's listing match.
    const stateMsg = JSON.stringify({ type: 'combat_state', playerId: id, zones: p.combat.zones, maxHp: p.combat.maxHp });
    for (const [, q] of players) if (q.ws.readyState === 1) q.ws.send(stateMsg);
    broadcastCrew(id, p, players);   // everyone renders this ship's sailor count; the owner's HUD shows N/max
  } catch (err) {
    console.warn('[WS] loadAndSendWallet failed:', err.message);
  }
}

/** Crew resource (C1): the JSON every client needs to render N-of-max sailors on this ship + (for the owner)
 *  drive sail/turn/reload scaling. Broadcast to ALL on change (like combat_state) — crew changes are rare. */
function crewStateMsg(pid, p) {
  return JSON.stringify({ type: 'crew_state', playerId: pid, crew: p.crew | 0, maxCrew: p.maxCrew | 0 });
}
/** Crew-efficiency factor 0.5..1 (floor 0.5 with no crew, 1.0 fully manned). Mirrors the client's formula;
 *  scales mast-repair speed here (and sail/turn/reload client-side). NPCs (no maxCrew) → 1 (unaffected). */
function crewFactor(p) {
  const max = p && p.maxCrew | 0;
  if (!max || max <= 0) return 1;
  return 0.5 + 0.5 * Math.max(0, Math.min(1, (p.crew | 0) / max));
}
function broadcastCrew(pid, p, players) {
  const m = crewStateMsg(pid, p);
  for (const [, q] of players) if (q.ws && q.ws.readyState === 1) q.ws.send(m);
}

/** Send the player their authoritative purse + hold + current cargo capacity (from their vessel). */
function sendWallet(p) {
  if (p && p.ws.readyState === 1) {
    p.ws.send(JSON.stringify({
      type: 'wallet', gold: p.gold | 0, cargo: p.cargo || {},
      capacity: economy.capacityFor(p.ship || (p.state && p.state.vesselSlug)),
      catalog: economy.goodsCatalog(),
      factionRep: p.factionRep || factions.defaultRep(),
      ship: p.ship || 'pinnace',
    }));
  }
}

// ── Piracy reputation (Diplomacy D2) ──────────────────────────────────────────
// Attacking a nation's merchant shipping shifts the attacker's standing: you LOSE rep with that nation (more
// on a sink), lose a little with its ALLIES (you struck their friend), and GAIN rep with its WAR enemies (more
// on a sink — you're hurting their foe). Tiers scale hit→sink→capture. `factionRep` is clamped to ±REP_CLAMP.
const REP_CLAMP = 100;
// Attacking faction V's shipping: V (victim) + V's allies turn cold; V's WAR enemies — and now THEIR allies
// (enemyAlly) — warm to you. The enemy/enemyAlly gains are the deliberate "earn back your standing" lever:
// privateering against a nation's foes is a real path to rehabilitate a bad reputation with that nation.
const REP_TIERS = {
  attack:  { victim: -2,  ally: -1, enemy: +2,  enemyAlly: +1 },   // a connecting round/bar shot on a merchant
  sink:    { victim: -15, ally: -6, enemy: +12, enemyAlly: +5 },   // sending one to the bottom
  capture: { victim: -20, ally: -8, enemy: +16, enemyAlly: +7 },   // CAPTURE HOOK — a future board-and-take calls this tier
};
const clampRep = (v) => (v < -REP_CLAMP ? -REP_CLAMP : (v > REP_CLAMP ? REP_CLAMP : v));

/** Apply one piracy event's reputation shift to `shooter` for attacking faction `victimFaction`, at the given
 *  tier ('attack' | 'sink' | 'capture'). Updates standing in-memory, pushes a `reputation_changed` toast (with
 *  the per-faction deltas AND the full updated map, so the client's "Standing with the Powers" stays exact),
 *  and returns the deltas. Persistence is left to the caller (sinks persist immediately; attacks ride the 30 s
 *  autosave). Safe no-op for NPC shooters / unknown factions. Reused by the future capture feature. */
function awardPiracyRep(shooter, victimFaction, tier) {
  if (!shooter || shooter.isNpc || !factions.isFaction(victimFaction)) return null;
  const t = REP_TIERS[tier]; if (!t) return null;
  shooter.factionRep = factions.normalizeRep(shooter.factionRep);
  const rep = shooter.factionRep;
  const deltas = {};
  const bump = (fid, d) => { if (!d) return; deltas[fid] = (deltas[fid] || 0) + d; };
  bump(victimFaction, t.victim);
  const victimAllies = new Set(diplomacy.alliesOf(victimFaction));
  for (const a of victimAllies) bump(a, t.ally);
  const enemies = diplomacy.enemiesOf(victimFaction);
  for (const e of enemies) bump(e, t.enemy);
  // The allies of V's enemies also warm to you — you struck a common foe (smaller bump). Skip V itself and V's
  // own allies so the goodwill never contradicts the cold shoulder above.
  if (t.enemyAlly) {
    const enemySet = new Set(enemies);
    for (const e of enemies) {
      for (const a of diplomacy.alliesOf(e)) {
        if (a === victimFaction || victimAllies.has(a) || enemySet.has(a)) continue;
        bump(a, t.enemyAlly);
      }
    }
  }
  for (const [fid, d] of Object.entries(deltas)) rep[fid] = clampRep((rep[fid] || 0) + d);
  if (shooter.ws && shooter.ws.readyState === 1) {
    shooter.ws.send(JSON.stringify({ type: 'reputation_changed', reason: tier, deltas, factionRep: rep }));
  }
  return deltas;
}

// ── Trade reputation: relieving a town's shortage earns goodwill with its nation ──────────────────────────────
const REP_TRADE_K   = 0.7;   // goodwill per unit sold, at full scarcity (level→0)
const REP_TRADE_MAX = 8;     // cap per transaction (a fat sale can't vault your standing in one go)
// Buying a pardon at the Governor's Mansion / Mayor's House: restore NEGATIVE standing toward neutral (never
// above 0 — goodwill must be earned). Deliberately costly so it's a last resort, not a substitute for good conduct.
const PARDON_STEP          = 20;    // max points restored per petition
const PARDON_GOLD_PER_POINT = 140;  // gold per point restored (a full 20-pt petition ≈ 2 800g)

/** Award `gain` standing with `factionId` to `player` and push the live readout. Returns the delta map (or null). */
function awardFactionRep(player, factionId, gain, reason) {
  if (!player || player.isNpc || !factions.isFaction(factionId) || gain <= 0) return null;
  player.factionRep = factions.normalizeRep(player.factionRep);
  player.factionRep[factionId] = clampRep((player.factionRep[factionId] || 0) + gain);
  if (player.ws && player.ws.readyState === 1) {
    player.ws.send(JSON.stringify({ type: 'reputation_changed', reason, deltas: { [factionId]: gain }, factionRep: player.factionRep }));
  }
  return { [factionId]: gain };
}

/** Record that this player has seen a town's market (specialty + last-seen prices + day) in their discovery
 *  ledger. Driven from sendMarket → fires on trade_open AND after each trade (keeps prices fresh). */
function recordVisit(p, mk) {
  if (!p || !mk) return;
  if (!p.ledger || typeof p.ledger !== 'object') p.ledger = {};
  p.ledger[mk.townId] = {
    specialty: mk.specialty,
    day: economy.currentDay(),
    goods: mk.goods.map((g) => ({ id: g.goodId, ask: g.ask, bid: g.bid })),
  };
}

/** Send the player a town's market quote (+ their wallet so the panel can gate buttons). Also records the
 *  visit in their ledger, sends the matching ledger_entry, and attaches a demand-hint (best buyer elsewhere). */
function sendMarket(p, townId) {
  if (!p || p.ws.readyState !== 1) return;
  const mk = economy.marketFor(townId);
  if (!mk) { p.ws.send(JSON.stringify({ type: 'trade_error', reason: 'no_town' })); return; }
  recordVisit(p, mk);
  const hint = economy.hintFor(townId);
  p.ws.send(JSON.stringify({
    type: 'market_state', ...mk, hint, gold: p.gold | 0, cargo: p.cargo || {},
    capacity: economy.capacityFor(p.state && p.state.vesselSlug),
  }));
  p.ws.send(JSON.stringify({ type: 'ledger_entry', townId, ...p.ledger[townId] }));
}

function attachMultiplayer(server) {
  const wss = new WebSocketServer({ server });
  const players = new Map();
  const squadrons = new Map();   // Squadrons (Phase B): session-only fireteams, id → { id, leaderId, members:[] }
  let nextId = 1;

  // ── Movement helpers (authoritative pose application + correction/broadcast) ───────────────────
  /** Write an authoritative pose onto a player (both the stored authPose and the broadcast state). */
  const applyPose = (p, pose) => {
    p.authPose = pose;
    if (p.state) { p.state.x = pose.x; p.state.z = pose.z; p.state.heading = pose.heading; p.state.speed = pose.speed; }
  };
  /** Apply a collision-resolved pose, but never SHOVE a hull onto land — keep the velocity response
   *  while holding the old position if the pushed spot is on land. */
  const applyResolved = (p, pose) => {
    const onLand = terrainMask.isOnLand(pose.x, pose.z);
    applyPose(p, {
      x: onLand ? p.authPose.x : pose.x,
      z: onLand ? p.authPose.z : pose.z,
      heading: pose.heading,
      speed: pose.speed,
    });
  };
  /** Send a player the authoritative pose to snap to. */
  const sendCorrection = (p) => {
    if (p.ws.readyState === 1 && p.authPose) {
      p.ws.send(JSON.stringify({
        type: 'correction',
        x: p.authPose.x, z: p.authPose.z, heading: p.authPose.heading, speed: p.authPose.speed,
        seq: p.lastSeq || 0,
      }));
    }
  };
  /** Broadcast a player's current authoritative pose to everyone else (used when a ship's pose
   *  changes from a collision it didn't itself report). */
  const broadcastPose = (pid, p) => {
    if (!p.state) return;
    const m = JSON.stringify({ type: 'update', id: pid, ...p.state, npc: !!p.isNpc, ts: Date.now(), seq: p.lastSeq || 0 });
    for (const [qid, q] of players) {
      if (qid !== pid && q.ws.readyState === 1) q.ws.send(m);
    }
  };
  /** Teleport a player to a pose: set the server authority, snap their own client (correction), and broadcast
   *  the jump to everyone else. Used by the /teleport and /teleporto admin commands. Speed is zeroed on arrival;
   *  a regular target can't escape because their next update is clamped back toward this new authPose. */
  const teleportTo = (pid, p, x, z, heading) => {
    applyPose(p, { x: +x, z: +z, heading: ((+heading % 360) + 360) % 360, speed: 0 });
    sendCorrection(p);
    broadcastPose(pid, p);
  };
  /** Broadcast that an entity (player or NPC) has left so clients drop its vessel. */
  const broadcastLeave = (lid) => {
    const m = JSON.stringify({ type: 'leave', id: lid });
    for (const [, q] of players) if (q.ws.readyState === 1) q.ws.send(m);
  };
  /** Broadcast that a salvage crate is gone (collected dry or expired) so clients dispose its mesh. */
  const broadcastSalvageDespawn = (cid) => {
    const m = JSON.stringify({ type: 'salvage_despawn', id: cid });
    for (const [, q] of players) if (q.ws.readyState === 1) q.ws.send(m);
  };
  /** Push the current inter-faction relation matrix to everyone (on change) — drives the Diplomacy panel. */
  const broadcastDiplomacy = () => {
    const m = JSON.stringify({ type: 'diplomacy_state', matrix: diplomacy.matrix() });
    for (const [, q] of players) if (q.ws && q.ws.readyState === 1) q.ws.send(m);
  };
  /** Broadcast a system chat line to everyone (diplomacy announcements, etc.). */
  const broadcastSystem = (text) => {
    const m = JSON.stringify({ type: 'chat', chatType: 'system', from: '⚓ System', text });
    for (const [, q] of players) if (q.ws && q.ws.readyState === 1) q.ws.send(m);
  };

  // ── Weather: tick the shared authority at 1 Hz, broadcast every 5 s ────────────
  const broadcastWeather = () => {
    const msg = JSON.stringify(currentWaveState());
    for (const [, p] of players) {
      if (p.ws.readyState === 1) p.ws.send(msg);
    }
  };
  let broadcastCooldown = 0;
  setInterval(() => {
    weatherState.tick();
    economy.tickToToday();   // once-per-in-game-day economy drift (no-op until a day rolls over); catch-up safe
    // Inter-faction diplomacy: rare war/peace/alliance shifts on the in-game-day roll (≈1–2 game months apart),
    // rival-biased by the contested-border towns. Each shift is announced + refreshes everyone's relation matrix.
    {
      const dChanges = diplomacy.tickToDay(economy.currentDay(),
                                           diplomacy.rivalWeightsFromTowns(economy.townList()));
      if (dChanges.length) {
        broadcastDiplomacy();
        for (const c of dChanges) {
          const text = diplomacy.describeChange(c);
          broadcastSystem(text);
          const ev = JSON.stringify({ type: 'diplomacy_event', a: c.a, b: c.b, from: c.from, to: c.to, text });
          for (const [, q] of players) if (q.ws && q.ws.readyState === 1) q.ws.send(ev);
        }
      }
    }
    npc.spawnerTick(players); // keep the merchant fleet topped up (spawns at town piers)
    for (const cid of salvage.sweepExpired(Date.now())) broadcastSalvageDespawn(cid);   // drop expired crates

    // Mast self-repair: jury-rig a shot-away mast back to 50 % after 45 s. tickMastRepair arms the timer
    // when masts hit 0 and restores them on elapse; broadcast the new hull so every client updates HUD,
    // mast-raise visual, and (for the owner) the sailing penalty.
    const nowMast = Date.now();
    for (const [id, p] of players) {
      const r = combat.tickMastRepair(p.combat, nowMast, crewFactor(p));
      if (r === 'repaired') {
        const m = JSON.stringify({ type: 'combat_state', playerId: id, zones: p.combat.zones, maxHp: p.combat.maxHp });
        for (const [, q] of players) if (q.ws && q.ws.readyState === 1) q.ws.send(m);
      } else if (r === 'armed' && p.ws && p.ws.readyState === 1) {
        // Tell the OWNER how long the jury-rig will take (ms) so their HUD can show a repair progress bar.
        // Server-driven duration → when crew later makes it variable, the bar follows with no client change.
        p.ws.send(JSON.stringify({ type: 'mast_repair', ms: Math.max(0, p.combat.mastRepairUntil - nowMast) }));
      }
    }

    if (++broadcastCooldown >= 5) {
      broadcastCooldown = 0;
      broadcastWeather();
    }
  }, 1000);

  // ── NPC merchant movement (5 Hz): integrate routes + steer, then interest-managed broadcast ────
  const NPC_DT = 0.2;
  setInterval(() => {
    const now = Date.now();
    npc.tickNpcs(players, NPC_DT, broadcastLeave, now, fireNpcShot);   // integrate, despawn sunk, return fire
    npc.broadcastInterest(players, now);                  // send only the nearest few merchants to each client
  }, NPC_DT * 1000);

  // ── Authoritative location autosave (every 30 s) ──────────────────────────────
  // Persist each connected player's validated pose so they resume where they actually were. Replaces
  // the old client-initiated PUT /player-location (removed) — the server is the sole writer now.
  setInterval(() => {
    // economy save = backstop (trades persist inline); location + hull damage persist here + on disconnect.
    for (const [, p] of players) { savePlayerLocation(p); saveEconomyState(p); saveCombatState(p); }
    economy.flushState();   // town-market drift (global) — once, not per-player; no-op unless dirty
    diplomacy.flush();      // inter-faction relations (global) — no-op unless a shift happened
  }, 30000);

  // Push an immediate snapshot to everyone whenever an admin override / time change
  // happens, so the whole server updates at once instead of waiting for the next tick.
  weatherState.onChange(broadcastWeather);

  // ── Combat: "wait-and-see" shot adjudication ──────────────────────────────────
  // Each fired shot is registered here and flown over real wall-clock time by the step
  // loop below, tested against each victim's CURRENT pose. A ship that manoeuvres during
  // the ball's multi-second flight actually dodges it (unlike fire-time prediction).
  const activeShots = [];   // { shooterId, seq, ox,oy,oz, vx,vy,vz, fireTime, lastT }

  /** An NPC merchant fires (A3): relay the flight visual to every client and register the shot for the SAME
   *  wait-and-see adjudication a player's shot gets — so the merchant's ball is dodgeable exactly like a
   *  player's, and can damage/sink whatever its leading solution actually hits. */
  const fireNpcShot = (npcShip, shotData, shotType) => {
    const now = Date.now();
    const seq = (npcShip.shotSeq = (npcShip.shotSeq || 0) + 1);
    const msg = JSON.stringify({ type: 'cannon_shot', id: npcShip.id, seq, ...shotData, shotType });
    for (const [, p] of players) if (!p.isNpc && p.ws.readyState === 1) p.ws.send(msg);   // NPCs don't receive
    activeShots.push({ shooterId: npcShip.id, seq, ...shotData, shotType, fireTime: now, lastT: 0 });
  };

  /** Apply a resolved hit: damage the victim and broadcast the cosmetics / hull state. */
  const resolveHit = (shot, hit) => {
    const shooter = players.get(shot.shooterId);
    const victim  = players.get(hit.victimId);
    if (!victim || !victim.combat) return;
    if (victim.godmode) return;   // /godmode: invulnerable admin — the ball passes harmlessly, no damage or cosmetics
    if (squadron.sameSquadron(shooter, victim)) return;   // Squadrons (B2): mates' shots pass harmlessly through each other

    // ── Grapeshot (C3): anti-crew, NO hull/mast damage. Each pellet that connects attrites the victim's crew
    // (players only — NPCs carry none). Still aggros an NPC you fire grape at. Cosmetic combat_hit (grape flag)
    // shows the pellet strike; NO combat_state since the hull is untouched.
    if (shot.shotType === 'grape') {
      if (victim.isNpc && shooter && !shooter.isNpc) npc.markHostile(victim, shot.shooterId, Date.now());
      const killed = combat.applyGrapeCrew(victim);
      if (killed > 0) broadcastCrew(hit.victimId, victim, players);
      const grapeMsg = JSON.stringify({
        type: 'combat_hit', shooterId: shot.shooterId, victimId: hit.victimId, seq: shot.seq,
        zone: hit.zone, hx: hit.hx, hy: hit.hy, hz: hit.hz, side: hit.side, tof: hit.tof, grape: true,
      });
      for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(grapeMsg);
      return;
    }

    const { justSunk } = combat.applyDamage(victim.combat, hit.zone, hit.dmg);

    // NP-combat: a struck merchant turns on its attacker (timed grudge; refreshed per hit). Only a PLAYER
    // hit provokes it — collateral from another NPC's shot doesn't spark merchant-vs-merchant brawls. The
    // tactical helm + return fire that consume this state live in the NPC tick (A2–A4); here we just arm it.
    if (victim.isNpc && shooter && !shooter.isNpc) {
      npc.markHostile(victim, shot.shooterId, Date.now());
      // Piracy reputation (D2): a connecting shot on a nation's merchant dings your standing. The killing blow
      // is handled by the 'sink' tier below (don't double-charge it), so only award the 'attack' tier here.
      if (!justSunk && victim.faction) awardPiracyRep(shooter, victim.faction, 'attack');
    }

    // Cosmetics: everyone sees the splinters/fire/shudder on the struck ship.
    const hitMsg = JSON.stringify({
      type: 'combat_hit', shooterId: shot.shooterId, victimId: hit.victimId, seq: shot.seq,
      zone: hit.zone, hx: hit.hx, hy: hit.hy, hz: hit.hz, side: hit.side, tof: hit.tof,
    });
    for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(hitMsg);

    // Victim's authoritative hull state → drives their HUD diagram + everyone's listing tilt.
    const stateMsg = JSON.stringify({
      type: 'combat_state', playerId: hit.victimId, zones: victim.combat.zones,
      maxHp: victim.combat.maxHp,
    });
    for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(stateMsg);

    if (justSunk) {
      const sinker = shooter?.state?.callsign || shooter?.state?.vesselName || 'an unknown ship';
      const sunkMsg = JSON.stringify({
        type: 'combat_sunk', victimId: hit.victimId, shooterId: shot.shooterId, shooterName: sinker,
      });
      for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(sunkMsg);   // everyone sees the capsize

      if (victim.isNpc) {
        // A merchant sank → drop floating salvage (a fraction of its cargo + gold) at the wreck; the ship is
        // despawned after a short capsize-linger by the NPC tick. Anyone can sail over and collect.
        const LOOT = 0.5;
        const contents = {};
        for (const [g, q] of Object.entries(victim.cargo || {})) { const k = Math.floor((q || 0) * LOOT); if (k > 0) contents[g] = k; }
        const lootGold = Math.floor((victim.gold || 0) * LOOT);
        if (Object.keys(contents).length || lootGold > 0) {
          const crate = salvage.spawnCrate(victim.state.x, victim.state.z, contents, lootGold, Date.now());
          const spawnMsg = JSON.stringify({ type: 'salvage_spawn', id: crate.id, x: crate.x, z: crate.z });
          for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(spawnMsg);
        }
        if (shooter) sysReply(shooter.ws, `You sank the ${victim.state.vesselName || 'merchant'}! Salvage floats nearby.`);
        // Piracy reputation (D2): sinking a nation's merchant is the big standing shift — heavy loss with that
        // nation (+ its allies), a strong gain with its war-enemies. A sink is a milestone, so persist now
        // rather than waiting for the 30 s autosave. (A future capture reuses awardPiracyRep with the 'capture' tier.)
        if (shooter && !shooter.isNpc && victim.faction) {
          awardPiracyRep(shooter, victim.faction, 'sink');
          saveEconomyState(shooter);
        }
        victim.sinkAt = Date.now();   // the NPC tick removes it after the capsize plays
      } else {
        sysReply(victim.ws, `You were sunk by ${sinker}.`);
        if (shooter) sysReply(shooter.ws, `You sank ${victim.state?.callsign || 'a ship'}!`);
        // A sunk player spills a fraction of their CARGO (gold stays safe) into a floating crate at the wreck.
        // The goods leave their hold immediately (persisted), so being sunk has a real cost — but anyone can
        // scoop the crate, INCLUDING the owner once they respawn and sail back (player recovery).
        const contents = {};
        for (const [g, q] of Object.entries(victim.cargo || {})) { const k = Math.floor((q || 0) * PLAYER_WRECK_LOOT); if (k > 0) contents[g] = k; }
        if (Object.keys(contents).length) {
          for (const [g, k] of Object.entries(contents)) {
            victim.cargo[g] = (victim.cargo[g] || 0) - k;
            if (victim.cargo[g] <= 0) delete victim.cargo[g];
          }
          const crate = salvage.spawnCrate(victim.state.x, victim.state.z, contents, 0, Date.now());
          const spawnMsg = JSON.stringify({ type: 'salvage_spawn', id: crate.id, x: crate.x, z: crate.z });
          for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(spawnMsg);
          saveEconomyState(victim).then(() => sendWallet(victim));   // persist the lighter hold + refresh the owner's UI
          sysReply(victim.ws, 'Some of your cargo floats free at the wreck — sail back to recover it before others do.');
        }
      }
    }
  };

  // Step every active shot forward in real time and resolve hits / expiries (~30 Hz).
  setInterval(() => {
    if (!activeShots.length) return;
    const now = Date.now();
    for (let i = activeShots.length - 1; i >= 0; i--) {
      const s = activeShots[i];
      const tNow = (now - s.fireTime) / 1000;
      const result = combat.stepShot(s, s.lastT, tNow, players, now);
      s.lastT = tNow;
      if (result && result.victimId) {
        resolveHit(s, result);
        activeShots.splice(i, 1);
      } else if (result && result.expired) {
        activeShots.splice(i, 1);
      }
    }
  }, 33);

  wss.on('connection', (ws, req) => {
    // ── Authenticate the connection (JWT) ──────────────────────────────────────
    // No valid token → refuse with a 4401 close code. The client treats 4401 as "your session is
    // invalid" and routes to the login screen. This binds every connection to a real user, so the
    // callsign/identity used everywhere below can't be spoofed.
    const auth = verifyWsToken(req);
    if (!auth) {
      try { ws.close(4401, 'unauthorized'); } catch { /* already closing */ }
      return;
    }

    const id = String(nextId++);
    players.set(id, {
      ws, state: null, friends: [], combat: combat.newCombatState(), auth,
      gold: economy.STARTING_GOLD, cargo: {}, tradeLedger: [], ledger: {},   // Town Economy — overwritten by the DB load below
      factionRep: factions.defaultRep(),                                      // Factions reputation — overwritten by the DB load below
      ship: 'pinnace',                                                        // Ships-as-economy: owned hull — overwritten by the DB load below
      squadron: null, pendingInvite: null,                                    // Squadrons (Phase B): session-only, never persisted
      crew: 0, maxCrew: 0, crewWound: 0,                                      // Crew resource — set from the DB + vessel def in loadAndSendWallet
    });

    ws.send(JSON.stringify({ type: 'welcome', id }));
    ws.send(JSON.stringify(currentWaveState()));
    loadAndSendWallet(id, players.get(id), players);   // load purse + hold + persistent hull damage from the DB

    const existing = [];
    const nowTs = Date.now();
    for (const [pid, p] of players) {
      // NPCs are NOT in the join snapshot — they arrive via interest-managed updates once we know the
      // joiner's position (so a fresh client never builds the whole fleet at once).
      if (pid !== id && p.state && !p.isNpc) existing.push({ id: pid, ...p.state, ts: nowTs, seq: 0 });
    }
    if (existing.length > 0) {
      ws.send(JSON.stringify({ type: 'snapshot', players: existing }));
    }
    // Crew counts for everyone already aboard, so the joiner renders the right sailor count on each remote ship.
    for (const [pid, p] of players) {
      if (pid !== id && !p.isNpc && p.state && typeof p.crew === 'number') ws.send(crewStateMsg(pid, p));
    }
    // Existing floating salvage crates, so a joiner sees ones dropped before they connected.
    const crates = salvage.list().map((c) => ({ id: c.id, x: c.x, z: c.z }));
    if (crates.length) ws.send(JSON.stringify({ type: 'salvage_snapshot', crates }));
    // Current inter-faction relations, so the joiner's Diplomacy panel + standing predictions are populated.
    ws.send(JSON.stringify({ type: 'diplomacy_state', matrix: diplomacy.matrix() }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'ping') {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong', t: msg.t }));

      } else if (msg.type === 'update') {
        const prevCallsign = players.get(id)?.state?.callsign;
        const state = {
          x:          +msg.x          || 0,
          z:          +msg.z          || 0,
          heading:    +msg.heading    || 0,
          speed:      +msg.speed      || 0,
          turnRate:   +msg.turnRate   || 0,
          sheetAngle: +msg.sheetAngle || 0,
          isPortTack: !!msg.isPortTack,
          anchored:   !!msg.anchored,
          anchorSide: msg.anchorSide === 'P' ? 'P' : 'S',
          sailState:  ['reefed','topsails','full'].includes(msg.sailState) ? msg.sailState : 'full',
          vesselName: String(msg.vesselName ?? '').slice(0, 64),
          // Owned-ship authority: ignore the client's claimed hull and use the server's owned-ship record
          // (p.ship, loaded from the DB on connect), so a tampered client can't sail a vessel it hasn't
          // bought. capacity + movement physics then derive from the real hull.
          vesselSlug: (players.get(id).ship) || 'pinnace',
          // Authoritative identity from the verified JWT — a forged `msg.callsign` is ignored, so a
          // client can't impersonate another player or hijack their single-session slot.
          callsign:   players.get(id).auth.callsign,
        };
        // ── Authoritative movement validation ──────────────────────────────────
        // Validate the claimed pose against the vessel's physics relative to the LAST accepted pose.
        // Implausible claims (teleport / speed-hack) are clamped; the sender is corrected and
        // everyone else only ever sees the clamped pose. The first update has no baseline → trusted.
        {
          const p = players.get(id);
          const now = Date.now();
          const realDt = p.lastUpdateMs ? (now - p.lastUpdateMs) / 1000 : 0;
          // Owner/Admin bypass movement validation — they have a teleport ability. Role is from the
          // verified JWT (p.auth), so a regular client can't claim it.
          const trusted = p.auth.role === 'Owner' || p.auth.role === 'Admin';
          // Token-bucket dt (network-JITTER tolerance): refill the budget by real elapsed wall-clock time
          // (capped per packet at DT_MAX) up to MOVE_BURST_SEC, then validate against the WHOLE budget. So
          // when a high-ping client's updates stall then arrive BUNCHED, each bunched packet can still spend
          // a full send-interval of movement from the budget accrued during the stall — instead of seeing a
          // ~0 ms inter-arrival dt, getting clamped to nearly no travel, and rubber-banding (the bug a
          // ~300 ms-ping player hit). validateMove reports the seconds it actually consumed, debited below.
          if (p.moveDtBudget == null) p.moveDtBudget = moveConst.MOVE_BURST_SEC;
          p.moveDtBudget = Math.min(moveConst.MOVE_BURST_SEC, p.moveDtBudget + Math.min(realDt, moveConst.DT_MAX));
          const { pose, corrected, budgetSpentSec } = movement.validateMove(
            p.authPose || null,
            { x: state.x, z: state.z, heading: state.heading, speed: state.speed, vesselSlug: state.vesselSlug },
            p.moveDtBudget,
            trusted,
          );
          if (!trusted) p.moveDtBudget = Math.max(0, p.moveDtBudget - (budgetSpentSec || 0));
          p.state = state;
          p.lastUpdateMs = now;   // also drives combat victim-pose lag compensation
          p.lastSeq = Number.isFinite(+msg.seq) ? +msg.seq : 0;
          applyPose(p, pose);     // overwrite the cosmetic state with the authoritative pose
          let needCorrection = corrected;

          // ── Ship-to-ship collision (authoritative) ──────────────────────────
          // Resolve this mover against every other live hull. resolvePair is symmetric, so on contact
          // BOTH ships get pushed apart + a velocity response. The other ship changed without sending
          // an update of its own, so re-broadcast + correct it here; the mover is corrected below and
          // re-broadcast by the normal path at the end of the handler. Trusted (admin) ships skip this.
          if (!trusted) {
            const dimA = moveConst.collDims(state.vesselSlug);
            for (const [pid, q] of players) {
              if (pid === id || !q.state || !q.authPose) continue;
              if (q.combat && q.combat.sunk) continue;        // a sinking hull doesn't collide
              const res = movement.resolvePair(p.authPose, q.authPose, dimA, moveConst.collDims(q.state.vesselSlug));
              if (!res.hit) continue;
              applyResolved(p, res.a);
              applyResolved(q, res.b);
              needCorrection = true;
              broadcastPose(pid, q);
              sendCorrection(q);
            }
          }

          // Tell the sender to snap if we clamped/collided (no message in the common honest case).
          if (needCorrection) sendCorrection(p);
        }

        // Seed the combat hull to the player's actual vessel the first time we learn its slug (and
        // re-seed if they respawn in a different ship). The slug is constant per session, so this
        // fires once — a pinnace starts with its lighter HP, a sloop keeps the default.
        {
          const p = players.get(id);
          if (p.combat && p.combat.slug !== state.vesselSlug) {
            p.combat = combat.newCombatState(state.vesselSlug);
          }
        }

        // On first callsign assignment: load friends from DB
        if (state.callsign && state.callsign !== prevCallsign) {
          // ── Single-session enforcement ──────────────────────────────────────
          // Each account (callsign) may only be live in one window. If another
          // connection already holds this callsign, kick the OLDER one — the newest
          // login wins. Prevents the "two ghost ships of the same player" bug.
          for (const [pid, p] of players) {
            if (p.isNpc) continue;   // merchants never hold an account callsign
            if (pid !== id && p.state?.callsign === state.callsign) {
              if (p.ws.readyState === 1) {
                p.ws.send(JSON.stringify({
                  type: 'kicked',
                  reason: 'This account was opened in another window.',
                }));
                p.ws.close(4001, 'duplicate-login');
              }
              // Tell everyone the old vessel is gone so its ghost is removed.
              const leave = JSON.stringify({ type: 'leave', id: pid });
              for (const [, q] of players) {
                if (q.ws.readyState === 1) q.ws.send(leave);
              }
              players.delete(pid);
            }
          }
          loadAndBroadcastFriends(id, state.callsign, players);

          // Join announcement — only when the harbour isn't crowded (≤30 players),
          // to avoid spam at scale. (prevCallsign empty → this is a fresh arrival.)
          if (!prevCallsign && players.size <= JOIN_LEAVE_MAX_PLAYERS) {
            const joinMsg = JSON.stringify({
              type: 'chat', chatType: 'system', from: '⚓ System',
              text: `${state.callsign} has set sail.`,
            });
            for (const [, p] of players) {
              if (p.ws.readyState === 1) p.ws.send(joinMsg);
            }
          }
        }

        // Stamp a server-authoritative send time (ms) so receivers can interpolate
        // between snapshots on one consistent clock (avoids client clock-skew). seq is
        // the sender's monotonic counter, passed through for ordering/staleness checks.
        const broadcast = JSON.stringify({
          type: 'update', id, ...state,
          ts: Date.now(),
          seq: Number.isFinite(+msg.seq) ? +msg.seq : 0,
        });
        for (const [pid, p] of players) {
          if (pid !== id && p.ws.readyState === 1) p.ws.send(broadcast);
        }

      } else if (msg.type === 'friend_toggle') {
        const myCallsign = players.get(id)?.state?.callsign;
        if (!myCallsign) return;

        const targetCallsign = String(msg.callsign ?? '').slice(0, 32).trim();
        if (!targetCallsign || targetCallsign === myCallsign) return;

        (async () => {
          try {
            const user = await User.findOne({ where: { callsign: myCallsign }, attributes: ['id', 'friends'] });
            if (!user) return;

            const current = parseFriends(user.friends);
            const alreadyFriended = current.includes(targetCallsign);
            const updated = alreadyFriended
              ? current.filter(f => f !== targetCallsign)
              : [...current, targetCallsign];

            await User.update({ friends: JSON.stringify(updated) }, { where: { id: user.id } });

            const entry = players.get(id);
            if (!entry) return;
            entry.friends = updated;

            // Respond to requester
            const mutuals = computeMutuals(myCallsign, updated, players);
            sendFriendUpdate(entry.ws, updated, mutuals);

            // System chat confirmation
            let sysText;
            if (!alreadyFriended) {
              sysText = mutuals.includes(targetCallsign)
                ? `You are now mutual friends with ${targetCallsign}! 💛`
                : `You friended ${targetCallsign}. They need to /friend you back for it to be mutual.`;
            } else {
              sysText = `You unfriended ${targetCallsign}.`;
            }
            entry.ws.send(JSON.stringify({ type: 'chat', chatType: 'global', from: '⚓ System', text: sysText }));

            // Notify target if online — their mutuals changed
            for (const [pid, p] of players) {
              if (pid !== id && p.state?.callsign === targetCallsign && p.ws.readyState === 1) {
                const theirMutuals = computeMutuals(targetCallsign, p.friends || [], players);
                sendFriendUpdate(p.ws, p.friends || [], theirMutuals);

                if (!alreadyFriended && theirMutuals.includes(myCallsign)) {
                  p.ws.send(JSON.stringify({
                    type: 'chat', chatType: 'global', from: '⚓ System',
                    text: `${myCallsign} friended you — you are now mutual friends! 💛`,
                  }));
                }
                break;
              }
            }
          } catch (err) {
            console.warn('[WS] friend_toggle error:', err.message);
          }
        })();

      } else if (msg.type === 'squadron_invite') {
        squadron.invite(players, squadrons, id, String(msg.callsign ?? ''), Date.now());
      } else if (msg.type === 'squadron_accept') {
        squadron.accept(players, squadrons, id, Date.now());
      } else if (msg.type === 'squadron_decline') {
        squadron.decline(players, id);
      } else if (msg.type === 'squadron_leave') {
        squadron.leave(players, squadrons, id);

      } else if (msg.type === 'cannon_shot') {
        const me = players.get(id);
        const shotData = {
          ox: +msg.ox || 0, oy: +msg.oy || 0, oz: +msg.oz || 0,
          vx: +msg.vx || 0, vy: +msg.vy || 0, vz: +msg.vz || 0,
        };
        const seq = +msg.seq || 0;
        const shotType = (msg.shotType === 'bar' || msg.shotType === 'grape') ? msg.shotType : 'round';   // ammo type (default round)
        const now = Date.now();

        // ── Authority: reject implausible / spammed shots (no relay, no sim) ──────
        if (!combat.validateShot(shotData, me?.state, shotType) || !combat.allowShot(me?.combat, now, shotType)) {
          return;
        }

        // Relay the flight visual to everyone else (carries the shot seq + ammo type).
        const shot = JSON.stringify({ type: 'cannon_shot', id, seq, ...shotData, shotType });
        for (const [pid, p] of players) {
          if (pid !== id && p.ws.readyState === 1) p.ws.send(shot);
        }

        // ── Authority: register the shot for "wait-and-see" adjudication ─────────
        // The step loop flies it over real time and tests it against each victim's ACTUAL
        // evolving pose, so manoeuvring during the flight genuinely dodges it. fireTime is
        // `now` (when the muzzle data is valid); lastT tracks how far it's been tested.
        activeShots.push({ shooterId: id, seq, ...shotData, shotType, fireTime: now, lastT: 0 });

      } else if (msg.type === 'combat_reset') {
        // Dock "Repair Vessel" → restore the hull to full, for a gold fee (the first gold sink). The sunk→
        // respawn path ('respawn' below) stays FREE so a broke player isn't trapped at the bottom of the sea.
        const me = players.get(id);
        if (me && me.combat) {
          // Mercy repair: charge the fee if affordable, otherwise free — the harbourmaster never turns away
          // a broke captain. Always proceeds to a full hull. Staff (Owner/Admin) always repair gratis.
          const rep = economy.applyRepair(me, isStaff(me));
          saveEconomyState(me);   // persist the (possibly zero) gold deduction
          if (me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: 'repair_result', ok: true, gold: me.gold | 0, charged: rep.charged, mercy: rep.mercy, free: !!rep.free }));
          sendWallet(me);
          me.combat = combat.newCombatState(me.state?.vesselSlug);
          saveCombatState(me);   // persist the repaired (full) hull
          // Full hull broadcast to all: resets the victim's HUD and everyone's listing tilt.
          const stateMsg = JSON.stringify({
            type: 'combat_state', playerId: id, zones: me.combat.zones,
            maxHp: me.combat.maxHp,
          });
          for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(stateMsg);
          // Tell everyone else this ship is repaired so they clear its scorch decals.
          const repaired = JSON.stringify({ type: 'combat_repair', playerId: id });
          for (const [pid, p] of players) {
            if (pid !== id && p.ws.readyState === 1) p.ws.send(repaired);
          }
        }

      } else if (msg.type === 'respawn') {
        // A SUNK player respawns at a harbor: the client picks the nearest town and teleports there.
        // Reset the hull AND clear the authoritative pose so the next position update (the teleport) is
        // accepted as a fresh bootstrap instead of being clamped as an impossible jump. Gated on
        // actually being sunk so it can't be used as a free teleport mid-sail.
        const me = players.get(id);
        if (me && me.combat && me.combat.sunk) {
          me.combat = combat.newCombatState(me.state?.vesselSlug);
          // Crew carries over a respawn too (no free refill — recruit at a tavern to replace losses). Hull is
          // restored, but lost hands stay lost.
          me.maxCrew = crewFor(me.state?.vesselSlug); me.crew = Math.min(me.crew | 0, me.maxCrew); me.crewWound = 0;
          saveCombatState(me);  // persist the fresh hull (respawn = full repair)
          me.authPose = null;   // trust the next update — the respawn teleport
          me.moveDtBudget = moveConst.MOVE_BURST_SEC;   // fresh jitter budget so post-respawn moves aren't starved
          const stateMsg = JSON.stringify({
            type: 'combat_state', playerId: id, zones: me.combat.zones, maxHp: me.combat.maxHp,
          });
          for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(stateMsg);
          broadcastCrew(id, me, players);
          const repaired = JSON.stringify({ type: 'combat_repair', playerId: id });
          for (const [pid, p] of players) {
            if (pid !== id && p.ws.readyState === 1) p.ws.send(repaired);
          }
        }

      } else if (msg.type === 'recruit_crew') {
        // Tavern (Crew C4): hire ONE sailor. Must be docked. Charges RECRUIT_COST; if you can't afford it you
        // can still take on hands free "on commission" up to ceil(60% of complement) — so a broke captain can
        // always limp back to a fighting crew, but filling the top ~40% costs gold (keeps it a real sink).
        const me = players.get(id);
        if (me) {
          const reply = (ok, reason, charged = 0) => {
            if (me.ws.readyState === 1) me.ws.send(JSON.stringify({
              type: 'recruit_result', ok, reason: reason || null, charged,
              crew: me.crew | 0, maxCrew: me.maxCrew | 0, gold: me.gold | 0,
            }));
          };
          if (!(me.authPose && economy.townAt(me.authPose.x, me.authPose.z))) { reply(false, 'not_docked'); }
          else if ((me.crew | 0) >= (me.maxCrew | 0)) { reply(false, 'full'); }
          else {
            const cost = economy.RECRUIT_COST;
            const freeFloor = Math.ceil(0.6 * (me.maxCrew | 0));   // ≥60% complement is hireable free when broke
            let charged = 0;
            if ((me.gold | 0) >= cost) { me.gold -= cost; charged = cost; }
            else if ((me.crew | 0) < freeFloor) { charged = 0; }   // free commission hire
            else { reply(false, 'no_gold'); return; }
            me.crew = Math.min(me.maxCrew | 0, (me.crew | 0) + 1);
            saveCombatState(me);   // persist the new crew count
            saveEconomyState(me).then(() => { sendWallet(me); broadcastCrew(id, me, players); reply(true, charged === 0 ? 'free' : null, charged); });
          }
        }

      } else if (msg.type === 'listen_rumor') {
        // Tavern: overhear a rumour about a nearby treasure ship. Picks one of the THREE nearest merchants
        // that has a known run, names its vessel + origin→destination towns, and MARKS it for the player so it
        // shows on their map (merchants are otherwise hidden from non-staff). Must be docked at a port.
        const me = players.get(id);
        if (me) {
          const reply = (ok, data) => {
            if (me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: 'rumor_result', ok, ...(data || {}) }));
          };
          if (!(me.authPose && economy.townAt(me.authPose.x, me.authPose.z))) { reply(false, { reason: 'not_docked' }); }
          else {
            // Rumours only cover ships in the player's REGION (the map is 50 km across) — a tavern wouldn't
            // know a ship on the far coast. Well beyond render range (3 km) so it still reveals an unseen ship.
            const RUMOR_R2 = 14000 * 14000;
            const px = me.authPose.x, pz = me.authPose.z;
            const cand = [];
            for (const [, p] of players) {
              if (!p.isNpc || !p.state || (p.combat && p.combat.sunk)) continue;
              const destId = p.legTarget || (p.trip && p.trip.destTownId);   // where it's headed now
              const destT = destId && economy.getTown(destId);
              if (!destT) continue;                                          // need a destination to gossip about
              const dx = p.state.x - px, dz = p.state.z - pz, d2 = dx * dx + dz * dz;
              if (d2 > RUMOR_R2) continue;                                    // too far to be local gossip
              cand.push({ p, destT, d2 });
            }
            if (!cand.length) { reply(false, { reason: 'no_rumours' }); }
            else {
              cand.sort((a, b) => a.d2 - b.d2);
              const pool = cand.slice(0, 3);                                 // one of the three nearest
              const sel = pool[Math.floor(Math.random() * pool.length)];
              const np = sel.p;
              // Origin is only "known" once the ship is laden (heading to its sell town); else it's a mystery.
              const srcT = (np.phase === 'toDest' && np.trip) ? economy.getTown(np.trip.srcTownId) : null;
              me.rumorShipId = np.id;                                        // force-included in this player's interest set
              reply(true, { shipId: np.id, slug: np.state.vesselSlug, from: srcT ? srcT.name : null, to: sel.destT.name });
            }
          }
        }

      } else if (msg.type === 'trade_open') {
        // Open a town's trader: send its (static) market quote + the player's wallet. Read-only.
        const me = players.get(id);
        if (me) sendMarket(me, String(msg.townId ?? ''));

      } else if (msg.type === 'trade_buy' || msg.type === 'trade_sell') {
        // Buy/sell a good at a town. Validated server-side against the AUTHORITATIVE pose (must be docked
        // there), gold, cargo capacity, and held quantity. Atomic (no partial fills). Persist BEFORE replying
        // so the client never sees gold the server didn't durably record (money safety).
        const me = players.get(id);
        if (me) {
          const townId = String(msg.townId ?? ''), goodId = String(msg.goodId ?? '');
          // PRE-sale snapshot: selling a town one of its NEEDS (a consumed good it's short of) earns goodwill with
          // its nation. Captured before the sale (which itself relieves the shortage), scaled by how scarce it was.
          let repFid = null, scarcity = 0;
          if (msg.type === 'trade_sell') {
            const town = economy.getTown(townId);
            if (town && town.faction && factions.isFaction(town.faction)) {
              const g = (economy.marketFor(townId)?.goods || []).find((x) => x.goodId === goodId);
              if (g && g.role === 'consumed') { repFid = town.faction; scarcity = Math.max(0, 1 - (g.level ?? 1)); }
            }
          }
          const apply = msg.type === 'trade_buy' ? economy.applyBuy : economy.applySell;
          const r = apply(me, me.authPose, townId, goodId, msg.qty);
          if (r.ok) {
            if (repFid && scarcity > 0) {
              const qtySold = Math.max(0, Math.floor(Number(r.qty ?? msg.qty)) || 0);   // atomic fill → full qty on ok
              const gain = Math.min(REP_TRADE_MAX, Math.round(qtySold * scarcity * REP_TRADE_K));
              awardFactionRep(me, repFid, gain, 'trade');
            }
            saveEconomyState(me).then(() => { sendMarket(me, townId); sendWallet(me); });
          } else {
            sendWallet(me);   // authoritative correction
            if (me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: 'trade_error', reason: r.reason }));
          }
        }

      } else if (msg.type === 'petition_pardon') {
        // Buy back NEGATIVE standing with the docked town's nation at its Governor's Mansion / Mayor's House.
        // Server-authoritative: must be docked at one of that nation's towns, standing must be below neutral,
        // and you must afford the (costly) fee. Restores toward 0 only — positive standing is earned, not bought.
        const me = players.get(id);
        if (me) {
          const townId = String(msg.townId ?? '');
          const town = economy.getTown(townId);
          const fid = town && town.faction;
          const err = (reason) => { if (me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: 'pardon_error', reason })); };
          if (!(me.authPose && economy.townAt(me.authPose.x, me.authPose.z))) { err('not_docked'); }
          else if (!fid || !factions.isFaction(fid)) { err('no_faction'); }
          else {
            me.factionRep = factions.normalizeRep(me.factionRep);
            const cur = me.factionRep[fid] || 0;
            if (cur >= 0) { err('not_needed'); }   // standing already neutral-or-better — nothing to pardon
            else {
              const restore = Math.min(PARDON_STEP, -cur);                 // never above neutral
              const cost = isStaff(me) ? 0 : restore * PARDON_GOLD_PER_POINT;
              if (!isStaff(me) && (me.gold | 0) < cost) { err('no_gold'); }
              else {
                if (!isStaff(me)) me.gold = (me.gold | 0) - cost;
                me.factionRep[fid] = clampRep(cur + restore);
                saveEconomyState(me).then(() => sendWallet(me));            // persist gold + rep (money safety)
                if (me.ws.readyState === 1) {
                  me.ws.send(JSON.stringify({ type: 'reputation_changed', reason: 'pardon', deltas: { [fid]: restore }, factionRep: me.factionRep }));
                  me.ws.send(JSON.stringify({ type: 'pardon_ok', townId, faction: fid, restored: restore, cost }));
                }
              }
            }
          }
        }

      } else if (msg.type === 'ship_buy') {
        // Shipwright purchase at a port. Server-authoritative: must be docked at a town; owned ship + gold are
        // the source of truth. Buying REPLACES the current hull with a 50% trade-in credit toward the new one
        // (cost clamped ≥0 — no cash-back on a downgrade). Blocks if current cargo wouldn't fit the new hold.
        // Owners/Admins commission ANY vessel for free. Persists BEFORE replying (money safety).
        const me = players.get(id);
        if (me) {
          const slug = String(msg.slug ?? '');
          const def = getVesselDef(slug);
          const shipErr = (reason) => { if (me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: 'ship_error', reason })); };
          if (!def || def.slug !== slug) {
            shipErr('bad_ship');
          } else if (!(me.authPose && economy.townAt(me.authPose.x, me.authPose.z))) {
            shipErr('not_docked');
          } else if (me.ship === slug) {
            shipErr('already_owned');
          } else if (economy.usedSlots(me.cargo) > (def.cargo | 0)) {
            shipErr('hold_too_small');   // decision: BLOCK — sell cargo down before refitting
          } else {
            const admin = isStaff(me);
            const owned = getVesselDef(me.ship);
            const tradeIn = Math.floor((owned.price | 0) * 0.5);   // 50% of the old hull's value
            const cost = admin ? 0 : Math.max(0, (def.price | 0) - tradeIn);
            if (!admin && me.gold < cost) {
              shipErr('no_gold');
            } else {
              if (!admin) me.gold -= cost;
              me.ship = slug;
              if (me.state) me.state.vesselSlug = slug;   // the 'update' handler keeps forcing this to me.ship
              // A newly-acquired hull arrives whole AND with the new vessel's zone HP (pinnace ≠ sloop).
              me.combat = combat.newCombatState(slug);
              // Crew CARRIES OVER to the new hull (clamped to its complement) — buying a bigger ship doesn't
              // refill the crew; you must recruit at a tavern to man the extra stations.
              me.maxCrew = crewFor(slug); me.crew = Math.min(me.crew | 0, me.maxCrew); me.crewWound = 0;
              saveCombatState(me);
              const hullMsg = JSON.stringify({ type: 'combat_state', playerId: id, zones: me.combat.zones, maxHp: me.combat.maxHp });
              for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(hullMsg);
              broadcastCrew(id, me, players);
              saveEconomyState(me).then(() => {
                sendWallet(me);   // authoritative new gold + ship + capacity
                if (me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: 'ship_bought', slug, cost }));
              });
            }
          }
        }

      } else if (msg.type === 'salvage_collect') {
        // Sail-over salvage pickup. Validated: the crate exists + the player is within reach of it (authPose).
        // Awards gold (full) + goods up to free hold; overflow stays floating. Atomic (single-threaded handler).
        const me = players.get(id);
        const crate = salvage.getCrate(String(msg.crateId ?? ''));
        if (me && crate && me.authPose) {
          const dx = me.authPose.x - crate.x, dz = me.authPose.z - crate.z;
          if (dx * dx + dz * dz <= salvage.COLLECT_RADIUS_M * salvage.COLLECT_RADIUS_M) {
            const free = Math.max(0, economy.capacityFor(me.state && me.state.vesselSlug) - economy.usedSlots(me.cargo));
            const res = salvage.collect(crate, free);
            if (res.gold > 0 || res.took > 0) {
              me.gold = (me.gold | 0) + res.gold;
              for (const [g, q] of Object.entries(res.goods)) me.cargo[g] = (me.cargo[g] || 0) + q;
              saveEconomyState(me).then(() => sendWallet(me));
              if (me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: 'salvage_collected', goods: res.goods, gold: res.gold }));
            }
            if (res.empty) { salvage.remove(crate.id); broadcastSalvageDespawn(crate.id); }
          }
        }

      } else if (msg.type === 'gun_state') {
        // Relay a ship's gun run-out/stow so others see its ports + barrels animate.
        const side = msg.side === 'port' ? 'port' : 'stbd';
        const gunState = JSON.stringify({ type: 'gun_state', id, side, deploy: +msg.deploy ? 1 : 0 });
        for (const [pid, p] of players) {
          if (pid !== id && p.ws.readyState === 1) p.ws.send(gunState);
        }

      } else if (msg.type === 'chat') {
        const text = String(msg.text ?? '').slice(0, 512).trim();
        if (!text) return;

        const senderCallsign = players.get(id)?.state?.callsign ?? 'Unknown';

        if (text.startsWith('/t ')) {
          const rest = text.slice(3).trim();
          // Callsigns may contain spaces, so they can be wrapped in double quotes:
          //   /t "Red Sail" hello   →  target "Red Sail", message "hello"
          //   /t Solo hello         →  target "Solo",      message "hello"  (unquoted = first token)
          const parsed = parseTargetAndRest(rest);
          if (!parsed) return;
          const { target: targetCallsign, rest: dmText } = parsed;
          if (!dmText || !targetCallsign) return;

          const dmMsg = JSON.stringify({
            type: 'chat', chatType: 'dm',
            from: senderCallsign, to: targetCallsign, text: dmText,
          });
          for (const [, p] of players) {
            if (p.state?.callsign === targetCallsign && p.ws.readyState === 1) {
              p.ws.send(dmMsg); break;
            }
          }
          const senderEntry = players.get(id);
          if (senderEntry?.ws.readyState === 1) senderEntry.ws.send(dmMsg);

        } else if (text.startsWith('/promote ') || text.startsWith('/demote ')) {
          // /promote "Red Sail"  → make target an Admin
          // /demote  "Red Sail"  → make target a regular Viewer
          const isPromote = text.startsWith('/promote ');
          const arg       = text.slice(isPromote ? 9 : 8).trim();
          const parsed    = parseTargetAndRest(arg);
          handleRoleCommand(id, senderCallsign, parsed?.target, isPromote ? 'Admin' : 'Viewer', players);

        } else if (text.startsWith('/kick ') || text.startsWith('/ban ') || text.startsWith('/unban ')) {
          const action = text.startsWith('/kick ') ? 'kick' : text.startsWith('/ban ') ? 'ban' : 'unban';
          const arg    = text.slice(action.length + 2).trim();
          const parsed = parseTargetAndRest(arg);
          handleModCommand(id, senderCallsign, action, parsed?.target, players);

        } else if (text === '/godmode' || text.startsWith('/godmode ')) {
          // Toggle invulnerability for the calling admin (session-only; cleared on disconnect).
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may use /godmode.'); }
          else {
            me.godmode = !me.godmode;
            sysReply(me.ws, me.godmode
              ? 'Godmode ON — your hull is invulnerable to cannon fire.'
              : 'Godmode OFF — you can take damage again.');
          }

        } else if (text.startsWith('/teleporto ')) {
          // /teleporto "<player>" — teleport the calling admin to open water beside another player.
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may teleport.'); }
          else {
            const parsed = parseTargetAndRest(text.slice('/teleporto '.length).trim());
            const name = parsed?.target;
            let target = null;
            for (const [, p] of players) { if (!p.isNpc && p.state && p.state.callsign === name) { target = p; break; } }
            if (!name || !target) { sysReply(me.ws, `No online player named "${name}".`); }
            else {
              const spot = findWaterNear(target.state.x, target.state.z);
              if (!spot) { sysReply(me.ws, `Couldn't find open water near "${name}".`); }
              else {
                const heading = (Math.atan2(target.state.x - spot.x, target.state.z - spot.z) * 180 / Math.PI + 360) % 360;
                teleportTo(id, me, spot.x, spot.z, heading);
                sysReply(me.ws, `Teleported beside "${name}".`);
              }
            }
          }

        } else if (text.startsWith('/teleport ')) {
          // /teleport "<player>" <X> <Y> — teleport another player to world coords (X = east/west, Y = north/south).
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may teleport players.'); }
          else {
            const parsed = parseTargetAndRest(text.slice('/teleport '.length).trim());
            const coords = (parsed?.rest || '').trim().split(/\s+/).filter(Boolean);
            const tx = Number(coords[0]), ty = Number(coords[1]);
            if (!parsed?.target || coords.length < 2 || !Number.isFinite(tx) || !Number.isFinite(ty)) {
              sysReply(me.ws, 'Usage: /teleport "<player>" <X> <Y>   (X = east/west, Y = north/south)');
            } else {
              let target = null, targetId = null;
              for (const [pid, p] of players) { if (!p.isNpc && p.state && p.state.callsign === parsed.target) { target = p; targetId = pid; break; } }
              if (!target) { sysReply(me.ws, `No online player named "${parsed.target}".`); }
              else if (terrainMask.isOnLand(tx, ty)) { sysReply(me.ws, `(${tx.toFixed(0)}, ${ty.toFixed(0)}) is on land — pick a spot of open water.`); }
              else {
                teleportTo(targetId, target, tx, ty, target.state.heading || 0);
                sysReply(me.ws, `Teleported "${parsed.target}" to (${tx.toFixed(0)}, ${ty.toFixed(0)}).`);
                sysReply(target.ws, `You were teleported to (${tx.toFixed(0)}, ${ty.toFixed(0)}) by ${senderCallsign}.`);
              }
            }
          }

        } else if (text.startsWith('/repair ')) {
          // /repair "<player>" — fully restore another player's hull (admin courtesy). Resets their combat
          // state to a fresh hull of their owned ship, refloats them if sinking, and notifies them.
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may repair players.'); }
          else {
            const parsed = parseTargetAndRest(text.slice('/repair '.length).trim());
            const name = parsed?.target;
            let target = null, targetId = null;
            for (const [pid, p] of players) { if (!p.isNpc && p.state && p.state.callsign === name) { target = p; targetId = pid; break; } }
            if (!name || !target) { sysReply(me.ws, `No online player named "${name}".`); }
            else {
              target.combat = combat.newCombatState((target.ship) || (target.state && target.state.vesselSlug));
              saveCombatState(target);
              // Full hull → everyone's HUD/listing resets; combat_repair clears scorch decals AND (for the
              // target's own client) refloats a sinking/sunk hull. Sent to ALL incl. the target.
              const hull = JSON.stringify({ type: 'combat_state', playerId: targetId, zones: target.combat.zones, maxHp: target.combat.maxHp });
              const repaired = JSON.stringify({ type: 'combat_repair', playerId: targetId });
              for (const [, p] of players) if (p.ws.readyState === 1) { p.ws.send(hull); p.ws.send(repaired); }
              sysReply(target.ws, 'Your ship has been fully repaired by the admins.');
              sysReply(me.ws, `Repaired "${name}".`);
            }
          }

        } else if (text.startsWith('/crew ')) {
          // /crew "<player>" — fully re-crew another player's ship to its complement (admin courtesy). Mirrors
          // /repair: sets crew to maxCrew, clears any partial wound, persists, and broadcasts the new crew_state.
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may re-crew players.'); }
          else {
            const parsed = parseTargetAndRest(text.slice('/crew '.length).trim());
            const name = parsed?.target;
            let target = null, targetId = null;
            for (const [pid, p] of players) { if (!p.isNpc && p.state && p.state.callsign === name) { target = p; targetId = pid; break; } }
            if (!name || !target) { sysReply(me.ws, `No online player named "${name}".`); }
            else {
              target.maxCrew = crewFor(target.ship);   // recompute from the owned vessel in case the ship changed
              target.crew = target.maxCrew;
              target.crewWound = 0;
              saveCombatState(target);                  // persist the new crew count (same column as recruit)
              broadcastCrew(targetId, target, players); // everyone's crew HUD/scaling updates
              sysReply(target.ws, `Your crew has been brought back to full strength (${target.crew}) by the admins.`);
              sysReply(me.ws, `Re-crewed "${name}" to ${target.crew}/${target.maxCrew}.`);
            }
          }

        } else if (text.startsWith('/reputation')) {
          // /reputation "<player>"                  → clear all NEGATIVE standings to neutral (keep the good ones)
          // /reputation "<player>" <faction> <value> → set that nation's standing outright (admin override)
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may adjust reputation.'); }
          else {
            const parsed = parseTargetAndRest(text.slice('/reputation'.length).trim());
            const name = parsed?.target;
            let target = null, targetId = null;
            for (const [pid, p] of players) { if (!p.isNpc && p.state && p.state.callsign === name) { target = p; targetId = pid; break; } }
            if (!name || !target) { sysReply(me.ws, `No online player named "${name}". Usage: /reputation "<player>" [<faction> <value>]`); }
            else {
              target.factionRep = factions.normalizeRep(target.factionRep);
              const rest = (parsed.rest || '').trim();
              let note = null;
              if (!rest) {
                let cleared = 0;
                for (const fid of factions.factionIds()) { if (target.factionRep[fid] < 0) { target.factionRep[fid] = 0; cleared++; } }
                note = `Cleared ${cleared} negative standing(s) for "${name}".`;
              } else {
                const [fArg, vArg] = rest.split(/\s+/);
                const fid = String(fArg || '').toLowerCase();
                const val = Math.round(Number(vArg));
                if (!factions.isFaction(fid) || !Number.isFinite(val)) {
                  sysReply(me.ws, `Usage: /reputation "<player>" [<faction> <value>]  (factions: ${factions.factionIds().join(', ')})`);
                } else {
                  target.factionRep[fid] = clampRep(val);
                  note = `Set ${name}'s ${factions.factionName(fid)} standing to ${target.factionRep[fid]}.`;
                }
              }
              if (note) {
                saveEconomyState(target);   // persist the new rep map
                if (target.ws.readyState === 1) {
                  target.ws.send(JSON.stringify({ type: 'reputation_changed', reason: 'admin', deltas: {}, factionRep: target.factionRep }));
                }
                sysReply(me.ws, note);
              }
            }
          }

        } else if (text.startsWith('/givegold ')) {
          // /givegold "<player>" <amount> — gift gold to another player (admin). Amount is a positive integer.
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may give gold.'); }
          else {
            const parsed = parseTargetAndRest(text.slice('/givegold '.length).trim());
            const amount = Math.floor(Number((parsed?.rest || '').trim()));
            if (!parsed?.target || !Number.isFinite(amount) || amount <= 0) {
              sysReply(me.ws, 'Usage: /givegold "<player>" <amount>   (amount must be a positive number)');
            } else {
              let target = null;
              for (const [, p] of players) { if (!p.isNpc && p.state && p.state.callsign === parsed.target) { target = p; break; } }
              if (!target) { sysReply(me.ws, `No online player named "${parsed.target}".`); }
              else {
                target.gold = (target.gold | 0) + amount;
                saveEconomyState(target).then(() => sendWallet(target));   // persist BEFORE the client sees it
                sysReply(target.ws, `The admins have granted you ${amount} gold.`);
                sysReply(me.ws, `Gave ${amount} gold to "${parsed.target}" (now ${target.gold}).`);
              }
            }
          }

        } else if (text === '/diplomacy' || text.startsWith('/diplomacy ')) {
          // /diplomacy                                       → show the current relation matrix
          // /diplomacy <nationA> <nationB> <war|peace|alliance>  → force a relation (announced to all)
          // Nations: english / french / spanish / dutch (id or name; single words → no quoting needed).
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may change diplomacy.'); }
          else {
            const args = text.slice('/diplomacy'.length).trim().split(/\s+/).filter(Boolean);
            const resolveFaction = (s) => {
              const t = String(s || '').toLowerCase();
              for (const fid of factions.factionIds()) {
                if (fid === t || factions.factionName(fid).toLowerCase() === t) return fid;
              }
              return null;
            };
            if (args.length === 0) {
              sysReply(me.ws, `Diplomacy — ${diplomacy.summary()}`);
            } else if (args.length === 3) {
              const a = resolveFaction(args[0]), b = resolveFaction(args[1]), stt = args[2].toLowerCase();
              if (!a || !b) { sysReply(me.ws, 'Unknown nation. Use english / french / spanish / dutch.'); }
              else if (a === b) { sysReply(me.ws, 'A nation cannot hold relations with itself.'); }
              else if (!diplomacy.isState(stt)) { sysReply(me.ws, 'State must be war, peace, or alliance.'); }
              else {
                const c = diplomacy.setRelation(a, b, stt);
                if (!c) { sysReply(me.ws, `${factions.factionName(a)} and ${factions.factionName(b)} are already at ${stt}.`); }
                else {
                  const ann = diplomacy.describeChange(c) + ' (by decree of the admiralty)';
                  broadcastSystem(ann);
                  broadcastDiplomacy();
                  const ev = JSON.stringify({ type: 'diplomacy_event', a: c.a, b: c.b, from: c.from, to: c.to, text: ann });
                  for (const [, q] of players) if (q.ws && q.ws.readyState === 1) q.ws.send(ev);
                  diplomacy.flush(true);   // persist the decree immediately
                  sysReply(me.ws, `Set ${factions.factionName(a)} ↔ ${factions.factionName(b)} to ${stt}.`);
                }
              }
            } else {
              sysReply(me.ws, 'Usage: /diplomacy   |   /diplomacy <nationA> <nationB> <war|peace|alliance>');
            }
          }

        } else if (text === '/mast' || text.startsWith('/mast ')) {
          // /mast [hp] — set YOUR OWN masts-zone HP, for testing the dismasting arc solo (admin). No arg
          // shoots it clean away (0 → leans/slows below 60%, collapses + "furled" at 0, then the 45 s
          // jury-rig restores it to 50%). A number sets it directly (e.g. /mast 50, /mast 60). Broadcasts
          // your hull so every other client sees your mast drop/rise too.
          const me = players.get(id);
          if (!isStaff(me)) { sysReply(me?.ws, 'Only an Owner or Admin may use /mast.'); }
          else if (!me.combat) { sysReply(me.ws, 'No combat state yet — try again in a moment.'); }
          else {
            const arg = text.slice('/mast'.length).trim();
            const maxM = me.combat.maxHp.masts;
            const hp   = arg === '' ? 0 : Number(arg);
            if (!Number.isFinite(hp)) {
              sysReply(me.ws, 'Usage: /mast [hp]   (omit hp to dismast; e.g. /mast 0, /mast 50)');
            } else {
              const clamped = Math.max(0, Math.min(maxM, Math.round(hp)));
              me.combat.zones.masts  = clamped;
              me.combat.mastRepairUntil = 0;   // clear any pending jury-rig; the 1 Hz tick re-arms it if 0
              const hull = JSON.stringify({ type: 'combat_state', playerId: id, zones: me.combat.zones, maxHp: me.combat.maxHp });
              for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(hull);
              sysReply(me.ws, clamped === 0
                ? `Mast shot away (0/${maxM}) — she'll jury-rig back to ${Math.round(maxM * 0.5)} in 45 s.`
                : `Mast HP set to ${clamped}/${maxM}.`);
            }
          }

        } else if (text === '/reloadassets') {
          handleReloadAssets(id, senderCallsign, players);

        } else if (text === '/squad' || text.startsWith('/squad ')) {
          // /squad invite "<callsign>" · /squad accept · /squad decline · /squad leave — squadron lifecycle (Phase B).
          const arg  = text.slice('/squad'.length).trim();
          const m    = arg.match(/^(\S+)\s*([\s\S]*)$/);
          const sub  = (m?.[1] || '').toLowerCase();
          const rest = m?.[2] || '';
          if (sub === 'invite') {
            const tgt = parseTargetAndRest(rest)?.target || rest.trim();
            squadron.invite(players, squadrons, id, tgt, Date.now());
          } else if (sub === 'accept') {
            squadron.accept(players, squadrons, id, Date.now());
          } else if (sub === 'decline') {
            squadron.decline(players, id);
          } else if (sub === 'leave' || sub === 'disband') {
            squadron.leave(players, squadrons, id);
          } else {
            sysReply(players.get(id)?.ws, 'Usage: /squad invite "<callsign>" · /squad accept · /squad decline · /squad leave');
          }

        } else if (text === '/s' || text.startsWith('/s ')) {
          // /s <message> — talk privately to your squadron (Phase B).
          const body = text.slice(2).trim();
          if (body) squadron.chat(players, squadrons, id, body);
          else sysReply(players.get(id)?.ws, 'Usage: /s <message>   (squadron chat)');

        } else if (text.startsWith('/')) {
          // Strict command parsing: anything starting with '/' that wasn't matched
          // above (or handled client-side) is an unknown command — never broadcast it.
          sysReply(players.get(id)?.ws, `Command not recognized: ${text.split(' ')[0]}. Type /help for a list.`);

        } else {
          const globalMsg = JSON.stringify({ type: 'chat', chatType: 'global', from: senderCallsign, text });
          for (const [, p] of players) {
            if (p.ws.readyState === 1) p.ws.send(globalMsg);
          }
        }
      }
    });

    ws.on('close', () => {
      const closing = players.get(id);
      const closingCallsign = closing?.state?.callsign;
      savePlayerLocation(closing);   // persist final authoritative pose before dropping the player
      saveEconomyState(closing);     // backstop persist of purse + hold (trades already persist inline)
      saveCombatState(closing);      // persist hull damage so it survives logout/restart
      squadron.handleDisconnect(players, squadrons, id);   // Squadrons (B): drop from any squadron (disband if <2), void invites
      players.delete(id);

      // If this player was the admin holding an active weather override, clear it so a
      // pinned (possibly becalmed, windSpeed-0) sky doesn't outlive their session and
      // strand everyone who logs in next. onChange → broadcastWeather pushes the resumed
      // natural weather to all remaining clients immediately.
      if (closingCallsign) weatherState.clearOverrideForOwner(closingCallsign);

      // Notify any connected player whose mutuals changed because this player left
      if (closingCallsign) {
        for (const [, p] of players) {
          if (!p.state?.callsign || !(p.friends || []).includes(closingCallsign)) continue;
          const theirMutuals = computeMutuals(p.state.callsign, p.friends, players);
          sendFriendUpdate(p.ws, p.friends, theirMutuals);
        }
      }

      const leave = JSON.stringify({ type: 'leave', id });
      for (const [, p] of players) {
        if (p.ws.readyState === 1) p.ws.send(leave);
      }

      // Leave announcement — only when the harbour isn't crowded (≤30 players)
      // and this connection had actually picked up a callsign.
      if (closingCallsign && players.size <= JOIN_LEAVE_MAX_PLAYERS) {
        const leaveMsg = JSON.stringify({
          type: 'chat', chatType: 'system', from: '⚓ System',
          text: `${closingCallsign} has left the waters.`,
        });
        for (const [, p] of players) {
          if (p.ws.readyState === 1) p.ws.send(leaveMsg);
        }
      }
    });

    ws.on('error', () => {
      players.delete(id);
    });
  });

  console.log('Sailing multiplayer WebSocket ready');
}

module.exports = { attachMultiplayer, _test: { awardPiracyRep, REP_TIERS, REP_CLAMP } };
