import {
  Color,
  CustomBlending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  SrcColorFactor,
  Vector2,
  Vector3,
  ZeroFactor,
} from 'three';
import type { World } from '../core/world';
import type { Bottle } from '../bottles';

const MAX_DROPS = 900;
const MAX_SPOTS = 96;
const GRAVITY = 9.81;
const RAIL_HALF_DEPTH = 0.08;
/** Game seconds the cloud holds the bottle silhouette before it releases. */
const HOLD = 0.06;
const LIGAMENT_BREAK = 0.12;

const K_DROP = 0;
const K_FOAM = 1;
const K_LIG = 2;

const dropVert = /* glsl */ `
attribute vec4 aPos;   // xyz, width (m)
attribute vec4 aVel;   // xyz, fixed length (m; ligaments)
attribute vec4 aCol;   // rgb, alpha
uniform vec3 uSunDir;
uniform float uBlur;   // shutter time in game seconds (= timeScale / 60)
uniform float uPx;     // metres per pixel at distance 1
varying vec2 vUv;
varying vec4 vCol;
varying float vGlow;
void main() {
  vec4 mv = modelViewMatrix * vec4(aPos.xyz, 1.0);
  vec3 vv = (viewMatrix * vec4(aVel.xyz, 0.0)).xyz;
  float sp = length(vv.xy);
  vec2 ax = sp > 1e-4 ? vv.xy / sp : vec2(0.0, 1.0);
  vec2 px = vec2(ax.y, -ax.x);
  float minW = 1.3 * uPx * -mv.z;
  float w = max(aPos.w, minW);
  float len = max(w, aVel.w) + sp * uBlur;
  mv.xy += ax * position.y * len + px * position.x * w;
  vUv = position.xy * 2.0;
  float k = aPos.w / w;
  vCol = vec4(aCol.rgb, aCol.a * k);
  vec3 toP = normalize(aPos.xyz - cameraPosition);
  vGlow = pow(max(dot(toP, -uSunDir), 0.0), 6.0);
  gl_Position = projectionMatrix * mv;
}`;

const dropFrag = /* glsl */ `
uniform vec3 uSunColor;
varying vec2 vUv;
varying vec4 vCol;
varying float vGlow;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  vec3 n = vec3(vUv, sqrt(1.0 - r2));
  float rim = pow(1.0 - n.z, 2.0);
  float spec = pow(max(dot(n, normalize(vec3(-0.35, 0.5, 0.8))), 0.0), 32.0);
  vec3 body = vCol.rgb * (0.45 + 0.55 * n.z);
  vec3 c = body + vCol.rgb * uSunColor * vGlow * 0.25 * (1.0 + 0.5 * rim) + spec * uSunColor * 1.1;
  gl_FragColor = vec4(c, vCol.a * (0.7 + 0.3 * rim) * (1.0 - smoothstep(0.7, 1.0, r2)));
}`;

const spotVert = /* glsl */ `
attribute vec4 aSpot; // xyz, radius
attribute vec2 aA;    // strength, seed
varying vec2 vUv;
varying vec2 vA;
void main() {
  vUv = position.xy * 2.0;
  vA = aA;
  vec3 p = aSpot.xyz + vec3(position.x, 0.0, -position.y) * aSpot.w * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
// multiplicative: dst * src.rgb, so 1 = no change, 0.6 = wet albedo
const spotFrag = /* glsl */ `
varying vec2 vUv;
varying vec2 vA;
void main() {
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  float edge = 0.8 + 0.1 * sin(a * 5.0 + vA.y * 9.0) + 0.06 * sin(a * 11.0 + vA.y * 3.0);
  float m = 1.0 - smoothstep(edge - 0.3, edge, r);
  gl_FragColor = vec4(vec3(1.0 - 0.5 * m * vA.x), 1.0);
}`;

/** Simple liquid splash: velocity-stretched droplets, ligaments that pinch off, wet spots. */
export function createLiquid(world: World) {
  const geo = new PlaneGeometry(1, 1);
  const pos = new Float32Array(MAX_DROPS * 4);
  const vel = new Float32Array(MAX_DROPS * 4);
  const col = new Float32Array(MAX_DROPS * 4);
  const life = new Float32Array(MAX_DROPS);
  const age = new Float32Array(MAX_DROPS);
  const kind = new Uint8Array(MAX_DROPS);
  const aPos = new InstancedBufferAttribute(pos, 4).setUsage(DynamicDrawUsage);
  const aVel = new InstancedBufferAttribute(vel, 4).setUsage(DynamicDrawUsage);
  const aCol = new InstancedBufferAttribute(col, 4).setUsage(DynamicDrawUsage);
  geo.setAttribute('aPos', aPos);
  geo.setAttribute('aVel', aVel);
  geo.setAttribute('aCol', aCol);
  const sunColor = world.sun.color.clone().multiplyScalar(Math.min(3, world.sun.intensity) / 3);
  const uniforms = {
    uSunDir: { value: world.sunDir },
    uSunColor: { value: sunColor },
    uBlur: { value: 1 / 60 },
    uPx: { value: 0.001 },
  };
  const mat = new ShaderMaterial({
    vertexShader: dropVert,
    fragmentShader: dropFrag,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  });
  const drops = new InstancedMesh(geo, mat, MAX_DROPS);
  drops.count = 0;
  drops.frustumCulled = false;
  drops.renderOrder = 5;
  drops.name = 'liquidDrops';
  world.scene.add(drops);

  const sgeo = new PlaneGeometry(1, 1);
  const spot = new Float32Array(MAX_SPOTS * 4);
  const spotA = new Float32Array(MAX_SPOTS * 2);
  const spotLife = new Float32Array(MAX_SPOTS);
  const spotDur = new Float32Array(MAX_SPOTS);
  const aSpot = new InstancedBufferAttribute(spot, 4).setUsage(DynamicDrawUsage);
  const aA = new InstancedBufferAttribute(spotA, 2).setUsage(DynamicDrawUsage);
  sgeo.setAttribute('aSpot', aSpot);
  sgeo.setAttribute('aA', aA);
  const spots = new InstancedMesh(
    sgeo,
    new ShaderMaterial({
      vertexShader: spotVert,
      fragmentShader: spotFrag,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: ZeroFactor,
      blendDst: SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    MAX_SPOTS,
  );
  spots.frustumCulled = false;
  spots.renderOrder = 4;
  spots.name = 'liquidSpots';
  world.scene.add(spots);

  let count = 0;
  let spotNext = 0;
  let spotsAlive = 0;
  let spotBudget = 0; // per-splash cap on landing spots
  const c = new Color();
  const foamC = new Color(0.75, 0.72, 0.66);
  const v3 = new Vector3();
  const side = new Vector3();
  const up = new Vector3();
  const negDir = new Vector3();
  const res = new Vector2();
  const onLand: ((p: Vector3) => void)[] = [];
  const landP = new Vector3();

  function addSpot(x: number, y: number, z: number, r: number) {
    const i = spotNext;
    spotNext = (spotNext + 1) % MAX_SPOTS;
    spot[i * 4] = x;
    spot[i * 4 + 1] = y + 0.001;
    spot[i * 4 + 2] = z;
    spot[i * 4 + 3] = r;
    spotDur[i] = 8 + Math.random() * 7;
    spotLife[i] = spotDur[i];
    spotA[i * 2] = 1;
    spotA[i * 2 + 1] = Math.random();
    spotsAlive = MAX_SPOTS;
    aSpot.needsUpdate = true;
  }

  /** Random direction inside a cone around `axis` (unit) with half-angle `ang`; written to v3. */
  function cone(axis: Vector3, ang: number) {
    side.set(axis.z, 0, -axis.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    up.crossVectors(axis, side);
    const a = Math.random() * Math.PI * 2;
    const r = Math.tan(ang) * Math.sqrt(Math.random());
    return v3.copy(axis).addScaledVector(side, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
  }

  function emit(k: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, w: number, len: number, color: Color, alpha: number, t: number) {
    if (count >= MAX_DROPS) return -1;
    const i = count++;
    const o = i * 4;
    pos[o] = x;
    pos[o + 1] = y;
    pos[o + 2] = z;
    pos[o + 3] = w;
    vel[o] = vx;
    vel[o + 1] = vy;
    vel[o + 2] = vz;
    vel[o + 3] = len;
    col[o] = color.r;
    col[o + 1] = color.g;
    col[o + 2] = color.b;
    col[o + 3] = alpha;
    life[i] = t;
    age[i] = 0;
    kind[i] = k;
    return i;
  }

  function spawn(bottle: Bottle, point: Vector3, dir: Vector3) {
    const fill = bottle.fill ?? 0;
    if (fill <= 0.02) return;
    const g = bottle.group.position;
    const top = bottle.fillWorldY();
    const whisky = bottle.type === 'whiskey';
    const vk = whisky ? 0.75 : 1;
    c.copy(bottle.liquidColor).multiplyScalar(0.75);
    const n = Math.round((whisky ? 300 : 420) * (0.5 + 0.5 * fill));
    const nLig = whisky ? 40 : 28;
    const nFoam = bottle.type === 'beer' ? 40 : bottle.type === 'soda' ? 15 : 0;
    negDir.copy(dir).negate();
    spotBudget = 14;
    for (let j = 0; j < n + nLig + nFoam; j++) {
      // start inside the liquid volume so the cloud holds the bottle shape
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * bottle.radius * 0.9;
      const ox = Math.cos(a);
      const oz = Math.sin(a);
      const x = g.x + ox * rr;
      const z = g.z + oz * rr;
      const y = g.y + 0.01 + Math.random() * Math.max(0.02, top - g.y - 0.01);
      const u = Math.random();
      let sp: number;
      if (u < 0.7) {
        cone(dir, 0.61); // 35 deg exit cone
        sp = 1.5 + Math.random() * 2;
      } else if (u < 0.85) {
        cone(negDir, 0.7); // backsplash toward the shooter
        sp = 0.5 + Math.random();
      } else {
        v3.set(Math.random() * 2 - 1, Math.random() - 0.5, Math.random() * 2 - 1).normalize();
        sp = 0.3 + Math.random() * 0.9;
      }
      sp *= vk;
      // radial bulge from the axis plus vertical spread
      const out = (0.3 + 0.9 * (rr / bottle.radius)) * vk;
      const vx = v3.x * sp + ox * out;
      const vy = v3.y * sp + (Math.random() - 0.3) * 1.2 * vk;
      const vz = v3.z * sp + oz * out;
      if (j < n) {
        const mist = Math.random() < 0.5;
        const w = mist ? 0.0012 + Math.random() * 0.0012 : (whisky ? 0.0035 : 0.0028) + Math.random() * 0.0025;
        emit(K_DROP, x, y, z, vx, vy, vz, w, 0, c, mist ? 0.55 : 0.85, 1.4 + Math.random() * 0.8);
      } else if (j < n + nLig) {
        emit(K_LIG, x, y, z, vx * 1.1, vy, vz * 1.1, 0.0022 + Math.random() * 0.001, 0.006 + Math.random() * 0.006, c, 0.9, 2);
      } else {
        emit(K_FOAM, x, Math.max(y, top - 0.03), z, vx * 0.4, vy * 0.4 + 0.3, vz * 0.4, 0.003 + Math.random() * 0.003, 0, foamC, 0.5, 1 + Math.random() * 0.6);
      }
    }
    addSpot(g.x, world.railTopY, g.z, bottle.radius * 1.4);
    drops.count = count;
  }

  function kill(i: number) {
    const last = --count;
    if (i !== last) {
      pos.copyWithin(i * 4, last * 4, last * 4 + 4);
      vel.copyWithin(i * 4, last * 4, last * 4 + 4);
      col.copyWithin(i * 4, last * 4, last * 4 + 4);
      life[i] = life[last];
      age[i] = age[last];
      kind[i] = kind[last];
    }
  }

  world.onUpdate((dt) => {
    uniforms.uBlur.value = world.time.scale / 60;
    world.renderer.getDrawingBufferSize(res);
    uniforms.uPx.value = (2 * Math.tan((world.camera.fov * Math.PI) / 360)) / Math.max(1, res.y);
    if (dt <= 0) return;
    if (count > 0) {
      const drag = Math.exp(-dt * 0.8);
      for (let i = count - 1; i >= 0; i--) {
        const o = i * 4;
        life[i] -= dt;
        age[i] += dt;
        const k = kind[i];
        // ligament pinch-off: 3-4 child drops along its axis
        if (k === K_LIG && age[i] > LIGAMENT_BREAK) {
          const len = vel[o + 3];
          const sp = Math.hypot(vel[o], vel[o + 1], vel[o + 2]) || 1;
          const m = 3 + (Math.random() < 0.5 ? 1 : 0);
          for (let q = 0; q < m; q++) {
            const f = (q / (m - 1) - 0.5) * len;
            c.setRGB(col[o], col[o + 1], col[o + 2]);
            emit(
              K_DROP,
              pos[o] + (vel[o] / sp) * f,
              pos[o + 1] + (vel[o + 1] / sp) * f,
              pos[o + 2] + (vel[o + 2] / sp) * f,
              vel[o] * (1 + f * 4) + (Math.random() - 0.5) * 0.3,
              vel[o + 1] * (1 + f * 4) + (Math.random() - 0.5) * 0.3,
              vel[o + 2] * (1 + f * 4) + (Math.random() - 0.5) * 0.3,
              0.0015 + Math.random() * 0.0015,
              0,
              c,
              0.85,
              life[i],
            );
          }
          kill(i);
          continue;
        }
        const hold = age[i] < HOLD ? 0.15 : 1;
        const foam = k === K_FOAM;
        const dr = foam ? drag * drag : drag;
        vel[o] *= dr;
        vel[o + 2] *= dr;
        if (hold === 1) vel[o + 1] -= GRAVITY * dt * (foam ? 0.6 : 1);
        const py = pos[o + 1];
        const h = dt * hold;
        pos[o] += vel[o] * h;
        pos[o + 1] += vel[o + 1] * h;
        pos[o + 2] += vel[o + 2] * h;
        const ny = pos[o + 1];
        const onRail = Math.abs(pos[o + 2]) < RAIL_HALF_DEPTH && py >= world.railTopY && ny < world.railTopY;
        const hit = onRail || ny < 0.003;
        if (hit || life[i] <= 0) {
          if (hit && !foam && pos[o + 3] > 0.0018 && spotBudget > 0 && Math.random() < 0.2) {
            spotBudget--;
            addSpot(pos[o], onRail ? world.railTopY : 0, pos[o + 2], 0.02 + Math.random() * 0.04);
          }
          if (hit && onLand.length) {
            landP.set(pos[o], ny, pos[o + 2]);
            for (const fn of onLand) fn(landP);
          }
          kill(i);
        }
      }
      drops.count = count;
      aPos.needsUpdate = true;
      aVel.needsUpdate = true;
      aCol.needsUpdate = true;
    }
    if (spotsAlive > 0) {
      let alive = 0;
      for (let i = 0; i < MAX_SPOTS; i++) {
        if (spotLife[i] <= 0) continue;
        spotLife[i] -= dt;
        const f = spotLife[i] / spotDur[i];
        spotA[i * 2] = Math.max(0, Math.min(1, f * 2.5)); // holds, then fades over the last 40 %
        if (spotLife[i] > 0) alive++;
      }
      spotsAlive = alive;
      aA.needsUpdate = true;
    }
  });

  return {
    spawn,
    /** Droplet landing callback (throttle on the caller side). */
    onLand(fn: (p: Vector3) => void) {
      onLand.push(fn);
    },
    get count() {
      return count;
    },
    clear() {
      count = 0;
      drops.count = 0;
      spotLife.fill(0);
      spotA.fill(0);
      aA.needsUpdate = true;
      spotsAlive = 0;
    },
  };
}

export type Liquid = ReturnType<typeof createLiquid>;
