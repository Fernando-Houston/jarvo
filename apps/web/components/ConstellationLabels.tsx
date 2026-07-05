"use client";

// Floating labels for constellation nodes: an HTML chip per parcel, glued to
// its 3D anchor every frame (positions come from the orb's projection pass
// via orbBus — no react re-renders at 60fps, just direct style writes).

import { useEffect, useRef } from "react";
import { useHvi } from "@/lib/store";
import { orbBus } from "@/lib/orbBus";

function money(n: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

export default function ConstellationLabels() {
  const chips = useHvi((s) => s.chips);
  const refs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // Clamp each chip to the viewport so edge nodes don't bleed off-screen
      // (chips are translate(-50%), so keep the center within half-width of
      // both edges). Cheap here — the constellation holds ~5 chips.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 6;
      for (const [id, el] of refs.current) {
        const screen = orbBus.screens.get(id);
        if (!screen || !screen.visible) {
          el.style.opacity = "0";
        } else {
          el.style.opacity = "1";
          const halfW = el.offsetWidth / 2;
          const x = Math.max(halfW + margin, Math.min(vw - halfW - margin, screen.x));
          const y = Math.max(margin, Math.min(vh - el.offsetHeight - margin, screen.y + 14));
          el.style.transform = `translate(-50%, 0) translate(${x}px, ${y}px)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // The focus parcel is described by the side card; label only the memories.
  const memoryChips = chips.filter((c) => !c.isFocus);

  return (
    <div className="labels-layer" aria-hidden>
      {memoryChips.map((chip) => (
        <div
          key={chip.id}
          className={`node-chip ${chip.isFocus ? "focus" : ""}`}
          onClick={() => {
            // Tap a node to travel there: instant local refocus (map + card)
            // plus the spoken answer — no waiting on the round-trip.
            if (chip.id !== "comps-summary") {
              import("@/lib/voice").then(({ voice }) => voice.focusNode(chip.id, chip.label));
            }
          }}
          ref={(el) => {
            if (el) refs.current.set(chip.id, el);
            else refs.current.delete(chip.id);
          }}
        >
          <span className="chip-addr">{chip.label}</span>
          <span className="chip-meta">
            {money(chip.value)}
            {chip.distanceMi != null && ` · ${chip.distanceMi < 0.1 ? "nearby" : chip.distanceMi.toFixed(1) + " mi"}`}
          </span>
        </div>
      ))}
    </div>
  );
}
