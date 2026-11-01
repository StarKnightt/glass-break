# System 2 critique (bottles + glass): verdict FAIL

Shots: shots/system2/critic/{game,rail,close_beer,close_soda,close_whiskey}.jpg
Refs: amber_liquid_bottle_on_wood, bottles_colored_transmitted_shadows, clear_bottles_on_weathered_plank_dry_yard, bottle_caustic_in_sun.
Perf: 5.0 ms median and 5.3–5.5 ms p90 on an RTX 4060, 74–128 draw calls. Perf is not the problem.

1. **No refraction: the glass reads as a flat tinted fill.** In close_beer, the empty neck and shoulder are a uniform opaque sage green. The hills and horizon behind it are not visible or distorted. In close_soda, the body is milky with only a faint ghost of the field. The refs show a sharp, displaced and inverted background through every wall, with the strongest bending at the edges.
   Fix: roughness 0.0–0.03 (it is currently clearly higher, or there is a blur/haze term). Set `thickness` to about 0.03, using a `thicknessMap` that is high at the silhouette. Keep `ior` at 1.52 and remove any sheen, clearcoat-roughness or translucency hack. Confirm the transmission render target is not being downsampled or blurred by the DOF/bloom pass. Exclude bottles from DOF, or render the close-ups with DOF off.

2. **No dark silhouette edges or wall thickness.** All three bottles have soft, even edges. The refs (colored_transmitted_shadows) show near-black, saturated outlines where the light path grazes the wall, a dark thick base ring, and a visible lip thickness.
   Fix: build real outer and inner lathe walls. Add per-vertex thickness via `onBeforeCompile` (thickness ∝ 1/max(N·V, 0.15)). Make the base 3–4× thicker with a punt. Use attenuationDistance 0.03 for beer and 0.04 for whiskey, so long paths go dark.

3. **No specular streaks, reflections or fresnel.** The bottles are backlit by a low sun, yet there is no vertical sun streak, no sky reflection band and no bright grazing rim. The whiskey bottle has one faint smudge on its shoulder. Real bottles always show 1–2 crisp vertical highlight lines and a window/sky reflection.
   Fix: use an HDR env map that contains the actual sun disk (PMREM from the sky at a high res, envMapIntensity 1.2–1.5). Use specularIntensity 1, with clearcoat 1 and clearcoatRoughness 0.02 for a second sharp lobe. Optionally add an analytic sun specular term (very small roughness) in `onBeforeCompile` to guarantee the streak.

4. **The liquid color is wrong and the liquid is not seen through the glass.** The beer's liquid is bright orange under green glass. Real green glass would make it dark olive-brown. The whiskey body glows uniformly orange like an emissive plastic. The amber ref shows a dark core, a bright amber rim and refracted swirls, with a darker bottom.
   Fix: multiply the liquid color by the glass attenuation, or render the liquid inside the transmission pass so the glass tints it. Make the liquid slightly transmissive or use a view-dependent shade: darker at the center thickness and brighter at the sun-facing rim (back-scatter term). Cut the emissive by about 60%.

5. **No meniscus or fill line.** The liquid top is a hard, flat horizontal cut. The ref shows a bright curved meniscus band, a thin highlight line where the liquid meets the glass, and a visible ellipse of the surface seen from slightly above.
   Fix: add a small upward-curved meniscus ring at the wall (3–4 mm), a specular line on the liquid top (roughness 0.02), beer foam ring and bubbles as planned in research §2.

6. **Fake caustic decals are neon blobs.** Under the beer there is a saturated glowing green puddle. Under the soda there is a white barcode-like stripe. There is no dark shadow body at all. The colored_transmitted_shadows ref shows a long shadow stretched away from the sun, tinted and mostly dark, with a bright caustic focus line and darker borders.
   Fix: elongate the projector along the sun direction (a low sun makes it 3–5× the bottle height), with a dark tinted fill (≈20–40% of the light) and one thin bright focus band near the far end. Clamp it to below about 1.5× the rail albedo so it never looks emissive. Clear glass should cast a light grey shadow with white caustic lines.

7. **No contact with the rail.** In the rail view, the bottles float: there is no contact shadow, no AO ring, and no darkening of the wood under the base.
   Fix: add a small blurred contact-shadow disc (radius 1.1× the base, opacity 0.5) and make sure bottles cast into the shadow map (castShadow, plus a tight shadow camera with bias tuned for 6 cm objects). Tilt bottles randomly by ±1–2° and seat them on the uneven rail.

8. **Labels look like clean CG stickers.** Kestrel and Hollow are pure white with crisp vector borders. "wellFiz" is cropped off the band, so the texture is wrapped at the wrong U scale. The labels are evenly lit all the way around, and none of the back of a label shows through the glass.
   Fix: warm the paper to an aged cream (#e8dcc0 range) with grime, scuffs and a darker glue edge. Add a slight lift/peel at one corner and a roughness of 0.85 with a fiber normal map. Fit the text to 40% of the circumference. Make labels DoubleSide so they are visible through the far wall. Raise the label 0.3 mm off the glass with a thin dark seam line.

9. **Caps and proportions are generic.** The caps are flat grey/white/red cylinders with no crimped flutes, no metal specular and no cork. The whiskey bottle is a rounded box but should be a flat-shouldered rectangle with sharp-ish edges.
   Fix: give the crown cap 21 flutes via a lathe with sin(θ·21) displacement, metalness 1 and roughness 0.3, plus a printed top. Give the whiskey a cork or ribbed screw cap. Build the whiskey body from a rounded-rectangle extrude (corner radius 6 mm). The neck lengths look right; keep them.

10. **Readability and scale in the game view.** At the default vantage the bottles are 8–15 px specks. The clear sodas vanish entirely, and only their red labels show. Real backlit bottles pop as glowing silhouettes with rim light.
   Fix: a stronger fresnel/rim and backlit transmission glow (see items 3 and 4) will do most of the work. Consider a slightly narrower default FOV (or a zoom on aim). Give clear glass a faint green edge (attenuationColor #d8f0e0, distance 0.5) so it reads against the dry field. Remove the milky haze; clear glass must be clear, with only edge darkening and highlights.

Verdict: **FAIL.** The glass reads as tinted plastic or frosted resin, not photographed glass. Items 1–4 are blocking. Items 6–8 are the next most visible.
