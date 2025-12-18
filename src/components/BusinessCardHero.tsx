"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  AdaptiveDpr,
  RoundedBox,
  Sparkles,
  useProgress,
  useTexture,
} from "@react-three/drei";
import * as THREE from "three";

type OrientationState = {
  beta: number | null;
  gamma: number | null;
  alpha: number | null;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function damp(current: number, target: number, lambda: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function useDeviceOrientation() {
  const [orientation, setOrientation] = useState<OrientationState>({
    beta: null,
    gamma: null,
    alpha: null,
  });
  const [permissionState, setPermissionState] = useState<
    "unknown" | "granted" | "denied" | "not_required"
  >("unknown");

  const isIOSPermissionAPI =
    typeof window !== "undefined" &&
    typeof (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent !==
      "undefined" &&
    typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission ===
      "function";

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onDeviceOrientation = (e: DeviceOrientationEvent) => {
      setOrientation({
        beta: typeof e.beta === "number" ? e.beta : null,
        gamma: typeof e.gamma === "number" ? e.gamma : null,
        alpha: typeof e.alpha === "number" ? e.alpha : null,
      });
    };

    const startListening = () => {
      window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
      return () => window.removeEventListener("deviceorientation", onDeviceOrientation);
    };

    if (!isIOSPermissionAPI) {
      // Non-iOS Safari: permission is typically not required, start immediately.
      setPermissionState("not_required");
      const stop = startListening();
      return () => stop();
    }

    // iOS Safari: check if permission was previously granted
    const wasGranted = localStorage.getItem("device-orientation-permission") === "granted";
    
    if (wasGranted) {
      // Try to start listening - if permission is still granted, events will fire
      setPermissionState("granted");
      const stop = startListening();
      
      // Verify permission is still active by checking if we receive events
      const timeout = setTimeout(() => {
        // If no events after 500ms, permission might have been revoked
        // This is a best-effort check
      }, 500);
      
      return () => {
        clearTimeout(timeout);
        stop();
      };
    }

    // iOS Safari: wait for explicit user gesture to request permission.
    setPermissionState("unknown");
    return;
  }, [isIOSPermissionAPI]);

  const requestPermission = useCallback(async () => {
    if (!isIOSPermissionAPI) return true;
    try {
      const result = await (
        DeviceOrientationEvent as unknown as { requestPermission: () => Promise<"granted" | "denied"> }
      ).requestPermission();
      if (result === "granted") {
        setPermissionState("granted");
        // Store permission state in localStorage
        localStorage.setItem("device-orientation-permission", "granted");
        const onDeviceOrientation = (e: DeviceOrientationEvent) => {
          setOrientation({
            beta: typeof e.beta === "number" ? e.beta : null,
            gamma: typeof e.gamma === "number" ? e.gamma : null,
            alpha: typeof e.alpha === "number" ? e.alpha : null,
          });
        };
        window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
        return true;
      }
      setPermissionState("denied");
      localStorage.setItem("device-orientation-permission", "denied");
      return false;
    } catch {
      setPermissionState("denied");
      localStorage.setItem("device-orientation-permission", "denied");
      return false;
    }
  }, [isIOSPermissionAPI]);

  const isSupported =
    typeof window !== "undefined" && "DeviceOrientationEvent" in window && window.isSecureContext;

  return { orientation, isSupported, permissionState, requestPermission, isIOSPermissionAPI };
}

function LoadingBridge({
  onProgress,
  onLoaded,
}: {
  onProgress: (p: number) => void;
  onLoaded: () => void;
}) {
  const { progress, active } = useProgress();
  const doneRef = useRef(false);

  useEffect(() => {
    onProgress(progress);
    if (!active && progress >= 100 && !doneRef.current) {
      doneRef.current = true;
      onLoaded();
    }
  }, [active, onLoaded, onProgress, progress]);

  return null;
}

function Card({
  flipped,
  rotated,
  interactive,
  tiltStrength,
  deviceTilt,
  onToggleFlip,
  intro,
}: {
  flipped: boolean;
  rotated: boolean;
  interactive: boolean;
  tiltStrength: number;
  deviceTilt: { x: number; y: number };
  onToggleFlip: () => void;
  intro: { ready: boolean; t: number };
}) {
  const group = useRef<THREE.Group>(null);
  const edgeMaterial = useRef<THREE.MeshPhysicalMaterial>(null);
  const { pointer, viewport } = useThree();

  const frontMap = useTexture("/card-front.png");
  const backMap = useTexture("/card-back.png");
  const [frontMapFitted, setFrontMapFitted] = useState<THREE.Texture | null>(null);
  const [backMapFitted, setBackMapFitted] = useState<THREE.Texture | null>(null);

  const { faceGeo, cardW, cardH, thickness, cornerR } = useMemo(() => {
    const cardW = 1.75;
    const cardH = 1.0;
    const thickness = 0.04;
    const cornerR = 0.12;

    const w = cardW;
    const h = cardH;
    const r = Math.min(cornerR, w * 0.5, h * 0.5);

    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + r, -h / 2);
    shape.lineTo(w / 2 - r, -h / 2);
    shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    shape.lineTo(w / 2, h / 2 - r);
    shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    shape.lineTo(-w / 2 + r, h / 2);
    shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    shape.lineTo(-w / 2, -h / 2 + r);
    shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);

    const faceGeo = new THREE.ShapeGeometry(shape, 48);
    // Ensure the texture maps perfectly to the card face (0..1 UVs), avoiding
    // default ShapeGeometry UV quirks that can cause cropping/stretching.
    {
      const pos = faceGeo.getAttribute("position") as THREE.BufferAttribute;
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const u = (x + w / 2) / w;
        const v = (y + h / 2) / h;
        uv[i * 2 + 0] = u;
        uv[i * 2 + 1] = v;
      }
      faceGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }
    faceGeo.computeVertexNormals();

    return { faceGeo, cardW, cardH, thickness, cornerR };
  }, []);

  const fitScale = useMemo(() => {
    // viewport.{width,height} are in world-units at z=0 for the current camera.
    // We fit the *rotating* card with a generous margin, especially in portrait.
    const portrait = viewport.width < viewport.height;
    const isMobile = viewport.width < 768 || portrait; // Mobile detection
    const margin = portrait ? 1.55 : 1.35; // more headroom in portrait to avoid side cropping when tilted
    const sW = viewport.width / (cardW * margin);
    const sH = viewport.height / (cardH * margin);
    const baseScale = clamp(Math.min(sW, sH), 0.6, 1.25);
    // 120% zoom on mobile
    return isMobile ? baseScale * 1.2 : baseScale;
  }, [cardH, cardW, viewport.height, viewport.width]);

  useEffect(() => {
    // Fit textures into the card aspect ratio without deformation.
    // If the image aspect doesn't match the card, we letterbox with a
    // background color sampled from the image itself (avoids ugly edge-smear).
    const targetAspect = cardW / cardH;

    const makeFitted = (src: THREE.Texture) => {
      const img = src.image as
        | HTMLImageElement
        | HTMLCanvasElement
        | ImageBitmap
        | OffscreenCanvas
        | undefined;
      if (!img) return null;

      // Best-effort get dimensions across image sources.
      const w =
        "naturalWidth" in img
          ? img.naturalWidth
          : "width" in img
            ? (img.width as number)
            : 0;
      const h =
        "naturalHeight" in img
          ? img.naturalHeight
          : "height" in img
            ? (img.height as number)
            : 0;
      if (!w || !h) return null;

      const outW = 1024;
      const outH = Math.max(1, Math.round(outW / targetAspect));
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      // Sample a 1x1 average-ish color from the image for the letterbox fill.
      const sample = document.createElement("canvas");
      sample.width = 1;
      sample.height = 1;
      const sctx = sample.getContext("2d");
      if (sctx) {
        sctx.drawImage(img as CanvasImageSource, 0, 0, 1, 1);
        const [r, g, b] = sctx.getImageData(0, 0, 1, 1).data;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      } else {
        ctx.fillStyle = "#0b0f17";
      }
      ctx.fillRect(0, 0, outW, outH);

      const imgAspect = w / h;
      let drawW = outW;
      let drawH = outH;
      if (imgAspect > targetAspect) {
        // Image is wider than the card: fit by width.
        drawW = outW;
        drawH = Math.round(outW / imgAspect);
      } else {
        // Image is taller than the card: fit by height.
        drawH = outH;
        drawW = Math.round(outH * imgAspect);
      }
      const dx = Math.round((outW - drawW) / 2);
      const dy = Math.round((outH - drawH) / 2);
      ctx.drawImage(img as CanvasImageSource, dx, dy, drawW, drawH);

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    };

    const f = makeFitted(frontMap);
    const b = makeFitted(backMap);
    if (f) setFrontMapFitted(f);
    if (b) setBackMapFitted(b);

    return () => {
      f?.dispose();
      b?.dispose();
    };
  }, [backMap, cardH, cardW, frontMap]);

  useEffect(() => {
    frontMap.colorSpace = THREE.SRGBColorSpace;
    backMap.colorSpace = THREE.SRGBColorSpace;
    frontMap.anisotropy = 8;
    backMap.anisotropy = 8;
    frontMap.wrapS = frontMap.wrapT = THREE.ClampToEdgeWrapping;
    backMap.wrapS = backMap.wrapT = THREE.ClampToEdgeWrapping;
  }, [backMap, frontMap]);

  const initializedRef = useRef(false);
  const animationStartTimeRef = useRef<number | null>(null);
  const ANIMATION_DURATION = 1.0; // 1 seconds

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;

    const isMobile = viewport.width < 768 || viewport.width < viewport.height;
    const motionMultiplier = isMobile ? 3.5 : 1; // 3.5x on mobile

    const flipTarget = flipped ? Math.PI : 0; // Y-axis: show back of card
    const rotateTarget = rotated ? Math.PI : 0; // Z-axis: rotate for other person
    const baseHover = Math.sin(state.clock.elapsedTime * 0.9) * 0.03;
    const baseRoll = Math.sin(state.clock.elapsedTime * 0.7) * 0.03;

    const pointerTiltX = -pointer.y * tiltStrength;
    const pointerTiltY = pointer.x * tiltStrength;

    // Apply motion multiplier on mobile for device tilt
    const deviceTiltX = deviceTilt.x !== 0 ? deviceTilt.x * tiltStrength * motionMultiplier : 0;
    const deviceTiltY = deviceTilt.y !== 0 ? deviceTilt.y * tiltStrength * motionMultiplier : 0;
    
    const tiltX = deviceTiltX !== 0 ? deviceTiltX : pointerTiltX;
    const tiltY = deviceTiltY !== 0 ? deviceTiltY : pointerTiltY;

    // Intro animation: card comes from top, rotates, and scales up (4 seconds duration)
    let introProgress = 1.0;
    const isContentLoaded = intro.t >= 100;
    
    if (isContentLoaded && !intro.ready) {
      // Start animation timer when content is loaded (but before intro.ready)
      if (animationStartTimeRef.current === null) {
        animationStartTimeRef.current = state.clock.elapsedTime;
      }
      const elapsed = state.clock.elapsedTime - (animationStartTimeRef.current ?? 0);
      introProgress = Math.min(elapsed / ANIMATION_DURATION, 1.0);
    } else if (intro.ready) {
      // Animation complete
      animationStartTimeRef.current = null;
      introProgress = 1.0;
    } else {
      // Still loading, keep at 0
      introProgress = 0;
    }
    
    // Smooth ease-in-out for smoother animation
    const introEase = introProgress < 0.5
      ? 2 * introProgress * introProgress
      : 1 - Math.pow(-2 * introProgress + 2, 3) / 2;
    
    // Initialize position on first frame when content is loaded
    if (!initializedRef.current && isContentLoaded) {
      const startY = isMobile ? 1.2 : 1.0;
      g.position.set(0, startY, -1.2);
      g.scale.set(0.3 * fitScale, 0.3 * fitScale, 0.3 * fitScale);
      g.rotation.set(0.05, 0, 0); // No rotation during intro
      initializedRef.current = true;
    }
    
    const isAnimationComplete = introProgress >= 1.0;
    const isAnimating = !isAnimationComplete && introProgress > 0;
    
    // Disable base animations during intro for smoother motion
    const activeBaseHover = isAnimating ? 0 : baseHover;
    const activeBaseRoll = isAnimating ? 0 : baseRoll;
    
    const targetScale = isAnimationComplete
      ? 1.0 * fitScale 
      : (0.3 + introEase * 0.7) * fitScale; // Start at 30%, grow to 100%
    // Smoother damping during animation
    const scaleDamping = isAnimating ? 5 : 8;
    g.scale.x = damp(g.scale.x, targetScale, scaleDamping, dt);
    g.scale.y = damp(g.scale.y, targetScale, scaleDamping, dt);
    g.scale.z = damp(g.scale.z, targetScale, scaleDamping, dt);
    
    // Position: start from top, animate to final position
    const startY = isMobile ? 1.2 : 1.0; // Start higher on mobile
    const finalY = isMobile 
      ? (activeBaseHover + 0.35) // Higher position on mobile
      : (activeBaseHover - 0.03);
    const targetY = isAnimationComplete
      ? finalY 
      : startY - (startY - finalY) * introEase;
    // Smoother damping during animation
    const positionDamping = isAnimating ? 4 : 7;
    g.position.y = damp(g.position.y, targetY, positionDamping, dt);
    
    const startZ = -1.2; // Start further back
    const finalZ = 0;
    const targetZ = isAnimationComplete ? finalZ : startZ - (startZ - finalZ) * introEase;
    g.position.z = damp(g.position.z, targetZ, positionDamping, dt);

    // Disable tilt during animation for smoother motion
    const activeTiltY = isAnimating ? 0 : tiltY * 0.25;
    const activeTiltX = isAnimating ? 0 : tiltX;
    const activePointerRoll = isAnimating ? 0 : pointer.x * 0.04;
    
    // Smoother rotation damping during animation
    const rotationDamping = isAnimating ? 6 : 10;
    g.rotation.y = damp(g.rotation.y, flipTarget + activeTiltY, rotationDamping, dt);
    g.rotation.x = damp(g.rotation.x, activeTiltX + activeBaseHover * 0.15, rotationDamping, dt);
    g.rotation.z = damp(g.rotation.z, rotateTarget + activeBaseRoll + activePointerRoll, rotationDamping, dt);

    if (edgeMaterial.current) {
      edgeMaterial.current.emissiveIntensity = 0.22 + baseHover * 0.6;
    }
  });

  return (
    <group ref={group} position={[0, 0, 0]} rotation={[0.05, 0, 0]}>
      <group
        onPointerDown={(e) => {
          e.stopPropagation();
          if (!interactive) return;
          onToggleFlip();
        }}
      >
        <RoundedBox
          args={[cardW, cardH, thickness]}
          radius={cornerR}
          smoothness={10}
          castShadow
        >
          <meshPhysicalMaterial
            ref={edgeMaterial}
            color="#0b0f17"
            roughness={0.35}
            metalness={0.35}
            clearcoat={1}
            clearcoatRoughness={0.14}
            emissive="#0b1b34"
            emissiveIntensity={0.22}
          />
        </RoundedBox>

        {/* Front */}
        <mesh
          geometry={faceGeo}
          position={[0, 0, thickness / 2 + 0.0015]}
          castShadow
        >
          <meshPhysicalMaterial
            map={frontMapFitted ?? frontMap}
            roughness={0.28}
            metalness={0.05}
            clearcoat={1}
            clearcoatRoughness={0.1}
            sheen={0.5}
            sheenRoughness={0.35}
            sheenColor="#a7c4ff"
          />
        </mesh>

        {/* Back */}
        <mesh
          geometry={faceGeo}
          position={[0, 0, -thickness / 2 - 0.0015]}
          rotation={[0, Math.PI, 0]}
          castShadow
        >
          <meshPhysicalMaterial
            map={backMapFitted ?? backMap}
            roughness={0.32}
            metalness={0.05}
            clearcoat={1}
            clearcoatRoughness={0.12}
            sheen={0.45}
            sheenRoughness={0.4}
            sheenColor="#ffd5ff"
          />
        </mesh>
      </group>
    </group>
  );
}

function Flare({
  tiltStrength,
  deviceTilt,
}: {
  tiltStrength: number;
  deviceTilt: { x: number; y: number };
}) {
  const lightRef = useRef<THREE.SpotLight>(null);
  const { pointer, viewport } = useThree();
  const baseX = -2.4;

  useFrame((state, dt) => {
    if (!lightRef.current) return;

    const isMobile = viewport.width < 768 || viewport.width < viewport.height;
    const motionMultiplier = isMobile ? 3.5 : 1; // 3.5x on mobile

    const pointerTiltY = pointer.x * tiltStrength;
    const deviceTiltY = deviceTilt.y !== 0 ? deviceTilt.y * tiltStrength * motionMultiplier : 0;
    const tiltY = deviceTiltY !== 0 ? deviceTiltY : pointerTiltY;

    const targetX = baseX + tiltY * 3;
    lightRef.current.position.x = damp(lightRef.current.position.x, targetX, 8, dt);
  });

  return (
    <spotLight
      ref={lightRef}
      position={[baseX, 2.2, 3.2]}
      intensity={2.47}
      angle={0.5}
      penumbra={0.85}
      color="#ffd7fa"
    />
  );
}

function Scene({
  flipped,
  rotated,
  interactive,
  tiltStrength,
  deviceTilt,
  onToggleFlip,
  intro,
}: {
  flipped: boolean;
  rotated: boolean;
  interactive: boolean;
  tiltStrength: number;
  deviceTilt: { x: number; y: number };
  onToggleFlip: () => void;
  intro: { ready: boolean; t: number };
}) {
  return (
    <>
      <color attach="background" args={["#05070b"]} />

      <ambientLight intensity={0.69} />
      <hemisphereLight intensity={0.40} color="#cfe0ff" groundColor="#0a0c10" />
      <directionalLight
        position={[3.8, 3.2, 2.6]}
        intensity={2.53}
        color="#d9e8ff"
        castShadow
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-camera-near={0.1}
        shadow-camera-far={18}
        shadow-camera-left={-1.5}
        shadow-camera-right={1.5}
        shadow-camera-top={1.2}
        shadow-camera-bottom={-1.2}
        shadow-radius={8}
        shadow-bias={0.0005}
        shadow-normalBias={0.02}
      />
      <Flare tiltStrength={tiltStrength} deviceTilt={deviceTilt} />
      <pointLight position={[0, 0.25, 2.4]} intensity={1.32} color="#8fb7ff" />

      <Sparkles
        count={36}
        size={2.2}
        speed={0.25}
        opacity={0.22}
        scale={[6.5, 3.5, 2.2]}
        position={[0, 0.25, 0.8]}
        color="#b7d2ff"
      />

      <Card
        flipped={flipped}
        rotated={rotated}
        interactive={interactive}
        tiltStrength={tiltStrength}
        deviceTilt={deviceTilt}
        onToggleFlip={onToggleFlip}
        intro={intro}
      />
    </>
  );
}

function ResponsiveCamera() {
  const { camera, size } = useThree();

  useEffect(() => {
    const aspect = size.width / size.height;
    const isMobile = size.width < 768 || aspect < 1;
    // Keep framing stable on mobile portrait: back camera up a bit.
    // Desktop stays closer for impact.
    const portrait = aspect < 1;
    const nextZ = portrait ? 3.35 : 3.0;
    // Move camera down on mobile to position card at top
    const nextY = isMobile ? (portrait ? -0.15 : -0.12) : (portrait ? 0.05 : 0.04);
    camera.position.set(0, nextY, nextZ);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, size.height, size.width]);

  return null;
}

export function BusinessCardHero() {
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [introReady, setIntroReady] = useState(false);

  const { orientation, isSupported, permissionState, requestPermission, isIOSPermissionAPI } =
    useDeviceOrientation();

  const tiltStrength = 0.28; // premium subtle, keep card in-frame

  const deviceTilt = useMemo(() => {
    if (!isSupported) return { x: 0, y: 0 };
    if (isIOSPermissionAPI && permissionState !== "granted") return { x: 0, y: 0 };

    const beta = orientation.beta ?? 0; // front/back, [-180..180]
    const gamma = orientation.gamma ?? 0; // left/right, [-90..90]

    // Normalize and clamp to keep motion premium and nausea-free.
    const x = clamp(beta, -35, 35) / 35; // -1..1
    const y = clamp(gamma, -35, 35) / 35; // -1..1
    return { x: (x * Math.PI) / 14, y: (y * Math.PI) / 14 };
  }, [isIOSPermissionAPI, isSupported, orientation.beta, orientation.gamma, permissionState]);

  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => setIntroReady(true), 220);
    return () => window.clearTimeout(t);
  }, [loaded]);

  const handleShareVCard = async () => {
    const vCardContent = `BEGIN:VCARD
VERSION:3.0
N:Kévin;RIOU
FN:RIOU Kévin
TITLE:CEO
URL:nare.li
EMAIL;TYPE=INTERNET:kevin@nare.li
TEL;TYPE=voice,work,pref:+33618260849
ADR:;;;Paris;;;France
END:VCARD`;

    try {
      // Create a Blob with the vCard content
      const blob = new Blob([vCardContent], { type: "text/vcard" });
      const file = new File([blob], "contact.vcf", { type: "text/vcard" });

      // Use Web Share API if available (iOS Safari, etc.)
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "RIOU Kévin - Contact",
          text: "Add this contact to your address book",
        });
      } else if (navigator.share) {
        // Fallback: share as text if file sharing not supported
        await navigator.share({
          title: "RIOU Kévin - Contact",
          text: vCardContent,
        });
      } else {
        // Fallback: download the vCard file
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "contact.vcf";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      // User cancelled or error occurred
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Error sharing vCard:", error);
      }
    }
  };

  const showMotionButton =
    isSupported && isIOSPermissionAPI && permissionState !== "granted" && permissionState !== "denied";

  return (
    <div className="relative h-[100svh] w-full overflow-hidden bg-[#05070b] text-white">
      {/* Background glow */}
      <div
        className="pointer-events-none absolute inset-0 opacity-90 bg-[#05070b]"
      />

      <Canvas
        className="absolute inset-0"
        shadows
        dpr={[1, 2]}
        camera={{ position: [0, 0.04, 3.0], fov: 40, near: 0.1, far: 50 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.45;
          gl.outputColorSpace = THREE.SRGBColorSpace;
        }}
      >
        <AdaptiveDpr pixelated />
        <ResponsiveCamera />
        <Suspense fallback={null}>
          <LoadingBridge
            onProgress={(p) => setProgress(p)}
            onLoaded={() => setLoaded(true)}
          />
          <Scene
            flipped={flipped}
            rotated={rotated}
            interactive={loaded}
            tiltStrength={tiltStrength}
            deviceTilt={deviceTilt}
            onToggleFlip={() => setFlipped((v) => !v)}
            intro={{ ready: introReady, t: progress }}
          />
        </Suspense>
      </Canvas>

      {/* Minimal loader + buttons-only UI */}
      <div className="pointer-events-none absolute inset-0">

        <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
          {loaded && isIOSPermissionAPI && permissionState === "denied" && (
            <div className="pointer-events-auto max-w-[280px] rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-center text-xs text-white/70 backdrop-blur">
              Motion is denied (Safari settings). Pointer tilt still works.
            </div>
          )}

          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
            {loaded && showMotionButton && (
              <button
                type="button"
                onClick={async () => {
                  await requestPermission();
                }}
                className="rounded-full border border-white/15 bg-white/10 px-5 py-2 text-sm font-medium text-white/90 backdrop-blur transition hover:bg-white/15"
              >
                Enable motion
              </button>
            )}

            <button
              type="button"
              onClick={() => setRotated((v) => !v)}
              disabled={!loaded}
              className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Flip
            </button>
            <button
              type="button"
              onClick={handleShareVCard}
              disabled={!loaded}
              className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Share
            </button>
          </div>
        </div>
      </div>

      {/* Vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          boxShadow:
            "inset 0 0 0 1px rgba(255,255,255,0.05), inset 0 -120px 220px rgba(0,0,0,0.55), inset 0 120px 220px rgba(0,0,0,0.55), inset 120px 0 220px rgba(0,0,0,0.55), inset -120px 0 220px rgba(0,0,0,0.55)",
        }}
      />
    </div>
  );
}


