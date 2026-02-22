import { Engine, Scene } from "@babylonjs/core";
import { createDefaultScene } from "./Quality";

export class EngineHost {
  public engine: Engine;
  public scene: Scene;
  public canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true);
    this.scene = createDefaultScene(this.engine);
  }

  bindResize(onResize?: () => void) {
    const handler = () => {
      this.engine.resize();
      onResize?.();
    };
    window.addEventListener("resize", handler);
    window.addEventListener("orientationchange", handler);

    // Run once on boot so CSS-sized canvas is reflected in the engine.
    handler();
  }

  run(tick: () => void) {
    this.engine.runRenderLoop(() => {
      tick();
      this.scene.render();
    });
  }

  getDeltaSeconds() {
    return Math.min(this.engine.getDeltaTime() / 1000, 1 / 15);
  }
}
