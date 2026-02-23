import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { WorldConfig } from "../world/WorldConfig";

type Tier = "sim" | "crowd" | "fake";

type SimNPC = {
  root: TransformNode;
  torso: Mesh;
  head: Mesh;
  armL: Mesh;
  armR: Mesh;
  legL: Mesh;
  legR: Mesh;

  target: Vector3;
  speed: number;
  phase: number;
  walk: number;
  mode: "walk" | "idle";
  idleLeft: number;
  idlePhase: number;
  desiredYaw: number;
  yaw: number;
  prevPos: Vector3;
  fade: number;
  moveRampLeft: number; // 0.3s ramp after spawn/handoff
  waypoints: Vector3[];
  wpIndex: number;
  behavior: "normal" | "runner" | "phone";
  obeyTraffic: boolean;
  phonePauseLeft: number;
  stumbleT: number;
  stumblePhase: number;
  hitSfxCooldown: number;

};

type ThinGroup = {
  proto: Mesh;
  baseColor: Color3;
  pos: Float32Array;
  yaw: Float32Array;
  speed: Float32Array;
  phase: Float32Array;
  fadeMul: Float32Array;
  fadeOutLeft: Float32Array;
  suppressLeft: Float32Array;
  lockLeft: Float32Array; // prevents teleport/repel while pending handoff
  matrices: Float32Array;
  colors: Float32Array;
  count: number;
  logicAcc: number;
  refreshAcc: number;
};

export class NPCManager {
  private sim: SimNPC[] = [];
  private crowd!: ThinGroup;
  private fake!: ThinGroup;

  private simSkinMat: StandardMaterial;
  private simShirtMat: StandardMaterial;
  private simPantsMat: StandardMaterial;

  private thinMatCache = new Map<string, StandardMaterial>();
  private seed = 1337;
  private scene: Scene;

  private lastPlayerPos = new Vector3(Number.NaN, 0, Number.NaN);
  private playerSpeed = 0;

  // Cross-fade / handoff tuning
  private handoffAcc = 0;
  private readonly HANDOFF_HZ = 6;
  private readonly HANDOFF_DIST = 6;
  private readonly HANDOFF_MAX_PER_STEP = 100;
  private readonly CROWD_SUPPRESS_SEC = 1.0;
  private readonly CROWD_FADE_OUT_SEC = 0.22;
  private readonly SIM_FADE_IN_SEC = 0.28;
  private readonly SIM_MOVE_RAMP_SEC = 0.30;
  private readonly ROAD_W = 12; // must match ChunkWorld roadW
  private readonly SIDEWALK_W = 4.0; // must match ChunkWorld sidewalkW
  private readonly ROAD_THRESHOLD = 10.5; // roadW/2 + sidewalkW + small margin
  private readonly CROSSWALK_OFFSET = 9.5; // must match ChunkWorld crosswalk center (intersectionHalf + cwDepth/2 + offset)
  private readonly CROSSWALK_WIDTH = 3.2; // must match ChunkWorld cwDepth (thickness)
  private readonly CROWD_FADE_IN_SPEED = 3.5;


  // Simple traffic signal (global, deterministic):
  // - 0..8s: cars X-direction green (pedestrians crossing E-W allowed)
  // - 8..16s: cars Z-direction green (pedestrians crossing N-S allowed)
  private trafficCarsXGreen(tSec: number) {
    const phase = tSec % 16;
    return phase < 8;
  }

  private canPedCrossNS(tSec: number) {
    // N-S crossing goes over the X-road; allowed when cars X are NOT green
    return !this.trafficCarsXGreen(tSec);
  }

  private canPedCrossEW(tSec: number) {
    // E-W crossing goes over the Z-road; allowed when cars X ARE green
    return this.trafficCarsXGreen(tSec);
  }

  private isCrosswalkEntry(wp: Vector3, next: Vector3): "NS" | "EW" | null {
    const halfRoad = this.ROAD_W * 0.5;
    const pad = 0.6;
    // NS: x near ±CROSSWALK_OFFSET and heading toward z=0
    const isNS =
      Math.abs(Math.abs(wp.x) - this.CROSSWALK_OFFSET) < 0.85 &&
      Math.abs(next.x - wp.x) < 0.25 &&
      Math.abs(next.z) < 0.25 &&
      Math.abs(Math.abs(wp.z) - (halfRoad + pad)) < 1.25;

    if (isNS) return "NS";

    // EW: z near ±CROSSWALK_OFFSET and heading toward x=0
    const isEW =
      Math.abs(Math.abs(wp.z) - this.CROSSWALK_OFFSET) < 0.85 &&
      Math.abs(next.z - wp.z) < 0.25 &&
      Math.abs(next.x) < 0.25 &&
      Math.abs(Math.abs(wp.x) - (halfRoad + pad)) < 1.25;

    if (isEW) return "EW";
    return null;
  }

  private ensureHitAudio() {
    // Lazy-create a shared AudioContext
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (!w.__npcHitAudio) {
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext);
      if (!Ctx) return null;
      w.__npcHitAudio = { ctx: new Ctx(), lastPlay: 0 };
    }
    return w.__npcHitAudio as { ctx: AudioContext; lastPlay: number } | null;
  }

  private playNpcHitBeep(strength01: number) {
    const audio = this.ensureHitAudio();
    if (!audio) return;
    const now = audio.ctx.currentTime;
    // global limiter
    if (now - audio.lastPlay < 0.08) return;
    audio.lastPlay = now;

    const osc = audio.ctx.createOscillator();
    const gain = audio.ctx.createGain();
    osc.type = "triangle";
    // Slightly vary pitch
    const f = 260 + 220 * Math.max(0, Math.min(1, strength01));
    osc.frequency.setValueAtTime(f, now);

    const v = 0.03 * Math.max(0.2, Math.min(1, strength01));
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(v, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

    osc.connect(gain);
    gain.connect(audio.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }
  constructor(scene: Scene) {
    this.scene = scene;

    this.simSkinMat = new StandardMaterial("simSkinMat", scene);
    this.simSkinMat.diffuseColor = new Color3(0.92, 0.78, 0.62);
    this.simSkinMat.specularColor = new Color3(0.05, 0.05, 0.05);

    this.simShirtMat = new StandardMaterial("simShirtMat", scene);
    this.simShirtMat.diffuseColor = new Color3(0.25, 0.55, 0.85);
    this.simShirtMat.specularColor = new Color3(0.04, 0.04, 0.04);

    this.simPantsMat = new StandardMaterial("simPantsMat", scene);
    this.simPantsMat.diffuseColor = new Color3(0.18, 0.18, 0.22);
    this.simPantsMat.specularColor = new Color3(0.04, 0.04, 0.04);

    this.tuneMobileMaterial(this.simSkinMat, this.simSkinMat.diffuseColor);
    this.tuneMobileMaterial(this.simShirtMat, this.simShirtMat.diffuseColor);
    this.tuneMobileMaterial(this.simPantsMat, this.simPantsMat.diffuseColor);

    this.crowd = this.createThinGroup("npcCrowdProto", new Color3(0.70, 0.85, 0.75));
    this.fake = this.createThinGroup("npcFakeProto", new Color3(0.70, 0.75, 0.90));
  }

  private tuneMobileMaterial(mat: StandardMaterial, color?: Color3) {
    if (color) {
      mat.emissiveColor = color;
      mat.diffuseColor = new Color3(0, 0, 0);
    }
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = true;
    if (!mat.isFrozen) mat.freeze();
  }

  update(
    dt: number,
    playerPos: Vector3,
    resolveCollision?: (pos: Vector3, radius: number) => void,
    vehiclePos?: Vector3,
    vehicleRadius: number = 1.35,
    vehicleSpeed: number = 0
  ) {
    // compute player planar speed for adaptive handoff budget
    if (Number.isNaN(this.lastPlayerPos.x)) this.lastPlayerPos.copyFrom(playerPos);
    const pdx = playerPos.x - this.lastPlayerPos.x;
    const pdz = playerPos.z - this.lastPlayerPos.z;
    const pdt = Math.max(1e-3, dt);
    this.playerSpeed = Math.sqrt(pdx * pdx + pdz * pdz) / pdt;
    this.lastPlayerPos.copyFrom(playerPos);
    this.ensureSimPopulation(playerPos);
    this.ensureThinPopulation(this.crowd, "crowd", playerPos);
    this.ensureThinPopulation(this.fake, "fake", playerPos);

    this.tryHandoffCrowdToSim(dt, playerPos);

    this.updateSim(dt, playerPos, resolveCollision, vehiclePos, vehicleRadius, vehicleSpeed);
    this.updateThin(dt, this.crowd, "crowd", playerPos);
    this.updateThin(dt, this.fake, "fake", playerPos);
  }

  getStats() {
    return { sim: this.sim.length, crowd: this.crowd.count, fake: this.fake.count };
  }

  private ensureSimPopulation(playerPos: Vector3) {
    const max = WorldConfig.NPC_SIM_MAX;
    while (this.sim.length < max) this.sim.push(this.spawnSimNPC(playerPos));
  }

  private spawnSimNPC(around: Vector3): SimNPC {
    const root = new TransformNode("simNPC", this.scene);
    root.scaling = new Vector3(0.8, 0.8, 0.8);

    const torso = MeshBuilder.CreateBox(
      "simTorso",
      { width: 0.75, depth: 0.35, height: 0.85 },
      this.scene
    );
    torso.material = this.simShirtMat;
    torso.parent = root;
    torso.position.y = 0.85;

    const head = MeshBuilder.CreateBox(
      "simHead",
      { width: 0.55, depth: 0.55, height: 0.55 },
      this.scene
    );
    head.material = this.simSkinMat;
    head.parent = root;
    head.position.y = 1.45;

    const armL = MeshBuilder.CreateBox(
      "simArmL",
      { width: 0.22, depth: 0.22, height: 0.75 },
      this.scene
    );
    armL.material = this.simSkinMat;
    armL.parent = root;
    armL.position.set(-0.52, 1.02, 0);

    const armR = armL.clone("simArmR") as Mesh;
    armR.parent = root;
    armR.position.set(0.52, 1.02, 0);

    const legL = MeshBuilder.CreateBox(
      "simLegL",
      { width: 0.25, depth: 0.25, height: 0.78 },
      this.scene
    );
    legL.material = this.simPantsMat;
    legL.parent = root;
    legL.position.set(-0.2, 0.39, 0);

    const legR = legL.clone("simLegR") as Mesh;
    legR.parent = root;
    legR.position.set(0.2, 0.39, 0);

    for (const m of [torso, head, armL, armR, legL, legR]) {
      m.isPickable = false;
      m.alwaysSelectAsActiveMesh = false;
    }

    // Start invisible and fade in
    torso.visibility = 0;
    head.visibility = 0;
    armL.visibility = 0;
    armR.visibility = 0;
    legL.visibility = 0;
    legR.visibility = 0;

    root.position.copyFrom(this.sampleWalkableInRing(around, 8, WorldConfig.NPC_SIM_RADIUS));
    root.position.y = 0;

  const npc: SimNPC = {

    root,
    torso,
    head,
    armL,
    armR,
    legL,
    legR,
    target: new Vector3(0, 0, 0),
    speed: 1.6 + this.rand() * 1.2,
    phase: this.rand() * Math.PI * 2,
    walk: 0,
    mode: "walk",
    idleLeft: 0,
    idlePhase: this.rand() * Math.PI * 2,
    desiredYaw: 0,
    yaw: 0,
    prevPos: root.position.clone(),
    fade: 0,
    moveRampLeft: this.SIM_MOVE_RAMP_SEC,
    waypoints: [],
    wpIndex: 0,
    behavior: (this.rand() < 0.18 ? "runner" : (this.rand() < 0.36 ? "phone" : "normal")),
  obeyTraffic: this.rand() < 0.35,
  phonePauseLeft: 0,
  stumbleT: 0,
  stumblePhase: this.rand() * Math.PI * 2,
  hitSfxCooldown: 0,
};
  // Plan first route so Sim never starts by spawning or targeting inside road lanes.
  this.planWalkChain(npc, around, WorldConfig.NPC_SIM_RADIUS);
  npc.prevPos.copyFrom(npc.root.position);
  return npc;
}

  private updateSim(
    dt: number,
    playerPos: Vector3,
    resolveCollision?: (pos: Vector3, radius: number) => void,
    vehiclePos?: Vector3,
    vehicleRadius: number = 1.35,
    vehicleSpeed: number = 0
  ) {
    for (const npc of this.sim) {
      // Keep sim around player
      const dx = npc.root.position.x - playerPos.x;
      const dz = npc.root.position.z - playerPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > WorldConfig.NPC_SIM_RADIUS * WorldConfig.NPC_SIM_RADIUS * 1.8) {
        npc.root.position.copyFrom(this.randomPointInRing(playerPos, 6, WorldConfig.NPC_SIM_RADIUS));
        npc.fade = 0;
        npc.moveRampLeft = this.SIM_MOVE_RAMP_SEC;
        npc.torso.visibility = 0;
        npc.head.visibility = 0;
        npc.armL.visibility = 0;
        npc.armR.visibility = 0;
        npc.legL.visibility = 0;
        npc.legR.visibility = 0;
        npc.root.position.y = 0;
        this.planWalkChain(npc, playerPos, WorldConfig.NPC_SIM_RADIUS);
      }

      if (npc.mode === "idle") {
        npc.idleLeft -= dt;
        npc.phonePauseLeft = Math.max(0, npc.phonePauseLeft - dt);
        npc.hitSfxCooldown = Math.max(0, npc.hitSfxCooldown - dt);

        // If waiting at a crosswalk entry and the light is still red, keep waiting.
        if (npc.obeyTraffic && npc.wpIndex < npc.waypoints.length) {
          const axis = this.isCrosswalkEntry(npc.target, npc.waypoints[npc.wpIndex]);
          if (axis) {
            const tSec = performance.now() * 0.001;
            const can = axis === "NS" ? this.canPedCrossNS(tSec) : this.canPedCrossEW(tSec);
            if (!can) {
              npc.idleLeft = Math.max(npc.idleLeft, 0.12);
              continue;
            }
          }
        }

        if (npc.idleLeft <= 0) {
          npc.mode = "walk";
          // Phone pause resumes walking toward the same target (no replanning).
          if (npc.phonePauseLeft <= 0) {
            this.planWalkChain(npc, playerPos, WorldConfig.NPC_SIM_RADIUS);
          }
        }
      }
      if (npc.mode === "walk") {
        const to = npc.target.subtract(npc.root.position);
        const dist = Math.sqrt(to.x * to.x + to.z * to.z);

        // Phone-type NPC: occasionally pause for a brief moment (checking phone)
        if (npc.behavior === "phone" && npc.mode === "walk" && npc.phonePauseLeft <= 0) {
          // approx 1% chance per second when moving
          if (dist > 0.6 && this.rand() < dt * 0.01) {
            npc.phonePauseLeft = 0.45 + this.rand() * 0.9;
            npc.mode = "idle";
            npc.idleLeft = npc.phonePauseLeft;
          }
        }

        // Traffic light: stop at crosswalk entry when red (only for some NPCs)
        if (npc.obeyTraffic && npc.wpIndex < npc.waypoints.length) {
          const axis = this.isCrosswalkEntry(npc.target, npc.waypoints[npc.wpIndex]);
          if (axis && dist < 1.25) {
            const tSec = performance.now() * 0.001;
            const can = axis === "NS" ? this.canPedCrossNS(tSec) : this.canPedCrossEW(tSec);
            if (!can) {
              npc.mode = "idle";
              npc.idleLeft = Math.max(npc.idleLeft, 0.12);
            }
          }
        }

        if (dist < 0.7) {

	          // Waypoint chaining: if we are in the middle of a crosswalk route, consume waypoints first.
	          if (npc.wpIndex < npc.waypoints.length) {
	            npc.target.copyFrom(npc.waypoints[npc.wpIndex++]);
	          } else {
	            // Otherwise decide whether to idle or pick a new walking chain.
	            if (this.rand() < 0.28) {
	              npc.mode = "idle";
	              npc.idleLeft = 0.8 + this.rand() * 2.2;
	              npc.idlePhase = this.rand() * Math.PI * 2;
	            } else {
	              this.planWalkChain(npc, playerPos, WorldConfig.NPC_SIM_RADIUS);
	            }
	          }
        } else {
          const dirX = to.x / dist;
          const dirZ = to.z / dist;
          npc.desiredYaw = Math.atan2(dirX, dirZ);
          const moveMul = 1 - this.clamp(npc.moveRampLeft / this.SIM_MOVE_RAMP_SEC, 0, 1);
          const behaviorMul = npc.behavior === "runner" ? 1.7 : (npc.behavior === "phone" ? 0.72 : 1.0);
          const paused = npc.phonePauseLeft > 0 ? 1 : 0;
          const sp = npc.speed * behaviorMul * (paused ? 0 : 1);
          npc.root.position.x += dirX * sp * moveMul * dt;
          npc.root.position.z += dirZ * sp * moveMul * dt;
        }
      }


      // Keep pedestrians off vehicle lanes (roads), allow only sidewalks + crosswalk rectangles.
      {
        const p = this.projectToWalkable(npc.root.position.x, npc.root.position.z);
        npc.root.position.x = p.x;
        npc.root.position.z = p.z;

        // Keep sim NPCs out of building footprints as well (cheap, same as player).
        // This prevents NPCs / player / buildings from visually overlapping.
        if (resolveCollision) {
          const beforeX = npc.root.position.x;
          const beforeZ = npc.root.position.z;
          resolveCollision(npc.root.position, 0.48);
          const corrX = npc.root.position.x - beforeX;
          const corrZ = npc.root.position.z - beforeZ;
          const corr2 = corrX * corrX + corrZ * corrZ;
          if (corr2 > 1e-6) {
            // If we had to push out, gently steer away from the wall so we don't keep "pressing" into it.
            const sign = Math.sin(npc.phase * 3.17) >= 0 ? 1 : -1;
            npc.desiredYaw += sign * 0.55;
          }
        }

        // Avoid overlapping the player (cheap separation push)
        {
          const dxp = npc.root.position.x - playerPos.x;
          const dzp = npc.root.position.z - playerPos.z;
          const d2p = dxp * dxp + dzp * dzp;
          const minR = 0.95;
          if (d2p > 1e-6 && d2p < minR * minR) {
            const d = Math.sqrt(d2p);
            const push = (minR - d);
            npc.root.position.x += (dxp / d) * push;
            npc.root.position.z += (dzp / d) * push;
          }
        }

        // Vehicle interaction: avoid / bump / stumble (optional)
        if (vehiclePos) {
          const dxv = npc.root.position.x - vehiclePos.x;
          const dzv = npc.root.position.z - vehiclePos.z;
          const d2v = dxv * dxv + dzv * dzv;

          // Increase reaction radius with vehicle speed
          const sp01 = this.clamp(vehicleSpeed / 18, 0, 1);
          const reactR = (vehicleRadius + 0.95) + sp01 * 2.2;
          const bumpR = (vehicleRadius + 0.72);

          if (d2v > 1e-6 && d2v < reactR * reactR) {
            const d = Math.sqrt(d2v);
            const nx = dxv / d;
            const nz = dzv / d;

            // Soft push when nearby, stronger when penetrating
            let push = 0;
            if (d < bumpR) {
              push = (bumpR - d) * (1.6 + sp01 * 1.2);
              // Trigger stumble (short wobble) + tiny beep with cooldown
              if (npc.hitSfxCooldown <= 0) {
                npc.hitSfxCooldown = 0.12;
                this.playNpcHitBeep(this.clamp((bumpR - d) / bumpR + sp01 * 0.25, 0, 1));
              }
              npc.stumbleT = Math.max(npc.stumbleT, 0.42);
            } else {
              push = (reactR - d) * (0.45 + sp01 * 0.55);
            }

            npc.root.position.x += nx * push;
            npc.root.position.z += nz * push;

            // Encourage turning away from the car
            npc.desiredYaw = Math.atan2(nx, nz) + (Math.sin(npc.phase * 2.7) >= 0 ? 0.55 : -0.55);

            // Resolve against buildings after push so we don't clip into walls
            if (resolveCollision) resolveCollision(npc.root.position, 0.48);
          }
        }
      }
      npc.moveRampLeft = Math.max(0, npc.moveRampLeft - dt);

      npc.yaw = this.lerpAngle(npc.yaw, npc.desiredYaw, this.clamp(dt * 10, 0, 1));
      npc.root.rotation.y = npc.yaw;
      this.animateSim(npc, dt);
    }
  }

  private animateSim(npc: SimNPC, dt: number) {
    const safeDt = Math.min(0.05, Math.max(0, dt));
    const t = performance.now() * 0.001;

    const dx = npc.root.position.x - npc.prevPos.x;
    const dz = npc.root.position.z - npc.prevPos.z;
    const v = Math.sqrt(dx * dx + dz * dz) / Math.max(1e-4, safeDt);
    npc.prevPos.copyFrom(npc.root.position);

    const moving = npc.mode === "walk" && v > 0.05;
    const targetWalk = moving ? 1 : 0;
    npc.walk += (targetWalk - npc.walk) * Math.min(1, safeDt * 8);

    const runFactor = this.clamp((v - 1.4) / 2.2, 0, 1);
    const freq = (6.0 + v * 2.2) * (1.0 + 0.35 * runFactor);

    // Fade ramp: during spawn fade-in, also ramp animation so it doesn't "start moving" abruptly.
    const ramp = this.clamp(npc.fade, 0, 1);
    const moveMul = 1 - this.clamp(npc.moveRampLeft / this.SIM_MOVE_RAMP_SEC, 0, 1);
    const walkR = npc.walk * ramp * moveMul;

    const ampArm = (0.85 + 0.55 * runFactor) * walkR;
    const ampLeg = (0.70 + 0.45 * runFactor) * walkR;

    const s = Math.sin(t * freq + npc.phase);
    const c = Math.cos(t * freq + npc.phase);

    npc.armL.rotation.x = s * ampArm;
    npc.armR.rotation.x = -s * ampArm;
    npc.legL.rotation.x = -s * ampLeg;
    npc.legR.rotation.x = s * ampLeg;

    const bob = (Math.abs(c) * (0.055 + 0.03 * runFactor)) * walkR;
    npc.torso.position.y = 0.85 + bob;
    npc.head.position.y = 1.45 + bob * 0.9;
    npc.armL.position.y = 1.02 + bob * 0.85;
    npc.armR.position.y = 1.02 + bob * 0.85;

    let targetHeadYaw = 0;
    let targetHeadPitch = 0;
    let targetTorsoYaw = 0;
    if (moving) {
      let d = (npc.desiredYaw - npc.yaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      targetHeadYaw = this.clamp(d * 0.8, -0.7, 0.7);
      targetHeadPitch =
        Math.sin(t * freq * 0.5 + npc.phase) * (0.06 + 0.05 * runFactor) * walkR;
    }

    if (npc.mode === "idle") {
      const look = Math.sin(t * 1.2 + npc.idlePhase) * 0.9 * ramp;
      targetHeadYaw = look;
      targetHeadPitch = Math.sin(t * 1.6 + npc.idlePhase * 1.7) * 0.18 * ramp;
      targetTorsoYaw = targetHeadYaw * 0.35;
      npc.armL.rotation.x *= 0.25;
      npc.armR.rotation.x *= 0.25;
      npc.legL.rotation.x *= 0.15;
      npc.legR.rotation.x *= 0.15;
    }

    npc.head.rotation.y += (targetHeadYaw - npc.head.rotation.y) * Math.min(1, safeDt * 10);
    npc.head.rotation.x += (targetHeadPitch - npc.head.rotation.x) * Math.min(1, safeDt * 8);
    npc.torso.rotation.y += (targetTorsoYaw - npc.torso.rotation.y) * Math.min(1, safeDt * 6);

    // Phone pose + stumble wobble (very light)
    if (npc.behavior === "phone") {
      // look slightly down and hold phone with right arm
      const phonePitch = 0.55;
      npc.head.rotation.x += (phonePitch - npc.head.rotation.x) * Math.min(1, safeDt * 4);
      npc.armR.rotation.x += (-1.05 - npc.armR.rotation.x) * Math.min(1, safeDt * 6);
      npc.armR.rotation.z += (-0.45 - npc.armR.rotation.z) * Math.min(1, safeDt * 6);
      npc.armL.rotation.x *= 0.35;
    } else {
      // relax phone-specific z
      npc.armR.rotation.z *= (1 - Math.min(1, safeDt * 6));
    }

    if (npc.stumbleT > 0) {
      npc.stumbleT = Math.max(0, npc.stumbleT - safeDt);
      npc.stumblePhase += safeDt * 18;
      const k = this.clamp(npc.stumbleT / 0.42, 0, 1);
      const wob = Math.sin(npc.stumblePhase) * 0.75 * k;

      npc.torso.rotation.z = wob * 0.35;
      npc.head.rotation.z = -wob * 0.25;
      npc.armR.rotation.z += -wob * 0.25;
      npc.armL.rotation.z += wob * 0.18;
    } else {
      // ease back to neutral
      npc.torso.rotation.z *= (1 - Math.min(1, safeDt * 10));
      npc.head.rotation.z *= (1 - Math.min(1, safeDt * 10));
      npc.armL.rotation.z *= (1 - Math.min(1, safeDt * 10));
      npc.armR.rotation.z *= (1 - Math.min(1, safeDt * 10));
    }

    // Spawn fade-in (Sim appears gradually in transition zone)
    if (npc.fade < 1) {
      npc.fade = Math.min(1, npc.fade + safeDt / this.SIM_FADE_IN_SEC);
      const v = npc.fade;
      npc.torso.visibility = v;
      npc.head.visibility = v;
      npc.armL.visibility = v;
      npc.armR.visibility = v;
      npc.legL.visibility = v;
      npc.legR.visibility = v;
    } else {
      // Ensure fully visible
      npc.torso.visibility = 1;
      npc.head.visibility = 1;
      npc.armL.visibility = 1;
      npc.armR.visibility = 1;
      npc.legL.visibility = 1;
      npc.legR.visibility = 1;
    }
  }

  private tryHandoffCrowdToSim(dt: number, playerPos: Vector3) {
    if (this.sim.length === 0 || this.crowd.count === 0) return;

    this.handoffAcc += dt;
    const step = 1 / this.HANDOFF_HZ;
    if (this.handoffAcc < step) return;
    this.handoffAcc -= step;

    const convertR = WorldConfig.NPC_SIM_RADIUS + this.HANDOFF_DIST;
    const convertR2 = convertR * convertR;

    // Mark nearby crowd as "handoff candidates" so they won't be teleported away while the player runs into them.
    for (let i = 0; i < this.crowd.count; i++) {
      if (this.crowd.suppressLeft[i] > 0) continue;
      if (this.crowd.fadeOutLeft[i] > 0) continue;
      if (this.crowd.fadeMul[i] < 0.05) continue;
      const x = this.crowd.pos[i * 3 + 0];
      const z = this.crowd.pos[i * 3 + 2];
      const dx = x - playerPos.x;
      const dz = z - playerPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= convertR2) {
        this.crowd.lockLeft[i] = Math.max(this.crowd.lockLeft[i], 0.9);
      }
    }

    // Promote multiple per tick so sprinting doesn't leave half the crowd popping away.
    const speedFactor = this.clamp(this.playerSpeed / 7.5, 0, 1);
    let promotesLeft = Math.floor(this.lerp(6, this.HANDOFF_MAX_PER_STEP, speedFactor));

    const pickCandidate = (preferRoad: boolean, requireSpacing: boolean) => {
      let bestIdx = -1;
      let bestD2 = 1e18;

      for (let i = 0; i < this.crowd.count; i++) {
        if (this.crowd.suppressLeft[i] > 0) continue;
        if (this.crowd.fadeOutLeft[i] > 0) continue;
        if (this.crowd.fadeMul[i] < 0.05) continue;

        const x = this.crowd.pos[i * 3 + 0];
        const z = this.crowd.pos[i * 3 + 2];
        const dx = x - playerPos.x;
        const dz = z - playerPos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > convertR2) continue;

        if (preferRoad && !this.isNearRoad(x, z)) continue;

        if (requireSpacing) {
          let ok = true;
          for (let j = 0; j < this.sim.length; j++) {
            const sx = this.sim[j].root.position.x - x;
            const sz = this.sim[j].root.position.z - z;
            if (sx * sx + sz * sz < 1.2 * 1.2) { ok = false; break; }
          }
          if (!ok) continue;
        }

        const score = d2 + (this.crowd.lockLeft[i] > 0 ? -1e12 : 0);
        if (score < bestD2) {
          bestD2 = score;
          bestIdx = i;
        }
      }
      return bestIdx;
    };

    while (promotesLeft-- > 0) {
      // Pass 1: prefer road + spacing (best look)
      let bestIdx = pickCandidate(true, true);
      // Pass 2: relax spacing but keep road preference
      if (bestIdx < 0) bestIdx = pickCandidate(true, false);
      // Pass 3: relax road constraint (guarantee conversion near player)
      if (bestIdx < 0) bestIdx = pickCandidate(false, false);
      if (bestIdx < 0) break;

      // pick farthest sim to recycle (keeps sim cap stable but guarantees promotion near player)
      let simIdx = 0;
      let farD2 = -1;
      for (let i = 0; i < this.sim.length; i++) {
        const sx = this.sim[i].root.position.x - playerPos.x;
        const sz = this.sim[i].root.position.z - playerPos.z;
        const d2 = sx * sx + sz * sz;
        if (d2 > farD2) {
          farD2 = d2;
          simIdx = i;
        }
      }

      const sim = this.sim[simIdx];
      const cx = this.crowd.pos[bestIdx * 3 + 0];
      const cz = this.crowd.pos[bestIdx * 3 + 2];
      const cyaw = this.crowd.yaw[bestIdx];

      // Offset behind the Crowd to reduce visual overlap (0.2~0.4m).
      const back = 0.2 + this.rand01() * 0.2;
      const fx = Math.sin(cyaw);
      const fz = Math.cos(cyaw);

      // Extra small lateral jitter so multiple nearby promotions don't stack into one point.
      const side = (this.rand01() - 0.5) * 0.25;
      const rx = Math.sin(cyaw + Math.PI / 2);
      const rz = Math.cos(cyaw + Math.PI / 2);

      sim.root.position.set(cx - fx * back + rx * side, 0, cz - fz * back + rz * side);
      sim.prevPos.copyFrom(sim.root.position);
      sim.yaw = cyaw;
      sim.desiredYaw = cyaw;
      sim.root.rotation.y = cyaw;
      sim.speed = 1.4 + this.clamp(this.crowd.speed[bestIdx], 0.6, 2.2);
      sim.phase = this.crowd.phase[bestIdx];
      sim.mode = "walk";
      sim.idleLeft = 0;
      sim.moveRampLeft = this.SIM_MOVE_RAMP_SEC;
      this.planWalkChain(sim, playerPos, WorldConfig.NPC_SIM_RADIUS);

      // Fade-in the promoted Sim NPC so it feels like detail increases instead of popping
      sim.fade = 0;
      sim.torso.visibility = 0;
      sim.head.visibility = 0;
      sim.armL.visibility = 0;
      sim.armR.visibility = 0;
      sim.legL.visibility = 0;
      sim.legR.visibility = 0;

      // Fade out the Crowd instance smoothly; respawn is handled in updateThin after fade completes.
      this.crowd.fadeOutLeft[bestIdx] = this.CROWD_FADE_OUT_SEC;
      this.crowd.lockLeft[bestIdx] = Math.max(this.crowd.lockLeft[bestIdx], this.CROWD_FADE_OUT_SEC + 0.2);
    }
  }

  private createThinGroup(name: string, color: Color3): ThinGroup {
    const proto = MeshBuilder.CreateBox(name, { width: 0.7, depth: 0.4, height: 1.1 }, this.scene);

    let mat = this.thinMatCache.get(name);
    if (!mat) {
      mat = new StandardMaterial(`${name}Mat`, this.scene);
      this.tuneMobileMaterial(mat, color);
      // Per-instance fading uses vertex alpha in the color buffer
      // Enable vertex colors; alpha will be respected when proto.hasVertexAlpha is true.
      mat.alpha = 1;
      mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
      this.thinMatCache.set(name, mat);
    }

    proto.material = mat;
    proto.hasVertexAlpha = true;
    // Enable per-instance vertex color (RGBA) buffer for fading
    (proto as any).useVertexColors = true;
    proto.isPickable = false;
    proto.alwaysSelectAsActiveMesh = false;
    proto.freezeWorldMatrix();
    proto.setEnabled(true);

    const max = WorldConfig.NPC_FAKE_MAX + 32;
    const pos = new Float32Array(max * 3);
    const yaw = new Float32Array(max);
    const speed = new Float32Array(max);
    const phase = new Float32Array(max);
    const fadeMul = new Float32Array(max);
    const suppressLeft = new Float32Array(max);
    const fadeOutLeft = new Float32Array(max);
    const lockLeft = new Float32Array(max);
    const matrices = new Float32Array(max * 16);
    const colors = new Float32Array(max * 4);

    proto.thinInstanceSetBuffer("matrix", matrices, 16, false);
    proto.thinInstanceSetBuffer("color", colors, 4, false);
    proto.thinInstanceCount = 0;

    return {
      proto,
      baseColor: color.clone(),
      pos,
      yaw,
      speed,
      phase,
      fadeMul,
      fadeOutLeft,
      suppressLeft,
      lockLeft,
      matrices,
      colors,
      count: 0,
      logicAcc: 0,
      refreshAcc: 0,
    };
  }

  private ensureThinPopulation(group: ThinGroup, tier: Tier, playerPos: Vector3) {
    const desired = tier === "crowd" ? WorldConfig.NPC_CROWD_MAX : WorldConfig.NPC_FAKE_MAX;
    if (group.count === desired) return;
    group.count = desired;

    const minR = tier === "fake" ? WorldConfig.NPC_CROWD_RADIUS + 12 : WorldConfig.NPC_SIM_RADIUS + 2;
    const maxR = tier === "fake" ? WorldConfig.NPC_FAKE_RADIUS : WorldConfig.NPC_CROWD_RADIUS;
    for (let i = 0; i < group.count; i++) {
      const p = this.sampleWalkableInRing(playerPos, minR, maxR);
      const pp = this.projectToWalkable(p.x, p.z);
      group.pos[i * 3 + 0] = pp.x;
      group.pos[i * 3 + 1] = 0;
      group.pos[i * 3 + 2] = pp.z;
      group.yaw[i] = this.rand() * Math.PI * 2;
      group.speed[i] = tier === "crowd" ? 1.1 + this.rand() * 0.8 : 0.0;
      group.phase[i] = this.rand() * Math.PI * 2;
      group.fadeMul[i] = 1;
      group.fadeOutLeft[i] = 0;
      group.suppressLeft[i] = 0;
      group.lockLeft[i] = 0;
    }
    this.writeThinBuffers(group, tier, playerPos);
    group.proto.thinInstanceCount = group.count;
  }

  private updateThin(dt: number, group: ThinGroup, tier: Tier, playerPos: Vector3) {
    const logicHz = tier === "crowd" ? WorldConfig.NPC_CROWD_LOGIC_HZ : WorldConfig.NPC_FAKE_REFRESH_HZ;
    const logicStep = logicHz > 0 ? 1 / logicHz : 9999;

    group.logicAcc += dt;
    group.refreshAcc += dt;

    for (let i = 0; i < group.count; i++) {
      if (group.lockLeft && group.lockLeft[i] > 0) {
        group.lockLeft[i] = Math.max(0, group.lockLeft[i] - dt);
      }
      // Smooth fade-out (handoff) before suppress/respawn to avoid popping
      if (group.fadeOutLeft[i] > 0) {
        group.fadeOutLeft[i] -= dt;
        const t = this.clamp(group.fadeOutLeft[i] / this.CROWD_FADE_OUT_SEC, 0, 1);
        group.fadeMul[i] = t;
        if (group.fadeOutLeft[i] <= 0) {
          // After fade-out completes, suppress then respawn outside the Sim ring
          group.fadeMul[i] = 0;
          group.lockLeft[i] = 0;
          group.suppressLeft[i] = this.CROWD_SUPPRESS_SEC;
          group.lockLeft[i] = 0;
        }
        continue;
      }
      if (group.suppressLeft[i] > 0) {
        group.suppressLeft[i] -= dt;
        if (group.suppressLeft[i] <= 0) {
          const minR = tier === "fake" ? WorldConfig.NPC_CROWD_RADIUS + 12 : WorldConfig.NPC_SIM_RADIUS + 2;
          const maxR = tier === "fake" ? WorldConfig.NPC_FAKE_RADIUS : WorldConfig.NPC_CROWD_RADIUS;
          const p = this.sampleWalkableInRing(playerPos, minR, maxR);
          group.pos[i * 3 + 0] = p.x;
          group.pos[i * 3 + 2] = p.z;
          group.yaw[i] = this.rand() * Math.PI * 2;
          group.fadeMul[i] = 0;
          group.lockLeft[i] = 0;
        }
      } else {
        group.fadeMul[i] = this.clamp(group.fadeMul[i] + dt * this.CROWD_FADE_IN_SPEED, 0, 1);
      }
    }

    if (tier === "fake") {
      if (group.refreshAcc >= logicStep) {
        group.refreshAcc = 0;
        const minR = WorldConfig.NPC_CROWD_RADIUS + 12;
        const maxR = WorldConfig.NPC_FAKE_RADIUS;
        for (let i = 0; i < group.count; i++) {
      if (group.lockLeft && group.lockLeft[i] > 0) {
        group.lockLeft[i] = Math.max(0, group.lockLeft[i] - dt);
      }
          const dx = group.pos[i * 3 + 0] - playerPos.x;
          const dz = group.pos[i * 3 + 2] - playerPos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > maxR * maxR || d2 < minR * minR) {
            const p = this.sampleWalkableInRing(playerPos, minR, maxR);
            group.pos[i * 3 + 0] = p.x;
            group.pos[i * 3 + 2] = p.z;
            group.yaw[i] = this.rand() * Math.PI * 2;
          }
        }
        this.writeThinBuffers(group, tier, playerPos);
      }
      return;
    }

    if (group.logicAcc < logicStep) return;
    const steps = Math.min(2, Math.floor(group.logicAcc / logicStep));
    group.logicAcc -= steps * logicStep;

    for (let s = 0; s < steps; s++) {
      const minR = WorldConfig.NPC_SIM_RADIUS + 2;
      const maxR = WorldConfig.NPC_CROWD_RADIUS;
      for (let i = 0; i < group.count; i++) {
      if (group.lockLeft && group.lockLeft[i] > 0) {
        group.lockLeft[i] = Math.max(0, group.lockLeft[i] - dt);
      }
        if (group.suppressLeft[i] > 0) continue;
        if (group.lockLeft && group.lockLeft[i] > 0) {
          group.lockLeft[i] = Math.max(0, group.lockLeft[i] - logicStep);
          continue;
        }

        let x = group.pos[i * 3 + 0];
        let z = group.pos[i * 3 + 2];
        const dx = x - playerPos.x;
        const dz = z - playerPos.z;
        const d2 = dx * dx + dz * dz;

        const max2 = maxR * maxR * 1.96;
        if (d2 > max2) {
          const p = this.sampleWalkableInRing(playerPos, minR, maxR);
          x = p.x;
          z = p.z;
          const ppT = this.projectToWalkable(x, z);
          x = ppT.x;
          z = ppT.z;
          group.yaw[i] = this.rand() * Math.PI * 2;
          group.pos[i * 3 + 0] = x;
          group.pos[i * 3 + 2] = z;
          continue;
        }

        const d = Math.sqrt(Math.max(1e-6, d2));
        // Keep crowd near the Sim ring visible so it can be promoted via handoff (detail upgrade),
        // instead of being teleported away (which looks like popping/disappearing).
        const repel = d < minR ? 1 - d / minR : 0;

        let yaw = group.yaw[i];
        yaw += (this.rand() - 0.5) * 0.35;
        if (repel > 0) {
          const away = Math.atan2(dx, dz);
          let delta = (away - yaw) % (Math.PI * 2);
          if (delta > Math.PI) delta -= Math.PI * 2;
          if (delta < -Math.PI) delta += Math.PI * 2;
          yaw += delta * (0.35 + 0.45 * repel);
        }

        group.yaw[i] = yaw;
        const sp = group.speed[i] * (1 + 0.8 * repel);
        x += Math.sin(yaw) * sp * logicStep;
        z += Math.cos(yaw) * sp * logicStep;
        const pp = this.projectToWalkable(x, z);
        group.pos[i * 3 + 0] = pp.x;
        group.pos[i * 3 + 2] = pp.z;
      }
    }

    this.writeThinBuffers(group, tier, playerPos);
  }

  private writeThinBuffers(group: ThinGroup, tier: Tier, playerPos: Vector3) {
    const m = Matrix.Identity();
    const s = new Vector3(1, 1, 1);
    const r = Matrix.Identity();

    for (let i = 0; i < group.count; i++) {
      const x = group.pos[i * 3 + 0];
      const z = group.pos[i * 3 + 2];
      const yaw = group.yaw[i];

      const h = 0.95 + (group.phase[i] % 1) * 0.2;
      s.x = 1;
      s.y = h;
      s.z = 1;
      Matrix.ScalingToRef(s.x, s.y, s.z, m);
      Matrix.RotationYToRef(yaw, r);
      m.multiplyToRef(r, m);
      m.setTranslationFromFloats(x, 0.55 * h, z);
      group.matrices.set(m.m, i * 16);

      let alpha = 1;
      if (tier === "crowd") {
        // Crowd should stay fully visible; handoff will handle smooth fade-out when promoting to Sim.
        alpha = 1;
      } else if (tier === "fake") {
        const inner = WorldConfig.NPC_CROWD_RADIUS + 10;
        const fade = 14;
        const dx = x - playerPos.x;
        const dz = z - playerPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        alpha = this.clamp((dist - inner) / fade, 0, 1);
      }

      alpha *= group.fadeMul[i];
      const ci = i * 4;
      group.colors[ci + 0] = group.baseColor.r;
      group.colors[ci + 1] = group.baseColor.g;
      group.colors[ci + 2] = group.baseColor.b;
      group.colors[ci + 3] = alpha;
    }

    group.proto.thinInstanceSetBuffer("matrix", group.matrices, 16, false);
    group.proto.thinInstanceSetBuffer("color", group.colors, 4, false);
  }

	private sampleWalkableInRing(center: Vector3, minR: number, maxR: number) {
  const p = this.randomPointInRing(center, minR, maxR);
  const pp = this.projectToWalkable(p.x, p.z);
  p.x = pp.x;
  p.z = pp.z;
  p.y = 0;
  return p;
}

private sampleSidewalkDest(center: Vector3, radius: number) {
  // Sample until we land on a sidewalk band (crosswalk is reserved for routing, not as a final destination).
  for (let k = 0; k < 12; k++) {
    const p = this.sampleWalkableInRing(center, 6, radius);
    if (!this.isInCrosswalkWorld(p.x, p.z)) return p;
  }
  return this.sampleWalkableInRing(center, 6, radius);
}

private isInCrosswalkWorld(x: number, z: number) {
  const s = WorldConfig.CHUNK_SIZE;
  const cx = Math.round(x / s);
  const cz = Math.round(z / s);
  const lx = x - cx * s;
  const lz = z - cz * s;
  return this.isInCrosswalkLocal(lx, lz);
}

private classifySideWorld(x: number, z: number): "N" | "S" | "E" | "W" {
  const s = WorldConfig.CHUNK_SIZE;
  const cx = Math.round(x / s);
  const cz = Math.round(z / s);
  const lx = x - cx * s;
  const lz = z - cz * s;

  const halfRoad = this.ROAD_W * 0.5;
  if (lz > halfRoad) return "N";
  if (lz < -halfRoad) return "S";
  if (lx > halfRoad) return "E";
  return "W";
}

private planWalkChain(npc: SimNPC, around: Vector3, radius: number) {
  // 목적지는 (인도)에서만 샘플링. 도로/교차로 중앙을 직접 목표로 삼지 않음.
  const dest = this.sampleSidewalkDest(around, radius);

  const halfRoad = this.ROAD_W * 0.5;
  const pad = 0.35;

  const from = npc.root.position;
  const sideA = this.classifySideWorld(from.x, from.z);
  const sideB = this.classifySideWorld(dest.x, dest.z);

  const way: Vector3[] = [];

  if (sideA === sideB) {
    way.push(dest);
  } else {
    const adjacent =
      (sideA === "N" && (sideB === "E" || sideB === "W")) ||
      (sideA === "S" && (sideB === "E" || sideB === "W")) ||
      (sideA === "E" && (sideB === "N" || sideB === "S")) ||
      (sideA === "W" && (sideB === "N" || sideB === "S"));

    if (adjacent) {
      // Move around the corner on sidewalks (no need to step onto crosswalk)
      const sx = sideB === "E" ? +1 : sideB === "W" ? -1 : sideA === "E" ? +1 : -1;
      const sz = sideB === "N" ? +1 : sideB === "S" ? -1 : sideA === "N" ? +1 : -1;
      const corner = new Vector3(sx * (halfRoad + pad), 0, sz * (halfRoad + pad));
      const cwp = this.projectToWalkable(corner.x, corner.z);
      way.push(new Vector3(cwp.x, 0, cwp.z));
      way.push(dest);
    } else {
      // Opposite sides: 반드시 횡단보도로만 건넘 (인도 → 횡단보도 → 인도)
      if ((sideA === "N" && sideB === "S") || (sideA === "S" && sideB === "N")) {
        const off = this.CROSSWALK_OFFSET;
        const cwX = Math.abs(from.x - off) < Math.abs(from.x + off) ? off : -off;

        const entryZ = sideA === "N" ? (halfRoad + pad) : (-halfRoad - pad);
        const exitZ  = sideB === "N" ? (halfRoad + pad) : (-halfRoad - pad);

        way.push(new Vector3(cwX, 0, entryZ));
        way.push(new Vector3(cwX, 0, 0));
        way.push(new Vector3(cwX, 0, exitZ));
        way.push(dest);
      } else if ((sideA === "E" && sideB === "W") || (sideA === "W" && sideB === "E")) {
        const off = this.CROSSWALK_OFFSET;
        const cwZ = Math.abs(from.z - off) < Math.abs(from.z + off) ? off : -off;

        const entryX = sideA === "E" ? (halfRoad + pad) : (-halfRoad - pad);
        const exitX  = sideB === "E" ? (halfRoad + pad) : (-halfRoad - pad);

        way.push(new Vector3(entryX, 0, cwZ));
        way.push(new Vector3(0, 0, cwZ));
        way.push(new Vector3(exitX, 0, cwZ));
        way.push(dest);
      } else {
        way.push(dest);
      }
    }
  }

  // Safety: project all waypoints to allowed walkables (sidewalk/crosswalk)
  for (let i = 0; i < way.length; i++) {
    const p = this.projectToWalkable(way[i].x, way[i].z);
    way[i].x = p.x;
    way[i].z = p.z;
    way[i].y = 0;
  }

  npc.waypoints = way;
  npc.wpIndex = 0;
  npc.target.copyFrom(way[npc.wpIndex++]);
}

  private randomPointInRing(center: Vector3, minR: number, maxR: number) {
    const a = this.rand() * Math.PI * 2;
    const r = Math.sqrt(this.lerp(minR * minR, maxR * maxR, this.rand()));
    return new Vector3(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r);
  }

  private lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
  }

  private lerpAngle(a: number, b: number, t: number) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  private rand01() {
    return this.rand();
  }

  private isNearRoad(x: number, z: number) {
    // "Near road" means close to the road corridor (sidewalk vibe), not necessarily inside the lanes.
    const s = WorldConfig.CHUNK_SIZE;
    const cx = Math.round(x / s);
    const cz = Math.round(z / s);
    const lx = x - cx * s;
    const lz = z - cz * s;
    const t = this.ROAD_THRESHOLD;
    return Math.abs(lx) <= t || Math.abs(lz) <= t;
  }

  private isInCrosswalkLocal(lx: number, lz: number) {
    const off = this.CROSSWALK_OFFSET;
    const halfW = this.CROSSWALK_WIDTH * 0.5;
    const halfRoad = this.ROAD_W * 0.5;

    // Crosswalks across roadX (pedestrians cross Z) at x = ±off
    const inRoadXBand = Math.abs(lz) <= halfRoad;
    const inCWX =
      inRoadXBand && (Math.abs(lx - off) <= halfW || Math.abs(lx + off) <= halfW);

    // Crosswalks across roadZ (pedestrians cross X) at z = ±off
    const inRoadZBand = Math.abs(lx) <= halfRoad;
    const inCWZ =
      inRoadZBand && (Math.abs(lz - off) <= halfW || Math.abs(lz + off) <= halfW);

    return inCWX || inCWZ;
  }

  private projectToWalkable(x: number, z: number) {
    // Chunk-local classification:
    // 1) Road (vehicles only)           => forbidden
    // 2) Crosswalk (NPC allowed)        => allowed
    // 3) Sidewalk (NPC allowed)         => allowed
    // 4) Buildable land (buildings only)=> forbidden for NPC
    //
    // This function projects any (x,z) to the nearest allowed point for NPCs:
    // sidewalk strips or crosswalk rectangles.

    const s = WorldConfig.CHUNK_SIZE;
    const cx = Math.round(x / s);
    const cz = Math.round(z / s);
    const lx = x - cx * s;
    const lz = z - cz * s;

    const halfRoad = this.ROAD_W * 0.5;
    const sw = this.SIDEWALK_W;

    type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
    const rects: Rect[] = [];

    // Sidewalk bands along the two roads
    rects.push({ minX: -s * 0.5, maxX: s * 0.5, minZ: halfRoad, maxZ: halfRoad + sw }); // +Z
    rects.push({ minX: -s * 0.5, maxX: s * 0.5, minZ: -halfRoad - sw, maxZ: -halfRoad }); // -Z
    rects.push({ minX: halfRoad, maxX: halfRoad + sw, minZ: -s * 0.5, maxZ: s * 0.5 }); // +X
    rects.push({ minX: -halfRoad - sw, maxX: -halfRoad, minZ: -s * 0.5, maxZ: s * 0.5 }); // -X

    // Crosswalk rectangles (allowed even though they are inside road corridor)
    const cwHalf = this.CROSSWALK_WIDTH * 0.5;
    rects.push({ minX: this.CROSSWALK_OFFSET - cwHalf, maxX: this.CROSSWALK_OFFSET + cwHalf, minZ: -halfRoad, maxZ: halfRoad }); // +X side
    rects.push({ minX: -this.CROSSWALK_OFFSET - cwHalf, maxX: -this.CROSSWALK_OFFSET + cwHalf, minZ: -halfRoad, maxZ: halfRoad }); // -X side
    rects.push({ minX: -halfRoad, maxX: halfRoad, minZ: this.CROSSWALK_OFFSET - cwHalf, maxZ: this.CROSSWALK_OFFSET + cwHalf }); // +Z side
    rects.push({ minX: -halfRoad, maxX: halfRoad, minZ: -this.CROSSWALK_OFFSET - cwHalf, maxZ: -this.CROSSWALK_OFFSET + cwHalf }); // -Z side

    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    const closestPointRect = (px: number, pz: number, r: Rect) => {
      const cxp = clamp(px, r.minX, r.maxX);
      const czp = clamp(pz, r.minZ, r.maxZ);
      const dx = px - cxp;
      const dz = pz - czp;
      return { x: cxp, z: czp, d2: dx * dx + dz * dz };
    };

    // If already inside an allowed rect, keep it (just clamp to rect bounds)
    for (const r of rects) {
      if (lx >= r.minX && lx <= r.maxX && lz >= r.minZ && lz <= r.maxZ) {
        return { x: cx * s + lx, z: cz * s + lz };
      }
    }

    // Otherwise project to nearest rect (sidewalk or crosswalk)
    let best = { x: lx, z: lz, d2: Number.POSITIVE_INFINITY };
    for (const r of rects) {
      const cpt = closestPointRect(lx, lz, r);
      if (cpt.d2 < best.d2) best = cpt;
    }

    // Slight inward padding so we don't hover exactly on edges
    const pad = 0.15;
    let px = best.x;
    let pz = best.z;

    // Push a bit away from the road boundary when on sidewalk
    // (prevents numeric jitter from bouncing between road and sidewalk)
    if (Math.abs(pz) >= halfRoad && Math.abs(pz) <= halfRoad + sw + 1e-3 && Math.abs(px) > halfRoad) {
      // corner area, leave as is
    } else {
      if (pz > halfRoad) pz = Math.max(pz, halfRoad + pad);
      if (pz < -halfRoad) pz = Math.min(pz, -halfRoad - pad);
      if (px > halfRoad) px = Math.max(px, halfRoad + pad);
      if (px < -halfRoad) px = Math.min(px, -halfRoad - pad);
    }

    return { x: cx * s + px, z: cz * s + pz };
  }

  private clamp(v: number, a: number, b: number) {
    return Math.max(a, Math.min(b, v));
  }

  private rand() {
    let x = this.seed | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x;
    return ((x >>> 0) % 1000000) / 1000000;
  }
}