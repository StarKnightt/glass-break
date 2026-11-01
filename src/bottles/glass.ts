import { Color, MeshPhysicalMaterial, Vector3, type Texture } from 'three';

export interface GlassUniforms {
  uFillY: { value: number };
  uBaseY: { value: number };
  uBaseTop: { value: number };
  uTopY: { value: number };
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
    roughness: 0.0,
    transmission: 1,
    ior: 1.52,
    thickness: 0.01,
    specularIntensity: 1,
    envMapIntensity: 0.5,
    clearcoat: 0.6,
    clearcoatRoughness: 0.02,
    dispersion: 0.12,
  });
  if (env) {
    m.envMap = env;
    m.envMapRotation.set(envRot.x, envRot.y, envRot.z);
  }
  m.customProgramCacheKey = () => 'bottleGlass2';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <transmission_pars_fragment>',
        `#include <transmission_pars_fragment>
uniform float uFillY, uBaseY, uBaseTop, uTopY, uInnerR, uWall, uFoam;
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
  // glass path: two walls, much longer at grazing incidence, heavy base ring, thick lip
  float graze = 1.0 / max( gNoV, 0.12 );
  float tGlass = 2.0 * uWall * graze;
  float hY = gY - uBaseY;
  tGlass += smoothstep( uBaseTop + 0.003, uBaseTop - 0.003, hY ) * ( 0.02 + 0.03 * ( 1.0 - gNoV ) );
  tGlass += smoothstep( uTopY - 0.007, uTopY - 0.002, hY ) * 0.012 * graze;
  float inLiq = smoothstep( uFillY + 0.0006, uFillY - 0.0006, gY ) * step( uBaseY + uBaseTop, gY );
  float tLiq = 2.0 * uInnerR * gNoV * inLiq;
  vec3 optDepth = uSigmaGlass * tGlass + uSigmaLiquid * tLiq;
  // refraction offset: walls bend the backdrop most at the edges; the liquid column is a lens
  float e = 1.0 - gNoV;
  float tDisp = 0.006 + 0.07 * e * e + tLiq * 0.9;
  // three's attenuation: exp( log( c ) / d * len ), len ≈ tDisp → exp( -optDepth )
  vec3 effAtt = max( exp( - optDepth ), vec3( 1e-6 ) );
  vec4 transmitted = getIBLVolumeRefraction(
    gN, gV, material.roughness, material.diffuseContribution, material.specularColorBlended, material.specularF90,
    gPos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, tDisp,
    effAtt, tDisp );
  material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
  totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
  vec3 glassT = exp( - uSigmaGlass * tGlass );
  // liquid: sun scattered in the liquid, seen through the glass tint; brighter toward the rim
  float fwd = pow( max( dot( -gV, uSunDir ), 0.0 ), 5.0 );
  float wrapL = max( dot( gN, uSunDir ) * 0.5 + 0.5, 0.0 );
  vec3 liqT = exp( - uSigmaLiquid * tLiq * 0.5 );
  totalDiffuse += uLiquidColor * liqT * glassT * uSunColor * inLiq * ( fwd * 0.05 * ( 0.3 + 0.7 * e ) + wrapL * 0.004 );
  // crisp sun glint: sharp reflection lobe of the sun disk (vertical streak on a cylinder)
  vec3 gR = reflect( -gV, gN );
  float glint = pow( max( dot( gR, uSunDir ), 0.0 ), 900.0 );
  totalSpecular += uSunColor * glint * 14.0;
  // thin bright grazing rim only at the very edge
  totalSpecular += uSunColor * glassT * pow( e, 8.0 ) * fwd * 0.25;
  // meniscus: dark line + bright curved band just above it; beer gets a foam band
  float dy = gY - uFillY;
  float liqOn = step( 0.0001, uSigmaLiquid.r + uSigmaLiquid.g + uSigmaLiquid.b );
  float line = exp( - dy * dy / 0.0000008 ) * liqOn;
  totalDiffuse *= 1.0 - 0.7 * line;
  float men = exp( - pow( ( dy - 0.0016 ) / 0.0007, 2.0 ) ) * liqOn * ( 1.0 - uFoam );
  totalDiffuse += ( uSunColor * 0.06 + uLiquidColor * glassT * 0.05 ) * men;
  float foam = uFoam * liqOn * smoothstep( -0.0005, 0.0005, dy ) * smoothstep( 0.0045, 0.002, dy );
  totalDiffuse = mix( totalDiffuse, vec3( 0.75, 0.68, 0.52 ) * glassT * ( 0.35 + 0.65 * wrapL ) * uSunColor * 0.25 + transmitted.rgb * 0.25, foam * 0.8 );
`,
      );
  };
  return m;
}
