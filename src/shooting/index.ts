import { Euler, MathUtils, Object3D, Raycaster, Vector2, Vector3, type Intersection } from 'three';
import type { World } from '../core/world';
import type { Bottle, BottleSystem } from '../bottles';
import { createImpacts } from './impacts';

export type HitFn = (bottle: Bottle, point: Vector3, normal: Vector3, dir: Vector3) => void;
export type MissFn = (point: Vector3 | null, normal: Vector3 | null, object: Object3D | null) => void;
export type FireFn = (origin: Vector3, dir: Vector3) => void;

const FIRE_INTERVAL = 0.35;
const YAW_RANGE = 0.42;
const PITCH_MIN = -0.22;
const PITCH_MAX = 0.18;
const SENS = 0.0021;
const ZOOM = 3;
const MAX_RANGE = 120;
const DEG = Math.PI / 180;
/** Recoil spring: stiff and underdamped (zeta ~0.45) so it overshoots once. */
const K = 600;
const C = 2 * 0.45 * Math.sqrt(K);
const JOLT_TIME = 0.015;
const SHAKE_TIME = 0.12;

const NO_OFFSET = { yaw: 0, pitch: 0 };

const LOCK_SUPPORTED = 'pointerLockElement' in document && 'requestPointerLock' in HTMLElement.prototype;

/**
 * First-person shooting: pointer-lock mouse look (mouse-follow only where pointer lock is
 * unsupported), hold-RMB zoom, center-screen hitscan against bottles then fence/ground,
 * recoil via the camera rig.
 */
export function createShooting(world: World, bottles: BottleSystem) {
  const { camera, cameraRig: rig, scene, renderer } = world;
  const canvas = renderer.domElement;
  const impacts = createImpacts(scene);
  const ray = new Raycaster();
  ray.far = MAX_RANGE;
  const center = new Vector2(0, 0);
  const aimEuler = new Euler(0, 0, 0, 'YXZ');
  const tmpP = new Vector3();

  const hitFns: HitFn[] = [];
  const missFns: MissFn[] = [];
  const fireFns: FireFn[] = [];
  const lockFns: ((locked: boolean, error: boolean) => void)[] = [];
  const zoomedFov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(rig.baseFov) / 2) / ZOOM));

  let locked = false;
  let fallback = !LOCK_SUPPORTED;
  let started = false;
  let lastShot = -1e9;
  let zoomHeld = false;
  let zoomT = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  // recoil springs: angles (rad), camera-local position (m), fov (deg)
  const ang = { pitch: 0, yaw: 0, roll: 0 };
  const angV = { pitch: 0, yaw: 0, roll: 0 };
  const posX = new Vector3();
  const posV = new Vector3();
  let fovP = 0;
  let fovV = 0;
  let jolt = 0; // remaining jolt time
  const joltRate = { pitch: 0, yaw: 0, roll: 0 };
  let trauma = 0;
  let shakeT = 0;

  const api = {
    /** Set false once the fracture system owns bottle destruction. */
    autoRemove: true,
    shots: 0,
    hits: 0,
    get active() {
      return locked || (fallback && started);
    },
    get fallback() {
      return fallback;
    },
    get zoom() {
      return zoomT;
    },
    /** Camera rotation that is presentation only (slow-mo punch-in turn), not player aim. */
    viewOffset: () => NO_OFFSET as { yaw: number; pitch: number },
    /** Player's real aim direction (world), excluding `viewOffset`. */
    aimDir(out: Vector3) {
      const o = api.viewOffset();
      const r = camera.rotation;
      aimEuler.set(r.x - o.pitch, r.y - o.yaw, r.z, 'YXZ');
      return out.set(0, 0, -1).applyEuler(aimEuler);
    },
    /** Where the real aim lands on screen (NDC); off-center only while the punch-in turns the view. */
    aimNdc(out: Vector2) {
      const o = api.viewOffset();
      if (o.yaw === 0 && o.pitch === 0) return out.set(0, 0);
      camera.updateMatrixWorld();
      api.aimDir(tmpP).multiplyScalar(10).add(camera.position).project(camera);
      return out.set(tmpP.x, tmpP.y);
    },
    onHit(fn: HitFn) {
      hitFns.push(fn);
    },
    onMiss(fn: MissFn) {
      missFns.push(fn);
    },
    onFire(fn: FireFn) {
      fireFns.push(fn);
    },
    /** (locked, error) whenever pointer lock is gained, lost or refused. */
    onLockChange(fn: (locked: boolean, error: boolean) => void) {
      lockFns.push(fn);
    },
    /** Start / resume aiming from the overlay's click. Refused locks are retried on the next click. */
    start() {
      started = true;
      if (fallback || locked) return;
      try {
        const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        r?.catch?.(() => lockFns.forEach((f) => f(false, true)));
      } catch {
        lockFns.forEach((f) => f(false, true));
      }
    },
    /** Dev/test hook: use mouse-follow aiming without pointer lock. */
    forceFallback() {
      fallback = true;
      started = true;
    },
    setZoom(on: boolean) {
      zoomHeld = on;
    },
    /** Point the center ray at a world point (used by tests / scripted aim). */
    aimAt(p: Vector3) {
      const d = p.clone().sub(camera.position).normalize();
      rig.yaw = targetYaw = Math.atan2(-d.x, -d.z) - rig.base.y;
      rig.pitch = targetPitch = Math.asin(d.y) - rig.base.x;
      rig.update(world.time.real);
      camera.updateMatrixWorld();
    },
    reset() {
      api.shots = 0;
      api.hits = 0;
      impacts.clear();
    },
    fire() {
      const now = performance.now() / 1000;
      if (now - lastShot < FIRE_INTERVAL) return false;
      lastShot = now;
      api.shots++;

      camera.updateMatrixWorld();
      ray.setFromCamera(center, camera);
      api.aimDir(ray.ray.direction);
      const origin = ray.ray.origin.clone();
      const dir = ray.ray.direction.clone();
      kick();
      for (const fn of fireFns) fn(origin, dir);

      const targets = bottles.raycastTargets();
      // caps sit above the glass hit proxy; a shot through the cap should still break the bottle
      for (const b of bottles.bottles) if (b.alive && b.meshes.cap) targets.push(b.meshes.cap);
      const bHits = ray.intersectObjects(targets, false);
      const envTargets: Object3D[] = [];
      for (const name of ['fence', 'ground']) {
        const o = scene.getObjectByName(name);
        if (o) envTargets.push(o);
      }
      const eHits = ray.intersectObjects(envTargets, true);
      const b = bHits[0];
      const e = eHits[0];
      if (b && (!e || b.distance <= e.distance)) {
        const bottle = bottles.bottleFromObject(b.object);
        if (bottle) {
          api.hits++;
          const n = worldNormal(b, dir);
          for (const fn of hitFns) fn(bottle, b.point.clone(), n, dir.clone());
          if (api.autoRemove) bottle.remove();
          return true;
        }
      }
      if (e) {
        const n = worldNormal(e, dir);
        if (e.object.name === 'ground' || n.y > 0.75) impacts.dust(e.point, n);
        else impacts.splinter(e.point, n, dir);
        for (const fn of missFns) fn(e.point.clone(), n, e.object);
      } else {
        for (const fn of missFns) fn(null, null, null);
      }
      return true;
    },
    impacts,
  };

  function kick() {
    const z = 1 + zoomT * 0.6;
    const p = (0.8 + Math.random() * 0.4) * DEG * z;
    jolt = JOLT_TIME;
    joltRate.pitch = p / JOLT_TIME;
    joltRate.yaw = ((Math.random() - 0.5) * 0.35 * DEG * z) / JOLT_TIME;
    joltRate.roll = ((Math.random() - 0.5) * 0.6 * DEG) / JOLT_TIME;
    angV.pitch = angV.yaw = angV.roll = 0;
    posV.set(0, 0.004, 0.01).multiplyScalar(1 / JOLT_TIME);
    fovV = (-1.2 * (camera.fov / rig.baseFov)) / JOLT_TIME;
    trauma = 1;
    shakeT = 0;
  }

  function worldNormal(h: Intersection, dir: Vector3) {
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : dir.clone().negate();
    if (n.dot(dir) > 0) n.negate();
    return n;
  }

  // --- input -------------------------------------------------------------------------------
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (!locked) zoomHeld = false;
    lockFns.forEach((f) => f(locked, false));
  });
  document.addEventListener('pointerlockerror', () => lockFns.forEach((f) => f(false, true)));

  window.addEventListener('mousemove', (e) => {
    const fovK = camera.fov / rig.baseFov;
    if (locked) {
      rig.yaw = MathUtils.clamp(rig.yaw - e.movementX * SENS * fovK, -YAW_RANGE, YAW_RANGE);
      rig.pitch = MathUtils.clamp(rig.pitch - e.movementY * SENS * fovK, PITCH_MIN, PITCH_MAX);
    } else if (fallback && started) {
      const nx = (e.clientX / innerWidth) * 2 - 1;
      const ny = (e.clientY / innerHeight) * 2 - 1;
      targetYaw = -nx * YAW_RANGE * 0.8;
      targetPitch = MathUtils.clamp(-ny * 0.2, PITCH_MIN, PITCH_MAX);
    }
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!api.active) return;
    if (e.button === 0) api.fire();
    else if (e.button === 2) zoomHeld = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) zoomHeld = false;
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', () => (zoomHeld = false));

  const shakeNoise = (t: number, s: number) => Math.sin(t * 91 + s) * 0.6 + Math.sin(t * 157 + s * 2.3) * 0.4;

  world.onRealUpdate((dt) => {
    if (fallback && started && !locked) {
      const k = 1 - Math.exp(-dt * 6);
      rig.yaw += (targetYaw - rig.yaw) * k;
      rig.pitch += (targetPitch - rig.pitch) * k;
    }

    const zt = zoomHeld && api.active ? 1 : 0;
    zoomT += (zt - zoomT) * (1 - Math.exp(-dt * 10));
    if (Math.abs(zt - zoomT) < 1e-4) zoomT = zt;
    // zoomed: more sway (breathing / holding a magnified view steady)
    rig.swayAmount = 1 + zoomT * 0.6;

    // recoil: a fast jolt phase drives the offsets, then underdamped springs bring them home
    const steps = Math.max(1, Math.ceil(Math.min(dt, 1 / 20) / (1 / 480)));
    const h = Math.min(dt, 1 / 20) / steps;
    for (let s = 0; s < steps; s++) {
      if (jolt > 0) {
        const jh = Math.min(h, jolt);
        jolt -= jh;
        ang.pitch += joltRate.pitch * jh;
        ang.yaw += joltRate.yaw * jh;
        ang.roll += joltRate.roll * jh;
        posX.addScaledVector(posV, jh);
        fovP += fovV * jh;
        if (jolt <= 0) {
          posV.set(0, 0, 0);
          fovV = 0;
        }
        continue;
      }
      for (const ax of ['pitch', 'yaw', 'roll'] as const) {
        angV[ax] += (-K * ang[ax] - C * angV[ax]) * h;
        ang[ax] += angV[ax] * h;
      }
      posV.addScaledVector(posX, -K * h).addScaledVector(posV, -C * h);
      posX.addScaledVector(posV, h);
      fovV += (-K * 0.5 * fovP - C * 0.7 * fovV) * h;
      fovP += fovV * h;
    }
    shakeT += dt;
    trauma = Math.max(0, trauma - dt / SHAKE_TIME);
    const sh = trauma * trauma * 0.12 * DEG;
    rig.kick.pitch = ang.pitch + sh * shakeNoise(shakeT, 0.3);
    rig.kick.yaw = ang.yaw + sh * shakeNoise(shakeT, 1.7);
    rig.kick.roll = ang.roll + sh * 1.5 * shakeNoise(shakeT, 4.1);
    rig.kickPos.copy(posX);

    const fov = MathUtils.lerp(rig.baseFov, zoomedFov, zoomT) + fovP;
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    impacts.update(world.time.scale * dt, canvas.height, MathUtils.degToRad(camera.fov));
  });

  return api;
}

export type Shooting = ReturnType<typeof createShooting>;
