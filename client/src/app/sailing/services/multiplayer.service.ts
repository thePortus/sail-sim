import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  MeshBuilder, Vector3, Color3, StandardMaterial, TransformNode,
  Mesh, Scene, DynamicTexture, SceneLoader, Quaternion,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { SceneService }  from './scene.service';
import { WeatherService } from './weather.service';
import { OtherPlayer, SailState, ChatMessage } from '../models';
import { Settings } from '../../app.settings';

// ── OtherPlayerEntry holds everything for one remote vessel ───────────────────
interface OtherPlayerEntry extends OtherPlayer {
  root:            TransformNode;
  sailFullRoot:    TransformNode | null;
  sailReducedRoot: TransformNode | null;
  recoilRoll:      number;
  recoilRollVel:   number;
}

@Injectable({ providedIn: 'root' })
export class MultiplayerService {
  private sceneService   = inject(SceneService);
  private weatherService = inject(WeatherService);
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
  private readonly REMOTE_FLOAT_Y    = 1.65;
  private readonly RECOIL_SPRING     = 7.2;
  private readonly RECOIL_DAMPING    = 5.8;
  private readonly RECOIL_IMPULSE    = 0.46;   // rad/s
  private readonly RECOIL_MAX_ROLL   = 0.12;   // ~6.9° cap

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
    x: 0, z: 0, heading: 0, speed: 0,
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
        for (const entry of this.players.values()) this.tickRecoil(entry, dt);
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
  ): void {
    Object.assign(this.localState, { x, z, heading, speed, sailState, vesselName, vesselSlug });
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

  private sendUpdate(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'update', ...this.localState }));
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
      console.log('[MP] remote cannon_shot received', msg, 'onRemoteShot set:', !!this.onRemoteShot);
      this.onRemoteShot?.(+msg.ox, +msg.oy, +msg.oz, +msg.vx, +msg.vy, +msg.vz);

    } else if (msg.type === 'friend_update') {
      this.myFriends.set(Array.isArray(msg.myFriends) ? msg.myFriends.map(String) : []);
      this.mutualFriends.set(Array.isArray(msg.mutuals) ? msg.mutuals.map(String) : []);

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

    if (!entry) {
      const root = new TransformNode('player_' + data.id, scene);
      root.position.y = this.REMOTE_FLOAT_Y;

      entry = {
        root,
        sailFullRoot:    null,
        sailReducedRoot: null,
        recoilRoll:      0,
        recoilRollVel:   0,
        id:         data.id,
        x:          0, z: 0, heading: 0, speed: 0,
        sailState:  'full',
        vesselName: 'Sloop', vesselSlug: 'sloop',
        callsign:   String(data.callsign ?? ''),
      };
      this.players.set(data.id, entry);

      const callsign = String(data.callsign ?? '').slice(0, 32);
      const slug     = String(data.vesselSlug ?? 'sloop').slice(0, 64);
      this.buildPlayerVessel(data.id, slug, callsign, entry, scene)
        .catch(err => console.warn('Multiplayer mesh build failed:', err));
    }

    entry.x         = +data.x        || 0;
    entry.z         = +data.z        || 0;
    entry.heading   = +data.heading  || 0;
    entry.speed     = +data.speed    || 0;
    entry.sailState = (['reefed','topsails','full'] as SailState[]).includes(data.sailState)
      ? data.sailState : 'full';
    entry.callsign   = String(data.callsign   ?? '').slice(0, 32);
    entry.vesselName = String(data.vesselName ?? 'Sloop').slice(0, 64);
    entry.vesselSlug = String(data.vesselSlug ?? 'sloop').slice(0, 64);

    // Update sail visibility to match remote player's current state
    entry.sailFullRoot?.setEnabled(entry.sailState === 'full');
    entry.sailReducedRoot?.setEnabled(entry.sailState === 'topsails');

    entry.root.position.x = entry.x;
    entry.root.position.z = entry.z;
    entry.root.position.y = this.REMOTE_FLOAT_Y;
    entry.root.rotation.y = entry.heading * Math.PI / 180;

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

  private disposeEntry(entry: OtherPlayerEntry): void {
    entry.root.getChildMeshes(false).forEach(m => (m as Mesh).dispose(false, true));
    entry.root.getChildTransformNodes(false).forEach(n => n.dispose());
    entry.root.dispose();
  }

  private publishSignal(): void {
    this.otherPlayers.set(
      Array.from(this.players.values()).map(
        ({ root: _r, sailFullRoot: _sf, sailReducedRoot: _sr, recoilRoll: _rr, recoilRollVel: _rv, ...p }) => p as OtherPlayer,
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
    entry.root.rotation.z = entry.recoilRoll;
  }

  // ── Visibility ────────────────────────────────────────────────────────────

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
    const baseUrl = Settings.apiUrl + 'geometry/';
    const prefix  = 'rp_' + playerId + '_';

    const loadGLB = async (
      filename: string, parent: TransformNode,
    ): Promise<TransformNode | null> => {
      try {
        const res = await SceneLoader.ImportMeshAsync('', baseUrl, filename, scene);
        if (!res.meshes.length) return null;
        const glbRoot = res.meshes[0];

        // Same 180° Y-flip the local VesselService applies
        const flipY = Quaternion.RotationAxis(Vector3.Up(), Math.PI);
        glbRoot.rotationQuaternion = glbRoot.rotationQuaternion
          ? flipY.multiply(glbRoot.rotationQuaternion)
          : flipY;

        glbRoot.parent = parent;
        for (const m of res.meshes) {
          m.renderingGroupId = 2;
          m.isPickable = false;
        }
        return glbRoot as unknown as TransformNode;
      } catch (err) {
        console.warn(`[Multiplayer] GLB load failed: ${filename}`, err);
        return null;
      }
    };

    // Hull (includes mast — same as local vessel)
    await loadGLB('sloop-hull.glb', entry.root);

    // Boom pivot — sails attach here so they can rotate with sail trim later
    const boomPivot = new TransformNode(prefix + 'boom', scene);
    boomPivot.parent = entry.root;

    // Sails — toggled by addOrUpdatePlayer() each state update
    entry.sailFullRoot    = await loadGLB('sloop-sail.glb',         boomPivot);
    entry.sailReducedRoot = await loadGLB('sloop-sail-reduced.glb', boomPivot);

    // Apply initial sail state (async build may land after several state updates)
    entry.sailFullRoot?.setEnabled(entry.sailState === 'full');
    entry.sailReducedRoot?.setEnabled(entry.sailState === 'topsails');

    // Snapshot of hull+sail meshes before the label is added (for shadow casting)
    const shadowMeshes = entry.root.getChildMeshes(false);

    // Callsign label (billboard above masthead)
    this.buildCallsignLabel(prefix + 'label', callsign, entry.root, scene);

    // Shadows
    const sg = this.sceneService.shadowGenerator;
    if (sg) {
      for (const m of shadowMeshes) {
        sg.addShadowCaster(m, true);
        m.receiveShadows = true;
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

    return plane;
  }
}
