export interface ProfileTable {
  type: string;
  height: number;
  floorY: number;
  neckY: number;
  R0: number;
  step: number;
  outer: Float32Array;
  inner: Float32Array;
  square?: [number, number];
}

/** Label band: [y0, y1, theta0, thetaLen] in bottle-local space. */
export type LabelBand = [number, number, number, number];

export interface FractureJob {
  id: number;
  type: string;
  theta: number;
  y: number;
  /** Bullet direction in bottle-local space. */
  dir: [number, number, number];
  fill: number;
  seed: number;
  labels: LabelBand[];
}

export interface FractureResult {
  id: number;
  pieces: number;
  pos: Float32Array;
  nrm: Float32Array;
  sid: Float32Array;
  edge: Float32Array;
  luv: Float32Array;
  index: Uint32Array;
  /** Per piece (32 floats): centroid xyz, radius, area, flags (1 neck, 2 base), indexStart, indexCount, 8 sample points. */
  meta: Float32Array;
  crack: Float32Array;
  crackD: Float32Array;
  ms?: number;
  key?: string;
}

export const META = 32;
