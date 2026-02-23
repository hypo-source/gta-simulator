import { Scene, Vector3 } from "@babylonjs/core";
import { Vehicle } from "./Vehicle";

export class PoliceManager {
  private scene: Scene;
  private policeCar: Vehicle | null = null;

  private wantedLevel = 0;
  private npcHitCount = 0;
  private loseTimer = 0;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  public notifyNpcHit() {
    this.npcHitCount++;
    console.log("HIT COUNT:", this.npcHitCount);

    if (this.npcHitCount >= 3 && this.wantedLevel === 0) {
      console.log("WANTED TRIGGERED");
      this.wantedLevel = 1;
      this.spawnPolice();
    }
  }

  private spawnPolice() {
    this.policeCar = new Vehicle(this.scene);
    this.policeCar.root.position = new Vector3(0, 0, -25);
  }

  public update(dt: number, targetPos: Vector3) {
    if (!this.policeCar || this.wantedLevel === 0) return;

    const policePos = this.policeCar.root.position;
    const dir = targetPos.subtract(policePos);
    const distance = dir.length();

    dir.normalize();

    this.policeCar.update(dt, {
      throttle: 1,
      steer: dir.x * 0.6,
      boost: false,
      handbrake: false,
    });

    if (distance > 40) {
      this.loseTimer += dt;
      if (this.loseTimer > 12) {
        this.clearWanted();
      }
    } else {
      this.loseTimer = 0;
    }
  }

  private clearWanted() {
    this.wantedLevel = 0;
    this.npcHitCount = 0;
    this.loseTimer = 0;

    if (this.policeCar) {
      this.policeCar.root.dispose();
      this.policeCar = null;
    }
  }

  public getWantedLevel() {
    return this.wantedLevel;
  }
}