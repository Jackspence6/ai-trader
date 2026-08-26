#!/usr/bin/env node
//
// Assembles a bundle that runs the console on a machine that cannot afford to
// build it.
//
// The deployment target for this is an old, slow box of unknown operating
// system. On a machine like that the expensive and failure-prone steps are the
// two we can remove entirely: `pnpm install` (610MB of packages, of which the
// running app imports about 35MB) and `next build` (the step most likely to run
// out of memory on 4GB). Next's `output: "standalone"` traces what the server
// actually imports at runtime, so this bundle needs no package manager, no
// build, and no toolchain — only Node.
//
// What it cannot do is run the two engines: the Asset loop and the recorder are
// TypeScript entry points that need tsx and the dev dependency tree. That is a
// deliberate line. This bundle is the console, which is the thing you want up
// first and the thing that has to look right; the engines come with a full
// install on a machine that can take one.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repo, "dist-bundle");
const next = path.join(repo, ".next");

if (!existsSync(path.join(next, "standalone"))) {
  console.error("\n  No standalone output found. Run `pnpm build` first.");
  console.error("  (next.config.ts must have output: \"standalone\" — it does by default.)\n");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The traced server and its minimal node_modules.
cpSync(path.join(next, "standalone"), out, { recursive: true });
// Static assets are not traced — Next expects them copied alongside.
cpSync(path.join(next, "static"), path.join(out, ".next", "static"), { recursive: true });
// The template, so the first thing you do on the box is copy and edit a file
// that documents itself.
cpSync(path.join(repo, ".env.example"), path.join(out, ".env.example"));

// Drop sharp.
//
// Next traces it because it *could* be needed by the image optimiser. This app
// renders no images through next/image — there is not one import of it — so
// sharp is never loaded, and it is the single largest thing in the bundle
// (17MB of the 51) and the only native binary in it.
//
// Removing it therefore does two things: it halves the download, and it makes
// the bundle portable. With sharp in, the bundle is Linux-x64 only, because
// that is where it was built; without it, everything left is JavaScript and
// the same folder runs on Windows, macOS and Linux. Given the target is a
// machine whose operating system we do not know, that is the more valuable
// half of the trade.
//
// If a future screen does use next/image, this will fail loudly at runtime on
// the first request for an optimised image rather than silently, and the fix
// is to delete these lines.
const sharpDirs = readdirSync(path.join(out, "node_modules", ".pnpm"), { withFileTypes: true })
  .filter((e) => e.name.startsWith("@img+") || e.name.startsWith("sharp@"))
  .map((e) => path.join(out, "node_modules", ".pnpm", e.name));
for (const dir of [...sharpDirs, path.join(out, "node_modules", "@img"), path.join(out, "node_modules", "sharp")]) {
  rmSync(dir, { recursive: true, force: true });
}
if (sharpDirs.length > 0) console.log(`  dropped sharp (${sharpDirs.length} packages) — bundle is now platform-independent`);

// The launcher. Node's own env-file loading is not applied by the standalone
// server, so without this you would have to set SITE_PASSWORD in the shell —
// which is three different incantations on three operating systems and the
// single most likely thing to go wrong at 6am on a machine you do not use.
writeFileSync(
  path.join(out, "start.mjs"),
  `#!/usr/bin/env node
//
// Start the Meridian console.
//
//   node start.mjs
//
// Reads .env.local (then .env) from this folder, checks the one setting that
// must be present, and starts the server. Nothing to install.

import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.error(\`\\n  Could not read \${file}: \${err.message}\\n\`);
      process.exit(1);
    }
  }
}

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  console.error(\`\\n  Node \${process.versions.node} is too old — this needs 22 or newer.\`);
  console.error("  https://nodejs.org — take the LTS download.\\n");
  process.exit(1);
}

// The site lock fails closed: with no password the console starts and refuses
// every login, which looks like a broken build rather than a missing setting.
// Say so here instead.
if (!process.env.SITE_PASSWORD) {
  console.error("\\n  SITE_PASSWORD is not set, so nothing would be able to log in.\\n");
  console.error("  Copy .env.example to .env.local in this folder and put a password in it:");
  console.error("      SITE_PASSWORD=something-only-you-know\\n");
  process.exit(1);
}

process.env.PORT ||= "3000";
process.env.HOSTNAME ||= "0.0.0.0";
process.env.NODE_ENV = "production";

console.log(\`\\n  Meridian console starting on http://localhost:\${process.env.PORT}\`);
console.log("  Leave this window open. Ctrl+C stops it.\\n");

await import("./server.js");
`,
);

// Unix convenience wrapper. Windows users run `node start.mjs`, which is why
// the launcher above is the real entry point rather than a shell script.
writeFileSync(
  path.join(out, "start.sh"),
  "#!/usr/bin/env bash\ncd \"$(dirname \"$0\")\"\nexec node start.mjs\n",
  { mode: 0o755 },
);
writeFileSync(
  path.join(out, "start.cmd"),
  "@echo off\r\ncd /d \"%~dp0\"\r\nnode start.mjs\r\npause\r\n",
);

const version = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version;
writeFileSync(
  path.join(out, "BUNDLE.txt"),
  `Meridian console — prebuilt bundle, version ${version}

WHAT THIS IS
  The console, already built. It needs Node 22 or newer and nothing else:
  no package manager, no build step, no Docker.

TO RUN IT
  1. Copy .env.example to .env.local
  2. Open .env.local and set SITE_PASSWORD to something only you know
  3. Windows:  double-click start.cmd
     Mac/Linux: ./start.sh
  4. Open http://localhost:3000

WHAT IT WILL SHOW
  The header will read PAPER. No real money is at risk and that is enforced
  in code, not by configuration.

  Without a database it has no history: NAV, the capital ladder and the event
  board will say so rather than showing zeroes as though they were measured.
  Without the engines running, nothing scans. Both are normal for a first
  bring-up and both are visible on /system.

WHAT IT CANNOT DO
  Run the Asset loop or the recorder — those need a full install
  (pnpm install) on a machine that can take one. See docs/deploy-old-machine.md
  in the repository.
`,
);

console.log(`bundle -> ${path.relative(repo, out)}`);
