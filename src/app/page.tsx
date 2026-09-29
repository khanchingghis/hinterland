"use client";

import dynamic from "next/dynamic";

const Explorer = dynamic(() => import("@/components/explorer").then((mod) => mod.Explorer), {
  ssr: false,
  loading: () => (
    <div className="grid h-dvh place-items-center bg-[#e7e1d4] text-[#2a241c]">
      <p className="font-display text-3xl">Hinterland</p>
    </div>
  ),
});

export default function Home() {
  return <Explorer />;
}
