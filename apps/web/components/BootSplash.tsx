"use client";

// Boot splash: the bull + wordmark over black while the WebGL orb and the
// gateway connection warm up. Fades out once we're connected (min-show so it
// never strobes), with a hard timeout so a dead network can't trap the UI
// behind it. On installed PWAs this picks up exactly where the OS launch
// image leaves off — same artwork, so the handoff is seamless.

import { useEffect, useState } from "react";
import { useHvi } from "@/lib/store";

const MIN_SHOW_MS = 900;
const MAX_SHOW_MS = 3500;
const FADE_MS = 600;

export default function BootSplash() {
  const connected = useHvi((s) => s.connected);
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  const [bornAt] = useState(() => Date.now());

  useEffect(() => {
    if (phase !== "shown") return;
    const fade = () => setPhase("fading");
    if (connected) {
      const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - bornAt));
      const t = setTimeout(fade, wait);
      return () => clearTimeout(t);
    }
    const t = setTimeout(fade, MAX_SHOW_MS - (Date.now() - bornAt));
    return () => clearTimeout(t);
  }, [connected, phase, bornAt]);

  useEffect(() => {
    if (phase !== "fading") return;
    const t = setTimeout(() => setPhase("gone"), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Debug tap (same pattern as __hviOrbDebug): when the splash showed, when
  // it faded — lets a headless check prove the lifecycle it can't screenshot.
  useEffect(() => {
    const w = window as unknown as { __jarvoBoot?: Record<string, number> };
    w.__jarvoBoot = w.__jarvoBoot ?? { shownAt: bornAt };
    if (phase === "fading") w.__jarvoBoot.fadeAt = Date.now();
    if (phase === "gone") w.__jarvoBoot.goneAt = Date.now();
  }, [phase, bornAt]);

  if (phase === "gone") return null;

  return (
    <div className={`boot-splash ${phase === "fading" ? "boot-fade" : ""}`} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- static export, no optimizer */}
      <img className="boot-logo" src="/icon-192.png" alt="" width={112} height={112} />
      <div className="boot-word">JARVO</div>
      <div className="boot-sub">Houston Voice Intelligence</div>
    </div>
  );
}
