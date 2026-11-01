import { Vector3 } from 'three';
import type { World } from '../core/world';
import type { createPost } from './post';

type Post = ReturnType<typeof createPost>;

/** Real-time seconds / game-time scales of the break sequence. */
export const SLOWMO = {
  hitStopScale: 0.02,
  hitStop: 0.05,
  slowScale: 0.2,
  chainSlowScale: 0.35,
  enter: 0.09,
  hold: 0.7, // plateau length after the ease-in (first break of a chain)
  chainDecay: 0.6, // k-th break within `chainWindow` holds hold * chainDecay^k
  chainWindow: 3,
  skipHitStopUnder: 0.4,
  exit: 0.42,
  fovPunch: 2.4, // deg peak (at base fov), 60 ms attack
  fovHold: 0.8, // deg while slow
  zoomFov: 17, // cinematic punch-in target from the default view (deg)
  zoomedPunch: 0.85, // fov multiplier when the player is already scoped in
  aimFollow: 0.85, // fraction of the way the view turns toward the bottle
  zoomRate: 7, // two-pole follow rate (1/s): ~0.3 s smooth S-curve, no jump cut
};

const smoother = (x: number) => {
  x = Math.min(Math.max(x, 0), 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

export function createSlowmo(world: World, post: Post | null) {
  const { camera, cameraRig: rig } = world;
  let clock = 0; // real seconds
  let active = false;
  let enterAt = 0;
  let enterFrom = 1;
  let slow = SLOWMO.slowScale;
  let holdEnd = 0;
  let lastBreak = -1e9;
  let chain = 0;
  let amount = 0;
  let punchT = 1e9; // seconds since the last punch
  let punchGain = 0;
  let dipUntil = -1;
  // cinematic punch-in: two cascaded low-passes give a smooth S-curve in and out
  let z1 = 0;
  let z2 = 0;
  const off = { yaw: 0, pitch: 0 }; // smoothed aim offset toward the bottle
  const offT = { yaw: 0, pitch: 0 };
  /** The part of the offset currently baked into the camera rotation (via rig.kick). */
  const applied = { yaw: 0, pitch: 0 };
  const d = new Vector3();
  const zoomOf = () => (globalThis as { shooting?: { zoom?: number } }).shooting?.zoom ?? 0;

  const vig = post?.vignette;
  const baseDark = vig?.darkness ?? 0;
  const satU = post?.grade?.uniforms.get('uSat');
  const baseSat = satU ? (satU.value as number) : 1;
  const ca = post?.ca;
  const baseCa = ca ? ca.offset.clone() : null;

  function scaleAt(t: number) {
    if (t < enterAt) return SLOWMO.hitStopScale;
    if (t < enterAt + SLOWMO.enter) return enterFrom + (slow - enterFrom) * smoother((t - enterAt) / SLOWMO.enter);
    if (t < holdEnd) return slow;
    const k = (t - holdEnd) / SLOWMO.exit;
    if (k >= 1) return 1;
    return slow + (1 - slow) * smoother(k);
  }

  function trigger(target?: Vector3) {
    if (target) {
      d.copy(target).sub(camera.position).normalize();
      const yaw = Math.atan2(-d.x, -d.z) - rig.base.y;
      const pitch = Math.asin(d.y) - rig.base.x;
      offT.yaw = (yaw - rig.yaw) * SLOWMO.aimFollow;
      offT.pitch = (pitch - rig.pitch) * SLOWMO.aimFollow;
    }
    const since = clock - lastBreak;
    chain = since < SLOWMO.chainWindow ? chain + 1 : 0;
    lastBreak = clock;
    const hold = SLOWMO.hold * Math.pow(SLOWMO.chainDecay, chain);
    punchGain = Math.max(punchT < 0.3 ? punchGain * 0.5 : 0, Math.pow(SLOWMO.chainDecay, chain));
    punchT = 0;
    const cur = world.time.scale;
    if (!active || chain === 0) {
      enterAt = clock + SLOWMO.hitStop;
      enterFrom = SLOWMO.hitStopScale;
      slow = chain === 0 ? SLOWMO.slowScale : SLOWMO.chainSlowScale;
      holdEnd = enterAt + SLOWMO.enter + hold;
      active = true;
      return;
    }
    // chained break: never deepen hard, only top the plateau up a little
    if (since >= SLOWMO.skipHitStopUnder) dipUntil = clock + SLOWMO.hitStop * 0.8;
    const inHold = clock < holdEnd;
    if (!inHold) {
      slow = Math.min(SLOWMO.chainSlowScale, Math.max(slow, cur));
      enterFrom = cur;
      enterAt = since < SLOWMO.skipHitStopUnder ? clock : clock + SLOWMO.hitStop * 0.5;
    }
    holdEnd = Math.max(holdEnd, clock + SLOWMO.enter + hold);
  }

  function reset() {
    active = false;
    amount = 0;
    punchGain = 0;
    punchT = 1e9;
    chain = 0;
    lastBreak = -1e9;
    z1 = z2 = 0;
    off.yaw = off.pitch = offT.yaw = offT.pitch = 0;
    applied.yaw = applied.pitch = 0;
    dipUntil = -1;
    world.time.scale = 1;
    apply();
  }

  function apply() {
    const a = smoother(amount);
    if (vig) vig.darkness = baseDark + 0.08 * a;
    if (satU) satU.value = baseSat * (1 - 0.06 * a);
    if (ca && baseCa) ca.offset.copy(baseCa).multiplyScalar(1 + 0.3 * a);
  }

  // Registered after the shooting system: its spring rewrites camera.fov every frame; we add on top.
  world.onRealUpdate((dt) => {
    clock += dt;
    punchT += dt;
    if (active) {
      let s = scaleAt(clock);
      if (clock < dipUntil) s = Math.min(s, SLOWMO.hitStopScale * 2);
      if (s >= 1 && clock > holdEnd) active = false;
      world.time.scale = active ? s : 1;
    }
    const target = active ? Math.min(1, (1 - world.time.scale) / (1 - SLOWMO.slowScale)) : 0;
    amount += (target - amount) * (1 - Math.exp(-dt * (target > amount ? 18 : 5)));
    // punch: 60 ms smooth attack to the peak, then ~120 ms decay; the held part rides on `amount`
    const pk = punchT < 0.06 ? smoother(punchT / 0.06) : Math.exp(-(punchT - 0.06) / 0.12);
    // punch-in: in during hit-stop / early slow-mo, held, out with the slow-mo exit
    const zt = active && clock < holdEnd + SLOWMO.exit * 0.25 ? 1 : 0;
    const kz = 1 - Math.exp(-dt * SLOWMO.zoomRate * 1.6);
    z1 += (zt - z1) * kz;
    z2 += (z1 - z2) * kz;
    const ko = 1 - Math.exp(-dt * 10);
    off.yaw += (offT.yaw - off.yaw) * ko;
    off.pitch += (offT.pitch - off.pitch) * ko;
    applied.yaw = applied.pitch = 0;
    if (z2 > 1e-4) {
      applied.yaw = off.yaw * z2;
      applied.pitch = off.pitch * z2;
      const zf = SLOWMO.zoomFov / rig.baseFov;
      const f = zf + (SLOWMO.zoomedPunch - zf) * Math.min(1, zoomOf());
      camera.fov *= 1 - (1 - Math.min(1, f)) * z2;
      // aim offset rides on the additive kick (rewritten by the shooting spring each frame)
      rig.kick.yaw += applied.yaw;
      rig.kick.pitch += applied.pitch;
      camera.updateProjectionMatrix();
    }
    const deg = (SLOWMO.fovPunch - SLOWMO.fovHold) * pk * punchGain + SLOWMO.fovHold * smoother(Math.min(1, amount * 1.4));
    if (deg > 1e-3) {
      camera.fov -= deg * (camera.fov / rig.baseFov);
      camera.updateProjectionMatrix();
    }
    apply();
  });

  return {
    trigger,
    reset,
    get active() {
      return active;
    },
    /** Breaks so far in the current chain (0 = first). */
    /** Cinematic view turn (rad) currently in the camera; shots and the crosshair exclude it. */
    get aimOffset() {
      return applied;
    },
    get chain() {
      return chain;
    },
    /** 0..1 smoothed slowness for audio filters. */
    get amount() {
      return amount;
    },
  };
}

export type Slowmo = ReturnType<typeof createSlowmo>;
