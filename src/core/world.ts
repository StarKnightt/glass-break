import type { PerspectiveCamera, Scene, WebGLRenderer, DirectionalLight, Vector3 } from 'three';
import type { EffectComposer } from 'postprocessing';
import type { CameraRig } from '../scene/camera';

export type UpdateFn = (dt: number, time: number) => void;

/** Shared context handed to every game system. */
export interface World {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** Aim (yaw/pitch), recoil kick and handheld sway live here; the rig owns camera rotation. */
  cameraRig: CameraRig;
  composer: EffectComposer;
  sun: DirectionalLight;
  /** Normalized direction from the scene toward the sun. */
  sunDir: Vector3;
  /** World positions (bottom center) where bottles stand on the top rail. */
  bottleSlots: Vector3[];
  /** Height of the top-rail surface the bottles stand on. */
  railTopY: number;
  /** Game-time multiplier (hit-stop / slow-mo). Real-time systems ignore it. */
  time: { scale: number; game: number; real: number };
  /** Called with scaled dt (game time). */
  onUpdate(fn: UpdateFn): void;
  /** Called with unscaled dt (real time), e.g. camera sway, UI. */
  onRealUpdate(fn: UpdateFn): void;
}
