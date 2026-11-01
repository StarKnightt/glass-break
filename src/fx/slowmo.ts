import { Vector3 } from 'three';
import type { World } from '../core/world';
import type { createPost } from './post';

type Post = ReturnType<typeof createPost>;

/** Real-time seconds / game-time scales of the break sequence. */
export const SLOWMO = {
  hitStopScale: 0.02,
  hitStop: 0.05,
  slowScale: 0.2,
  enter: 0.09,
  hold: 0.8, // end of the slow plateau, measured from the trigger
  exit: 0.42,
  extend: 0.55, // a later break pushes the plateau end to at least now + extend
  maxHold: 1.5,
  fovPunch: 1.6, // deg (at base fov), eased in, held while slow
  pushIn: 0.045, // m toward the bottle
};

const smoother = (x: number) => {
  x = Math.min(Math.max(x, 0), 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

export function createSlowmo(world: World, post: Post | null) {
  const { camera, cameraRig: rig } = world;
  let active = false;
  let t = 0;
  let enterAt = 0; // start of the ease into the plateau
  let enterFrom = 0; // scale the ease starts from
  let holdEnd = 0;
  let chainStart = 0;
  let dipUntil = -1;
  /** 0..1 how "slow" the world currently feels (drives camera, post and audio). */
  let amount = 0;
  let punch = 0; // fast attack kick on top of `amount`
  const push = new Vector3(); // camera-local unit push direction
  const tmp = new Vector3();

  const vig = post?.vignette;
  const baseDark = vig?.darkness ?? 0;
  const satU = post?.grade?.uniforms.get('uSat');
  const baseSat = satU ? (satU.value as number) : 1;
  const ca = post?.ca;
  const baseCa = ca ? ca.offset.clone() : null;

  function scaleAt(time: number) {
    if (time < enterAt) return SLOWMO.hitStopScale;
    if (time < enterAt + SLOWMO.enter) {
      return enterFrom + (SLOWMO.slowScale - enterFrom) * smoother((time - enterAt) / SLOWMO.enter);
    }
    if (time < holdEnd) return SLOWMO.slowScale;
    const k = (time - holdEnd) / SLOWMO.exit;
    if (k >= 1) return 1;
    // lingers slow, then accelerates back (ease-in-out, biased toward the end)
    const e = smoother(k);
    return SLOWMO.slowScale + (1 - SLOWMO.slowScale) * e * e * (3 - 2 * e) * 0.5 + (1 - SLOWMO.slowScale) * e * 0.5;
  }

  function trigger(target?: Vector3) {
    if (target) {
      tmp.copy(target);
      camera.worldToLocal(tmp);
      if (tmp.lengthSq() > 1e-6) push.copy(tmp).normalize();
    } else push.set(0, 0, -1);
    punch = 1;
    if (!active) {
      active = true;
      t = 0;
      chainStart = 0;
      enterAt = SLOWMO.hitStop;
      enterFrom = SLOWMO.hitStopScale;
      holdEnd = SLOWMO.hold;
      return;
    }
    if (t < holdEnd) {
      holdEnd = Math.min(Math.max(holdEnd, t + SLOWMO.extend), chainStart + SLOWMO.maxHold);
      dipUntil = t + 0.025; // tiny secondary hit-stop
    } else {
      // already easing out: glide back down from where we are, no hard hit-stop
      enterFrom = world.time.scale;
      enterAt = t;
      chainStart = t;
      holdEnd = t + SLOWMO.extend;
      dipUntil = t + 0.02;
    }
  }

  function reset() {
    active = false;
    amount = 0;
    punch = 0;
    world.time.scale = 1;
    apply();
  }

  function apply() {
    const a = smoother(amount);
    if (vig) vig.darkness = baseDark + 0.16 * a;
    if (satU) satU.value = baseSat * (1 - 0.14 * a);
    if (ca && baseCa) ca.offset.copy(baseCa).multiplyScalar(1 + 1.6 * a);
  }

  // Registered after the shooting system: its spring rewrites camera.fov / kickPos every frame,
  // we add our offsets on top.
  world.onRealUpdate((dt) => {
    if (active) {
      t += dt;
      let s = scaleAt(t);
      if (t < dipUntil) s = Math.min(s, 0.05);
      if (s >= 1 && t > holdEnd) {
        active = false;
        s = 1;
      }
      world.time.scale = s;
    }
    const target = active ? Math.min(1, (1 - world.time.scale) / (1 - SLOWMO.slowScale)) : 0;
    // asymmetric follow: quick in, smooth out
    amount += (target - amount) * (1 - Math.exp(-dt * (target > amount ? 18 : 5)));
    punch *= Math.exp(-dt * 9);
    const p = smoother(amount) * 0.8 + punch * 0.35;
    if (p > 1e-4) {
      camera.fov -= SLOWMO.fovPunch * p * (camera.fov / rig.baseFov);
      camera.updateProjectionMatrix();
      rig.kickPos.addScaledVector(push, SLOWMO.pushIn * p);
    }
    apply();
  });

  return {
    trigger,
    reset,
    get active() {
      return active;
    },
    /** 0..1 smoothed slowness for audio filters. */
    get amount() {
      return amount;
    },
  };
}

export type Slowmo = ReturnType<typeof createSlowmo>;
