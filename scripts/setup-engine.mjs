#!/usr/bin/env node
//
// Installs the events engine's Python packages into a virtual environment
// beside the engine, so its tests can run on the host.
//
// The engine itself runs in Docker in normal operation; this exists purely so
// `pnpm test:all` is a complete statement about the system rather than a
// statement about the TypeScript half of it. The venv is local to the repo and
// gitignored — nothing is installed into the machine's Python.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(repo, "services", "events-engine", "backend");
const venv = path.join(backend, ".venv");
const py = path.join(venv, "bin", "python");

function run(exe, args, cwd = backend) {
  const r = spawnSync(exe, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(py)) {
  console.log(`creating ${path.relative(repo, venv)}`);
  const host = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0 ? "python3" : "python";
  run(host, ["-m", "venv", ".venv"]);
}

// -e so the tests import the working tree, not a stale copy; -c so the versions
// are the ones the 137 engine tests were actually run against rather than
// whatever pip resolves today.
run(py, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);

const pinned = spawnSync(
  py,
  ["-m", "pip", "install", "--quiet", "-c", "constraints.txt", "-e", ".[dev]"],
  { cwd: backend, stdio: "inherit" },
);
if (pinned.status !== 0) {
  // A platform that cannot satisfy the pins should still end up with a working
  // engine — but it must be loud about it, because it is no longer the tested
  // combination.
  console.warn("\n  constraints.txt could not be satisfied on this platform.");
  console.warn("  Installing unpinned instead: this is NOT the tested version set.\n");
  run(py, ["-m", "pip", "install", "--quiet", "-e", ".[dev]"]);
}

const check = spawnSync(py, ["-c", "import pytest, pytest_asyncio, oddsengine; print('engine ready')"], {
  cwd: backend,
  stdio: "inherit",
});
process.exit(check.status ?? 1);
