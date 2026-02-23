// src/game/Vehicle.ts
import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";

export type VehicleInput = {
  throttle: number; // -1..1 (S=-1, W=+1)
  steer: number; // -1..1 (A=-1, D=+1)
  boost: boolean;
  handbrake: boolean;
};

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export class Vehicle {
  public root: TransformNode;
  private vel = new Vector3(0, 0, 0);
  private yaw = 0;

  // Arcade tuning
  private maxSpeed = 34;
  private accel = 42;
  private brake = 62;
  private friction = 6.8;
  private steerRate = 2.25;
  private boostMul = 1.5;

  constructor(scene: Scene) {
    this.root = new TransformNode("vehicleRoot", scene);
    // Spawn near city center-ish
    this.root.position.set(10, 0, 6);

    const matBody = new StandardMaterial("carBodyMat", scene);
    matBody.diffuseColor = new Color3(0.18, 0.18, 0.2);
    matBody.emissiveColor = new Color3(0.02, 0.02, 0.02);

    const matTop = new StandardMaterial("carTopMat", scene);
    matTop.diffuseColor = new Color3(0.26, 0.26, 0.3);
    matTop.emissiveColor = new Color3(0.02, 0.02, 0.02);

    const matWheel = new StandardMaterial("carWheelMat", scene);
    matWheel.diffuseColor = new Color3(0.05, 0.05, 0.06);

    // Body
    const body = MeshBuilder.CreateBox(
      "carBody",
      { width: 2.2, height: 0.7, depth: 4.0 },
      scene
    );
    body.parent = this.root;
    body.position.y = 0.55;
    body.material = matBody;
    body.isPickable = true;

    // Top
    const top = MeshBuilder.CreateBox(
      "carTop",
      { width: 1.9, height: 0.55, depth: 1.8 },
      scene
    );
    top.parent = this.root;
    top.position.set(0, 1.05, -0.2);
    top.material = matTop;
    top.isPickable = false;

    // Wheels
    const wheelProto = MeshBuilder.CreateBox(
      "carWheelProto",
      { width: 0.45, height: 0.45, depth: 0.9 },
      scene
    );
    wheelProto.material = matWheel;
    wheelProto.isPickable = false;

    const offsets = [
      new Vector3(-1.05, 0.25, 1.45),
      new Vector3(1.05, 0.25, 1.45),
      new Vector3(-1.05, 0.25, -1.45),
      new Vector3(1.05, 0.25, -1.45),
    ];
    offsets.forEach((o, i) => {
      const w = wheelProto.clone(`carWheel_${i}`) as Mesh;
      w.parent = this.root;
      w.position.copyFrom(o);
    });
    wheelProto.dispose();
  }

  distanceTo(pos: Vector3) {
    const dx = pos.x - this.root.position.x;
    const dz = pos.z - this.root.position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  getExitPosition(): Vector3 {
    // Exit to right side
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    return this.root.position.add(right.scale(2.0));
  }

  update(dt: number, input: VehicleInput) {
    // Steering based on speed
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const speed01 = clamp(speed / 18, 0, 1);
    const steer = input.steer * (0.35 + 0.65 * speed01);
    this.yaw += steer * this.steerRate * dt;

    const forward = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const boost = input.boost ? this.boostMul : 1;

    const throttle = clamp(input.throttle, -1, 1);
    if (throttle > 0) {
      this.vel.addInPlace(forward.scale(this.accel * boost * throttle * dt));
    } else if (throttle < 0) {
      this.vel.addInPlace(forward.scale(this.brake * throttle * dt));
    }

    const friction = this.friction * (input.handbrake ? 2.2 : 1.0);
    this.vel.x *= Math.max(0, 1 - friction * dt);
    this.vel.z *= Math.max(0, 1 - friction * dt);

    const newSpeed = Math.hypot(this.vel.x, this.vel.z);
    const max = this.maxSpeed * boost;
    if (newSpeed > max) {
      const s = max / Math.max(1e-6, newSpeed);
      this.vel.x *= s;
      this.vel.z *= s;
    }

    this.root.position.x += this.vel.x * dt;
    this.root.position.z += this.vel.z * dt;
    this.root.rotation.y = this.yaw;
  }
}