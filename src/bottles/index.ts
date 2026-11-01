import {
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshStandardMaterial,
  DoubleSide,
  Vector2,
  Vector3,
  type Object3D,
  type Texture,
} from 'three';
import type { World } from '../core/world';
import { buildProfile, lathe, type BottleProfile, type BottleType } from './profiles';
import { createGlassMaterial, sigmaFrom, type GlassUniforms } from './glass';
import { createLabelTextures, LABEL_BRAND } from './labels';
import { createCaustic, createContactShadow } from './caustics';

export type { BottleType } from './profiles';

interface TypeLook {
  glass: [string, number];
  liquid: [string, number];
  liquidGlow: string;
  surface: string;
  foam: number;
  cap?: { color: string; metal: number; rough: number; kind: 'crown' | 'screw' };
  caustic: string;
}

const LOOK: Record<BottleType, TypeLook> = {
  beer: {
    glass: ['#1e6b2c', 0.012],
    liquid: ['#d89a2a', 0.04],
    liquidGlow: '#ff9a2a',
    surface: '#d8c49a',
    foam: 1,
    cap: { color: '#c9a24a', metal: 0.9, rough: 0.32, kind: 'crown' },
    caustic: '#7dff62',
  },
  soda: {
    glass: ['#eaf6ee', 0.03],
    liquid: ['#4a1404', 0.012],
    liquidGlow: '#a02a08',
    surface: '#1a0703',
    foam: 0,
    cap: { color: '#b3221a', metal: 0.55, rough: 0.35, kind: 'crown' },
    caustic: '#fffbe8',
  },
  whiskey: {
    glass: ['#5a2a06', 0.03],
    liquid: ['#c8741e', 0.05],
    liquidGlow: '#ff8a1e',
    surface: '#5a2a0a',
    foam: 0,
    cap: { color: '#151413', metal: 0.2, rough: 0.55, kind: 'screw' },
    caustic: '#ff9a3a',
  },
};

export interface Bottle {
  id: number;
  type: BottleType;
  /** Root object; position = bottom center on the rail. */
  group: Group;
  meshes: { glass: Mesh; labels: Mesh[]; cap: Mesh | null; liquidSurface: Mesh; hit: Mesh; caustic: Mesh };
  /** Glass absorption color (attenuationColor, sRGB) and the colored-light tint. */
  tint: Color;
  liquidColor: Color;
  /** 0 = empty, 1 = up to the shoulder. */
  readonly fill: number;
  setFill(f: number): void;
  /** World-space liquid top height (meaningless when fill = 0). */
  fillWorldY(): number;
  label: { brand: string; texture: Texture };
  radius: number;
  height: number;
  profile: BottleProfile;
  slot: Vector3;
  alive: boolean;
  remove(): void;
  reset(): void;
}

const LAYOUT: { type: BottleType; fill: number }[] = [
  { type: 'beer', fill: 0.62 },
  { type: 'soda', fill: 0 },
  { type: 'whiskey', fill: 0.55 },
  { type: 'beer', fill: 0 },
  { type: 'soda', fill: 0.5 },
  { type: 'whiskey', fill: 0 },
  { type: 'beer', fill: 0.4 },
  { type: 'soda', fill: 0 },
];

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function makeCap(kind: 'crown' | 'screw', topY: number) {
  if (kind === 'crown') {
    const g = new CylinderGeometry(0.0141, 0.0149, 0.0064, 84, 3);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = Math.hypot(x, z);
      if (r < 0.013) continue;
      const th = Math.atan2(x, z);
      const skirt = Math.min(1, Math.max(0, (0.0032 - y) / 0.005));
      const k = 1 + 0.06 * Math.pow(Math.max(0, Math.cos(th * 21)), 2) * skirt;
      p.setXYZ(i, x * k, y, z * k);
    }
    g.computeVertexNormals();
    g.translate(0, topY - 0.0026, 0);
    return g;
  }
  const g = new CylinderGeometry(0.0171, 0.0171, 0.018, 96, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 0.016) continue;
    const th = Math.atan2(x, z);
    const k = 1 + 0.025 * Math.abs(Math.sin(th * 24));
    p.setXYZ(i, x * k, p.getY(i), z * k);
  }
  g.computeVertexNormals();
  g.translate(0, topY - 0.0075, 0);
  return g;
}

function labelBand(profile: BottleProfile, y0: number, y1: number, theta0: number, thetaLen: number, offset = 0.00045) {
  const pts: Vector2[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    pts.push(new Vector2(profile.outerR(y), y));
  }
  return lathe(pts, 72, { theta0, thetaLen, square: profile.square, rOffset: offset });
}

/** Builds the 8 rail bottles. Glass is the only transmissive part (8 meshes total). */
export function createBottles(world: World) {
  const { scene, renderer } = world;
  renderer.transmissionResolutionScale = 0.75;
  const markers = scene.getObjectByName('bottleSlotMarkers');
  if (markers) markers.visible = false;

  const env = scene.environment;
  const envRot = scene.environmentRotation;
  const tex = createLabelTextures(renderer);
  const profiles: Record<BottleType, BottleProfile> = {
    beer: buildProfile('beer'),
    soda: buildProfile('soda'),
    whiskey: buildProfile('whiskey'),
  };
  const glassGeo: Record<BottleType, ReturnType<typeof lathe>> = {
    beer: lathe(profiles.beer.points, 64),
    soda: lathe(profiles.soda.points, 64),
    whiskey: lathe(profiles.whiskey.points, 72, { square: profiles.whiskey.square }),
  };
  const hitGeo = (t: BottleType) => {
    const pr = profiles[t];
    const pts = pr.points.slice(0, pr.split + 1).filter((_, i, a) => i % 6 === 0 || i === a.length - 1);
    return lathe(pts, 14, { square: pr.square });
  };
  const hitMat = new MeshBasicMaterial({ visible: false });
  const paperMat = (map: Texture) =>
    new MeshStandardMaterial({ map, roughness: 0.82, metalness: 0, side: DoubleSide });
  const labelMats = {
    beer: paperMat(tex.beer),
    beerNeck: paperMat(tex.beerNeck),
    soda: paperMat(tex.soda),
    whiskey: paperMat(tex.whiskey),
  };
  const capMats: Partial<Record<BottleType, MeshStandardMaterial>> = {};
  for (const t of ['beer', 'soda', 'whiskey'] as BottleType[]) {
    const c = LOOK[t].cap;
    if (!c) continue;
    capMats[t] = new MeshStandardMaterial({ color: c.color, metalness: c.metal, roughness: c.rough, envMap: env, envMapIntensity: 0.9 });
    capMats[t]!.envMapRotation.copy(envRot);
  }
  // Surface disc: flat center rising into a meniscus at the wall.
  const discPts = [new Vector2(0.0003, 0), new Vector2(0.6, 0.0), new Vector2(0.9, 0.0004), new Vector2(0.98, 0.0012), new Vector2(1.0, 0.0022)];
  const discGeo = {
    round: lathe(discPts, 48),
    square: lathe(discPts, 48, { square: [10, 11] }),
  };

  const root = new Group();
  root.name = 'bottles';
  const causticRoot = new Group();
  causticRoot.name = 'bottleCaustics';
  scene.add(root, causticRoot);

  const railZ: [number, number] = [-0.079, 0.079];
  const sunColor = world.sun.color.clone().multiplyScalar(world.sun.intensity * 0.22);
  const bottles: Bottle[] = [];
  const r = rnd(1337);

  world.bottleSlots.forEach((slot, i) => {
    const spec = LAYOUT[i % LAYOUT.length];
    const type = spec.type;
    const look = LOOK[type];
    const pr = profiles[type];

    const group = new Group();
    group.name = `bottle_${i}_${type}`;
    const basePos = slot.clone().add(new Vector3((r() - 0.5) * 0.03, 0.0004, (r() - 0.5) * 0.02));
    const baseRotY = (r() - 0.5) * 0.6;
    group.position.copy(basePos);
    group.rotation.y = baseRotY;

    const tint = new Color(look.glass[0]);
    const liquidColor = new Color(look.liquid[0]);
    const uniforms: GlassUniforms = {
      uFillY: { value: -1 },
      uBaseY: { value: basePos.y },
      uBaseTop: { value: pr.floorY },
      uInnerR: { value: pr.innerR(0.06) },
      uWall: { value: 0.003 },
      uSigmaGlass: { value: sigmaFrom(new Color(look.glass[0]), look.glass[1]) },
      uSigmaLiquid: { value: new Vector3() },
      uLiquidColor: { value: new Color(look.liquidGlow) },
      uFoam: { value: look.foam },
      uSunDir: { value: world.sunDir },
      uSunColor: { value: sunColor },
    };
    const liquidSigma = sigmaFrom(liquidColor, look.liquid[1]);
    const glassMat = createGlassMaterial(env, envRot, uniforms);
    const glass = new Mesh(glassGeo[type], glassMat);
    glass.name = 'glass';
    glass.castShadow = true;
    glass.receiveShadow = false;
    const depthMat = new MeshDepthMaterial({ alphaHash: true, opacity: 0.4 });
    glass.customDepthMaterial = depthMat;
    group.add(glass);

    const labels: Mesh[] = [];
    let labelTex: Texture;
    if (type === 'beer') {
      labels.push(new Mesh(labelBand(pr, 0.034, 0.104, -1.35, 2.7), labelMats.beer));
      labels.push(new Mesh(labelBand(pr, 0.168, 0.186, -0.95, 1.9), labelMats.beerNeck));
      labelTex = tex.beer;
    } else if (type === 'soda') {
      labels.push(new Mesh(labelBand(pr, 0.068, 0.106, -Math.PI, Math.PI * 2), labelMats.soda));
      labelTex = tex.soda;
    } else {
      labels.push(new Mesh(labelBand(pr, 0.035, 0.132, -0.72, 1.44), labelMats.whiskey));
      labelTex = tex.whiskey;
    }
    for (const l of labels) {
      l.castShadow = true;
      l.receiveShadow = true;
      l.name = 'label';
      group.add(l);
    }

    let cap: Mesh | null = null;
    if (look.cap) {
      cap = new Mesh(makeCap(look.cap.kind, pr.height + 0.0012), capMats[type]!);
      cap.castShadow = true;
      cap.receiveShadow = true;
      cap.name = 'cap';
      cap.rotation.y = r() * Math.PI;
      group.add(cap);
    }

    const surfMat = new MeshStandardMaterial({
      color: look.surface,
      roughness: look.foam ? 0.85 : 0.06,
      envMap: env,
      envMapIntensity: 1,
    });
    surfMat.envMapRotation.copy(envRot);
    const liquidSurface = new Mesh(pr.square ? discGeo.square : discGeo.round, surfMat);
    liquidSurface.name = 'liquidSurface';
    group.add(liquidSurface);

    group.add(createContactShadow(pr.maxR * (pr.square ? 1.1 : 1)));

    const hit = new Mesh(hitGeo(type), hitMat);
    hit.name = 'bottleHit';
    group.add(hit);

    const causticTint = new Color(look.caustic);
    const caustic = createCaustic(causticTint, pr.maxR, pr.height, world.sunDir, railZ);
    caustic.position.x = basePos.x;
    caustic.position.z = basePos.z;
    caustic.position.y += basePos.y;
    causticRoot.add(caustic);

    root.add(group);

    let fill = 0;
    const fillLocalY = () => pr.floorY + 0.002 + (pr.shoulderY - pr.floorY - 0.002) * fill;
    const bottle: Bottle = {
      id: i,
      type,
      group,
      meshes: { glass, labels, cap, liquidSurface, hit, caustic },
      tint,
      liquidColor,
      get fill() {
        return fill;
      },
      setFill(f: number) {
        fill = Math.min(1, Math.max(0, f));
        const on = fill > 0.001;
        const y = fillLocalY();
        uniforms.uFillY.value = on ? group.position.y + y : -1e3;
        uniforms.uSigmaLiquid.value.copy(on ? liquidSigma : new Vector3());
        uniforms.uInnerR.value = pr.innerR(Math.min(y, 0.06));
        liquidSurface.visible = on;
        const ri = pr.innerR(y) - 0.0002;
        liquidSurface.position.y = y;
        liquidSurface.scale.set(ri, 1, ri);
        depthMat.opacity = on ? 0.4 + 0.35 * fill : 0.4;
        (caustic.material as import('three').ShaderMaterial).uniforms.uFill.value = fill;
      },
      fillWorldY: () => group.position.y + fillLocalY(),
      label: { brand: LABEL_BRAND[type], texture: labelTex },
      radius: pr.maxR * (pr.square ? 1.15 : 1),
      height: pr.height + (cap ? 0.002 : 0),
      profile: pr,
      slot: basePos.clone(),
      alive: true,
      remove() {
        bottle.alive = false;
        group.visible = false;
        caustic.visible = false;
      },
      reset() {
        bottle.alive = true;
        group.visible = true;
        caustic.visible = true;
        group.position.copy(basePos);
        group.rotation.set(0, baseRotY, 0);
        bottle.setFill(spec.fill);
      },
    };
    bottle.setFill(spec.fill);
    bottles.push(bottle);
  });

  world.onUpdate((_dt, t) => {
    for (const b of bottles) {
      const m = b.meshes.caustic.material as import('three').ShaderMaterial;
      m.uniforms.uTime.value = t;
    }
  });

  return {
    bottles,
    root,
    /** Invisible low-poly proxies of alive bottles for Raycaster.intersectObjects. */
    raycastTargets: () => bottles.filter((b) => b.alive).map((b) => b.meshes.hit),
    /** Maps any hit object (proxy or bottle child) back to its bottle. */
    bottleFromObject(o: Object3D | null): Bottle | undefined {
      while (o) {
        const b = bottles.find((x) => x.group === o);
        if (b) return b;
        o = o.parent;
      }
      return undefined;
    },
    resetAll: () => bottles.forEach((b) => b.reset()),
  };
}

export type BottleSystem = ReturnType<typeof createBottles>;
