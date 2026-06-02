'use strict';

const { WebSocketServer } = require('ws');
const db   = require('./models');
const User = db.User;
const { fn, col, where } = db.Sequelize;

// Above this many connected players, suppress join/leave chat announcements to
// avoid spamming a crowded harbour.
const JOIN_LEAVE_MAX_PLAYERS = 30;

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

function attachMultiplayer(server) {
  const wss = new WebSocketServer({ server });
  const players = new Map();
  let nextId = 1;

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
    if (++broadcastCooldown >= 5) {
      broadcastCooldown = 0;
      broadcastWeather();
    }
  }, 1000);

  // Push an immediate snapshot to everyone whenever an admin override / time change
  // happens, so the whole server updates at once instead of waiting for the next tick.
  weatherState.onChange(broadcastWeather);

  wss.on('connection', (ws) => {
    const id = String(nextId++);
    players.set(id, { ws, state: null, friends: [] });

    ws.send(JSON.stringify({ type: 'welcome', id }));
    ws.send(JSON.stringify(currentWaveState()));

    const existing = [];
    const nowTs = Date.now();
    for (const [pid, p] of players) {
      if (pid !== id && p.state) existing.push({ id: pid, ...p.state, ts: nowTs, seq: 0 });
    }
    if (existing.length > 0) {
      ws.send(JSON.stringify({ type: 'snapshot', players: existing }));
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'update') {
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
          vesselSlug: String(msg.vesselSlug ?? 'sloop').slice(0, 64),
          callsign:   String(msg.callsign   ?? '').slice(0, 32),
        };
        players.get(id).state = state;

        // On first callsign assignment: load friends from DB
        if (state.callsign && state.callsign !== prevCallsign) {
          // ── Single-session enforcement ──────────────────────────────────────
          // Each account (callsign) may only be live in one window. If another
          // connection already holds this callsign, kick the OLDER one — the newest
          // login wins. Prevents the "two ghost ships of the same player" bug.
          for (const [pid, p] of players) {
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

      } else if (msg.type === 'cannon_shot') {
        const shot = JSON.stringify({
          type: 'cannon_shot', id,
          ox: +msg.ox || 0, oy: +msg.oy || 0, oz: +msg.oz || 0,
          vx: +msg.vx || 0, vy: +msg.vy || 0, vz: +msg.vz || 0,
        });
        let forwarded = 0;
        for (const [pid, p] of players) {
          if (pid !== id && p.ws.readyState === 1) { p.ws.send(shot); forwarded++; }
        }
        console.log(`[WS] cannon_shot from ${id} forwarded to ${forwarded} player(s)`);

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

        } else if (text === '/reloadassets') {
          handleReloadAssets(id, senderCallsign, players);

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
      const closingCallsign = players.get(id)?.state?.callsign;
      players.delete(id);

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

module.exports = { attachMultiplayer };
