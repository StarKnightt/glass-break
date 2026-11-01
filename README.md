# Glass Break

A first-person glass-bottle shooting game in the browser, built in three.js. An old wooden fence
sits in a dry backyard at golden hour. A row of beer, soda and whiskey bottles stands on the rail,
some of them half full. The sun is low and warm, the shadows are long, and dust hangs in the air.
Click to start, aim, and shoot: the bottle that takes the hit cracks from the impact, drops into
slow motion, and comes apart into shards that catch the sun and bounce on the ground. If it was
filled, the liquid dumps out with it. There is a score and a reset; that is all the game keeps.

![The backyard at golden hour, bottles on the fence, under the game's title](og-image.png)

**Play it: https://starknightt.github.io/glass-break/**

It wants a desktop GPU, a keyboard and a mouse; Chrome or Edge is recommended. Click the scene
once to start and lock the pointer. Sound starts on that same click.

## Running it locally

```
git clone https://github.com/StarKnightt/glass-break.git
cd glass-break
pnpm install
pnpm dev        # http://127.0.0.1:5173/
pnpm build      # type-check, then a production build into dist/
```

The runtime dependencies are `three` (0.187), `postprocessing` and `d3-delaunay`. The game is
TypeScript built with Vite, and the production build uses the base `/glass-break/` for GitHub
Pages. Every push to `main` builds the site and deploys it through `.github/workflows/deploy.yml`.

## Controls

| Input | Action |
|---|---|
| Click | Start; locks the pointer and starts the sound |
| Mouse | Aim |
| Left button | Shoot |
| Right button | Zoom |
| `R` | Reset the bottles and the score |
| `C` | Play the cinematic |
| `Esc` | Pause (releases the pointer; click to resume) |

| URL option | Effect |
|---|---|
| `cinematic` | Starts the cinematic after load |
| `debug` | FPS, frame time and draw-call readout |

## What is in it

- **The backyard.** A weathered wooden fence at golden hour, dry ground, grass, hanging dust, and
  a low sun that throws long shadows across the rail.
- **Eight bottles.** Green beer, clear soda and brown whiskey, some empty and some half full, each
  with its own silhouette, tint, cap and a painted-on label.
- **Glass.** Transmission, refraction, fresnel, thickness and coloured absorption, so a filled
  bottle tints whatever you see through it.
- **Shatter.** A hit cracks from the impact, then bursts into shards, needles and powder that
  spin, catch the sun, hit the rail and the ground and bounce.
- **Liquid.** A filled bottle dumps a splash: drops, foam and a short hold of the bottle's shape
  before it breaks apart.
- **Slow motion.** The break drops into bullet time with a camera punch toward the hit.
- **Sound.** Gunshot, crack, tinkles and splash, all synthesized with the Web Audio API. No
  audio files.
- **A cinematic.** `C`, or `?cinematic`, plays a scripted pass along the fence.

## How it works

### Glass

Each bottle is a lathed profile with a `MeshPhysicalMaterial` set to full transmission (IOR 1.52).
A custom absorption path treats two walls at grazing incidence, a thick base, and the liquid
column as one tint, so the refracted backyard goes green, amber or brown with the glass and
whatever is in it. Labels are drawn on a canvas at load and wrapped on the body; caustics and a
contact shadow sit under each bottle on the rail.

### Shatter

A web worker fractures the hit bottle with a Voronoi diagram (`d3-delaunay`). The main thread
swaps the intact mesh for shards, glitter and crack lines, then integrates them with gravity
against the rail and the ground. Filled bottles also fire the liquid system at the same moment.

### Slow motion and the shot

A hitscan from the view, with recoil and a hold-to-zoom. On a break the game clock drops (about
0.2× on the first hit), the camera eases toward the bottle, and the post chain (bloom, AgX, a
warm grade, vignette) stays on the shatter. Later hits in a short window get a shorter hold so
a string of bottles does not stall the scene.

### Sound

Nothing is recorded. Oscillators and noise buffers build the gunshot, a shatter that changes
with the glass type, shard tinkles placed in stereo, and the splash. A low-pass follows the
slow-motion amount so the break sounds as heavy as it looks.

## Project structure

```
src/
  main.ts         boot, the loop, cinematic keys
  core/           world clock, debug overlay
  scene/          backyard, fence, ground, grass, dust, camera, HDRI sun
  bottles/        profiles, glass, labels, caustics
  shooting/       aim, fire, impacts, tracer
  fracture/       Voronoi worker, shard physics
  liquid/         splash particles
  fx/             post chain, slow motion
  audio/          Web Audio synth
  cinematic/      the scripted intro pass
  ui/             HUD
```

## Limitations

- **Browsers.** Built for Chromium (Chrome, Edge) on a desktop. Firefox and Safari are untested.
- **No touch.** It needs a mouse for aim, shoot and zoom. It will not play on a phone.

## Licence

MIT. See [LICENSE](LICENSE).

`og-image.png` is the GitHub social preview: a render of the backyard with the title on the
left-hand field.
