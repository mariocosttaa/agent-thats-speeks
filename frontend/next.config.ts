import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Smaller production image for Docker (standalone server bundle).
  output: "standalone",
};

export default nextConfig;
