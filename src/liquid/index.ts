import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { World } from '../core/world';
import type { Bottle } from '../bottles';

const MAX_DROPS = 700;
const MAX_SPOTS = 48;
const GRAVITY = 9.81;
const RAIL_HALF_DEPTH = 0.08;
const WHITE = new Color(1, 1, 1);

const dropVert = /* glsl */ `
attribute vec4 aPos;   // xyz, size
attribute vec4 aVel;   // xyz, stretch
attribute vec4 aCol;   // rgb, alpha
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec4 vCol;
varying float vGlow;
void main() {
  vec4 mv = modelViewMatrix * vec4(aPos.xyz, 1.0);
  vec3 vv = (viewMatrix * vec4(aVel.xyz, 0.0)).xyz;
  float sp = length(vv.xy);
  vec2 ax = sp > 1e-4 ? vv.xy / sp : vec2(0.0, 1.0);
  vec2 px = vec2(ax.y, -ax.x);
  float len = aPos.w + sp * aVel.w;
  mv.xy += ax * position.y * len + px * position.x * aPos.w;
  vUv = position.xy * 2.0;
  vCol = aCol;
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
  float spec = pow(max(dot(n, normalize(vec3(-0.35, 0.5, 0.8))), 0.0), 24.0);
  vec3 body = vCol.rgb * (0.35 + 0.65 * n.z);
  vec3 c = body + vCol.rgb * uSunColor * vGlow * (0.6 + 1.6 * rim) + spec * uSunColor * 0.9;
  gl_FragColor = vec4(c, vCol.a * (0.55 + 0.45 * rim) * (1.0 - smoothstep(0.7, 1.0, r2)));
}`;

const spotVert = /* glsl */ `
attribute vec4 aSpot; // xyz, radius
attribute float aA;
varying vec2 vUv;
varying float vA;
void main() {
  vUv = position.xy * 2.0;
  vA = aA;
  vec3 p = aSpot.xyz + vec3(position.x, 0.0, -position.y) * aSpot.w * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const spotFrag = /* glsl */ `
varying vec2 vUv;
varying float vA;
void main() {
  float r = length(vUv);
  // irregular edge from a cheap angular wobble
  float a = atan(vUv.y, vUv.x);
  float edge = 0.8 + 0.12 * sin(a * 5.0 + vA * 9.0) + 0.06 * sin(a * 11.0);
  float m = 1.0 - smoothstep(edge - 0.25, edge, r);
  gl_FragColor = vec4(0.04, 0.025, 0.01, m * vA * 0.45);
}`;

/** Simple liquid splash: velocity-stretched droplet sprites + short-lived wet spots. */
export function createLiquid(world: World) {
  const geo = new PlaneGeometry(1, 1);
  const pos = new Float32Array(MAX_DROPS * 4);
  const vel = new Float32Array(MAX_DROPS * 4);
  const col = new Float32Array(MAX_DROPS * 4);
  const life = new Float32Array(MAX_DROPS);
  const flags = new Uint8Array(MAX_DROPS); // 1 = foam (slower, no wet spot)
  const aPos = new InstancedBufferAttribute(pos, 4).setUsage(DynamicDrawUsage);
  const aVel = new InstancedBufferAttribute(vel, 4).setUsage(DynamicDrawUsage);
  const aCol = new InstancedBufferAttribute(col, 4).setUsage(DynamicDrawUsage);
  geo.setAttribute('aPos', aPos);
  geo.setAttribute('aVel', aVel);
  geo.setAttribute('aCol', aCol);
  const sunColor = world.sun.color.clone().multiplyScalar(Math.min(3, world.sun.intensity) / 3);
  const mat = new ShaderMaterial({
    vertexShader: dropVert,
    fragmentShader: dropFrag,
    uniforms: { uSunDir: { value: world.sunDir }, uSunColor: { value: sunColor } },
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
  const spotA = new Float32Array(MAX_SPOTS);
  const spotLife = new Float32Array(MAX_SPOTS);
  const aSpot = new InstancedBufferAttribute(spot, 4).setUsage(DynamicDrawUsage);
  const aA = new InstancedBufferAttribute(spotA, 1).setUsage(DynamicDrawUsage);
  sgeo.setAttribute('aSpot', aSpot);
  sgeo.setAttribute('aA', aA);
  const spots = new InstancedMesh(
    sgeo,
    new ShaderMaterial({
      vertexShader: spotVert,
      fragmentShader: spotFrag,
      transparent: true,
      depthWrite: false,
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
  const c = new Color();
  const radial = new Vector3();
  const onLand: ((p: Vector3) => void)[] = [];
  const landP = new Vector3();

  function addSpot(x: number, y: number, z: number, r: number) {
    const i = spotNext;
    spotNext = (spotNext + 1) % MAX_SPOTS;
    spot.set([x, y + 0.001, z, r], i * 4);
    spotLife[i] = 1;
    spotA[i] = 1;
    spotsAlive = MAX_SPOTS;
  }

  function spawn(bottle: Bottle, point: Vector3, dir: Vector3) {
    const fill = bottle.fill ?? 0;
    if (fill <= 0.02) return;
    const g = bottle.group.position;
    const top = bottle.fillWorldY();
    const whisky = bottle.type === 'whiskey';
    const n = Math.round((whisky ? 140 : 220) * (0.4 + 0.6 * fill)) + 12;
    const foam = bottle.type === 'beer' ? 40 : bottle.type === 'soda' ? 20 : 0;
    const speedK = whisky ? 0.7 : 1;
    for (let k = 0; k < n + foam; k++) {
      if (count >= MAX_DROPS) break;
      const i = count++;
      const isFoam = k >= n;
      const streak = !isFoam && k < 12;
      // spawn inside the liquid volume so the cloud briefly holds the bottle shape
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * bottle.radius * 0.9;
      const y = g.y + 0.01 + Math.random() * Math.max(0.02, top - g.y - 0.01);
      radial.set(Math.cos(a), 0, Math.sin(a));
      const out = (0.6 + 2.6 * (rr / bottle.radius)) * speedK;
      const along = (streak ? 5 + Math.random() * 3 : 0.5 + Math.random() * 3.5) * speedK * (isFoam ? 0.4 : 1);
      pos[i * 4] = g.x + radial.x * rr;
      pos[i * 4 + 1] = y;
      pos[i * 4 + 2] = g.z + radial.z * rr;
      pos[i * 4 + 3] = isFoam ? 0.006 + Math.random() * 0.006 : (whisky ? 0.005 : 0.0035) + Math.random() * 0.0045;
      vel[i * 4] = radial.x * out + dir.x * along;
      vel[i * 4 + 1] = Math.random() * 1.6 + 0.4 + dir.y * along + (point.y - y) * -2;
      vel[i * 4 + 2] = radial.z * out + dir.z * along;
      vel[i * 4 + 3] = streak ? 0.05 : 0.018;
      if (isFoam) c.setRGB(0.95, 0.92, 0.85);
      else c.copy(bottle.liquidColor).lerp(WHITE, 0.05).multiplyScalar(0.9);
      col[i * 4] = c.r;
      col[i * 4 + 1] = c.g;
      col[i * 4 + 2] = c.b;
      col[i * 4 + 3] = isFoam ? 0.9 : 0.85;
      life[i] = 1.6 + Math.random() * 0.8;
      flags[i] = isFoam ? 1 : 0;
    }
    // immediate wet patch where the bottle stood
    addSpot(g.x, world.railTopY, g.z, bottle.radius * 1.3);
    drops.count = count;
  }

  function kill(i: number) {
    const last = --count;
    if (i !== last) {
      pos.copyWithin(i * 4, last * 4, last * 4 + 4);
      vel.copyWithin(i * 4, last * 4, last * 4 + 4);
      col.copyWithin(i * 4, last * 4, last * 4 + 4);
      life[i] = life[last];
      flags[i] = flags[last];
    }
  }

  world.onUpdate((dt) => {
    if (dt <= 0) return;
    if (count > 0) {
      const drag = Math.exp(-dt * 0.6);
      for (let i = count - 1; i >= 0; i--) {
        const o = i * 4;
        life[i] -= dt;
        const foam = flags[i] === 1;
        vel[o] *= foam ? drag * drag : drag;
        vel[o + 2] *= foam ? drag * drag : drag;
        vel[o + 1] -= GRAVITY * dt * (foam ? 0.6 : 1);
        const py = pos[o + 1];
        pos[o] += vel[o] * dt;
        pos[o + 1] += vel[o + 1] * dt;
        pos[o + 2] += vel[o + 2] * dt;
        const ny = pos[o + 1];
        const onRail = Math.abs(pos[o + 2]) < RAIL_HALF_DEPTH && py >= world.railTopY && ny < world.railTopY;
        const hit = onRail || ny < 0.003;
        if (hit || life[i] <= 0) {
          if (hit && !foam && Math.random() < 0.07) {
            addSpot(pos[o], onRail ? world.railTopY : 0, pos[o + 2], 0.012 + Math.random() * 0.03);
            if (onLand.length) {
              landP.set(pos[o], ny, pos[o + 2]);
              for (const fn of onLand) fn(landP);
            }
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
        spotLife[i] -= dt / 5; // ~5 s of game time
        spotA[i] = Math.max(0, Math.min(1, spotLife[i] * 1.6));
        if (spotLife[i] > 0) alive++;
      }
      spotsAlive = alive;
      aA.needsUpdate = true;
    }
  });

  return {
    spawn,
    /** Droplet splat callback (throttle on the caller side). */
    onLand(fn: (p: Vector3) => void) {
      onLand.push(fn);
    },
    get count() {
      return count;
    },
    clear() {
      count = 0;
          spotLife.fill(0);
      spotA.fill(0);
      aA.needsUpdate = true;
      spotsAlive = 0;
    },
  };
}

export type Liquid = ReturnType<typeof createLiquid>;
