"use client";

// The living voice + the constellation. 42k GPU particles:
//  - an emerald orb (hot core, waves, twinkle, orbiting halo) that reacts to
//    audio and swirls while thinking;
//  - when parcels enter the conversation, the voice lifts into a small sun
//    and the particles crystallize into the focus parcel (gold) plus green
//    memory nodes at true geographic bearings, tethered by light.

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { orbBus } from "@/lib/orbBus";
import { ORB_HOME } from "@/lib/constellation";
import { TOTAL as COUNT, HALO_COUNT, MORPH_START } from "@/lib/particleField";
import { useHvi } from "@/lib/store";

const MODE_INDEX = { idle: 0, listening: 1, thinking: 2, speaking: 3 } as const;
const MAX_LINE_VERTS = 16; // 5 memory links + orb tether, xyz pairs

const vertexShader = /* glsl */ `
  attribute vec3 aSphere;   // core/shell: rest position · halo: (radius, phase, speed)
  attribute vec3 aTarget;
  attribute float aSeed;
  attribute float aKind;    // 0 core, 1 shell, 2 halo
  attribute float aMorphW;  // 0 = always the voice, 1 = may become data
  attribute float aNodeKind; // 0 none, 1 focus parcel, 2 memory node

  uniform float uTime;
  uniform float uLevel;
  uniform float uMode;      // 0 idle, 1 listening, 2 thinking, 3 speaking
  uniform float uMorph;
  uniform float uOrbScale;
  uniform vec3 uOrbOffset;

  varying float vBright;
  varying float vMorph;
  varying float vPalette;
  varying float vKind;
  varying float vNodeKind;

  float wob(vec3 p, float t, float seed) {
    return sin(p.x * 2.3 + t + seed * 6.28) *
           sin(p.y * 1.9 + t * 1.31 + seed * 3.1) *
           sin(p.z * 2.6 + t * 0.73 + seed * 9.4);
  }

  void main() {
    float t = uTime;
    float seed = aSeed;

    float isListening = step(0.5, uMode) * (1.0 - step(1.5, uMode));
    float isThinking  = step(1.5, uMode) * (1.0 - step(2.5, uMode));
    float isSpeaking  = step(2.5, uMode);
    float isAudio = isListening + isSpeaking;

    vec3 orbPos;
    if (aKind > 1.5) {
      // ── Halo ring: independent orbit, tilted, always in motion ──
      float R = aSphere.x;
      float theta = aSphere.y + t * (0.25 + aSphere.z * 0.35) * (1.0 + isThinking * 2.2);
      vec3 ring = vec3(cos(theta) * R, sin(theta * 2.0 + seed * 6.28) * 0.045, sin(theta) * R);
      float cxr = cos(1.05), sxr = sin(1.05);
      ring = vec3(ring.x, cxr * ring.y - sxr * ring.z, sxr * ring.y + cxr * ring.z);
      float czr = cos(0.4), szr = sin(0.4);
      ring = vec3(czr * ring.x - szr * ring.y, szr * ring.x + czr * ring.y, ring.z);
      orbPos = ring * (1.0 + isAudio * uLevel * 0.18);
    } else {
      vec3 p = aSphere;
      float breath = 1.0 + 0.05 * sin(t * 0.85 + seed * 0.5);
      float wave = 0.055 * sin(p.y * 4.5 - t * 1.7 + seed * 2.0)
                 + 0.04  * sin(p.x * 3.5 + t * 1.15);
      float audioAmp = uLevel * (0.4 + 0.3 * sin(seed * 40.0 + t * 3.2));
      float radial = 1.0 + wave + isAudio * audioAmp;
      float swirl = t * (0.22 + isThinking * (1.1 + seed * 0.5));
      float cs = cos(swirl), sn = sin(swirl);
      p = vec3(cs * p.x + sn * p.z, p.y, -sn * p.x + cs * p.z);
      float churn = 1.0 - isThinking * (0.14 + 0.07 * sin(t * 2.3 + seed * 12.0));
      vec3 wobble = vec3(
        wob(aSphere, t * 0.7, seed),
        wob(aSphere.yzx, t * 0.6, seed + 0.33),
        wob(aSphere.zxy, t * 0.8, seed + 0.66)
      ) * (0.11 + isThinking * 0.05);
      orbPos = p * breath * radial * churn + wobble;
    }

    // The voice shrinks and lifts when the constellation is out.
    orbPos = orbPos * uOrbScale + uOrbOffset;

    // ── Morph into the data form (staggered flow), only morphable particles ──
    vec3 dataPos = aTarget + vec3(0.0, 0.0, 0.025 * sin(t * 1.6 + seed * 20.0));
    // Layout nodes (Chapter 42 buildings, kind 4+order) assemble in rect
    // order — a wave across the site plan — instead of by random seed.
    float isLayoutV = step(3.5, aNodeKind) * (1.0 - step(4.5, aNodeKind));
    float mSeed = clamp(uMorph * 1.35 - seed * 0.35, 0.0, 1.0);
    float mRect = clamp(uMorph * 2.0 - fract(aNodeKind) * 1.15, 0.0, 1.0);
    float m = mix(mSeed, mRect, isLayoutV);
    m = m * m * (3.0 - 2.0 * m);
    m *= aMorphW;
    vec3 pos = mix(orbPos, dataPos, m);

    float twinkle = 0.72 + 0.42 * sin(t * (2.0 + seed * 5.0) + seed * 43.0);
    vBright = twinkle * (0.85 + isAudio * uLevel * 1.3 + isThinking * 0.45);
    vMorph = m;
    vPalette = seed;
    vKind = aKind;
    vNodeKind = aNodeKind;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float sparkle = step(0.94, fract(seed * 7.31));
    float size = (3.4 + sparkle * 3.2 + aKind * 0.6)
               * (1.0 + uLevel * 0.5)
               * (1.0 - m * 0.25)
               * (1.0 - step(2.5, aNodeKind) * (1.0 - step(3.5, aNodeKind)) * m * 0.4) // comps: smaller dots
               * (1.0 - step(4.5, aNodeKind) * m * 0.45); // ground: finest grain
    gl_PointSize = size * (3.4 / max(1.0, -mv.z));
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform float uFlood;   // 1 = focus parcel is in a FEMA flood zone
  varying float vBright;
  varying float vMorph;
  varying float vPalette;
  varying float vKind;
  varying float vNodeKind;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;

    float core = exp(-d * d * 14.0);
    float halo = exp(-d * d * 3.0) * 0.55;

    vec3 emerald = vec3(0.10, 0.95, 0.45);
    vec3 spring  = vec3(0.35, 1.00, 0.60);
    vec3 teal    = vec3(0.05, 0.65, 0.55);
    vec3 tint = mix(teal, emerald, smoothstep(0.15, 0.75, vPalette));
    tint = mix(tint, spring, step(0.82, vPalette));

    // Focus parcel burns gold; memory nodes stay luminous emerald; comps
    // fade to cool steel satellites.
    float isFocusNode = step(0.5, vNodeKind) * (1.0 - step(1.5, vNodeKind));
    float isMemNode = step(1.5, vNodeKind) * (1.0 - step(2.5, vNodeKind));
    float isCompNode = step(2.5, vNodeKind) * (1.0 - step(3.5, vNodeKind));
    float isLayoutNode = step(3.5, vNodeKind) * (1.0 - step(4.5, vNodeKind));
    float isRoadNode = step(4.5, vNodeKind) * (1.0 - step(5.5, vNodeKind));
    float isWaterNode = step(5.5, vNodeKind);
    vec3 gold = vec3(1.0, 0.78, 0.25);
    tint = mix(tint, gold, vMorph * isFocusNode * 0.9);
    tint = mix(tint, spring, vMorph * isMemNode * 0.7);
    tint = mix(tint, vec3(0.55, 0.82, 0.95), vMorph * isCompNode * 0.8);
    // Chapter 42 buildings: warm incandescent white, brighter than the lot.
    tint = mix(tint, vec3(1.0, 0.95, 0.78), vMorph * isLayoutNode * 0.95);
    // Ground layer: freeways as amber streams, bayous as water.
    tint = mix(tint, vec3(1.0, 0.62, 0.24), vMorph * isRoadNode * 0.85);
    tint = mix(tint, vec3(0.25, 0.55, 1.0), vMorph * isWaterNode * 0.9);
    // Floodplain: the focus parcel drowns from gold into water blue.
    vec3 floodBlue = vec3(0.25, 0.55, 1.0);
    tint = mix(tint, floodBlue, vMorph * isFocusNode * uFlood * 0.85);

    vec3 white = vec3(0.85, 1.0, 0.92);
    vec3 color = tint * halo + mix(tint, white, 0.6) * core;
    color *= vBright * (1.0 + vKind * 0.25 + vMorph * isMemNode * 0.35);
    color *= 1.0 - vMorph * isCompNode * 0.45; // comps read as background data
    color *= 1.0 + vMorph * isLayoutNode * 0.4; // buildings pop
    color *= 1.0 - vMorph * (isRoadNode + isWaterNode) * 0.5; // ground stays faint

    float alpha = (halo + core) * 0.9;
    gl_FragColor = vec4(color, alpha);
  }
`;

function makeGlowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.0, "rgba(70, 255, 160, 0.55)");
  grad.addColorStop(0.25, "rgba(35, 200, 120, 0.22)");
  grad.addColorStop(0.6, "rgba(12, 110, 80, 0.07)");
  grad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/** Drag-to-orbit / wheel-to-zoom. Auto camera until the user takes over. */
function CameraRig() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const el = gl.domElement;
    el.style.touchAction = "none"; // we own pinch + drag
    const pointers = new Map<number, { x: number; y: number }>();
    let prevPinch: number | null = null;
    let gyroArmed = false;

    const takeControl = () => {
      if (!orbBus.cam.user) {
        orbBus.cam.user = true;
        useHvi.getState().setFreeCam(true);
      }
    };
    // Gyro parallax: needs a user gesture on iOS to request permission.
    const armGyro = () => {
      if (gyroArmed) return;
      gyroArmed = true;
      const DOE = window.DeviceOrientationEvent as unknown as
        | { requestPermission?: () => Promise<string> }
        | undefined;
      const attach = () =>
        window.addEventListener("deviceorientation", (e) => {
          if (e.gamma == null || e.beta == null) return;
          // gamma: left/right tilt; beta: front/back (45° ≈ natural hold).
          orbBus.gyroX = Math.max(-1, Math.min(1, e.gamma / 30));
          orbBus.gyroY = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
        });
      if (DOE?.requestPermission) {
        DOE.requestPermission().then((r) => r === "granted" && attach()).catch(() => {});
      } else {
        attach();
      }
    };
    // Track a single-pointer gesture to tell a tap from a drag: a tap on the
    // orb while it's speaking/thinking interrupts (barge-in without a mic).
    let downAt = 0;
    let downPos: { x: number; y: number } | null = null;
    let moved = 0;
    const onDown = (e: PointerEvent) => {
      armGyro();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      if (pointers.size === 1) {
        downAt = performance.now();
        downPos = { x: e.clientX, y: e.clientY };
        moved = 0;
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) {
        // Pinch: zoom by the change in distance between the two touches.
        const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
        pointers.set(e.pointerId, cur);
        if (!other) return;
        const dist = Math.hypot(cur.x - other.x, cur.y - other.y);
        if (prevPinch != null && dist > 0) {
          takeControl();
          orbBus.cam.radius = Math.max(2.4, Math.min(11, orbBus.cam.radius * (prevPinch / dist)));
        }
        prevPinch = dist;
        return;
      }
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      pointers.set(e.pointerId, cur);
      if (downPos) moved += Math.abs(dx) + Math.abs(dy);
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      takeControl();
      orbBus.cam.yaw -= dx * 0.005;
      orbBus.cam.pitch = Math.max(-0.25, Math.min(1.25, orbBus.cam.pitch + dy * 0.004));
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) prevPinch = null;
      // A quick, still tap (not a drag) on the orb during speech = interrupt.
      if (downPos && moved < 8 && performance.now() - downAt < 400) {
        const st = useHvi.getState().orbState;
        if (st === "speaking" || st === "thinking") {
          void import("@/lib/voice").then(({ voice }) => {
            voice.interrupt();
            voice.haptic(15);
          });
        }
      }
      downPos = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      takeControl();
      orbBus.cam.radius = Math.max(2.4, Math.min(11, orbBus.cam.radius * (1 + e.deltaY * 0.0012)));
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [gl]);

  return null;
}

function Particles() {
  const points = useRef<THREE.Points>(null!);
  const material = useRef<THREE.ShaderMaterial>(null!);
  const glow = useRef<THREE.Sprite>(null!);
  const targetAttr = useRef<THREE.BufferAttribute>(null!);
  const nodeKindAttr = useRef<THREE.BufferAttribute>(null!);
  const lineGeom = useRef<THREE.BufferGeometry>(null!);
  const lineMat = useRef<THREE.LineBasicMaterial>(null!);
  const appliedVersion = useRef(-1);
  // The attribute the last upload landed in. StrictMode/HMR remounts make
  // r3f rebuild the THREE objects while refs (like appliedVersion) survive —
  // without this identity check, a restored constellation uploads into the
  // first, immediately-discarded attribute and the rebuilt one stays zeroed.
  const appliedAttr = useRef<THREE.BufferAttribute | null>(null);
  const appliedLines = useRef(-1);
  const lineCount = useRef(0);
  const morph = useRef(0);
  const orbScale = useRef(1);
  const orbOffset = useRef(new THREE.Vector3(0, 0, 0));
  const projVec = useMemo(() => new THREE.Vector3(), []);

  const { spheres, seeds, kinds, morphWs, initialTargets, initialNodeKinds, lineBuffer, glowTex } =
    useMemo(() => {
      const spheres = new Float32Array(COUNT * 3);
      const seeds = new Float32Array(COUNT);
      const kinds = new Float32Array(COUNT);
      const morphWs = new Float32Array(COUNT);
      for (let i = 0; i < COUNT; i++) {
        seeds[i] = Math.random();
        morphWs[i] = i >= MORPH_START ? 1 : 0;
        if (i < HALO_COUNT) {
          kinds[i] = 2;
          spheres[i * 3] = 1.45 + Math.random() * 0.4;
          spheres[i * 3 + 1] = Math.random() * Math.PI * 2;
          spheres[i * 3 + 2] = Math.random();
        } else {
          const shell = Math.random() < 0.16;
          kinds[i] = shell ? 1 : 0;
          const u = Math.random();
          const v = Math.random();
          const theta = 2 * Math.PI * u;
          const phi = Math.acos(2 * v - 1);
          const r = shell ? 0.99 + Math.random() * 0.03 : Math.cbrt(0.3 + 0.7 * Math.random());
          spheres[i * 3] = r * Math.sin(phi) * Math.cos(theta);
          spheres[i * 3 + 1] = r * Math.cos(phi);
          spheres[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
        }
      }
      return {
        spheres,
        seeds,
        kinds,
        morphWs,
        initialTargets: new Float32Array(COUNT * 3),
        initialNodeKinds: new Float32Array(COUNT),
        lineBuffer: new Float32Array(MAX_LINE_VERTS * 3),
        glowTex: makeGlowTexture(),
      };
    }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uMode: { value: 0 },
      uMorph: { value: 0 },
      uFlood: { value: 0 },
      uOrbScale: { value: 1 },
      uOrbOffset: { value: new THREE.Vector3(0, 0, 0) },
    }),
    []
  );

  useFrame((state, delta) => {
    // ShaderMaterial CLONES the uniforms object passed at construction — the
    // useMemo object above is only the template. Mutate the material's own
    // uniforms or nothing reaches the GPU.
    const u = material.current?.uniforms;
    if (!u) return;
    const t = state.clock.elapsedTime;
    u.uTime.value = t;
    u.uLevel.value = orbBus.level;
    u.uMode.value = MODE_INDEX[orbBus.mode];

    // ── Upload new constellation targets ──
    if (
      orbBus.targetsVersion !== appliedVersion.current ||
      targetAttr.current !== appliedAttr.current
    ) {
      appliedVersion.current = orbBus.targetsVersion;
      appliedAttr.current = targetAttr.current;
      if (orbBus.targets) {
        (targetAttr.current.array as Float32Array).set(orbBus.targets);
        targetAttr.current.needsUpdate = true;
        if (orbBus.nodeKinds) {
          (nodeKindAttr.current.array as Float32Array).set(orbBus.nodeKinds);
          nodeKindAttr.current.needsUpdate = true;
        }
        // Re-cast: if a form was already out, briefly inhale before re-forming.
        if (morph.current > 0.5) morph.current = 0.18;
      }
    }
    const constellationOut = Boolean(orbBus.targets);
    const goal = constellationOut ? 1 : 0;
    morph.current += (goal - morph.current) * Math.min(1, delta * 1.8);
    u.uMorph.value = morph.current;
    // Flood tint washes in/out gently (slower than the morph — it reads as water).
    u.uFlood.value += (orbBus.flood - u.uFlood.value) * Math.min(1, delta * 1.4);

    // ── The voice lifts into a small sun while the map is out ──
    const sTarget = constellationOut ? 0.34 : 1;
    orbScale.current += (sTarget - orbScale.current) * Math.min(1, delta * 2.2);
    u.uOrbScale.value = orbScale.current;
    const off = constellationOut ? ORB_HOME : [0, 0, 0];
    orbOffset.current.lerp(new THREE.Vector3(off[0], off[1], off[2]), Math.min(1, delta * 2.2));
    (u.uOrbOffset.value as THREE.Vector3).copy(orbOffset.current);

    // Slow drift rotation (only meaningful while it's the big orb)
    if (points.current) {
      points.current.rotation.y = 0; // rotation now baked into the shader swirl
    }

    // ── Core glow follows the voice ──
    if (glow.current) {
      const level = orbBus.level;
      const breath = 1 + 0.06 * Math.sin(t * 0.85);
      const s = (3.4 * breath + level * 1.6) * orbScale.current;
      glow.current.scale.set(s, s, 1);
      glow.current.position.copy(orbOffset.current).add(new THREE.Vector3(0, 0, -0.6));
      (glow.current.material as THREE.SpriteMaterial).opacity = 0.75 + level * 0.5;
    }

    // ── Constellation lines fade with the morph ──
    if (orbBus.linesVersion !== appliedLines.current) {
      appliedLines.current = orbBus.linesVersion;
      const lines = orbBus.lines;
      if (lines && lines.length) {
        lineBuffer.set(lines.subarray(0, Math.min(lines.length, lineBuffer.length)));
        lineCount.current = Math.min(lines.length / 3, MAX_LINE_VERTS);
      } else {
        lineCount.current = 0;
      }
      const posAttr = lineGeom.current.getAttribute("position") as THREE.BufferAttribute;
      posAttr.needsUpdate = true;
      lineGeom.current.setDrawRange(0, lineCount.current);
    }
    if (lineMat.current) {
      lineMat.current.opacity = 0.28 * morph.current;
    }

    // ── Camera ──
    const cam = state.camera;
    if (orbBus.camResetRequested) {
      orbBus.camResetRequested = false;
      orbBus.cam.user = false;
      orbBus.cam.yaw = 0;
      orbBus.cam.pitch = 0;
    }
    if (orbBus.cam.user) {
      // Free flight: orbit the constellation on drag, zoom on wheel.
      const { yaw, pitch, radius } = orbBus.cam;
      const cp = Math.cos(pitch);
      const target = new THREE.Vector3(
        radius * Math.sin(yaw) * cp,
        radius * Math.sin(pitch),
        radius * Math.cos(yaw) * cp
      );
      cam.position.lerp(target, Math.min(1, delta * 6));
    } else {
      // Cinematic auto camera: fit the constellation + pointer parallax.
      const zGoal = constellationOut ? orbBus.cameraZ : 4.2;
      orbBus.cam.radius = zGoal; // keep free-cam zoom in sync for a smooth grab
      cam.position.z += (zGoal - cam.position.z) * Math.min(1, delta * 1.5);
      // Pointer parallax on desktop; device-tilt parallax on phones — the
      // constellation shifts like a window into somewhere.
      const px = state.pointer.x * 0.35 + orbBus.gyroX * 0.55;
      const py = state.pointer.y * 0.22 - orbBus.gyroY * 0.4;
      cam.position.x += (px - cam.position.x) * 0.04;
      cam.position.y += (py - cam.position.y) * 0.04;
    }
    cam.lookAt(0, 0, 0);

    // Debug tap (read via DevTools: __hviOrbDebug) — cheap scalars only.
    (window as unknown as Record<string, unknown>).__hviOrbDebug = {
      uTime: u.uTime.value,
      uMorph: u.uMorph.value,
      uOrbScale: u.uOrbScale.value,
      uFlood: u.uFlood.value,
      appliedVersion: appliedVersion.current,
      busVersion: orbBus.targetsVersion,
      attrSample: targetAttr.current ? targetAttr.current.array[15600 * 3] : null,
    };

    // ── Project label anchors to screen space for the HTML chips ──
    if (orbBus.anchors.length) {
      const { width, height } = state.size;
      for (const a of orbBus.anchors) {
        projVec.set(a.pos[0], a.pos[1], a.pos[2]).project(cam);
        const entry = orbBus.screens.get(a.id) ?? { x: 0, y: 0, visible: false };
        entry.x = (projVec.x * 0.5 + 0.5) * width;
        entry.y = (-projVec.y * 0.5 + 0.5) * height;
        entry.visible = morph.current > 0.55 && projVec.z < 1;
        orbBus.screens.set(a.id, entry);
      }
    }
  });

  return (
    <group>
      <sprite ref={glow} position={[0, 0, -0.6]}>
        <spriteMaterial map={glowTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <lineSegments>
        <bufferGeometry ref={lineGeom}>
          <bufferAttribute attach="attributes-position" args={[lineBuffer, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          ref={lineMat}
          color={new THREE.Color(0.35, 1.0, 0.6)}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
      <points ref={points}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[spheres, 3]} />
          <bufferAttribute attach="attributes-aSphere" args={[spheres, 3]} />
          <bufferAttribute ref={targetAttr} attach="attributes-aTarget" args={[initialTargets, 3]} />
          <bufferAttribute attach="attributes-aSeed" args={[seeds, 1]} />
          <bufferAttribute attach="attributes-aKind" args={[kinds, 1]} />
          <bufferAttribute attach="attributes-aMorphW" args={[morphWs, 1]} />
          <bufferAttribute ref={nodeKindAttr} attach="attributes-aNodeKind" args={[initialNodeKinds, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={material}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}

export default function Orb() {
  return (
    <Canvas
      camera={{ position: [0, 0, 4.2], fov: 50 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      dpr={[1, 2]}
      style={{ position: "absolute", inset: 0 }}
    >
      <CameraRig />
      <Particles />
    </Canvas>
  );
}
