import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { WorldConfig } from "../world/WorldConfig";

type MissionPhase = "idle" | "pickup" | "dropoff" | "failed";

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

/**
 * Very lightweight "delivery/checkpoint" mission system.
 * - Press M to start/restart.
 * - Go to PICKUP checkpoint, then go to DROPOFF checkpoint.
 * - Repeat until timer ends.
 */
export class MissionManager {
  private scene: Scene;
  private isBlocked: ((pos: Vector3, radius: number) => boolean) | null = null;

  private phase: MissionPhase = "idle";
  private deliveries = 0;
  private score = 0;
  private combo = 0;
  private comboTimer = 0;
  private comboWindowSec = 12;

  // One simple HUD popup (score/combo feedback)
  private popup: { text: string; color: string; t: number; ttl: number } | null = null;

  // Spawn direction bias to avoid always spawning "same way"
  private lastDirAngle: number | null = null;
  private lastTargetPos = new Vector3(0, 0, 0);

  private timeLeft = 0;
  private timeLimitSec = 90;

  private targetPos = new Vector3(0, 0, 0);
  private target!: TransformNode;
  private ring!: Mesh;
  private beam!: Mesh;
  private orb!: Mesh;

  private animT = 0;
  private activationRadius = 2.6;

  // Optional "requester" NPC + speech bubble (purely cosmetic, very cheap)
  private requester!: TransformNode;
  private requesterBody!: Mesh;
  private requesterSkirt!: Mesh;
  private bubbleTex!: DynamicTexture;

  // Tiny success FX (no external assets): pooled spark meshes + optional beep
  private fxPool: Mesh[] = [];
  private fxActive: { mesh: Mesh; t: number; ttl: number; v: Vector3 }[] = [];
  private audioCtx: AudioContext | null = null;

  constructor(scene: Scene, isBlocked?: (pos: Vector3, radius: number) => boolean) {
    this.scene = scene;
    this.isBlocked = isBlocked ?? null;
    this.createTargetMeshes();
    this.createRequester();
    this.createFxPool();
    this.hideTarget();
  }

  /** Start a new mission run (timer + first pickup). */
  start(playerPos: Vector3) {
    this.deliveries = 0;
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.lastDirAngle = null;
    this.timeLeft = this.timeLimitSec;
    this.phase = "pickup";
    this.spawnTargetNear(playerPos, "pickup");
  }

  /** Per-frame update. */
  update(dt: number, playerPos: Vector3) {
    this.animT += dt;

    // combo decay
    this.comboTimer = Math.max(0, this.comboTimer - dt);

    // popup animation timer
    if (this.popup) {
      this.popup.t += dt;
      if (this.popup.t >= this.popup.ttl) this.popup = null;
    }

    // Animate marker even while idle (cheap).
    if (this.target) {
      this.target.rotation.y += dt * 0.9;
      const bob = Math.sin(this.animT * 2.2) * 0.2;
      this.orb.position.y = 6.4 + bob;
    }

    // Make requester roughly face the player (adds life, still cheap).
    if (this.phase !== "idle" && this.phase !== "failed") {
      const dx = playerPos.x - this.targetPos.x;
      const dz = playerPos.z - this.targetPos.z;
      this.requester.rotation.y = Math.atan2(dx, dz);
    }

    if (this.phase === "idle" || this.phase === "failed") return;

    // Update tiny FX
    if (this.fxActive.length) {
      for (let i = this.fxActive.length - 1; i >= 0; i--) {
        const fx = this.fxActive[i];
        fx.t += dt;
        const p = fx.t / fx.ttl;
        fx.mesh.position.addInPlace(fx.v.scale(dt));
        fx.mesh.scaling.setAll(Math.max(0, 1.0 - p) * 0.9 + 0.1);
        const mat = fx.mesh.material as StandardMaterial;
        mat.alpha = Math.max(0, 1.0 - p);
        if (fx.t >= fx.ttl) {
          fx.mesh.setEnabled(false);
          // Return to pool
          this.fxPool.push(fx.mesh);
          this.fxActive.splice(i, 1);
        }
      }
    }

    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft <= 0) {
      this.phase = "failed";
      this.hideTarget();
      return;
    }

    const dist = Vector3.Distance(playerPos, this.targetPos);
    if (dist <= this.activationRadius) {
      if (this.phase === "pickup") {
        // "Picked up" the package.
        const gained = 50;
        this.score += gained;
        this.popup = { text: `+${gained} (픽업)`, color: "#4f7cff", t: 0, ttl: 1.2 };

        this.phase = "dropoff";
        this.spawnTargetNear(playerPos, "dropoff");
      } else if (this.phase === "dropoff") {
        // Delivered.
        this.triggerDropoffSuccessFx(this.targetPos);
        this.deliveries++;

        // Combo: if you deliver again within combo window, multiplier increases.
        if (this.comboTimer > 0) this.combo++;
        else this.combo = 1;
        this.comboTimer = this.comboWindowSec;

        const mult = Math.min(3, 1 + 0.25 * Math.max(0, this.combo - 1));
        const gained = Math.round(100 * mult);
        this.score += gained;

        const comboTxt = this.combo >= 2 ? ` 콤보 x${this.combo}` : "";
        this.popup = { text: `+${gained}${comboTxt}`, color: "#3cff7a", t: 0, ttl: 1.35 };

        // Small time reward to keep flow (slightly scales with combo, capped).
        const timeBonus = clamp(8 + Math.min(6, (this.combo - 1) * 2), 0, 16);
        this.timeLeft = clamp(this.timeLeft + timeBonus, 0, this.timeLimitSec);

        this.phase = "pickup";
        this.spawnTargetNear(playerPos, "pickup");
      }
    }
  }

  isActive() {
    return this.phase !== "idle";
  }

  isFailed() {
    return this.phase === "failed";
  }

  isIdle() {
    return this.phase === "idle";
  }

  getHudText(playerPos?: Vector3) {

    if (this.phase === "idle") {
      return `미션: 대기 (M 시작)`;
    }
    if (this.phase === "failed") {
      return `미션 실패! (M 재시작) | 배달 ${this.deliveries} | 점수 ${this.score}`;
    }
    const label = this.phase === "pickup" ? "픽업(파란)" : "드롭(초록)";
    const comboTxt = (this.combo >= 2 && this.comboTimer > 0) ? ` | 콤보 x${this.combo}` : "";
    const dist = playerPos ? Vector3.Distance(playerPos, this.targetPos) : 0;
    const distTxt = playerPos ? ` | 거리 ${dist.toFixed(0)}m` : "";
    return `미션: ${label} → 목표 지점${distTxt}${comboTxt} | 남은시간 ${this.timeLeft.toFixed(
      0
    )}s | 배달 ${this.deliveries} | 점수 ${this.score}`;
  }

  getPopup() {
    if (!this.popup) return null;
    const p = this.popup;
    const a = clamp(1 - p.t / p.ttl, 0, 1);
    const scale = 1 + (1 - a) * 0.15;
    return { text: p.text, color: p.color, alpha: a, scale };
  }


  // --- Internal

  private createTargetMeshes() {
    const scene = this.scene;
    this.target = new TransformNode("missionTarget", scene);

    const matPickup = new StandardMaterial("mat_mission_pickup", scene);
    matPickup.diffuseColor = new Color3(0.15, 0.35, 0.9);
    matPickup.emissiveColor = new Color3(0.08, 0.18, 0.55);

    const matDrop = new StandardMaterial("mat_mission_dropoff", scene);
    matDrop.diffuseColor = new Color3(0.15, 0.9, 0.35);
    matDrop.emissiveColor = new Color3(0.08, 0.55, 0.18);

    // Ground ring
    this.ring = MeshBuilder.CreateTorus(
      "missionRing",
      { diameter: 7, thickness: 0.35, tessellation: 32 },
      scene
    );
    this.ring.parent = this.target;
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.15;
    this.ring.isPickable = false;

    // Tall beam
    this.beam = MeshBuilder.CreateCylinder(
      "missionBeam",
      { height: 12, diameter: 0.55, tessellation: 16 },
      scene
    );
    this.beam.parent = this.target;
    this.beam.position.y = 6;
    this.beam.isPickable = false;

    // Floating orb
    this.orb = MeshBuilder.CreateSphere(
      "missionOrb",
      { diameter: 1.25, segments: 16 },
      scene
    );
    this.orb.parent = this.target;
    this.orb.position.y = 6.4;
    this.orb.isPickable = false;

    // Default to pickup look.
    this.setTargetLook("pickup", matPickup, matDrop);
  }

  private createRequester() {
    const scene = this.scene;

    // Parent under the target marker so it moves together.
    this.requester = new TransformNode("missionRequester", scene);
    this.requester.parent = this.target;
    this.requester.position = new Vector3(3.2, 0, 0);

    // Materials
    const skin = new StandardMaterial("mat_mission_skin", scene);
    skin.diffuseColor = new Color3(0.85, 0.72, 0.62);

    // Role-specific tops (pickup=blue requester, dropoff=green recipient)
    const shirtMPick = new StandardMaterial("mat_mission_shirt_m_pick", scene);
    shirtMPick.diffuseColor = new Color3(0.18, 0.28, 0.72);
    const shirtFPick = new StandardMaterial("mat_mission_shirt_f_pick", scene);
    shirtFPick.diffuseColor = new Color3(0.76, 0.25, 0.46);

    const shirtMDrop = new StandardMaterial("mat_mission_shirt_m_drop", scene);
    shirtMDrop.diffuseColor = new Color3(0.16, 0.62, 0.30);
    const shirtFDrop = new StandardMaterial("mat_mission_shirt_f_drop", scene);
    shirtFDrop.diffuseColor = new Color3(0.22, 0.70, 0.36);

    const pants = new StandardMaterial("mat_mission_pants", scene);
    pants.diffuseColor = new Color3(0.18, 0.18, 0.2);
    const skirt = new StandardMaterial("mat_mission_skirt", scene);
    skirt.diffuseColor = new Color3(0.16, 0.16, 0.18);

    const hair = new StandardMaterial("mat_mission_hair", scene);
    hair.diffuseColor = new Color3(0.12, 0.08, 0.06);

    // Body (simple block character)
    const body = MeshBuilder.CreateBox(
      "missionRequesterBody",
      { width: 0.85, depth: 0.5, height: 1.25 },
      scene
    );
    body.parent = this.requester;
    body.position = new Vector3(0, 0.9, 0);
    body.isPickable = false;
    body.material = shirtMPick;
    this.requesterBody = body;

    const head = MeshBuilder.CreateBox(
      "missionRequesterHead",
      { width: 0.55, depth: 0.55, height: 0.55 },
      scene
    );
    head.parent = this.requester;
    head.position = new Vector3(0, 1.7, 0);
    head.isPickable = false;
    head.material = skin;

    const hairTop = MeshBuilder.CreateBox(
      "missionRequesterHair",
      { width: 0.6, depth: 0.6, height: 0.25 },
      scene
    );
    hairTop.parent = this.requester;
    hairTop.position = new Vector3(0, 1.9, 0);
    hairTop.isPickable = false;
    hairTop.material = hair;

    // Female skirt overlay (enabled only for female)
    const skirtMesh = MeshBuilder.CreateBox(
      "missionRequesterSkirt",
      { width: 0.9, depth: 0.55, height: 0.55 },
      scene
    );
    skirtMesh.parent = this.requester;
    skirtMesh.position = new Vector3(0, 0.25, 0);
    skirtMesh.isPickable = false;
    skirtMesh.material = skirt;
    skirtMesh.setEnabled(false);
    this.requesterSkirt = skirtMesh;

    const legs = MeshBuilder.CreateBox(
      "missionRequesterLegs",
      { width: 0.8, depth: 0.45, height: 0.55 },
      scene
    );
    legs.parent = this.requester;
    legs.position = new Vector3(0, 0.25, 0);
    legs.isPickable = false;
    legs.material = pants;

    // Speech bubble: billboarded plane with a DynamicTexture.
    this.bubbleTex = new DynamicTexture(
      "missionBubbleTex",
      { width: 512, height: 256 },
      scene,
      true
    );

    const bubbleMat = new StandardMaterial("mat_mission_bubble", scene);
    bubbleMat.diffuseTexture = this.bubbleTex;
    bubbleMat.emissiveColor = new Color3(1, 1, 1);
    bubbleMat.specularColor = new Color3(0, 0, 0);
    bubbleMat.backFaceCulling = false;

    const bubble = MeshBuilder.CreatePlane(
      "missionRequesterBubble",
      { width: 2.6, height: 1.25 },
      scene
    );
    bubble.parent = this.requester;
    bubble.position = new Vector3(0, 2.55, 0);
    bubble.isPickable = false;
    bubble.material = bubbleMat;
    bubble.billboardMode = Mesh.BILLBOARDMODE_ALL;
    // Default (idle) appearance: pickup requester
    this.setRequesterRoleStyle("pickup", false);
    this.setBubbleText("M 키로 미션 시작", "pickup");
  }

  private setBubbleText(text: string, role: "pickup" | "dropoff") {
    const ctx = this.bubbleTex.getContext();
    if (ctx) ctx.clearRect(0, 0, 512, 256);
    const bg =
      role === "pickup"
        ? "rgba(120,160,255,0.88)"
        : "rgba(120,255,170,0.86)";
    // drawText fills background when backgroundColor is provided.
    this.bubbleTex.drawText(
      text,
      null,
      150,
      "bold 46px Arial",
      "#111",
      bg,
      true,
      true
    );
  }

  private setRequesterRoleStyle(role: "pickup" | "dropoff", isFemale: boolean) {
    const mName =
      role === "pickup" ? "mat_mission_shirt_m_pick" : "mat_mission_shirt_m_drop";
    const fName =
      role === "pickup" ? "mat_mission_shirt_f_pick" : "mat_mission_shirt_f_drop";
    const shirtM = this.scene.getMaterialByName(mName) as StandardMaterial;
    const shirtF = this.scene.getMaterialByName(fName) as StandardMaterial;
    this.requesterBody.material = isFemale ? shirtF : shirtM;
    this.requesterSkirt.setEnabled(isFemale);
  }

  private setTargetLook(
    phase: "pickup" | "dropoff",
    matPickup: StandardMaterial,
    matDrop: StandardMaterial
  ) {
    const mat = phase === "pickup" ? matPickup : matDrop;
    this.ring.material = mat;
    this.beam.material = mat;
    this.orb.material = mat;
  }

  private spawnTargetNear(playerPos: Vector3, phase: "pickup" | "dropoff") {
    // Create / reuse materials
    const matPickup =
      (this.scene.getMaterialByName(
        "mat_mission_pickup"
      ) as StandardMaterial) || new StandardMaterial("mat_mission_pickup", this.scene);
    const matDrop =
      (this.scene.getMaterialByName(
        "mat_mission_dropoff"
      ) as StandardMaterial) || new StandardMaterial("mat_mission_dropoff", this.scene);
    // Ensure consistent visuals even if the material existed.
    matPickup.diffuseColor = new Color3(0.15, 0.35, 0.9);
    matPickup.emissiveColor = new Color3(0.08, 0.18, 0.55);
    matDrop.diffuseColor = new Color3(0.15, 0.9, 0.35);
    matDrop.emissiveColor = new Color3(0.08, 0.55, 0.18);
    this.setTargetLook(phase, matPickup, matDrop);

    // Better placement: snap to ChunkWorld sidewalks grid.
    // ChunkWorld has sidewalks at +/-8 units from each chunk center.
    const s = WorldConfig.CHUNK_SIZE;
    const sidewalkCenter = 8;

    // Distance distribution stabilization: avoid too-close/too-far targets.
    const minD = 38;
    const maxD = 92;
    const tries = 36;
    let best = playerPos.clone();
    let bestScore = -1e9;

    const pcx = Math.floor(playerPos.x / s);
    const pcz = Math.floor(playerPos.z / s);

    // Choose candidates and pick the best one:
    // - within [minD, maxD]
    // - prefer larger turn angle from last target direction (less repetitive)
    // - avoid spawning too close to previous target
    const safetyR = 3.0; // keep marker + requester away from building footprints
    for (let i = 0; i < tries; i++) {
      const dcx = Math.floor(Math.random() * 5) - 2; // -2..2
      const dcz = Math.floor(Math.random() * 5) - 2;
      const cx = pcx + dcx;
      const cz = pcz + dcz;

      const alongX = Math.random() < 0.5;
      const sign = Math.random() < 0.5 ? -1 : 1;

      // Place along the sidewalk, away from chunk edges.
      const edge = 10;
      const t = -s * 0.5 + edge + Math.random() * (s - edge * 2);
      const snapped = Math.round(t / 2) * 2;

      const localX = alongX ? snapped : sign * sidewalkCenter;
      const localZ = alongX ? sign * sidewalkCenter : snapped;

      const p = new Vector3(cx * s + localX, 0, cz * s + localZ);
      const dist = Vector3.Distance(p, playerPos);
      if (dist < minD || dist > maxD) continue;

      // Avoid spawning inside/too close to buildings.
      if (this.isBlocked && this.isBlocked(p, safetyR)) continue;

      const dPrev = Vector3.Distance(p, this.lastTargetPos);
      if (dPrev < minD * 0.65) continue;

      // Angle bias: reward turning away from last direction
      const ang = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
      let turn = 0.0;
      if (this.lastDirAngle != null) {
        let da = Math.abs(ang - this.lastDirAngle);
        da = da > Math.PI ? Math.PI * 2 - da : da;
        turn = da / Math.PI; // 0..1
      } else {
        turn = 0.6;
      }

      // Prefer mid distances slightly (helps feel consistent)
      const mid = (minD + maxD) * 0.5;
      const distScore = 1 - Math.abs(dist - mid) / (maxD - minD); // ~0..1
      const score = distScore * 0.55 + turn * 0.45;

      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }

// Fallback: if we failed to find a good spot, pick a stable distance on a sidewalk line.
    const bestDist = Vector3.Distance(best, playerPos);
    if (bestDist < minD || bestDist > maxD || bestDist < 1) {
      const ang = Math.random() * Math.PI * 2;
      const d = minD + Math.random() * (maxD - minD);
      const guess = new Vector3(
        playerPos.x + Math.cos(ang) * d,
        0,
        playerPos.z + Math.sin(ang) * d
      );

      const cx = Math.round(guess.x / s);
      const cz = Math.round(guess.z / s);
      const localX = guess.x - cx * s;
      const localZ = guess.z - cz * s;

      // Snap to nearest sidewalk band.
      const sx =
        Math.abs(localX - sidewalkCenter) < Math.abs(localX + sidewalkCenter)
          ? sidewalkCenter
          : -sidewalkCenter;
      const sz =
        Math.abs(localZ - sidewalkCenter) < Math.abs(localZ + sidewalkCenter)
          ? sidewalkCenter
          : -sidewalkCenter;

      const alongX = Math.abs(localX) > Math.abs(localZ);
      const t = alongX ? localX : localZ;
      const edge = 10;
      const clamped = clamp(t, -s * 0.5 + edge, s * 0.5 - edge);
      const snapped = Math.round(clamped / 2) * 2;

      best = new Vector3(
        cx * s + (alongX ? snapped : sx),
        0,
        cz * s + (alongX ? sz : snapped)
      );
    }

    // If fallback landed in a bad spot (e.g., near lots/buildings), try a few nearby sidewalk shifts.
    if (this.isBlocked && this.isBlocked(best, safetyR)) {
      const shifts = [0, 2, -2, 4, -4, 6, -6, 8, -8];
      let found = false;
      for (const dx of shifts) {
        for (const dz of shifts) {
          const cand = new Vector3(best.x + dx, 0, best.z + dz);
          // keep on sidewalk grid-ish
          if (this.isBlocked(cand, safetyR)) continue;
          best = cand;
          found = true;
          break;
        }
        if (found) break;
      }
    }

    this.targetPos.copyFrom(best);
    this.lastTargetPos.copyFrom(best);
    this.lastDirAngle = Math.atan2(best.x - playerPos.x, best.z - playerPos.z);

    this.target.position.copyFrom(this.targetPos);

    // Cosmetic requester near the marker.
    // Choose an offset direction that doesn't clip into nearby buildings.
    if (this.isBlocked) {
      const offsets = [
        new Vector3(3.2, 0, 0),
        new Vector3(-3.2, 0, 0),
        new Vector3(0, 0, 3.2),
        new Vector3(0, 0, -3.2),
        new Vector3(2.4, 0, 2.4),
        new Vector3(-2.4, 0, 2.4),
        new Vector3(2.4, 0, -2.4),
        new Vector3(-2.4, 0, -2.4),
      ];
      let chosen = offsets[0];
      for (const off of offsets) {
        const wp = new Vector3(this.targetPos.x + off.x, 0, this.targetPos.z + off.z);
        if (!this.isBlocked(wp, 1.0)) {
          chosen = off;
          break;
        }
      }
      this.requester.position.copyFrom(chosen);
    }

    // Randomize gender per spawn to make it feel alive.
    const female = Math.random() < 0.45;
    this.setRequesterRoleStyle(phase, female);
    this.requester.rotation.y = Math.random() * Math.PI * 2;
    if (phase === "pickup") {
      this.setBubbleText(female ? "배달 부탁해요!" : "배달 좀 부탁!", "pickup");
    } else {
      this.setBubbleText(female ? "여기 두고 가요!" : "여기 줘!", "dropoff");
    }

    this.showTarget();
  }

  private hideTarget() {
    this.target?.setEnabled(false);
  }

  private showTarget() {
    this.target?.setEnabled(true);
  }

  // --- Success effects

  private createFxPool() {
    const scene = this.scene;
    const base = new StandardMaterial("mat_mission_fx", scene);
    base.diffuseColor = new Color3(1, 1, 1);
    base.emissiveColor = new Color3(0.65, 0.95, 0.75);
    base.specularColor = new Color3(0, 0, 0);
    base.alpha = 0;

    for (let i = 0; i < 14; i++) {
      const m = MeshBuilder.CreateSphere(
        `missionFx_${i}`,
        { diameter: 0.35, segments: 6 },
        scene
      );
      m.isPickable = false;
      m.material = base.clone(`mat_mission_fx_${i}`);
      (m.material as StandardMaterial).alpha = 0;
      m.setEnabled(false);
      this.fxPool.push(m);
    }
  }

  private triggerDropoffSuccessFx(at: Vector3) {
    const count = 8;
    for (let i = 0; i < count; i++) {
      const m = this.fxPool.pop();
      if (!m) break;
      m.setEnabled(true);
      m.position.copyFrom(at);
      m.position.y += 1.0 + Math.random() * 0.6;
      const ang = Math.random() * Math.PI * 2;
      const sp = 2.2 + Math.random() * 2.0;
      const v = new Vector3(
        Math.cos(ang) * sp,
        2.5 + Math.random() * 2.0,
        Math.sin(ang) * sp
      );
      const mat = m.material as StandardMaterial;
      mat.alpha = 1;
      mat.emissiveColor = new Color3(
        0.55 + Math.random() * 0.25,
        0.9,
        0.6 + Math.random() * 0.25
      );
      this.fxActive.push({ mesh: m, t: 0, ttl: 0.42 + Math.random() * 0.18, v });
    }
    this.playSuccessBeep();
  }

  private playSuccessBeep() {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      if (!this.audioCtx) this.audioCtx = new Ctx();
      const ctx = this.audioCtx!;
      if (ctx.state === "suspended") ctx.resume?.();

      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = 740;
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(ctx.destination);

      const t0 = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
      o.start(t0);
      o.stop(t0 + 0.16);
    } catch {
      // ignore audio errors
    }
  }
}