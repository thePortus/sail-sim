'use strict';

const { WebSocketServer } = require('ws');
const db   = require('./models');
const User = db.User;

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

// ── Server-side weather state ─────────────────────────────────────────────────

const weather = {
  windBearing:   180 + Math.random() * 180,
  windSpeed:     6 + Math.random() * 6,
  targetBearing: 0,
  targetSpeed:   0,
  timeSec:       0,
  nextTargetSec: 30,
};
weather.targetBearing = weather.windBearing;
weather.targetSpeed   = weather.windSpeed;

function beaufortFromSpeed(speed) {
  return Math.min(8, Math.max(0, Math.floor(speed / 2.8)));
}

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

function angularDiff(target, current) {
  let diff = ((target - current) + 360) % 360;
  if (diff > 180) diff -= 360;
  return diff;
}

function weatherTick() {
  weather.timeSec++;
  if (weather.timeSec >= weather.nextTargetSec) {
    const dramatic = Math.random() < 0.10;
    if (dramatic) {
      const shift = (Math.random() - 0.5) * 240;
      weather.targetBearing = (weather.windBearing + shift + 360) % 360;
      weather.targetSpeed   = Math.max(3, Math.min(22, weather.windSpeed + (Math.random() - 0.5) * 28));
    } else {
      const shift = (Math.random() - 0.5) * 50;
      weather.targetBearing = (weather.windBearing + shift + 360) % 360;
      weather.targetSpeed   = Math.max(3, Math.min(16, weather.windSpeed + (Math.random() - 0.5) * 12));
    }
    weather.nextTargetSec = weather.timeSec + 60 + Math.random() * 90;
  }
  const bearingDiff = angularDiff(weather.targetBearing, weather.windBearing);
  const bearingStep = Math.sign(bearingDiff) * Math.min(Math.abs(bearingDiff), 1.2);
  weather.windBearing = (weather.windBearing + bearingStep + 360) % 360;
  const speedDiff = weather.targetSpeed - weather.windSpeed;
  weather.windSpeed = Math.max(2, Math.min(22,
    weather.windSpeed + Math.sign(speedDiff) * Math.min(Math.abs(speedDiff), 0.5)));
}

function currentWaveState() {
  return {
    type:        'wave_state',
    windBearing: +weather.windBearing.toFixed(2),
    windSpeed:   +weather.windSpeed.toFixed(2),
    beaufort:    beaufortFromSpeed(weather.windSpeed),
    t:           weather.timeSec,
  };
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

  // ── Weather tick (1 Hz) ───────────────────────────────────────────────────────
  let broadcastCooldown = 0;
  setInterval(() => {
    weatherTick();
    broadcastCooldown++;
    if (broadcastCooldown >= 5) {
      broadcastCooldown = 0;
      const msg = JSON.stringify(currentWaveState());
      for (const [, p] of players) {
        if (p.ws.readyState === 1) p.ws.send(msg);
      }
    }
  }, 1000);

  wss.on('connection', (ws) => {
    const id = String(nextId++);
    players.set(id, { ws, state: null, friends: [] });

    ws.send(JSON.stringify({ type: 'welcome', id }));
    ws.send(JSON.stringify(currentWaveState()));

    const existing = [];
    for (const [pid, p] of players) {
      if (pid !== id && p.state) existing.push({ id: pid, ...p.state });
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
        }

        const broadcast = JSON.stringify({ type: 'update', id, ...state });
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
          const targetCallsign = parsed?.target;
          const newRole   = isPromote ? 'Admin' : 'Viewer';
          handleRoleCommand(id, senderCallsign, targetCallsign, newRole, players);

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
    });

    ws.on('error', () => {
      players.delete(id);
    });
  });

  console.log('Sailing multiplayer WebSocket ready');
}

module.exports = { attachMultiplayer };
