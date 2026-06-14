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
import { ScatterService } from './scatter/scatter.service';
import { VesselController, createVesselController, rigForSlug } from './vessel-controller';
import { CrewService, CrewHandle, crewSeedFrom } from './crew.service';
import { CombatService } from './combat.service';
import { SquadronService } from './squadron.service';
import { SalvageService } from './salvage.service';
import { SfxService } from './sfx.service';
import { MastCrackService } from './mast-crack.service';
import { TelemetryService } from './telemetry.service';
import { CombatHitMsg, ZoneState, listingFor, capsizeFor, zoneHpFor, sinkProgress, SINK_DEPTH, SINK_REVEAL_MS, mastHealth } from './combat.constants';
import { OtherPlayer, SailState, ChatMessage, MarketState, MarketHint, LedgerEntry } from '../models';
import { factionColor, factionName } from '../faction.config';
import { Settings } from '../../app.settings';
import { AuthService } from '../../services/auth.service';

// Remote vessel rig assets are resolved per slug via rigForSlug() (vessel-controller.ts).

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
  controller:      VesselController | null;  // drives this remote's trim/sail/rudder/flag
  crew:            CrewHandle | null;        // animated deck crew (seeded from playerId)
  builtSlug?:      string;                   // slug the current mesh was built with — a change triggers a rebuild
  rebuilding?:     boolean;                  // a hull-swap rebuild is in flight (guards re-entry)
  prevMastH?:      number;                   // last mast-health fraction, for the demasting-crack 0-crossing
  recoilRoll:      number;
  recoilRollVel:   number;
  recoilSway:      number;
  recoilSwayVel:   number;
  hitRoll:         number;
  hitRollVel:      number;
  hitSway:         number;
  hitSwayVel:      number;
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

  // ── Damage listing (eased toward the target tilt from this ship's hull state) ──
  listRoll:  number;           // smoothed extra roll from beam damage
  listPitch: number;           // smoothed extra pitch from bow/stern damage

  // ── Sink/capsize (this ship was sunk) ──
  sinking:     boolean;        // server combat_sunk for this id (cleared on repair)
  sinkElapsed: number;         // seconds since the sinking began (feeds sinkProgress)
  sinkEnv:     number;         // applied 0→1 progress (eased out on repair)

  // ── Collision: previous-frame hull distance to the local ship (for on-screen closing rate). ──
  collPrevDist?: number;
}

@Injectable({ providedIn: 'root' })
export class MultiplayerService {
  private sceneService   = inject(SceneService);
  private oceanService   = inject(OceanService);
  private weatherService = inject(WeatherService);
  private assetCache     = inject(VesselAssetCacheService);
  private crewService    = inject(CrewService);
  private vesselService  = inject(VesselService);
  private scatterService = inject(ScatterService);
  private combatService  = inject(CombatService);
  readonly squadronService = inject(SquadronService);
  private mastCrackService = inject(MastCrackService);
  private sfx            = inject(SfxService);
  private telemetry      = inject(TelemetryService);
  private zone           = inject(NgZone);
  private authService    = inject(AuthService);
  readonly salvageService = inject(SalvageService);

  otherPlayers  = signal<OtherPlayer[]>([]);
  chatMessages  = signal<ChatMessage[]>([]);
  myFriends     = signal<string[]>([]);   // callsigns I've explicitly friended
  mutualFriends = signal<string[]>([]);   // mutual (both sides friended, and online)
  // Set when the server kicks this session (same account opened in another window).
  // The game component watches this to show a notice and bail out of the session.
  kickedReason  = signal<string | null>(null);
  // Set when the websocket is refused/closed with code 4401 (invalid/expired JWT). The game component
  // watches this to force a fresh login — the session token can no longer be trusted.
  authFailed    = signal<boolean>(false);

  // ── Town Economy ────────────────────────────────────────────────────────────
  // Authoritative purse + hold (server-pushed via 'wallet'/'market_state'), and the currently open town's
  // market quote (null when the trader panel is closed / no market loaded). The trader UI reads these signals.
  gold     = signal<number>(0);
  cargo    = signal<Record<string, number>>({});
  capacity = signal<number>(0);            // current vessel's cargo hold capacity (slots)
  market   = signal<MarketState | null>(null);
  goodsCatalog = signal<Record<string, string>>({});   // goodId → display name (for the inventory panel anywhere)
  // Factions reputation — the player's standing per nation (neutral 0). Scaffold only; shown in the Ship's Hold.
  factionRep   = signal<Record<string, number>>({});
  // Ships-as-economy — the player's OWNED vessel slug (server-authoritative; drives the shipwright UI).
  ownedShip    = signal<string>('pinnace');
  // Set to the new slug when a shipwright purchase succeeds → the game swaps the in-world vessel, then clears it.
  purchasedShip = signal<string | null>(null);
  // Last shipwright rejection reason (transient; the shipwright panel surfaces it).
  shipError    = signal<string | null>(null);
  // Phase 3 — discovery: visited-town ledger, current trade rumour, and the town to beacon on the minimap.
  ledger       = signal<Record<string, LedgerEntry>>({});
  hint         = signal<MarketHint | null>(null);
  hintedHarbor = signal<string | null>(null);
  // Position of the single nearest NPC merchant (any distance) — for the minimap marker only.
  nearestMerchant = signal<{ x: number; z: number } | null>(null);
  // Owners/Admins receive every merchant's position for the minimap (full-fleet view); empty for regular players.
  allMerchants = signal<{ x: number; z: number }[]>([]);
  // Set when the player collects salvage — the game overlay shows a transient toast.
  salvageToast = signal<{ goods: Record<string, number>; gold: number } | null>(null);
  /** Last trade rejection reason (transient; the panel may surface it as a toast). */
  tradeError = signal<string | null>(null);
  /** True when the most recent dock repair was a mercy (free) repair — the UI can flash a note. */
  lastRepairMercy = signal<boolean>(false);

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
  /** Last authoritative hull state per remote ship (drives its damage-listing tilt). */
  private remoteZones  = new Map<string, ZoneState>();
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer:   ReturnType<typeof setInterval> | null = null;

  private readonly VISIBILITY_RADIUS = 15_000;
  private readonly REMOTE_DRAFT      = 0.0;  // matches VesselService FLOAT_DRAFT (model origin = waterline)
  private readonly RECOIL_SPRING     = 7.2;
  private readonly RECOIL_DAMPING    = 5.8;
  private readonly RECOIL_IMPULSE    = 0.40;   // rad/s heel kick PER shot (matches VesselService)
  private readonly RECOIL_MAX_ROLL   = 0.17;   // ~9.7° cap
  // Lateral shudder — mirrors VesselService so remotes lurch away from their guns too.
  private readonly RECOIL_SWAY_SPRING  = 9.0;
  private readonly RECOIL_SWAY_DAMPING = 6.0;
  private readonly RECOIL_SWAY_IMPULSE = 0.95;  // m/s lateral kick PER shot
  private readonly RECOIL_SWAY_MAX     = 0.95;  // m hard cap
  // Heavy hit shudder — mirrors VesselService so a struck remote ship rocks violently.
  private readonly HIT_SPRING       = 8.5;
  private readonly HIT_DAMPING      = 4.6;
  private readonly HIT_ROLL_IMPULSE = 1.1;
  private readonly HIT_SWAY_IMPULSE = 2.6;
  private readonly HIT_MAX_ROLL     = 0.34;
  private readonly HIT_MAX_SWAY     = 1.8;

  // ── Remote movement smoothing ──────────────────────────────────────────────
  // We render remote vessels this many ms BEHIND the newest snapshot, so there's
  // almost always a newer snapshot to interpolate toward (eliminates the per-update
  // teleport). ~2 updates of slack at the 10 Hz (100 ms) send rate.
  private readonly INTERP_DELAY_MS = 110;
  private readonly LIST_EASE = 0.04;   // per-frame ease toward the damage-listing tilt (slow settle)
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

  // ── Cannon shot + combat callbacks (set by CannonService; avoids circular DI) ──
  onRemoteShot: ((ox: number, oy: number, oz: number,
                  vx: number, vy: number, vz: number,
                  shooterId: string, seq: number, bar: boolean) => void) | null = null;
  /** Server-adjudicated ship hit → play the authoritative cosmetic on the struck ship. */
  onCombatHit: ((msg: CombatHitMsg) => void) | null = null;
  /** A ship repaired to full (own or remote) → clear its persistent battle damage. */
  onCombatRepair: ((playerId: string) => void) | null = null;

  broadcastShot(ox: number, oy: number, oz: number,
                vx: number, vy: number, vz: number, seq: number,
                shotType: 'round' | 'bar' = 'round'): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'cannon_shot', ox, oy, oz, vx, vy, vz, seq, shotType }));
  }

  /** Ask the server to restore our hull to full IN PLACE (dock "Repair Vessel"; no teleport). */
  requestCombatReset(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'combat_reset' }));
    this.combatService.clearSunk();
    this.vesselService.stopSinking();                  // refloat the hull (eases buoyancy back to normal)
    if (this.myId) this.onCombatRepair?.(this.myId);   // wipe our own scorch marks now
  }

  // ── Town Economy: trade actions (server-authoritative) ──────────────────────
  /** Open a town's trader → server replies with its market quote + our wallet. */
  openTrade(townId: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'trade_open', townId }));
  }
  /** Buy `qty` of a good at a town (validated server-side; reply updates market + wallet). */
  tradeBuy(townId: string, goodId: string, qty: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'trade_buy', townId, goodId, qty }));
  }
  /** Sell `qty` of a good at a town (validated server-side; reply updates market + wallet). */
  tradeSell(townId: string, goodId: string, qty: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'trade_sell', townId, goodId, qty }));
  }
  /** Close the trader panel locally (clears the open market quote). */
  closeTrade(): void { this.market.set(null); }

  /** Shipwright: ask the server to buy/commission a vessel (validated server-side: docked, gold/admin,
   *  cargo fits). On success the server sends a fresh wallet + a `ship_bought` that drives the in-world swap. */
  buyShip(slug: string): void {
    this.shipError.set(null);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ship_buy', slug }));
  }

  /** Respawn after a sinking: the caller has already teleported the vessel to a harbor; this tells the
   *  server to reset our hull AND clear our authoritative pose (so the teleport isn't clamped). */
  requestRespawn(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'respawn' }));
    this.combatService.clearSunk();
    this.vesselService.stopSinking();
    if (this.myId) this.onCombatRepair?.(this.myId);
  }

  /** Our own server-assigned id (for combat targeting). */
  getMyId(): string | null { return this.myId; }
  /** The root TransformNode of a remote vessel, or null. */
  getRemoteRoot(id: string): TransformNode | null { return this.players.get(id)?.root ?? null; }

  /** Remote vessels as wake sources (id + display position + scaled speed) for the FFT ocean. */
  getVesselWakeSources(): { id: string; x: number; z: number; speed: number }[] {
    const out: { id: string; x: number; z: number; speed: number }[] = [];
    for (const [id, e] of this.players) {
      out.push({ id, x: e.dispX, z: e.dispZ, speed: Math.abs(e.speed) * 4.0 });
    }
    return out;
  }

  /** Fill remote vessel display positions (x,z) into `out` (vec4 stride) from index `start`,
   *  up to `max` total entries. Returns how many were written. For the FFT ocean boat shadows. */
  fillVesselPositions(out: Float32Array, start: number, max: number): number {
    let n = 0;
    for (const e of this.players.values()) {
      const i = start + n;
      if (i >= max) { break; }
      out[i * 4 + 0] = e.dispX;
      out[i * 4 + 1] = e.dispZ;
      out[i * 4 + 2] = 0;
      out[i * 4 + 3] = 0;
      n++;
    }
    return n;
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

  // ── Squadrons (Phase B) — typed lifecycle messages (the server also accepts the /squad chat commands). ──
  squadronInvite(callsign: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'squadron_invite', callsign }));
  }
  squadronAccept(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'squadron_accept' }));
    this.squadronService.clearInvite();
  }
  squadronDecline(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'squadron_decline' }));
    this.squadronService.clearInvite();
  }
  squadronLeave(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'squadron_leave' }));
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
    this.authFailed.set(false);

    // Recoil animation tick — runs every render frame while connected
    const scene = this.sceneService.scene;
    if (scene) {
      this.recoilTickFn = () => this.sceneService.span('mp', () => {
        const dt = Math.min(scene.getEngine().getDeltaTime() * 0.001, 0.05);
        const renderAt = performance.now() - this.INTERP_DELAY_MS;
        for (const entry of this.players.values()) {
          this.tickRemoteMotion(entry, renderAt, dt);
          this.tickRecoil(entry, dt);
        }
        // Ship-to-ship collision: bounce/deflect the LOCAL ship off any remote hull (runs after remote
        // display positions are updated above).
        this.tickCollisions(dt);
      });
      scene.registerBeforeRender(this.recoilTickFn);
    }

    // Authenticate the socket: browsers can't set WS headers, so pass the JWT as a query param. The
    // server verifies it and refuses (close 4401) if it's missing/invalid.
    const token = this.authService.getToken();
    const url = token ? `${Settings.wsUrl}?token=${encodeURIComponent(token)}` : Settings.wsUrl;
    this.ws = new WebSocket(url);

    // Let the salvage service ask the server to collect a crate the local ship sailed over.
    this.salvageService.sendCollect = (crateId) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'salvage_collect', crateId }));
    };

    this.ws.addEventListener('open', () => {
      this.updateTimer = setInterval(() => this.sendUpdate(), 100);
      // Round-trip ping for the debug overlay (everyone, backtick).
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
        }
      }, 2000);
    });

    this.ws.addEventListener('message', (evt) => {
      let msg: any;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this.zone.run(() => this.handleMessage(msg));
    });

    this.ws.addEventListener('close', (evt) => {
      if (this.updateTimer) clearInterval(this.updateTimer);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.telemetry.ping.set(-1);
      // 4401 = server rejected the JWT. The token can't be trusted → force a fresh login.
      if (evt.code === 4401) this.zone.run(() => this.authFailed.set(true));
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
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.telemetry.ping.set(-1);
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
    this.market.set(null);
    this.ledger.set({});
    this.hint.set(null);
    this.hintedHarbor.set(null);
    this.nearestMerchant.set(null);
    this.allMerchants.set([]);
    this.factionRep.set({});
    this.ownedShip.set('pinnace');
    this.purchasedShip.set(null);
    this.shipError.set(null);
    this.salvageToast.set(null);
    this.salvageService.clear();
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

    } else if (msg.type === 'correction') {
      // Server clamped our claimed pose (teleport/speed-hack, or — later — collision/land). Snap the
      // local boat to the authoritative pose. Honest play never triggers this.
      this.vesselService.applyServerCorrection(+msg.x, +msg.z, +msg.heading, +msg.speed);

    } else if (msg.type === 'leave') {
      this.removePlayer(msg.id);

    } else if (msg.type === 'wave_state') {
      this.weatherService.receiveServerState(msg);

    } else if (msg.type === 'cannon_shot') {
      if (msg.id === this.myId) return;
      this.onRemoteShot?.(+msg.ox, +msg.oy, +msg.oz, +msg.vx, +msg.vy, +msg.vz,
                          String(msg.id), +msg.seq || 0, msg.shotType === 'bar');

    } else if (msg.type === 'combat_hit') {
      // Authoritative ship hit. CannonService defers the whole reaction (shudder + cosmetic)
      // until the matching ball actually arrives (server tof), so it lands in sync with the
      // visible shot rather than instantly at the muzzle.
      this.onCombatHit?.(msg as CombatHitMsg);

    } else if (msg.type === 'pong') {
      this.telemetry.ping.set(Math.round(performance.now() - (+msg.t || 0)));

    } else if (msg.type === 'combat_state') {
      const pid = String(msg.playerId ?? '');
      const maxHp = (msg as { maxHp?: ZoneState }).maxHp;
      if (!pid || pid === this.myId) this.combatService.setLocalZones(msg.zones as ZoneState, maxHp);
      else                            this.remoteZones.set(pid, msg.zones as ZoneState);

    } else if (msg.type === 'mast_repair') {
      // Server armed our mast jury-rig (sent only to us) → run the HUD repair bar over its duration.
      this.combatService.startMastRepair(+msg.ms || 0);

    } else if (msg.type === 'combat_sunk') {
      if (msg.victimId === this.myId) {
        // Start the capsize NOW, but delay the "you were sunk" card until the wreck animation has played.
        this.vesselService.startSinking();
        const by = String(msg.shooterName ?? '');
        setTimeout(() => this.combatService.markSunk(by), SINK_REVEAL_MS);
      } else {
        // A remote ship was sunk → capsize it (its per-zone damage drives which way it rolls/settles).
        const e = this.players.get(String(msg.victimId));
        if (e && !e.sinking) { e.sinking = true; e.sinkElapsed = 0; }
      }

    } else if (msg.type === 'combat_repair') {
      // A ship was restored to full → clear its persistent battle damage AND refloat it. If it's US (an admin
      // /repair'd our hull), also clear the sinking/sunk state locally — the dock-repair path does this
      // client-side, but an admin repair only reaches us over the wire.
      const pid = String(msg.playerId);
      if (pid === this.myId) {
        this.combatService.clearSunk();
        this.vesselService.stopSinking();
      } else {
        const e = this.players.get(pid);
        if (e) { e.sinking = false; }
      }
      this.onCombatRepair?.(pid);

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
      // Also live-reload the scatter assets (palms/beech/rocks/driftwood) from the server.
      this.scatterService.reloadAssets(+msg.version || 0).catch((e) => console.warn('[MP] scatter reload failed', e));

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
        chatType:  msg.chatType === 'dm' ? 'dm' : (msg.chatType === 'squadron' ? 'squadron' : 'global'),
      };
      this.chatMessages.update(msgs => [...msgs.slice(-199), chatMsg]);

    } else if (msg.type === 'squadron_invited') {
      // A captain invited us → surface the accept/decline prompt (Phase B).
      this.squadronService.setInvite({
        squadronId:   String(msg.squadronId ?? ''),
        fromId:       String(msg.fromId ?? ''),
        fromCallsign: String(msg.fromCallsign ?? ''),
      });

    } else if (msg.type === 'squadron_state') {
      // Authoritative roster (squadronId:null = we left / it disbanded → clear the UI).
      if (msg.squadronId == null) {
        this.squadronService.setRoster(null);
      } else {
        this.squadronService.setRoster({
          squadronId: String(msg.squadronId),
          leaderId:   String(msg.leaderId ?? ''),
          members:    Array.isArray(msg.members)
            ? msg.members.map((m: any) => ({ id: String(m.id), callsign: String(m.callsign) }))
            : [],
        });
      }
      this.squadronService.clearInvite();   // any pending invite is now resolved

    } else if (msg.type === 'wallet') {
      // Authoritative purse + hold + capacity (on connect, and as a correction after a denied/failed trade).
      this.gold.set(+msg.gold || 0);
      this.cargo.set((msg.cargo && typeof msg.cargo === 'object') ? msg.cargo as Record<string, number> : {});
      if (msg.capacity != null) this.capacity.set(+msg.capacity || 0);
      if (Array.isArray(msg.catalog)) {
        const cat: Record<string, string> = {};
        for (const g of msg.catalog) cat[String(g.id)] = String(g.name);
        this.goodsCatalog.set(cat);
      }
      if (msg.factionRep && typeof msg.factionRep === 'object') this.factionRep.set(msg.factionRep as Record<string, number>);
      if (typeof msg.ship === 'string' && msg.ship) { this.ownedShip.set(msg.ship); this.localState.vesselSlug = msg.ship; }

    } else if (msg.type === 'market_state') {
      // A town's market quote (+ our wallet) — opens/refreshes the trader panel.
      this.market.set({
        townId: String(msg.townId), name: String(msg.name), specialty: String(msg.specialty),
        goods: msg.goods || [], hint: msg.hint ?? null,
        faction: msg.faction ?? null, contested: !!msg.contested, rivalFaction: msg.rivalFaction ?? null,
      });
      this.hint.set(msg.hint ?? null);
      this.hintedHarbor.set(msg.hint?.townId ?? null);
      if (msg.gold != null) this.gold.set(+msg.gold || 0);
      if (msg.cargo && typeof msg.cargo === 'object') this.cargo.set(msg.cargo as Record<string, number>);
      if (msg.capacity != null) this.capacity.set(+msg.capacity || 0);

    } else if (msg.type === 'nearest_merchant') {
      this.nearestMerchant.set(msg.x == null ? null : { x: +msg.x, z: +msg.z });

    } else if (msg.type === 'all_merchants') {
      this.allMerchants.set(Array.isArray(msg.ships) ? msg.ships.map((s: any) => ({ x: +s.x, z: +s.z })) : []);

    } else if (msg.type === 'salvage_spawn') {
      this.salvageService.spawn(String(msg.id), +msg.x, +msg.z);

    } else if (msg.type === 'salvage_despawn') {
      this.salvageService.despawn(String(msg.id));

    } else if (msg.type === 'salvage_snapshot') {
      this.salvageService.snapshot(Array.isArray(msg.crates) ? msg.crates : []);

    } else if (msg.type === 'salvage_collected') {
      // The wallet update arrives separately; surface a transient toast of what we scooped.
      this.salvageToast.set({ goods: (msg.goods && typeof msg.goods === 'object') ? msg.goods : {}, gold: +msg.gold || 0 });

    } else if (msg.type === 'ledger') {
      // Full discovered-towns ledger (on connect).
      this.ledger.set((msg.towns && typeof msg.towns === 'object') ? msg.towns as Record<string, LedgerEntry> : {});

    } else if (msg.type === 'ledger_entry') {
      // One town's discovery record refreshed (on opening its trader / trading there).
      this.ledger.update(l => ({ ...l, [String(msg.townId)]: { specialty: msg.specialty, day: +msg.day || 0, goods: msg.goods || [] } }));

    } else if (msg.type === 'repair_result') {
      // Dock repair always succeeds (mercy free repair when broke). The wallet message alongside corrects gold.
      this.gold.set(+msg.gold || this.gold());
      this.lastRepairMercy.set(!!msg.mercy);

    } else if (msg.type === 'trade_error') {
      this.tradeError.set(String(msg.reason ?? 'trade failed'));

    } else if (msg.type === 'ship_bought') {
      // The wallet message arriving alongside already updated gold/ownedShip; trigger the in-world swap.
      this.shipError.set(null);
      this.purchasedShip.set(String(msg.slug ?? ''));

    } else if (msg.type === 'ship_error') {
      this.shipError.set(String(msg.reason ?? 'purchase failed'));
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
        crew:            null,
        recoilRoll:      0,
        recoilRollVel:   0,
        recoilSway:      0,
        recoilSwayVel:   0,
        hitRoll:         0,
        hitRollVel:      0,
        hitSway:         0,
        hitSwayVel:      0,
        anchorDeploy:    0,
        id:         data.id,
        x:          sx, z: sz, heading: sHeading, speed: sSpeed,
        sailState:  'full',
        vesselName: 'Sloop', vesselSlug: 'sloop',
        callsign:   String(data.callsign ?? ''),
        npc:        !!data.npc,
        faction:    data.faction ?? null,
        buffer:      [],
        dispX:       sx,
        dispZ:       sz,
        dispHeading: sHeading * Math.PI / 180,
        heaveY:      this.REMOTE_DRAFT,   // seed near the waterline (avoids spawn rise from y=0)
        pitchRad:    0,
        rollWaveRad: 0,
        listRoll:    0,
        listPitch:   0,
        sinking:     false,
        sinkElapsed: 0,
        sinkEnv:     0,
      };
      this.players.set(data.id, entry);
      // Seed any hull state we already heard about before this ship's mesh existed.
      const known = this.remoteZones.get(data.id);
      if (known) { const l = listingFor(known, zoneHpFor(entry.vesselSlug)); entry.listRoll = l.roll; entry.listPitch = l.pitch; }

      const callsign = String(data.callsign ?? '').slice(0, 32);
      const slug     = String(data.vesselSlug ?? 'sloop').slice(0, 64);
      entry.builtSlug = slug;   // track what the mesh is built as, so a later slug change rebuilds it
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
    entry.npc        = !!data.npc;
    if (data.faction !== undefined) entry.faction = data.faction ?? null;
    // Hull swapped under us (a remote player bought a new ship at a shipwright) → rebuild their mesh so
    // everyone sees the new vessel, not the old one. Guarded against re-entry; keeps the same root + pose.
    if (!isNew && entry.controller && entry.builtSlug && entry.builtSlug !== entry.vesselSlug && !entry.rebuilding) {
      this.rebuildRemoteVessel(data.id, entry, scene);
    }
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
    this.remoteZones.delete(id);
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

  /** Tear down a remote's vessel meshes/crew/controller/label but KEEP its root TransformNode (used by both
   *  full disposal and an in-place hull swap). See the shadow-caster note below. */
  private clearVesselMeshes(entry: OtherPlayerEntry): void {
    entry.crew?.dispose();   // frees the crew's per-member cloned materials + observer
    entry.crew = null;
    entry.controller?.dispose();
    entry.controller = null;
    // Unregister from the ocean reflection list AND the shadow generator before disposing so stale meshes
    // don't pile up across many join/leaves. (Babylon does NOT auto-remove a disposed mesh from a
    // ShadowGenerator's manual render list — left unpruned, churning NPC merchants accumulate dead refs
    // until the shadow/depth pass dereferences one (black screen) and the GPU descriptor heap exhausts.)
    const sg = this.sceneService.shadowGenerator;
    entry.root.getChildMeshes(false).forEach(m => {
      this.oceanService.removeFromRenderList(m);
      sg?.removeShadowCaster(m, true);
      // dispose(doNotRecurse=false, disposeMaterialAndTextures=FALSE): vessels are
      // instantiated with cloneMaterials=false, so every ship (local + remote) shares ONE
      // material + texture set owned by the asset container. Disposing them here would strip
      // the texture off the local ship and all other remotes — leaving a flat grey model.
      (m as Mesh).dispose(false, false);
    });
    entry.root.getChildTransformNodes(false).forEach(n => n.dispose());
  }

  private disposeEntry(entry: OtherPlayerEntry): void {
    this.clearVesselMeshes(entry);
    entry.root.dispose();
  }

  /** A remote player swapped hulls at a shipwright: rebuild their mesh in place (same root + pose) with the
   *  new vessel slug. Clears the old meshes/crew/label first, then re-instantiates via buildPlayerVessel. */
  private rebuildRemoteVessel(playerId: string, entry: OtherPlayerEntry, scene: Scene): void {
    entry.rebuilding = true;
    const slug = entry.vesselSlug;
    this.clearVesselMeshes(entry);
    void this.buildPlayerVessel(playerId, slug, entry.callsign, entry, scene)
      .catch(err => console.warn('[Multiplayer] hull-swap rebuild failed for', playerId, err))
      .finally(() => {
        // Only the freshest entry for this id may clear the flag (it may have left + rejoined mid-rebuild).
        if (this.players.get(playerId) === entry) { entry.builtSlug = slug; entry.rebuilding = false; }
      });
  }

  private publishSignal(): void {
    this.otherPlayers.set(
      Array.from(this.players.values()).map(
        ({ root: _r, controller: _c, crew: _cw, recoilRoll: _rr, recoilRollVel: _rv,
           recoilSway: _rs, recoilSwayVel: _rsv,
           hitRoll: _hr, hitRollVel: _hrv, hitSway: _hs, hitSwayVel: _hsv,
           anchorDeploy: _ad, ...p }) => p as OtherPlayer,
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
      closest.recoilSwayVel += dir * this.RECOIL_SWAY_IMPULSE;   // lateral shudder
      // Kick the firing side's gun barrels too (game port → model 'P', matches local).
      closest.controller?.addGunRecoil(firedSide === 'port' ? 'P' : 'S');
    }
  }

  /**
   * Cosmetic cannon-hit test: returns the displayed pose of the nearest remote ship
   * whose hull (an oriented ellipse ~18 m × 7 m) contains the world point (bx,bz),
   * or null. Uses the smoothed DISPLAYED transform so it matches what's on screen.
   */
  shipHitAt(bx: number, bz: number): { x: number; z: number; heading: number; id: string } | null {
    for (const e of this.players.values()) {
      const dx = bx - e.dispX, dz = bz - e.dispZ;
      const hr = e.dispHeading;                       // radians
      const lat = dx * Math.cos(hr) - dz * Math.sin(hr);   // beam axis
      const lon = dx * Math.sin(hr) + dz * Math.cos(hr);   // fore-aft axis
      if ((lat * lat) / 12.25 + (lon * lon) / 81.0 <= 1.0) {
        return { x: e.dispX, z: e.dispZ, heading: e.dispHeading * 180 / Math.PI, id: e.id };
      }
    }
    return null;
  }

  /** Heavy shudder on a remote ship (id) that was struck on the given side. */
  applyHitShudder(id: string, side: 'port' | 'stbd'): void {
    const e = this.players.get(id);
    if (!e) return;
    const dir = side === 'port' ? 1 : -1;
    e.hitRollVel += dir * this.HIT_ROLL_IMPULSE;
    e.hitSwayVel += dir * this.HIT_SWAY_IMPULSE;
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
    const heaveTarget = hC + this.REMOTE_DRAFT + rigForSlug(entry.vesselSlug).floatDraft;
    const pitchTarget = Math.atan2(hStern - hBow, HALF_LEN * 2);   // +bow up
    const rollTarget  = Math.atan2(hStbd - hPort, HALF_BEAM * 2);  // +stbd down

    const bk = 1 - Math.pow(1 - 0.08, dt * 60);   // gentle swell-following smoothing
    entry.heaveY      += (heaveTarget - entry.heaveY) * bk;
    entry.pitchRad    += (pitchTarget - entry.pitchRad) * bk;
    entry.rollWaveRad += (rollTarget  - entry.rollWaveRad) * bk;

    // Sink progress: eased 0→1 while sinking, eased back out on repair. Updated HERE (runs before
    // tickRecoil) so the draft drop and the capsize rotation use the same value this frame.
    if (entry.sinking) { entry.sinkElapsed += dt; entry.sinkEnv = sinkProgress(entry.sinkElapsed); }
    else if (entry.sinkEnv > 0.0001) { entry.sinkEnv += (0 - entry.sinkEnv) * Math.min(1, dt * 1.8); }
    else { entry.sinkEnv = 0; }

    entry.root.position.x = entry.dispX;
    entry.root.position.z = entry.dispZ;
    entry.root.position.y = entry.heaveY - SINK_DEPTH * entry.sinkEnv;
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

      // Mast collapse/repair: drive off this remote's authoritative masts-zone HP (same source as its
      // damage-listing tilt), so every client sees her mast come down and rise again in lockstep. On the
      // 0-crossing, play the demasting crack at her position (distance-attenuated). prevMastH is undefined
      // until the first observation, so a ship that comes into view already-dismasted doesn't crack.
      const mastH = mastHealth(this.remoteZones.get(entry.id), zoneHpFor(entry.vesselSlug));
      if (entry.prevMastH !== undefined && entry.prevMastH > 0.001 && mastH <= 0.001) {
        this.mastCrackService.crackAt(entry.x, entry.z);
      }
      entry.prevMastH = mastH;
      entry.controller.setMastDamage(mastH);

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
    // Heavy hit shudder (separate channel, own caps) — a struck ship rocks violently.
    const hitRollAcc = -this.HIT_SPRING * entry.hitRoll - this.HIT_DAMPING * entry.hitRollVel;
    entry.hitRollVel += hitRollAcc * dt;
    entry.hitRoll += entry.hitRollVel * dt;
    if (entry.hitRoll >  this.HIT_MAX_ROLL) entry.hitRoll =  this.HIT_MAX_ROLL;
    if (entry.hitRoll < -this.HIT_MAX_ROLL) entry.hitRoll = -this.HIT_MAX_ROLL;
    if (Math.abs(entry.hitRoll) < 0.0002 && Math.abs(entry.hitRollVel) < 0.0002) {
      entry.hitRoll = 0; entry.hitRollVel = 0;
    }

    // Damage listing: ease toward the tilt implied by this ship's hull state (per-vessel HP).
    const list = listingFor(this.remoteZones.get(entry.id), zoneHpFor(entry.vesselSlug));
    entry.listRoll  += (list.roll  - entry.listRoll)  * this.LIST_EASE;
    entry.listPitch += (list.pitch - entry.listPitch) * this.LIST_EASE;

    // Capsize: dramatic heel/plunge toward the damaged side, scaled by sink progress (env set in
    // tickRemoteMotion this frame). Layered on top of everything else, free to exceed the list cap.
    const cap = entry.sinkEnv > 0.0001 ? capsizeFor(this.remoteZones.get(entry.id), zoneHpFor(entry.vesselSlug)) : { roll: 0, pitch: 0 };

    // Combine cannon recoil + hit shudder + damage list with the wave-induced roll/pitch
    // set by tickRemoteMotion (runs first) so neither channel overwrites the other.
    entry.root.rotation.z = entry.rollWaveRad + entry.recoilRoll + entry.hitRoll + entry.listRoll + cap.roll * entry.sinkEnv;
    entry.root.rotation.x = entry.pitchRad + entry.listPitch + cap.pitch * entry.sinkEnv;

    // Lateral shudder: damped sideways lurch away from the firing side, layered on
    // top of the interpolated display position (dispX/dispZ set by tickRemoteMotion).
    const swayAcc = -this.RECOIL_SWAY_SPRING * entry.recoilSway - this.RECOIL_SWAY_DAMPING * entry.recoilSwayVel;
    entry.recoilSwayVel += swayAcc * dt;
    entry.recoilSway += entry.recoilSwayVel * dt;
    if (entry.recoilSway >  this.RECOIL_SWAY_MAX) entry.recoilSway =  this.RECOIL_SWAY_MAX;
    if (entry.recoilSway < -this.RECOIL_SWAY_MAX) entry.recoilSway = -this.RECOIL_SWAY_MAX;
    if (Math.abs(entry.recoilSway) < 0.0005 && Math.abs(entry.recoilSwayVel) < 0.0005) {
      entry.recoilSway = 0;
      entry.recoilSwayVel = 0;
    }
    const hitSwayAcc = -this.HIT_SPRING * entry.hitSway - this.HIT_DAMPING * entry.hitSwayVel;
    entry.hitSwayVel += hitSwayAcc * dt;
    entry.hitSway += entry.hitSwayVel * dt;
    if (entry.hitSway >  this.HIT_MAX_SWAY) entry.hitSway =  this.HIT_MAX_SWAY;
    if (entry.hitSway < -this.HIT_MAX_SWAY) entry.hitSway = -this.HIT_MAX_SWAY;
    if (Math.abs(entry.hitSway) < 0.0005 && Math.abs(entry.hitSwayVel) < 0.0005) {
      entry.hitSway = 0; entry.hitSwayVel = 0;
    }

    const totalSway = entry.recoilSway + entry.hitSway;
    if (totalSway !== 0) {
      const h = entry.dispHeading;   // radians; +sway = toward starboard
      entry.root.position.x = entry.dispX + totalSway * Math.cos(h);
      entry.root.position.z = entry.dispZ - totalSway * Math.sin(h);
    }
  }

  // ── Ship-to-ship collision (local ship only; see plan) ─────────────────────
  // Each hull is a capsule: a keel segment (centre ± heading·HALF) of radius RADIUS. We resolve only the
  // LOCAL ship — cancel the component of its velocity pointing INTO the struck hull (+ a little bounce),
  // keep the tangential part. The other ship's owner resolves its own ship the same way, and we see it via
  // its position broadcast. No momentum transfer, so no agreement/handshake needed.
  // Per-vessel collision capsule (keel half-length + radius ≈ half-beam + margin). Each ship uses its
  // OWN size, so a small pinnace collides at its true hull, not the sloop's bulk. Default = sloop.
  private readonly COLL_DIMS_BY_SLUG: Record<string, { halfLen: number; radius: number }> = {
    sloop:   { halfLen: 5.0, radius: 2.2 },
    pinnace: { halfLen: 3.8, radius: 1.4 },
  };
  private collDims(slug: string | undefined): { halfLen: number; radius: number } {
    return this.COLL_DIMS_BY_SLUG[slug ?? ''] ?? this.COLL_DIMS_BY_SLUG['sloop'];
  }
  // (Separation/bounce is resolved server-side now — movement.resolvePair. The client only detects
  // contact here to fire impact FX, so the restitution constant moved to the server.)
  private readonly COLL_FX_MIN  = 0.6;       // min closing speed (m/s) to fire shake/crunch (ignore taps)
  private readonly COLL_FX_FULL = 7.0;       // closing speed (m/s) at which shake/crunch are full strength
  private _collFxCooldown = 0;               // debounce so a scrape doesn't machine-gun the crunch/shake

  private tickCollisions(dt: number): void {
    if (this._collFxCooldown > 0) { this._collFxCooldown -= dt; }
    const vs = this.vesselService.state();
    if (!vs) { return; }
    const ahr = vs.heading * Math.PI / 180;            // local heading → radians (0=N=+Z, 90=E=+X)
    const aFx = Math.sin(ahr), aFz = Math.cos(ahr);
    const aDim = this.collDims(this.localState.vesselSlug);   // local ship's capsule size

    // Find the deepest overlap against any remote hull. Also track each hull's ON-SCREEN closing rate
    // (how fast the gap is shrinking) — symmetric for both ships, and accurate even though remote speed
    // snapshots lag ~100 ms behind the interpolated display position.
    const invDt = 1 / Math.max(dt, 1e-3);
    let best: { pen: number; closing: number } | null = null;
    for (const entry of this.players.values()) {
      if (!entry.root || !entry.root.isEnabled()) { continue; }   // skip culled / far ships
      const bDim = this.collDims(entry.vesselSlug);   // remote ship's capsule size
      const rsum = aDim.radius + bDim.radius;
      const bFx = Math.sin(entry.dispHeading), bFz = Math.cos(entry.dispHeading);
      const cp = this.closestSegSeg(
        vs.x, vs.z, aFx, aFz, aDim.halfLen,
        entry.dispX, entry.dispZ, bFx, bFz, bDim.halfLen,
      );
      const dx = cp.pbx - cp.pax, dz = cp.pbz - cp.paz;
      const dist = Math.hypot(dx, dz);
      const prev = entry.collPrevDist;          // last frame's gap (undefined / stale after a cull → ignore)
      entry.collPrevDist = dist;
      if (dist >= rsum || dist < 1e-4) { continue; }
      const pen = rsum - dist;
      const closing = (prev !== undefined && prev < rsum * 3) ? (prev - dist) * invDt : 0;   // m/s, + = closing
      if (!best || pen > best.pen) { best = { pen, closing }; }
    }
    if (!best) { return; }

    // NOTE: the actual separation + bounce is resolved SERVER-side now (movement.resolvePair) and
    // arrives as a `correction` that snaps the local ship apart. Here we only detect the contact to
    // fire the local impact FX (camera shake + crunch) so the feel stays immediate.

    // Impact FX (camera shake + crunch). Severity = the on-screen CLOSING rate, so it fires whether WE ram
    // or WE'RE rammed (the rammer's hull is visibly driving into us even after its broadcast speed reads 0).
    // Debounced so a sustained scrape fires once per crunch-length rather than every frame.
    if (this._collFxCooldown <= 0 && best.closing > this.COLL_FX_MIN) {
      const sev = Math.min(1, best.closing / this.COLL_FX_FULL);
      this.vesselService.addShakeTrauma(0.3 + sev * 0.6);
      this.playCollisionCrunch(sev);
      this._collFxCooldown = 0.9;   // ~matches the crunch length so a scrape doesn't stack crunches
    }
  }

  /** Synthesised hull collision: a deep slam thud, a PROLONGED scatter of sharp cracks (timbers
   *  splintering — dense at impact, thinning out), and a low groan of stressed wood underneath. Scaled by
   *  severity. Routed through the shared SFX context. */
  private playCollisionCrunch(sev: number): void {
    const { ctx, master } = this.sfx.getSharedContext();
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const t0 = ctx.currentTime + 0.01;
    const vol = 0.35 + sev * 0.65;

    // 1) Slam — the deep boom of two hulls colliding.
    const thud = ctx.createOscillator(); thud.type = 'triangle';
    thud.frequency.setValueAtTime(150, t0);
    thud.frequency.exponentialRampToValueAtTime(55, t0 + 0.20);
    const thudG = ctx.createGain();
    thudG.gain.setValueAtTime(0.0001, t0);
    thudG.gain.exponentialRampToValueAtTime(0.95 * vol, t0 + 0.012);
    thudG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
    thud.connect(thudG); thudG.connect(master);
    thud.start(t0); thud.stop(t0 + 0.38);

    // 2) Splintering timbers — many sharp cracks scattered over ~1 s, clustered at impact and thinning
    //    out, each a band-passed noise pop at a random "crack" pitch.
    const windowSec = 0.9 + sev * 0.8;
    const nCracks = 18 + Math.floor(sev * 26);         // ~18..44 — many, overlapping into a cascade
    let ct = t0 + 0.02;
    for (let i = 0; i < nCracks; i++) {
      const frac = i / nCracks;
      const fade = 1 - frac * 0.6;                      // later cracks softer (it settles)
      const dur = 0.05 + Math.random() * 0.18;          // longer than the gaps below → cracks overlap
      const len = Math.max(1, Math.floor(ctx.sampleRate * (dur + 0.02)));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let s = 0; s < len; s++) { d[s] = (Math.random() * 2 - 1) * Math.pow(1 - s / len, 1.5); }
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 240 + Math.random() * 2300;  // wide range → varied crack pitches
      bp.Q.value = 1.5 + Math.random() * 4;             // higher Q = more tonal, woody snap
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ct);
      g.gain.exponentialRampToValueAtTime((0.22 + Math.random() * 0.4) * vol * fade, ct + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, ct + dur);
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(ct); src.stop(ct + dur + 0.03);
      // TIGHT onsets (much shorter than each crack's duration) → many cracks ring at once; gaps widen
      // a little over time so the dense cascade at the slam scatters into stray cracks as it settles.
      ct += (0.006 + Math.random() * 0.022) * (0.5 + frac * 1.8);
    }

    // 3) Low groan of stressed wood under the cracking.
    const groan = ctx.createOscillator(); groan.type = 'sawtooth';
    groan.frequency.setValueAtTime(92, t0);
    groan.frequency.linearRampToValueAtTime(68, t0 + windowSec);
    const groanLp = ctx.createBiquadFilter(); groanLp.type = 'lowpass'; groanLp.frequency.value = 250;
    const groanG = ctx.createGain();
    groanG.gain.setValueAtTime(0.0001, t0);
    groanG.gain.exponentialRampToValueAtTime(0.18 * vol, t0 + 0.08);
    groanG.gain.exponentialRampToValueAtTime(0.0001, t0 + windowSec);
    groan.connect(groanLp); groanLp.connect(groanG); groanG.connect(master);
    groan.start(t0); groan.stop(t0 + windowSec + 0.05);
  }

  /** Closest points between two 2-D segments, each given as (centre, unit dir, half-length). 2-D port of
   *  Ericson's ClosestPtSegmentSegment. Returns the closest point on each (pa = A, pb = B). */
  private closestSegSeg(
    ax: number, az: number, adx: number, adz: number, aHalf: number,
    bx: number, bz: number, bdx: number, bdz: number, bHalf: number,
  ): { pax: number; paz: number; pbx: number; pbz: number } {
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const p1x = ax - adx * aHalf, p1z = az - adz * aHalf;   // A start
    const q1x = bx - bdx * bHalf, q1z = bz - bdz * bHalf;   // B start
    const d1x = adx * 2 * aHalf,  d1z = adz * 2 * aHalf;    // A edge vector
    const d2x = bdx * 2 * bHalf,  d2z = bdz * 2 * bHalf;    // B edge vector
    const rx = p1x - q1x, rz = p1z - q1z;
    const a = d1x * d1x + d1z * d1z;
    const e = d2x * d2x + d2z * d2z;
    const f = d2x * rx + d2z * rz;
    const EPS = 1e-8;
    let s = 0, t = 0;
    if (a <= EPS && e <= EPS) { /* both points */ }
    else if (a <= EPS) { t = clamp01(f / e); }
    else {
      const c = d1x * rx + d1z * rz;
      if (e <= EPS) { s = clamp01(-c / a); }
      else {
        const b = d1x * d2x + d1z * d2z;
        const denom = a * e - b * b;
        s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
        t = (b * s + f) / e;
        if (t < 0)      { t = 0; s = clamp01(-c / a); }
        else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
      }
    }
    return {
      pax: p1x + d1x * s, paz: p1z + d1z * s,
      pbx: q1x + d2x * t, pbz: q1z + d2z * t,
    };
  }

  // ── Visibility ────────────────────────────────────────────────────────────

  /** Drive a remote vessel's yards + boom/gaff to match its broadcast sail trim —
   *  identical math to VesselService (yards braced from sheet angle, boom/gaff swung
   *  to the leeward side per tack). */
  private applyRemoteTrim(entry: OtherPlayerEntry): void {
    if (!entry.controller) return;
    entry.controller.setSailTrim(entry.sheetAngle ?? 30, !!entry.isPortTack);
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
    const rig = rigForSlug(slug);
    const [rigged, manifest] = await Promise.all([
      this.assetCache.instantiateRigged(rig.glb, scene, entry.root, rig.importFlipY),
      this.assetCache.loadManifest(rig.manifest),
    ]);
    if (!rigged) { console.warn('[Multiplayer] rigged vessel failed to load for', playerId); return; }

    for (const m of rigged.root.getChildMeshes(false)) m.isPickable = false;
    entry.controller = createVesselController(slug, rigged.entries, rigged.root, manifest, scene);

    // Apply the sail state + trim we already know (updates may have arrived pre-build).
    entry.controller.applySailState(entry.sailState, true);   // snap initial pose
    this.applyRemoteTrim(entry);

    // Animated deck crew, seeded from the player id — every client derives the same
    // seed from the same id, so this remote's pirates look identical everywhere.
    // NPC merchants skip the crew: they churn through the interest range constantly, and the crew is the
    // heaviest build/dispose cost (cloned materials + skeleton + observer per member).
    if (!entry.npc) {
      void this.crewService
        .attach(slug, rigged.root, scene, crewSeedFrom(playerId))
        .then((h) => {
          if (!h) return;
          if (this.players.get(playerId) === entry) entry.crew = h;
          else h.dispose();   // player left while the crew GLB was loading
        });
    }

    // Snapshot of vessel meshes before the label is added (for shadow casting +
    // ocean registration — we don't want the billboard label in either).
    const vesselMeshes = entry.root.getChildMeshes(false);

    // Nameplate (billboard above masthead). NPC merchants show their ship name + a faction-coloured "⚑ NATION
    // MERCHANT" tag; players show their callsign.
    const labelText = entry.npc ? (entry.vesselName || 'Merchant') : callsign;
    this.buildCallsignLabel(prefix + 'label', labelText, entry.root, scene, entry.npc ? (entry.faction || null) : null);

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
      if (!entry.npc) sg?.addShadowCaster(m, true);   // merchants don't cast shadows (churn perf + leak surface)
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
    name: string, text: string, root: TransformNode, scene: Scene, faction: string | null = null,
  ): Mesh {
    const merchant = !!faction;
    const texW = 768, texH = 128;

    const tex = new DynamicTexture(name + '_tex', { width: texW, height: texH }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;

    ctx.clearRect(0, 0, texW, texH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.70)';
    ctx.beginPath();
    ctx.rect(10, 10, texW - 20, texH - 20);
    ctx.fill();
    ctx.textAlign = 'center';

    if (merchant) {
      const col = factionColor(faction);
      // Ship name (top) in cream, then a faction-coloured "⚑ NATION MERCHANT" tag (bottom).
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#f3ead0';
      ctx.font = 'bold 50px Arial, sans-serif';
      ctx.fillText(text, texW / 2, 62);
      ctx.fillStyle = col;
      ctx.font = 'bold 30px Arial, sans-serif';
      ctx.fillText(`⚑ ${factionName(faction).toUpperCase()} MERCHANT`, texW / 2, 104);
      ctx.strokeStyle = col;
      ctx.lineWidth = 5;
      ctx.strokeRect(8, 8, texW - 16, texH - 16);
    } else {
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 56px Arial, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(text.toUpperCase(), texW / 2, texH / 2);
      ctx.strokeStyle = 'rgba(130, 200, 255, 0.55)';
      ctx.lineWidth = 3;
      ctx.strokeRect(10, 10, texW - 20, texH - 20);
    }

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
