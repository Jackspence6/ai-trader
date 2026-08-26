import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone: a self-contained server with only the modules the
  // running app actually imports, traced from the build. It is additive — the
  // normal build output is still produced — and it is what makes deployment to
  // a machine that cannot afford to compile anything possible.
  output: "standalone",
};

export default nextConfig;
