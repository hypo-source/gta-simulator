import { ArcRotateCamera, Ray, Scene, TransformNode, Vector3, AbstractMesh } from "@babylonjs/core";

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// Lerp angles with wrap-around (shortest path)
function lerpAngle(a: number, b: number, t: number) {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

export class CameraController {
  private cam: ArcRotateCamera;
  private target: TransformNode;
  private pivot: TransformNode;

  // User-controlled pitch (beta). We keep it independent from player yaw.
  private pitch = Math.PI / 3;
  private minBeta = 0.28; // ~16 deg (look up)
  private maxBeta = 1.35; // ~77 deg (look down)

  private baseRadius = 9.5;
  private zoomRadius = 9.5;
  private baseFov = 0.85;

  // Spring tuning (bigger = snappier)
  private followSharpness = 12;

  // Collision tuning
  private minRadius = 2.2;
  private collisionMargin = 0.45;

  constructor(scene: Scene, target: TransformNode, canvas: HTMLCanvasElement) {
    this.target = target;

    // Pivot sits slightly above the player (eye/shoulder height).
    this.pivot = new TransformNode("cameraPivot", scene);
    this.pivot.parent = target;
    this.pivot.position = new Vector3(0, 1.25, 0);

    this.cam = new ArcRotateCamera(
      "cam",
      // Start behind the player so WASD feels intuitive.
      Math.PI,
      Math.PI / 3,
      10,
      this.pivot.getAbsolutePosition().clone(),
      scene
    );

    // Follow pivot (keeps camera centered slightly above the player).
    this.cam.lockedTarget = this.pivot;

    // We drive look/rotation ourselves (RMB-drag / right-half drag),
    // so we avoid Babylon's default orbit inputs to keep controls consistent.
    this.cam.keysUp = [];
    this.cam.keysDown = [];
    this.cam.keysLeft = [];
    this.cam.keysRight = [];

    // Enable scene picking (used for camera collision raycasts).
    scene.activeCamera = this.cam;

    // Apply initial sizing (otherwise it only updates on resize/orientation events).
    this.onResize();
  }

  onResize() {
    const portrait = window.innerHeight >= window.innerWidth;
    this.baseRadius = portrait ? 11 : 9.5;
    this.baseFov = portrait ? 0.9 : 0.85;

    this.cam.fov = this.baseFov;
    // Keep the user's zoom preference, but adjust if it was never set.
    if (!Number.isFinite(this.zoomRadius) || this.zoomRadius <= 0) this.zoomRadius = this.baseRadius;
    if (!Number.isFinite(this.cam.radius) || this.cam.radius <= 0) this.cam.radius = this.zoomRadius;
  }

  /**
   * Mouse wheel zoom.
   * - deltaY > 0  : wheel down (zoom out)
   * - deltaY < 0  : wheel up (zoom in)
   */
  addZoomDelta(deltaY: number) {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;

    // Normalize wheel delta into a nice step.
    // Typical mouse wheel notch is ~100; trackpads can be smaller/frequent.
    const step = deltaY / 160;
    this.zoomRadius = this.zoomRadius + step;

    // Clamp
    const min = 3.2;
    const max = 18;
    this.zoomRadius = Math.max(min, Math.min(max, this.zoomRadius));
  }

  update(dt: number) {
    // Keep the camera behind the player's facing direction.
    // Player yaw is stored on the target's Y rotation.
    const yaw = this.target.rotation.y || 0;

    // For our +Z forward convention in Player, "behind" is alpha = -yaw - PI/2.
    const desiredAlpha = -yaw - Math.PI / 2;
    // Apply user pitch input (TouchControls provides lookY)
    // NOTE: pitch is integrated elsewhere by passing lookY into update.
    const desiredBeta = Math.max(this.minBeta, Math.min(this.maxBeta, this.pitch));

    // Spring step (frame-rate independent)
    const t = 1 - Math.exp(-this.followSharpness * Math.max(0, dt));

    // Smoothly rotate
    this.cam.alpha = lerpAngle(this.cam.alpha, desiredAlpha, t);
    this.cam.beta = lerp(this.cam.beta, desiredBeta, t);

    // Collision-aware radius (raycast from pivot to desired camera position)
    const desiredRadius = this.zoomRadius;

    const pivotPos = this.pivot.getAbsolutePosition().clone();

    // Desired camera position from spherical coords (ArcRotate convention, LH).
    const sinBeta = Math.sin(this.cam.beta);
    const offset = new Vector3(
      desiredRadius * Math.cos(this.cam.alpha) * sinBeta,
      desiredRadius * Math.cos(this.cam.beta),
      desiredRadius * Math.sin(this.cam.alpha) * sinBeta
    );

    const desiredPos = pivotPos.add(offset);
    const dir = desiredPos.subtract(pivotPos);
    const len = dir.length();
    let radiusAllowed = desiredRadius;

    if (len > 1e-4) {
      const ray = new Ray(pivotPos, dir.scale(1 / len), len);
      const pick = this.cam.getScene().pickWithRay(
        ray,
        (m: AbstractMesh) => {
          // Ignore the player and any non-pickable meshes.
          if (!m.isPickable) return false;
          if (m.parent === this.target || m.parent === this.pivot) return false;
          if (m.name.startsWith("player")) return false;
          return true;
        }
      );

      if (pick && pick.hit && typeof pick.distance === "number") {
        radiusAllowed = Math.max(this.minRadius, pick.distance - this.collisionMargin);
      }
    }

    // Spring radius
    this.cam.radius = lerp(this.cam.radius, radiusAllowed, t);
  }

  /**
   * Update camera with optional pitch input.
   * lookY: positive should pitch up (consistent with our inverted accumulator)
   */
  updateWithInput(dt: number, lookY: number) {
    // Match Player's yaw integration feel.
    this.pitch += lookY * dt * 2.2;
    this.update(dt);
  }
}
