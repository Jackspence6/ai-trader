import type { NextConfig } from "next";

/**
 * `output: "standalone"` is opt-in, not the default, and the reason is worth
 * writing down.
 *
 * Standalone emits a self-contained server with only the modules the running
 * app imports — about 35MB against the 610MB in node_modules — which is what
 * makes it possible to deploy to a machine that cannot afford to build. But
 * setting it unconditionally breaks the ordinary path: `next start` refuses to
 * run against a standalone build and says so, and `pnpm start` is the command
 * in the README, the quickstart, the deployment checklist and the last line of
 * bootstrap. A deployment where the documented start command prints "does not
 * work" is worse than one that needs an extra flag.
 *
 * So `pnpm bundle` sets MERIDIAN_BUNDLE=1 and everything else gets the normal
 * build. scripts/bundle.mjs sets it itself rather than the package script
 * doing it, because `VAR=1 cmd` is not a thing on Windows.
 */
const nextConfig: NextConfig = {
  // A separate distDir as well, so a bundle build does not leave `.next` in the
  // standalone shape. Without this, running `pnpm bundle` and then `pnpm start`
  // in the same checkout gives you the "next start does not work with output:
  // standalone" warning on a tree that was fine a minute ago, and nothing in
  // the working copy explains why.
  ...(process.env.MERIDIAN_BUNDLE === "1"
    ? { output: "standalone" as const, distDir: ".next-bundle" }
    : {}),
};

export default nextConfig;
