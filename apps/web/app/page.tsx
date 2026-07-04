"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import HUD from "@/components/HUD";
import ConstellationLabels from "@/components/ConstellationLabels";
import { voice } from "@/lib/voice";

const Orb = dynamic(() => import("@/components/Orb"), { ssr: false });

export default function Home() {
  useEffect(() => {
    voice.start();
  }, []);

  return (
    <main className="stage">
      <Orb />
      <ConstellationLabels />
      <HUD />
    </main>
  );
}
