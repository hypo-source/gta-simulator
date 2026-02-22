import {
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  Color3,
} from "@babylonjs/core";

export type PlayerInput = {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  jump: boolean;
  sprint: boolean;
};

export class Player {
  public root: TransformNode;

  // Move speed felt slow with the city scale; bump to a more game-like baseline.
  private walkSpeed = 10;
  private sprintMul = 2.0;

  private yaw = 0;

  private verticalVelocity = 0;
  private gravity = -19.6; // tuned for game feel
  private jumpSpeed = 7.2;
  private grounded = true;

  // Simple blocky character (Lego / Minecraft-ish)
  private animT = 0;
  private torso!: TransformNode;
  private head!: TransformNode;
  private armL!: TransformNode;
  private armR!: TransformNode;
  private legL!: TransformNode;
  private legR!: TransformNode;

  constructor(scene: Scene) {
    this.root = new TransformNode("playerRoot", scene);

    // --- Materials
    const matSkin = new StandardMaterial("matSkin", scene);
    matSkin.diffuseColor = new Color3(0.98, 0.86, 0.72);

    const matShirt = new StandardMaterial("matShirt", scene);
    matShirt.diffuseColor = new Color3(0.2, 0.6, 0.95);
    matShirt.emissiveColor = new Color3(0.03, 0.06, 0.09);

    const matPants = new StandardMaterial("matPants", scene);
    matPants.diffuseColor = new Color3(0.18, 0.18, 0.22);

    // --- Torso (pivot at hips)
    this.torso = new TransformNode("torsoPivot", scene);
    this.torso.parent = this.root;
    this.torso.position.y = 1.1;

    const torsoMesh = MeshBuilder.CreateBox("torso", { width: 0.9, height: 1.1, depth: 0.45 }, scene);
    torsoMesh.parent = this.torso;
    torsoMesh.position.y = 0.55;
    torsoMesh.material = matShirt;
    torsoMesh.isPickable = false;

    // --- Head (pivot at neck)
    this.head = new TransformNode("headPivot", scene);
    this.head.parent = this.torso;
    this.head.position.y = 1.25;

    const headMesh = MeshBuilder.CreateBox("head", { size: 0.65 }, scene);
    headMesh.parent = this.head;
    headMesh.position.y = 0.325;
    headMesh.material = matSkin;
    headMesh.isPickable = false;

    // --- Arms (pivots at shoulders)
    this.armL = new TransformNode("armLPivot", scene);
    this.armL.parent = this.torso;
    this.armL.position = new Vector3(-0.55, 1.0, 0);

    const armLMesh = MeshBuilder.CreateBox("armL", { width: 0.28, height: 0.95, depth: 0.28 }, scene);
    armLMesh.parent = this.armL;
    armLMesh.position.y = -0.475;
    armLMesh.material = matShirt;
    armLMesh.isPickable = false;

    this.armR = new TransformNode("armRPivot", scene);
    this.armR.parent = this.torso;
    this.armR.position = new Vector3(0.55, 1.0, 0);

    const armRMesh = MeshBuilder.CreateBox("armR", { width: 0.28, height: 0.95, depth: 0.28 }, scene);
    armRMesh.parent = this.armR;
    armRMesh.position.y = -0.475;
    armRMesh.material = matShirt;
    armRMesh.isPickable = false;

    // --- Legs (pivots at hips)
    this.legL = new TransformNode("legLPivot", scene);
    this.legL.parent = this.root;
    this.legL.position = new Vector3(-0.22, 1.1, 0);

    const legLMesh = MeshBuilder.CreateBox("legL", { width: 0.32, height: 1.05, depth: 0.32 }, scene);
    legLMesh.parent = this.legL;
    legLMesh.position.y = -0.525;
    legLMesh.material = matPants;
    legLMesh.isPickable = false;

    this.legR = new TransformNode("legRPivot", scene);
    this.legR.parent = this.root;
    this.legR.position = new Vector3(0.22, 1.1, 0);

    const legRMesh = MeshBuilder.CreateBox("legR", { width: 0.32, height: 1.05, depth: 0.32 }, scene);
    legRMesh.parent = this.legR;
    legRMesh.position.y = -0.525;
    legRMesh.material = matPants;
    legRMesh.isPickable = false;

    // Start at origin.
    this.root.position = new Vector3(0, 0, 0);
  }

  update(dt: number, input: PlayerInput) {
    this.animT += dt;

    // Look / yaw
    this.yaw += input.lookX * dt * 2.2;

    // Movement in local space (Babylon left-handed):
    // +Z forward at yaw=0, +X right at yaw=0
    const forward = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const rawMove = right.scale(input.moveX).add(forward.scale(input.moveY));
    const speed = this.walkSpeed * (input.sprint ? this.sprintMul : 1);

    const moving = rawMove.lengthSquared() > 1e-4;
    if (moving) {
      rawMove.normalize();
      this.root.position.addInPlace(rawMove.scale(speed * dt));
    }

    // Jump
    if (input.jump && this.grounded) {
      this.verticalVelocity = this.jumpSpeed;
      this.grounded = false;
    }

    // Gravity
    this.verticalVelocity += this.gravity * dt;
    this.root.position.y += this.verticalVelocity * dt;

    // Ground collision (ground plane at y=0)
    if (this.root.position.y <= 0) {
      this.root.position.y = 0;
      this.verticalVelocity = 0;
      this.grounded = true;
    }

    // Face the moving / looking direction
    this.root.rotation = new Vector3(0, this.yaw, 0);

    // --- Simple walk/run animation (arms/legs swing)
    // Speed factor 0..1-ish
    const speedFactor = moving ? (input.sprint ? 1.0 : 0.65) : 0.0;
    const freq = input.sprint ? 11 : 8; // steps per second-ish
    const amp = input.sprint ? 0.95 : 0.65; // radians

    const swing = Math.sin(this.animT * freq) * amp * speedFactor;

    // Arms opposite to legs (classic walk cycle)
    this.armL.rotation.x = swing;
    this.armR.rotation.x = -swing;
    this.legL.rotation.x = -swing;
    this.legR.rotation.x = swing;

    // Slight torso bob (only when moving & grounded)
    const bob = Math.abs(Math.sin(this.animT * freq)) * 0.07 * speedFactor;
    this.torso.position.y = 1.1 + bob;

    // When in air, damp the animation so it doesn't look weird
    if (!this.grounded) {
      this.armL.rotation.x *= 0.3;
      this.armR.rotation.x *= 0.3;
      this.legL.rotation.x *= 0.3;
      this.legR.rotation.x *= 0.3;
      this.torso.position.y = 1.1;
    }
  }
}
