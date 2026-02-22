import {
  Color3,
  DirectionalLight,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  Vector3,
} from "@babylonjs/core";

export function createDefaultScene(engine: Engine) {
  const scene = new Scene(engine);

  new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  new DirectionalLight("sun", new Vector3(-0.3, -1, -0.3), scene);

  MeshBuilder.CreateGround("ground", { width: 200, height: 200 }, scene);

  engine.setHardwareScalingLevel(1.0);
  scene.clearColor = new Color3(0.75, 0.85, 0.95).toColor4(1);

  return scene;
}
