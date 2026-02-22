import { App } from "./App";
import "../../style.css";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
new App(canvas).start();
