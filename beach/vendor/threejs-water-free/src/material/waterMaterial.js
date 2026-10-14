/**
 * The water surface material — a fully analytic TSL node material.
 *
 * Vertex: sum the FFT displacement cascades + analytical Gerstner swell to
 * displace the flat grid into a moving ocean surface.
 *
 * Fragment (the part that sells realism): rather than an opaque colour, the
 * surface is *transparent* and reconstructs what you actually see looking into
 * water —
 *   • Screen-space refraction — samples the already-rendered scene behind the
 *     surface (`viewportSharedTexture`) offset by the wave normal, so the
 *     seabed and submerged rocks warp with the ripples.
 *   • Beer–Lambert absorption — the water column depth (from the depth buffer)
 *     drives per-channel light extinction toward an intrinsic water colour, so
 *     shallow water reveals the bright sand and deep water turns it teal/blue.
 *   • Fresnel sky reflection — a physically-derived curve blends the refracted
 *     underwater colour with the reflected procedural sky.
 *   • Dynamic foam — Jacobian wave-crest foam plus a depth-gated shoreline band
 *     broken up by animated noise where water meets rock and sand.
 */
import { MeshBasicNodeMaterial, DoubleSide, Color, Vector2, Vector3 } from 'three/webgpu';
import {
  Fn,
  vec2,
  vec3,
  vec4,
  float,
  uniform,
  texture,
  positionLocal,
  positionWorld,
  positionView,
  cameraPosition,
  cameraNear,
  cameraFar,
  screenUV,
  viewportSharedTexture,
  viewportDepthTexture,
  perspectiveDepthToViewZ,
  normalize,
  length,
  dot,
  reflect,
  max,
  pow,
  mix,
  clamp,
  step,
  smoothstep,
  sin,
  cos,
  exp,
  sign,
} from 'three/tsl';
import { skyColor } from './sky.js';
import { fbm } from './noise.js';

// Schlick's Fresnel approximation.
const fresnelSchlick = /*#__PURE__*/ Fn(([cosTheta, f0]) => {
  const m = clamp(float(1.0).sub(cosTheta), 0.0, 1.0);
  const m2 = m.mul(m);
  return f0.add(float(1.0).sub(f0).mul(m2.mul(m2).mul(m)));
});

// Turbulent foam texture in [0,1]. Domain-warped and combined across two
// non-harmonic, rotated scales so it never visibly tiles, with a finer octave
// for the bubbly/lacey structure. `p` is world XZ in metres, `t` is time.
const foamPattern = /*#__PURE__*/ Fn(([p, t]) => {
  // Warp the lookup with a low-frequency field — destroys grid alignment.
  const warp = vec2(
    fbm(p.mul(0.06).add(vec2(t.mul(0.02), 0.0))),
    fbm(p.mul(0.06).add(vec2(3.7, 1.2)))
  ).sub(0.5).mul(9.0);
  const q = p.add(warp);
  const flow = vec2(t.mul(0.05), t.mul(0.037));
  const a = fbm(q.mul(0.12).add(flow));
  // Second scale rotated ~37° and non-harmonic to break repetition.
  const r = vec2(q.x.mul(0.8).sub(q.y.mul(0.6)), q.x.mul(0.6).add(q.y.mul(0.8)));
  const b = fbm(r.mul(0.052).sub(flow.mul(0.6)));
  const macro = a.mul(0.6).add(b.mul(0.4));
  const detail = fbm(q.mul(0.5).add(flow.mul(2.0)));
  return clamp(macro.mul(0.85).add(detail.mul(0.3)), 0.0, 1.0);
});

export function createWaterMaterial({ ocean, skyUniforms, timeNode, preset = {}, features = {} }) {
  // Feature flags from the quality level compile expensive paths in or out.
  const F = {
    refraction: features.refraction !== false,
    foamDetail: features.foamDetail !== false,
    clouds: features.clouds !== false,
    detail: features.detail ?? preset.detailStrength ?? 0.5,
    sparkle: features.sparkle ?? preset.sparkleStrength ?? 2.6,
  };
  const absorption = preset.absorptionColor ?? [0.3, 0.1, 0.06];
  const u = {
    origin: uniform(new Vector2(0, 0)),
    waterColor: uniform(new Color(preset.waterColor ?? 0x0a3a52)),
    extinction: uniform(new Vector3(absorption[0], absorption[1], absorption[2])),
    foamColor: uniform(new Color(preset.foamColor ?? 0xffffff)),
    sssColor: uniform(new Color(preset.sssColor ?? 0x117a5e)),
    fresnelF0: uniform(preset.fresnelF0 ?? 0.02),
    refractionStrength: uniform(preset.refractionStrength ?? 1.0),
    shoreDepth: uniform(preset.shoreDepth ?? 1.6),
    shoreFoamStrength: uniform(preset.shoreFoamStrength ?? 1.0),
    foamScale: uniform(preset.foamScale ?? 2.0),
    crestFoam: uniform(preset.crestFoam ?? 0.5),
    sunShininess: uniform(preset.sunShininess ?? 600),
    sssStrength: uniform(preset.sssStrength ?? 0.6),
    detailStrength: uniform(F.detail),
    sparkleStrength: uniform(F.sparkle),
    submerged: uniform(0),
  };

  const cascades = ocean.cascades.map((c, i) => ({
    patchSize: c.patchSize,
    disp: texture(ocean.displacementTextures[i]),
    slope: texture(ocean.slopeTextures[i]),
  }));

  const worldXZ = positionLocal.xz.add(u.origin);

  // ---- Vertex displacement -------------------------------------------------
  const displacement = Fn(() => {
    const d = vec3(0).toVar();
    for (const c of cascades) {
      const s = c.disp.sample(worldXZ.div(c.patchSize));
      d.addAssign(vec3(s.x, s.y, s.z));
    }
    for (const g of ocean.gerstner) {
      const phase = float(g.k)
        .mul(float(g.dirX).mul(worldXZ.x).add(float(g.dirY).mul(worldXZ.y)))
        .sub(timeNode.mul(g.omega));
      const a = float(g.amplitude);
      const st = float(g.steepness);
      d.addAssign(
        vec3(
          st.mul(a).mul(g.dirX).mul(cos(phase)),
          a.mul(sin(phase)),
          st.mul(a).mul(g.dirY).mul(cos(phase))
        )
      );
    }
    return d;
  })();

  const positionNode = positionLocal.add(displacement);

  // ---- Surface normal from slopes -----------------------------------------
  const slopeSum = Fn(() => {
    const s = vec2(0).toVar();
    for (const c of cascades) {
      s.addAssign(c.slope.sample(worldXZ.div(c.patchSize)).xy);
    }
    for (const g of ocean.gerstner) {
      const phase = float(g.k)
        .mul(float(g.dirX).mul(worldXZ.x).add(float(g.dirY).mul(worldXZ.y)))
        .sub(timeNode.mul(g.omega));
      const dcos = float(g.amplitude).mul(g.k).mul(cos(phase));
      s.addAssign(vec2(float(g.dirX).mul(dcos), float(g.dirY).mul(dcos)));
    }
    return s;
  })();

  const foamMask = Fn(() => {
    const f = float(0).toVar();
    for (const c of cascades) {
      f.addAssign(c.disp.sample(worldXZ.div(c.patchSize)).w);
    }
    return f;
  })();

  // ---- Shading -------------------------------------------------------------
  const colorNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld));

    // Distance to the fragment — flattens the normal and fades sparkle far away
    // to remove specular aliasing on the horizon.
    const dist = length(cameraPosition.sub(positionWorld));
    const flat = clamp(dist.mul(0.0007), 0.0, 0.85);

    // Surface normal, optionally perturbed by an animated FBM detail normal.
    let sx = slopeSum.x;
    let sz = slopeSum.y;
    if (F.detail > 0) {
      const detailUV = worldXZ.mul(0.5).add(vec2(timeNode.mul(0.25), timeNode.mul(0.18)));
      const dC = fbm(detailUV);
      const dX = fbm(detailUV.add(vec2(0.2, 0.0)));
      const dZ = fbm(detailUV.add(vec2(0.0, 0.2)));
      const detail = vec2(dX.sub(dC), dZ.sub(dC)).mul(u.detailStrength).mul(flat.oneMinus());
      sx = sx.add(detail.x);
      sz = sz.add(detail.y);
    }
    const Nwave = normalize(vec3(sx.negate(), 1.0, sz.negate()));
    const Nflat = normalize(mix(Nwave, vec3(0.0, 1.0, 0.0), flat));
    const N = normalize(Nflat.mul(sign(dot(Nflat, V)).add(0.0001))); // face the viewer
    const cosNV = max(dot(N, V), 0.0);

    // Water column depth from the depth buffer (view-space distance).
    const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(screenUV), cameraNear, cameraFar);
    const surfaceZ = positionView.z;
    const waterDepth = surfaceZ.sub(sceneZ).max(0.0);

    // Transmission: full screen-space refraction, or a single straight sample.
    let sceneColor;
    let depthR;
    if (F.refraction) {
      const offsetAmt = clamp(waterDepth.mul(0.05), 0.0, 1.0).mul(u.refractionStrength).mul(0.06);
      const refractUV = screenUV.add(N.xz.mul(offsetAmt));
      const sceneZR = perspectiveDepthToViewZ(viewportDepthTexture(refractUV), cameraNear, cameraFar);
      const validR = step(sceneZR, surfaceZ); // refracted sample must be behind the surface
      sceneColor = mix(viewportSharedTexture(screenUV), viewportSharedTexture(refractUV), validR);
      depthR = mix(waterDepth, surfaceZ.sub(sceneZR).max(0.0), validR);
    } else {
      sceneColor = viewportSharedTexture(screenUV);
      depthR = waterDepth;
    }

    // Beer–Lambert absorption toward the intrinsic water colour.
    const absorb = exp(u.extinction.mul(depthR).negate());
    const underwaterColor = sceneColor.rgb.mul(absorb).add(u.waterColor.mul(absorb.oneMinus()));

    // Subsurface scattering — light through back-lit crests.
    const sunDir = skyUniforms.sunDirection;
    const back = max(dot(V, sunDir.negate()), 0.0);
    const sss = u.sssColor
      .mul(pow(back, float(3.0)))
      .mul(smoothstep(-0.3, 1.0, positionWorld.y))
      .mul(u.sssStrength)
      .mul(skyUniforms.sunIntensity);
    const body = underwaterColor.add(sss);

    // Fresnel sky reflection + sun specular.
    const fres = clamp(fresnelSchlick(cosNV, u.fresnelF0), 0.0, 1.0);
    const R = reflect(V.negate(), N);
    const reflSky = skyColor(R, skyUniforms, timeNode, F.clouds);
    const spec = pow(max(dot(R, sunDir), 0.0), u.sunShininess)
      .mul(skyUniforms.sunColor)
      .mul(skyUniforms.sunIntensity)
      .mul(2.0);

    let surface = mix(body, reflSky, fres).add(spec);
    if (F.sparkle > 0) {
      // Sun glitter — sparse high-frequency glints near the sun's reflection.
      const sparkleN = fbm(worldXZ.mul(2.2).add(vec2(timeNode.mul(0.7), timeNode.mul(-0.55))));
      const sparkle = step(0.66, sparkleN)
        .mul(pow(max(dot(R, sunDir), 0.0), float(90.0)))
        .mul(u.sparkleStrength)
        .mul(skyUniforms.sunIntensity)
        .mul(flat.oneMinus());
      surface = surface.add(skyUniforms.sunColor.mul(sparkle));
    }

    // ---- Foam ---------------------------------------------------------------
    const surge = sin(timeNode.mul(1.4).sub(waterDepth.mul(0.9))).mul(0.5).add(0.5);
    const shoreProx = smoothstep(u.shoreDepth, float(0.0), waterDepth);
    const shoreDensity = shoreProx.mul(surge.mul(0.5).add(0.6)).mul(u.shoreFoamStrength);
    const heightDensity = smoothstep(float(0.7), float(1.05), positionWorld.y.mul(0.18).add(0.5)).mul(u.crestFoam);

    let foam;
    let foamCol;
    if (F.foamDetail) {
      // Turbulent multi-scale foam texture, eroded by the foam density so edges
      // are organic and never tile with the FFT patch.
      const ft = foamPattern(worldXZ, timeNode);
      const crestDensity = foamMask.mul(u.foamScale).mul(ft.mul(0.6).add(0.7));
      const density = clamp(shoreDensity.add(crestDensity).add(heightDensity), 0.0, 1.4);
      const thr = clamp(float(1.0).sub(density.mul(0.9)), 0.05, 1.0);
      foam = smoothstep(thr, thr.add(0.22), ft);
      foamCol = u.foamColor.mul(ft.mul(0.28).add(0.8));
    } else {
      // Cheap foam: a single noise octave for slight breakup.
      const ftc = fbm(worldXZ.mul(0.12).add(vec2(timeNode.mul(0.05), 0.0)));
      const crestDensity = foamMask.mul(u.foamScale);
      const density = clamp(shoreDensity.add(crestDensity).add(heightDensity), 0.0, 1.4);
      const thr = clamp(float(1.0).sub(density.mul(0.95)), 0.05, 1.0);
      foam = smoothstep(thr, thr.add(0.3), ftc);
      foamCol = u.foamColor;
    }
    const withFoam = mix(surface, foamCol, foam);

    // Underwater view (camera submerged).
    const underTint = mix(u.waterColor, reflSky.mul(0.5), fres.mul(0.5));
    return vec4(mix(withFoam, underTint, u.submerged), 1.0);
  })();

  const material = new MeshBasicNodeMaterial();
  material.side = DoubleSide;
  material.transparent = true; // draw after opaque scene so refraction can read it
  material.depthWrite = false;
  material.positionNode = positionNode;
  material.colorNode = colorNode;

  return { material, uniforms: u };
}
