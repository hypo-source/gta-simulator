// Touch + Mouse + Keyboard input unified in one class.
// - Mobile: left-half drag => move (virtual joystick), right-half drag => look (yaw)
// - PC: WASD => move, Arrow keys or LMB-drag => look

type InputSnapshot = {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  /** Mouse wheel delta since last frame (PC only). Positive usually means wheel down. */
  zoom: number;
  jump: boolean;
  sprint: boolean;
};

export class TouchControls {
  private canvas: HTMLCanvasElement;
  private rect: DOMRect;
  private maxRadiusPx = 70;

  // Virtual joystick (left)
  private leftPointerId: number | null = null;
  private joyStart = { x: 0, y: 0 };
  private joy = { x: 0, y: 0 }; // [-1..1]

  // Look (right)
  private rightPointerId: number | null = null;
  private lastLookX = 0;
  private lastLookY = 0;
  private lookAccumX = 0; // accumulated since last read
  private lookAccumY = 0; // accumulated since last read

  // Mouse look
  private mouseLookActive = false;

  // Mouse wheel zoom (accumulated since last read)
  private zoomAccum = 0;

  // Jump trigger (tap / key)
  private jumpQueued = false;
  private lastTapTimeMs = 0;
  private tapSlopPx = 12;
  private tapStart: {x:number;y:number; t:number} | null = null;

  private mouseLastX = 0;
  private mouseLastY = 0;

  // Keyboard state
  private keys = new Set<string>();

  // Options
  private invertPitch = false; // false: mouse up => look up (default). true: inverted.

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.rect = this.canvas.getBoundingClientRect();
    this.onResize();

    // Keyboard
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);

      // Toggle pitch inversion (I)
      if (e.code === "KeyI" && !e.repeat) {
        this.invertPitch = !this.invertPitch;
        try {
          localStorage.setItem("invertPitch", this.invertPitch ? "1" : "0");
        } catch {
          // ignore
        }
      }
      // Prevent page scrolling with arrows/space when the game is focused.
      if (
        e.code === "ArrowLeft" ||
        e.code === "ArrowRight" ||
        e.code === "ArrowUp" ||
        e.code === "ArrowDown" ||
        e.code === "Space"
      ) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    // Pointer events cover both touch and mouse.
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Wheel zoom (PC)
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        // Prevent page scroll while zooming the camera.
        e.preventDefault();
        // Accumulate raw wheel delta; CameraController will normalize it.
        this.zoomAccum += e.deltaY;
      },
      { passive: false }
    );

    this.canvas.addEventListener("pointerdown", this.onPointerDown, {
      passive: false,
    });
    this.canvas.addEventListener("pointermove", this.onPointerMove, {
      passive: false,
    });
    this.canvas.addEventListener("pointerup", this.onPointerUp, {
      passive: false,
    });
    this.canvas.addEventListener("pointercancel", this.onPointerUp, {
      passive: false,
    });

    // Load persisted option
    try {
      const v = localStorage.getItem("invertPitch");
      if (v === "1") this.invertPitch = true;
      if (v === "0") this.invertPitch = false;
    } catch {
      // ignore
    }
  }

  isPitchInverted() {
    return this.invertPitch;
  }

  onResize() {
    this.rect = this.canvas.getBoundingClientRect();
    // Scale joystick radius with screen size, but keep reasonable bounds.
    const base = Math.min(this.rect.width, this.rect.height);
    this.maxRadiusPx = Math.max(55, Math.min(110, base * 0.14));
  }

  readInput(): InputSnapshot {
    // Keyboard movement
    const k = (code: string) => (this.keys.has(code) ? 1 : 0);
    const moveXKey = k("KeyD") - k("KeyA");
    const moveYKey = k("KeyW") - k("KeyS");

    // Arrow look
    const lookXKey = k("ArrowRight") - k("ArrowLeft");
    const lookYKey = k("ArrowUp") - k("ArrowDown");

    const sprintKey = (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"));
    const jumpKey = this.keys.has("Space");

    // Combine with touch joystick
    let moveX = this.joy.x + moveXKey;
    let moveY = this.joy.y + moveYKey;

    // Clamp movement to [-1..1]
    moveX = Math.max(-1, Math.min(1, moveX));
    moveY = Math.max(-1, Math.min(1, moveY));

    // Look: accumulated pointer deltas + arrow keys
    // Pointer deltas are scaled into a reasonable normalized range.
    const pointerLookX = this.lookAccumX;
    const pointerLookY = this.lookAccumY;
    this.lookAccumX = 0; // consume each frame
    this.lookAccumY = 0; // consume each frame

    // Mouse wheel zoom (consume each frame)
    const zoom = this.zoomAccum;
    this.zoomAccum = 0;

    const lookX = pointerLookX + lookXKey * 1.2;
    const lookY = pointerLookY + lookYKey * 1.2;

    const joyMag = Math.min(1, Math.hypot(this.joy.x, this.joy.y));
    const sprint = sprintKey || joyMag > 0.88;
    const jump = jumpKey || this.jumpQueued;
    this.jumpQueued = false;

    return { moveX, moveY, lookX, lookY, jump, sprint, zoom };
  }

  private toLocal = (e: PointerEvent) => {
    const x = e.clientX - this.rect.left;
    const y = e.clientY - this.rect.top;
    return { x, y };
  };

  private onPointerDown = (e: PointerEvent) => {
    // Keep the browser from doing selection/scroll gestures.
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    const p = this.toLocal(e);
    const isLeftHalf = p.x < this.rect.width * 0.5;

    if (e.pointerType === "mouse") {
      // Left mouse button drag => look
      if (e.button === 0) {
        this.mouseLookActive = true;
        this.mouseLastX = p.x;
        this.mouseLastY = p.y;
      }
      return;
    }

    // Touch / pen
    this.tapStart = { x: p.x, y: p.y, t: performance.now() };
    if (isLeftHalf && this.leftPointerId === null) {
      this.leftPointerId = e.pointerId;
      this.joyStart = { x: p.x, y: p.y };
      this.joy = { x: 0, y: 0 };
    } else if (!isLeftHalf && this.rightPointerId === null) {
      this.rightPointerId = e.pointerId;
      this.lastLookX = p.x;
      this.lastLookY = p.y;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    e.preventDefault();
    const p = this.toLocal(e);

    // Mouse look
    if (e.pointerType === "mouse" && this.mouseLookActive) {
      const dx = p.x - this.mouseLastX;
      const dy = p.y - this.mouseLastY;
      this.mouseLastX = p.x;
      this.mouseLastY = p.y;
      this.accumulateLook(dx, dy, true);
      return;
    }

    // Touch joystick
    if (this.leftPointerId === e.pointerId) {
      const dx = p.x - this.joyStart.x;
      const dy = p.y - this.joyStart.y;
      const nx = Math.max(-1, Math.min(1, dx / this.maxRadiusPx)); // right drag => +X (right)
      const ny = Math.max(-1, Math.min(1, -dy / this.maxRadiusPx)); // up drag => +Y (forward)
      this.joy = { x: nx, y: ny };
      return;
    }

    // Touch look
    if (this.rightPointerId === e.pointerId) {
      const dx = p.x - this.lastLookX;
      const dy = p.y - this.lastLookY;
      this.lastLookX = p.x;
      this.lastLookY = p.y;
      this.accumulateLook(dx, dy, false);
      return;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    e.preventDefault();
    const p = this.toLocal(e);
    if (e.pointerType === "mouse") {
      if (e.button === 0) this.mouseLookActive = false;
      return;
    }

    // Tap / double-tap => jump (mobile friendly)
    if (this.tapStart) {
      const now = performance.now();
      const dx = p.x - this.tapStart.x;
      const dy = p.y - this.tapStart.y;
      const dist2 = dx * dx + dy * dy;
      const dt = now - this.tapStart.t;
      const isTap = dt < 220 && dist2 < this.tapSlopPx * this.tapSlopPx;
      if (isTap) {
        if (now - this.lastTapTimeMs < 320) {
          this.jumpQueued = true;
          this.lastTapTimeMs = 0;
        } else {
          this.lastTapTimeMs = now;
        }
      }
      this.tapStart = null;
    }
    if (this.leftPointerId === e.pointerId) {
      this.leftPointerId = null;
      this.joy = { x: 0, y: 0 };
    }
    if (this.rightPointerId === e.pointerId) {
      this.rightPointerId = null;
    }
  };

  private accumulateLook(dxPx: number, dyPx: number, isMouse: boolean) {
    // Convert pixel delta into a small normalized look velocity.
    // Bigger screens naturally produce smaller normalized deltas.
    const w = Math.max(1, this.rect.width);
    const h = Math.max(1, this.rect.height);
    const dxNorm = dxPx / w;
    const dyNorm = dyPx / h;
    const baseSensitivity = 8.5;
    // Mouse: 4x the previous sensitivity (2.0 -> 8.0)
    const sensitivity = baseSensitivity * (isMouse ? 8.0 : 1.0);

    // Reverse mouse LMB-drag direction from the previous behavior
    // (drag right => turn right)
    this.lookAccumX += dxNorm * sensitivity;

    // Pitch inversion option:
    // invertPitch=false => mouse up (dy<0) => look up (positive lookY)
    // invertPitch=true  => mouse up (dy<0) => look down
    const pitchSign = this.invertPitch ? 1 : -1;
    this.lookAccumY += dyNorm * sensitivity * pitchSign;
  }
}