import { Injectable, NgZone, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  MeshBuilder, Vector3, Color3, StandardMaterial, TransformNode,
  Mesh, Scene, DynamicTexture,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { WeatherService } from './weather.service';
import { OtherPlayer, SailState } from '../models';
import { Settings } from '../../app.settings';
import { firstValueFrom } from 'rxjs';

// ── OtherPlayerEntry holds everything for one remote vessel ───────────────────
interface OtherPlayerEntry extends OtherPlayer {
  root:   TransformNode;
  meshes: Mesh[];
}

// ── Simplified vessel-part shape used when building remote meshes ─────────────
interface RemotePart {
  id:       string;
  shape:    string;
  params:   Record<string, number | undefined>;
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  material: { color: string; specular?: string; alpha?: number; emissive?: string };
}

@Injectable({ providedIn: 'root' })
export class MultiplayerService {
  private sceneService  = inject(SceneService);
  private weatherService = inject(WeatherService);
  private zone          = inject(NgZone);
  private http          = inject(HttpClient);

  otherPlayers = signal<OtherPlayer[]>([]);

  private ws:          WebSocket | null = null;
  private myId:        string   | null = null;
  private players      = new Map<string, OtherPlayerEntry>();
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  // Vessel definition cache (slug → part list) so we only fetch once per type
  private vesselCache = new Map<string, RemotePart[]>();

  // Players beyond this world-unit radius are hidden (meshes disabled)
  private readonly VISIBILITY_RADIUS = 15_000;

  // Float height for remote vessels (calm-sea default; no bobbing on remotes)
  private readonly REMOTE_FLOAT_Y = 1.65;

  // Label plane dimensions in world units
  private readonly LABEL_WIDTH  = 7.5;
  private readonly LABEL_HEIGHT = 0.9;
  private readonly LABEL_Y      = 20;     // above vessel root (above masthead)

  // Current local state — kept updated by updateLocalState()
  private localState: Omit<OtherPlayer, 'id'> = {
    x: 0, z: 0, heading: 0, speed: 0,
    sailState: 'full', vesselName: 'Sloop', vesselSlug: 'sloop', callsign: 'Sailor',
  };

  // ── Connection ────────────────────────────────────────────────────────────

  connect(callsign: string): void {
    this.localState.callsign = callsign;
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
    // Re-evaluate visibility of all known players whenever we move
    if (this.sceneService.scene) this.refreshAllVisibility();
  }

  disconnect(): void {
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.ws?.close();
    for (const entry of this.players.values()) this.disposeEntry(entry);
    this.players.clear();
    this.otherPlayers.set([]);
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
      // Server-authoritative weather: sync all clients to the same sea state.
      this.weatherService.receiveServerState(msg.windBearing, msg.windSpeed);
    }
  }

  // ── Player lifecycle ──────────────────────────────────────────────────────

  private addOrUpdatePlayer(data: any, scene: Scene): void {
    let entry = this.players.get(data.id);

    if (!entry) {
      // Create a root immediately; mesh parts are attached asynchronously
      const root = new TransformNode('player_' + data.id, scene);
      root.position.y = this.REMOTE_FLOAT_Y;

      entry = {
        root, meshes: [],
        id:         data.id,
        x:          0, z: 0, heading: 0, speed: 0,
        sailState:  'full',
        vesselName: 'Sloop', vesselSlug: 'sloop',
        callsign:   String(data.callsign ?? ''),
      };
      this.players.set(data.id, entry);

      // Build full vessel mesh + label asynchronously
      const callsign  = String(data.callsign ?? '').slice(0, 32);
      const slug      = String(data.vesselSlug ?? 'sloop').slice(0, 64);
      this.buildPlayerVessel(data.id, slug, callsign, entry, scene)
        .catch(err => console.warn('Multiplayer mesh build failed:', err));
    }

    // Apply state updates
    entry.x         = +data.x        || 0;
    entry.z         = +data.z        || 0;
    entry.heading   = +data.heading  || 0;
    entry.speed     = +data.speed    || 0;
    entry.sailState = (['reefed','topsails','full'] as SailState[]).includes(data.sailState)
      ? data.sailState : 'full';
    entry.callsign  = String(data.callsign  ?? '').slice(0, 32);
    entry.vesselName = String(data.vesselName ?? 'Sloop').slice(0, 64);
    entry.vesselSlug = String(data.vesselSlug ?? 'sloop').slice(0, 64);

    // Move the root — everything parented to it follows automatically
    entry.root.position.x = entry.x;
    entry.root.position.z = entry.z;
    entry.root.position.y = this.REMOTE_FLOAT_Y;
    entry.root.rotation.y = entry.heading * Math.PI / 180;

    // Show/hide based on distance from local player
    this.applyVisibility(entry);

    // Publish signal for minimap / HUD consumers
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
    entry.meshes.forEach(m => { m.material?.dispose(); m.dispose(); });
    entry.root.dispose();
  }

  private publishSignal(): void {
    this.otherPlayers.set(
      Array.from(this.players.values()).map(
        ({ root: _r, meshes: _m, ...p }) => p as OtherPlayer,
      ),
    );
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
  // Fetches the vessel definition (with cache), creates one mesh per part,
  // parents everything to `entry.root`, and adds a floating callsign label.

  private async buildPlayerVessel(
    playerId: string, slug: string, callsign: string,
    entry: OtherPlayerEntry, scene: Scene,
  ): Promise<void> {
    // ── 1. Fetch / retrieve vessel part definitions ──────────────────────────
    if (!this.vesselCache.has(slug)) {
      const vessel: any = await firstValueFrom(
        this.http.get(`${Settings.apiUrl}vessels/${slug}`)
      );
      this.vesselCache.set(slug, vessel.parts as RemotePart[]);
    }
    const parts = this.vesselCache.get(slug)!;

    // ── 2. Build structural parts ────────────────────────────────────────────
    const prefix = 'rp_' + playerId + '_';
    const meshes: Mesh[] = [];

    for (const part of parts) {
      const mesh = this.buildRemotePart(prefix + part.id, part, entry.root, scene);
      meshes.push(mesh);
    }

    // ── 3. Add simplified static sails ──────────────────────────────────────
    const sailMeshes = this.buildRemoteSails(prefix, entry.root, scene);
    meshes.push(...sailMeshes);

    // ── 4. Add callsign label (billboard above the mast) ────────────────────
    const label = this.buildCallsignLabel(prefix + 'label', callsign, entry.root, scene);
    meshes.push(label);

    // Attach all to the entry so they can be disposed later
    entry.meshes.push(...meshes);
  }

  // ── Per-part mesh creation (mirrors VesselService.createPart) ────────────

  private buildRemotePart(
    name: string, part: RemotePart, root: TransformNode, scene: Scene,
  ): Mesh {
    let mesh: Mesh;
    const p = part.params;

    switch (part.shape) {
      case 'box':
        mesh = MeshBuilder.CreateBox(name, {
          width: p['width'], height: p['height'], depth: p['depth'],
        }, scene);
        break;
      case 'cylinder':
        mesh = MeshBuilder.CreateCylinder(name, {
          diameter: p['diameter'], height: p['height'],
          tessellation: p['tessellation'] ?? 8,
        }, scene);
        break;
      case 'sphere':
        mesh = MeshBuilder.CreateSphere(name, {
          diameter: p['diameter'],
          segments: p['tessellation'] ?? 8,
        }, scene);
        break;
      case 'torus':
        mesh = MeshBuilder.CreateTorus(name, {
          diameter:     p['diameter'],
          thickness:    p['thickness'] ?? 0.1,
          tessellation: p['tessellation'] ?? 16,
        }, scene);
        break;
      default:
        mesh = MeshBuilder.CreatePlane(name, {
          width: p['width'] ?? 1, height: p['height'] ?? 1,
          sideOrientation: Mesh.DOUBLESIDE,
        }, scene);
    }

    mesh.parent   = root;
    mesh.position = new Vector3(part.position.x, part.position.y, part.position.z);
    if (part.rotation) {
      mesh.rotation = new Vector3(part.rotation.x, part.rotation.y, part.rotation.z);
    }
    mesh.isPickable = false;

    const mat = new StandardMaterial(name + '_mat', scene);
    mat.diffuseColor  = Color3.FromHexString(part.material.color);
    mat.specularColor = Color3.FromHexString(part.material.specular ?? '#222222');
    if (part.material.alpha    !== undefined) mat.alpha          = part.material.alpha;
    if (part.material.emissive !== undefined) {
      mat.emissiveColor   = Color3.FromHexString(part.material.emissive);
      mat.disableLighting = false;
    }
    mesh.material = mat;

    return mesh;
  }

  // ── Simplified static sails for remote vessels ────────────────────────────
  // A semi-transparent mainsail plane + jib plane — enough to read as a sailboat.

  private buildRemoteSails(prefix: string, root: TransformNode, scene: Scene): Mesh[] {
    const sailColor = new Color3(0.96, 0.95, 0.88);
    const meshes: Mesh[] = [];

    // Mainsail: large rectangle from mast (z=1.5) sweeping aft, near the boom
    const mainSail = MeshBuilder.CreatePlane(prefix + 'mainsail', {
      width: 7.5, height: 13.0, sideOrientation: Mesh.DOUBLESIDE,
    }, scene);
    mainSail.parent   = root;
    mainSail.position = new Vector3(0, 8.5, -1.2);  // centred on the sail area
    mainSail.rotation = new Vector3(0, 0, 0);
    mainSail.isPickable = false;

    const mainMat = new StandardMaterial(prefix + 'mainsail_mat', scene);
    mainMat.diffuseColor  = sailColor;
    mainMat.alpha         = 0.88;
    mainMat.backFaceCulling = false;
    mainSail.material = mainMat;
    meshes.push(mainSail);

    // Jib: smaller plane forward of the mast
    const jib = MeshBuilder.CreatePlane(prefix + 'jib', {
      width: 4.0, height: 10.0, sideOrientation: Mesh.DOUBLESIDE,
    }, scene);
    jib.parent   = root;
    jib.position = new Vector3(0, 6.5, 4.5);
    jib.isPickable = false;

    const jibMat = new StandardMaterial(prefix + 'jib_mat', scene);
    jibMat.diffuseColor  = new Color3(0.95, 0.94, 0.86);
    jibMat.alpha         = 0.85;
    jibMat.backFaceCulling = false;
    jib.material = jibMat;
    meshes.push(jib);

    return meshes;
  }

  // ── Floating callsign label ───────────────────────────────────────────────
  // Renders into a DynamicTexture and mounts it on a BILLBOARDMODE_ALL plane
  // positioned above the masthead so it's always readable from any angle.

  private buildCallsignLabel(
    name: string, callsign: string, root: TransformNode, scene: Scene,
  ): Mesh {
    const texW = 512, texH = 80;

    const tex = new DynamicTexture(name + '_tex', { width: texW, height: texH }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;

    // Semi-transparent dark pill
    ctx.clearRect(0, 0, texW, texH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.beginPath();
    ctx.rect(10, 10, texW - 20, texH - 20);
    ctx.fill();

    // White callsign text
    ctx.fillStyle = '#FFFFFF';
    ctx.font      = 'bold 34px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(callsign.toUpperCase(), texW / 2, texH / 2);

    // Subtle bright border
    ctx.strokeStyle = 'rgba(130, 200, 255, 0.55)';
    ctx.lineWidth   = 2;
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
