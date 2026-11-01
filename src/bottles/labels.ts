import { CanvasTexture, SRGBColorSpace, type WebGLRenderer } from 'three';
import type { BottleType } from './profiles';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Aged paper base: warm off-white, mottling, stains, darkened/abraded edges. */
function paper(ctx: CanvasRenderingContext2D, w: number, h: number, base: string, seed: number) {
  const r = rng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) {
    const a = r() * 0.06;
    ctx.fillStyle = r() < 0.5 ? `rgba(90,60,20,${a})` : `rgba(255,250,235,${a})`;
    const s = 1 + r() * 3;
    ctx.fillRect(r() * w, r() * h, s, s);
  }
  for (let i = 0; i < 7; i++) {
    const x = r() * w, y = r() * h, rad = 20 + r() * 90;
    const g = ctx.createRadialGradient(x, y, rad * 0.6, x, y, rad);
    g.addColorStop(0, 'rgba(150,100,40,0.05)');
    g.addColorStop(0.92, 'rgba(120,75,25,0.12)');
    g.addColorStop(1, 'rgba(120,75,25,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const e = ctx.createLinearGradient(0, 0, 0, h);
  e.addColorStop(0, 'rgba(90,60,25,0.35)');
  e.addColorStop(0.06, 'rgba(90,60,25,0)');
  e.addColorStop(0.94, 'rgba(90,60,25,0)');
  e.addColorStop(1, 'rgba(90,60,25,0.4)');
  ctx.fillStyle = e;
  ctx.fillRect(0, 0, w, h);
}

function scuffs(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const r = rng(seed + 7);
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = `rgba(235,225,200,${0.15 + r() * 0.25})`;
    ctx.lineWidth = 0.5 + r() * 1.5;
    const x = r() * w, y = r() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (r() - 0.5) * 40, y + (r() - 0.5) * 8);
    ctx.stroke();
  }
}

function make(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, renderer: WebGLRenderer) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  draw(ctx);
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

/** Body label textures. u wraps around the bottle (front centered at u = 0.5), v up. */
export function createLabelTextures(renderer: WebGLRenderer) {
  const W = 1024, H = 400;
  const beer = make(W, H, (c) => {
    paper(c, W, H, '#e9dcb8', 11);
    c.fillStyle = '#7a1a14';
    c.fillRect(0, 26, W, 16);
    c.fillRect(0, H - 42, W, 16);
    c.strokeStyle = '#b08a3a';
    c.lineWidth = 4;
    c.strokeRect(150, 62, W - 300, H - 124);
    c.fillStyle = '#1d2a1c';
    c.textAlign = 'center';
    c.font = 'italic 700 120px Georgia, serif';
    c.fillText('Kestrel', W / 2, 200);
    c.font = '700 54px Georgia, serif';
    c.fillStyle = '#7a1a14';
    c.fillText('PALE LAGER', W / 2, 272);
    c.font = '26px Georgia, serif';
    c.fillStyle = '#3a2e1c';
    c.fillText('BREWED IN DRY CREEK SINCE 1911', W / 2, 318);
    scuffs(c, W, H, 11);
  }, renderer);
  const beerNeck = make(512, 128, (c) => {
    paper(c, 512, 128, '#7a1a14', 3);
    c.fillStyle = '#e9cf8a';
    c.textAlign = 'center';
    c.font = '700 54px Georgia, serif';
    c.fillText('KESTREL', 256, 84);
  }, renderer);
  const soda = make(W, H, (c) => {
    paper(c, W, H, '#c8352a', 21);
    c.fillStyle = '#f3e7cf';
    c.textAlign = 'center';
    for (const x of [W * 0.25, W * 0.75]) {
      c.font = 'italic 700 112px "Brush Script MT", "Segoe Script", cursive';
      c.fillText('Fizzwell', x, 210);
      c.font = '700 40px Arial, sans-serif';
      c.fillText('CHERRY COLA', x, 272);
    }
    c.fillStyle = 'rgba(243,231,207,0.9)';
    c.fillRect(0, 30, W, 8);
    c.fillRect(0, H - 38, W, 8);
    scuffs(c, W, H, 21);
  }, renderer);
  const whiskey = make(W, H * 1.3, (c) => {
    const h = H * 1.3;
    paper(c, W, h, '#efe6cf', 31);
    c.fillStyle = '#141210';
    c.fillRect(0, 0, W, h);
    paper(c, W, h, '#e8dcbc', 32);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = '#efe4c4';
    c.fillRect(0, 0, W, h);
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = '#1b1712';
    c.lineWidth = 6;
    c.strokeRect(70, 30, W - 140, h - 60);
    c.lineWidth = 2;
    c.strokeRect(86, 46, W - 172, h - 92);
    c.fillStyle = '#1b1712';
    c.textAlign = 'center';
    c.font = '600 44px Georgia, serif';
    c.fillText('OLD', W / 2, 140);
    c.font = '700 116px Georgia, serif';
    c.fillText('HOLLOW', W / 2, 250);
    c.font = 'italic 46px Georgia, serif';
    c.fillStyle = '#6a1e10';
    c.fillText('Sour Mash Whiskey', W / 2, 320);
    c.fillStyle = '#1b1712';
    c.font = '28px Georgia, serif';
    c.fillText('AGED 8 YEARS  ·  86 PROOF', W / 2, 400);
    c.fillText('No. 7', W / 2, 450);
    scuffs(c, W, h, 31);
  }, renderer);
  return { beer, beerNeck, soda, whiskey } satisfies Record<string, CanvasTexture>;
}

export type LabelSet = ReturnType<typeof createLabelTextures>;
export const LABEL_BRAND: Record<BottleType, string> = {
  beer: 'Kestrel Pale Lager',
  soda: 'Fizzwell Cherry Cola',
  whiskey: 'Old Hollow Sour Mash',
};
