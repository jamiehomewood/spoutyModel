// spoutyModel - show a 3D model inside the Igloo room and handle it.
//
//   index.html               operator view: you stand in the middle of the room and turn your head;
//                            tap the model (or Tab) to handle it. Works on the room tablet too.
//   index.html?view=igloo    output for an Igloo web layer: a 2:1 equirectangular 360 image (set the layer to 4096 x 2048).
//
// When served by serve.py every open page shares one state (model, pose, cutaway...), so the tablet
// drives what the Igloo layer shows. Opened any other way it just works on its own.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const qs = new URLSearchParams(location.search);
const VIEW = qs.get('view') === 'igloo' ? 'igloo' : 'preview';
const CUBE = Math.min(4096, Math.max(256, +qs.get('cube') || 2048));
document.body.classList.add(VIEW);

const WALL_YAW = { front: 0, right: -Math.PI / 2, back: Math.PI, left: Math.PI / 2 };
const BACKDROP = { dark: 0x0e0f12, light: 0xe2e2df };
const MODEL_EXT = ['glb', 'gltf', 'obj', 'fbx', 'stl'];
const DEFAULT_MODEL = { src: 'models/furosemide_box.glb', name: 'Furosemide 40 mg box' };
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const Y = AXES.y, X = AXES.x;
const UNITS = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };

const defaults = () => ({
  rev: 0,
  room: { w: 6.40, d: 5.71, h: 2.244, proj: null, eye: 1.6 },
  backdrop: 'dark',
  exposure: 1,
  model: { ...DEFAULT_MODEL },
  kind: 'object',                // 'object' = handle it in front of a wall, 'environment' = stand inside it
  place: { wall: 'front', dist: 1.9, x: 0, y: 1.35 },
  xf: { q: [0, 0, 0, 1], s: 1 },
  spin: false,
  cut: { on: false, axis: 'z', pos: 0, flip: false },
  env: { units: 'auto', floor: 0, yaw: 0, x: null, z: null },   // x/z: where you stand, in the model (metres)
  hidden: [],
});

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const k of Object.keys(base)) {
    if (!(k in over)) continue;
    const b = base[k], o = over[k];
    if (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object') merge(b, o);
    else base[k] = o;
  }
  return base;
}

function loadLocal() {
  try { const j = localStorage.getItem('spoutyModel.state'); return j ? merge(defaults(), JSON.parse(j)) : null; }
  catch { return null; }
}
let saveTimer = 0;
function saveLocal() {
  if (VIEW !== 'preview') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const s = { ...S, model: S.model.src.startsWith('blob:') ? { ...DEFAULT_MODEL } : S.model };
      localStorage.setItem('spoutyModel.state', JSON.stringify(s));
      localStorage.setItem('spoutyModel.edges', local.edges ? '1' : '0');
    } catch { /* storage unavailable - fine */ }
  }, 400);
}

let S = (VIEW === 'preview' && loadLocal()) || defaults();
const local = {
  mode: 'look', yaw: 0, pitch: 0, fov: 75, spin: 0, interacting: false,
  edges: (() => { try { return localStorage.getItem('spoutyModel.edges') !== '0'; } catch { return true; } })(),
};
const projH = () => (S.room.proj ?? S.room.h / 2);
const wallDist = (wall) => (wall === 'left' || wall === 'right' ? S.room.w / 2 : S.room.d / 2);

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: VIEW === 'preview', powerPreference: 'high-performance' });
renderer.setPixelRatio(VIEW === 'igloo' ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.localClippingEnabled = true;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('stage').appendChild(renderer.domElement);

// ------------------------------------------------------------------ the virtual world (what Igloo projects)
const world = new THREE.Scene();
world.background = new THREE.Color(BACKDROP.dark);
const pmrem = new THREE.PMREMGenerator(renderer);
world.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
world.environmentIntensity = 0.75;

const anchor = new THREE.Group();          // sits in front of a wall, +Z facing the room centre
const pivot = new THREE.Group();           // your rotation + size
anchor.add(pivot);
world.add(anchor);

// Environment mode: the model at real size, turned and slid so the spot you stand on is the room centre.
const envRoot = new THREE.Group();         // turn + floor height, origin = where you stand
const envOffset = new THREE.Group();       // slides the model so your stand point is at the origin
const envScale = new THREE.Group();        // units -> metres
envRoot.add(envOffset); envOffset.add(envScale); world.add(envRoot);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);   // shines from the room centre onto the model
keyLight.target = anchor;
world.add(keyLight);
const fillLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0);   // used in environment mode
world.add(fillLight);

const cubeRT = new THREE.WebGLCubeRenderTarget(CUBE, { type: THREE.HalfFloatType, generateMipmaps: false });
const cubeCam = new THREE.CubeCamera(0.02, 500, cubeRT);   // the projection centre
world.add(cubeCam);

const cutPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
const clipList = [cutPlane];

let content = null;        // fitted holder of the loaded model (largest side = 1 m before your size)
let parts = [];            // [{ name, meshes: [], mats: [] }]
let loaded = null;         // { obj, box (model's own units), pos0 } of the current model
let mountedKind = null;

// ------------------------------------------------------------------ preview: the room, lit by the projection
const ROOM_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const ROOM_FRAG = /* glsl */`
uniform samplerCube cube;
uniform vec3 proj, rmin, rmax, edgeColor;
uniform float edgeW, edgeA;
varying vec3 vW;
void main() {
  vec3 col = textureCube(cube, normalize(vW - proj)).rgb;
  if (vW.y > rmax.y - 0.002) col = vec3(0.015);                 // the real ceiling isn't projected
  if (edgeA > 0.0) {
    vec3 a = min(abs(vW - rmin), abs(rmax - vW));
    float n = step(a.x, edgeW) + step(a.y, edgeW) + step(a.z, edgeW);
    if (n >= 2.0) col = mix(col, edgeColor, edgeA);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const EQ_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const EQ_FRAG = /* glsl */`
uniform samplerCube cube;
varying vec2 vUv;
const float PI = 3.14159265359;
void main() {
  float lon = (vUv.x - 0.5) * 2.0 * PI;     // image centre = front wall, right of centre = right wall
  float lat = (vUv.y - 0.5) * PI;
  vec3 d = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));
  gl_FragColor = vec4(textureCube(cube, d).rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

let viewScene, eyeCam, roomMesh, roomMat, eqScene, eqCam;
if (VIEW === 'preview') {
  viewScene = new THREE.Scene();
  eyeCam = new THREE.PerspectiveCamera(local.fov, innerWidth / innerHeight, 0.02, 60);
  eyeCam.rotation.order = 'YXZ';
  roomMat = new THREE.ShaderMaterial({
    uniforms: {
      cube: { value: cubeRT.texture }, proj: { value: new THREE.Vector3() },
      rmin: { value: new THREE.Vector3() }, rmax: { value: new THREE.Vector3() },
      edgeColor: { value: new THREE.Color(1, 1, 1) }, edgeW: { value: 0.006 }, edgeA: { value: 0.3 },
    },
    vertexShader: ROOM_VERT, fragmentShader: ROOM_FRAG, side: THREE.BackSide,
  });
  roomMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), roomMat);
  viewScene.add(roomMesh);
} else {
  eqScene = new THREE.Scene();
  eqCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const eqMat = new THREE.ShaderMaterial({ uniforms: { cube: { value: cubeRT.texture } },
    vertexShader: EQ_VERT, fragmentShader: EQ_FRAG, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), eqMat);
  quad.frustumCulled = false;
  eqScene.add(quad);
}

let roomKey = '';
function applyRoom() {
  const r = S.room, k = `${r.w}|${r.d}|${r.h}`;
  if (VIEW !== 'preview' || k === roomKey) return;
  roomKey = k;
  roomMesh.geometry.dispose();
  roomMesh.geometry = new THREE.BoxGeometry(r.w, r.h, r.d);
  roomMesh.position.set(0, r.h / 2, 0);
  roomMat.uniforms.rmin.value.set(-r.w / 2, 0, -r.d / 2);
  roomMat.uniforms.rmax.value.set(r.w / 2, r.h, r.d / 2);
}

// ------------------------------------------------------------------ models
const gltfLoader = new GLTFLoader()
  .setDRACOLoader(new DRACOLoader().setDecoderPath('./vendor/three/jsm/libs/draco/gltf/'))
  .setMeshoptDecoder(MeshoptDecoder);

async function loadObject(src, name) {
  if (src === 'builtin:layers') return layerDemo();
  const ext = (src.startsWith('blob:') ? name : src).split('?')[0].split('.').pop().toLowerCase();
  if (ext === 'glb' || ext === 'gltf') return (await gltfLoader.loadAsync(src)).scene;
  if (ext === 'obj') return await new OBJLoader().loadAsync(src);
  if (ext === 'fbx') return await new FBXLoader().loadAsync(src);
  if (ext === 'stl') {
    const g = await new STLLoader().loadAsync(src);
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb9bdc6, roughness: 0.5, metalness: 0.1 }));
  }
  throw new Error(`.${ext} files aren't supported`);
}

function layerDemo() {
  const g = new THREE.Group();
  [['Outer layer', 0.5, 0xd9a37f], ['Middle layer', 0.4, 0xb6403a], ['Inner layer', 0.28, 0x3f6fb5], ['Core', 0.14, 0xf2c14e]]
    .forEach(([n, r, c]) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 96, 64), new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 }));
      m.name = n; m.scale.set(1, 0.85, 1); g.add(m);
    });
  return g;
}

function prepare(obj) {
  const byName = new Map();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const mats = list.map((m) => {
      const c = (m || new THREE.MeshStandardMaterial()).clone();
      c.clippingPlanes = clipList;
      c.userData.side0 = c.side;
      return c;
    });
    o.material = Array.isArray(o.material) ? mats : mats[0];
    o.frustumCulled = false;
    const name = o.name || o.parent?.name || `Part ${byName.size + 1}`;
    if (!byName.has(name)) byName.set(name, { name, meshes: [], mats: [] });
    byName.get(name).meshes.push(o);
    byName.get(name).mats.push(...mats);
  });
  return [...byName.values()];
}

function disposeTree(o) {
  o.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
    const ms = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
    ms.forEach((m) => { for (const v of Object.values(m)) if (v && v.isTexture) v.dispose(); m.dispose(); });
  });
}

let loadedSrc = null, loadToken = 0, cutSideApplied = null;
async function ensureModel() {
  if (S.model.src === loadedSrc) return;
  const src = S.model.src, name = S.model.name, tok = ++loadToken;
  loadedSrc = src;
  status(`Loading ${name}…`);
  try {
    const obj = await loadObject(src, name);
    if (tok !== loadToken) { disposeTree(obj); return; }
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (content) content.removeFromParent();
    if (loaded) { loaded.obj.removeFromParent(); disposeTree(loaded.obj); }
    loaded = { obj, box, pos0: obj.position.clone() };
    content = null; mountedKind = null;
    parts = prepare(obj);
    if (S.kind === 'auto' && VIEW === 'preview') {
      // a model bigger than a few metres is probably a scene to stand in
      S.kind = maxDim() * autoUnits().f > 3 ? 'environment' : 'object';
      markDirty();
    }
    mount();
    applyHidden();
    buildPartsUI();
    redrawSoon(6000);          // textures can finish arriving after the model
    status('');
  } catch (e) {
    console.error(e);
    status(`Couldn't load ${name}: ${e.message}`, true);
  }
}

function maxDim() {
  if (!loaded) return 1;
  const s = loaded.box.getSize(new THREE.Vector3());
  return Math.max(s.x, s.y, s.z) || 1;
}
function autoUnits() {
  const m = maxDim();
  if (m > 3000) return { k: 'mm', f: 0.001 };
  if (m > 300) return { k: 'cm', f: 0.01 };
  return { k: 'm', f: 1 };
}
const unitScale = () => UNITS[S.env.units] ?? autoUnits().f;
const isEnv = () => S.kind === 'environment';

// Put the loaded model either on the turntable (object) or around you at real size (environment).
function mount() {
  if (!loaded) return;
  const k = isEnv() ? 'environment' : 'object';
  if (mountedKind === k) return;
  const { obj, box, pos0 } = loaded;
  obj.removeFromParent();
  if (content && content !== obj) content.removeFromParent();
  if (k === 'object') {
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    content = new THREE.Group();
    content.scale.setScalar(1 / maxDim());
    obj.position.copy(pos0).sub(centre);
    content.add(obj);
    pivot.add(content);
  } else {
    obj.position.copy(pos0);
    content = obj;
    envScale.add(obj);
  }
  mountedKind = k;
  cutSideApplied = null;
}

// The model's floor-plan extent at real size (for the "stand at" sliders)
function envExtent() {
  if (!loaded) return null;
  const u = unitScale(), b = loaded.box;
  return { x0: b.min.x * u, x1: b.max.x * u, z0: b.min.z * u, z1: b.max.z * u, cx: (b.min.x + b.max.x) / 2 * u, cz: (b.min.z + b.max.z) / 2 * u };
}

function applyHidden() {
  const hide = new Set(S.hidden);
  parts.forEach((p) => p.meshes.forEach((m) => { m.visible = !hide.has(p.name); }));
}

// ------------------------------------------------------------------ per-frame placement
const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3();
function updateWorld(dt) {
  world.background.set(BACKDROP[S.backdrop] ?? BACKDROP.dark);
  const yaw = WALL_YAW[S.place.wall] ?? 0;
  const toCentre = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  anchor.rotation.set(0, yaw, 0);
  anchor.position.copy(toCentre).multiplyScalar(-S.place.dist).addScaledVector(right, S.place.x);
  anchor.position.y = S.place.y;

  if (S.spin) local.spin += dt * 0.5;
  pivot.quaternion.fromArray(S.xf.q);
  if (local.spin) pivot.quaternion.premultiply(tmpQ.setFromAxisAngle(Y, local.spin));
  pivot.scale.setScalar(S.xf.s);

  mount();
  const env = isEnv() && loaded;
  if (env) {
    const u = unitScale(), e = envExtent();
    envScale.scale.setScalar(u);
    envOffset.position.set(-(S.env.x ?? e.cx), -loaded.box.min.y * u, -(S.env.z ?? e.cz));
    envRoot.rotation.set(0, THREE.MathUtils.degToRad(S.env.yaw), 0);
    envRoot.position.set(0, S.env.floor, 0);
  }
  keyLight.intensity = env ? 0.4 : 1.5;
  fillLight.intensity = env ? 0.8 : 0;
  renderer.toneMappingExposure = S.exposure;

  const ph = projH();
  cubeCam.position.set(0, ph, 0);
  keyLight.position.set(0, ph + 0.8, 0);
  world.updateMatrixWorld();

  // cutaway: a plane fixed to the model, so it turns with it (object mode only)
  if (S.cut.on && content && !env) {
    const n = AXES[S.cut.axis].clone();
    if (S.cut.flip) n.negate();
    const p0 = n.clone().multiplyScalar(S.cut.pos * 0.52);
    cutPlane.setFromNormalAndCoplanarPoint(n.negate(), p0).applyMatrix4(pivot.matrixWorld);
  } else {
    cutPlane.set(Y, 1e6);
  }
  const want = S.cut.on && !env;
  if (cutSideApplied !== want) {
    cutSideApplied = want;
    parts.forEach((p) => p.mats.forEach((m) => { m.side = want ? THREE.DoubleSide : m.userData.side0; m.needsUpdate = true; }));
  }
}

// ------------------------------------------------------------------ render loop
let last = performance.now(), lastSig = '', redrawUntil = 0;
const redrawSoon = (ms = 4000) => { redrawUntil = Math.max(redrawUntil, performance.now() + ms); };
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  updateWorld(dt);
  // Only redraw the 360 view while something is changing - a still scene costs nothing.
  const sig = JSON.stringify(S) + mountedKind + loadToken;
  if (sig !== lastSig) { lastSig = sig; redrawUntil = Math.max(redrawUntil, now + 1500); }
  if (S.spin || now < redrawUntil) cubeCam.update(renderer, world);
  if (VIEW === 'igloo') {
    renderer.render(eqScene, eqCam);
  } else {
    const r = S.room;
    eyeCam.position.set(0, Math.min(r.eye, r.h - 0.05), 0);
    eyeCam.rotation.set(local.pitch, local.yaw, 0);
    if (eyeCam.fov !== local.fov) { eyeCam.fov = local.fov; eyeCam.updateProjectionMatrix(); }
    roomMat.uniforms.proj.value.set(0, projH(), 0);
    roomMat.uniforms.edgeA.value = local.edges ? 0.3 : 0;
    roomMat.uniforms.edgeColor.value.set(S.backdrop === 'light' ? 0x000000 : 0xffffff);
    renderer.render(viewScene, eyeCam);
  }
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  redrawSoon();
  renderer.setSize(innerWidth, innerHeight);
  if (eyeCam) { eyeCam.aspect = innerWidth / innerHeight; eyeCam.updateProjectionMatrix(); }
});

// ------------------------------------------------------------------ sync with serve.py
const sync = { ok: false, dirty: false, busy: false };
function markDirty() { sync.dirty = true; saveLocal(); }

function applyRemote(state, rev) {
  const wasSpin = S.spin;
  S = merge(defaults(), state);
  S.rev = rev;
  if (!S.spin || !wasSpin) local.spin = 0;
  applyRoom();
  ensureModel();
  applyHidden();
  syncUI();
}

async function syncTick() {
  if (sync.busy) return;
  sync.busy = true;
  try {
    if (VIEW === 'preview' && sync.dirty) {
      sync.dirty = false;
      const r = await fetch('api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S) });
      if (r.ok) S.rev = (await r.json()).rev;
    } else {
      const r = await fetch(`api/state?since=${S.rev}`, { cache: 'no-store' });
      if (r.status === 200 && !local.interacting) { const j = await r.json(); applyRemote(j.state, j.rev); }
    }
    setConn(true);
  } catch { setConn(false); } finally { sync.busy = false; }
}

async function syncInit() {
  try {
    const r = await fetch('api/state?since=-1', { cache: 'no-store' });
    if (!r.ok && r.status !== 204) throw new Error('no server');
    sync.ok = true;
    if (r.status === 200) { const j = await r.json(); applyRemote(j.state, j.rev); }
    else if (VIEW === 'preview') sync.dirty = true;
    setInterval(syncTick, 40);
    refreshModels();
  } catch {
    sync.ok = false;
  }
  setConn(sync.ok);
}

// ------------------------------------------------------------------ UI (preview only)
const $ = (id) => document.getElementById(id);
let statusTimer = 0;
function status(msg, warn = false) {
  const el = $('status');
  el.textContent = msg; el.classList.toggle('warn', warn);
  clearTimeout(statusTimer);
  if (msg && warn) statusTimer = setTimeout(() => { el.textContent = ''; }, 8000);
}
function setConn(ok) {
  const el = $('syncInfo');
  if (!el) return;
  const port = location.port || '8010';
  el.innerHTML = ok
    ? `Connected - the Igloo layer follows this screen.<br>Igloo web layer URL (4096 × 2048, Dynamic Resolution off):<br><b>http://localhost:${port}/index.html?view=igloo</b>`
    : 'Not connected to serve.py - this screen works on its own. Start it with start.bat so the Igloo layer can follow.';
}

function setMode(m) {
  local.mode = m;
  $('modeChip').textContent = m === 'object' ? 'HANDLE OBJECT' : 'LOOK';
  $('modeChip').classList.toggle('object', m === 'object');
  $('modeLook').classList.toggle('on', m === 'look');
  $('modeObject').classList.toggle('on', m === 'object');
  $('hint').textContent = isEnv()
    ? (local.tapMove ? 'Tap the floor where you want to stand' : 'Drag to look around · W A S D to step through the scene · scroll to zoom')
    : m === 'object'
      ? 'Drag to turn it · scroll or pinch to resize · right-drag / two fingers to move · tap empty space or Tab to finish'
      : 'Drag to look around · tap the model or press Tab to handle it';
  if (isEnv()) $('modeChip').textContent = 'ENVIRONMENT';
}

function fmt(v, unit = ' m') { return `${(+v).toFixed(2)}${unit}`; }

function syncUI() {
  if (VIEW !== 'preview') return;
  $('size').value = Math.log2(S.xf.s); $('sizeOut').textContent = fmt(S.xf.s);
  $('spinBtn').classList.toggle('on', S.spin);
  document.querySelectorAll('#wallSeg button').forEach((b) => b.classList.toggle('on', b.dataset.wall === S.place.wall));
  const wd = wallDist(S.place.wall);
  $('dist').max = (wd + 1.5).toFixed(2);
  $('dist').value = S.place.dist; $('distOut').textContent = fmt(S.place.dist);
  $('height').max = (S.room.h + 0.6).toFixed(2);
  $('height').value = S.place.y; $('heightOut').textContent = fmt(S.place.y);
  $('side').value = S.place.x; $('sideOut').textContent = fmt(S.place.x);
  $('cutOn').checked = S.cut.on; $('cutFlip').checked = S.cut.flip;
  $('cutPos').value = S.cut.pos; $('cutOut').textContent = `${Math.round((S.cut.pos + 1) * 50)}%`;
  document.querySelectorAll('#axisSeg button').forEach((b) => b.classList.toggle('on', b.dataset.axis === S.cut.axis));
  document.querySelectorAll('#bgSeg button').forEach((b) => b.classList.toggle('on', b.dataset.bg === S.backdrop));
  $('edgesOn').checked = local.edges;
  $('roomW').value = S.room.w; $('roomD').value = S.room.d; $('roomH').value = S.room.h;
  $('roomP').value = S.room.proj ?? ''; $('roomE').value = S.room.eye;
  const hide = new Set(S.hidden);
  document.querySelectorAll('#parts input').forEach((c) => { c.checked = !hide.has(c.dataset.name); });
  // environment
  document.body.classList.toggle('kind-env', isEnv());
  document.querySelectorAll('#kindSeg button').forEach((b) => b.classList.toggle('on', b.dataset.kind === S.kind));
  const au = autoUnits();
  $('envUnits').options[0].textContent = `Auto (${au.k})`;
  $('envUnits').value = S.env.units;
  $('exposure').value = S.exposure; $('exposureOut').textContent = `${Math.round(S.exposure * 100)}%`;
  $('envFloor').value = S.env.floor; $('envFloorOut').textContent = fmt(S.env.floor);
  $('envYaw').value = S.env.yaw; $('envYawOut').textContent = `${Math.round(S.env.yaw)}°`;
  const e = envExtent();
  if (e) {
    $('envX').min = e.x0.toFixed(2); $('envX').max = e.x1.toFixed(2);
    $('envZ').min = e.z0.toFixed(2); $('envZ').max = e.z1.toFixed(2);
    const sx = S.env.x ?? e.cx, sz = S.env.z ?? e.cz;
    $('envX').value = sx; $('envXOut').textContent = fmt(sx);
    $('envZ').value = sz; $('envZOut').textContent = fmt(sz);
    const sz3 = loaded.box.getSize(new THREE.Vector3()).multiplyScalar(unitScale());
    $('envSize').textContent = `Model at real size: ${sz3.x.toFixed(1)} × ${sz3.z.toFixed(1)} m, ${sz3.y.toFixed(1)} m high`;
  }
  $('tapMove').classList.toggle('on', !!local.tapMove);
  if (isEnv() && local.mode === 'object') setMode('look');
  else setMode(local.mode);
  const sel = $('modelSel');
  if (![...sel.options].some((o) => o.value === S.model.src)) addOption(S.model.src, S.model.name);
  sel.value = S.model.src;
}

function addOption(src, name) {
  const o = document.createElement('option');
  o.value = src; o.textContent = name;
  $('modelSel').appendChild(o);
}

async function refreshModels() {
  const sel = $('modelSel');
  if (!sel) return;
  let list = [];
  try { const r = await fetch('api/models', { cache: 'no-store' }); if (r.ok) list = await r.json(); } catch { /* standalone */ }
  sel.innerHTML = '';
  if (!list.some((m) => m.src === DEFAULT_MODEL.src)) list.unshift({ ...DEFAULT_MODEL });
  list.forEach((m) => addOption(m.src, m.name));
  addOption('builtin:layers', 'Layer demo (built in)');
  syncUI();
}

function buildPartsUI() {
  const box = $('parts');
  if (!box) return;
  box.innerHTML = '';
  parts.forEach((p) => {
    const l = document.createElement('label');
    l.className = 'check';
    const c = document.createElement('input');
    c.type = 'checkbox'; c.dataset.name = p.name;
    c.addEventListener('change', () => {
      const set = new Set(S.hidden);
      c.checked ? set.delete(p.name) : set.add(p.name);
      S.hidden = [...set]; applyHidden(); markDirty();
    });
    l.append(c, document.createTextNode(p.name));
    box.appendChild(l);
  });
  syncUI();
}

function setModel(src, name) {
  S.model = { src, name };
  S.hidden = [];
  S.xf = { q: [0, 0, 0, 1], s: 1 };
  S.cut.on = false;
  S.kind = 'auto';                                      // decided once it has loaded, from its size
  S.env = defaults().env;
  local.spin = 0;
  markDirty();
  ensureModel();
  syncUI();
}

async function openFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!MODEL_EXT.includes(ext) && ext !== 'zip') { status(`${file.name}: use a GLB, OBJ, FBX, STL or a Sketchfab .zip`, true); return; }
  if (ext === 'zip' && !sync.ok) { status('A .zip needs serve.py running (start.bat) to unpack it', true); return; }
  if (ext === 'gltf') status('Tip: a .gltf with separate texture files won\'t carry them over - use the .zip or a .glb', true);
  if (sync.ok) {
    status(`Uploading ${file.name}…`);
    try {
      const r = await fetch(`api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      await refreshModels();
      setModel(j.src, j.name);
      return;
    } catch (e) { status(`Upload failed (${e.message}) - showing it on this screen only`, true); }
  }
  setModel(URL.createObjectURL(file), file.name);
}

function foldSpin() {
  if (!local.spin) return;
  tmpQ.setFromAxisAngle(Y, local.spin).multiply(new THREE.Quaternion().fromArray(S.xf.q));
  S.xf.q = tmpQ.toArray();
  local.spin = 0;
}

function facingWall() {
  let best = 'front', bestD = 9;
  for (const [w, a] of Object.entries(WALL_YAW)) {
    const d = Math.abs(Math.atan2(Math.sin(local.yaw - a), Math.cos(local.yaw - a)));
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

function setWall(w) {
  S.place.wall = w;
  S.place.x = 0;
  S.place.dist = Math.min(S.place.dist, wallDist(w) - 0.3);
  markDirty(); syncUI();
}

// ------------------------------------------------------------------ handling: look / object
const ray = new THREE.Raycaster();
function pick(clientX, clientY) {
  return !!pickHit(clientX, clientY);
}
function pickHit(clientX, clientY) {
  if (!content) return null;
  const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, eyeCam);
  // where the ray from your eye hits the room surface...
  const o = ray.ray.origin, d = ray.ray.direction, r = S.room;
  const lo = [-r.w / 2, 0, -r.d / 2], hi = [r.w / 2, r.h, r.d / 2];
  let t = Infinity;
  ['x', 'y', 'z'].forEach((k, i) => {
    if (Math.abs(d[k]) < 1e-6) return;
    const tt = ((d[k] > 0 ? hi[i] : lo[i]) - o[k]) / d[k];
    if (tt > 0) t = Math.min(t, tt);
  });
  const hit = o.clone().addScaledVector(d, t);
  // ...then what the projection put on that spot
  const c = new THREE.Vector3(0, projH(), 0);
  ray.set(c, hit.sub(c).normalize());
  return ray.intersectObject(content, true).find((h) => h.object.visible) || null;
}

// Environment: move where you stand (x/z in the model, metres)
function standAt(x, z) {
  const e = envExtent();
  if (!e) return;
  S.env.x = THREE.MathUtils.clamp(x, e.x0, e.x1);
  S.env.z = THREE.MathUtils.clamp(z, e.z0, e.z1);
  markDirty(); syncUI();
}
function tapToStand(clientX, clientY) {
  const hit = pickHit(clientX, clientY);
  local.tapMove = false;
  if (!hit) { status('Tap a spot on the model\'s floor', true); syncUI(); return; }
  const p = envRoot.worldToLocal(hit.point.clone());      // relative to where you stand now
  const e = envExtent();
  standAt((S.env.x ?? e.cx) + p.x, (S.env.z ?? e.cz) + p.z);
}
function step(fwd, side) {
  const e = envExtent();
  if (!e) return;
  const a = local.yaw - THREE.MathUtils.degToRad(S.env.yaw);   // your heading inside the model
  const dx = -Math.sin(a) * fwd + Math.cos(a) * side;
  const dz = -Math.cos(a) * fwd - Math.sin(a) * side;
  standAt((S.env.x ?? e.cx) + dx, (S.env.z ?? e.cz) + dz);
}

function rotateObj(dx, dy) {
  const q = new THREE.Quaternion().fromArray(S.xf.q);
  q.premultiply(tmpQ.setFromAxisAngle(Y, dx * 0.008));
  q.premultiply(tmpQ.setFromAxisAngle(X, dy * 0.008));
  S.xf.q = q.normalize().toArray();
  markDirty();
}
function panObj(dx, dy) {
  const dist = eyeCam.position.distanceTo(anchor.position);
  const mpp = (2 * Math.tan(THREE.MathUtils.degToRad(local.fov / 2)) * dist) / innerHeight;
  S.place.x = THREE.MathUtils.clamp(S.place.x + dx * mpp, -3, 3);
  S.place.y = THREE.MathUtils.clamp(S.place.y - dy * mpp, 0.1, S.room.h + 0.6);
  markDirty(); syncUI();
}
function scaleObj(f) {
  S.xf.s = THREE.MathUtils.clamp(S.xf.s * f, 0.2, 5);
  markDirty(); syncUI();
}
function look(dx, dy) {
  const k = THREE.MathUtils.degToRad(local.fov / innerHeight);
  local.yaw -= dx * k;                 // same feel as spoutyPreview: drag right to look right
  local.pitch = THREE.MathUtils.clamp(local.pitch - dy * k, -1.5, 1.5);
}

function initControls() {
  const el = renderer.domElement;
  const pts = new Map();
  let moved = 0, panBtn = false;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { moved = 0; panBtn = e.button === 2 || e.shiftKey; }
    local.interacting = true;
  });
  el.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (pts.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      if (local.mode === 'object') (panBtn ? panObj : rotateObj)(dx, dy);
      else look(dx, dy);
    } else if (pts.size === 2) {
      const [a, b] = [...pts.entries()].map(([id, v]) => (id === e.pointerId ? { x: e.clientX, y: e.clientY, ox: v.x, oy: v.y } : { x: v.x, y: v.y, ox: v.x, oy: v.y }));
      const d0 = Math.hypot(a.ox - b.ox, a.oy - b.oy), d1 = Math.hypot(a.x - b.x, a.y - b.y);
      moved += 99;
      if (d0 > 10) {
        if (local.mode === 'object') scaleObj(d1 / d0);
        else local.fov = THREE.MathUtils.clamp(local.fov * (d0 / d1), 30, 110);
      }
      if (local.mode === 'object') panObj(dx / 2, dy / 2);
    }
    p.x = e.clientX; p.y = e.clientY;
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      local.interacting = false;
      if (moved < 6) {
        if (isEnv()) { if (local.tapMove) tapToStand(e.clientX, e.clientY); }
        else setMode(pick(e.clientX, e.clientY) ? 'object' : 'look');
      }
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (local.mode === 'object') scaleObj(Math.exp(-e.deltaY * 0.0015));
    else local.fov = THREE.MathUtils.clamp(local.fov * Math.exp(e.deltaY * 0.001), 30, 110);
  }, { passive: false });

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (isEnv() && 'wasd'.includes(k) && k.length === 1) {
      const st = e.shiftKey ? 1 : 0.25;
      step(k === 'w' ? st : k === 's' ? -st : 0, k === 'd' ? st : k === 'a' ? -st : 0);
    }
    else if (k === 'tab') { e.preventDefault(); if (!isEnv()) setMode(local.mode === 'object' ? 'look' : 'object'); }
    else if (k === 'b') { S.backdrop = S.backdrop === 'dark' ? 'light' : 'dark'; markDirty(); syncUI(); }
    else if (k === 'e') { local.edges = !local.edges; saveLocal(); syncUI(); }
    else if (k === 'c') { S.cut.on = !S.cut.on; markDirty(); syncUI(); }
    else if (k === ' ') { e.preventDefault(); $('spinBtn').click(); }
    else if (k === 'r') { local.yaw = 0; local.pitch = 0; local.fov = 75; }
    else if ('1234'.includes(k) && k) { local.yaw = [0, -Math.PI / 2, Math.PI, Math.PI / 2][+k - 1]; local.pitch = 0; }
    else if (k === 'h') $('panel').classList.toggle('hidden');
  });

  // drag & drop a model file
  let dragDepth = 0;
  addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });
}

function initPanel() {
  $('panelToggle').onclick = () => $('panel').classList.toggle('hidden');
  if (innerWidth < 560) $('panel').classList.add('hidden');
  $('modelSel').onchange = (e) => setModel(e.target.value, e.target.selectedOptions[0].textContent);
  $('openBtn').onclick = () => $('fileIn').click();
  $('fileIn').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
  $('modeLook').onclick = () => setMode('look');
  $('modeObject').onclick = () => setMode('object');
  $('spinBtn').onclick = () => { if (S.spin) foldSpin(); S.spin = !S.spin; markDirty(); syncUI(); };
  $('resetObj').onclick = () => { S.xf = { q: [0, 0, 0, 1], s: 1 }; S.spin = false; local.spin = 0; markDirty(); syncUI(); };
  $('size').oninput = (e) => { S.xf.s = 2 ** +e.target.value; markDirty(); syncUI(); };
  document.querySelectorAll('#wallSeg button').forEach((b) => { b.onclick = () => setWall(b.dataset.wall); });
  $('toFacing').onclick = () => setWall(facingWall());
  $('dist').oninput = (e) => { S.place.dist = +e.target.value; markDirty(); syncUI(); };
  $('height').oninput = (e) => { S.place.y = +e.target.value; markDirty(); syncUI(); };
  $('side').oninput = (e) => { S.place.x = +e.target.value; markDirty(); syncUI(); };
  $('cutOn').onchange = (e) => { S.cut.on = e.target.checked; markDirty(); syncUI(); };
  $('cutFlip').onchange = (e) => { S.cut.flip = e.target.checked; markDirty(); syncUI(); };
  $('cutPos').oninput = (e) => { S.cut.pos = +e.target.value; S.cut.on = true; markDirty(); syncUI(); };
  document.querySelectorAll('#axisSeg button').forEach((b) => { b.onclick = () => { S.cut.axis = b.dataset.axis; S.cut.on = true; markDirty(); syncUI(); }; });
  $('partsAll').onclick = () => { S.hidden = []; applyHidden(); markDirty(); syncUI(); };
  $('partsNone').onclick = () => { S.hidden = parts.map((p) => p.name); applyHidden(); markDirty(); syncUI(); };
  document.querySelectorAll('#bgSeg button').forEach((b) => { b.onclick = () => { S.backdrop = b.dataset.bg; markDirty(); syncUI(); }; });
  $('edgesOn').onchange = (e) => { local.edges = e.target.checked; saveLocal(); };
  $('exposure').oninput = (e) => { S.exposure = +e.target.value; markDirty(); syncUI(); };
  document.querySelectorAll('#kindSeg button').forEach((b) => {
    b.onclick = () => { S.kind = b.dataset.kind; S.cut.on = false; local.tapMove = false; markDirty(); syncUI(); };
  });
  $('envUnits').onchange = (e) => { S.env.units = e.target.value; S.env.x = S.env.z = null; markDirty(); syncUI(); };
  $('envFloor').oninput = (e) => { S.env.floor = +e.target.value; markDirty(); syncUI(); };
  $('envYaw').oninput = (e) => { S.env.yaw = +e.target.value; markDirty(); syncUI(); };
  $('envX').oninput = (e) => standAt(+e.target.value, S.env.z ?? envExtent().cz);
  $('envZ').oninput = (e) => standAt(S.env.x ?? envExtent().cx, +e.target.value);
  $('tapMove').onclick = () => { local.tapMove = !local.tapMove; syncUI(); };
  $('envCentre').onclick = () => { S.env.x = S.env.z = null; markDirty(); syncUI(); };
  $('envReset').onclick = () => { S.env = { ...defaults().env, units: S.env.units }; markDirty(); syncUI(); };
  const num = (id, key, allowBlank) => {
    $(id).onchange = (e) => {
      const v = e.target.value.trim();
      if (allowBlank && v === '') S.room[key] = null;
      else if (Number.isFinite(+v) && +v > 0) S.room[key] = +v;
      applyRoom(); markDirty(); syncUI();
    };
  };
  num('roomW', 'w'); num('roomD', 'd'); num('roomH', 'h'); num('roomP', 'proj', true); num('roomE', 'eye');
  $('roomReset').onclick = () => { S.room = defaults().room; applyRoom(); markDirty(); syncUI(); };
}

// ------------------------------------------------------------------ start
applyRoom();
if (VIEW === 'preview') {
  initPanel();
  initControls();
  setMode('look');
  refreshModels();
}
ensureModel();
syncUI();
syncInit();
requestAnimationFrame(frame);
window.spouty = { get state() { return S; }, local };   // handy in the browser console
