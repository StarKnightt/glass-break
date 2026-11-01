import {
  AdditiveBlending,
  CircleGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  NearestFilter,
  Quaternion,
  RGBAFormat,
  ShaderMaterial,
  Vector3,

  type MeshPhysicalMaterial,
  type MeshStandardMaterial,
  type Texture,
} from 'three';
import type { World } from '../core/world';
import type { Bottle, BottleSystem, BottleType } from '../bottles';
import type { FractureJob, FractureResult, LabelBand, ProfileTable } from './types';
import { META } from './types';
import {
  createCheapMaterial,
  createDepthMaterial,
  createGlitterMaterial,
  createTransmissiveMaterial,
  shardUniforms,
  type ShardUniforms,
} from './materials';

export type ShatterFn = (bottle: Bottle, point: Vector3, dir: Vector3) => void;
export type ShardImpactFn = (position: Vector3, speed: number, size: number) => void;

const MAXP = 256;
const BREAK_SLOTS = 12;
const TRANS_SLOTS = 8;
const GLITTER = 2600;
const CRACK_TIME = 0.012;
const MAX_AWAKE = 320;
const G = 9.81;

const LABELS: Record<BottleType, LabelBand[]> = {
  beer: [[0.034, 0.104, -1.35, 2.7], [0.168, 0.186, -0.95, 1.9]],
  soda: [[0.068, 0.106, -Math.PI, Math.PI * 2]],
  whiskey: [[0.035, 0.132, -0.72, 1.44]],
};
const ATTEN: Record<BottleType, number> = { beer: 0.02, soda: 0.08, whiskey: 0.035 };

// Static colliders (match src/scene/fence.ts): top rail box and posts.
const RAIL = { y0: 1.12, y1: 1.165, z0: -0.09, z1: 0.09, x0: -10.6, x1: 10.6 };
const POSTS = Array.from({ length: 11 }, (_, i) => -10.5 + i * 2.1);

interface Break {
  bottle: Bottle;
  state: 'pending' | 'crack' | 'burst';
  t: number;
  jobId: number;
  n: number;
  mesh: Mesh;
  uni: ShardUniforms;
  tex: DataTexture;
  data: Float32Array;
  geo: BufferGeometry | null;
  lines: LineSegments | null;
  crush: Mesh | null;
  nrmW: Vector3;
  // physics
  p: Float32Array; q: Float32Array; v: Float32Array; w: Float32Array;
  rad: Float32Array; invI: Float32Array; delay: Float32Array; surfY: Float32Array; still: Float32Array; awake: Uint8Array; samp: Float32Array;
  meta: Float32Array | null;
  awakeCount: number;
  hitW: Vector3; dirW: Vector3; hitL: Vector3;
  matW: Matrix4; quatW: Quaternion;
  cap: Mesh | null;
  neck: number;
  order: number;
}

export function createFracture(world: World, bottles: BottleSystem) {
  const { scene } = world;
  const env = scene.environment;
  const envRot = scene.environmentRotation;
  const sunColor = world.sun.color.clone().multiplyScalar(world.sun.intensity * 0.22);

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const tables: ProfileTable[] = [];
  const seen = new Set<string>();
  for (const b of bottles.bottles) {
    if (seen.has(b.type)) continue;
    seen.add(b.type);
    const pr = b.profile;
    const step = 0.0005;
    const n = Math.ceil(pr.height / step) + 2;
    const outer = new Float32Array(n), inner = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      outer[i] = pr.outerR(i * step);
      inner[i] = pr.innerR(i * step);
    }
    const R0 = pr.outerR(0.06);
    let neckY = pr.shoulderY;
    while (neckY < pr.height && pr.outerR(neckY) > R0 * 0.8) neckY += 0.001;
    tables.push({ type: b.type, height: pr.height, floorY: pr.floorY, neckY, R0, step, outer, inner, square: pr.square });
  }
  worker.postMessage({ kind: 'init', profiles: tables });

  const shatterFns: ShatterFn[] = [];
  const crackFns: ShatterFn[] = [];
  const impactFns: ShardImpactFn[] = [];

  // break slots
  const slots: Break[] = [];
  for (let s = 0; s < BREAK_SLOTS; s++) {
    const uni = shardUniforms(world.sunDir, sunColor);
    const data = new Float32Array(MAXP * 2 * 4);
    const tex = new DataTexture(data, MAXP * 2, 1, RGBAFormat, FloatType);
    tex.minFilter = tex.magFilter = NearestFilter;
    tex.needsUpdate = true;
    uni.uShardTex.value = tex;
    const mesh = new Mesh(new BufferGeometry(), createCheapMaterial(env, envRot, uni));
    mesh.customDepthMaterial = createDepthMaterial(uni);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.name = 'shards';
    scene.add(mesh);
    slots.push({
      bottle: null as unknown as Bottle, state: 'burst', t: 0, jobId: -1, n: 0, mesh, uni, tex, data, geo: null, lines: null, crush: null, nrmW: new Vector3(),
      p: new Float32Array(MAXP * 3), q: new Float32Array(MAXP * 4), v: new Float32Array(MAXP * 3), w: new Float32Array(MAXP * 3),
      rad: new Float32Array(MAXP), invI: new Float32Array(MAXP), delay: new Float32Array(MAXP), surfY: new Float32Array(MAXP), still: new Float32Array(MAXP), awake: new Uint8Array(MAXP),
      samp: new Float32Array(MAXP * 24), meta: null, awakeCount: 0,
      hitW: new Vector3(), dirW: new Vector3(), hitL: new Vector3(), matW: new Matrix4(), quatW: new Quaternion(),
      cap: null, neck: -1, order: -1,
    });
  }
  let orderCounter = 0;

  // transmissive pool for the biggest pieces
  const trans: { mesh: Mesh; uni: ShardUniforms; owner: Break | null; piece: number; order: number }[] = [];
  for (let i = 0; i < TRANS_SLOTS; i++) {
    const uni = shardUniforms(world.sunDir, sunColor);
    const mat = createTransmissiveMaterial(env, envRot, uni);
    const mesh = new Mesh(new BufferGeometry(), mat);
    mesh.customDepthMaterial = createDepthMaterial(uni);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    mesh.visible = false;
    mesh.name = 'shardTransmissive';
    scene.add(mesh);
    trans.push({ mesh, uni, owner: null, piece: -1, order: 0 });
  }

  // glitter
  const flakeGeo = new BufferGeometry();
  flakeGeo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0.15, 0, 0.35, 0.9, 0]), 3));
  flakeGeo.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  const glitter = new InstancedMesh(flakeGeo, createGlitterMaterial(world.sunDir, sunColor), GLITTER);
  glitter.instanceColor = new InstancedBufferAttribute(new Float32Array(GLITTER * 3), 3);
  glitter.frustumCulled = false;
  glitter.count = 0;
  glitter.name = 'glassGlitter';
  scene.add(glitter);
  const gP = new Float32Array(GLITTER * 3), gV = new Float32Array(GLITTER * 3), gQ = new Float32Array(GLITTER * 4), gW = new Float32Array(GLITTER * 3);
  const gD = new Float32Array(GLITTER);
  const gS = new Float32Array(GLITTER), gAwake = new Uint8Array(GLITTER);
  let gNext = 0, gAwakeN = 0;

  const crackMat = new ShaderMaterial({
    vertexShader: `attribute float d; varying float vD; void main(){ vD = d; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    uniforms: { uR: { value: 0 }, uF: { value: 1 } },
    fragmentShader: `uniform float uR, uF; varying float vD; void main(){ if (vD > uR || vD > 0.055) discard; float k = exp(-vD / 0.018) * uF; gl_FragColor = vec4(vec3(1.3, 1.4, 1.35) * k, 1.0); }`,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const crushGeo = new CircleGeometry(0.0075, 24);
  const crushMat = new ShaderMaterial({
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy / 0.0075; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vP; void main(){ float r = length(vP); float a = atan(vP.y, vP.x); float spokes = 0.6 + 0.4 * sin(a * 13.0 + sin(a * 5.0) * 2.0); float k = exp(-r * r * 9.0) * 1.3 + smoothstep(1.0, 0.0, r) * spokes * 0.25; gl_FragColor = vec4(vec3(1.0, 1.02, 1.0) * k, 1.0); }`,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });

  const pending = new Map<number, Break>();

  worker.onmessage = (e: MessageEvent<FractureResult>) => {
    const r = e.data;
    lastWorkerMs = r.ms ?? 0;
    if (r.key) patterns.set(r.key, r);
  };
  let lastWorkerMs = 0;

  function freeSlot(br: Break) {
    br.mesh.visible = false;
    br.geo?.dispose();
    br.geo = null;
    if (br.lines) {
      scene.remove(br.lines);
      br.lines.geometry.dispose();
      br.lines = null;
    }
    if (br.crush) {
      scene.remove(br.crush);
      br.crush = null;
    }
    if (br.cap) {
      scene.remove(br.cap);
      br.cap = null;
    }
    for (const t of trans) if (t.owner === br) { t.owner = null; t.mesh.visible = false; }
    br.awakeCount = 0;
    br.n = 0;
    br.jobId = -1;
    br.order = -1;
  }

  function takeSlot(): Break {
    let best = slots[0];
    for (const s of slots) {
      if (s.order < 0) return s;
      if (s.order < best.order) best = s;
    }
    if (best.state !== 'burst') best.bottle.remove();
    freeSlot(best);
    return best;
  }

  const tv = new Vector3();
  const HEIGHTS = [0.2, 0.34, 0.48, 0.62, 0.76];
  const patterns = new Map<string, FractureResult | null>();
  const heightOf = new Map<string, number>();
  for (const t of tables) heightOf.set(t.type, t.height);
  function requestPattern(type: string, k: number) {
    const key = `${type}:${k}`;
    patterns.set(key, null);
    const job: FractureJob = {
      id: -1, type, theta: 0, y: heightOf.get(type)! * HEIGHTS[k], dir: [0, 0, -1], fill: 0.5,
      seed: (Math.random() * 1e9) | 0, labels: [],
    };
    worker.postMessage({ kind: 'job', key, job });
  }
  for (const t of tables) HEIGHTS.forEach((_, k) => requestPattern(t.type, k));

  const qY = new Quaternion(), mY = new Matrix4();
  function shatter(bottle: Bottle, hitPoint: Vector3, hitNormal: Vector3, bulletDir: Vector3) {
    if (!bottle.alive) return;
    bottle.group.updateMatrixWorld(true);
    const hitL = bottle.group.worldToLocal(hitPoint.clone());
    const H = bottle.profile.height;
    let best = -1, bestD = 1e9;
    HEIGHTS.forEach((f, k) => {
      const d = Math.abs(f * H - hitL.y);
      if (patterns.get(`${bottle.type}:${k}`) && d < bestD) { bestD = d; best = k; }
    });
    for (const fn of crackFns) fn(bottle, hitPoint, bulletDir);
    if (best < 0) {
      bottle.remove();
      for (const fn of shatterFns) fn(bottle, hitPoint, bulletDir);
      return;
    }
    const key = `${bottle.type}:${best}`;
    const r = patterns.get(key)!;
    requestPattern(bottle.type, best);
    bottle.alive = false;
    const br = takeSlot();
    br.bottle = bottle;
    br.order = orderCounter++;
    const phi = Math.atan2(hitL.x, hitL.z);
    mY.makeRotationY(phi);
    qY.setFromAxisAngle(up, phi);
    br.matW.copy(bottle.group.matrixWorld).multiply(mY);
    bottle.group.getWorldQuaternion(br.quatW).multiply(qY);
    br.hitW.copy(hitPoint);
    br.dirW.copy(bulletDir).normalize();
    br.nrmW.copy(hitNormal).normalize();
    const py = HEIGHTS[best] * H;
    br.hitL.set(0, py, bottle.profile.outerR(py));
    br.uni.uRot.value = phi;
    setup(br, r);
    burst(br);
  }

  function setup(br: Break, r: FractureResult) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(r.pos, 3));
    geo.setAttribute('normal', new BufferAttribute(r.nrm, 3));
    geo.setAttribute('sid', new BufferAttribute(r.sid, 1));
    geo.setAttribute('edge', new BufferAttribute(r.edge, 1));
    geo.setAttribute('luv', new BufferAttribute(r.luv, 4));
    geo.setIndex(new BufferAttribute(r.index, 1));
    br.geo = geo;
    br.mesh.geometry = geo;
    br.meta = r.meta;
    br.n = Math.min(MAXP, r.pieces);
    const b = br.bottle;
    const u = br.uni;
    u.uTint.value.copy(b.tint);
    const labelMats = b.meshes.labels.map((l) => (l.material as MeshStandardMaterial).map as Texture | null);
    const bands = LABELS[b.type];
    u.uLabelA.value = labelMats[0] ?? null;
    u.uLabelB.value = labelMats[1] ?? null;
    u.uHasB.value = labelMats[1] && bands[1] ? 1 : 0;
    if (bands[0]) u.uLabA.value.set(bands[0][0], bands[0][1], bands[0][2], bands[0][3]);
    if (bands[1]) u.uLabB.value.set(bands[1][0], bands[1][1], bands[1][2], bands[1][3]);
    const cm = br.mesh.material as MeshStandardMaterial;
    cm.color.copy(b.tint).lerp(new Color(1, 1, 1), 0.3);

    // brief cracks around the impact (visible in slow-mo only)
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(r.crack.slice(), 3));
    lg.setAttribute('d', new BufferAttribute(r.crackD.slice(), 1));
    const lines = new LineSegments(lg, crackMat.clone());
    lines.matrixAutoUpdate = false;
    lines.matrix.copy(br.matW);
    lines.matrixWorld.copy(br.matW);
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    scene.add(lines);
    br.lines = lines;
    const crush = new Mesh(crushGeo, crushMat.clone());
    crush.position.copy(br.hitW).addScaledVector(br.nrmW, 0.0008);
    crush.lookAt(tv.copy(crush.position).add(br.nrmW));
    crush.renderOrder = 6;
    scene.add(crush);
    br.crush = crush;
    br.t = 0;
  }

  const up = new Vector3(0, 1, 0);
  const c = new Vector3(), radial = new Vector3(), vel = new Vector3(), rnd = new Vector3(), side = new Vector3();
  const qTmp = new Quaternion();
  function randUnit(o: Vector3) {
    const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    return o.set(s * Math.cos(a), z, s * Math.sin(a));
  }
  /** Random direction within a cone of half-angle `ang` around `axis`. */
  function cone(o: Vector3, axis: Vector3, ang: number) {
    randUnit(o);
    o.addScaledVector(axis, -o.dot(axis)).normalize().multiplyScalar(Math.tan(ang) * Math.sqrt(Math.random()));
    return o.add(axis).normalize();
  }

  function burst(br: Break) {
    const b = br.bottle;
    const meta = br.meta!;
    b.remove();
    br.state = 'burst';
    br.mesh.visible = true;
    const power = 1 + b.fill * 0.7;
    const qw = br.quatW;
    const dir = br.dirW;
    br.awakeCount = 0;
    br.neck = -1;
    side.crossVectors(dir, up).normalize();
    const areas: [number, number][] = [];
    for (let i = 0; i < br.n; i++) {
      const o = i * META;
      c.set(meta[o], meta[o + 1], meta[o + 2]);
      const rad = Math.max(0.0015, meta[o + 3]);
      const flags = meta[o + 5];
      const d = c.distanceTo(br.hitL);
      const near = Math.exp(-d / 0.035);
      radial.set(c.x, 0, c.z).normalize().applyQuaternion(qw);
      const dot = radial.dot(dir);
      const r1 = Math.random();
      let spin = 4 + 26 * (1 - Math.min(1, rad / 0.03)) * (0.4 + 0.6 * Math.random());
      if (flags & 1) {
        // neck: carried along the bullet path, tips over
        vel.copy(dir).multiplyScalar(0.4 + 0.6 * r1).addScaledVector(radial, 0.15).addScaledVector(up, 0.1 + 0.35 * Math.random());
        br.neck = i;
        rnd.copy(side).multiplyScalar((Math.random() < 0.5 ? -1 : 1) * (5 + 6 * Math.random())).addScaledVector(randUnit(c.clone()), 1.5);
      } else if (flags & 2) {
        vel.copy(dir).multiplyScalar(0.1 + 0.15 * r1);
        spin = 0.6;
        randUnit(rnd).multiplyScalar(spin);
      } else if (near < 0.2 && r1 < 0.4) {
        // far pieces lose their support and slump onto the rail
        vel.copy(radial).multiplyScalar(0.03 + 0.15 * Math.random()).addScaledVector(dir, 0.05);
      } else if (dot > 0.25) {
        // exit side jet
        cone(vel, dir, 0.6).multiplyScalar((0.8 + 3.5 * dot * (0.3 + near)) * power * (0.6 + 0.6 * r1));
        vel.addScaledVector(radial, 0.4);
      } else if (dot < -0.25 && near > 0.3 && r1 < 0.4) {
        // entry spall back toward the shooter, falling just in front of the fence
        cone(vel, tv.copy(dir).negate(), 0.8).multiplyScalar((0.4 + 1.3 * near) * (0.6 + 0.7 * Math.random()));
        vel.addScaledVector(radial, 0.2);
      } else if (dot < -0.25 && near > 0.3) {
        // driven through the bottle with the bullet
        cone(vel, dir, 0.55).multiplyScalar((1.2 + 2.5 * near) * power * (0.6 + 0.6 * Math.random()));
      } else if (r1 < 0.55) {
        // drops onto the rail
        vel.copy(radial).multiplyScalar(0.03 + 0.15 * Math.random()).addScaledVector(dir, 0.05);
      } else {
        vel.copy(radial).multiplyScalar((0.5 + 1.4 * near + 0.5 * Math.random()) * power).addScaledVector(dir, 0.5);
      }
      if (!(flags & 3)) vel.y += -0.1 + 0.5 * Math.random();
      if (!(flags & 1) && !(flags & 2)) randUnit(rnd).multiplyScalar(spin);
      c.set(meta[o], meta[o + 1], meta[o + 2]).applyMatrix4(br.matW);
      br.p[i * 3] = c.x; br.p[i * 3 + 1] = c.y; br.p[i * 3 + 2] = c.z;
      br.v[i * 3] = vel.x; br.v[i * 3 + 1] = vel.y; br.v[i * 3 + 2] = vel.z;
      br.q[i * 4] = qw.x; br.q[i * 4 + 1] = qw.y; br.q[i * 4 + 2] = qw.z; br.q[i * 4 + 3] = qw.w;
      br.w[i * 3] = rnd.x; br.w[i * 3 + 1] = rnd.y; br.w[i * 3 + 2] = rnd.z;
      br.rad[i] = rad;
      br.invI[i] = 1 / (0.3 * rad * rad);
      br.still[i] = 0;
      br.delay[i] = flags & 2 ? 0.03 : Math.max(0, d - 0.008) * 0.18;
      br.surfY[i] = -1;
      br.awake[i] = meta[o + 7] > 0 ? 1 : 0;
      br.awakeCount += br.awake[i];
      for (let k = 0; k < 24; k++) br.samp[i * 24 + k] = meta[o + 8 + k];
      br.data[i * 8 + 3] = 1;
      if (!(flags & 2)) areas.push([meta[o + 4] * (flags & 1 ? 3 : 1), i]);
    }
    // transmissive: biggest pieces
    areas.sort((a, b2) => b2[0] - a[0]);
    for (let k = 0; k < Math.min(3, areas.length); k++) {
      const piece = areas[k][1];
      let t = trans.find((x) => !x.owner);
      if (!t) {
        t = trans.reduce((a, b2) => (a.order < b2.order ? a : b2));
        if (t.owner) t.owner.data[t.piece * 8 + 3] = Math.abs(t.owner.data[t.piece * 8 + 3]);
        if (t.owner) t.owner.tex.needsUpdate = true;
      }
      t.owner = br;
      t.piece = piece;
      t.order = orderCounter++;
      const g = new BufferGeometry();
      for (const name of ['position', 'normal', 'sid', 'edge', 'luv']) g.setAttribute(name, br.geo!.getAttribute(name));
      g.setIndex(br.geo!.getIndex());
      g.setDrawRange(meta[piece * META + 6], meta[piece * META + 7]);
      t.mesh.geometry = g;
      t.uni.uShardTex.value = br.tex;
      t.uni.uLabelA.value = br.uni.uLabelA.value;
      t.uni.uLabelB.value = br.uni.uLabelB.value;
      t.uni.uHasB.value = br.uni.uHasB.value;
      t.uni.uTint.value.copy(b.tint);
      const tm = t.mesh.material as MeshPhysicalMaterial;
      tm.attenuationColor.copy(b.tint);
      tm.attenuationDistance = ATTEN[b.type];
      t.mesh.visible = true;
      br.data[piece * 8 + 3] = -1;
    }
    // cap rides on the neck
    if (br.neck >= 0 && b.meshes.cap) {
      const cap = new Mesh(b.meshes.cap.geometry, b.meshes.cap.material);
      cap.matrixAutoUpdate = false;
      cap.castShadow = true;
      cap.userData.local = new Matrix4().makeRotationY(b.meshes.cap.rotation.y);
      const m = br.meta!;
      cap.userData.local.premultiply(new Matrix4().makeTranslation(-m[br.neck * META], -m[br.neck * META + 1], -m[br.neck * META + 2]));
      scene.add(cap);
      br.cap = cap;
    }
    writeTex(br);
    spawnGlitter(br, power);
    for (const fn of shatterFns) fn(b, br.hitW, br.dirW);
  }

  const white = new Color(1, 1, 1), gc = new Color();
  function spawnGlitter(br: Break, power: number) {
    const n = Math.round(200 + 80 * power);
    const tint = br.bottle.tint;
    const back = tv.copy(br.dirW).negate();
    for (let k = 0; k < n; k++) {
      const i = gNext;
      gNext = (gNext + 1) % GLITTER;
      if (glitter.count < GLITTER) glitter.count++;
      const kind = Math.random();
      randUnit(rnd);
      c.copy(br.hitW).addScaledVector(rnd, Math.random() * 0.012);
      if (kind < 0.5) {
        // powder halo: tiny, slowed hard by air, hangs around the hit
        randUnit(vel).multiplyScalar(0.4 + Math.random() * 1.6).addScaledVector(back, 0.6 + Math.random());
        gD[i] = 5 + Math.random() * 5;
        gS[i] = 0.0003 + Math.random() * 0.0006;
        gc.copy(tint).lerp(white, 0.75);
      } else if (kind < 0.8) {
        // exit jet needles
        c.addScaledVector(br.dirW, br.bottle.radius * (0.5 + Math.random()));
        cone(vel, br.dirW, 0.55).multiplyScalar((2 + Math.random() * 4) * power);
        gD[i] = 0.6;
        gS[i] = 0.0008 + Math.pow(Math.random(), 2) * 0.004;
        gc.copy(tint).lerp(white, 0.4);
      } else {
        // entry spall
        cone(vel, back, 0.75).multiplyScalar(0.8 + Math.random() * 2.2);
        gD[i] = 0.8;
        gS[i] = 0.0008 + Math.pow(Math.random(), 2) * 0.003;
        gc.copy(tint).lerp(white, 0.4);
      }
      vel.y += Math.random() * 0.4;
      gP[i * 3] = c.x; gP[i * 3 + 1] = c.y; gP[i * 3 + 2] = c.z;
      gV[i * 3] = vel.x; gV[i * 3 + 1] = vel.y; gV[i * 3 + 2] = vel.z;
      qTmp.setFromAxisAngle(randUnit(rnd), Math.random() * 6.28);
      gQ[i * 4] = qTmp.x; gQ[i * 4 + 1] = qTmp.y; gQ[i * 4 + 2] = qTmp.z; gQ[i * 4 + 3] = qTmp.w;
      randUnit(rnd).multiplyScalar(20 + Math.random() * 40);
      gW[i * 3] = rnd.x; gW[i * 3 + 1] = rnd.y; gW[i * 3 + 2] = rnd.z;
      if (!gAwake[i]) gAwakeN++;
      gAwake[i] = 1;
      glitter.setColorAt(i, gc);
    }
    glitter.instanceColor!.needsUpdate = true;
  }

  function writeTex(br: Break) {
    const d = br.data;
    for (let i = 0; i < br.n; i++) {
      const i3 = i * 3, i4 = i * 4;
      if (!(Number.isFinite(br.p[i3] + br.p[i3 + 1] + br.p[i3 + 2]) && Number.isFinite(br.q[i4] + br.q[i4 + 1] + br.q[i4 + 2] + br.q[i4 + 3]))) {
        br.p[i3] = br.p[i3 + 1] = br.p[i3 + 2] = 0;
        br.q[i4] = br.q[i4 + 1] = br.q[i4 + 2] = 0;
        br.q[i4 + 3] = 1;
        br.v.fill(0, i3, i3 + 3);
        br.w.fill(0, i3, i3 + 3);
        if (br.awake[i]) { br.awake[i] = 0; br.awakeCount--; }
        d[i * 8 + 3] = 0;
      }
      d[i * 8] = br.p[i * 3]; d[i * 8 + 1] = br.p[i * 3 + 1]; d[i * 8 + 2] = br.p[i * 3 + 2];
      d[i * 8 + 4] = br.q[i * 4]; d[i * 8 + 5] = br.q[i * 4 + 1]; d[i * 8 + 6] = br.q[i * 4 + 2]; d[i * 8 + 7] = br.q[i * 4 + 3];
    }
    br.tex.needsUpdate = true;
    if (br.cap && br.neck >= 0) {
      const i = br.neck;
      qTmp.set(br.q[i * 4], br.q[i * 4 + 1], br.q[i * 4 + 2], br.q[i * 4 + 3]);
      c.set(br.p[i * 3], br.p[i * 3 + 1], br.p[i * 3 + 2]);
      br.cap.matrix.compose(c, qTmp, rnd.set(1, 1, 1)).multiply(br.cap.userData.local as Matrix4);
      br.cap.matrixWorld.copy(br.cap.matrix);
    }
  }

  // --- physics ---
  let lastImpact = 0;
  const ip = new Vector3();
  function emitImpact(x: number, y: number, z: number, speed: number, size: number) {
    const now = performance.now();
    if (now - lastImpact < 12 || impactFns.length === 0) return;
    lastImpact = now;
    ip.set(x, y, z);
    for (const fn of impactFns) fn(ip, speed, size);
  }

  /** Returns penetration depth and writes the contact normal, or 0. */
  const cn = [0, 0, 0];
  let cSurf = 0;
  function collide(x: number, y: number, z: number): number {
    if (y < 0) { cn[0] = 0; cn[1] = 1; cn[2] = 0; cSurf = 0; return -y; }
    if (y < RAIL.y1 && y > RAIL.y0 - 0.01 && z > RAIL.z0 && z < RAIL.z1 && x > RAIL.x0 && x < RAIL.x1) {
      const dTop = RAIL.y1 - y, dF = RAIL.z1 - z, dB = z - RAIL.z0, dBot = y - RAIL.y0 + 0.01;
      const m = Math.min(dTop, dF, dB, dBot);
      cn[0] = 0; cn[1] = m === dTop ? 1 : m === dBot ? -1 : 0; cn[2] = m === dF ? 1 : m === dB ? -1 : 0;
      cSurf = RAIL.y1;
      return m;
    }
    if (y < RAIL.y0 && z > -0.065 && z < 0.065) {
      for (const px of POSTS) {
        const dx = x - px;
        if (dx > -0.06 && dx < 0.06) {
          const dl = dx + 0.06, dr = 0.06 - dx, dF = 0.065 - z, dB = z + 0.065;
          const m = Math.min(dl, dr, dF, dB);
          cn[0] = m === dl ? -1 : m === dr ? 1 : 0; cn[1] = 0; cn[2] = m === dF ? 1 : m === dB ? -1 : 0;
          return m;
        }
      }
    }
    return 0;
  }

  function stepBreak(br: Break, h: number) {
    const { p, q, v, w, samp } = br;
    for (let i = 0; i < br.n; i++) {
      if (!br.awake[i]) continue;
      if (br.delay[i] > 0) {
        br.delay[i] -= h;
        continue;
      }
      const i3 = i * 3, i4 = i * 4;
      const rad = br.rad[i];
      const drag = 0.04 + 0.0006 / rad;
      v[i3 + 1] -= G * h;
      const dk = 1 - drag * h;
      v[i3] *= dk; v[i3 + 1] *= dk; v[i3 + 2] *= dk;
      p[i3] += v[i3] * h; p[i3 + 1] += v[i3 + 1] * h; p[i3 + 2] += v[i3 + 2] * h;
      let qx = q[i4], qy = q[i4 + 1], qz = q[i4 + 2], qw = q[i4 + 3];
      const wx = w[i3], wy = w[i3 + 1], wz = w[i3 + 2];
      const hh = 0.5 * h;
      const nx = qx + hh * (wx * qw + wy * qz - wz * qy);
      const ny = qy + hh * (wy * qw + wz * qx - wx * qz);
      const nz = qz + hh * (wz * qw + wx * qy - wy * qx);
      const nw = qw + hh * (-wx * qx - wy * qy - wz * qz);
      const l = 1 / Math.hypot(nx, ny, nz, nw);
      qx = q[i4] = nx * l; qy = q[i4 + 1] = ny * l; qz = q[i4 + 2] = nz * l; qw = q[i4 + 3] = nw * l;
      let contact = false;
      if (p[i3 + 1] - rad < RAIL.y1 + 0.01) {
        const invI = br.invI[i];
        for (let k = 0; k < 8; k++) {
          const sx = samp[i * 24 + k * 3], sy = samp[i * 24 + k * 3 + 1], sz = samp[i * 24 + k * 3 + 2];
          // r = q * s
          const tx = 2 * (qy * sz - qz * sy), ty = 2 * (qz * sx - qx * sz), tz = 2 * (qx * sy - qy * sx);
          const rx = sx + qw * tx + (qy * tz - qz * ty);
          const ry = sy + qw * ty + (qz * tx - qx * tz);
          const rz = sz + qw * tz + (qx * ty - qy * tx);
          const depth = collide(p[i3] + rx, p[i3 + 1] + ry, p[i3 + 2] + rz);
          if (depth <= 0) continue;
          contact = true;
          const cx = cn[0], cy = cn[1], cz = cn[2];
          if (cy > 0.5) br.surfY[i] = cSurf;
          // velocity at contact point
          let vpx = v[i3] + (w[i3 + 1] * rz - w[i3 + 2] * ry);
          let vpy = v[i3 + 1] + (w[i3 + 2] * rx - w[i3] * rz);
          let vpz = v[i3 + 2] + (w[i3] * ry - w[i3 + 1] * rx);
          const vn = vpx * cx + vpy * cy + vpz * cz;
          p[i3] += cx * depth; p[i3 + 1] += cy * depth; p[i3 + 2] += cz * depth;
          if (vn >= 0) continue;
          if (vn < -0.8) emitImpact(p[i3], p[i3 + 1], p[i3 + 2], -vn, rad);
          const e = vn < -0.5 ? 0.22 + Math.random() * 0.12 : 0;
          const rnx = ry * cz - rz * cy, rny = rz * cx - rx * cz, rnz = rx * cy - ry * cx;
          const j = (-(1 + e) * vn) / (1 + invI * (rnx * rnx + rny * rny + rnz * rnz));
          const ang = vn < -0.4 ? invI : invI * 0.15;
          v[i3] += cx * j; v[i3 + 1] += cy * j; v[i3 + 2] += cz * j;
          w[i3] += rnx * j * ang; w[i3 + 1] += rny * j * ang; w[i3 + 2] += rnz * j * ang;
          // friction
          vpx = v[i3] + (w[i3 + 1] * rz - w[i3 + 2] * ry);
          vpy = v[i3 + 1] + (w[i3 + 2] * rx - w[i3] * rz);
          vpz = v[i3 + 2] + (w[i3] * ry - w[i3 + 1] * rx);
          const vn2 = vpx * cx + vpy * cy + vpz * cz;
          let ttx = vpx - cx * vn2, tty = vpy - cy * vn2, ttz = vpz - cz * vn2;
          const vt = Math.hypot(ttx, tty, ttz);
          if (vt > 1e-5) {
            ttx /= vt; tty /= vt; ttz /= vt;
            const rtx = ry * ttz - rz * tty, rty = rz * ttx - rx * ttz, rtz = rx * tty - ry * ttx;
            let jt = -vt / (1 + invI * (rtx * rtx + rty * rty + rtz * rtz));
            jt = Math.max(jt, -0.55 * j);
            v[i3] += ttx * jt; v[i3 + 1] += tty * jt; v[i3 + 2] += ttz * jt;
            w[i3] += rtx * jt * ang; w[i3 + 1] += rty * jt * ang; w[i3 + 2] += rtz * jt * ang;
          }
          const wd = vn < -0.4 ? 0.96 : 0.85;
          w[i3] *= wd; w[i3 + 1] *= wd; w[i3 + 2] *= wd;
        }
      }
      if (contact) {
        const v2 = v[i3] * v[i3] + v[i3 + 1] * v[i3 + 1] + v[i3 + 2] * v[i3 + 2];
        const w2 = w[i3] * w[i3] + w[i3 + 1] * w[i3 + 1] + w[i3 + 2] * w[i3 + 2];
        if (v2 < 0.04) {
          const k = 1 - 6 * h;
          w[i3] *= k; w[i3 + 1] *= k; w[i3 + 2] *= k;
        }
        if (v2 < 0.012 && w2 < 9) br.still[i] += h;
        else br.still[i] = 0;
        if (br.still[i] > 0.15) {
          br.awake[i] = 0;
          br.awakeCount--;
          if (br.surfY[i] >= 0) layFlat(br, i);
          v[i3] = v[i3 + 1] = v[i3 + 2] = 0;
          w[i3] = w[i3 + 1] = w[i3 + 2] = 0;
        }
      }
      if (p[i3 + 1] < -2) {
        br.awake[i] = 0;
        br.awakeCount--;
      }
    }
  }

  const fa = new Vector3(), fb = new Vector3(), fq = new Quaternion(), fq2 = new Quaternion();
  /** Settle a resting plate onto its widest face with a little random tilt so some catch the sun. */
  function layFlat(br: Break, i: number) {
    const m = br.meta!;
    const o = i * META;
    if (m[o + 5] & 2) return;
    fq.set(br.q[i * 4], br.q[i * 4 + 1], br.q[i * 4 + 2], br.q[i * 4 + 3]);
    fa.set(m[o], 0, m[o + 2]);
    if (fa.lengthSq() < 1e-10) return;
    fa.normalize().applyQuaternion(fq);
    fb.set((Math.random() - 0.5) * 0.3, fa.y >= 0 ? 1 : -1, (Math.random() - 0.5) * 0.3).normalize();
    fq2.setFromUnitVectors(fa, fb);
    fq.premultiply(fq2);
    br.q[i * 4] = fq.x; br.q[i * 4 + 1] = fq.y; br.q[i * 4 + 2] = fq.z; br.q[i * 4 + 3] = fq.w;
    let minY = 1e9;
    for (let k = 0; k < 8; k++) {
      fa.set(br.samp[i * 24 + k * 3], br.samp[i * 24 + k * 3 + 1], br.samp[i * 24 + k * 3 + 2]).applyQuaternion(fq);
      minY = Math.min(minY, fa.y);
    }
    br.p[i * 3 + 1] = br.surfY[i] - minY + 0.0003;
  }

  const gm = new Matrix4(), gq = new Quaternion(), gs = new Vector3(), gp = new Vector3();
  function stepGlitter(dt: number) {
    if (gAwakeN === 0) return;
    for (let i = 0; i < glitter.count; i++) {
      if (!gAwake[i]) continue;
      const i3 = i * 3;
      gV[i3 + 1] -= G * dt;
      const dk = Math.max(0, 1 - gD[i] * dt);
      gV[i3] *= dk; gV[i3 + 1] *= dk; gV[i3 + 2] *= dk;
      const py = gP[i3 + 1];
      gP[i3] += gV[i3] * dt; gP[i3 + 1] += gV[i3 + 1] * dt; gP[i3 + 2] += gV[i3 + 2] * dt;
      let floor = 0.0004;
      const x = gP[i3], z = gP[i3 + 2];
      if (py >= RAIL.y1 && x > RAIL.x0 && x < RAIL.x1 && z > RAIL.z0 && z < RAIL.z1) floor = RAIL.y1 + 0.0004;
      let spin = 1;
      if (gP[i3 + 1] < floor) {
        gP[i3 + 1] = floor;
        gV[i3 + 1] = -gV[i3 + 1] * 0.2;
        gV[i3] *= 0.4; gV[i3 + 2] *= 0.4;
        gW[i3] *= 0.4; gW[i3 + 1] *= 0.4; gW[i3 + 2] *= 0.4;
        spin = 0.5;
        if (Math.abs(gV[i3 + 1]) < 0.15 && Math.hypot(gV[i3], gV[i3 + 2]) < 0.1) {
          gAwake[i] = 0;
          gAwakeN--;
        }
      }
      gq.set(gQ[i * 4], gQ[i * 4 + 1], gQ[i * 4 + 2], gQ[i * 4 + 3]);
      const ang = Math.hypot(gW[i3], gW[i3 + 1], gW[i3 + 2]) * dt * spin;
      if (ang > 1e-5) {
        qTmp.setFromAxisAngle(gs.set(gW[i3], gW[i3 + 1], gW[i3 + 2]).normalize(), ang);
        gq.premultiply(qTmp);
        if (!gAwake[i]) {
          // settle flat-ish
          gs.set(0, 0, 1).applyQuaternion(gq);
          qTmp.setFromUnitVectors(gs, gs.y >= 0 ? up : tv.set(0, -1, 0));
          gq.premultiply(qTmp.slerp(new Quaternion(), 0.15));
        }
        gQ[i * 4] = gq.x; gQ[i * 4 + 1] = gq.y; gQ[i * 4 + 2] = gq.z; gQ[i * 4 + 3] = gq.w;
      }
      gp.set(gP[i3], gP[i3 + 1], gP[i3 + 2]);
      const s = gS[i];
      gm.compose(gp, gq, gs.set(s, s, s));
      glitter.setMatrixAt(i, gm);
    }
    glitter.instanceMatrix.needsUpdate = true;
  }

  /** Keep at most MAX_AWAKE moving shards: hide the smallest moving ones of the oldest breaks. */
  function capAwake() {
    let total = 0;
    for (const s2 of slots) if (s2.order >= 0) total += s2.awakeCount;
    if (total <= MAX_AWAKE) return;
    const live = slots.filter((s2) => s2.order >= 0 && s2.awakeCount > 0).sort((a, b2) => a.order - b2.order);
    for (const br of live) {
      for (let i = 0; i < br.n && total > MAX_AWAKE; i++) {
        if (!br.awake[i] || br.rad[i] > 0.006) continue;
        br.awake[i] = 0;
        br.awakeCount--;
        total--;
        br.data[i * 8 + 3] = 0;
      }
      if (total <= MAX_AWAKE) break;
    }
  }

  let simMs = 0;
  world.onUpdate((dt) => {
    const t0 = performance.now();
    for (const br of slots) {
      if (br.order < 0) continue;
      br.t += dt;
      if (br.lines?.visible) {
        const lm = br.lines.material as ShaderMaterial;
        lm.uniforms.uR.value = 0.06 * Math.min(1, br.t / CRACK_TIME);
        lm.uniforms.uF.value = 1 - Math.min(1, Math.max(0, (br.t - CRACK_TIME) / 0.012));
        if (br.t > CRACK_TIME + 0.012) br.lines.visible = false;
      }
      if (br.crush?.visible && br.t > 0.02) br.crush.visible = false;
      if (br.awakeCount <= 0 || dt <= 0) continue;
      const n = Math.min(8, Math.max(1, Math.ceil(dt / (1 / 200))));
      const h = dt / n;
      for (let s = 0; s < n; s++) stepBreak(br, h);
      writeTex(br);
    }
    capAwake();
    if (dt > 0) {
      const n = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 120))));
      for (let s = 0; s < n; s++) stepGlitter(dt / n);
    }
    simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
  });

  function clearShards() {
    for (const br of slots) {
      if (br.order >= 0 && br.state !== 'burst') br.bottle.alive = true;
      freeSlot(br);
      br.state = 'burst';
    }
    pending.clear();
    for (const t of trans) { t.owner = null; t.mesh.visible = false; }
    glitter.count = 0;
    gNext = 0;
    gAwakeN = 0;
    gAwake.fill(0);
  }

  const api = {
    shatter,
    clearShards,
    onShatter(fn: ShatterFn) { shatterFns.push(fn); },
    /** Fires on the hit frame, before the crack phase (sound, hit-stop). */
    onCrack(fn: ShatterFn) { crackFns.push(fn); },
    onShardImpact(fn: ShardImpactFn) { impactFns.push(fn); },
    _slots: slots,
    stats() {
      let awake = 0, total = 0;
      for (const s of slots) if (s.order >= 0) { awake += s.awakeCount; total += s.n; }
      return { awake, total, glitter: glitter.count, glitterAwake: gAwakeN, simMs: +simMs.toFixed(3), workerMs: +lastWorkerMs.toFixed(1) };
    },
  };
  return api;
}

export type FractureSystem = ReturnType<typeof createFracture>;

