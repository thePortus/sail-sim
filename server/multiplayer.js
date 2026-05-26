'use strict';

const { WebSocketServer } = require('ws');

/**
 * Sailing multiplayer WebSocket server.
 *
 * Protocol (all messages are JSON):
 *
 *   Server → client on connect:
 *     { type: 'welcome',  id: string }
 *     { type: 'snapshot', players: PlayerState[] }
 *     { type: 'wave_state', windBearing, windSpeed, beaufort, t }
 *
 *   Client → server (~100 ms):
 *     { type: 'update', x, z, heading, speed, sailState, vesselName, vesselSlug, callsign }
 *
 *   Server → other clients on update:
 *     { type: 'update', id, x, z, heading, speed, sailState, vesselName, vesselSlug, callsign }
 *
 *   Server → all clients on weather tick (~5 s):
 *     { type: 'wave_state', windBearing, windSpeed, beaufort, t }
 *
 *   Server → all remaining on disconnect:
 *     { type: 'leave', id }
 */

// ── Server-side weather state ─────────────────────────────────────────────────
// All clients receive the same wave seed so every player sees the same ocean.

const weather = {
  windBearing:   180 + Math.random() * 180,  // start somewhere in the southern half
  windSpeed:     6 + Math.random() * 6,       // 6–12 m/s (B3–B5)
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

function angularDiff(target, current) {
  let diff = ((target - current) + 360) % 360;
  if (diff > 180) diff -= 360;
  return diff;
}

function weatherTick() {
  weather.timeSec++;

  // Occasionally choose a new target wind
  if (weather.timeSec >= weather.nextTargetSec) {
    const dramatic = Math.random() < 0.10;
    if (dramatic) {
      const shift = (Math.random() - 0.5) * 240;
      weather.targetBearing = (weather.windBearing + shift + 360) % 360;
      weather.targetSpeed   = Math.max(3, Math.min(22,
        weather.windSpeed + (Math.random() - 0.5) * 28,
      ));
    } else {
      const shift = (Math.random() - 0.5) * 50;
      weather.targetBearing = (weather.windBearing + shift + 360) % 360;
      weather.targetSpeed   = Math.max(3, Math.min(16,
        weather.windSpeed + (Math.random() - 0.5) * 12,
      ));
    }
    weather.nextTargetSec = weather.timeSec + 60 + Math.random() * 90;
  }

  // Gradually move toward target (same rate limits as the old client-side service)
  const bearingDiff = angularDiff(weather.targetBearing, weather.windBearing);
  const bearingStep = Math.sign(bearingDiff) * Math.min(Math.abs(bearingDiff), 1.2);
  weather.windBearing = (weather.windBearing + bearingStep + 360) % 360;

  const speedDiff = weather.targetSpeed - weather.windSpeed;
  weather.windSpeed = Math.max(2, Math.min(22,
    weather.windSpeed + Math.sign(speedDiff) * Math.min(Math.abs(speedDiff), 0.5),
  ));
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

function attachMultiplayer(server) {
  const wss = new WebSocketServer({ server });
  const players = new Map();
  let nextId = 1;

  // ── Server-side weather tick (1 Hz) ─────────────────────────────────────────
  let broadcastCooldown = 0;
  setInterval(() => {
    weatherTick();
    broadcastCooldown++;

    // Broadcast wave state to all connected clients every 5 s
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
    players.set(id, { ws, state: null });

    ws.send(JSON.stringify({ type: 'welcome', id }));

    // Send current wave state immediately so the new client syncs up
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

        const broadcast = JSON.stringify({ type: 'update', id, ...state });
        for (const [pid, p] of players) {
          if (pid !== id && p.ws.readyState === 1) p.ws.send(broadcast);
        }

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
          // DM: /t <callsign> <message>
          const rest = text.slice(3).trim();
          const spaceIdx = rest.indexOf(' ');
          if (spaceIdx === -1) return;
          const targetCallsign = rest.slice(0, spaceIdx).trim();
          const dmText         = rest.slice(spaceIdx + 1).trim();
          if (!dmText || !targetCallsign) return;

          const dmMsg = JSON.stringify({
            type: 'chat', chatType: 'dm',
            from: senderCallsign, to: targetCallsign, text: dmText,
          });

          // Deliver to target
          for (const [, p] of players) {
            if (p.state?.callsign === targetCallsign && p.ws.readyState === 1) {
              p.ws.send(dmMsg);
              break;
            }
          }
          // Echo back to sender so they see it in their DM tab
          const senderEntry = players.get(id);
          if (senderEntry?.ws.readyState === 1) senderEntry.ws.send(dmMsg);

        } else {
          // Global broadcast
          const globalMsg = JSON.stringify({
            type: 'chat', chatType: 'global',
            from: senderCallsign, text,
          });
          for (const [, p] of players) {
            if (p.ws.readyState === 1) p.ws.send(globalMsg);
          }
        }
      }
    });

    ws.on('close', () => {
      players.delete(id);
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
