import {
  MeshBuilder,
  Scene,
  TransformNode,
  Vector3,
  StandardMaterial,
  Color3,
  Mesh,
  Matrix,
  Quaternion,
} from "@babylonjs/core";
import { WorldConfig } from "./WorldConfig";

type ChunkKey = string;

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getOrCreateMat(scene: Scene, name: string, diffuse: Color3, emissive?: Color3) {
  const existing = scene.getMaterialByName(name) as StandardMaterial | null;
  if (existing) return existing;

  const m = new StandardMaterial(name, scene);
  m.diffuseColor = diffuse;
  if (emissive) m.emissiveColor = emissive;
  return m;
}

function createBuilding(
  scene: Scene,
  parent: TransformNode,
  rng: () => number,
  x: number,
  z: number,
  dims?: { w: number; d: number; h: number }
) {
  const w = dims?.w ?? (4 + rng() * 6);
  const d = dims?.d ?? (4 + rng() * 6);
  const h = dims?.h ?? (6 + rng() * 20);

  // Building root
  const root = new TransformNode("bRoot", scene);
  root.parent = parent;
  root.position = new Vector3(x, 0, z);

  // Detailed mesh group
  const detail = new TransformNode("bDetail", scene);
  detail.parent = root;

  const base = MeshBuilder.CreateBox("building", { width: w, depth: d, height: h }, scene);
  base.parent = detail;
  base.position = new Vector3(0, h / 2, 0);

  // Building material (a few muted variants)
  const palette = [
    new Color3(0.78, 0.78, 0.80),
    new Color3(0.75, 0.70, 0.62),
    new Color3(0.65, 0.70, 0.76),
    new Color3(0.70, 0.66, 0.72),
  ];
  const c = palette[Math.floor(rng() * palette.length)];
  base.material = getOrCreateMat(scene, `mat_building_${c.toHexString()}`, c);
  base.isPickable = true;

  // Roof (slightly taller lip)
  const roofH = 0.6 + rng() * 0.8;
  const roof = MeshBuilder.CreateBox("roof", { width: w + 0.25, depth: d + 0.25, height: roofH }, scene);
  roof.parent = detail;
  roof.position = new Vector3(0, h + roofH / 2, 0);
  roof.material = getOrCreateMat(scene, "mat_roof", new Color3(0.18, 0.18, 0.2));

  // Door (front side, -Z)
  const doorW = Math.min(1.6, w * 0.25);
  const doorH = Math.min(2.4, h * 0.22);
  const door = MeshBuilder.CreateBox("door", { width: doorW, height: doorH, depth: 0.12 }, scene);
  door.parent = detail;
  door.position = new Vector3(0, doorH / 2, -d / 2 - 0.06);
  door.material = getOrCreateMat(scene, "mat_door", new Color3(0.22, 0.13, 0.06));

  // Windows are created as thin instances at the CHUNK level for performance.
  // We only return matrices for the caller to add to its window mesh.

  const windows: Matrix[] = [];

  const floors = Math.max(2, Math.floor(h / 2.6));
  const cols = Math.max(2, Math.floor(w / 1.6));
  const rows = floors;

  let idx = 0;
  const yStart = 1.6;
  for (let r = 0; r < rows; r++) {
    const y = yStart + r * 2.2;
    if (y > h - 1.2) break;

    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const xOff = -w / 2 + 1.0 + cIdx * 1.5;
      if (xOff > w / 2 - 1.0) break;

      // Randomly skip more windows for performance + variation
      if (rng() < WorldConfig.WINDOW_SKIP_FRONT) continue;

      const localF = new Vector3(xOff, y, -d / 2 - 0.04);
      const localB = new Vector3(xOff, y, d / 2 + 0.04);
      windows.push(Matrix.Translation(root.position.x + localF.x, localF.y, root.position.z + localF.z));
      windows.push(Matrix.Translation(root.position.x + localB.x, localB.y, root.position.z + localB.z));
    }

    // Side windows
    const sideCols = Math.max(2, Math.floor(d / 1.6));
    for (let sIdx = 0; sIdx < sideCols; sIdx++) {
      const zOff = -d / 2 + 1.0 + sIdx * 1.5;
      if (zOff > d / 2 - 1.0) break;
      if (rng() < WorldConfig.WINDOW_SKIP_SIDE) continue;

      const leftPos = new Vector3(-w / 2 - 0.04, y, zOff);
      const rightPos = new Vector3(w / 2 + 0.04, y, zOff);
      const q = Quaternion.FromEulerAngles(0, Math.PI / 2, 0);
      const lT = Matrix.Compose(Vector3.One(), q, new Vector3(root.position.x + leftPos.x, leftPos.y, root.position.z + leftPos.z));
      const rT = Matrix.Compose(Vector3.One(), q, new Vector3(root.position.x + rightPos.x, rightPos.y, root.position.z + rightPos.z));
      windows.push(lT);
      windows.push(rT);
    }
  }

  // Simple far LOD mesh (no windows/roof/door)
  const simple = MeshBuilder.CreateBox("building_simple", { width: w, depth: d, height: h }, scene);
  simple.parent = root;
  simple.position = new Vector3(0, h / 2, 0);
  simple.material = base.material;
  simple.isPickable = true;
  simple.setEnabled(false);

  return { root, detail, simple, windows };
}

function createChunkWindowMesh(scene: Scene, parent: TransformNode) {
  const winMat = getOrCreateMat(scene, "mat_window", new Color3(0.12, 0.18, 0.22), new Color3(0.06, 0.08, 0.1));
  const mesh = MeshBuilder.CreateBox("winThin", { width: 0.7, height: 0.7, depth: 0.06 }, scene);
  mesh.material = winMat;
  mesh.isPickable = false;
  mesh.parent = parent;

  // Hide the base mesh by moving it far below; thin instances will still render.
  mesh.position.y = -100000;
  return mesh;
}

type BuildingLOD = {
  root: TransformNode;
  detail: TransformNode;
  simple: Mesh;
  center: Vector3;
};

class Chunk {
  root: TransformNode;
  private windowMesh: Mesh;
  private buildings: BuildingLOD[] = [];
  public scene: Scene;

  constructor(scene: Scene, cx: number, cz: number) {
    this.scene = scene;
    this.root = new TransformNode(`chunk_${cx}_${cz}`, scene);
    this.windowMesh = createChunkWindowMesh(scene, this.root);

    const seed = (cx * 73856093) ^ (cz * 19349663) ^ 0x9e3779b9;
    const rng = mulberry32(seed);

    // A simple "road cross" so chunks look like a city grid
    const roadMat = getOrCreateMat(scene, "mat_road", new Color3(0.12, 0.12, 0.12));
    const roadW = 12;
    const s = WorldConfig.CHUNK_SIZE;

    const roadX = MeshBuilder.CreateBox("roadX", { width: s, depth: roadW, height: 0.05 }, scene);
    roadX.parent = this.root;
    roadX.position.y = 0.025;
    roadX.material = roadMat;

    const roadZ = MeshBuilder.CreateBox("roadZ", { width: roadW, depth: s, height: 0.05 }, scene);
    roadZ.parent = this.root;
    roadZ.position.y = 0.025;
    roadZ.material = roadMat;

    // Sidewalks (NPCs can walk here)
    const sidewalkW = 4.0;
    const sidewalkMat = getOrCreateMat(scene, "mat_sidewalk", new Color3(0.42, 0.42, 0.44));
    const halfRoad = roadW * 0.5;
    const sideH = 0.04;

    const sideX1 = MeshBuilder.CreateBox("sideX1", { width: s, depth: sidewalkW, height: sideH }, scene);
    sideX1.parent = this.root;
    sideX1.position = new Vector3(0, sideH * 0.5, halfRoad + sidewalkW * 0.5);
    sideX1.material = sidewalkMat;

    const sideX2 = sideX1.clone("sideX2") as Mesh;
    sideX2.parent = this.root;
    sideX2.position.z = -(halfRoad + sidewalkW * 0.5);

    const sideZ1 = MeshBuilder.CreateBox("sideZ1", { width: sidewalkW, depth: s, height: sideH }, scene);
    sideZ1.parent = this.root;
    sideZ1.position = new Vector3(halfRoad + sidewalkW * 0.5, sideH * 0.5, 0);
    sideZ1.material = sidewalkMat;

    const sideZ2 = sideZ1.clone("sideZ2") as Mesh;
    sideZ2.parent = this.root;
    sideZ2.position.x = -(halfRoad + sidewalkW * 0.5);



    // --- Road markings / crosswalk / traffic lights (cheap city feel) ---
    const markWhite = getOrCreateMat(scene, "mat_road_mark_white", new Color3(0.92, 0.92, 0.92), new Color3(0.55, 0.55, 0.55));
    const markYellow = getOrCreateMat(scene, "mat_road_mark_yellow", new Color3(0.92, 0.82, 0.20), new Color3(0.55, 0.48, 0.10));
    const poleMat = getOrCreateMat(scene, "mat_signal_pole", new Color3(0.10, 0.10, 0.10));
    const lightRed = getOrCreateMat(scene, "mat_signal_red", new Color3(0.15, 0.02, 0.02), new Color3(0.95, 0.10, 0.10));
    const lightGreen = getOrCreateMat(scene, "mat_signal_green", new Color3(0.02, 0.15, 0.02), new Color3(0.12, 0.95, 0.18));

    const markH = 0.012;
    const lineW = 0.22;

    // Center lines (yellow)
    const cLineX = MeshBuilder.CreateBox("centerLineX", { width: s, depth: lineW, height: markH }, scene);
    cLineX.parent = this.root;
    cLineX.position = new Vector3(0, 0.05 + markH * 0.5, 0);
    cLineX.material = markYellow;

    const cLineZ = MeshBuilder.CreateBox("centerLineZ", { width: lineW, depth: s, height: markH }, scene);
    cLineZ.parent = this.root;
    cLineZ.position = new Vector3(0, 0.05 + markH * 0.5, 0);
    cLineZ.material = markYellow;

    // Lane separators (white) for 4 lanes total (2 each direction)
    const laneOff = roadW * 0.25; // between lanes per direction
    const edgeOff = roadW * 0.5 - 0.35; // road edge highlight

    const laneX1 = MeshBuilder.CreateBox("laneX1", { width: s, depth: lineW, height: markH }, scene);
    laneX1.parent = this.root;
    laneX1.position = new Vector3(0, 0.05 + markH * 0.5, laneOff);
    laneX1.material = markWhite;

    const laneX2 = laneX1.clone("laneX2") as Mesh;
    laneX2.parent = this.root;
    laneX2.position.z = -laneOff;

    const edgeX1 = laneX1.clone("edgeX1") as Mesh;
    edgeX1.parent = this.root;
    edgeX1.position.z = edgeOff;

    const edgeX2 = laneX1.clone("edgeX2") as Mesh;
    edgeX2.parent = this.root;
    edgeX2.position.z = -edgeOff;

    const laneZ1 = MeshBuilder.CreateBox("laneZ1", { width: lineW, depth: s, height: markH }, scene);
    laneZ1.parent = this.root;
    laneZ1.position = new Vector3(laneOff, 0.05 + markH * 0.5, 0);
    laneZ1.material = markWhite;

    const laneZ2 = laneZ1.clone("laneZ2") as Mesh;
    laneZ2.parent = this.root;
    laneZ2.position.x = -laneOff;

    const edgeZ1 = laneZ1.clone("edgeZ1") as Mesh;
    edgeZ1.parent = this.root;
    edgeZ1.position.x = edgeOff;

    const edgeZ2 = laneZ1.clone("edgeZ2") as Mesh;
    edgeZ2.parent = this.root;
    edgeZ2.position.x = -edgeOff;

    // Crosswalks (zebra) near intersection (4 sides)
    const cwOffset = 8;
    const cwWidth = 6;
    const cwStripeW = 0.55;
    const cwStripeGap = 0.35;
    const stripes = 9;

    const makeCrosswalk = (centerX: number, centerZ: number, alongX: boolean) => {
      // alongX=true => stripes extend in X (pedestrians cross Z)
      for (let k = 0; k < stripes; k++) {
        const t = (k - (stripes - 1) * 0.5) * (cwStripeW + cwStripeGap);
        const w = alongX ? cwWidth : cwStripeW;
        const d = alongX ? cwStripeW : cwWidth;
        const stripe = MeshBuilder.CreateBox("cwStripe", { width: w, depth: d, height: markH }, scene);
        stripe.parent = this.root;
        stripe.position.y = 0.05 + markH * 0.5;
        stripe.position.x = centerX + (alongX ? t : 0);
        stripe.position.z = centerZ + (alongX ? 0 : t);
        stripe.material = markWhite;
      }
    };

    // Pedestrians cross the horizontal road (roadX) at x=±cwOffset (cross Z)
    makeCrosswalk(cwOffset, 0, true);
    makeCrosswalk(-cwOffset, 0, true);
    // Pedestrians cross the vertical road (roadZ) at z=±cwOffset (cross X)
    makeCrosswalk(0, cwOffset, false);
    makeCrosswalk(0, -cwOffset, false);

    // Simple traffic lights at 4 corners (static red/green for vibe)
    const makeSignal = (x: number, z: number, green: boolean) => {
      const pole = MeshBuilder.CreateBox("sigPole", { width: 0.22, depth: 0.22, height: 4.2 }, scene);
      pole.parent = this.root;
      pole.position = new Vector3(x, 2.1, z);
      pole.material = poleMat;

      const head = MeshBuilder.CreateBox("sigHead", { width: 0.42, depth: 0.28, height: 0.85 }, scene);
      head.parent = this.root;
      head.position = new Vector3(x, 3.55, z);
      head.material = poleMat;

      const lamp = MeshBuilder.CreateBox("sigLamp", { width: 0.22, depth: 0.05, height: 0.22 }, scene);
      lamp.parent = this.root;
      lamp.position = new Vector3(x, 3.55, z + 0.17);
      lamp.material = green ? lightGreen : lightRed;
    };

    const corner = roadW * 0.5 + 1.3;
    makeSignal(corner, corner, false);
    makeSignal(-corner, corner, true);
    makeSignal(corner, -corner, true);
    makeSignal(-corner, -corner, false);

    // Buildings: place ONLY on buildable land (green lots), never on sidewalks/roads
    const block = s / 2;
    const margin = 10;

    // Buildable lots (1 per quadrant)
    const lotMat = getOrCreateMat(scene, "mat_lot", new Color3(0.18, 0.28, 0.16));
    const lotSetback = (roadW * 0.5) + sidewalkW + 2.0; // keep buildings away from sidewalks
    const lotMargin = 6.0;

    const lotMax = block - lotMargin;
    const lotSize = Math.max(8, lotMax - lotSetback);
    const lotH = 0.03;

    type Lot = { minX: number; maxX: number; minZ: number; maxZ: number };
    const lots: Lot[] = [];

    const makeLot = (sx: number, sz: number) => {
      // sx/sz are ±1 quadrant signs
      const minX = sx > 0 ? lotSetback : -lotMax;
      const maxX = sx > 0 ? lotMax : -lotSetback;
      const minZ = sz > 0 ? lotSetback : -lotMax;
      const maxZ = sz > 0 ? lotMax : -lotSetback;

      const cxLot = (minX + maxX) * 0.5;
      const czLot = (minZ + maxZ) * 0.5;

      const lot = MeshBuilder.CreateBox("buildableLot", { width: lotSize, depth: lotSize, height: lotH }, scene);
      lot.parent = this.root;
      lot.position = new Vector3(cxLot, lotH * 0.5, czLot);
      lot.material = lotMat;
      lot.isPickable = false;

      lots.push({ minX, maxX, minZ, maxZ });
    };

    makeLot(-1, -1);
    makeLot(1, -1);
    makeLot(-1, 1);
    makeLot(1, 1);

    // Non-overlap placement (AABB)
    type Footprint = { x: number; z: number; w: number; d: number };
    const placed: Footprint[] = [];
    const pad = 1.6;

    const overlaps = (a: Footprint, b: Footprint) => {
      return (
        Math.abs(a.x - b.x) < (a.w + b.w) * 0.5 + pad &&
        Math.abs(a.z - b.z) < (a.d + b.d) * 0.5 + pad
      );
    };

    const tryPlaceInLot = (lot: Lot, w: number, d: number) => {
      for (let t = 0; t < 28; t++) {
        const x = (lot.minX + w * 0.5) + ((lot.maxX - w * 0.5) - (lot.minX + w * 0.5)) * rng();
        const z = (lot.minZ + d * 0.5) + ((lot.maxZ - d * 0.5) - (lot.minZ + d * 0.5)) * rng();
        const fp = { x, z, w, d };
        let ok = true;
        for (const p of placed) {
          if (overlaps(fp, p)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        placed.push(fp);
        return { x, z };
      }
      return null;
    };

    for (const lot of lots) {
      const count = 2 + Math.floor(rng() * 4); // 2-5 per lot
      for (let i = 0; i < count; i++) {
        const w = 5 + rng() * 8;
        const d = 5 + rng() * 8;
        const h = 8 + rng() * 24;

        const pos = tryPlaceInLot(lot, w, d);
        if (!pos) continue;

        const built = createBuilding(scene, this.root, rng, pos.x, pos.z, { w, d, h });
        if (built.windows.length) {
          this.windowMesh.thinInstanceAdd(built.windows);
        }
        const center = new Vector3(
          this.root.position.x + built.root.position.x,
          0,
          this.root.position.z + built.root.position.z
        );
        this.buildings.push({
          root: built.root,
          detail: built.detail,
          simple: built.simple,
          center,
        });
      }
    }

    this.root.position.x = cx * WorldConfig.CHUNK_SIZE;
    this.root.position.z = cz * WorldConfig.CHUNK_SIZE;
  }

  updateLOD(playerPos: Vector3) {
    const lodDist = WorldConfig.BUILDING_DETAIL_LOD_DIST;
    const lodDist2 = lodDist * lodDist;
    for (const b of this.buildings) {
      const dx = (this.root.position.x + b.root.position.x) - playerPos.x;
      const dz = (this.root.position.z + b.root.position.z) - playerPos.z;
      const d2 = dx * dx + dz * dz;
      const near = d2 <= lodDist2;
      b.detail.setEnabled(near);
      b.simple.setEnabled(!near);
    }
  }

  dispose() {
    this.root.getChildMeshes().forEach((m) => m.dispose());
    this.root.dispose();
  }
}

export class ChunkWorld {
  private loaded = new Map<ChunkKey, Chunk>();
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  update(playerPos: Vector3) {
    const cx = Math.floor(playerPos.x / WorldConfig.CHUNK_SIZE);
    const cz = Math.floor(playerPos.z / WorldConfig.CHUNK_SIZE);

    const r = WorldConfig.FAR_RADIUS;
    const want = new Set<string>();

    for (let z = cz - r; z <= cz + r; z++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const key = `${x}:${z}`;
        want.add(key);
        if (!this.loaded.has(key)) {
          this.loaded.set(key, new Chunk(this.scene, x, z));
        }
      }
    }

    for (const [key, chunk] of this.loaded) {
      if (!want.has(key)) {
        chunk.dispose();
        this.loaded.delete(key);
      } else {
        chunk.updateLOD(playerPos);
      }
    }
  }
}
