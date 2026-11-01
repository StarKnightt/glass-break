/** Sample-level synthesis of glass sounds into AudioBuffers (baked once, played many times). */

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Adds a decaying sinusoid (phasor recurrence, no per-sample trig) into L/R. */
function addMode(
  L: Float32Array,
  R: Float32Array,
  sr: number,
  start: number,
  freq: number,
  amp: number,
  tau: number,
  pan: number,
  attack = 0.0004,
) {
  const i0 = Math.floor(start * sr);
  const n = Math.min(L.length - i0, Math.ceil(tau * 7 * sr));
  if (n <= 0 || freq >= sr * 0.45) return;
  const w = (2 * Math.PI * freq) / sr;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const dec = Math.exp(-1 / (tau * sr));
  const att = Math.max(1, attack * sr);
  const gl = amp * Math.cos((pan + 1) * Math.PI * 0.25);
  const gr = amp * Math.sin((pan + 1) * Math.PI * 0.25);
  let x = 1;
  let y = 0;
  let e = 1;
  for (let i = 0; i < n; i++) {
    const nx = x * c - y * s;
    y = x * s + y * c;
    x = nx;
    const v = y * e * (i < att ? i / att : 1);
    L[i0 + i] += v * gl;
    R[i0 + i] += v * gr;
    e *= dec;
  }
}

function addNoiseClick(L: Float32Array, R: Float32Array, sr: number, start: number, amp: number, tau: number, pan: number) {
  const i0 = Math.floor(start * sr);
  const n = Math.min(L.length - i0, Math.ceil(tau * 6 * sr));
  const dec = Math.exp(-1 / (tau * sr));
  const gl = amp * (1 - pan) * 0.5;
  const gr = amp * (1 + pan) * 0.5;
  let e = 1;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    const v = (w - prev) * e; // first difference = crude highpass
    prev = w;
    L[i0 + i] += v * gl;
    R[i0 + i] += v * gr;
    e *= dec;
  }
}

function normalize(L: Float32Array, R: Float32Array, peak: number) {
  let m = 1e-6;
  for (let i = 0; i < L.length; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
  const k = peak / m;
  for (let i = 0; i < L.length; i++) {
    L[i] *= k;
    R[i] *= k;
  }
}

/** Pitch multiplier per bottle type: thicker whiskey glass rings lower. */
export const GLASS_PITCH: Record<string, number> = { beer: 1, soda: 1.12, whiskey: 0.74 };

/**
 * Ringing partials + dense granular shatter (~150-400 ms of clicks, dense at the start).
 * The initial crack transient and the body thump are separate node voices so slow-mo never softens them.
 */
export function bakeShatter(ctx: BaseAudioContext, pitch: number) {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(2, Math.ceil(sr * 1.1), sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  // ringing glass: inharmonic partials, each with a slightly detuned twin for beating
  const nPart = 9 + Math.floor(Math.random() * 5);
  for (let i = 0; i < nPart; i++) {
    const f = rnd(1900, 8200) * pitch;
    const tau = rnd(0.03, 0.12) + (0.22 * 3000) / f * Math.random();
    const amp = rnd(0.04, 0.12);
    const pan = rnd(-0.6, 0.6);
    const t0 = rnd(0, 0.012);
    addMode(L, R, sr, t0, f, amp, tau, pan);
    addMode(L, R, sr, t0, f * rnd(1.002, 1.007), amp * 0.6, tau * 0.8, -pan);
  }
  // granular burst: many tiny pitched clicks, density falling off over ~0.4 s
  const span = rnd(0.22, 0.42);
  const nGrain = 110 + Math.floor(Math.random() * 60);
  for (let i = 0; i < nGrain; i++) {
    const u = Math.random();
    const t = 0.003 + span * Math.pow(u, 2.6);
    const fall = 1 - (t / (span + 0.05)) * 0.8;
    const pan = rnd(-0.9, 0.9);
    if (Math.random() < 0.3) addNoiseClick(L, R, sr, t, rnd(0.05, 0.22) * fall, rnd(0.0006, 0.002), pan);
    else addMode(L, R, sr, t, rnd(2600, 11500) * pitch, rnd(0.03, 0.16) * fall, rnd(0.003, 0.022), pan, 0.0002);
  }
  // a few late, sparser bits (pieces still breaking apart)
  for (let i = 0; i < 14; i++) {
    const t = span + rnd(0, 0.3);
    addMode(L, R, sr, t, rnd(3000, 9000) * pitch, rnd(0.015, 0.05), rnd(0.008, 0.04), rnd(-0.9, 0.9));
  }
  normalize(L, R, 0.6);
  const fade = Math.floor(sr * 0.015);
  for (let i = 0; i < fade; i++) {
    L[i] *= i / fade;
    R[i] *= i / fade;
  }
  return buf;
}

/** One small shard ping: bar-like inharmonic modes (1, 2.76, 5.40) + click. */
export function bakeTinkle(ctx: BaseAudioContext, tauK = 1) {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(sr * 0.35), sr);
  const L = buf.getChannelData(0);
  const R = new Float32Array(L.length);
  const f = rnd(2800, 6000);
  const tau = rnd(0.025, 0.09) * tauK;
  const ratios = [1, rnd(2.6, 2.9), rnd(5.1, 5.6)];
  ratios.forEach((r, i) => addMode(L, R, sr, 0.001, f * r, [0.5, 0.3, 0.16][i], tau / (1 + i * 0.8), -1, 0.0002));
  if (Math.random() < 0.5) addMode(L, R, sr, rnd(0.01, 0.05), f * rnd(1.1, 1.5), 0.25, tau * 0.6, -1, 0.0002); // bounce
  addNoiseClick(L, R, sr, 0, 0.3, 0.0008, -1);
  normalize(L, R, 0.9);
  return buf;
}

/** Outdoor backyard IR: a few early ground/fence reflections and a short (~0.6 s) diffuse tail. */
export function bakeYardIR(ctx: BaseAudioContext) {
  const sr = ctx.sampleRate;
  const len = Math.ceil(sr * 0.65);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      lp += (Math.random() * 2 - 1 - lp) * (0.55 - 0.4 * (t / 0.65)); // darker as it decays
      d[i] = lp * Math.exp(-t / 0.13) * (t < 0.008 ? t / 0.008 : 1) * 0.5;
    }
    for (const [t, a] of [[0.011, 0.5], [0.023, 0.32], [0.041, 0.22], [0.067, 0.14]] as const) {
      d[Math.floor((t + (ch ? 0.0017 : 0)) * sr)] += a * (ch ? 0.9 : 1);
    }
  }
  return buf;
}

export function bakeNoise(ctx: BaseAudioContext, seconds: number) {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** 16-bit PCM WAV, base64 (dev verification only). */
export function wavBase64(buf: AudioBuffer) {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const bytes = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => bytes.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  bytes.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVEfmt ');
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, ch, true);
  bytes.setUint32(24, buf.sampleRate, true);
  bytes.setUint32(28, buf.sampleRate * ch * 2, true);
  bytes.setUint16(32, ch * 2, true);
  bytes.setUint16(34, 16, true);
  str(36, 'data');
  bytes.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      bytes.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 32767, true);
      o += 2;
    }
  }
  const u8 = new Uint8Array(bytes.buffer);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
