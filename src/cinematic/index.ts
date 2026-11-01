import { CatmullRomCurve3, Color, Matrix4, Quaternion, Vector3 } from 'three';
import type { World } from '../core/world';
import type { createPost } from '../fx/post';
import type { Bottle, BottleSystem } from '../bottles';
import type { FractureSystem } from '../fracture';
import type { Liquid } from '../liquid';
import type { Slowmo } from '../fx/slowmo';
import type { Shooting } from '../shooting';
import type { GameAudio } from '../audio';
import { createStreak } from '../fx/streak';
import { createFlare } from './flare';
import { createBarrel, createBullet, createMuzzleFx } from './props';

type Post = ReturnType<typeof createPost>;

/** Cinematic timeline (seconds of real / video time unless noted). */
export const CINE = {
  cut: 2.4, // drone -> shooter cam
  shotAt: 2.62,
  bulletSpeed: 190, // m/s (game time)
  bulletScale: 0.022, // time scale while the bullet flies
  shatterScale: 0.075, // super slow-mo plateau after the hit
  toShatter: 0.7, // ramp bulletScale -> shatterScale
  orbitDist: 1.2, // m from the hit point where the camera peels off the bullet
  orbitBlend: 0.3,
  hold: 2.4, // after impact, before ramping back
  rampBack: 0.9,
  settle: 2.1, // ease to the composed view
  tail: 0.35, // hold on the composed view
  trail: 0.3, // trail length (s of video)
};

export interface CineEvents {
  shot: number;
  impact: number;
  end: number;
  type: string;
  fill: number;
  pan: number;
  shards: { t: number; speed: number; size: number; pan: number; scale: number }[];
  drips: { t: number; pan: number }[];
}

export interface CineDeps {
  world: World;
  post: Post;
  bottles: BottleSystem;
  fracture: FractureSystem;
  liquid: Liquid;
  slowmo: Slowmo;
  shooting: Shooting;
  audio: GameAudio;
  hud: HTMLElement;
}

const smoother = (x: number) => {
  x = Math.min(Math.max(x, 0), 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const UP = new Vector3(0, 1, 0);
const EYE = new Vector3(-1.35, 1.6, 6.6);

interface Pose {
  p: Vector3;
  q: Quaternion;
  fov: number;
}
const pose = (): Pose => ({ p: new Vector3(), q: new Quaternion(), fov: 30 });
const m4 = new Matrix4();
const qRoll = new Quaternion();
const fwdV = new Vector3();
function aim(o: Pose, pos: Vector3, look: Vector3, fov: number, roll = 0) {
  o.p.copy(pos);
  m4.lookAt(pos, look, UP);
  o.q.setFromRotationMatrix(m4);
  if (roll) o.q.multiply(qRoll.setFromAxisAngle(fwdV.set(0, 0, 1), roll));
  o.fov = fov;
  return o;
}
function mix(o: Pose, a: Pose, b: Pose, w: number) {
  o.p.lerpVectors(a.p, b.p, w);
  o.q.slerpQuaternions(a.q, b.q, w);
  o.fov = a.fov + (b.fov - a.fov) * w;
  return o;
}

export function createCinematic(d: CineDeps) {
  const { world, post, bottles, fracture, liquid, slowmo, shooting, audio, hud } = d;
  const { scene, camera, renderer } = world;

  const drone = new CatmullRomCurve3(
    [new Vector3(-12.5, 8.2, 25), new Vector3(-8.5, 6.0, 19.5), new Vector3(-5.2, 3.9, 14.5), new Vector3(-2.9, 2.45, 10.4), new Vector3(-1.75, 1.85, 8.3)],
    false,
    'centripetal',
  );
  const droneLookA = new Vector3(0.6, 0.9, -1.5);
  const droneLookB = new Vector3(0.0, 1.3, 0);

  const bullet = createBullet();
  const barrel = createBarrel();
  const muzzle = createMuzzleFx();
  const trail = createStreak(new Color(1.0, 0.86, 0.66).multiplyScalar(2.2), 0.0032, 1.6);
  trail.uniforms.uTaper.value = 0.2;
  trail.uniforms.uHead.value = 1.6;
  const flashStreak = createStreak(new Color(5, 3, 1.3), 0.012, 1);
  flashStreak.uniforms.uHead.value = 0.6;
  scene.add(bullet.mesh, bullet.glint, barrel, muzzle.flash, ...muzzle.smoke, trail.mesh, flashStreak.mesh);
  const flare = createFlare(scene, camera, world.sunDir, () => {
    const f = scene.getObjectByName('fence');
    return f ? [f] : [];
  });

  let active = false;
  let done = false;
  let t = 0;
  let scale = 1;
  let target: Bottle | null = null;
  const H = new Vector3(); // hit point
  const N = new Vector3(); // surface normal at the hit
  const M = new Vector3(); // muzzle
  const dA = new Vector3(); // eye aim
  const dB = new Vector3(); // bullet dir
  const rA = new Vector3();
  const uA = new Vector3();
  const B = new Vector3(); // bullet position
  const hist: { t: number; p: Vector3 }[] = [];
  let shotT = -1;
  let impactT = -1;
  let orbitT = -1;
  let retT = -1;
  let endT = 1e9;
  let gb = 0; // bullet game time
  let flightDist = 0;
  let bulletOn = false;
  let spin = 0;
  let az0 = 0;
  let shotAge = 0; // game seconds since the shot
  const cur = pose();
  const pA = pose();
  const pB = pose();
  const pC = pose();
  const chaseFrozen = pose();
  const orbitStart = pose();
  const tmp = new Vector3();
  const tmp2 = new Vector3();
  let baseBloom = post.bloom.intensity;
  let events: CineEvents = { shot: 0, impact: 0, end: 0, type: '', fill: 0, pan: 0, shards: [], drips: [] };

  const panOf = (p: Vector3) => {
    camera.updateMatrixWorld();
    tmp.copy(p).applyMatrix4(camera.matrixWorldInverse);
    return Math.max(-1, Math.min(1, tmp.x / Math.max(0.3, Math.hypot(tmp.x, tmp.z)))) * 0.8;
  };
  fracture.onShardImpact((p, speed, size) => {
    if (active && events.shards.length < 400) events.shards.push({ t, speed, size, pan: panOf(p), scale });
  });
  liquid.onLand((p) => {
    if (active && events.drips.length < 300) events.drips.push({ t, pan: panOf(p) });
  });

  // the game's own slow-mo punch-in and firing are disabled while the camera is scripted
  const trigger = slowmo.trigger;
  slowmo.trigger = (...a: Parameters<Slowmo['trigger']>) => {
    if (!active) trigger(...a);
  };
  const fire = shooting.fire;
  shooting.fire = () => (active ? false : fire());

  function pickBottle() {
    const alive = bottles.bottles.filter((b) => b.alive);
    const mid = alive.reduce((s, b) => s + b.group.position.x, 0) / Math.max(1, alive.length);
    const by = (list: Bottle[]) => list.slice().sort((a, b) => Math.abs(a.group.position.x - mid) - Math.abs(b.group.position.x - mid))[0];
    return by(alive.filter((b) => b.fill > 0.02)) ?? by(alive) ?? null;
  }

  function play() {
    if (active) stop();
    bottles.resetAll();
    target = pickBottle();
    if (!target) return;
    active = true;
    done = false;
    t = 0;
    scale = 1;
    shotT = impactT = orbitT = retT = -1;
    endT = 1e9;
    gb = 0;
    shotAge = 1e9;
    bulletOn = false;
    hist.length = 0;
    events = { shot: 0, impact: 0, end: 0, type: target.type, fill: target.fill, pan: 0, shards: [], drips: [] };

    target.group.updateMatrixWorld(true);
    const base = target.group.position;
    // aim at the bottle's belly, on the side facing the shooter
    H.set(base.x, base.y + target.height * 0.42, base.z);
    tmp.copy(EYE).sub(H).setY(0).normalize();
    N.copy(tmp);
    H.addScaledVector(tmp, target.radius * 0.98);
    dA.copy(H).sub(EYE).normalize();
    rA.crossVectors(dA, UP).normalize();
    uA.crossVectors(rA, dA).normalize();
    M.copy(EYE).addScaledVector(dA, 0.62).addScaledVector(rA, 0.055).addScaledVector(uA, -0.095);
    dB.copy(H).sub(M).normalize();
    flightDist = M.distanceTo(H);
    az0 = Math.atan2(-dB.x, -dB.z);

    barrel.position.copy(M);
    barrel.quaternion.setFromUnitVectors(UP, dB);
    barrel.visible = true;
    bullet.mesh.quaternion.setFromUnitVectors(UP, dB);
    baseBloom = post.bloom.intensity;
    post.bloom.intensity = baseBloom * 1.35;
    hud.style.visibility = 'hidden';
    world.time.scale = 1;
  }

  function stop() {
    if (!active) return;
    active = false;
    done = true;
    events.end = t;
    for (const o of [bullet.mesh, bullet.glint, barrel, muzzle.flash, ...muzzle.smoke, trail.mesh, flashStreak.mesh]) o.visible = false;
    flare.hide();
    post.bloom.intensity = baseBloom;
    hud.style.visibility = '';
    bottles.resetAll();
    world.time.scale = 1;
  }

  function scaleAt() {
    if (shotT < 0) return 1;
    if (impactT < 0) return CINE.bulletScale;
    if (retT < 0 || t < retT) return CINE.bulletScale + (CINE.shatterScale - CINE.bulletScale) * smoother((t - impactT) / CINE.toShatter);
    return CINE.shatterScale + (1 - CINE.shatterScale) * smoother((t - retT) / CINE.rampBack);
  }

  /** Advance the timeline; sets the game time scale for this frame. Call before the game updates. */
  function preStep(dtReal: number) {
    if (!active) return;
    t += dtReal;
    if (shotT < 0 && t >= CINE.shotAt) {
      shotT = t;
      events.shot = t;
      shotAge = 0;
      bulletOn = true;
      gb = 0;
      audio.gunshot();
    }
    scale = scaleAt();
    world.time.scale = scale;
    const gdt = dtReal * scale;
    if (shotT >= 0) shotAge += gdt;
    if (bulletOn) {
      gb += gdt;
      const s = CINE.bulletSpeed * gb;
      if (impactT < 0) {
        B.copy(M).addScaledVector(dB, Math.min(s, flightDist));
        if (orbitT < 0 && flightDist - s < CINE.orbitDist) orbitT = t;
        if (s >= flightDist && target) {
          impactT = t;
          retT = t + CINE.hold;
          endT = retT + CINE.settle + CINE.tail;
          events.impact = t;
          events.pan = panOf(H);
          gb = 0;
          fracture.shatter(target, H.clone(), N.clone(), dB.clone());
        }
      } else {
        // through the bottle: slowed, dropping a little
        const s2 = CINE.bulletSpeed * 0.55 * gb;
        B.copy(H).addScaledVector(dB, s2).addScaledVector(UP, -0.4 * s2 * s2);
        if (s2 > 0.9) bulletOn = false;
      }
      spin += gdt * 2 * Math.PI * 1800; // rifling spin (rev/s)
    }
    if (t >= endT) {
      events.end = t;
      stop();
    }
  }

  function dronePose(o: Pose) {
    const x = Math.min(1, t / CINE.cut);
    const u = 0.25 * x + 0.75 * (1 - Math.pow(1 - x, 2.2)) * 0.6 + 0.75 * smoother(x) * 0.4;
    drone.getPointAt(Math.min(1, u), tmp);
    tmp2.lerpVectors(droneLookA, droneLookB, smoother(x));
    const bank = 0.045 * Math.sin(Math.PI * x) - 0.01 * x;
    return aim(o, tmp, tmp2, 40 - 6 * smoother(x), bank);
  }

  function shooterPose(o: Pose) {
    const k = Math.min(1, (t - CINE.cut) / 0.6);
    tmp.copy(EYE).addScaledVector(rA, 0.11).addScaledVector(uA, 0.012).addScaledVector(dA, 0.06 * smoother(k));
    tmp2.copy(H).addScaledVector(uA, -0.08);
    return aim(o, tmp, tmp2, 36, 0.004);
  }

  function chasePose(o: Pose) {
    const sh = 0.0025;
    const a = t * 13.0;
    // rear three-quarter so the bullet reads in profile, not as a disc
    tmp.copy(B).addScaledVector(dB, -0.085).addScaledVector(uA, 0.026).addScaledVector(rA, 0.05);
    tmp2.copy(B).addScaledVector(dB, 0.4).addScaledVector(rA, 0.012).addScaledVector(uA, Math.sin(a) * sh + Math.sin(a * 1.7) * sh * 0.5).addScaledVector(rA, Math.sin(a * 1.3 + 1) * sh);
    return aim(o, tmp, tmp2, 44, 0.02 * Math.sin(t * 2.1));
  }

  function orbitPose(o: Pose) {
    const span = (retT > 0 ? retT : impactT > 0 ? impactT + CINE.hold : t + 3) + CINE.settle - orbitT;
    const k = smoother((t - orbitT) / span);
    const az = az0 + 0.18 + 0.5 * k;
    const R = 0.66 - 0.06 * k;
    tmp.set(H.x + Math.sin(az) * R, H.y + 0.06 - 0.02 * k, H.z + Math.cos(az) * R);
    tmp2.copy(H).addScaledVector(UP, -0.015);
    return aim(o, tmp, tmp2, 38 - 3 * k, -0.015 * k);
  }

  function composedPose(o: Pose) {
    return aim(o, tmp.set(0.5, 1.44, 2.9), tmp2.set(0.05, 1.25, 0), 36);
  }

  function cameraPose() {
    if (t < CINE.cut) return dronePose(cur);
    if (shotT < 0 || t < shotT + 0.08) return shooterPose(cur);
    if (orbitT < 0) {
      shooterPose(pA);
      chasePose(pB);
      return mix(cur, pA, pB, smoother((t - shotT - 0.08) / 0.45));
    }
    // peel off the bullet into a slow orbit around the hit
    const w = smoother((t - orbitT) / CINE.orbitBlend);
    if (impactT < 0) chasePose(chaseFrozen);
    if (w < 1) {
      if (t - shotT - 0.08 < 0.45) {
        shooterPose(pA);
        mix(orbitStart, pA, chaseFrozen, smoother((t - shotT - 0.08) / 0.45));
      } else orbitStart.p.copy(chaseFrozen.p), orbitStart.q.copy(chaseFrozen.q), (orbitStart.fov = chaseFrozen.fov);
    }
    orbitPose(pB);
    mix(pC, orbitStart, pB, w);
    if (retT < 0 || t < retT) return mix(cur, pC, pC, 0);
    composedPose(pA);
    return mix(cur, pC, pA, smoother((t - retT) / CINE.settle));
  }

  function updateProps(dtReal: number) {
    const H8 = renderer.domElement.height;
    // bullet + glint
    bullet.mesh.visible = bulletOn;
    if (bulletOn) {
      bullet.mesh.position.copy(B);
      bullet.mesh.quaternion.setFromUnitVectors(UP, dB).multiply(qRoll.setFromAxisAngle(UP, spin));
      bullet.glint.position.copy(B).addScaledVector(world.sunDir, 0.0025);
      bullet.glint.quaternion.copy(camera.quaternion);
      const flick = 0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(spin * 2), 6);
      const dist = camera.position.distanceTo(B);
      const sz = Math.max(0.006, dist * 0.012);
      bullet.glint.scale.set(sz, sz, 1);
      (bullet.glint.material as { opacity: number }).opacity = flick * Math.min(1, 0.006 / sz + 0.35);
      bullet.glint.visible = true;
    } else bullet.glint.visible = false;
    // trail: from where the bullet was CINE.trail seconds ago up to now
    if (shotT >= 0 && (bulletOn || hist.length)) {
      if (bulletOn) hist.push({ t, p: B.clone() });
      while (hist.length > 1 && hist[0].t < t - CINE.trail) hist.shift();
      if (!bulletOn && hist.length && hist[hist.length - 1].t < t - CINE.trail) hist.length = 0;
      if (hist.length > 1) {
        const head = hist[hist.length - 1].p;
        const tailP = hist[0].p;
        const age = Math.max(0, t - hist[hist.length - 1].t);
        trail.set(tailP, head, 0.75 * (1 - age / CINE.trail), camera.fov, H8);
      } else trail.mesh.visible = false;
    } else trail.mesh.visible = false;
    // muzzle flash (game time), smoke drifting slowly
    const fl = shotT >= 0 ? Math.exp(-shotAge / 0.0022) : 0;
    muzzle.flash.visible = fl > 0.01;
    if (muzzle.flash.visible) {
      muzzle.flash.position.copy(M).addScaledVector(dB, 0.015);
      muzzle.flash.quaternion.copy(camera.quaternion);
      const s = 0.05 + 0.05 * (1 - fl);
      muzzle.flash.scale.set(s, s, 1);
      (muzzle.flash.material as { opacity: number }).opacity = fl;
      flashStreak.set(tmp.copy(M), tmp2.copy(M).addScaledVector(dB, 0.07 + 0.05 * (1 - fl)), fl * 0.9, camera.fov, H8);
    } else flashStreak.mesh.visible = false;
    muzzle.smoke.forEach((m, i) => {
      const age = shotT >= 0 ? shotAge : 0;
      const on = shotT >= 0 && age < 0.25 && t < (orbitT > 0 ? orbitT + 0.5 : 1e9);
      m.visible = on;
      if (!on) return;
      const g = age + 0.0015;
      m.position.copy(M).addScaledVector(dB, 0.02 + i * 0.012 + g * (0.9 + i * 0.4)).addScaledVector(UP, g * 0.15 * i);
      m.quaternion.copy(camera.quaternion);
      const s = 0.02 + i * 0.008 + g * (0.5 + 0.2 * i);
      m.scale.set(s, s, 1);
      (m.material as { opacity: number }).opacity = 0.22 * Math.min(1, age / 0.0008) * (1 - age / 0.25);
    });
    barrel.visible = active && (orbitT < 0 || t < orbitT + 0.2);
    flare.update(dtReal, true);
  }

  /** Overrides the camera for this frame; call after every game update, before rendering. */
  function postStep(dtReal: number) {
    if (!active) return;
    const p = cameraPose();
    camera.position.copy(p.p);
    camera.quaternion.copy(p.q);
    camera.fov = p.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    updateProps(dtReal);
  }

  return {
    play,
    stop,
    preStep,
    postStep,
    get active() {
      return active;
    },
    get done() {
      return done;
    },
    get time() {
      return t;
    },
    get scale() {
      return scale;
    },
    get events() {
      return events;
    },
  };
}

export type Cinematic = ReturnType<typeof createCinematic>;
