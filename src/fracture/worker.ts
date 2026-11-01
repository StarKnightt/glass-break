/// <reference lib="webworker" />
import { Delaunay } from 'd3-delaunay';
import type { FractureJob, FractureResult, ProfileTable } from './types';

const profs = new Map<string, ProfileTable>();

function squareK(theta: number) {
  const n = 10;
  const c = Math.abs(Math.cos(theta)), s = Math.abs(Math.sin(theta));
  return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n);
}
function squareBlend(sq: [number, number] | undefined, y: number) {
  if (!sq) return 0;
  const c = Math.min(1, Math.max(0, (y - sq[0]) / (sq[1] - sq[0])));
  return 1 - c * c * (3 - 2 * c);
}
function lut(t: Float32Array, step: number, y: number) {
  const f = Math.min(t.length - 1.001, Math.max(0, y / step));
  const i = Math.floor(f);
  return t[i] + (t[i + 1] - t[i]) * (f - i);
}
function mulberry(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fracture(job: FractureJob): FractureResult {
  const pr = profs.get(job.type)!;
  const rng = mulberry(job.seed);
  const R0 = pr.R0;
  const P = Math.PI * R0;
  const H = pr.height;
  const W = 2 * P;
  const wrapU = (u: number) => ((((u + P) % W) + W) % W) - P;
  const surfDist = (u0: number, y0: number, u1: number, y1: number) => Math.hypot(wrapU(u1 - u0), y1 - y0);

  const rOut = (th: number, y: number) => {
    const b = squareBlend(pr.square, y);
    return lut(pr.outer, pr.step, y) * (b > 0 ? 1 + (squareK(th) - 1) * b : 1);
  };
  const rIn = (th: number, y: number) => {
    const yy = Math.max(y, pr.floorY);
    const b = squareBlend(pr.square, yy);
    return lut(pr.inner, pr.step, yy) * (b > 0 ? 1 + (squareK(th) - 1) * b : 1);
  };
  const surf = (u: number, y: number, inner: boolean, out: number[]) => {
    const th = u / R0;
    const r = inner ? rIn(th, y) : rOut(th, y);
    out.push(r * Math.sin(th), inner ? Math.max(y, pr.floorY) : y, r * Math.cos(th));
  };

  const uh = wrapU(job.theta * R0);
  const yh = job.y;

  // Neck / base survival
  let neckCut = pr.neckY + (rng() - 0.5) * 0.01;
  let hasNeck = true;
  if (yh > neckCut - 0.015) {
    neckCut = yh + 0.035;
    if (neckCut > H - 0.03) hasNeck = false;
  }
  let baseCut = pr.floorY + 0.006 + rng() * 0.004;
  let hasBase = true;
  if (yh < baseCut + 0.015) {
    baseCut = yh - 0.02;
    if (baseCut < 0.008) hasBase = false;
  }
  const yLo = hasBase ? baseCut : 0;
  const yHi = hasNeck ? neckCut : H;

  // Exit point along the bullet direction through the shell
  const th0 = job.theta;
  const r0 = rOut(th0, yh);
  const px = r0 * Math.sin(th0), pz = r0 * Math.cos(th0);
  const [dx, dy, dz] = job.dir;
  const a = dx * dx + dz * dz;
  let ue = NaN, ye = NaN;
  if (a > 1e-6) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - R0 * R0;
    const t = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
    if (t > 0.01) {
      const ex = px + dx * t, ez = pz + dz * t;
      ue = wrapU(Math.atan2(ex, ez) * R0);
      ye = yh + dy * t;
      if (ye < yLo + 0.01 || ye > yHi - 0.01) ue = NaN;
    }
  }

  const seeds: number[] = [];
  const inBody = (y: number) => y > yLo + 0.002 && y < yHi - 0.002;
  const push = (u: number, y: number) => {
    if (inBody(y)) seeds.push(wrapU(u), y);
  };
  const inLabel = (u: number, y: number) => {
    for (const L of job.labels) {
      if (y < L[0] || y > L[1]) continue;
      const th = u / R0;
      const rel = (((th - L[2]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (rel <= L[3]) return true;
    }
    return false;
  };
  const power = 1 + job.fill * 0.6;

  // crush zone
  for (let i = 0; i < 6; i++) {
    const ang = rng() * Math.PI * 2, rr = 0.0012 + rng() * 0.003;
    push(uh + Math.cos(ang) * rr, yh + Math.sin(ang) * rr);
  }
  // radial rays + concentric rings
  const rays = (cu: number, cy: number, n: number, r0: number, rMax: number, grow: number, keep: number) => {
    for (let k = 0; k < n; k++) {
      const al = ((k + (rng() - 0.5) * 0.5) / n) * Math.PI * 2;
      let r = r0 * (0.8 + rng() * 0.5);
      while (r < rMax) {
        const aa = al + (rng() - 0.5) * 0.12;
        push(cu + Math.cos(aa) * r, cy + Math.sin(aa) * r);
        r *= grow + rng() * 0.35;
        if (r > 0.03 && rng() > keep) break;
      }
    }
  };
  rays(uh, yh, 11 + Math.floor(rng() * 4), 0.006, 0.12 * power, 1.6, 0.55);
  if (!isNaN(ue)) rays(ue, ye, 6 + Math.floor(rng() * 3), 0.007, 0.07 * power, 1.75, 0.5);
  // sparse far seeds; labels hold glass together
  for (let i = 0, tries = 0; i < 14 && tries < 200; tries++) {
    const u = (rng() * 2 - 1) * P, y = yLo + rng() * (yHi - yLo);
    if (surfDist(u, y, uh, yh) < 0.035) continue;
    if (!isNaN(ue) && surfDist(u, y, ue, ye) < 0.025) continue;
    if (inLabel(u, y) && rng() < 0.65) continue;
    push(u, y);
    i++;
  }
  const nBody = seeds.length / 2;
  // neck / base zone seeds (merged later)
  const zone: number[] = [];
  if (hasNeck) for (let i = 0; i < 6; i++) zone.push(((i + rng() * 0.7) / 6) * W - P, neckCut + rng() * 0.012);
  else for (let i = 0; i < 3; i++) zone.push(((i + rng()) / 3) * W - P, H - 0.01 - rng() * 0.015);
  if (hasBase) for (let i = 0; i < 6; i++) zone.push(((i + rng() * 0.7) / 6) * W - P, baseCut - rng() * 0.008);
  seeds.push(...zone);
  const N = seeds.length / 2;

  const pts = new Float64Array(N * 6);
  for (let i = 0; i < N; i++) {
    for (let g = 0; g < 3; g++) {
      pts[(g * N + i) * 2] = seeds[i * 2] + (g - 1) * W;
      pts[(g * N + i) * 2 + 1] = seeds[i * 2 + 1];
    }
  }
  // real seeds are the middle copy
  const del = new Delaunay(pts);
  const vor = del.voronoi([-P, 0, P, H]);
  const seedOf = (cell: number) => cell % N;

  // union-find pieces
  const par = new Int32Array(N);
  for (let i = 0; i < N; i++) par[i] = i;
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  const unite = (i: number, j: number) => {
    i = find(i);
    j = find(j);
    if (i !== j) par[j] = i;
  };
  let neckSeed = -1, baseSeed = -1;
  for (let i = nBody; i < N; i++) {
    const y = seeds[i * 2 + 1];
    if (hasNeck && y >= neckCut - 1e-4) {
      if (neckSeed < 0) neckSeed = i;
      else unite(neckSeed, i);
    } else if (hasBase && y <= baseCut + 1e-4) {
      if (baseSeed < 0) baseSeed = i;
      else unite(baseSeed, i);
    }
  }
  for (let i = 0; i < nBody; i++) {
    const u = seeds[i * 2], y = seeds[i * 2 + 1];
    if (!inLabel(u, y) || surfDist(u, y, uh, yh) < 0.04) continue;
    for (const jc of vor.neighbors(N + i)) {
      const j = seedOf(jc);
      if (j >= nBody || j === i) continue;
      const u2 = seeds[j * 2], y2 = seeds[j * 2 + 1];
      if (inLabel(u2, y2) && surfDist(u2, y2, uh, yh) > 0.04 && rng() < 0.45) unite(i, j);
    }
  }
  // compact piece ids, order: neck, base first so they're easy to find
  const pid = new Int32Array(N).fill(-1);
  let np = 0;
  const order: number[] = [];
  if (neckSeed >= 0) order.push(find(neckSeed));
  if (baseSeed >= 0) order.push(find(baseSeed));
  for (let i = 0; i < N; i++) order.push(find(i));
  for (const r of order) if (pid[r] < 0) pid[r] = np++;
  const pieceOfSeed = (s: number) => pid[find(s)];

  // collect polygons per piece
  const polys: number[][][] = Array.from({ length: np }, () => []);
  const polyCell: number[][] = Array.from({ length: np }, () => []);
  for (let c = 0; c < 3 * N; c++) {
    const poly = vor.cellPolygon(c);
    if (!poly || poly.length < 4) continue;
    const p = pieceOfSeed(seedOf(c));
    polys[p].push(poly.slice(0, -1).flat());
    polyCell[p].push(c);
  }

  const pos: number[] = [], nrm: number[] = [], sid: number[] = [], edge: number[] = [], luv: number[] = [];
  const idx: number[] = [];
  const meta: number[] = [];
  const crack: number[] = [];
  const crackD: number[] = [];
  const tmp: number[] = [];
  const STEP = 0.0055;
  let prevC: number[] | null = null;

  const labelUV = (u: number, y: number) => {
    const out = [-1, -1, -1, -1];
    const th = u / R0;
    job.labels.forEach((L, k) => {
      if (k > 1) return;
      let rel = (((th - L[2]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (rel > L[3] + (2 * Math.PI - L[3]) / 2) rel -= 2 * Math.PI;
      out[k * 2] = rel / L[3];
      out[k * 2 + 1] = (y - L[0]) / (L[1] - L[0]);
    });
    return out;
  };
  const surfNormal = (u: number, y: number, inner: boolean) => {
    const e = 0.0004;
    tmp.length = 0;
    surf(u - e, y, inner, tmp);
    surf(u + e, y, inner, tmp);
    surf(u, y - e, inner, tmp);
    surf(u, y + e, inner, tmp);
    const tx = tmp[3] - tmp[0], ty = tmp[4] - tmp[1], tz = tmp[5] - tmp[2];
    const bx = tmp[9] - tmp[6], by = tmp[10] - tmp[7], bz = tmp[11] - tmp[8];
    // ∂u × ∂y points outward for this parametrization
    let nx = ty * bz - tz * by, ny = tz * bx - tx * bz, nz = tx * by - ty * bx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return inner ? [0, 1, 0] : [Math.sin(u / R0), 0, Math.cos(u / R0)];
    nx /= l; ny /= l; nz /= l;
    if (nx * Math.sin(u / R0) + nz * Math.cos(u / R0) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    return inner ? [-nx, -ny, -nz] : [nx, ny, nz];
  };
  let vBase = 0;
  const addV = (x: number, y: number, z: number, n: number[], s: number, e: number, uv: number[]) => {
    pos.push(x, y, z);
    nrm.push(n[0], n[1], n[2]);
    sid.push(s);
    edge.push(e);
    luv.push(uv[0], uv[1], uv[2], uv[3]);
    return vBase++;
  };
  const NOUV = [-1, -1, -1, -1];
  const tri = (a: number, b: number, c: number, rx: number, ry: number, rz: number) => {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * rx + fy * ry + fz * rz >= 0) idx.push(a, b, c);
    else idx.push(a, c, b);
  };

  for (let p = 0; p < np; p++) {
    const v0 = vBase, i0 = idx.length;
    let area = 0;
    const isNeck = neckSeed >= 0 && p === pieceOfSeed(neckSeed);
    const isBase = baseSeed >= 0 && p === pieceOfSeed(baseSeed);
    polys[p].forEach((poly, k) => {
      const cell = polyCell[p][k];
      const n = poly.length / 2;
      let cu = 0, cy = 0;
      for (let i = 0; i < n; i++) { cu += poly[i * 2]; cy += poly[i * 2 + 1]; }
      cu /= n; cy /= n;
      let maxL = 0;
      for (let i = 0; i < n; i++) maxL = Math.max(maxL, Math.hypot(poly[i * 2] - cu, poly[i * 2 + 1] - cy));
      const lv = Math.min(8, Math.max(1, Math.ceil(maxL / STEP)));
      for (const inner of [false, true]) {
        for (let i = 0; i < n; i++) {
          const au = poly[i * 2], ay = poly[i * 2 + 1];
          const bu = poly[((i + 1) % n) * 2], by = poly[((i + 1) % n) * 2 + 1];
          if (!inner) area += Math.abs((au - cu) * (by - cy) - (bu - cu) * (ay - cy)) / 2;
          const grid: number[][] = [];
          for (let s = 0; s <= lv; s++) {
            const row: number[] = [];
            for (let t = 0; t <= lv - s; t++) {
              const u = cu + ((au - cu) * s) / lv + ((bu - cu) * t) / lv;
              const y = cy + ((ay - cy) * s) / lv + ((by - cy) * t) / lv;
              tmp.length = 0;
              surf(u, y, inner, tmp);
              const nn = surfNormal(u, y, inner);
              const [x0, y0, z0] = [tmp[0], tmp[1], tmp[2]];
              row.push(addV(x0, y0, z0, nn, p, inner ? 0.5 : 0, inner ? NOUV : labelUV(u, y)));
            }
            grid.push(row);
          }
          for (let s = 0; s < lv; s++) {
            for (let t = 0; t < lv - s; t++) {
              const A = grid[s][t], B = grid[s + 1][t], C = grid[s][t + 1];
              const r = nrm.slice(A * 3, A * 3 + 3);
              tri(A, B, C, r[0], r[1], r[2]);
              if (t < lv - s - 1) tri(B, grid[s + 1][t + 1], C, r[0], r[1], r[2]);
            }
          }
        }
      }
      // side walls, rim
      for (let i = 0; i < n; i++) {
        const au = poly[i * 2], ay = poly[i * 2 + 1];
        const bu = poly[((i + 1) % n) * 2], by = poly[((i + 1) % n) * 2 + 1];
        const mu = (au + bu) / 2, my = (ay + by) / 2;
        let other = -2;
        const eps = 1e-7;
        if (my < eps * 10 && Math.abs(ay - by) < 1e-6) other = -3; // bottom
        else if (my > H - 1e-6 && Math.abs(ay - by) < 1e-6) other = -1; // top rim
        else {
          let ex = -(by - ay), ey = bu - au;
          const el = Math.hypot(ex, ey) || 1;
          ex /= el; ey /= el;
          if ((mu - cu) * ex + (my - cy) * ey < 0) { ex = -ex; ey = -ey; }
          let qx = mu + ex * 2e-5;
          const qy = my + ey * 2e-5;
          if (qx > P) qx -= W;
          if (qx < -P) qx += W;
          const j = del.find(qx + 0, qy, cell);
          other = pieceOfSeed(seedOf(j));
          if (other === p) continue;
        }
        if (other === -3) continue;
        const len = Math.hypot(bu - au, by - ay);
        const m = Math.max(1, Math.ceil(len / STEP));
        tmp.length = 0;
        surf(mu, my, false, tmp);
        surf(cu, cy, false, tmp);
        const ox = tmp[0] - tmp[3], oy = tmp[1] - tmp[4], oz = tmp[2] - tmp[5];
        const ring: number[][] = [];
        for (let s = 0; s <= m; s++) {
          const u = au + ((bu - au) * s) / m, y = ay + ((by - ay) * s) / m;
          tmp.length = 0;
          surf(u, y, false, tmp);
          surf(u, y, true, tmp);
          const l = Math.hypot(ox, oy, oz);
          const on = l > 1e-9 ? [ox / l, oy / l, oz / l] : surfNormal(u, y, false);
          ring.push([addV(tmp[0], tmp[1], tmp[2], on, p, 1, NOUV), addV(tmp[3], tmp[4], tmp[5], on, p, 1, NOUV)]);
          if (other >= 0 && p < other) {
            const sn = surfNormal(u, y, false);
            const d1 = surfDist(u, y, uh, yh);
            const cur = [tmp[0] + sn[0] * 0.0004, tmp[1] + sn[1] * 0.0004, tmp[2] + sn[2] * 0.0004, isNaN(ue) ? d1 : Math.min(d1, surfDist(u, y, ue, ye) + 0.01)];
            if (prevC) {
              crack.push(prevC[0], prevC[1], prevC[2], cur[0], cur[1], cur[2]);
              crackD.push(prevC[3], cur[3]);
            }
            prevC = cur;
          }
        }
        prevC = null;
        for (let s = 0; s < m; s++) {
          const [a0, a1] = ring[s], [b0, b1] = ring[s + 1];
          tri(a0, b0, b1, ox, oy, oz);
          tri(a0, b1, a1, ox, oy, oz);
        }
      }
    });
    if (isBase) {
      // outer floor and inner floor discs
      for (const [y, inner] of [[0.0015, false], [pr.floorY, true]] as [number, boolean][]) {
        const segs = 36;
        const c = addV(0, y + (inner ? 0.0015 : 0.003), 0, [0, inner ? 1 : -1, 0], p, inner ? 0.5 : 0, NOUV);
        const ringI: number[] = [];
        for (let s = 0; s < segs; s++) {
          const th = (s / segs) * Math.PI * 2;
          const r = inner ? rIn(th, y) : rOut(th, 0.0045) * 0.97;
          ringI.push(addV(r * Math.sin(th), y, r * Math.cos(th), [0, inner ? 1 : -1, 0], p, inner ? 0.5 : 0, NOUV));
        }
        for (let s = 0; s < segs; s++) tri(c, ringI[s], ringI[(s + 1) % segs], 0, inner ? 1 : -1, 0);
      }
    }
    // centroid, recenter
    const vn = vBase - v0;
    if (vn === 0) {
      meta.push(0, 0, 0, 0, 0, 0, i0, 0, ...new Array(24).fill(0));
      continue;
    }
    let mx = 0, my = 0, mz = 0;
    for (let v = v0; v < vBase; v++) { mx += pos[v * 3]; my += pos[v * 3 + 1]; mz += pos[v * 3 + 2]; }
    mx /= vn; my /= vn; mz /= vn;
    let rad = 0;
    for (let v = v0; v < vBase; v++) {
      pos[v * 3] -= mx; pos[v * 3 + 1] -= my; pos[v * 3 + 2] -= mz;
      rad = Math.max(rad, Math.hypot(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
    }
    const samples: number[] = [];
    for (let k = 0; k < 8; k++) {
      const sx = k & 1 ? 1 : -1, sy = k & 2 ? 1 : -1, sz = k & 4 ? 1 : -1;
      let best = -1e9, bi = v0;
      for (let v = v0; v < vBase; v++) {
        const d = pos[v * 3] * sx + pos[v * 3 + 1] * sy + pos[v * 3 + 2] * sz;
        if (d > best) { best = d; bi = v; }
      }
      samples.push(pos[bi * 3], pos[bi * 3 + 1], pos[bi * 3 + 2]);
    }
    const flags = (isNeck ? 1 : 0) | (isBase ? 2 : 0);
    meta.push(mx, my, mz, rad, area, flags, i0, idx.length - i0, ...samples);
  }

  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) pos[i] = 0;
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]);
    if (!Number.isFinite(l) || l < 1e-6) { nrm[i] = 0; nrm[i + 1] = 1; nrm[i + 2] = 0; }
  }
  for (let i = 0; i < luv.length; i++) if (!Number.isFinite(luv[i])) luv[i] = -1;
  for (let i = 0; i < meta.length; i++) if (!Number.isFinite(meta[i])) meta[i] = 0;
  for (let i = 0; i < crack.length; i++) if (!Number.isFinite(crack[i])) crack[i] = 0;
  for (let i = 0; i < crackD.length; i++) if (!Number.isFinite(crackD[i])) crackD[i] = 1;
  return {
    id: job.id,
    pieces: np,
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    sid: new Float32Array(sid),
    edge: new Float32Array(edge),
    luv: new Float32Array(luv),
    index: new Uint32Array(idx),
    meta: new Float32Array(meta),
    crack: new Float32Array(crack),
    crackD: new Float32Array(crackD),
  };
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.kind === 'init') {
    for (const p of m.profiles as ProfileTable[]) profs.set(p.type, p);
    return;
  }
  const t0 = performance.now();
  const r = fracture(m.job as FractureJob);
  r.ms = performance.now() - t0;
  (self as unknown as Worker).postMessage(r, [r.pos.buffer, r.nrm.buffer, r.sid.buffer, r.edge.buffer, r.luv.buffer, r.index.buffer, r.meta.buffer, r.crack.buffer, r.crackD.buffer]);
};
