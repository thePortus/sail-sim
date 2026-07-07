'use strict';

/**
 * Squadrons (Phase B) — session-only fireteams of up to MAX_SQUADRON players who sail together. Membership
 * lets allies skip friendly fire (combat resolveHit ignores same-squadron hits) and share a private /s chat
 * channel. Everything here is IN MEMORY ONLY: a `squadrons` Map (id → squadron) owned by the multiplayer
 * layer, plus a `squadron` id and a transient `pendingInvite` on each player entry. Nothing is persisted —
 * every session everyone starts unsquadroned, matching the agreed "session-only" scope.
 *
 * A squadron is { id, leaderId, members:[playerId,…] } with the leader first. Only the leader may invite; a
 * squadron that drops below 2 members (leave / decline-to-nothing / disconnect) disbands. The lifecycle
 * messages mirror friend_toggle's shape:
 *   client→server: squadron_invite {callsign} · squadron_accept · squadron_decline · squadron_leave
 *   server→client: squadron_invited {squadronId, fromId, fromCallsign}  (prompt the invitee)
 *                  squadron_state   {squadronId, leaderId, members:[{id,callsign}]}  (roster; null = disbanded)
 *
 * Operations send directly through each entry's ws (like the rest of multiplayer.js); the pure helpers
 * (findByCallsign / roster) are exported for unit tests with stub ws objects.
 */

const { maskText } = require('./profanity');

const MAX_SQUADRON = 4;
const INVITE_TTL_MS = 60000;   // a pending invite lapses after this
let seq = 0;

function jsend(p, obj) { if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function sysReply(p, text) { jsend(p, { type: 'chat', chatType: 'system', from: '⚓ System', text }); }

/** First online (non-NPC) player entry with this callsign → [id, entry], or [null, null]. */
function findByCallsign(players, callsign) {
  for (const [pid, p] of players) if (!p.isNpc && p.state && p.state.callsign === callsign) return [pid, p];
  return [null, null];
}

/** Roster for the squadron_state broadcast: [{id, callsign}], leader first. */
function roster(players, sq) {
  return sq.members.map((mid) => ({ id: mid, callsign: players.get(mid)?.state?.callsign || '???' }));
}

/** Push the current roster to every member so all clients show the same squadron. */
function broadcastSquadron(players, sq) {
  const payload = { type: 'squadron_state', squadronId: sq.id, leaderId: sq.leaderId, members: roster(players, sq) };
  for (const mid of sq.members) jsend(players.get(mid), payload);
}

/** Tell a (now-ex) member their client should clear any squadron UI. */
function sendCleared(p) { jsend(p, { type: 'squadron_state', squadronId: null, leaderId: null, members: [] }); }

/** Chat line to every current member of a squadron. */
function squadronChat(players, sq, text, from = '⚓ System') {
  // Mask profanity per-recipient (default-on filter; raw for opt-outs). System lines are clean, so `clean===text`
  // sends the shared text to all — only a member-typed line with profanity takes the per-recipient path.
  const clean = maskText(text);
  for (const mid of sq.members) {
    const p = players.get(mid);
    if (!p) { continue; }
    const t = (clean === text || p.filterProfanity === false) ? text : clean;
    jsend(p, { type: 'chat', chatType: 'squadron', from, text: t });
  }
}

/**
 * Remove a member from their squadron and apply the disband/leadership rules. Shared by an explicit /leave
 * and a disconnect (notifyLeaver=false there, since their socket is gone). Returns the squadron's fate for
 * logging/tests: 'disbanded' | 'left' | 'none'.
 */
function removeMember(players, squadrons, memberId, notifyLeaver = true) {
  const p = players.get(memberId);
  const sqId = p && p.squadron;
  const sq = sqId && squadrons.get(sqId);
  if (p) { p.squadron = null; p.pendingInvite = null; }
  if (!sq) return 'none';
  sq.members = sq.members.filter((m) => m !== memberId);
  if (notifyLeaver && p) { sendCleared(p); sysReply(p, 'You left the squadron.'); }
  const leaverName = p?.state?.callsign || 'A captain';

  if (sq.members.length < 2) {
    // Too few to be a squadron → disband and clear the last member.
    for (const mid of sq.members) {
      const m = players.get(mid);
      if (m) m.squadron = null;
      sendCleared(m);
      sysReply(m, 'Your squadron has disbanded.');
    }
    squadrons.delete(sq.id);
    return 'disbanded';
  }
  if (sq.leaderId === memberId) sq.leaderId = sq.members[0];   // leader left → promote the senior member
  squadronChat(players, sq, `${leaverName} has left the squadron.`);
  broadcastSquadron(players, sq);
  return 'left';
}

/** squadron_invite {callsign}: the leader (or a soloist forming up) asks another captain to join. */
function invite(players, squadrons, actorId, targetCallsign, nowMs) {
  const actor = players.get(actorId);
  const myCallsign = actor?.state?.callsign;
  if (!myCallsign) return;
  const name = String(targetCallsign || '').slice(0, 32).trim();
  if (!name) { sysReply(actor, 'Usage: /squad invite "<callsign>"'); return; }
  if (name === myCallsign) { sysReply(actor, "You can't invite yourself."); return; }

  const [targetId, target] = findByCallsign(players, name);
  if (!target) { sysReply(actor, `No online captain named "${name}".`); return; }
  if (target.squadron) { sysReply(actor, `${name} is already in a squadron.`); return; }

  // Form a squadron on first invite (actor becomes leader); otherwise only the leader may invite.
  let sq = actor.squadron ? squadrons.get(actor.squadron) : null;
  if (sq) {
    if (sq.leaderId !== actorId) { sysReply(actor, 'Only the squadron leader can invite.'); return; }
    if (sq.members.length >= MAX_SQUADRON) { sysReply(actor, `Your squadron is full (${MAX_SQUADRON}).`); return; }
  } else {
    sq = { id: 'sq_' + (++seq), leaderId: actorId, members: [actorId] };
    squadrons.set(sq.id, sq);
    actor.squadron = sq.id;
    broadcastSquadron(players, sq);   // leader now sees a 1-member squadron pending the join
  }

  target.pendingInvite = { squadronId: sq.id, fromId: actorId, fromCallsign: myCallsign, expiresAt: nowMs + INVITE_TTL_MS };
  jsend(target, { type: 'squadron_invited', squadronId: sq.id, fromId: actorId, fromCallsign: myCallsign });
  sysReply(target, `${myCallsign} has invited you to their squadron. Type /squad accept (or /squad decline).`);
  sysReply(actor, `Invited ${name} to your squadron.`);
}

/** squadron_accept: the invitee joins the squadron named in their pending invite (if still valid). */
function accept(players, squadrons, actorId, nowMs) {
  const actor = players.get(actorId);
  if (!actor) return;
  const inv = actor.pendingInvite;
  if (!inv || inv.expiresAt < nowMs) { actor.pendingInvite = null; sysReply(actor, 'You have no pending squadron invite.'); return; }
  actor.pendingInvite = null;
  if (actor.squadron) { sysReply(actor, 'Leave your current squadron first (/squad leave).'); return; }
  const sq = squadrons.get(inv.squadronId);
  if (!sq) { sysReply(actor, 'That squadron no longer exists.'); return; }
  if (sq.members.length >= MAX_SQUADRON) { sysReply(actor, 'That squadron is now full.'); return; }

  sq.members.push(actorId);
  actor.squadron = sq.id;
  squadronChat(players, sq, `${actor.state?.callsign || 'A captain'} has joined the squadron.`);
  broadcastSquadron(players, sq);
}

/** squadron_decline: drop the pending invite and let the inviter know. */
function decline(players, actorId) {
  const actor = players.get(actorId);
  if (!actor) return;
  const inv = actor.pendingInvite;
  actor.pendingInvite = null;
  if (!inv) { sysReply(actor, 'You have no pending squadron invite.'); return; }
  sysReply(actor, 'Invite declined.');
  const inviter = players.get(inv.fromId);
  if (inviter) sysReply(inviter, `${actor.state?.callsign || 'A captain'} declined your squadron invite.`);
}

/** squadron_leave: leave (and possibly disband) your squadron. */
function leave(players, squadrons, actorId) {
  const actor = players.get(actorId);
  if (!actor || !actor.squadron) { sysReply(actor, "You're not in a squadron."); return; }
  removeMember(players, squadrons, actorId, true);
}

/** Disconnect cleanup — drop the player from any squadron without trying to message their dead socket. */
function handleDisconnect(players, squadrons, leavingId) {
  const p = players.get(leavingId);
  if (p && p.squadron) removeMember(players, squadrons, leavingId, false);
  // Also void any invite addressed to / sent by the departing player so no stale prompt lingers.
  for (const [, other] of players) {
    if (other.pendingInvite && (other.pendingInvite.fromId === leavingId)) other.pendingInvite = null;
  }
}

/** True if two player entries are in the same squadron (friendly-fire test). */
function sameSquadron(a, b) { return !!(a && b && a.squadron && a.squadron === b.squadron); }

/** /s chat: relay to the sender's squadron, or tell them they have none. Returns true if handled. */
function chat(players, squadrons, actorId, text) {
  const actor = players.get(actorId);
  const sq = actor && actor.squadron && squadrons.get(actor.squadron);
  if (!sq) { sysReply(actor, "You're not in a squadron — /squad invite \"<callsign>\" to start one."); return; }
  squadronChat(players, sq, text, actor.state?.callsign || 'Unknown');
}

module.exports = {
  invite, accept, decline, leave, handleDisconnect, sameSquadron, chat,
  MAX_SQUADRON, INVITE_TTL_MS,
  _test: { findByCallsign, roster, removeMember, broadcastSquadron },
};
