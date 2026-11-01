# Glass Break

![Glass Break](og-image.png)

Golden-hour backyard, a row of glass bottles on the fence — shoot them and watch the shatter drop into slow motion.

The in-game cinematic is **C** or `?cinematic`. A recorded pass is in `glass-intro.mp4` (not embedded here).

## Features

- **Realistic glass** — refraction, fresnel, thickness, labels, beer / whiskey / soda tints
- **Voronoi shatter** — each hit is its own shard set, plus needles and powder
- **Liquid splash** — filled bottles dump a particle burst on break
- **Slow-mo punch-in** — bullet time plus a camera push toward the hit
- **Synthesized Web Audio** — gunshot, shatter, tinkles, splash; no audio files
- **Cinematic intro** — `C` or `?cinematic`

## Controls

| Input | Action |
| --- | --- |
| Click | Start |
| Mouse | Aim |
| LMB | Shoot |
| RMB | Zoom |
| `R` | Reset bottles |
| `C` | Play cinematic |
| `Esc` | Pause |

## Quick start

```bash
pnpm install
pnpm dev
```

Open http://127.0.0.1:5173/. Production build: `pnpm build`.

## Tech

Vite · three.js · TypeScript · Web Audio · pnpm

## A 30-second clip

1. Hold the untouched fence for 2–3 seconds.
2. Break the filled whiskey (3rd from left) mid-body for the amber splash.
3. Break the left soda and beer almost together. One miss into the fence early.
4. RMB-zoom the rest ~1.5 s apart — filled beer (2nd from right) and filled soda (middle) for liquid.
5. End on a neck shot of the far-right soda.

## License

[MIT](LICENSE)
