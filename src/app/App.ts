import { EngineHost } from "../engine/EngineHost";
import { ChunkWorld } from "../world/ChunkWorld";
import { Player } from "../game/Player";
import { CameraController } from "../game/CameraController";
import { TouchControls } from "../game/TouchControls";
import { WorldConfig } from "../world/WorldConfig";
import { NPCManager } from "../npc/NPCManager";
import { MissionManager } from "../game/MissionManager";
import { Vehicle } from "../game/Vehicle";

export class App {
  private host: EngineHost;
  private world!: ChunkWorld;
  private player!: Player;
  private camera!: CameraController;
  private controls!: TouchControls;
  private hintEl: HTMLDivElement | null = null;
  private fpsEl: HTMLDivElement | null = null;
  private missionEl: HTMLDivElement | null = null;
  private popupEl: HTMLDivElement | null = null;
  private missionBtn: HTMLButtonElement | null = null;
  private navCanvas: HTMLCanvasElement | null = null;
  private navCtx: CanvasRenderingContext2D | null = null;
  private navArrowEl: HTMLDivElement | null = null;
  private fpsValue = 0;
  private fpsFrames = 0;
  private fpsLastSampleMs = 0;
  private npc!: NPCManager;
  private mission!: MissionManager;
  private vehicle!: Vehicle;
  private inVehicle = false;
  private interactQueued = false;
  private playerBaseScale = 0.75;

  // Auto quality state
  private qLowMs = 0;
  private qHighMs = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.host = new EngineHost(canvas);
  }

  async start() {
    const { scene } = this.host;

    this.world = new ChunkWorld(scene);
    this.player = new Player(scene);
		this.camera = new CameraController(scene, this.player.root);
    this.controls = new TouchControls(this.host.canvas);
    this.npc = new NPCManager(scene);
    this.mission = new MissionManager(scene, (pos, r) => this.world.isCircleOverlappingBuildings(pos, r));
    this.vehicle = new Vehicle(scene);
    this.playerBaseScale = this.player.root.scaling.x || 0.75;

    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyE" && !e.repeat) this.interactQueued = true;
    });

    this.mountControlsHint();
    this.mountFpsHud();
    this.mountMissionHud();
    this.mountPopupHud();
    this.mountNavHud();

    this.host.bindResize(() => {
      this.camera.onResize();
      this.controls.onResize();
    });

    this.host.run(() => {
      const dt = this.host.getDeltaSeconds();
      const input = this.controls.readInput();

      // 탑승/하차 처리
      if (this.interactQueued) {
        this.interactQueued = false;

        if (!this.inVehicle) {
          const dist = this.vehicle.distanceTo(this.player.root.position);
          if (dist <= 3.2) {
            this.inVehicle = true;
            // 카메라가 player.root를 타겟으로 쓰는 구조라 root disable은 피하고, 시각만 숨김
            this.player.root.scaling.setAll(0.001);
          }
        } else {
          this.inVehicle = false;
          this.player.root.scaling.setAll(this.playerBaseScale);
          this.player.root.position.copyFrom(this.vehicle.getExitPosition());
        }
      }

      // 기준 위치 선택
      const refPos = this.inVehicle ? this.vehicle.root.position : this.player.root.position;

      if (this.inVehicle) {
        // 차량 조작
        const throttle = input.moveY;   // W:+1, S:-1
        const steer = input.moveX;      // A:-1, D:+1
        const boost = input.sprint;     // Shift
        const handbrake = input.jump;   // Space (재사용)

        this.vehicle.update(dt, { throttle, steer, boost, handbrake });

        // 카메라/미션/월드가 player root 기반이라 player root를 차량에 붙여준다
        this.player.root.position.copyFrom(this.vehicle.root.position);
        this.player.root.rotation.y = this.vehicle.root.rotation.y;
      } else {
        this.player.update(dt, input, (pos, r) => this.world.resolveCircleAgainstBuildings(pos, r));
      }

      this.world.update(refPos);
      this.npc.update(dt, refPos, (pos, r) => this.world.resolveCircleAgainstBuildings(pos, r));
      this.mission.update(dt, refPos);

      this.camera.addZoomDelta(input.zoom);
      this.camera.updateWithInput(dt, input.lookY);

      this.updateFpsHud();
      this.updateMissionHud();
      this.updatePopupHud();
      this.updateNavHud();
      this.autoQuality(dt);
    });
  }

  private mountMissionHud() {
    const el = document.createElement("div");
    el.id = "missionHud";

    Object.assign(el.style, {
      position: "fixed",
      left: "12px",
      bottom: "12px",
      zIndex: "10000",
      color: "#fff",
      background: "rgba(0,0,0,0.45)",
      padding: "8px 10px",
      borderRadius: "10px",
      fontSize: "13px",
      fontWeight: "700",
      lineHeight: "1.25",
      backdropFilter: "blur(6px)",
      userSelect: "none",
      pointerEvents: "none",
      letterSpacing: "0.2px",
      maxWidth: "min(620px, calc(100vw - 24px))",
    } as Partial<CSSStyleDeclaration>);

    el.textContent = "미션: 대기 (M 시작)";
    document.body.appendChild(el);
    this.missionEl = el;

    // Mobile/Touch-friendly start button (doesn't interfere with controls).
    const btn = document.createElement("button");
    btn.id = "missionBtn";
    btn.textContent = "미션 시작";
    Object.assign(btn.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "10001",
      padding: "10px 12px",
      borderRadius: "12px",
      border: "1px solid rgba(255,255,255,0.25)",
      background: "rgba(0,0,0,0.55)",
      color: "#fff",
      fontSize: "13px",
      fontWeight: "800",
      letterSpacing: "0.2px",
      cursor: "pointer",
      userSelect: "none",
      touchAction: "manipulation",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(btn);
    this.missionBtn = btn;

    const isTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
    // On desktop, keep it subtle but available.
    btn.style.opacity = isTouch ? "1" : "0.55";

    const startMission = () => {
      const refPos = this.inVehicle ? this.vehicle.root.position : this.player.root.position;
      this.mission.start(refPos);
      this.updateMissionHud();
      this.updatePopupHud();
      btn.textContent = "미션 재시작";
    };
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startMission();
    });

    // Start / restart the mission with M.
    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyM") {
        startMission();
      }
    });
  }

  private updateMissionHud() {
    if (!this.missionEl) return;
    this.missionEl.textContent = this.mission.getHudText(
      this.player?.root?.position
    );

    if (this.missionBtn) {
      if (this.mission.isIdle()) this.missionBtn.textContent = "미션 시작";
      else this.missionBtn.textContent = "미션 재시작";
    }
  }

  private mountFpsHud() {
    const el = document.createElement("div");
    el.id = "fpsHud";

    Object.assign(el.style, {
      position: "fixed",
      right: "12px",
      top: "12px",
      zIndex: "10000",
      color: "#fff",
      background: "rgba(0,0,0,0.45)",
      padding: "6px 10px",
      borderRadius: "10px",
      fontSize: "13px",
      fontWeight: "700",
      lineHeight: "1.2",
      backdropFilter: "blur(6px)",
      userSelect: "none",
      pointerEvents: "none",
      letterSpacing: "0.2px",
      minWidth: "220px",
      textAlign: "right",
    } as Partial<CSSStyleDeclaration>);

    el.textContent = "FPS --";
    document.body.appendChild(el);
    this.fpsEl = el;
  }

  
  private windowQualityLabel() {
    // Higher skip => fewer windows => lower detail.
    const avgSkip = (WorldConfig.WINDOW_SKIP_FRONT + WorldConfig.WINDOW_SKIP_SIDE) * 0.5;
    if (avgSkip >= 0.52) return "low";
    if (avgSkip >= 0.34) return "med";
    return "high";
  }

private updateFpsHud() {
    if (!this.fpsEl) return;

    // Robust FPS sampling (avoids Infinity/NaN on some platforms/first frames)
    const now = performance.now();
    if (!this.fpsLastSampleMs) this.fpsLastSampleMs = now;
    this.fpsFrames++;

    const elapsed = now - this.fpsLastSampleMs;
    if (elapsed >= 500) {
      this.fpsValue = (this.fpsFrames * 1000) / elapsed;
      this.fpsFrames = 0;
      this.fpsLastSampleMs = now;
    }

    const shown = Number.isFinite(this.fpsValue) && this.fpsValue > 0 ? this.fpsValue : 0;
    const npc = this.npc?.getStats?.();
    const npcText = npc ? `  |  NPC ${npc.sim}/${npc.crowd}/${npc.fake}` : "";
    this.fpsEl.textContent = `FPS ${shown.toFixed(0)}  |  R=${WorldConfig.FAR_RADIUS}  |  windows=${this.windowQualityLabel()}${npcText}`;
  }


private mountPopupHud() {
  const el = document.createElement("div");
  el.id = "missionPopup";
  Object.assign(el.style, {
    position: "fixed",
    left: "50%",
    top: "18%",
    transform: "translate(-50%, -50%)",
    zIndex: "10002",
    padding: "10px 14px",
    borderRadius: "999px",
    background: "rgba(0,0,0,0.35)",
    color: "#fff",
    fontSize: "18px",
    fontWeight: "900",
    letterSpacing: "0.4px",
    textShadow: "0 2px 10px rgba(0,0,0,0.55)",
    userSelect: "none",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 60ms linear",
    whiteSpace: "nowrap",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  this.popupEl = el;
}

private updatePopupHud() {
  if (!this.popupEl) return;
  const p = this.mission.getPopup();
  if (!p) {
    this.popupEl.style.opacity = "0";
    return;
  }
  this.popupEl.textContent = p.text;
  this.popupEl.style.color = p.color;
  this.popupEl.style.opacity = String(p.alpha);
  this.popupEl.style.transform = `translate(-50%, -50%) scale(${p.scale.toFixed(3)})`;
}

  private mountNavHud() {
    // Circular minimap + edge arrow indicator for current mission target
    const canvas = document.createElement("canvas");
    canvas.id = "navMiniMap";
    canvas.width = 160;
    canvas.height = 160;

    Object.assign(canvas.style, {
      position: "fixed",
      left: "12px",
      bottom: "96px",
      width: "160px",
      height: "160px",
      borderRadius: "50%",
      background: "rgba(0,0,0,0.25)",
      border: "1px solid rgba(255,255,255,0.18)",
      boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
      zIndex: "10000",
      pointerEvents: "none",
      backdropFilter: "blur(6px)",
    } as Partial<CSSStyleDeclaration>);

    document.body.appendChild(canvas);
    this.navCanvas = canvas;
    this.navCtx = canvas.getContext("2d");

    const arrow = document.createElement("div");
    arrow.id = "navEdgeArrow";
    Object.assign(arrow.style, {
      position: "fixed",
      width: "0",
      height: "0",
      borderLeft: "12px solid transparent",
      borderRight: "12px solid transparent",
      borderBottom: "20px solid rgba(40,220,255,0.92)",
      filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.35))",
      zIndex: "10002",
      pointerEvents: "none",
      transformOrigin: "50% 60%",
      opacity: "0",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(arrow);
    this.navArrowEl = arrow;
  }

  private updateNavHud() {
    const ctx = this.navCtx;
    const canvas = this.navCanvas;
    if (!ctx || !canvas) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.5 - 6;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    // Subtle background
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0, 0, w, h);

    // Grid rings
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.66, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.33, 0, Math.PI * 2);
    ctx.stroke();

    // Heading (player forward)
    const yaw = this.player?.root?.rotation?.y ?? 0;
    // 0 rad means +Z forward in our world; minimap 0 should point up.
    const headingX = Math.sin(yaw);
    const headingY = -Math.cos(yaw);

    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + headingX * radius * 0.55, cy + headingY * radius * 0.55);
    ctx.stroke();

    // Player dot
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();

    // Target
    const info = this.mission.getTargetInfo?.();
    const arrowEl = this.navArrowEl;

    if (info && this.player?.root?.position) {
      const p = this.player.root.position;
      const dx = info.pos.x - p.x;
      const dz = info.pos.z - p.z;

      const dist = Math.sqrt(dx * dx + dz * dz);
      const maxRange = 140; // meters mapped to edge of minimap

      // World angle: 0 => +Z (forward), + => right
      const worldAngle = Math.atan2(dx, dz);
      const rel = worldAngle - yaw;

      // Map to minimap space (relative to heading, so forward is up)
      const t = Math.min(1, dist / maxRange);
      const px = cx + Math.sin(rel) * (radius * 0.9 * t);
      const py = cy - Math.cos(rel) * (radius * 0.9 * t);

      // Color by phase (pickup: blue, dropoff: green)
      const isPickup = info.phase === "pickup";
      ctx.fillStyle = isPickup ? "rgba(70,140,255,0.95)" : "rgba(70,255,140,0.95)";
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();

      // Edge arrow indicator (always show when mission active)
      if (arrowEl) {
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        const scx = winW * 0.5;
        const scy = winH * 0.5;
        const margin = 38;
        const rr = Math.min(scx, scy) - margin;

        // For screen placement, use relative angle as well (forward is up)
        const sx = scx + Math.sin(rel) * rr;
        const sy = scy - Math.cos(rel) * rr;

        arrowEl.style.left = `${sx}px`;
        arrowEl.style.top = `${sy}px`;
        const deg = (rel * 180) / Math.PI;
        arrowEl.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
        arrowEl.style.opacity = "0.95";
        // Phase color
        arrowEl.style.borderBottomColor = isPickup
          ? "rgba(70,140,255,0.92)"
          : "rgba(70,255,140,0.92)";
      }
    } else {
      // No active mission => hide edge arrow
      if (arrowEl) arrowEl.style.opacity = "0";
    }

    // Compass "N" (world north = +Z = up when yaw==0)
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "700 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("N", cx, 10);

    ctx.restore();

    // Outer stroke
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }


  private autoQuality(dt: number) {
    // Keep FPS high by dynamically adjusting load radius + window density.
    // Targets ~55-60fps. Uses hysteresis to avoid oscillation.
    const fps = this.fpsValue;
    if (!Number.isFinite(fps) || fps <= 0) return;

    // Accumulate time spent in low/high FPS zones
    if (fps < 50) {
      this.qLowMs += dt * 1000;
      this.qHighMs = 0;
    } else if (fps > 58) {
      this.qHighMs += dt * 1000;
      this.qLowMs = 0;
    } else {
      this.qLowMs = 0;
      this.qHighMs = 0;
    }

    // Downshift quality quicker, upshift slower.
    if (this.qLowMs > 1200) {
      WorldConfig.FAR_RADIUS = Math.max(1, WorldConfig.FAR_RADIUS - 1);
      WorldConfig.WINDOW_SKIP_FRONT = Math.min(0.75, WorldConfig.WINDOW_SKIP_FRONT + 0.06);
      WorldConfig.WINDOW_SKIP_SIDE = Math.min(0.80, WorldConfig.WINDOW_SKIP_SIDE + 0.06);
      WorldConfig.BUILDING_DETAIL_LOD_DIST = Math.max(28, WorldConfig.BUILDING_DETAIL_LOD_DIST - 6);
      this.qLowMs = 0;
    }

    if (this.qHighMs > 4500) {
      WorldConfig.FAR_RADIUS = Math.min(WorldConfig.FAR_RADIUS_MAX, WorldConfig.FAR_RADIUS + 1);
      WorldConfig.WINDOW_SKIP_FRONT = Math.max(0.18, WorldConfig.WINDOW_SKIP_FRONT - 0.04);
      WorldConfig.WINDOW_SKIP_SIDE = Math.max(0.22, WorldConfig.WINDOW_SKIP_SIDE - 0.04);
      WorldConfig.BUILDING_DETAIL_LOD_DIST = Math.min(60, WorldConfig.BUILDING_DETAIL_LOD_DIST + 6);
      this.qHighMs = 0;
    }
  }

  private mountControlsHint() {
    // Simple on-screen help (works on both PC & mobile).
    const el = document.createElement("div");
    el.id = "controlsHint";
    el.innerHTML = `
      <div style="font-weight:700; margin-bottom:6px;">조작</div>
      <div style="margin-bottom:6px;">
        <div><b>PC</b> · 이동: <b>WASD</b> · 달리기: <b>Shift</b> · 점프: <b>Space</b></div>
        <div>회전: <b>←/→</b> 또는 <b>마우스 좌클릭 드래그</b></div>
        <div>상하 시점: <b>↑/↓</b> 또는 <b>드래그 상하</b></div>
        <div>줌 인/아웃: <b>마우스 휠</b></div>
        <div>피치 반전 토글: <b>I</b> (<span id="invertPitchState"></span>)</div>
        <div>미니 미션(배달/체크포인트) 시작/재시작: <b>M</b></div>
        <div>탑승/하차: <b>E</b> (차량 근처)</div>
      </div>
      <div>
        <div><b>모바일</b> · 왼쪽 드래그: 이동 · 오른쪽 드래그: 회전</div>
        <div>상하 시점: 오른쪽 드래그 상하</div>
        <div>점프: <b>더블탭</b> · 달리기: 조이스틱을 끝까지</div>
      </div>
      <div style="margin-top:6px; opacity:0.85;">힌트 숨기기/보이기: <b>H</b></div>
    `.trim();

    // Inline styles so it works without extra CSS edits.
    Object.assign(el.style, {
      position: "fixed",
      left: "12px",
      top: "12px",
      zIndex: "9999",
      color: "#fff",
      background: "rgba(0,0,0,0.45)",
      padding: "10px 12px",
      borderRadius: "12px",
      fontSize: "13px",
      lineHeight: "1.35",
      backdropFilter: "blur(6px)",
      maxWidth: "min(520px, calc(100vw - 24px))",
      userSelect: "none",
      pointerEvents: "none",
    } as Partial<CSSStyleDeclaration>);

    document.body.appendChild(el);
    this.hintEl = el;

    // Toggle with H (PC)
    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyH" && this.hintEl) {
        this.hintEl.style.display = this.hintEl.style.display === "none" ? "block" : "none";
      }

      if (e.code === "KeyI" && this.hintEl) {
        const span = this.hintEl.querySelector<HTMLSpanElement>("#invertPitchState");
        if (span && this.controls) {
          span.textContent = this.controls.isPitchInverted() ? "반전 ON" : "반전 OFF";
        }
      }
    });

    // Initialize invert pitch state label
    const span = el.querySelector<HTMLSpanElement>("#invertPitchState");
    if (span && this.controls) {
      span.textContent = this.controls.isPitchInverted() ? "반전 ON" : "반전 OFF";
    }
  }
}
