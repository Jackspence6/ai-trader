#!/usr/bin/env node
// Swap the typography module between the webfont build and the system-font
// build. `on` makes the build work with no outbound network; `off` restores.
//
// Idempotent both ways so a build interrupted halfway does not leave the repo
// in the offline state without anyone noticing.

import { copyFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const live = path.join(repo, "src/app/fonts.ts");
const offline = path.join(repo, "src/app/fonts.offline.ts");
const backup = path.join(repo, "src/app/.fonts.online.bak");

const mode = process.argv[2];
if (mode === "on") {
  if (!existsSync(backup)) copyFileSync(live, backup);
  writeFileSync(live, readFileSync(offline, "utf8"));
  console.log("fonts: offline (system faces)");
} else if (mode === "off") {
  if (existsSync(backup)) {
    writeFileSync(live, readFileSync(backup, "utf8"));
    unlinkSync(backup);
    console.log("fonts: online (Inter + JetBrains Mono)");
  } else {
    console.log("fonts: already online");
  }
} else {
  console.error("usage: offline-fonts.mjs on|off");
  process.exit(1);
}
