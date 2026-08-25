import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const ext of [".ts", ".tsx", ".js"]) {
      try {
        const candidate = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return next(specifier + ext, context);
        }
      } catch { /* fall through to default resolution */ }
    }
  }
  return next(specifier, context);
}
