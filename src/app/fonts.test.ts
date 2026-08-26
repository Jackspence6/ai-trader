/**
 * The typefaces are part of the build, not a runtime download.
 *
 * This exists because the opposite was true for several commits without
 * anyone noticing: the fonts were fetched from Google at build time, and the
 * offline workaround left the repo rendering in system faces. A console in the
 * wrong typeface still looks like a console, so nothing failed and nothing
 * looked broken — it was simply not the product.
 *
 * These assertions are cheap and catch the three ways it can regress: a font
 * file dropped in a merge, a truncated binary, and fonts.ts quietly going back
 * to a network source.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const appDir = path.join(process.cwd(), "src", "app");

describe("typography ships with the build", () => {
  const faces = [
    { file: "inter-latin-variable.woff2", minBytes: 20_000 },
    { file: "jetbrains-mono-latin-variable.woff2", minBytes: 20_000 },
  ];

  for (const { file, minBytes } of faces) {
    it(`${file} is present and is a real woff2`, () => {
      const full = path.join(appDir, "fonts", file);
      const size = statSync(full).size;
      expect(size).toBeGreaterThan(minBytes);

      // woff2 files start with the ASCII signature "wOF2".
      const head = readFileSync(full).subarray(0, 4).toString("latin1");
      expect(head).toBe("wOF2");
    });
  }

  it("has the licence beside the files it covers", () => {
    for (const name of ["Inter-LICENSE.txt", "JetBrainsMono-LICENSE.txt"]) {
      const text = readFileSync(path.join(appDir, "fonts", name), "utf8");
      expect(text).toContain("SIL Open Font License");
    }
  });

  it("loads the faces locally, never over the network at build time", () => {
    const src = readFileSync(path.join(appDir, "fonts.ts"), "utf8");
    // Match the import, not the string: the module's own comment explains why
    // it no longer uses the google loader, and a naive substring check would
    // fail on the explanation.
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toContain("next/font/local");
    // next/font/google fetches at build time, which is what made the build
    // depend on the network and produced the swap that caused the bug.
    expect(imports).not.toContain("next/font/google");
  });
});
