import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mulberry32 } from './rand';
import { SUN_COLOR } from './environment';

const BOX_MIN = new Vector3(-9, 0.05, -5);
const BOX_SIZE = new Vector3(18, 3.6, 13);

/**
 * Drifting dust motes. Only visible when backlit (Henyey-Greenstein forward scatter) and
 * analytically occluded by the fence's shadow volume.
 */
export function createDust(sunDir: Vector3, fenceTopY: number, fenceHalfLen: number, count = 500) {
  const rnd = mulberry32(99);
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rnd();
    pos[i * 3 + 1] = rnd() ** 1.6; // denser near the ground
    pos[i * 3 + 2] = rnd();
    seed[i * 2] = rnd();
    seed[i * 2 + 1] = rnd();
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('seed', new Float32BufferAttribute(seed, 2));

  const mat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uSunCol: { value: new Color().copy(SUN_COLOR) },
      uBoxMin: { value: BOX_MIN },
      uBoxSize: { value: BOX_SIZE },
      uFenceTop: { value: fenceTopY },
      uFenceHalf: { value: fenceHalfLen },
      uPxScale: { value: 1 },
      uIntensity: { value: 16.0 },
    },
    vertexShader: /* glsl */ `
      attribute vec2 seed;
      uniform float uTime, uFenceTop, uFenceHalf, uPxScale, uIntensity;
      uniform vec3 uSunDir, uBoxMin, uBoxSize, uSunCol;
      varying vec3 vCol;
      void main(){
        vec3 p = position;
        float t = uTime;
        // slow wind drift + curl-ish wobble, wrapped in the box
        p.x += t * (0.012 + seed.x * 0.01);
        p.y += t * (seed.y - 0.45) * 0.004;
        p.z += t * 0.004;
        vec3 w = uBoxMin + fract(p) * uBoxSize;
        w.x += sin(t * 0.37 + seed.y * 30.0) * 0.12 + sin(t * 0.9 + seed.x * 17.0) * 0.04;
        w.y += sin(t * 0.29 + seed.x * 23.0) * 0.08;
        w.z += cos(t * 0.33 + seed.y * 11.0) * 0.1;

        vec3 V = normalize(w - cameraPosition);
        float g = 0.82;
        float mu = dot(V, uSunDir);
        float hg = (1.0 - g*g) / pow(1.0 + g*g - 2.0*g*mu, 1.5) / 12.566;

        // fence shadow volume
        float lit = 1.0;
        if (w.z > 0.0 && uSunDir.z < 0.0) {
          float k = w.z / -uSunDir.z;
          vec3 hit = w + uSunDir * k;
          // rails (bands) and posts (every POST_SPACING) are the only solid parts
          float rail = step(abs(hit.y - 0.32), 0.06) + step(abs(hit.y - 0.78), 0.06) + step(abs(hit.y - (uFenceTop - 0.02)), 0.03);
          float post = step(abs(fract(hit.x / 2.1 + 0.5) - 0.5) * 2.1, 0.06) * step(hit.y, uFenceTop);
          if (abs(hit.x) < uFenceHalf && hit.y > 0.0 && rail + post > 0.0) lit = 0.0;
        }
        if (w.y < 0.0) lit = 0.0;

        vec4 mv = modelViewMatrix * vec4(w, 1.0);
        float size = 0.006 + seed.x * seed.x * 0.02;
        float px0 = size * uPxScale / max(-mv.z, 0.05);
        // out-of-focus discs: circle of confusion around a 6.5 m focus
        float coc = abs(1.0 - 6.5 / max(-mv.z, 0.05)) * uPxScale * 0.006;
        gl_PointSize = clamp(max(px0, coc), 1.0, 40.0);
        float twinkle = 0.7 + 0.3 * sin(t * (1.0 + seed.y * 3.0) + seed.x * 40.0);
        // dim very close motes (they'd be out of focus) and far ones fade into haze
        float d = -mv.z;
        float fade = smoothstep(0.6, 2.0, d) * (1.0 - smoothstep(14.0, 22.0, d));
        vCol = uSunCol * hg * lit * twinkle * fade * uIntensity * (0.4 + seed.y);
        // sub-pixel points: keep energy roughly constant
        float px = size * uPxScale / max(d, 0.05);
        vCol *= clamp(px * px, 0.05, 1.0);
        vCol *= clamp(px0 * px0 / (gl_PointSize * gl_PointSize), 0.02, 1.0) * 3.0;
        vCol = clamp(vCol, 0.0, 24.0);
        if (any(isnan(vCol)) || -mv.z <= 0.0) vCol = vec3(0.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        float a = smoothstep(1.0, 0.7, r) * (0.75 + 0.25 * smoothstep(0.5, 0.95, r));
        gl_FragColor = vec4(vCol * a, 1.0);
      }`,
  });

  const points = new Points(geo, mat);
  points.frustumCulled = false;
  points.name = 'dust';
  points.renderOrder = 10;

  return {
    points,
    update(time: number, drawingBufferHeight: number, fovRad: number) {
      mat.uniforms.uTime.value = time;
      mat.uniforms.uPxScale.value = drawingBufferHeight / (2 * Math.tan(fovRad / 2));
    },
  };
}
