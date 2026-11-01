import { MathUtils, Object3D, Raycaster, Vector2, Vector3, type Intersection } from 'three';
import type { World } from '../core/world';
import type { Bottle, BottleSystem } from '../bottles';
import { createImpacts } from './impacts';

export type HitFn = (bottle: Bottle, point: Vector3, normal: Vector3, dir: Vector3) => void;
export type MissFn = (point: Vector3 | null, normal: Vector3 | null, object: Object3D | null) => void;
export type FireFn = (origin: Vector3, dir: Vector3) => void;

const FIRE_INTERVAL = 0.25;
const YAW_RANGE = 0.42;
const PITCH_MIN = -0.22;
const PITCH_MAX = 0.18;
const SENS = 0.0021;
const ZOOM = 2;
const MAX_RANGE = 120;

/**
 * First-person shooting: pointer-lock mouse look (mouse-follow fallback), hold-RMB zoom,
 * center-screen hitscan against bottles then fence/ground, recoil via the camera rig.
 */
export function createShooting(world: World, bottles: BottleSystem) {
  const { camera, cameraRig: rig, scene, renderer } = world;
  const canvas = renderer.domElement;
  const impacts = createImpacts(scene);
  const ray = new Raycaster();
  ray.far = MAX_RANGE;
  const center = new Vector2(0, 0);

  const hitFns: HitFn[] = [];
  const missFns: MissFn[] = [];
  const fireFns: FireFn[] = [];
  const zoomedFov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(rig.baseFov) / 2) / ZOOM));

  let locked = false;
  let fallback = false;
  let lastShot = -1e9;
  let zoomHeld = false;
  let zoomT = 0;
  // fallback mouse-follow aim target
  let targetYaw = 0;
  let targetPitch = 0;
  // recoil spring state
  const kv = { pitch: 0, yaw: 0, roll: 0 };

  const api = {
    /** Set false once the fracture system owns bottle destruction. */
    autoRemove: true,
    shots: 0,
    hits: 0,
    get active() {
      return locked || fallback;
    },
    get zoom() {
      return zoomT;
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
    /** Start / resume aiming. Called from the start overlay's click. */
    start() {
      if (locked || fallback) return;
      try {
        const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        r?.catch?.(() => (fallback = true));
      } catch {
        fallback = true;
      }
      // Some environments neither lock nor error; fall back if not locked shortly after.
      setTimeout(() => {
        if (!locked) fallback = true;
      }, 400);
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
      impacts.clearDecals();
    },
    fire() {
      const now = performance.now() / 1000;
      if (now - lastShot < FIRE_INTERVAL) return false;
      lastShot = now;
      api.shots++;

      camera.updateMatrixWorld();
      ray.setFromCamera(center, camera);
      const origin = ray.ray.origin.clone();
      const dir = ray.ray.direction.clone();
      for (const fn of fireFns) fn(origin, dir);

      // recoil: pitch up, slight random yaw/roll, spring settles it
      kv.pitch += 0.26 + Math.random() * 0.05;
      kv.yaw += (Math.random() - 0.5) * 0.09;
      kv.roll += (Math.random() - 0.5) * 0.12;

      const bHits = ray.intersectObjects(bottles.raycastTargets(), false);
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

  function worldNormal(h: Intersection, dir: Vector3) {
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : dir.clone().negate();
    if (n.dot(dir) > 0) n.negate();
    return n;
  }

  // --- input -------------------------------------------------------------------------------
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (locked) fallback = false;
  });
  document.addEventListener('pointerlockerror', () => (fallback = true));

  window.addEventListener('mousemove', (e) => {
    const fovK = camera.fov / rig.baseFov;
    if (locked) {
      rig.yaw = MathUtils.clamp(rig.yaw - e.movementX * SENS * fovK, -YAW_RANGE, YAW_RANGE);
      rig.pitch = MathUtils.clamp(rig.pitch - e.movementY * SENS * fovK, PITCH_MIN, PITCH_MAX);
    } else if (fallback) {
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

  world.onRealUpdate((dt) => {
    if (fallback && !locked) {
      const k = 1 - Math.exp(-dt * 6);
      rig.yaw += (targetYaw - rig.yaw) * k;
      rig.pitch += (targetPitch - rig.pitch) * k;
    }

    // zoom (smooth, ease toward target)
    const zt = zoomHeld && api.active ? 1 : 0;
    zoomT += (zt - zoomT) * (1 - Math.exp(-dt * 11));
    if (Math.abs(zt - zoomT) < 1e-4) zoomT = zt;
    const fov = MathUtils.lerp(rig.baseFov, zoomedFov, zoomT);
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    rig.swayAmount = 1 - zoomT * 0.35;

    // recoil: critically-ish damped spring per axis
    const K = 170;
    const C = 21;
    const h = Math.min(dt, 1 / 30);
    for (const ax of ['pitch', 'yaw', 'roll'] as const) {
      kv[ax] += (-K * rig.kick[ax] - C * kv[ax]) * h;
      rig.kick[ax] += kv[ax] * h;
    }

    impacts.update(world.time.scale * dt, canvas.height, MathUtils.degToRad(camera.fov));
  });

  return api;
}

export type Shooting = ReturnType<typeof createShooting>;
