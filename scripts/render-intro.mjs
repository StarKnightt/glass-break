// Offline frame-by-frame render of the cinematic intro -> glass-intro.mp4
// Usage: node scripts/render-intro.mjs   (dev server must be running on :5173)
// Env: URL, CHROME, MAX_FRAMES, ONLY_FRAMES=1 (skip encode), STILLS="i,j,..." (copy frames to shots/cinematic)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  ({ chromium } = require('C:/tmp/shot/node_modules/playwright-core'));
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const outDir = path.join(root, '.render');
const framesDir = path.join(outDir, 'frames');
const url = process.env.URL || 'http://127.0.0.1:5173/?cinematic&render=1&perf=fixed';
const maxFrames = +(process.env.MAX_FRAMES || 900);
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || 'D:/DevCache/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__cine && window.fracture, null, { timeout: 120000 });
await page.waitForTimeout(4000); // fracture patterns are baked in a worker
await page.evaluate(() => window.__cine.warm(30));
await page.evaluate(() => window.__cine.start());

const t0 = Date.now();
let n = 0;
for (; n < maxFrames; n++) {
  const url = await page.evaluate(() => window.__cine.renderFrame());
  fs.writeFileSync(path.join(framesDir, `f${String(n).padStart(4, '0')}.png`), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  if (n % 60 === 0) console.log(`frame ${n}  t=${(await page.evaluate(() => window.__cine.time)).toFixed(2)}s  ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`);
  if (await page.evaluate(() => window.__cine.done)) {
    n++;
    break;
  }
}
const duration = n / 60;
const events = await page.evaluate(() => window.__cine.events);
console.log(`${n} frames (${duration.toFixed(3)} s); shot ${events.shot.toFixed(2)} impact ${events.impact.toFixed(2)} shards ${events.shards.length} drips ${events.drips.length}`);
const audio = await page.evaluate((d) => window.__cine.renderAudio(d), duration);
fs.writeFileSync(path.join(outDir, 'intro.wav'), Buffer.from(audio.wav, 'base64'));
fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify({ ...events, frames: n }, null, 1));
console.log(`audio: peak before norm ${audio.peakBefore.toFixed(3)}, gain ${audio.gain.toFixed(3)}`);
const errs = await page.evaluate(() => window.__errs || []);
if (errs.length) console.log('page errors:', errs.slice(0, 10));
await browser.close();

if (process.env.ONLY_FRAMES) process.exit(0);
const mp4 = path.join(root, 'glass-intro.mp4');
const r = spawnSync(
  'ffmpeg',
  ['-y', '-hide_banner', '-loglevel', 'warning', '-framerate', '60', '-i', path.join(framesDir, 'f%04d.png'), '-i', path.join(outDir, 'intro.wav'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', process.env.CRF || '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-threads', '4', '-r', '60',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-shortest', '-movflags', '+faststart', mp4],
  { stdio: 'inherit' },
);
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('wrote', mp4, (fs.statSync(mp4).size / 1e6).toFixed(1), 'MB');
