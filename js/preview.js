// three.js preview: the ported WindLight sky, a small island test scene and water.
// Everything renders into a half-float target; a final pass applies exposure,
// ACES tone mapping and scene gamma. It's an approximation of Firestorm's PBR
// renderer — Phase 7 calibrates it against in-world screenshots.

import { ATMOS_UNIFORMS, ATMOS_FUNCS, skyUniforms, skyIrradiance, makeCloudNoise } from './atmosphere.js';
import { WATER_PARAMS, toStored } from './params.js';

// Seabed / island shape, shared by the ground mesh (JS) and the water shader (GLSL).
const ISLAND = /* glsl */ `
float terrainHeight(vec2 p) {
  float r = length(p);
  return 1.2 - smoothstep(18.0, 44.0, r) * 7.2;
}`;
const terrainHeight = (x, z) => {
  const r = Math.hypot(x, z);
  const t = Math.min(1, Math.max(0, (r - 18) / 26));
  return 1.2 - t * t * (3 - 2 * t) * 7.2;
};

const SHADING = /* glsl */ `
uniform vec3 sky_irradiance;
uniform float probe_ambiance;
// How much sky irradiance one unit of Reflection Probe Ambiance adds. A guess
// until Phase 7 calibration; chosen so the Firestorm-suggested 2.0 looks balanced.
const float PROBE_SCALE = 0.3;
uniform vec4 spheres[4];

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// atmosphericsFuncs.glsl: a touch of light opposite the sun so shadows keep detail.
float ambientLighting(vec3 norm, vec3 light_dir) {
  float a = min(abs(dot(norm, light_dir)), 1.0) * 0.5;
  return 1.0 - a * a;
}

// Analytic soft shadows from the test spheres.
float sphereShadow(vec3 p, vec3 l) {
  float s = 1.0;
  for (int i = 0; i < 4; i++) {
    vec3 oc = spheres[i].xyz - p;
    float t = dot(oc, l);
    if (t <= 0.0) continue;
    float d = length(oc - l * t);
    s *= smoothstep(spheres[i].w * 0.85, spheres[i].w * 1.15 + t * 0.02, d);
  }
  return s;
}

// What the sky looks like from a surface in direction r, blurred toward
// the sky irradiance as roughness rises.
vec3 envRadiance(vec3 r, float roughness) {
  vec3 dir = normalize(vec3(r.x, max(r.y, 0.02), r.z));
  vec3 sky = srgb_to_linear(skyColor(dir));
  vec4 cl = cloudLayer(dir);
  sky = mix(sky, srgb_to_linear(cl.rgb), cl.a);
  vec3 env = mix(sky, sky_irradiance, clamp(sqrt(roughness) * 1.2, 0.0, 1.0));
  // Below the horizon the reflection sees ground, not sky.
  return mix(env, sky_irradiance * 0.25, smoothstep(0.0, -0.2, r.y));
}

float ggx(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159 * d * d);
}

// Firestorm in PBR mode (classic_mode = 0): amblit is greyed and linearised, both
// lights scaled by sky_sunlight_scale / sky_ambient_scale (1.5). Reflection probes
// add sky irradiance × Reflection Probe Ambiance.
vec3 shade(vec3 p, vec3 n, vec3 albedo, float roughness, float metallic) {
  vec3 v = normalize(cameraPosition - p);
  vec3 l = normalize(lightnorm);
  vec3 sunlit, amblit, additive, atten;
  calcAtmosphericVars(p - cameraPosition, l, sunlit, amblit, additive, atten);
  amblit *= ambientLighting(n, l);
  amblit = vec3(luminance(srgb_to_linear(amblit))) * 1.5;
  sunlit = srgb_to_linear(sunlit) * 1.5;
  vec3 irradiance = max(amblit, sky_irradiance * probe_ambiance * PROBE_SCALE);

  float NdotL = max(dot(n, l), 0.0) * step(0.0, l.y);
  float NdotV = clamp(dot(n, v), 0.001, 1.0);
  float shadow = sphereShadow(p + n * 0.01, l);
  vec3 h = normalize(l + v);
  float a = max(roughness * roughness, 0.002);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 F = f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - NdotV, 5.0);

  vec3 diffuse = albedo * (1.0 - metallic) * (sunlit * NdotL * shadow + irradiance);
  vec3 spec = F * envRadiance(reflect(-v, n), roughness);
  spec += sunlit * shadow * NdotL * ggx(max(dot(n, h), 0.0), a) * F * 0.25 / max(NdotV, 0.1);
  vec3 color = diffuse * (1.0 - F * (1.0 - metallic)) + spec;
  return color * atten + srgb_to_linear(additive * 2.0);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  gl_Position.z = gl_Position.w; // always at the far plane
}`;

const SKY_FRAG = /* glsl */ `
${ATMOS_UNIFORMS}
${ATMOS_FUNCS}
varying vec3 vWorld;
void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  vec3 sky = skyColor(dir);
  vec4 cl = cloudLayer(dir);
  vec3 c = sky + heavenlyBodies(dir, sky) * (1.0 - cl.a);
  c = mix(c, cl.rgb, cl.a);
  gl_FragColor = vec4(srgb_to_linear(c), 1.0);
}`;

const SURFACE_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SURFACE_FRAG = /* glsl */ `
${ATMOS_UNIFORMS}
${ATMOS_FUNCS}
${SHADING}
uniform vec3 albedo;
uniform float roughness;
uniform float metallic;
uniform bool terrain;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 base = albedo;
  if (terrain) {
    // Grass on top, sand toward the water, darker wet sand below it.
    vec3 grass = vec3(0.07, 0.11, 0.04);
    vec3 sand = vec3(0.36, 0.32, 0.24);
    base = mix(sand, grass, smoothstep(0.6, 1.1, vWorld.y));
    base *= mix(0.6, 1.0, smoothstep(-0.3, 0.1, vWorld.y));
  }
  gl_FragColor = vec4(shade(vWorld, normalize(vNormal), base, roughness, metallic), 1.0);
}`;

const WATER_FRAG = /* glsl */ `
${ATMOS_UNIFORMS}
${ATMOS_FUNCS}
${SHADING}
${ISLAND}
uniform vec3 fog_color;
uniform float fog_density;
uniform float fresnel_scale;
uniform float fresnel_offset;
uniform float scale_above;
uniform float blur;
uniform vec2 wave1;
uniform vec2 wave2;
uniform vec3 norm_scale;
uniform float time;
varying vec3 vWorld;

vec2 slope(vec2 uv) {
  float e = 1.0 / 512.0;
  return vec2(cloudNoise(uv + vec2(e, 0.0)) - cloudNoise(uv - vec2(e, 0.0)),
              cloudNoise(uv + vec2(0.0, e)) - cloudNoise(uv - vec2(0.0, e))) / (2.0 * e);
}

void main() {
  vec3 p = vWorld;
  vec3 toEye = cameraPosition - p;
  float dist = length(toEye);
  vec3 v = toEye / dist;

  // Two scrolling wave layers plus detail, like the viewer's bump map lookups.
  vec2 s1 = slope(p.xz * 0.015 + wave1 * time * 0.004);
  vec2 s2 = slope(p.xz * 0.05 + wave2 * time * 0.006);
  vec2 s3 = slope(p.xz * 0.2 + (wave1 + wave2) * time * 0.01);
  vec2 s = (s1 + s2 * 0.4 + s3 * 0.6) * 0.5 * 0.15; // the noise is low-contrast (0.4), so slopes are scaled up
  vec3 n = normalize(vec3(-s.x * norm_scale.x, max(norm_scale.z, 0.05) * 0.5, -s.y * norm_scale.y));
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(80.0, 3000.0, dist)));

  vec3 l = normalize(lightnorm);
  vec3 sunlit, amblit, additive, atten;
  calcAtmosphericVars(p - cameraPosition, l, sunlit, amblit, additive, atten);
  amblit = vec3(luminance(srgb_to_linear(amblit))) * 1.5;
  sunlit = srgb_to_linear(sunlit) * 1.5;
  vec3 irradiance = max(amblit, sky_irradiance * probe_ambiance * PROBE_SCALE);

  // waterF.glsl: df = dot(viewVec, wave) * fresnelScale + fresnelOffset, squared and summed.
  float df = max(0.0, dot(-v, n) * fresnel_scale + fresnel_offset);
  float reflectance = min(1.0, 3.0 * df * df);
  vec3 radiance = envRadiance(reflect(-v, n), blur) * df * 2.0;

  // Refraction: seabed seen through the water, fogged by depth (waterFogF.glsl, D = 0.98^(l·kd)).
  vec2 bed = p.xz + n.xz * scale_above * 20.0;
  float depth = max(0.0, -terrainHeight(bed));
  float path = depth / max(v.y, 0.08);
  float D = pow(0.98, path * fog_density);
  vec3 sand = vec3(0.30, 0.27, 0.20) * (sunlit * max(l.y, 0.0) * 0.8 + irradiance);
  vec3 fog = srgb_to_linear(fog_color) * (sunlit * max(l.y, 0.0) * 0.5 + irradiance);
  vec3 refracted = mix(fog, sand, D * step(0.001, depth));
  if (depth <= 0.001) refracted = sand;

  vec3 h = normalize(l + v);
  float a = max(blur, 0.03);
  float glint = ggx(max(dot(n, h), 0.0), a * a) * 0.02 * step(0.0, l.y);
  vec3 punctual = min(sunlit * glint * max(dot(n, l), 0.0), vec3(10.0));

  vec3 color = mix(refracted, radiance, reflectance) + punctual;
  color = color * atten + srgb_to_linear(additive * 2.0);
  // Soft shoreline.
  float shore = smoothstep(0.0, 0.15, depth);
  gl_FragColor = vec4(color, shore);
}`;

const POST_FRAG = /* glsl */ `
uniform sampler2D tex;
uniform float exposure;
uniform float gamma;
varying vec2 vUv;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 linear_to_srgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec3 c = texture2D(tex, vUv).rgb * exposure;
  c = aces(c);
  c = pow(c, vec3(1.0 / max(gamma, 0.05)));
  gl_FragColor = vec4(linear_to_srgb(c), 1.0);
}`;

export async function createPreview(container) {
  const THREE = await import('three');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  container.prepend(renderer.domElement);

  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 40000);
  camera.position.set(15, 3.4, 13);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2, 0);
  controls.enableDamping = true;
  controls.minDistance = 3;
  controls.maxDistance = 150;
  controls.maxPolarAngle = Math.PI * 0.55;

  // Cloud noise doubles as the water bump map.
  const noise = makeCloudNoise(512);
  const noiseTex = new THREE.DataTexture(noise.data, noise.size, noise.size, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.needsUpdate = true;

  // One shared uniform set: every material sees the same sky.
  const atmos = {
    lightnorm: { value: new THREE.Vector3(0, 1, 0) },
    sun_dir: { value: new THREE.Vector3(0, 1, 0) },
    moon_dir: { value: new THREE.Vector3(0, -1, 0) },
    sun_up_factor: { value: 1 },
    sunlight_color: { value: new THREE.Vector3() },
    moonlight_color: { value: new THREE.Vector3() },
    ambient_color: { value: new THREE.Vector3() },
    blue_horizon: { value: new THREE.Vector3() },
    blue_density: { value: new THREE.Vector3() },
    haze_horizon: { value: 0 },
    haze_density: { value: 0 },
    cloud_shadow: { value: 0 },
    density_multiplier: { value: 0 },
    distance_multiplier: { value: 1 },
    max_y: { value: 1605 },
    glow: { value: new THREE.Vector3() },
    sun_moon_glow_factor: { value: 1 },
    cloud_color: { value: new THREE.Vector3() },
    cloud_pos_density1: { value: new THREE.Vector3() },
    cloud_pos_density2: { value: new THREE.Vector3() },
    cloud_scale: { value: 0.42 },
    cloud_offset: { value: new THREE.Vector2() },
    star_brightness: { value: 0 },
    moon_brightness: { value: 0.5 },
    cloud_noise: { value: noiseTex },
    sky_irradiance: { value: new THREE.Vector3() },
    probe_ambiance: { value: 2 },
    spheres: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, -100, 0, 0)) },
  };

  // ---- Sky dome ----
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(20000, 64, 32),
    new THREE.ShaderMaterial({ uniforms: atmos, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // ---- Island and test objects ----
  const surface = (props) => new THREE.ShaderMaterial({
    uniforms: {
      ...atmos,
      albedo: { value: new THREE.Color(...(props.albedo ?? [0.5, 0.5, 0.5])) },
      roughness: { value: props.roughness ?? 0.6 },
      metallic: { value: props.metallic ?? 0 },
      terrain: { value: !!props.terrain },
    },
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
  });

  const groundGeo = new THREE.CircleGeometry(48, 160, 0, Math.PI * 2);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, terrainHeight(gp.getX(i), gp.getZ(i)));
  groundGeo.computeVertexNormals();
  scene.add(new THREE.Mesh(groundGeo, surface({ terrain: true, roughness: 0.9 })));

  const SPHERES = [
    { pos: [0, 1.2, 0], r: 1.2, albedo: [0.95, 0.93, 0.88], roughness: 0.05, metallic: 1, label: 'chrome' },
    { pos: [-3.2, 0.8, 1.5], r: 0.8, albedo: [0.18, 0.18, 0.18], roughness: 0.7, label: '18% grey' },
    { pos: [2.8, 0.8, 2.6], r: 0.8, albedo: [0.5, 0.5, 0.5], roughness: 0.5, label: '50% grey' },
    { pos: [-1.0, 0.6, 3.8], r: 0.6, albedo: [0.85, 0.85, 0.85], roughness: 0.9, label: 'white' },
  ];
  SPHERES.forEach((s, i) => {
    const y = terrainHeight(s.pos[0], s.pos[2]) + s.r;
    const m = new THREE.Mesh(new THREE.SphereGeometry(s.r, 64, 32), surface(s));
    m.position.set(s.pos[0], y, s.pos[2]);
    scene.add(m);
    atmos.spheres.value[i].set(s.pos[0], y, s.pos[2], s.r);
  });

  // ---- Water ----
  const waterUniforms = {
    ...atmos,
    fog_color: { value: new THREE.Vector3() },
    fog_density: { value: 2 },
    fresnel_scale: { value: 0.4 },
    fresnel_offset: { value: 0.5 },
    scale_above: { value: 0.03 },
    blur: { value: 0.04 },
    wave1: { value: new THREE.Vector2() },
    wave2: { value: new THREE.Vector2() },
    norm_scale: { value: new THREE.Vector3(2, 2, 2) },
    time: { value: 0 },
  };
  const waterGeo = new THREE.PlaneGeometry(30000, 30000, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, new THREE.ShaderMaterial({
    uniforms: waterUniforms, vertexShader: SURFACE_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: false,
  }));
  water.renderOrder = 1;
  scene.add(water);

  // ---- Final pass ----
  const post = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { tex: { value: rt.texture }, exposure: { value: 1 }, gamma: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
    }),
  );
  const postScene = new THREE.Scene();
  postScene.add(post);
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---- State ----
  let animate = true;
  let scroll = [0, 0];
  let targetExposure = 1;
  let exposure = 1;
  let info = null;

  function setSky(values) {
    const u = skyUniforms(values);
    const v3 = (k, a) => atmos[k].value.set(a[0], a[1], a[2]);
    v3('lightnorm', u.lightnorm);
    v3('sun_dir', u.sunDir);
    v3('moon_dir', u.moonDir);
    atmos.sun_up_factor.value = u.sunUp ? 1 : 0;
    v3('sunlight_color', u.sunlight);
    v3('moonlight_color', u.moonlight);
    v3('ambient_color', u.ambient);
    v3('blue_horizon', u.blueHorizon);
    v3('blue_density', u.blueDensity);
    atmos.haze_horizon.value = u.hazeHorizon;
    atmos.haze_density.value = u.hazeDensity;
    atmos.cloud_shadow.value = u.cloudShadow;
    atmos.density_multiplier.value = u.densityMultiplier;
    atmos.distance_multiplier.value = u.distanceMultiplier;
    atmos.max_y.value = u.maxY;
    v3('glow', u.glow);
    atmos.sun_moon_glow_factor.value = u.sunMoonGlowFactor;
    v3('cloud_color', u.cloudColor);
    v3('cloud_pos_density1', u.cloudPosDensity1);
    v3('cloud_pos_density2', u.cloudPosDensity2);
    atmos.cloud_scale.value = u.cloudScale;
    scroll = u.cloudScroll;
    atmos.star_brightness.value = u.starBrightness;
    atmos.moon_brightness.value = u.moonBrightness;
    atmos.probe_ambiance.value = u.probeAmbiance;
    const irr = skyIrradiance(u);
    v3('sky_irradiance', irr);
    post.material.uniforms.gamma.value = u.gamma;
    // Auto exposure is on when ambiance > 0 and clamps to the viewer's HDR range (0.5–2).
    // Rough scene brightness: sun on a level surface plus probe ambient.
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const sunLin = (u.sunUp ? u.sunlight : u.moonlight).map((c) => Math.pow(Math.max(c, 0), 2.2) * 1.5);
    const scene = lum(sunLin) * Math.max(u.lightnorm[1], 0) + lum(irr) * u.probeAmbiance * 0.3;
    targetExposure = u.probeAmbiance > 0 ? Math.min(2, Math.max(0.5, 0.45 / Math.max(scene, 1e-4))) : 1;
    info = { sunUp: u.sunUp, exposure: targetExposure };
  }

  function setWater(values) {
    const s = (id) => toStored(WATER_PARAMS.find((p) => p.id === id), values[id]);
    waterUniforms.fog_color.value.set(...values.fogColor);
    waterUniforms.fog_density.value = s('fogDensity');
    waterUniforms.fresnel_scale.value = s('fresnelScale');
    waterUniforms.fresnel_offset.value = s('fresnelOffset');
    waterUniforms.scale_above.value = s('scaleAbove');
    waterUniforms.blur.value = s('blur');
    waterUniforms.wave1.value.set(values.wave1X, values.wave1Y);
    waterUniforms.wave2.value.set(values.wave2X, values.wave2Y);
    waterUniforms.norm_scale.value.set(values.normScaleX, values.normScaleY, values.normScaleZ);
  }

  // ---- Loop ----
  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    const pr = renderer.getPixelRatio();
    rt.setSize(Math.round(w * pr), Math.round(h * pr));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const clock = new THREE.Clock();
  let t = 0;
  let cloudShift = [0, 0];
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (animate) {
      t += dt;
      // The viewer advances cloud positions by scroll rate over time; 0.01/s is a guess.
      cloudShift = [cloudShift[0] + scroll[0] * dt * 0.01, cloudShift[1] + scroll[1] * dt * 0.01];
    }
    waterUniforms.time.value = t;
    atmos.cloud_offset.value.set(cloudShift[0], cloudShift[1]);
    exposure += (targetExposure - exposure) * Math.min(1, dt * 3);
    post.material.uniforms.exposure.value = exposure;
    sky.position.copy(camera.position);
    controls.update();
    if (camera.position.y < 0.4) camera.position.y = 0.4;

    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
  });

  return {
    setSky,
    setWater,
    setAnimate(on) { animate = on; },
    info: () => info,
    // Point the camera toward the sun (or moon) so its glow is in view.
    faceLight() {
      controls.target.set(0, 2, 0);
      controls.maxPolarAngle = Math.PI * 0.55;
      const l = atmos.lightnorm.value;
      const flat = new THREE.Vector3(l.x, 0, l.z).normalize();
      if (!Number.isFinite(flat.x)) return;
      const d = Math.max(8, camera.position.distanceTo(controls.target));
      camera.position.copy(controls.target).addScaledVector(flat, -Math.min(d, 20)).setY(3.4);
    },
    // Stand on the island and look up at the clouds; drag to look around from there.
    lookUp() {
      camera.position.set(6, 2.2, 6);
      const forward = new THREE.Vector3(-1, 0, -1).normalize();
      controls.target.copy(camera.position).addScaledVector(forward, 3).add(new THREE.Vector3(0, 4, 0));
      controls.maxPolarAngle = Math.PI * 0.97; // the camera sits below its target here
    },
    canvas: renderer.domElement,
  };
}
