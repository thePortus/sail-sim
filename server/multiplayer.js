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
 *
 *   Client → server (~100 ms):
 *     { type: 'update', x, z, heading, speed, sailState, vesselName, vesselSlug, callsign }
 *
 *   Server → other clients on update:
 *     { type: 'update', id, x, z, heading, speed, sailState, vesselName, vesselSlug, callsign }
 *
 *   Server → all remaining on disconnect:
 *     { type: 'leave', id }
 */
function attachMultiplayer(server) {
  const wss = new WebSocketServer({ server });
  const players = new Map();
  let nextId = 1;

  wss.on('connection', (ws) => {
    const id = String(nextId++);
    players.set(id, { ws, state: null });

    ws.send(JSON.stringify({ type: 'welcome', id }));

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
      if (msg.type !== 'update') return;

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
