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
	// Soft budget for how many thin->sim promotions we do per handoff step.
	// 가까이 접근한 NPC는 반드시 고퀄(Sim)로 바뀌어야 하므로, FORCE_SIM_RADIUS 안에서는 이 제한을 무시한다.
	private readonly HANDOFF_MAX_PER_STEP = 18;
	private readonly FORCE_SIM_RADIUS = 12; // meters
  private readonly CROWD_SUPPRESS_SEC = 1.0;
  private readonly CROWD_FADE_OUT_SEC = 0.22;
  private readonly SIM_FADE_IN_SEC = 0.28;
  private readonly SIM_MOVE_RAMP_SEC = 0.30;
  private readonly ROAD_W = 5; // must match ChunkWorld roadW
  private readonly ROAD_THRESHOLD = 5.0; // roadW/2 + sidewalk margin
  private readonly CROWD_FADE_IN_SPEED = 3.5;

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

  update(dt: number, playerPos: Vector3) {
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

    this.updateSim(dt, playerPos);
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

    root.position.copyFrom(this.randomPointInRing(around, 8, WorldConfig.NPC_SIM_RADIUS));
    root.position.y = 0;

    return {
      root,
      torso,
      head,
      armL,
      armR,
      legL,
      legR,
      target: this.randomWalkTarget(around, WorldConfig.NPC_SIM_RADIUS),
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
    };
  }

  private updateSim(dt: number, playerPos: Vector3) {
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
        npc.target = this.randomWalkTarget(playerPos, WorldConfig.NPC_SIM_RADIUS);
      }

      if (npc.mode === "idle") {
        npc.idleLeft -= dt;
        if (npc.idleLeft <= 0) {
          npc.mode = "walk";
          npc.target = this.randomWalkTarget(playerPos, WorldConfig.NPC_SIM_RADIUS);
        }
      }

      if (npc.mode === "walk") {
        const to = npc.target.subtract(npc.root.position);
        const dist = Math.sqrt(to.x * to.x + to.z * to.z);
        if (dist < 0.7) {
          if (this.rand() < 0.28) {
            npc.mode = "idle";
            npc.idleLeft = 0.8 + this.rand() * 2.2;
            npc.idlePhase = this.rand() * Math.PI * 2;
          } else {
            npc.target = this.randomWalkTarget(playerPos, WorldConfig.NPC_SIM_RADIUS);
          }
        } else {
          const dirX = to.x / dist;
          const dirZ = to.z / dist;
          npc.desiredYaw = Math.atan2(dirX, dirZ);
          const moveMul = 1 - this.clamp(npc.moveRampLeft / this.SIM_MOVE_RAMP_SEC, 0, 1);
          npc.root.position.x += dirX * npc.speed * moveMul * dt;
          npc.root.position.z += dirZ * npc.speed * moveMul * dt;
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

    // --- NPC animation feel upgrade: "foot planting" (cheap but effective)
    // 1) Smoothly damp swing to 0 when stopping (avoid jittery leg swing at rest)
    // 2) Fake "ground contact": lift foot only during forward swing and clamp foot above ground (y >= 0)
    const stop = this.clamp((0.18 - walkR) / 0.18, 0, 1); // 0 when walking, 1 when almost stopped
    const swingMul = 1 - stop * stop;
    const s2 = s * swingMul;

    const targetArmL = s2 * ampArm;
    const targetArmR = -s2 * ampArm;
    const targetLegL = -s2 * ampLeg;
    const targetLegR = s2 * ampLeg;

    // Smooth damping toward target (helps stop/landing feel)
    const k = Math.min(1, safeDt * 16);
    npc.armL.rotation.x += (targetArmL - npc.armL.rotation.x) * k;
    npc.armR.rotation.x += (targetArmR - npc.armR.rotation.x) * k;
    npc.legL.rotation.x += (targetLegL - npc.legL.rotation.x) * k;
    npc.legR.rotation.x += (targetLegR - npc.legR.rotation.x) * k;

    // Foot lift: only on forward swing (no "digging" through the floor).
    // These are blocky legs, so we approximate lift by moving the whole leg mesh in Y.
    const LEG_H = 0.78;
    const LEG_BASE_Y = LEG_H * 0.5; // 0.39
    const liftAmp = (0.08 + 0.03 * runFactor) * walkR;
    const liftL = Math.max(0, s2) * liftAmp;
    const liftR = Math.max(0, -s2) * liftAmp;

    const targetLegYL = LEG_BASE_Y + liftL;
    const targetLegYR = LEG_BASE_Y + liftR;
    npc.legL.position.y += (targetLegYL - npc.legL.position.y) * k;
    npc.legR.position.y += (targetLegYR - npc.legR.position.y) * k;

    // Clamp: foot must not go below ground (y >= 0). For a centered box, bottom is (pos.y - LEG_H/2).
    npc.legL.position.y = Math.max(LEG_BASE_Y, npc.legL.position.y);
    npc.legR.position.y = Math.max(LEG_BASE_Y, npc.legR.position.y);

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
		// Soft cap is scaled by speed, but we *guarantee* conversion in the close range.
		const speedFactor = this.clamp(this.playerSpeed / 7.5, 0, 1);
		let promotesLeft = Math.floor(this.lerp(6, this.HANDOFF_MAX_PER_STEP, speedFactor));

		// Force promote: very close NPCs must always become Sim (high quality).
		const forceR = this.FORCE_SIM_RADIUS;
		const forceR2 = forceR * forceR;
		let forceNeed = 0;
		for (let i = 0; i < this.crowd.count; i++) {
			if (this.crowd.suppressLeft[i] > 0) continue;
			if (this.crowd.fadeOutLeft[i] > 0) continue;
			if (this.crowd.fadeMul[i] < 0.05) continue;
			const x = this.crowd.pos[i * 3 + 0];
			const z = this.crowd.pos[i * 3 + 2];
			const dx = x - playerPos.x;
			const dz = z - playerPos.z;
			const d2 = dx * dx + dz * dz;
			if (d2 <= forceR2) {
				// keep them from being teleported away while we promote
				this.crowd.lockLeft[i] = Math.max(this.crowd.lockLeft[i], 1.2);
				forceNeed++;
			}
		}

		// We can only meaningfully promote up to the sim pool size per step.
		promotesLeft = Math.min(this.sim.length, Math.max(promotesLeft, forceNeed));

		const pickCandidate = (preferRoad: boolean, requireSpacing: boolean, forceOnly: boolean) => {
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
				if (forceOnly && d2 > forceR2) continue;

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
			// Pass 0: hard guarantee very-close NPCs convert first
			let bestIdx = pickCandidate(false, false, true);
			// Pass 1: prefer road + spacing (best look)
			if (bestIdx < 0) bestIdx = pickCandidate(true, true, false);
			// Pass 2: relax spacing but keep road preference
			if (bestIdx < 0) bestIdx = pickCandidate(true, false, false);
			// Pass 3: relax road constraint (guarantee conversion near player)
			if (bestIdx < 0) bestIdx = pickCandidate(false, false, false);
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
      sim.target = this.randomWalkTarget(playerPos, WorldConfig.NPC_SIM_RADIUS);

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
      const p = this.randomPointInRing(playerPos, minR, maxR);
      group.pos[i * 3 + 0] = p.x;
      group.pos[i * 3 + 1] = 0;
      group.pos[i * 3 + 2] = p.z;
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
          const p = this.randomPointInRing(playerPos, minR, maxR);
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
            const p = this.randomPointInRing(playerPos, minR, maxR);
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
          const p = this.randomPointInRing(playerPos, minR, maxR);
          x = p.x;
          z = p.z;
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
        group.pos[i * 3 + 0] = x;
        group.pos[i * 3 + 2] = z;
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

  private randomWalkTarget(center: Vector3, radius: number) {
    const p = this.randomPointInRing(center, 6, radius);
    p.y = 0;
    return p;
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
    const s = WorldConfig.CHUNK_SIZE;
    const cx = Math.round(x / s);
    const cz = Math.round(z / s);
    const lx = x - cx * s;
    const lz = z - cz * s;
    const t = this.ROAD_THRESHOLD;
    return Math.abs(lx) <= t || Math.abs(lz) <= t;
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