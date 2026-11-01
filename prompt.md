/goal build a realistic glass bottle shooting game in F:\glass-break. done means: it looks so real people think it's footage until the bottles break, it's fully playable, runs smooth at 60fps with pnpm dev, every system passed the critic against real reference photos, and it's committed to git.

the scene: an old wooden fence in a dry backyard at golden hour. a row of glass bottles on the fence: green beer bottles, clear soda bottles, brown whiskey bottles, some half full of liquid. warm low sun, long shadows, dust in the air. first person, click to shoot.

what matters most:
→ glass that looks real: refraction, reflections, fresnel, thickness, tinted color, a label on each bottle
→ breaking that feels real: cracks from the hit point, shatters into sharp shards of different sizes, shards spin, catch the sun, hit the ground and bounce, liquid splashes out
→ slow motion on the break with a subtle camera punch
→ sound: shot, glass crack, shards tinkling, all synthesized with web audio, no audio files
→ score and a reset button, minimal ui

before building, /find-skills and use these:
github.com/cloudai-x/threejs-skills
github.com/dgreenheck/webgpu-claude-skill
github.com/majidmanzarpour/threejs-game-skills
skills.sh

research step: before the glass and the shatter, research how developers build realistic glass and fracture in three.js (voronoi fracture, transmission materials, shard physics) and what makes breaking things feel satisfying in games. turn it into ideas for this game.

the gauntlet:
1. builder agent builds one system at a time: scene and lighting, then bottles and glass, then shooting, then fracture and shards, then liquid, then slow motion and sound
2. after each system, a separate critic agent takes screenshots and compares them against real photos of glass bottles on a fence and real slow motion footage of bottles breaking. no "looks good", only what's different from the real reference
3. builder fixes everything the critic found, then moves on
4. sequential agents only, never parallel

rules:
→ pnpm, vite, three.js
→ don't max out my cpu or gpu (ryzen 5 7600x, rtx 4060), keep it at 60fps
→ test on my second screen
→ be efficient with tokens: small context, don't reread files you don't need

before finishing: run it, test shooting, breaking and reset yourself, fix anything broken or ugly, make an OG image of a bottle mid-shatter for the github repo social preview, then git init and commit.
