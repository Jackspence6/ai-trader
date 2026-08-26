// Module resolution for the event-desk harness, which runs the TypeScript
// sources directly under `--experimental-strip-types` rather than through a
// bundler. Two things Node does not do on its own:
//
//   * extensionless relative imports — TypeScript's convention, not Node's;
//   * the `@/` path alias, which tsconfig maps to `src/`.
//
// The alias matters more than it looks. Without it the harness silently
// diverges from the app: a module can only be tested here if it avoids the
// import style the rest of the codebase uses, which is exactly backwards.

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(repo, "src");

function withExtension(basePath) {
  if (/\.[cm]?[jt]sx?$/.test(basePath) && existsSync(basePath)) return basePath;
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
    if (existsSync(basePath + ext)) return basePath + ext;
  }
  for (const ext of [".ts", ".tsx", ".js"]) {
    const idx = path.join(basePath, "index" + ext);
    if (existsSync(idx)) return idx;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  // tsconfig paths: "@/*" -> "src/*"
  if (specifier.startsWith("@/")) {
    const resolved = withExtension(path.join(srcRoot, specifier.slice(2)));
    if (resolved) return next(pathToFileURL(resolved).href, context);
  }

  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      const resolved = withExtension(base);
      if (resolved) return next(pathToFileURL(resolved).href, context);
    } catch {
      /* fall through to default resolution */
    }
  }

  return next(specifier, context);
}
