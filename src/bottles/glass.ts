import { Color, MeshPhysicalMaterial, Vector3, type Texture } from 'three';

export interface GlassUniforms {
  uFillY: { value: number };
  uBaseY: { value: number };
  uBaseTop: { value: number };
  uInnerR: { value: number };
  uWall: { value: number };
  uSigmaGlass: { value: Vector3 };
  uSigmaLiquid: { value: Vector3 };
  uLiquidColor: { value: Color };
  uFoam: { value: number };
  uSunDir: { value: Vector3 };
  uSunColor: { value: Color };
}

/** Absorption coefficient (1/m) from a "color after `dist` meters" pair, three.js convention. */
export function sigmaFrom(color: Color, dist: number) {
  const c = color.clone(); // linear
  return new Vector3(
    -Math.log(Math.max(1e-4, c.r)) / dist,
    -Math.log(Math.max(1e-4, c.g)) / dist,
    -Math.log(Math.max(1e-4, c.b)) / dist,
  );
}

/**
 * Bottle glass. Physical transmission, with the path length rebuilt per pixel:
 * two walls at grazing incidence (dark silhouettes), a thick base, and the liquid column
 * (chord ≈ 2·r·N·V) merged into one absorption so the refracted backdrop is tinted by liquid too.
 */
export function createGlassMaterial(env: Texture | null, envRot: { x: number; y: number; z: number }, u: GlassUniforms) {
  const m = new MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.035,
    transmission: 1,
    ior: 1.52,
    thickness: 0.01,
    specularIntensity: 1,
    envMapIntensity: 1.15,
    dispersion: 0.12,
  });
  if (env) {
    m.envMap = env;
    m.envMapRotation.set(envRot.x, envRot.y, envRot.z);
  }
  m.customProgramCacheKey = () => 'bottleGlass1';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <transmission_pars_fragment>',
        `#include <transmission_pars_fragment>
uniform float uFillY, uBaseY, uBaseTop, uInnerR, uWall, uFoam;
uniform vec3 uSigmaGlass, uSigmaLiquid, uLiquidColor, uSunDir, uSunColor;`,
      )
      .replace(
        '#include <transmission_fragment>',
        `
  material.transmission = transmission;
  material.transmissionAlpha = 1.0;
  vec3 gPos = vWorldPosition;
  vec3 gV = normalize( cameraPosition - gPos );
  vec3 gN = transformNormalByInverseViewMatrix( normal, viewMatrix );
  float gNoV = clamp( abs( dot( normal, geometryViewDir ) ), 0.0, 1.0 );
  float gY = gPos.y;
  // glass path: two walls, longer at grazing incidence, plus the heavy base
  float tGlass = 2.0 * uWall / max( gNoV, 0.18 );
  tGlass += smoothstep( uBaseTop + 0.004, uBaseTop - 0.004, gY - uBaseY ) * 0.012;
  float inLiq = smoothstep( uFillY + 0.0006, uFillY - 0.0006, gY ) * step( uBaseY + uBaseTop, gY );
  float tLiq = 2.0 * uInnerR * gNoV * inLiq;
  vec3 optDepth = uSigmaGlass * tGlass + uSigmaLiquid * tLiq;
  // refraction offset: thin for hollow glass, lens-like through the liquid column
  float tDisp = 0.004 + tLiq * 0.55;
  vec3 effAtt = exp( - optDepth / tDisp );
  effAtt = max( effAtt, vec3( 1e-4 ) );
  vec4 transmitted = getIBLVolumeRefraction(
    gN, gV, material.roughness, material.diffuseContribution, material.specularColorBlended, material.specularF90,
    gPos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, tDisp,
    effAtt, 1.0 );
  material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
  totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
  // liquid: forward-scattered sun glow + a little wrapped sun light (fake subsurface)
  float fwd = pow( max( dot( -gV, uSunDir ), 0.0 ), 5.0 );
  float wrapL = max( dot( gN, uSunDir ) * 0.5 + 0.5, 0.0 );
  totalDiffuse += uLiquidColor * uSunColor * inLiq * ( fwd * 0.9 + wrapL * 0.05 );
  // meniscus: thin dark line with a bright rim just above it; beer gets a foam band
  float dy = gY - uFillY;
  float liqOn = step( 0.0001, uSigmaLiquid.r + uSigmaLiquid.g + uSigmaLiquid.b );
  float line = exp( - dy * dy / 0.0000012 ) * liqOn;
  totalDiffuse *= 1.0 - 0.55 * line;
  float foam = uFoam * liqOn * smoothstep( -0.0005, 0.0005, dy ) * smoothstep( 0.0045, 0.002, dy );
  totalDiffuse = mix( totalDiffuse, vec3( 0.75, 0.68, 0.52 ) * ( 0.35 + 0.65 * wrapL ) * uSunColor * 0.35 + transmitted.rgb * 0.25, foam * 0.85 );
`,
      );
  };
  return m;
}
