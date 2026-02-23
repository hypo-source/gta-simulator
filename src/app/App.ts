import { EngineHost } from "../engine/EngineHost";
import { ChunkWorld } from "../world/ChunkWorld";
import { Player } from "../game/Player";
import { CameraController } from "../game/CameraController";
import { TouchControls } from "../game/TouchControls";
import { WorldConfig } from "../world/WorldConfig";
import { NPCManager } from "../npc/NPCManager";
import { MissionManager } from "../game/MissionManager";

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
  private fpsValue = 0;
  private fpsFrames = 0;
  private fpsLastSampleMs = 0;
  private npc!: NPCManager;
  private mission!: MissionManager;

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

    this.mountControlsHint();
    this.mountFpsHud();
    this.mountMissionHud();
    this.mountPopupHud();

    this.host.bindResize(() => {
      this.camera.onResize();
      this.controls.onResize();
    });

    this.host.run(() => {
      const dt = this.host.getDeltaSeconds();
      const input = this.controls.readInput();
      this.player.update(dt, input, (pos, r) => this.world.resolveCircleAgainstBuildings(pos, r));
      this.world.update(this.player.root.position);
      // Let NPCs cheaply avoid building footprints & player overlap.
      this.npc.update(dt, this.player.root.position, (pos, r) => this.world.resolveCircleAgainstBuildings(pos, r));
      this.mission.update(dt, this.player.root.position);
      this.camera.addZoomDelta(input.zoom);
      this.camera.updateWithInput(dt, input.lookY);
      this.updateFpsHud();
      this.updateMissionHud();
      this.updatePopupHud();
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
      this.mission.start(this.player.root.position);
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