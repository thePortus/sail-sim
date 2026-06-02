import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  MeshBuilder, Color3, StandardMaterial, TransformNode,
  Mesh, Material, Scene, DynamicTexture,
} from '@babylonjs/core';
import { SceneService }  from './scene.service';
import { OceanService }  from './ocean.service';
import { WeatherService } from './weather.service';
import { VesselAssetCacheService } from './vessel-asset-cache.service';
import { VesselService } from './vessel.service';
import { SloopController } from './rigged-vessel.controller';
import { OtherPlayer, SailState, ChatMessage } from '../models';
import { Settings } from '../../app.settings';

// Single rigged vessel asset, shared with VesselService. Future ships map their slug
// to a different GLB/manifest here.
const SLOOP_GLB      = 'bermuda_sloop_rigged.glb';
const SLOOP_MANIFEST = 'bermuda_sloop_rigged.manifest.json';
function glbForSlug(_slug: string): { glb: string; manifest: string } {
  return { glb: SLOOP_GLB, manifest: SLOOP_MANIFEST };
}

// One buffered server snapshot of a remote vessel's pose, stamped with the local
// arrival time so we can render on a consistent local clock.
interface PoseSnapshot {
  x: number; z: number; heading: number; speed: number;
  turnRate: number;  // deg/s — lets dead-reckoning curve through the sender's turn
  arrived: number;   // performance.now() when received (ms)
}

// ── OtherPlayerEntry holds everything for one remote vessel ───────────────────
interface OtherPlayerEntry extends OtherPlayer {
  root:            TransformNode;
  controller:      SloopController | null;  // drives this remote's trim/sail/rudder/flag
  recoilRoll:      number;
  recoilRollVel:   number;
  anchorDeploy:    number;                  // animated 0=stowed .. 1=lowered

  // ── Movement smoothing (interpolation + dead-reckoning) ──────────────────
  // x/z/heading (from OtherPlayer) are the DISPLAYED pose, updated each frame by
  // tickRemoteMotion. The buffer holds recent server snapshots we interpolate through.
  buffer:    PoseSnapshot[];   // chronological, capped
  dispX:     number;           // smoothed display position (mirrors root)
  dispZ:     number;
  dispHeading: number;         // smoothed display heading (radians)

  // ── Buoyancy (sampled from the ocean wave field so remotes bob like the local
  // ship instead of floating rigidly). Exponentially smoothed to avoid jitter. ──
  heaveY:    number;           // smoothed vertical offset (m)
  pitchRad:  number;           // smoothed bow-up/down
  rollWaveRad: number;         // smoothed wave-induced roll (added to recoil roll)
}

@Injectable({ providedIn: 'root' })
export class MultiplayerService {
  private sceneService   = inject(SceneService);
  private oceanService   = inject(OceanService);
  private weatherService = inject(WeatherService);
  private assetCache     = inject(VesselAssetCacheService);
  private vesselService  = inject(VesselService);
  private zone           = inject(NgZone);

  otherPlayers  = signal<OtherPlayer[]>([]);
  chatMessages  = signal<ChatMessage[]>([]);
  myFriends     = signal<string[]>([]);   // callsigns I've explicitly friended
  mutualFriends = signal<string[]>([]);   // mutual (both sides friended, and online)
  // Set when the server kicks this session (same account opened in another window).
  // The game component watches this to show a notice and bail out of the session.
  kickedReason  = signal<string | null>(null);

  // Callsigns this user has muted/blocked — their chat is dropped on receipt.
  // Persisted in localStorage so the block list survives reloads.
  private static readonly BLOCK_KEY = 'ignis_blocked_callsigns';
  private blocked = new Set<string>(this.loadBlocked());

  private loadBlocked(): string[] {
    try { return JSON.parse(localStorage.getItem(MultiplayerService.BLOCK_KEY) ?? '[]'); }
    catch { return []; }
  }
  private saveBlocked(): void {
    localStorage.setItem(MultiplayerService.BLOCK_KEY, JSON.stringify([...this.blocked]));
  }
  isBlocked(callsign: string): boolean { return this.blocked.has(callsign); }
  setBlocked(callsign: string, blocked: boolean): void {
    if (blocked) this.blocked.add(callsign);
    else         this.blocked.delete(callsign);
    this.saveBlocked();
  }

  private ws:          WebSocket | null = null;
  private myId:        string   | null = null;
  private players      = new Map<string, OtherPlayerEntry>();
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  private readonly VISIBILITY_RADIUS = 15_000;
  private readonly REMOTE_DRAFT      = 0.0;  // matches VesselService FLOAT_DRAFT (model origin = waterline)
  private readonly RECOIL_SPRING     = 7.2;
  private readonly RECOIL_DAMPING    = 5.8;
  private readonly RECOIL_IMPULSE    = 0.46;   // rad/s
  private readonly RECOIL_MAX_ROLL   = 0.12;   // ~6.9° cap

  // ── Remote movement smoothing ──────────────────────────────────────────────
  // We render remote vessels this many ms BEHIND the newest snapshot, so there's
  // almost always a newer snapshot to interpolate toward (eliminates the per-update
  // teleport). ~2 updates of slack at the 10 Hz (100 ms) send rate.
  private readonly INTERP_DELAY_MS = 110;
  // Beyond this gap with no new snapshot we DEAD-RECKON (extrapolate) instead of
  // freezing — covers a lagging/stalled sender — capped so a vanished player doesn't
  // sail off to infinity.
  private readonly EXTRAPOLATE_MAX_MS = 1000;
  private readonly BUFFER_MAX = 12;
  // Per-frame reconciliation rate: how fast the displayed pose eases toward the
  // interpolation/extrapolation target (higher = snappier, lower = smoother).
  private readonly RECONCILE = 0.25;
  // Must match the server world-distance multiplier (vessel.service TRAVEL_SCALE) so
  // dead-reckoning projects forward at the same rate positions actually move.
  private readonly TRAVEL_SCALE = 5.0;

  private recoilTickFn: (() => void) | null = null;

  // Label plane dimensions in world units
  private readonly LABEL_WIDTH  = 12;
  private readonly LABEL_HEIGHT = 1.8;
  private readonly LABEL_Y      = 9;

  // ── Cannon shot callbacks ─────────────────────────────────────────────────
  onRemoteShot: ((ox: number, oy: number, oz: number,
                  vx: number, vy: number, vz: number) => void) | null = null;

  broadcastShot(ox: number, oy: number, oz: number,
                vx: number, vy: number, vz: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'cannon_shot', ox, oy, oz, vx, vy, vz }));
  }

  /** Broadcast a gun-deploy change so other players see this ship's ports/run-out.
   *  deploy: 1 = arming/ready (ports open, gun out), 0 = stowing/reloaded (ports shut). */
  broadcastGunState(side: 'port' | 'stbd', deploy: 0 | 1): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'gun_state', side, deploy }));
  }

  sendChat(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Intercept /friend command — handled via dedicated WS message, not chat.
    // Strip surrounding double-quotes so /friend "Red Sail" works for spaced names.
    if (text.startsWith('/friend ')) {
      let target = text.slice(8).trim();
      const m = target.match(/^"([^"]+)"/);
      if (m) target = m[1].trim();
      if (target) this.ws.send(JSON.stringify({ type: 'friend_toggle', callsign: target }));
      return;
    }
    this.ws.send(JSON.stringify({ type: 'chat', text }));
  }

  toggleFriend(callsign: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'friend_toggle', callsign }));
  }

  // Current local state — kept updated by updateLocalState()
  private localState: Omit<OtherPlayer, 'id'> = {
    x: 0, z: 0, heading: 0, speed: 0, turnRate: 0, sheetAngle: 30, isPortTack: false,
    sailState: 'full', vesselName: 'Sloop', vesselSlug: 'sloop', callsign: 'Sailor',
  };

  // ── Connection ────────────────────────────────────────────────────────────

  connect(callsign: string): void {
    this.localState.callsign = callsign;
    this.kickedReason.set(null);   // clear any stale kick from a previous session

    // Recoil animation tick — runs every render frame while connected
    const scene = this.sceneService.scene;
    if (scene) {
      this.recoilTickFn = () => {
        const dt = Math.min(scene.getEngine().getDeltaTime() * 0.001, 0.05);
        const renderAt = performance.now() - this.INTERP_DELAY_MS;
        for (const entry of this.players.values()) {
          this.tickRemoteMotion(entry, renderAt, dt);
          this.tickRecoil(entry, dt);
        }
      };
      scene.registerBeforeRender(this.recoilTickFn);
    }

    const url = Settings.wsUrl;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.updateTimer = setInterval(() => this.sendUpdate(), 100);
    });

    this.ws.addEventListener('message', (evt) => {
      let msg: any;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this.zone.run(() => this.handleMessage(msg));
    });

    this.ws.addEventListener('close', () => {
      if (this.updateTimer) clearInterval(this.updateTimer);
    });
  }

  updateLocalState(
    x: number, z: number, heading: number, speed: number,
    sailState: SailState, vesselName: string, vesselSlug: string,
    turnRate = 0, sheetAngle = 30, isPortTack = false,
    anchored = false, anchorSide: 'S' | 'P' = 'S',
  ): void {
    Object.assign(this.localState, { x, z, heading, speed, turnRate, sheetAngle, isPortTack, anchored, anchorSide, sailState, vesselName, vesselSlug });
    if (this.sceneService.scene) this.refreshAllVisibility();
  }

  disconnect(): void {
    if (this.updateTimer) clearInterval(this.updateTimer);
    if (this.recoilTickFn) {
      this.sceneService.scene?.unregisterBeforeRender(this.recoilTickFn);
      this.recoilTickFn = null;
    }
    this.ws?.close();
    for (const entry of this.players.values()) this.disposeEntry(entry);
    this.players.clear();
    this.otherPlayers.set([]);
    this.myFriends.set([]);
    this.mutualFriends.set([]);
  }

  // ── WebSocket protocol ────────────────────────────────────────────────────

  private sendSeq = 0;
  private sendUpdate(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'update', ...this.localState, seq: ++this.sendSeq }));
  }

  private handleMessage(msg: any): void {
    const { scene } = this.sceneService;
    if (!scene) return;

    if (msg.type === 'welcome') {
      this.myId = msg.id;

    } else if (msg.type === 'snapshot') {
      for (const p of msg.players) this.addOrUpdatePlayer(p, scene);

    } else if (msg.type === 'update') {
      if (msg.id === this.myId) return;
      this.addOrUpdatePlayer(msg, scene);

    } else if (msg.type === 'leave') {
      this.removePlayer(msg.id);

    } else if (msg.type === 'wave_state') {
      this.weatherService.receiveServerState(msg);

    } else if (msg.type === 'cannon_shot') {
      if (msg.id === this.myId) return;
      this.onRemoteShot?.(+msg.ox, +msg.oy, +msg.oz, +msg.vx, +msg.vy, +msg.vz);

    } else if (msg.type === 'gun_state') {
      if (msg.id === this.myId) return;
      const entry = this.players.get(msg.id);
      const side = msg.side === 'port' ? 'P' : 'S';   // game port → model 'P' (matches local)
      entry?.controller?.setGunDeployTarget(side, +msg.deploy ? 1 : 0);

    } else if (msg.type === 'friend_update') {
      this.myFriends.set(Array.isArray(msg.myFriends) ? msg.myFriends.map(String) : []);
      this.mutualFriends.set(Array.isArray(msg.mutuals) ? msg.mutuals.map(String) : []);

    } else if (msg.type === 'reload_assets') {
      // Bust the cache + rebuild remotes, then live-reload the local player's own ship
      // (reloadRemoteVessels already set the cache version, so this fetches the fresh GLB).
      this.reloadRemoteVessels(+msg.version || 0, scene);
      this.vesselService.reloadModel().catch((e) => console.warn('[MP] local model reload failed', e));

    } else if (msg.type === 'kicked') {
      // Server closed this session because the same account logged in elsewhere.
      this.kickedReason.set(String(msg.reason ?? 'This account was opened in another window.'));

    } else if (msg.type === 'chat') {
      // Drop messages from blocked players (but never drop system messages).
      if (msg.chatType !== 'system' && this.blocked.has(String(msg.from ?? ''))) return;
      const chatMsg: ChatMessage = {
        id:        `${Date.now()}-${Math.random()}`,
        from:      String(msg.from ?? ''),
        to:        msg.to ? String(msg.to) : undefined,
        text:      String(msg.text ?? ''),
        timestamp: new Date(),
        chatType:  msg.chatType === 'dm' ? 'dm' : 'global',
      };
      this.chatMessages.update(msgs => [...msgs.slice(-199), chatMsg]);
    }
  }

  // ── Player lifecycle ──────────────────────────────────────────────────────

  private addOrUpdatePlayer(data: any, scene: Scene): void {
    let entry = this.players.get(data.id);

    const sx = +data.x || 0;
    const sz = +data.z || 0;
    const sHeading = +data.heading || 0;
    const sSpeed   = +data.speed   || 0;
    const isNew    = !entry;

    if (!entry) {
      const root = new TransformNode('player_' + data.id, scene);
      root.position.y = this.REMOTE_DRAFT;

      entry = {
        root,
        controller:      null,
        recoilRoll:      0,
        recoilRollVel:   0,
        anchorDeploy:    0,
        id:         data.id,
        x:          sx, z: sz, heading: sHeading, speed: sSpeed,
        sailState:  'full',
        vesselName: 'Sloop', vesselSlug: 'sloop',
        callsign:   String(data.callsign ?? ''),
        buffer:      [],
        dispX:       sx,
        dispZ:       sz,
        dispHeading: sHeading * Math.PI / 180,
        heaveY:      this.REMOTE_DRAFT,   // seed near the waterline (avoids spawn rise from y=0)
        pitchRad:    0,
        rollWaveRad: 0,
      };
      this.players.set(data.id, entry);

      const callsign = String(data.callsign ?? '').slice(0, 32);
      const slug     = String(data.vesselSlug ?? 'sloop').slice(0, 64);
      this.buildPlayerVessel(data.id, slug, callsign, entry, scene)
        .catch(err => console.warn('Multiplayer mesh build failed:', err));
    }

    // Latest server-known target (used by recoil aim, visibility, labels).
    entry.x         = sx;
    entry.z         = sz;
    entry.heading   = sHeading;
    entry.speed     = sSpeed;
    entry.sailState = (['reefed','topsails','full'] as SailState[]).includes(data.sailState)
      ? data.sailState : 'full';
    entry.callsign   = String(data.callsign   ?? '').slice(0, 32);
    entry.vesselName = String(data.vesselName ?? 'Sloop').slice(0, 64);
    entry.vesselSlug = String(data.vesselSlug ?? 'sloop').slice(0, 64);
    entry.sheetAngle = +data.sheetAngle || 0;
    entry.isPortTack = !!data.isPortTack;
    entry.anchored   = !!data.anchored;
    entry.anchorSide = data.anchorSide === 'P' ? 'P' : 'S';

    // Update sail furl + boom trim to match the remote player's current state.
    entry.controller?.applySailState(entry.sailState);
    this.applyRemoteTrim(entry);

    // Buffer this snapshot for interpolation (don't snap the mesh — tickRemoteMotion
    // eases the displayed pose toward the buffer each frame).
    entry.buffer.push({ x: sx, z: sz, heading: sHeading, speed: sSpeed, turnRate: +data.turnRate || 0, arrived: performance.now() });
    if (entry.buffer.length > this.BUFFER_MAX) entry.buffer.shift();

    if (isNew) {
      // First sighting: place the mesh immediately so it doesn't ease in from (0,0).
      entry.dispX = sx; entry.dispZ = sz; entry.dispHeading = sHeading * Math.PI / 180;
      entry.root.position.set(sx, this.REMOTE_DRAFT, sz);
      entry.root.rotation.y = entry.dispHeading;
    }

    this.applyVisibility(entry);
    this.publishSignal();
  }

  private removePlayer(id: string): void {
    const entry = this.players.get(id);
    if (!entry) return;
    this.disposeEntry(entry);
    this.players.delete(id);
    this.publishSignal();
  }

  /**
   * Admin /reloadassets: bust the asset cache (in-memory containers + browser via
   * ?v=version) and rebuild every remote vessel from its current pose so edited GLBs
   * appear live. The local player's own ship picks up the new geometry on next refresh.
   */
  private reloadRemoteVessels(version: number, scene: Scene): void {
    this.assetCache.setVersion(version);
    this.assetCache.clearCache();

    // Snapshot identity + last-known pose before tearing the entries down. The entry
    // IS an OtherPlayer superset, so a shallow copy is a valid addOrUpdatePlayer input.
    const snapshots = Array.from(this.players.values()).map((e) => ({
      id: e.id, x: e.x, z: e.z, heading: e.heading, speed: e.speed,
      turnRate: e.turnRate, sheetAngle: e.sheetAngle, isPortTack: e.isPortTack,
      anchored: e.anchored, anchorSide: e.anchorSide,
      sailState: e.sailState, vesselName: e.vesselName,
      vesselSlug: e.vesselSlug, callsign: e.callsign,
    }));

    for (const entry of this.players.values()) this.disposeEntry(entry);
    this.players.clear();

    for (const snap of snapshots) this.addOrUpdatePlayer(snap, scene);
    this.publishSignal();
  }

  private disposeEntry(entry: OtherPlayerEntry): void {
    entry.controller?.dispose();
    entry.controller = null;
    // Unregister from the ocean reflection list before disposing so stale meshes don't
    // pile up in the RTT across many join/leaves.
    entry.root.getChildMeshes(false).forEach(m => {
      this.oceanService.removeFromRenderList(m);
      (m as Mesh).dispose(false, true);
    });
    entry.root.getChildTransformNodes(false).forEach(n => n.dispose());
    entry.root.dispose();
  }

  private publishSignal(): void {
    this.otherPlayers.set(
      Array.from(this.players.values()).map(
        ({ root: _r, controller: _c, recoilRoll: _rr, recoilRollVel: _rv, anchorDeploy: _ad, ...p }) => p as OtherPlayer,
      ),
    );
  }

  // ── Remote cannon recoil ──────────────────────────────────────────────────

  /** Called by CannonService when a remote shot is received.
   *  Finds the firing vessel by proximity to the muzzle position and starts its recoil. */
  applyRemoteRecoil(wx: number, wz: number): void {
    let closest: OtherPlayerEntry | null = null;
    let minDist2 = Infinity;
    for (const entry of this.players.values()) {
      const dx = entry.x - wx;
      const dz = entry.z - wz;
      const d2 = dx * dx + dz * dz;
      if (d2 < minDist2) { minDist2 = d2; closest = entry; }
    }
    // Only apply if the nearest vessel is within ~50 world units of the muzzle tip
    if (closest && minDist2 < 2500) {
      const hr = closest.heading * Math.PI / 180;
      const dx = wx - closest.x;
      const dz = wz - closest.z;
      const localX = dx * Math.cos(hr) - dz * Math.sin(hr);
      const firedSide: 'port' | 'stbd' = localX < 0 ? 'port' : 'stbd';
      const dir = firedSide === 'port' ? 1 : -1;
      closest.recoilRollVel += dir * this.RECOIL_IMPULSE;
      // Kick the firing side's gun barrels too (game port → model 'P', matches local).
      closest.controller?.addGunRecoil(firedSide === 'port' ? 'P' : 'S');
    }
  }

  /** Shortest-arc difference a→b for angles in radians. */
  private angleDelta(a: number, b: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d >  Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /**
   * Per-frame remote-vessel motion: interpolate the displayed pose through the buffered
   * server snapshots at a fixed render delay; dead-reckon (extrapolate along heading at
   * the last speed) when no newer snapshot has arrived; then ease the actual mesh toward
   * that target so corrections (e.g. a lagged player snapping back) are smooth, not jumpy.
   */
  private tickRemoteMotion(entry: OtherPlayerEntry, renderAt: number, dt: number): void {
    const buf = entry.buffer;
    if (buf.length === 0) return;

    let tx: number, tz: number, tHeading: number;   // target pose this frame

    const newest = buf[buf.length - 1];
    if (renderAt <= buf[0].arrived) {
      // Render time is older than everything buffered — show the oldest.
      tx = buf[0].x; tz = buf[0].z; tHeading = buf[0].heading * Math.PI / 180;
    } else if (renderAt >= newest.arrived) {
      // No snapshot newer than the render cursor → DEAD-RECKON forward from the newest.
      // Integrate the sender's turn rate so the projected path CURVES through their turn
      // (Stage C) instead of shooting off straight. Sub-stepped for arc accuracy; capped
      // so a disconnected vessel doesn't coast forever.
      const ahead = Math.min(renderAt - newest.arrived, this.EXTRAPOLATE_MAX_MS) / 1000;
      const turnRad = (newest.turnRate || 0) * Math.PI / 180;   // rad/s
      const vWorld  = newest.speed * this.TRAVEL_SCALE;
      const steps = 6;
      const h0 = newest.heading * Math.PI / 180;
      let px = newest.x, pz = newest.z, ph = h0;
      const sdt = ahead / steps;
      for (let i = 0; i < steps; i++) {
        ph += turnRad * sdt;
        px += Math.sin(ph) * vWorld * sdt;
        pz += Math.cos(ph) * vWorld * sdt;
      }
      tx = px; tz = pz; tHeading = ph;
    } else {
      // Interpolate between the two snapshots straddling the render cursor.
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].arrived <= renderAt && buf[i + 1].arrived >= renderAt) { a = buf[i]; b = buf[i + 1]; break; }
      }
      const span = Math.max(1, b.arrived - a.arrived);
      const f    = Math.min(1, Math.max(0, (renderAt - a.arrived) / span));
      tx = a.x + (b.x - a.x) * f;
      tz = a.z + (b.z - a.z) * f;
      const ah = a.heading * Math.PI / 180;
      tHeading = ah + this.angleDelta(ah, b.heading * Math.PI / 180) * f;

      // Drop snapshots we've fully passed (keep one before the cursor for the next frame).
      while (buf.length > 2 && buf[1].arrived < renderAt) buf.shift();
    }

    // Ease the displayed pose toward the target — smooths reconciliation when a late
    // snapshot or extrapolation correction arrives, so the vessel never visibly jumps.
    const k = 1 - Math.pow(1 - this.RECONCILE, dt * 60);   // frame-rate-independent lerp
    entry.dispX += (tx - entry.dispX) * k;
    entry.dispZ += (tz - entry.dispZ) * k;
    entry.dispHeading += this.angleDelta(entry.dispHeading, tHeading) * k;

    // ── Buoyancy: sample the ocean wave field so the vessel bobs at the waterline
    // instead of floating rigidly. Heave from the centre height; pitch/roll from the
    // height difference across the hull (bow-vs-stern, port-vs-stbd). Exponentially
    // smoothed so it rides the swell rather than snapping to chop. Uses the OCEAN's
    // clock (matches the rendered surface).
    const t   = this.oceanService.getOceanTime();
    const hr  = entry.dispHeading;
    const fwdX = Math.sin(hr), fwdZ = Math.cos(hr);     // bow direction
    const rgtX = Math.cos(hr), rgtZ = -Math.sin(hr);    // starboard direction
    const HALF_LEN = 6.0, HALF_BEAM = 2.0;              // hull half-extents (sloop ≈ 12×4)

    const wave = this.oceanService.getWaveHeightAt.bind(this.oceanService);
    const hC = wave(entry.dispX, entry.dispZ, t);
    const hBow = wave(entry.dispX + fwdX * HALF_LEN, entry.dispZ + fwdZ * HALF_LEN, t);
    const hStern = wave(entry.dispX - fwdX * HALF_LEN, entry.dispZ - fwdZ * HALF_LEN, t);
    const hStbd = wave(entry.dispX + rgtX * HALF_BEAM, entry.dispZ + rgtZ * HALF_BEAM, t);
    const hPort = wave(entry.dispX - rgtX * HALF_BEAM, entry.dispZ - rgtZ * HALF_BEAM, t);

    // Targets: heave = surface height; pitch = bow-vs-stern slope; roll = stbd-vs-port.
    // REMOTE_DRAFT matches the local vessel's FLOAT_DRAFT so remotes sit at the SAME
    // waterline as your own ship (they were floating ~2.4 m too high at the old fixed
    // REMOTE_FLOAT_Y=1.65 baseline).
    const heaveTarget = hC + this.REMOTE_DRAFT;
    const pitchTarget = Math.atan2(hStern - hBow, HALF_LEN * 2);   // +bow up
    const rollTarget  = Math.atan2(hStbd - hPort, HALF_BEAM * 2);  // +stbd down

    const bk = 1 - Math.pow(1 - 0.08, dt * 60);   // gentle swell-following smoothing
    entry.heaveY      += (heaveTarget - entry.heaveY) * bk;
    entry.pitchRad    += (pitchTarget - entry.pitchRad) * bk;
    entry.rollWaveRad += (rollTarget  - entry.rollWaveRad) * bk;

    entry.root.position.x = entry.dispX;
    entry.root.position.z = entry.dispZ;
    entry.root.position.y = entry.heaveY;
    entry.root.rotation.y = entry.dispHeading;
    entry.root.rotation.x = entry.pitchRad;
    // rotation.z gets wave roll here; tickRecoil adds cannon recoil on top.
    entry.root.rotation.z = entry.rollWaveRad + entry.recoilRoll;

    // Rig animation: rudder reflects the broadcast yaw; flag/pennant flutter downwind;
    // sail furl + anchor ease toward the broadcast state so they animate like the local ship.
    if (entry.controller) {
      const rudder = Math.max(-1, Math.min(1, (newest.turnRate || 0) / 20));
      entry.controller.setRudder(rudder);
      const wind = this.weatherService.weather();
      if (wind) {
        const headingDeg = entry.dispHeading * 180 / Math.PI;
        const windLocalRad = (((wind.wind.fromBearingDeg + 180) % 360) - headingDeg) * Math.PI / 180;
        entry.controller.idleWind(windLocalRad, Math.min(1.2, wind.wind.speed / 8), t);
      }
      entry.controller.applySailState(entry.sailState);   // sets furl target; eases below

      const side: 'S' | 'P' = entry.anchorSide === 'P' ? 'P' : 'S';
      entry.anchorDeploy += ((entry.anchored ? 1 : 0) - entry.anchorDeploy) * Math.min(1, dt * 2.5);
      entry.controller.dropAnchor('S', side === 'S' ? entry.anchorDeploy : 0);
      entry.controller.dropAnchor('P', side === 'P' ? entry.anchorDeploy : 0);

      // Last: ease trim/boom/furl AND re-prepare the skeleton from all posed bone nodes.
      entry.controller.tickRig(dt);
    }
  }

  private tickRecoil(entry: OtherPlayerEntry, dt: number): void {
    const recoilAcc = -this.RECOIL_SPRING * entry.recoilRoll - this.RECOIL_DAMPING * entry.recoilRollVel;
    entry.recoilRollVel += recoilAcc * dt;
    entry.recoilRoll += entry.recoilRollVel * dt;
    if (entry.recoilRoll > this.RECOIL_MAX_ROLL) entry.recoilRoll = this.RECOIL_MAX_ROLL;
    if (entry.recoilRoll < -this.RECOIL_MAX_ROLL) entry.recoilRoll = -this.RECOIL_MAX_ROLL;
    if (Math.abs(entry.recoilRoll) < 0.0002 && Math.abs(entry.recoilRollVel) < 0.0002) {
      entry.recoilRoll = 0;
      entry.recoilRollVel = 0;
    }
    // Combine cannon recoil with the wave-induced roll set by tickRemoteMotion (runs
    // first) so neither overwrites the other.
    entry.root.rotation.z = entry.rollWaveRad + entry.recoilRoll;
  }

  // ── Visibility ────────────────────────────────────────────────────────────

  /** Drive a remote vessel's yards + boom/gaff to match its broadcast sail trim —
   *  identical math to VesselService (yards braced from sheet angle, boom/gaff swung
   *  to the leeward side per tack). */
  private applyRemoteTrim(entry: OtherPlayerEntry): void {
    if (!entry.controller) return;
    const sheet = entry.sheetAngle ?? 30;
    const braced = Math.max(0, Math.min(1, (88 - sheet) / 83));
    entry.controller.setTrim(braced);
    const swingSide = entry.isPortTack ? -1 : 1;
    entry.controller.setBoomSwing(swingSide * (sheet - 90) * Math.PI / 180);
  }

  private applyVisibility(entry: OtherPlayerEntry): void {
    const dx   = entry.x - this.localState.x;
    const dz   = entry.z - this.localState.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    entry.root.setEnabled(dist <= this.VISIBILITY_RADIUS);
  }

  private refreshAllVisibility(): void {
    for (const entry of this.players.values()) this.applyVisibility(entry);
  }

  // ── Vessel mesh building ──────────────────────────────────────────────────
  // Loads the same GLB files as VesselService so remote vessels look identical
  // to the local player's ship.

  private async buildPlayerVessel(
    playerId: string, slug: string, callsign: string,
    entry: OtherPlayerEntry, scene: Scene,
  ): Promise<void> {
    const prefix  = 'rp_' + playerId + '_';

    // Instantiate the single rigged GLB from the shared cache (fetched + parsed once
    // per session, then cheaply cloned per vessel with its own skeleton/clips/morphs).
    // 180° Y flip so the bow faces +Z = forward (matches VesselService); parenting +
    // renderingGroupId 2 happen in the cache.
    const { glb, manifest: manifestFile } = glbForSlug(slug);
    const [rigged, manifest] = await Promise.all([
      this.assetCache.instantiateRigged(glb, scene, entry.root, true),
      this.assetCache.loadManifest(manifestFile),
    ]);
    if (!rigged) { console.warn('[Multiplayer] rigged vessel failed to load for', playerId); return; }

    for (const m of rigged.root.getChildMeshes(false)) m.isPickable = false;
    entry.controller = new SloopController(rigged.entries, rigged.root, manifest, scene);

    // Apply the sail state + trim we already know (updates may have arrived pre-build).
    entry.controller.applySailState(entry.sailState, true);   // snap initial pose
    this.applyRemoteTrim(entry);

    // Snapshot of vessel meshes before the label is added (for shadow casting +
    // ocean registration — we don't want the billboard label in either).
    const vesselMeshes = entry.root.getChildMeshes(false);

    // Callsign label (billboard above masthead)
    this.buildCallsignLabel(prefix + 'label', callsign, entry.root, scene);

    // Ocean reflection + refraction — register every hull/rig/sail mesh with the ocean
    // so remote vessels appear mirrored in the surface and their submerged hull shows
    // through the water (matches VesselService).
    for (const m of vesselMeshes) {
      this.oceanService.addToRenderList(m);
    }

    // Shadows + WebGPU varying budget (mirrors VesselService): the rigged GLB's PBR
    // materials carry more vertex varyings than the old split parts, so with the SSAO
    // prePass + shadow receipt + fog + ocean reflection clip-plane they exceed WebGPU's
    // 16 inter-stage limit and invalidate every pipeline (black screen). Cast shadows
    // but don't receive them, drop fog, and exclude the materials from the prePass.
    const sg = this.sceneService.shadowGenerator;
    const seenMats = new Set<Material>();
    for (const m of vesselMeshes) {
      sg?.addShadowCaster(m, true);
      m.receiveShadows = false;
      const mat = m.material;
      if (mat && !seenMats.has(mat)) {
        seenMats.add(mat);
        mat.fogEnabled = false;
        this.sceneService.excludeFromPrePass(mat);
      }
    }
  }

  // ── Floating callsign label ───────────────────────────────────────────────

  private buildCallsignLabel(
    name: string, callsign: string, root: TransformNode, scene: Scene,
  ): Mesh {
    const texW = 768, texH = 128;

    const tex = new DynamicTexture(name + '_tex', { width: texW, height: texH }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;

    ctx.clearRect(0, 0, texW, texH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.70)';
    ctx.beginPath();
    ctx.rect(10, 10, texW - 20, texH - 20);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font      = 'bold 56px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(callsign.toUpperCase(), texW / 2, texH / 2);

    ctx.strokeStyle = 'rgba(130, 200, 255, 0.55)';
    ctx.lineWidth   = 3;
    ctx.strokeRect(10, 10, texW - 20, texH - 20);

    tex.update();
    tex.hasAlpha = true;

    const mat = new StandardMaterial(name + '_mat', scene);
    mat.diffuseTexture             = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling            = false;
    mat.disableLighting            = true;
    mat.emissiveColor              = new Color3(1, 1, 1);

    const plane = MeshBuilder.CreatePlane(name + '_plane', {
      width:  this.LABEL_WIDTH,
      height: this.LABEL_HEIGHT,
    }, scene);
    plane.parent        = root;
    plane.position.y    = this.LABEL_Y;
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.isPickable    = false;
    plane.material      = mat;
    // Group 2 = same layer as terrain/ocean-near/vessels (see VesselService/TerrainService).
    // The default group 0 renders BEFORE the group-2 world, so the shared depth buffer lets
    // foreground ocean/terrain paint over the nameplate — making it vanish. Matching the
    // world's group restores correct depth sorting: visible above the hull, hidden by hills.
    plane.renderingGroupId = 2;

    return plane;
  }
}
