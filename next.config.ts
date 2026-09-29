import type { NextConfig } from "next";

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  allowedDevOrigins: ["127.0.0.1"],
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
