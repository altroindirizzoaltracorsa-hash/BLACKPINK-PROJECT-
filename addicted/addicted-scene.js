// The ADDICTED lockup as jisoo.io's own 3D model, lit and moved the way that
// site does it. Every figure here was read off the page rather than chosen:
//
//   camera  = new THREE.PerspectiveCamera(38, …);  camera.position.set(0,0,4.4)
//   idle    = reduce ? 0 : Math.sin(t*0.6)*0.05
//   logoRoot.rotation.y = x*0.42 + idle*0.6
//   logoRoot.rotation.x = -y*0.3
//   const ease = 1 - Math.exp(-dt*6);  input.x += (input.tx - input.x)*ease
//   environment = pmrem.fromScene(makeStudioEnv(), 0.03).texture
//   AmbientLight(0xffffff,0.08) · DirectionalLight(0xdde6ff,0.5) · (0xffffff,0.8)
//   toneMapping = ACESFilmic, exposure 0.9
//   envMapIntensity = front ? 2.2 : 0.6 ;  clearcoat = front ? 0.5 : 0
//
// Two things are deliberately NOT theirs. Their makeStudioEnv() is a function
// of its own that the page does not expose, so RoomEnvironment stands in — the
// nearest thing three ships. And their x is normalised over innerWidth because
// their canvas IS the window; ours is normalised over the sky, which is the
// same gesture (edge of the art = full turn) on an element that is not the
// whole screen.
import * as THREE from '../vendor/three/three.module.min.js';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { RoomEnvironment } from '../vendor/three/RoomEnvironment.js';

export const AD = { yaw: 0.42, pitch: 0.30, easeRate: 6, idleAmp: 0.05, idleMul: 0.6, idleRate: 0.6, fov: 38, camZ: 4.4 };

export async function mountAddictedScene(host, glbUrl, opts = {}) {
  const reduce = opts.reduce ?? false;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  // Capped at 2: a phone at dpr 3 would render nine times the pixels for a
  // lockup this size and gain nothing anyone can see.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.03);
  scene.environment = envRT.texture;

  scene.add(new THREE.AmbientLight(0xffffff, 0.08));
  const key = new THREE.DirectionalLight(0xffffff, 0.8); key.position.set(2, 3, 4); scene.add(key);
  const fill = new THREE.DirectionalLight(0xdde6ff, 0.5); fill.position.set(-3, -1, 2); scene.add(fill);

  const camera = new THREE.PerspectiveCamera(AD.fov, 1, 0.1, 100);
  camera.position.set(0, 0, AD.camZ);

  const logoRoot = new THREE.Group();
  scene.add(logoRoot);

  const gltf = await new GLTFLoader().loadAsync(glbUrl);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const m = o.material;
    // 'chrome' is the lettering's face, 'chrome_side' the extruded edge — the
    // edge is the whole reason for shipping a model instead of a picture, and
    // it takes much less environment than the face.
    const front = m.name !== 'chrome_side';
    m.envMapIntensity = front ? 2.2 : 0.6;
    if ('clearcoat' in m) { m.clearcoat = front ? 0.5 : 0; m.clearcoatRoughness = 0.18; }
    m.needsUpdate = true;
  });
  logoRoot.add(gltf.scene);

  // Centre on the model's own bounds rather than trusting its origin.
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  gltf.scene.position.sub(box.getCenter(new THREE.Vector3()));
  const frameH = 2 * AD.camZ * Math.tan((AD.fov * Math.PI / 180) / 2);

  let tgX = 0, tgY = 0, curX = 0, curY = 0, last = 0, raf = 0, running = false, disposed = false;

  function resize() {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    // Hold the lockup at the same 86% of the frame the flat plate used, so
    // swapping one for the other does not resize the art.
    const s = (frameH * camera.aspect * 0.86) / (size.x || 1);
    gltf.scene.scale.setScalar(s);
  }
  resize();
  let ro = null;
  if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(host); }

  function frame(now) {
    if (disposed) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const ease = 1 - Math.exp(-dt * AD.easeRate);
    curX += (tgX - curX) * ease;
    curY += (tgY - curY) * ease;
    const idle = reduce ? 0 : Math.sin((now / 1000) * AD.idleRate) * AD.idleAmp;
    logoRoot.rotation.y = curX * AD.yaw + idle * AD.idleMul;
    logoRoot.rotation.x = -curY * AD.pitch;
    renderer.render(scene, camera);
    // Keep rendering while it is still settling or drifting; a still frame
    // under reduced motion needs no loop at all once it has arrived.
    const moving = Math.abs(tgX - curX) > 0.0005 || Math.abs(tgY - curY) > 0.0005;
    if (reduce && !moving) { raf = 0; running = false; return; }
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running || disposed) return;
    running = true; last = performance.now(); raf = requestAnimationFrame(frame);
  }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; running = false; }
  start();

  return {
    // Already normalised to −1…1, the units jisoo.io's rotation.y/x expect.
    aim(nx, ny) {
      const c = (v) => Math.max(-1, Math.min(1, v));
      tgX = c(nx); tgY = c(ny); start();
    },
    // fx/fy are 0…1 across the host; kept because it is the natural way to
    // say "the far edge" when driving the scene directly.
    point(fx, fy) { this.aim((fx - 0.5) * 2, (fy - 0.5) * 2); },
    rest() { tgX = 0; tgY = 0; start(); },
    start, stop,
    yawDeg() { return logoRoot.rotation.y * 180 / Math.PI; },
    pitchDeg() { return logoRoot.rotation.x * 180 / Math.PI; },
    dispose() {
      disposed = true; stop();
      if (ro) ro.disconnect();
      envRT.dispose(); pmrem.dispose();
      scene.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); } });
      renderer.dispose();
      canvas.remove();
    },
  };
}
