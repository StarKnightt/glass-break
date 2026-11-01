import {
  Matrix3,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector2,
  type Vector3,
  type DataTexture,
  type WebGLRenderer,
} from 'three';
import { loadPbr } from './textures';

export const GROUND_SIZE = 400;
const TILE_M = 2.6;

const NOISE_GLSL = /* glsl */ `
float gbHash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float gbNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = gbHash(i), b = gbHash(i+vec2(1,0)), c = gbHash(i+vec2(0,1)), d = gbHash(i+vec2(1,1));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float gbFbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*gbNoise(p); p*=2.03; a*=0.5; } return s; }
// 0 = dry grass, 1 = bare dirt
float gbDirtMask(vec2 xz){
  float n = gbFbm(xz*0.22) + 0.35*gbFbm(xz*1.3);
  // trodden strip along the base of the fence and toward the shooter
  float strip = exp(-pow((xz.y-0.35)/0.55, 2.0)) * 0.55;
  float path = exp(-pow(xz.x/1.2, 2.0)) * smoothstep(1.0, 3.0, xz.y) * smoothstep(12.0, 6.0, xz.y) * 0.35;
  return smoothstep(0.55, 0.8, n + strip + path);
}
`;

export function createGround(renderer: WebGLRenderer, hdr: DataTexture, bgSampleRot: Matrix3, postBases: Vector3[]) {
  const POSTS = postBases.length;
  const rep = GROUND_SIZE / TILE_M;
  const grass = loadPbr(renderer, 'withered_grass', rep);
  const dirt = loadPbr(renderer, 'dirt', rep);

  const mat = new MeshStandardMaterial({
    map: grass.map,
    normalMap: grass.normalMap,
    roughnessMap: grass.arm,
    roughness: 1,
    metalness: 0,
  });
  mat.normalScale.set(1.2, 1.2);

  const uniforms = {
    tDirt: { value: dirt.map },
    tDirtN: { value: dirt.normalMap },
    tBg: { value: hdr },
    uBgRot: { value: bgSampleRot },
    uBgFade: { value: new Vector2(28, 90) },
    uPosts: { value: postBases.map((p) => new Vector2(p.x, p.z)) },
  };

  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGbWorld;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvGbWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vGbWorld;
         uniform sampler2D tDirt; uniform sampler2D tDirtN; uniform sampler2D tBg;
         uniform mat3 uBgRot; uniform vec2 uBgFade; uniform vec2 uPosts[${POSTS}];
         ${NOISE_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `float gbM = gbDirtMask(vGbWorld.xz);
         vec2 gbDirtUv = vMapUv * 0.71 + vec2(0.37, 0.13);
         {
           // anti-tiling: blend a rotated, rescaled second sample through a noise mask
           vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.43 + vec2(0.31, 0.77);
           float tb = smoothstep(0.35, 0.65, gbFbm(vGbWorld.xz * 0.35 + 3.0));
           vec4 g = mix(texture2D(map, vMapUv), texture2D(map, uvB), tb);
           vec4 d = mix(texture2D(tDirt, gbDirtUv), texture2D(tDirt, uvB * 1.3 + 0.2), tb);
           // dirt is darker & redder than this yard; pull it toward dusty tan
           d.rgb = mix(d.rgb, vec3(dot(d.rgb, vec3(0.33))) * vec3(1.25, 1.05, 0.82), 0.5) * 1.35;
           vec3 c = mix(g.rgb, d.rgb, gbM);
           // macro variation to kill tiling
           float mv = gbFbm(vGbWorld.xz * 0.07);
           c *= mix(0.5, 0.72, mv);
           c = mix(c, c * vec3(1.06, 0.98, 0.86), gbFbm(vGbWorld.xz * 0.31 + 7.0));
           // contact darkening around post bases and under the fence line
           float occ = 1.0;
           for (int i = 0; i < ${POSTS}; i++) {
             float r = length(vGbWorld.xz - uPosts[i]);
             occ *= mix(0.35, 1.0, smoothstep(0.05, 0.35, r));
           }
           occ *= mix(0.75, 1.0, smoothstep(0.0, 0.25, abs(vGbWorld.z - 0.02)));
           diffuseColor.rgb *= c * occ;
         }`,
      )
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        `vec3 mapN = mix(texture2D( normalMap, vNormalMapUv ).xyz, texture2D( tDirtN, gbDirtUv ).xyz, gbM) * 2.0 - 1.0;`,
      )
      .replace(
        '#include <fog_fragment>',
        `#include <fog_fragment>
         {
           // Fade into the HDRI's own ground so the horizon is seamless.
           vec3 vd = normalize(vGbWorld - cameraPosition);
           vec3 sd = uBgRot * vd;
           vec2 euv = vec2(atan(sd.z, sd.x) * RECIPROCAL_PI2 + 0.5, asin(clamp(sd.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
           vec3 bg = texture2D(tBg, euv).rgb * 0.9;
           float dist = length(vGbWorld.xz - cameraPosition.xz);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, bg, smoothstep(uBgFade.x, uBgFade.y, dist));
         }`,
      );
  };

  const geo = new PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 1, 1).rotateX(-Math.PI / 2);
  const mesh = new Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}
