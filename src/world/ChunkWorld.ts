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
    // NOTE: Intersection area usually has no lane lines. We draw segmented lines and leave a clean center box.
    const markWhite = getOrCreateMat(scene, "mat_road_mark_white", new Color3(0.92, 0.92, 0.92), new Color3(0.55, 0.55, 0.55));
    const markYellow = getOrCreateMat(scene, "mat_road_mark_yellow", new Color3(0.92, 0.82, 0.20), new Color3(0.55, 0.48, 0.10));
    const poleMat = getOrCreateMat(scene, "mat_signal_pole", new Color3(0.10, 0.10, 0.10));
    const lightRedMat = getOrCreateMat(scene, "mat_signal_red", new Color3(0.15, 0.02, 0.02), new Color3(0.95, 0.10, 0.10));
    const lightGreenMat = getOrCreateMat(scene, "mat_signal_green", new Color3(0.02, 0.15, 0.02), new Color3(0.12, 0.95, 0.18));
    const lightYellowMat = getOrCreateMat(scene, "mat_signal_yellow", new Color3(0.15, 0.12, 0.02), new Color3(0.95, 0.82, 0.12));

    const markH = 0.012;
    const lineW = 0.22;

    // Intersection clear area (no lane lines here)
    const intersectionHalf = roadW * 0.5 + 1.0;
    const segLen = Math.max(2, (s * 0.5) - intersectionHalf);

    const makeXLineSeg = (name: string, z: number, mat: StandardMaterial) => {
      // Two segments along X, leaving a gap around the intersection
      const seg = MeshBuilder.CreateBox(name, { width: segLen, depth: lineW, height: markH }, scene);
      seg.parent = this.root;
      seg.position = new Vector3(-(intersectionHalf + segLen * 0.5), 0.05 + markH * 0.5, z);
      seg.material = mat;

      const seg2 = seg.clone(name + "_b") as Mesh;
      seg2.parent = this.root;
      seg2.position.x = (intersectionHalf + segLen * 0.5);
      return [seg, seg2];
    };

    const makeZLineSeg = (name: string, x: number, mat: StandardMaterial) => {
      // Two segments along Z, leaving a gap around the intersection
      const seg = MeshBuilder.CreateBox(name, { width: lineW, depth: segLen, height: markH }, scene);
      seg.parent = this.root;
      seg.position = new Vector3(x, 0.05 + markH * 0.5, -(intersectionHalf + segLen * 0.5));
      seg.material = mat;

      const seg2 = seg.clone(name + "_b") as Mesh;
      seg2.parent = this.root;
      seg2.position.z = (intersectionHalf + segLen * 0.5);
      return [seg, seg2];
    };

    // Center lines (yellow)
    makeXLineSeg("centerLineX", 0, markYellow);
    makeZLineSeg("centerLineZ", 0, markYellow);

    // Lane separators (white) for 4 lanes total (2 each direction)
    const laneOff = roadW * 0.25; // between lanes per direction
    const edgeOff = roadW * 0.5 - 0.35; // road edge highlight

    makeXLineSeg("laneX1", laneOff, markWhite);
    makeXLineSeg("laneX2", -laneOff, markWhite);
    makeXLineSeg("edgeX1", edgeOff, markWhite);
    makeXLineSeg("edgeX2", -edgeOff, markWhite);

    makeZLineSeg("laneZ1", laneOff, markWhite);
    makeZLineSeg("laneZ2", -laneOff, markWhite);
    makeZLineSeg("edgeZ1", edgeOff, markWhite);
    makeZLineSeg("edgeZ2", -edgeOff, markWhite);

    // Crosswalks (zebra) near the intersection (4 sides)
    // Place them just outside the clear intersection box, like real junctions.
    const cwDepth = 3.2;           // thickness along the walking direction
    const cwLength = roadW + 0.6;  // across the road
    const stripeW = 0.45;
    const stripeGap = 0.30;
    const stripeCount = Math.max(7, Math.floor(cwLength / (stripeW + stripeGap)));

    const makeCrosswalkX = (centerX: number, centerZ: number) => {
      // Pedestrians cross along X (across the vertical road). Stripes extend along Z.
      for (let k = 0; k < stripeCount; k++) {
        const t = (k - (stripeCount - 1) * 0.5) * (stripeW + stripeGap);
        const stripe = MeshBuilder.CreateBox("cwStripeX", { width: cwDepth, depth: stripeW, height: markH }, scene);
        stripe.parent = this.root;
        stripe.position.y = 0.05 + markH * 0.5;
        stripe.position.x = centerX;
        stripe.position.z = centerZ + t;
        stripe.material = markWhite;
      }
    };

    const makeCrosswalkZ = (centerX: number, centerZ: number) => {
      // Pedestrians cross along Z (across the horizontal road). Stripes extend along X.
      for (let k = 0; k < stripeCount; k++) {
        const t = (k - (stripeCount - 1) * 0.5) * (stripeW + stripeGap);
        const stripe = MeshBuilder.CreateBox("cwStripeZ", { width: stripeW, depth: cwDepth, height: markH }, scene);
        stripe.parent = this.root;
        stripe.position.y = 0.05 + markH * 0.5;
        stripe.position.x = centerX + t;
        stripe.position.z = centerZ;
        stripe.material = markWhite;
      }
    };

    const cwFromIntersection = 0.9;
    const cwCenter = intersectionHalf + (cwDepth * 0.5) + cwFromIntersection;

    // North/South crosswalks across the X-road (pedestrians cross Z)
    makeCrosswalkZ(0, cwCenter);
    makeCrosswalkZ(0, -cwCenter);

    // East/West crosswalks across the Z-road (pedestrians cross X)
    makeCrosswalkX(cwCenter, 0);
    makeCrosswalkX(-cwCenter, 0);

    // Traffic lights (animated, real-like phasing: NS green -> yellow -> all-red -> EW green -> yellow -> all-red)
    type SignalPhase = "NS" | "EW";
    const makeSignal = (x: number, z: number, phase: SignalPhase) => {
      const pole = MeshBuilder.CreateBox("sigPole", { width: 0.22, depth: 0.22, height: 4.2 }, scene);
      pole.parent = this.root;
      pole.position = new Vector3(x, 2.1, z);
      pole.material = poleMat;

      const head = MeshBuilder.CreateBox("sigHead", { width: 0.48, depth: 0.28, height: 0.95 }, scene);
      head.parent = this.root;
      head.position = new Vector3(x, 3.60, z);
      head.material = poleMat;

      const lampR = MeshBuilder.CreateBox("sigLampR", { width: 0.22, depth: 0.06, height: 0.22 }, scene);
      lampR.parent = this.root;
      lampR.position = new Vector3(x, 3.72, z + 0.17);
      lampR.material = lightRedMat;

      const lampY = MeshBuilder.CreateBox("sigLampY", { width: 0.22, depth: 0.06, height: 0.22 }, scene);
      lampY.parent = this.root;
      lampY.position = new Vector3(x, 3.60, z + 0.17);
      lampY.material = lightYellowMat;

      const lampG = MeshBuilder.CreateBox("sigLampG", { width: 0.22, depth: 0.06, height: 0.22 }, scene);
      lampG.parent = this.root;
      lampG.position = new Vector3(x, 3.48, z + 0.17);
      lampG.material = lightGreenMat;

      // Register to the global controller so every chunk's lights stay in sync.
      ChunkWorld.registerSignal({ phase, red: lampR, yellow: lampY, green: lampG });
    };

    const corner = roadW * 0.5 + sidewalkW + 0.9;
    // Place them at 4 corners; which direction they control is simplified by corner quadrant.
    makeSignal(corner, corner, "NS");
    makeSignal(-corner, corner, "EW");
    makeSignal(corner, -corner, "EW");
    makeSignal(-corner, -corner, "NS");
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
  // --- Global traffic signal controller (keeps all chunks in sync) ---
  private static _signals: Array<{ phase: "NS" | "EW"; red: Mesh; yellow: Mesh; green: Mesh }> = [];
  private static _sigT = 0;

  static registerSignal(s: { phase: "NS" | "EW"; red: Mesh; yellow: Mesh; green: Mesh }) {
    this._signals.push(s);
    // start in a sane state
    s.red.setEnabled(true);
    s.yellow.setEnabled(false);
    s.green.setEnabled(false);
  }

  private static _setLamp(s: { red: Mesh; yellow: Mesh; green: Mesh }, r: boolean, y: boolean, g: boolean) {
    s.red.setEnabled(r);
    s.yellow.setEnabled(y);
    s.green.setEnabled(g);
  }

  private static updateSignals(dt: number) {
    // Phase timings (seconds)
    const NS_GREEN = 10;
    const NS_YELLOW = 2;
    const ALL_RED_1 = 1;
    const EW_GREEN = 10;
    const EW_YELLOW = 2;
    const ALL_RED_2 = 1;

    const cycle = NS_GREEN + NS_YELLOW + ALL_RED_1 + EW_GREEN + EW_YELLOW + ALL_RED_2;
    this._sigT = (this._sigT + dt) % cycle;

    const t = this._sigT;
    const inNSGreen = t < NS_GREEN;
    const inNSYellow = t >= NS_GREEN && t < NS_GREEN + NS_YELLOW;
    const inAllRed1 = t >= NS_GREEN + NS_YELLOW && t < NS_GREEN + NS_YELLOW + ALL_RED_1;
    const inEWGreen = t >= NS_GREEN + NS_YELLOW + ALL_RED_1 && t < NS_GREEN + NS_YELLOW + ALL_RED_1 + EW_GREEN;
    const inEWYellow = t >= NS_GREEN + NS_YELLOW + ALL_RED_1 + EW_GREEN && t < NS_GREEN + NS_YELLOW + ALL_RED_1 + EW_GREEN + EW_YELLOW;
    // else -> all red 2

    for (const s of this._signals) {
      const isNS = s.phase === "NS";
      if (inAllRed1 || (!inNSGreen && !inNSYellow && !inEWGreen && !inEWYellow)) {
        // all red
        this._setLamp(s, true, false, false);
      } else if (inNSGreen) {
        this._setLamp(s, !isNS, false, isNS);
      } else if (inNSYellow) {
        this._setLamp(s, !isNS, isNS, false);
      } else if (inEWGreen) {
        this._setLamp(s, isNS, false, !isNS);
      } else if (inEWYellow) {
        this._setLamp(s, isNS, !isNS, false);
      } else {
        this._setLamp(s, true, false, false);
      }
    }
  }


  private loaded = new Map<ChunkKey, Chunk>();
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  update(playerPos: Vector3) {
    // drive traffic light animation
    const dt = this.scene.getEngine().getDeltaTime() * 0.001;
    ChunkWorld.updateSignals(dt);

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
