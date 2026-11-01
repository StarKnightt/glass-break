# Glass Break — Research & Technical Decisions (stage 0)

Target: 60 fps on Ryzen 5 7600X + RTX 4060 with headroom (aim ≤ 8 ms GPU, ≤ 4 ms CPU per frame).

## Stack (npm versions as of 2026-11-01)
- `three@0.187.0` with **WebGLRenderer** (the MeshPhysicalMaterial transmission path is mature there). Use `vite@8`, `typescript`, `pnpm`.
- `postprocessing@6.39.5` (pmndrs) for bloom/SMAA/vignette/CA. Don't also use three's EffectComposer.
- `d3-delaunay@6.0.4` for 2D Voronoi on the bottle's surface parameter space (the fracture core).
- `stats-gl@4.2.3` for dev-only perf HUD (hidden behind `?debug`).
- Optional/not default: `@dgreenheck/three-pinata@2.0.1` (runtime Voronoi fracture; needs watertight mesh and is O(n²) for exact mode, so it hitches if run on click); `@dimforge/rapier3d-compat@0.21.0` (2.9 MB, so only add it if the custom integrator proves insufficient).
- Env: Poly Haven **bambanani_sunset** 2k HDR (dry grass field, low sun, CC0): `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/bambanani_sunset_2k.hdr` (verified 200). Alternates: `qwantani_sunset`, `evening_field` (same URL pattern). Wood/dirt PBR: Poly Haven textures (search "planks", "weathered wood", "dry ground"/"aerial dirt") at 1k–2k.

## 1. Scene & lighting (golden hour)
- Sun: `DirectionalLight` color ≈ `#ffb070` (~3000 K), elevation 8–14°, placed behind-left of the fence (3/4 backlight), so the bottles get rim light and glow, and shadows fall long toward the camera. Intensity ~3–5 with `toneMapping = AgXToneMapping` (or ACES), exposure ~1.
- Fill: the HDRI as `scene.environment` (PMREM) with intensity ~0.6–1.0, plus a weak blue-ish `HemisphereLight`. Background: the same HDRI with `backgroundBlurriness ≈ 0.02–0.05`, or three's `GroundedSkybox` so the horizon meets the ground.
- Shadows: one 2048² PCFSoft shadow map, frustum tightly fit to fence + bottle area (~6×4 m), `normalBias` ~0.02. Only fence, bottles, and large shards cast.
- Fence: 3–4 posts and 2 rails with a flat top rail. Grey-brown sun-bleached wood with cracks, splits, nail heads and lichen spots. Textured roughness ~0.8. Slight random rotation/height per board.
- Ground: dry dirt + sparse straw-colored grass cards (instanced, ~2–4k blades, alpha-tested), pebbles. Distant backdrop: HDRI.
- Atmosphere: warm aerial haze (`FogExp2` tinted `#d9a46a`, low density). Dust motes: ~1000–1500 `Points` with soft sprites. Brightness ∝ forward-scatter phase vs sun direction (Henyey-Greenstein g≈0.7), so they sparkle only when backlit. They drift slowly with curl-ish noise.
- Fake caustics/colored light: behind each bottle on the rail top and ground, place an additive decal stretched along the sun direction. The decal is tinted by the bottle's attenuationColor, with a bright focused core plus animated wavy lines (see `refs/bottles_colored_transmitted_shadows.jpg`, `refs/bottle_caustic_in_sun.jpg`). Shadows of glass should be lighter and colored, not black. Set glass `castShadow` for a soft shadow, but render the shadow lighter: use a custom `customDepthMaterial` with dithered alpha ~0.5, plus a tinted decal.

## 2. Glass material
- `MeshPhysicalMaterial`: `transmission:1, roughness:0.03–0.06, ior:1.52, metalness:0, thickness` in world units (bottle ~0.065 m dia → thickness 0.02–0.04), `specularIntensity:1, envMapIntensity:1–1.3, dispersion:0.05–0.15` (only visible on edges), `opacity:1, transparent:false`.
- Tints (`attenuationColor` / `attenuationDistance`):
  - green beer `#1e6b2c` / 0.04–0.08
  - brown/amber whiskey/beer `#5a2a06` / 0.03–0.05
  - clear soda `#eaf6ee` / 0.6–1.0 (clear glass is slightly green at edges)
- Use a `thicknessMap`, or per-vertex thickness via `onBeforeCompile`, so silhouettes and the base/shoulder look darker and thicker. Real bottles are darkest at the edges (grazing path length) and at the thick base.
- Geometry: a `LatheGeometry` profile with **real wall thickness** (outer + inner surface, closed lip), 48–64 radial segments, smooth normals. Add a punt (domed base), lip ring and neck taper. Add slight wobble/imperfection via low-frequency normal noise (old glass is not perfect).
- Limitation: transmissive objects don't see other transmissive objects. Render **liquid** as non-transmissive: `MeshPhysicalMaterial` with `transmission:0`, opaque, color = liquid absorption color, roughness 0.1, slight emissive boost on the sun side (fake subsurface glow). Add a flat meniscus top and tiny rising bubbles (soda) as instanced dots. Beer gets a thin foam ring.
- Labels: separate opaque lathe band just outside the glass (r+0.3 mm), paper material (roughness 0.85, canvas-generated texture: brand name, border, aged/stained, slightly peeled corner). Back of the label is visible *through* the glass on the far side: the label quad should be DoubleSide.
- Fresnel/rim: the physical material gives it via the env. Check that grazing edges go bright and the sun makes a sharp specular streak running vertically along the body.
- Perf: transmission renders an extra opaque pass. Keep total transmissive meshes ≤ ~20 (bottles + large shards). Consider a lower transmission target resolution if supported (check the r187 API; `material.transmission` pass size follows the drawing buffer).

## 3. Shooting
- First person, fixed vantage (~6–8 m from the fence, eye 1.6 m). Mouse aim with Pointer Lock and a limited yaw/pitch range (±35°/±15°), simple crosshair dot. Click = shoot. Small FOV kick + recoil.
- Hit test: ray vs analytic per-bottle collider (capsule/cylinder stack) for precise impact point + normal, then shatter. Misses hit the fence (wood splinter puff + bullet-hole decal) or the ground (dirt puff).

## 4. Fracture (core system)
**Decision: custom precomputed shell fracture in the bottle's (θ, y) surface space, not 3D Voronoi.** Bottle shards are curved plates of wall glass, so 2D Voronoi on the lathe surface matches reality and is cheap.
- Seeds: impact-biased. Dense small cells within ~2–3 cm of the impact point. Seeds along ~8–14 jittered radial rays from the impact and on concentric rings at growing radii, so you get radial cracks + concentric arcs (spiderweb). Sparse large cells far away.
- **Neck usually survives** as one big piece (often with the lip), and the **base/punt ring often survives** (`refs/broken_brown_bottle_base_survives.jpg`). Exclude seeds above the shoulder (neck = 1 cell) and give the bottom ~15 % 1–2 cells.
- Build each cell: clip the polygon in (θ,y), sample it onto the lathe profile r(y) for outer and inner surfaces, and stitch edge faces. Fracture edge faces get a slightly greener/brighter "edge glass" material: real edges glow with internal reflection.
- Precompute at load in a **Web Worker** (or idle time). Per bottle type, make 3 patterns for low/mid/high impact height. At hit time pick the closest-height pattern and **rotate about Y** so its impact azimuth matches the hit (the lathe is rotationally symmetric). Zero hitch on click.
- Crack phase (before separation): for ~30–60 ms of game time (stretched by slow-mo), show cracks: draw the cell borders nearest the impact first, growing outward at ~1,500 m/s scaled (i.e., near-instant but visible in slow-mo). Implement as a shader on the intact bottle reading a per-pattern crack-distance texture, or as thin bright line meshes on the surface. Whitened crush zone at the impact point.
- Labels hold glass together: shards under the label share a label piece and fly as one clump. The label paper tears along cell edges near the impact, and the far side stays partially intact.
- Shard counts per bottle: 25–45 wall shards (wide size distribution: a few large, many small) + neck + base + 40–120 tiny "glitter" fragments (generic instanced tetra/flake shapes).

## 5. Shard physics
**Decision: custom integrator, no physics engine** (deterministic, no WASM, trivially cheap at these counts).
- Initial velocity: radial outward from bottle axis + along bullet direction (exit side faster, ~3–8 m/s; impact side small spall back toward the camera), random angular velocity 5–30 rad/s (small shards spin faster). Liquid-filled bottles burst more violently outward (hydraulic pressure).
- Integrate gravity, light air drag (small shards drag more), collide against ground plane y=0 and the fence top-rail box (sphere/OBB vs plane using shard bounding radius + lowest-vertex test). Restitution 0.2–0.35, friction 0.5, angular damping on contact. Settle: when |v|<0.05 and |ω|<0.2 for 0.3 s → sleep, snap to rest with the largest face down.
- Caps: ≤ 350 awake shards; ≤ 1,500 resting shards total. Oldest resting shards merge into static batched geometry, or fade out after reset/many bottles.
- Rendering: large shards (neck, base, top ~8 per bottle) use the transmissive glass material. Small shards and glitter use a cheaper **non-transmissive** glass (env reflection + fresnel + tint, `transparent:true`, depthWrite false) in one `InstancedMesh` (or one merged geometry with per-shard matrix from a DataTexture). Target ≤ 4 draw calls per broken bottle.
- Sun glints: small shards flash when their normal hits the sun half-vector. Make sure bloom catches these (HDR specular > 1). This is the "catch the sun" moment.
- Ground impacts feed audio (debris tinkles pitched by shard size, rate-limited) and spawn tiny dust puffs.

## 6. Liquid splash
- On break of a filled bottle: liquid volume → (a) 1–3 expanding **sheet** meshes (noisy radial ribbon/crown, alpha-faded, 150–250 ms), (b) 150–400 **droplets** as instanced velocity-stretched sprites/spheres with refraction-ish shading (specular highlight + tinted body), gravity, splat on ground → (c) **wet dark decal** on dirt/wood that grows then slowly fades (darken albedo ~40 %, lower roughness).
- Beer: amber + white foam particles. Soda: clear with carbonated mist (tiny white points). Whiskey: deep brown, more viscous (fewer, larger droplets, slower spread). Liquid follows the bullet direction mostly (exit side) in a cone.
- Refs: `refs/slowmo_airgun_glass_bottles.jpg` (water bursting in a cloud of beads and spray holding the bottle shape), `refs/slowmo_cannon_vs_beer_bottle.jpg`.

## 7. Game feel, slow-mo, camera
- Sequence on hit (all triggered on the same frame): gunshot audio → **hit-stop** 40–60 ms (timeScale 0.05) → crack lines visible → **slow-mo** at timeScale ~0.2–0.25 for ~0.6–0.8 s real time, starting ~40 ms *after* separation begins ("slow-mo arrives late, leaves early") → ease back to 1.0 over 0.25 s. Don't stack slow-mo on rapid multi-kills: extend instead, with a max of 1.2 s.
- Camera punch: FOV −2.5° kick that springs back in 150 ms, trauma-based shake (perlin, trauma², max 0.4°), and a small push-in toward the hit bottle during slow-mo. Gun recoil on every shot (smaller, no slow-mo on misses).
- Post: brief bloom/exposure bump (+0.15 EV, 80 ms) and subtle chromatic aberration pulse on break. Mild vignette always.
- Score pop: small number rising from the bottle (DOM overlay), +bonus for multi-break within slow-mo.

## 8. Audio (Web Audio, synthesized only)
- One `AudioContext`, unlocked on the first click. Master → compressor → destination. Outdoor slap echo: `ConvolverNode` with a synthetic IR (two sparse reflections at ~180 ms and ~420 ms + short decaying noise tail).
- Gunshot: 2 ms noise click (high-passed 2 kHz) + body noise burst (bandpass 800 Hz, 80 ms decay) + low thump sine 120→45 Hz (100 ms) + light distortion.
- Glass break (TLOU2-style layers): **Impact** (bright 5 ms transient + 3–5 inharmonic sine partials 2–9 kHz, 30–80 ms decay), **Pane/crack** (8–20 randomized tinkle pings staggered over 20–350 ms, partial ratios like 1, 2.76, 5.40, 8.93), **Thump** (sine 90→40 Hz), **Debris** (event-driven pings from shard ground hits, pitch ∝ 1/size, ≤ 12 per 100 ms). Bottle type changes pitch: thick brown = lower, clear soda = higher.
- Liquid: lowpassed noise burst (1.2 kHz) + short filtered "splat" grains on droplet impacts.
- Slow-mo: lowpass the master to ~2.5 kHz + pitch the debris layer down ~20 % while slow. Keep the initial impact unaltered for punch.
- Voice cap 32. Reuse buffers (pre-render noise buffers once). No allocation storms per frame.

## 9. Perf budget & rules
- `renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))`. Antialias via SMAA (postprocessing) or composer multisampling 4. Don't do both.
- Draw calls ≤ 150, triangles ≤ 1.5 M, textures ≤ 2k (fence/ground 2k, labels 512), 1 shadow-casting light, 2048² shadow map.
- Bottles: 6–8 on the fence, ≤ 20 transmissive meshes on screen. Particles: dust ≤ 1.5k, droplets ≤ 2k live, glitter ≤ 1k live.
- Fracture never runs on the click frame (worker-precomputed). No per-frame allocations (reuse Vector3/Matrix4). Single rAF loop, fixed physics step 1/120 s scaled by timeScale, with an accumulator.
- Dev: `stats-gl` + `renderer.info` overlay under `?debug`. Verify GPU ≲ 60 % on the 4060 at 1440p.

## 10. "What real looks like" — critic checklists
**Scene/light** (`refs/clear_bottles_on_weathered_plank_dry_yard.jpg`, `refs/wooden_fence_sunset_lowsun.jpg`)
- [ ] Warm low sun, long hard shadows raking toward camera. Sky is warm near the horizon and bluer up high.
- [ ] Wood is grey/silver weathered with visible grain, cracks and splits, not orange-brown plastic.
- [ ] Backlit dust motes visible only in the sun-facing direction. Slight warm haze in the distance.
**Glass** (`refs/amber_liquid_bottle_on_wood.jpg`, `refs/bottles_colored_transmitted_shadows.jpg`, `refs/bottle_caustic_in_sun.jpg`)
- [ ] Background visibly refracted/distorted through the bottle (vertical lensing). Edges darker and more saturated than the center.
- [ ] Sharp vertical specular streak from the sun + env reflections. Fresnel brightening at silhouette.
- [ ] Colored light patch/caustic on the rail behind/under each bottle. Glass shadows are lighter and tinted, not black.
- [ ] Liquid level line visible, with a meniscus. Liquid is darker/more saturated than empty glass. Label paper is matte and seen reversed through the far side.
**Fracture** (`refs/slowmo_bottle_cavitation_82kfps.jpg`, `refs/slowmo_pellet_vs_coke_bottle_25kfps.jpg`, `refs/broken_brown_bottle_base_survives.jpg`)
- [ ] Cracks radiate from the impact point before the pieces separate (visible in slow-mo).
- [ ] Wide shard-size spread: many tiny glittering bits near the impact, few large curved plates elsewhere.
- [ ] Neck often stays one piece; the base ring often stays one piece. Label holds a clump together.
- [ ] Shards are curved, thin, sharp-edged plates with bright/greenish edges, not chunky cubes or uniform triangles.
**Shard motion** (`refs/glass_shards_closeup.jpg`)
- [ ] Exit-side burst is stronger than entry-side spall. Pieces spin (small ones faster) and flash in the sun.
- [ ] Shards bounce low (not rubbery), skid, and settle flat on the dirt. Fragments are still visible on the ground afterwards.
**Liquid** (`refs/slowmo_airgun_glass_bottles.jpg`, `refs/slowmo_cannon_vs_beer_bottle.jpg`)
- [ ] Liquid briefly holds the bottle's shape as a cloud/sheet, then breaks into droplets and spray. Foam for beer.
- [ ] Wet dark splash stain on the ground/rail that lingers.
**Feel/audio**
- [ ] Hit-stop + slow-mo is readable but short (< 1 s). Camera punch is subtle, not nauseating.
- [ ] Sound is layered: crack transient, ringing tinkles, low thump, trailing debris. Gunshot has an outdoor echo.
**Perf**
- [ ] Steady 60 fps during multi-bottle breaks. No hitch on the click frame.
