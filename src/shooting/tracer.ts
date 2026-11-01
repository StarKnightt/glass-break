import { Color, Vector3 } from 'three';
import type { World } from '../core/world';
import { createStreak } from '../fx/streak';

const TRAVEL = 0.04; // s (real): muzzle to target, arrives with the break
const FADE = 0.22; // s of game time, so slow-mo keeps it on screen longer
const MAX_LIFE = 1.4; // s (real) safety cap
const MUZZLE = new Vector3(0.035, -0.072, -0.34); // camera space, near the bottom center of view

/** Faint, warm bullet tracer: a short soft streak racing from the bottom of view to the hit point. */
export function createTracer(world: World) {
  const { camera, renderer } = world;
  const streak = createStreak(new Color(1.0, 0.8, 0.52).multiplyScalar(3.4), 0.0022, 1.5);
  streak.uniforms.uTaper.value = 0.25;
  streak.uniforms.uHead.value = 0.8;
  world.scene.add(streak.mesh);
  const from = new Vector3();
  const to = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  let age = 1e9; // real
  let fade = 1e9; // game
  let live = false;
  let dtGame = 0;

  world.onUpdate((dt) => (dtGame = dt));
  world.onRealUpdate((dt) => {
    if (!live) return;
    age += dt;
    if (age > TRAVEL) fade += dtGame;
    const k = fade / FADE;
    if (k >= 1 || age > MAX_LIFE) {
      live = false;
      streak.mesh.visible = false;
      return;
    }
    const h = Math.min(1, age / TRAVEL);
    // the path points away from the eye, so most of its screen length is in the first few percent:
    // keep the tail near the muzzle and let it recede toward the target as it fades
    const tail = Math.min(h, 0.07 * h * h + 0.6 * k * k);
    a.lerpVectors(from, to, tail);
    b.lerpVectors(from, to, h);
    const alpha = 0.8 * (1 - k) * (1 - k) * Math.min(1, age / 0.008);
    streak.set(a, b, alpha, camera.fov, renderer.domElement.height);
  });

  return {
    /** Start a tracer toward `end` (or along `dir` when the shot hit nothing). */
    fire(end: Vector3 | null, dir: Vector3) {
      camera.updateMatrixWorld();
      from.copy(MUZZLE).applyMatrix4(camera.matrixWorld);
      if (end) to.copy(end);
      else to.copy(camera.position).addScaledVector(dir, 120);
      age = 0;
      fade = 0;
      live = true;
    },
  };
}

export type Tracer = ReturnType<typeof createTracer>;
