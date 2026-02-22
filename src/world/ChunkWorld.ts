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

function createBuilding(scene: Scene, parent: TransformNode, rng: () => number, x: number, z: number) {
  const w = 4 + rng() * 6;
  const d = 4 + rng() * 6;
  const h = 6 + rng() * 20;

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
    const roadW = 5;
    const s = WorldConfig.CHUNK_SIZE;

    const roadX = MeshBuilder.CreateBox("roadX", { width: s, depth: roadW, height: 0.05 }, scene);
    roadX.parent = this.root;
    roadX.position.y = 0.025;
    roadX.material = roadMat;

    const roadZ = MeshBuilder.CreateBox("roadZ", { width: roadW, depth: s, height: 0.05 }, scene);
    roadZ.parent = this.root;
    roadZ.position.y = 0.025;
    roadZ.material = roadMat;

    // Buildings: place on 2x2 blocks around the road cross
    const block = s / 2;
    const margin = 10;

    const spots = [
      { x: -block / 2, z: -block / 2 },
      { x: block / 2, z: -block / 2 },
      { x: -block / 2, z: block / 2 },
      { x: block / 2, z: block / 2 },
    ];

    for (const sp of spots) {
      // Each block gets 2-4 buildings
      const count = 1 + Math.floor(rng() * 3); // 1-3
      for (let i = 0; i < count; i++) {
        const bx = sp.x + (rng() - 0.5) * (block - margin);
        const bz = sp.z + (rng() - 0.5) * (block - margin);
        const built = createBuilding(scene, this.root, rng, bx, bz);
        // Add thin instances for this building
        if (built.windows.length) {
          this.windowMesh.thinInstanceAdd(built.windows);
        }

        // Store LOD handles
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
