import { BufferAttribute, BufferGeometry, SplineCurve, Vector2 } from 'three';

export type BottleType = 'beer' | 'soda' | 'whiskey';

/** Real-world dimensions in meters. Outer side runs from the heel up to the start of the lip finish. */
interface ProfileSpec {
  side: [number, number][];
  lip: [number, number][];
  bore: number;
  top: number;
  wall: (y: number) => number;
  floorY: number;
  puntH: number;
  /** Squared-off cross-section (whiskey): blend 1 → 0 between these heights. */
  square?: [number, number];
  /** Fill range: inner floor → shoulder start. */
  shoulderY: number;
}

const SPECS: Record<BottleType, ProfileSpec> = {
  // US 12 oz longneck: 229 mm tall, 61.5 mm body, crown finish 26.7 mm.
  beer: {
    side: [
      [0.0303, 0.006], [0.0307, 0.014], [0.0307, 0.06], [0.0307, 0.112], [0.0299, 0.127],
      [0.0258, 0.144], [0.0188, 0.161], [0.0146, 0.175], [0.013, 0.19], [0.0126, 0.205], [0.0125, 0.209],
    ],
    lip: [[0.0136, 0.2125], [0.0137, 0.2195], [0.0128, 0.2222], [0.0133, 0.2258], [0.0124, 0.229]],
    bore: 0.0088,
    top: 0.229,
    wall: (y) => (y > 0.16 ? 0.0036 : 0.0029),
    floorY: 0.012,
    puntH: 0.006,
    shoulderY: 0.12,
  },
  // Classic contour 6.5 oz glass soda: 196 mm tall, 58 mm max, pinched waist.
  soda: {
    side: [
      [0.0282, 0.006], [0.0289, 0.018], [0.029, 0.03], [0.0272, 0.046], [0.0259, 0.06], [0.0272, 0.077],
      [0.029, 0.097], [0.0287, 0.112], [0.026, 0.128], [0.021, 0.145], [0.0165, 0.16], [0.0138, 0.172], [0.0129, 0.18],
    ],
    lip: [[0.0137, 0.1835], [0.0137, 0.19], [0.0127, 0.1925], [0.0132, 0.1948], [0.0122, 0.197]],
    bore: 0.0089,
    top: 0.197,
    wall: (y) => (y > 0.15 ? 0.0034 : 0.0028),
    floorY: 0.011,
    puntH: 0.005,
    shoulderY: 0.11,
  },
  // Square-shouldered 750 ml whiskey: 80 mm square, 236 mm tall, screw finish.
  whiskey: {
    side: [
      [0.0392, 0.006], [0.04, 0.016], [0.04, 0.08], [0.04, 0.147], [0.0388, 0.157], [0.032, 0.166],
      [0.0215, 0.173], [0.016, 0.181], [0.0149, 0.195], [0.0146, 0.217],
    ],
    lip: [[0.0158, 0.2205], [0.0159, 0.2328], [0.0148, 0.236]],
    bore: 0.0094,
    top: 0.236,
    wall: (y) => (y > 0.165 ? 0.004 : 0.0034),
    floorY: 0.017,
    puntH: 0.004,
    square: [0.15, 0.172],
    shoulderY: 0.145,
  },
};

export interface BottleProfile {
  type: BottleType;
  points: Vector2[];
  /** Index splitting outer (0..split) from inner (split..end). */
  split: number;
  height: number;
  maxR: number;
  floorY: number;
  shoulderY: number;
  square?: [number, number];
  outerR(y: number): number;
  innerR(y: number): number;
}

function interpR(pts: Vector2[], y: number) {
  // pts sorted by ascending y
  if (y <= pts[0].y) return pts[0].x;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].y >= y) {
      const a = pts[i - 1], b = pts[i];
      const t = (y - a.y) / Math.max(1e-6, b.y - a.y);
      return a.x + (b.x - a.x) * t;
    }
  }
  return pts[pts.length - 1].x;
}

export function buildProfile(type: BottleType): BottleProfile {
  const s = SPECS[type];
  const r0 = s.side[0][0];
  const P = (r: number, y: number) => new Vector2(r, y);
  const ctrl: Vector2[] = [];
  // Outer base: domed punt rising to puntH at the axis, contact ring, rounded heel.
  ctrl.push(P(0.0004, s.puntH), P(r0 * 0.35, s.puntH * 0.85), P(r0 * 0.62, s.puntH * 0.35), P(r0 * 0.8, 0.0003), P(r0 * 0.9, 0.0002), P(r0 * 0.97, 0.0018));
  for (const [r, y] of s.side) ctrl.push(P(r, y));
  for (const [r, y] of s.lip) ctrl.push(P(r, y));
  const split = ctrl.length;
  // Rim: rounded top into the bore.
  ctrl.push(P(s.bore + 0.0012, s.top + 0.0002), P(s.bore + 0.0002, s.top - 0.0015), P(s.bore, s.top - 0.005));
  // Inner wall from the outer side, offset by wall thickness (thick heavy base below floorY).
  const inner = s.side
    .filter(([, y]) => y > s.floorY + 0.006 && y < s.side[s.side.length - 1][1] - 0.004)
    .map(([r, y]) => P(Math.max(s.bore, r - s.wall(y)), y))
    .reverse();
  ctrl.push(...inner);
  const rin = r0 - s.wall(0.05);
  ctrl.push(P(rin - 0.0006, s.floorY + 0.0018), P(rin - 0.004, s.floorY), P(rin * 0.5, s.floorY + s.puntH * 0.25), P(0.0004, s.floorY + s.puntH * 0.45));

  const curve = new SplineCurve(ctrl);
  const points = curve.getSpacedPoints(190).map((p) => new Vector2(Math.max(0.0003, p.x), p.y));
  // find the outer/inner split = topmost point
  let top = 0;
  for (let i = 0; i < points.length; i++) if (points[i].y > points[top].y) top = i;
  const outerPts = points.slice(0, top + 1).filter((p) => p.y > 0.004);
  const innerPts = points.slice(top).filter((p) => p.y > s.floorY + 0.002).reverse();
  const mono = (arr: Vector2[]) => {
    const out: Vector2[] = [];
    for (const p of arr) if (!out.length || p.y > out[out.length - 1].y) out.push(p);
    return out;
  };
  const oSorted = mono(outerPts);
  const iSorted = mono(innerPts);
  let maxR = 0;
  for (const p of points) maxR = Math.max(maxR, p.x);
  void split;
  return {
    type,
    points,
    split: top,
    height: s.top,
    maxR,
    floorY: s.floorY,
    shoulderY: s.shoulderY,
    square: s.square,
    outerR: (y) => interpR(oSorted, y),
    innerR: (y) => interpR(iSorted, y),
  };
}

/** Superellipse radius factor (n=5): 1 on the flats, ~1.15 at the corners. */
function squareK(theta: number) {
  const n = 10;
  const c = Math.abs(Math.cos(theta)), s = Math.abs(Math.sin(theta));
  return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n);
}

export function squareBlend(sq: [number, number] | undefined, y: number) {
  if (!sq) return 0;
  const t = (y - sq[0]) / (sq[1] - sq[0]);
  const c = Math.min(1, Math.max(0, t));
  return 1 - c * c * (3 - 2 * c);
}

/**
 * Lathe with no duplicated seam (smooth normals all round). `points` are (r, y).
 * thetaLen < 2π produces an open band with u in [0,1].
 */
export function lathe(
  points: Vector2[],
  segs: number,
  opts: { theta0?: number; thetaLen?: number; square?: [number, number]; rOffset?: number } = {},
) {
  const theta0 = opts.theta0 ?? 0;
  const thetaLen = opts.thetaLen ?? Math.PI * 2;
  const full = thetaLen >= Math.PI * 2 - 1e-6;
  const rings = full ? segs : segs + 1;
  const np = points.length;
  const pos = new Float32Array(rings * np * 3);
  const uv = new Float32Array(rings * np * 2);
  // arc length for v
  const acc = [0];
  for (let j = 1; j < np; j++) acc.push(acc[j - 1] + points[j].distanceTo(points[j - 1]));
  const total = acc[np - 1] || 1;
  for (let i = 0; i < rings; i++) {
    const u = i / segs;
    const th = theta0 + u * thetaLen;
    const sin = Math.sin(th), cos = Math.cos(th);
    for (let j = 0; j < np; j++) {
      const p = points[j];
      const b = squareBlend(opts.square, p.y);
      const k = b > 0 ? 1 + (squareK(th) - 1) * b : 1;
      const r = p.x * k + (opts.rOffset ?? 0);
      const o = (i * np + j) * 3;
      pos[o] = r * sin;
      pos[o + 1] = p.y;
      pos[o + 2] = r * cos;
      const q = (i * np + j) * 2;
      uv[q] = u;
      uv[q + 1] = acc[j] / total;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < segs; i++) {
    const i2 = full ? (i + 1) % segs : i + 1;
    for (let j = 0; j < np - 1; j++) {
      const a = i * np + j, b = i2 * np + j, c = i2 * np + j + 1, d = i * np + j + 1;
      idx.push(a, b, d, c, d, b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
