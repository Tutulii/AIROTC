import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Isolate from monorepo root lockfile
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
