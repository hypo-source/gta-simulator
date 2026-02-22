import { EngineHost } from "../engine/EngineHost";
import { ChunkWorld } from "../world/ChunkWorld";
import { Player } from "../game/Player";
import { CameraController } from "../game/CameraController";
import { TouchControls } from "../game/TouchControls";
import { WorldConfig } from "../world/WorldConfig";
import { NPCManager } from "../npc/NPCManager";

export class App {
  private host: EngineHost;
  private world!: ChunkWorld;
  private player!: Player;
  private camera!: CameraController;
  private controls!: TouchControls;
  private hintEl: HTMLDivElement | null = null;
  private fpsEl: HTMLDivElement | null = null;
  private fpsValue = 0;
  private fpsFrames = 0;
  private fpsLastSampleMs = 0;
  private npc!: NPCManager;
  private canvas: HTMLCanvasElement;

  // Auto quality state
  private qLowMs = 0;
  private qHighMs = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.host = new EngineHost(canvas);
  }

  async start() {
    const { scene } = this.host;

    this.world = new ChunkWorld(scene);
    this.player = new Player(scene);
    this.camera = new CameraController(scene, this.player.root, this.host.canvas);
    this.controls = new TouchControls(this.host.canvas);
    this.npc = new NPCManager(scene);

    this.mountControlsHint();
    this.mountFpsHud();

    this.host.bindResize(() => {
      this.camera.onResize();
      this.controls.onResize();
    });

    this.host.run(() => {
      const dt = this.host.getDeltaSeconds();
      const input = this.controls.readInput();
      this.player.update(dt, input);
      this.world.update(this.player.root.position);
        this.npc.update(dt, this.player.root.position);
      this.camera.addZoomDelta(input.zoom);
      this.camera.updateWithInput(dt, input.lookY);
      this.updateFpsHud();
      this.autoQuality(dt);
    });
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
