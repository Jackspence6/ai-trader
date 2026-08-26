#!/usr/bin/env node
//
// Runs the events-engine test suite under whichever Python this machine has.
//
// Three things go wrong on a clean box, and all three used to look like "the
// test suite is broken":
//
//   * `python` does not exist. macOS has shipped only `python3` since Monterey,
//     so a bare `python` in a package script fails on the exact machine this is
//     deployed to.
//   * The engine's dependencies are not installed on the host. The engine
//     itself runs in Docker, so nothing else needs them — but pytest imports
//     the package directly.
//   * pytest's rootdir. The `[tool.pytest.ini_options]` that turns on
//     asyncio_mode lives in the backend's own pyproject.toml, so running from
//     anywhere else silently drops async support and four tests "fail".
//
// This resolves all three explicitly and, when it cannot, says which one it hit
// and the command that fixes it. It never skips tests quietly: a suite that
// reports success without running is worse than one that fails.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(repo, "services", "events-engine", "backend");
const venv = path.join(backend, ".venv", "bin", "python");

function works(exe) {
  if (!exe) return false;
  const r = spawnSync(exe, ["-c", "import pytest, pytest_asyncio, oddsengine"], {
    cwd: backend,
    stdio: "ignore",
  });
  return r.status === 0;
}

function which(exe) {
  try {
    execFileSync(exe, ["--version"], { stdio: "ignore" });
    return exe;
  } catch {
    return null;
  }
}

const candidates = [existsSync(venv) ? venv : null, which("python3"), which("python")];
const python = candidates.find((c) => works(c));

if (!python) {
  const found = candidates.filter(Boolean);
  console.error("\n  The events-engine tests could not run.\n");
  if (found.length === 0) {
    console.error("  No Python interpreter was found. Install Python 3.10 or newer.\n");
  } else {
    console.error(`  Python is present (${found[0]}) but the engine's packages are not`);
    console.error("  installed for it. The engine normally runs in Docker, so this only");
    console.error("  matters for running its tests on the host:\n");
    console.error("    pnpm setup:engine\n");
    console.error("  or by hand:\n");
    console.error(`    cd ${path.relative(repo, backend)}`);
    console.error("    python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'\n");
  }
  process.exit(1);
}

// cwd is the backend so pytest finds its own pyproject.toml as rootdir.
const run = spawnSync(python, ["-m", "pytest", "-q", ...process.argv.slice(2)], {
  cwd: backend,
  stdio: "inherit",
});
process.exit(run.status ?? 1);
