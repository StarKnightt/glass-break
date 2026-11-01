import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  Shape,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadPbr } from './textures';
import { mulberry32 } from './rand';

/** Texture has 5 vertical planks across U; one tile spans ~0.75 m along the grain. */
const PLANKS_IN_TEX = 5;
const TILE_LEN = 0.75;

export const POST_HEIGHT = 1.12;
export const RAIL_W = 0.16;
export const RAIL_T = 0.045;
export const RAIL_TOP_Y = POST_HEIGHT + RAIL_T;
const POST_SPACING = 2.1;
const POST_COUNT = 11;

type Axis = 0 | 1 | 2;

function roundedRect(w: number, h: number, r: number) {
  const s = new Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

interface BoardOpts {
  /** Bow amplitude (m) and the axis it displaces along. */
  bow?: number;
  bowAxis?: Axis;
  bevel?: number;
  tint: Color;
}

/**
 * Beveled board extruded along `long`, with UVs laid out like a single plank from the texture
 * (grain along the length), plus bow/sag and twist so it doesn't read as a CG box.
 */
function board(sx: number, sy: number, sz: number, long: Axis, rnd: () => number, o: BoardOpts) {
  const dims = [sx, sy, sz];
  const L = dims[long];
  const a1 = ((long + 1) % 3) as Axis;
  const a2 = ((long + 2) % 3) as Axis;
  const bevel = Math.min(o.bevel ?? 0.007, dims[a1] * 0.3, dims[a2] * 0.3);
  const ex = new ExtrudeGeometry(roundedRect(dims[a1], dims[a2], bevel), {
    depth: L,
    steps: long === 1 ? 4 : 12,
    bevelEnabled: false,
    curveSegments: 2,
  });
  ex.translate(0, 0, -L / 2);
  // map local (x, y, z) = (a1, a2, long)
  const src = ex.getAttribute('position') as BufferAttribute;
  const pos = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) {
    pos[i * 3 + a1] = src.getX(i);
    pos[i * 3 + a2] = src.getY(i);
    pos[i * 3 + long] = src.getZ(i);
  }
  ex.dispose();
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.computeVertexNormals();

  const nrm = g.getAttribute('normal') as BufferAttribute;
  const uv = new Float32Array(src.count * 2);
  const col = new Float32Array(src.count * 3);
  const pw = 1 / PLANKS_IN_TEX;
  const u0 = Math.floor(rnd() * PLANKS_IN_TEX) * pw + pw * 0.08;
  const uw = pw * 0.84;
  const vOff = rnd() * 4;
  const flip = rnd() < 0.5;
  const bowA = (o.bow ?? 0.01) * (0.5 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1);
  const bowAxis = o.bowAxis ?? (long === 1 ? 0 : 2);
  const twist = (rnd() - 0.5) * 0.05;
  const p = [0, 0, 0];
  for (let i = 0; i < src.count; i++) {
    p[0] = pos[i * 3]; p[1] = pos[i * 3 + 1]; p[2] = pos[i * 3 + 2];
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    const na = nx > ny && nx > nz ? 0 : ny > nz ? 1 : 2;
    const along = p[long] + L / 2;
    let u: number, v: number;
    if (na === long) {
      u = u0 + (p[a1] / dims[a1] + 0.5) * uw;
      v = vOff + (p[a2] / dims[a2] + 0.5) * 0.05;
    } else {
      const across = (na === a1 ? a2 : a1) as Axis;
      let t = p[across] / dims[across] + 0.5;
      if (flip) t = 1 - t;
      u = u0 + t * uw;
      v = vOff + along / TILE_LEN;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
    col[i * 3] = o.tint.r; col[i * 3 + 1] = o.tint.g; col[i * 3 + 2] = o.tint.b;

    const s = along / L;
    p[bowAxis] += bowA * Math.sin(s * Math.PI);
    const ang = twist * (s - 0.5);
    const c = Math.cos(ang), sn = Math.sin(ang);
    const q1 = p[a1], q2 = p[a2];
    p[a1] = q1 * c - q2 * sn;
    p[a2] = q1 * sn + q2 * c;
    pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Per-board weathering tint: silver-grey with ±10 % value and slight warm/cool hue drift. */
function boardTint(rnd: () => number) {
  const v = 0.9 + rnd() * 0.2;
  const warm = (rnd() - 0.5) * 0.08;
  return new Color(v * (1 + warm), v, v * (1 - warm * 1.4));
}

export function createFence(renderer: WebGLRenderer) {
  const rnd = mulberry32(7);
  const tex = loadPbr(renderer, 'wood_planks_grey');
  const mat = new MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.arm,
    aoMap: tex.arm,
    aoMapIntensity: 0.8,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  });
  mat.normalScale.set(1.8, 1.8);
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFenceY;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFenceY = (modelMatrix * vec4(transformed, 1.0)).y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFenceY;')
      .replace(
        '#include <map_fragment>',
        `{
           // Sun-bleached silver-grey (~#8a8076..#a39a8c) with warm brown kept only in deep grain.
           vec3 t = texture2D(map, vMapUv).rgb;
           float l = dot(t, vec3(0.299, 0.587, 0.114));
           float k = clamp(0.35 + l * 11.0, 0.25, 1.7);
           vec3 silver = vec3(0.27, 0.245, 0.215) * k;
           vec3 grain = vec3(0.085, 0.055, 0.035);
           diffuseColor.rgb *= mix(grain, silver, smoothstep(0.015, 0.06, l));
           // contact darkening + grime splash near the ground
           diffuseColor.rgb *= mix(0.45, 1.0, smoothstep(0.0, 0.3, vFenceY));
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = 0.86 + 0.09 * texture2D(roughnessMap, vRoughnessMapUv).g;`,
      );
  };

  const geos: BufferGeometry[] = [];
  const half = ((POST_COUNT - 1) * POST_SPACING) / 2;
  for (let i = 0; i < POST_COUNT; i++) {
    const x = -half + i * POST_SPACING + (rnd() - 0.5) * 0.12;
    const h = POST_HEIGHT + 0.25; // buried 0.25 m
    const w = 0.1 + rnd() * 0.035;
    const g = board(w, h, 0.1 + rnd() * 0.03, 1, rnd, { bow: 0.006, tint: boardTint(rnd), bevel: 0.01 });
    g.rotateY((rnd() - 0.5) * 0.2);
    g.rotateZ((rnd() - 0.5) * 0.07);
    g.rotateX((rnd() - 0.5) * 0.06);
    g.translate(x, h / 2 - 0.25 - rnd() * 0.02, 0);
    geos.push(g);
  }
  // Top cap rail in 2-span boards. The bottle span (x in [-2.1, 2.1]) stays level.
  const span = POST_SPACING * 2;
  for (let s = 0; s < (POST_COUNT - 1) / 2; s++) {
    const x0 = -half + s * span;
    const isBottleSpan = Math.abs(x0 + span / 2) < 0.1;
    const g = board(span - 0.008, RAIL_T, RAIL_W + (rnd() - 0.5) * 0.02, 0, rnd, {
      bow: isBottleSpan ? 0.006 : 0.012,
      bowAxis: 2,
      tint: boardTint(rnd),
    });
    g.rotateY((rnd() - 0.5) * 0.012);
    if (!isBottleSpan) g.rotateZ((rnd() - 0.5) * 0.012);
    g.translate(x0 + span / 2, POST_HEIGHT + RAIL_T / 2 + (isBottleSpan ? 0 : (rnd() - 0.5) * 0.012), (rnd() - 0.5) * 0.02);
    geos.push(g);
  }
  // Two front rails nailed on the camera side, one board per span: sag, tilt, jitter.
  for (const y of [0.32, 0.78]) {
    for (let s = 0; s < POST_COUNT - 1; s++) {
      const x0 = -half + s * POST_SPACING;
      const broken = y === 0.78 && s === 7;
      const len = broken ? POST_SPACING * 0.62 : POST_SPACING + 0.06;
      const g = board(len, 0.1 + rnd() * 0.04, 0.022 + rnd() * 0.012, 0, rnd, {
        bow: 0.015,
        bowAxis: 1,
        tint: boardTint(rnd),
        bevel: 0.005,
      });
      if (broken) {
        // nail on the left post gave way: the board hangs down at an angle
        g.translate(len / 2, 0, 0);
        g.rotateZ(-0.32);
        g.translate(x0 + 0.02, y, 0.07);
      } else {
        g.rotateZ((rnd() - 0.5) * 0.04);
        g.rotateX((rnd() - 0.5) * 0.06);
        g.translate(x0 + POST_SPACING / 2, y + (rnd() - 0.5) * 0.07, 0.055 + 0.014 + (rnd() - 0.5) * 0.01);
      }
      geos.push(g);
    }
  }

  const merged = mergeGeometries(geos)!;
  merged.setAttribute('uv1', merged.getAttribute('uv'));
  const mesh = new Mesh(merged, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'fence';

  const group = new Group();
  group.add(mesh);

  // Bottle slots along the central rail span.
  const slots: Vector3[] = [];
  const n = 8;
  const width = 3.9;
  for (let i = 0; i < n; i++) {
    const x = -width / 2 + (i / (n - 1)) * width + (rnd() - 0.5) * 0.1;
    slots.push(new Vector3(x, RAIL_TOP_Y, (rnd() - 0.5) * 0.03));
  }
  const markers = new Group();
  markers.name = 'bottleSlotMarkers';
  const ring = new RingGeometry(0.026, 0.034, 32).rotateX(-Math.PI / 2);
  const rmat = new MeshBasicMaterial({ color: 0xff3020, depthWrite: false, toneMapped: false });
  for (const s of slots) {
    const m = new Mesh(ring, rmat);
    m.position.copy(s).setY(s.y + 0.002);
    markers.add(m);
  }
  group.add(markers);

  /** Post base positions, for ground contact darkening. */
  const postBases = geos.slice(0, POST_COUNT).map((g) => {
    g.computeBoundingBox();
    const c = new Vector3();
    g.boundingBox!.getCenter(c);
    return c.setY(0);
  });

  return { group, slots, markers, railTopY: RAIL_TOP_Y, postBases };
}
