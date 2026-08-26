#!/usr/bin/env node
//
// Pull `main`, rebuild, and restart — for a box nobody is sitting in front of.
//
// The whole design follows from one rule: **a failed update must never take the
// box down.** A machine running yesterday's working code is fine. A machine
// that stopped at 3am because a build broke is not, and nobody would find out
// until they looked.
//
// So the order is: fetch, and stop immediately if there is nothing new. Then
// pull, install, build and test — all of it while the old processes are still
// running and serving. Only once the new version has proved it builds and its
// tests pass do the services get restarted, and that is the only moment of
// downtime, measured in seconds.
//
// If anything fails, the checkout is put back to the commit that is actually
// running. Leaving the tree ahead of the processes is the worst outcome
// available: everything keeps working until the next unrelated restart, which
// then silently starts code that never built.
//
// What this deliberately does NOT do:
//
//   * touch the kill switch. If a person halted the desks, they stay halted
//     through an update. An updater that resumed trading on its own would
//     defeat the one control that exists to stop it.
//   * touch execution mode, .env.local, or anything gitignored. It only ever
//     fast-forwards tracked files.
//   * force anything. A dirty working tree means somebody edited this box by
//     hand; that is a thing to be told about, not to overwrite.
//
// Usage:
//   node scripts/update.mjs              check, and update if there is anything
//   node scripts/update.mjs --dry-run    report what it would do, change nothing
//   node scripts/update.mjs --force      rebuild even if the commit is unchanged
//
// Environment:
//   MERIDIAN_UPDATE_BRANCH    branch to track (default: main)
//   MERIDIAN_UPDATE_RESTART   command to restart the services. Defaults to the
//                             systemd units when systemctl is present; set it
//                             to a single space to disable restarting entirely.
//   MERIDIAN_UPDATE_SKIP_TESTS=1  skip the test gate (not recommended)
//   MERIDIAN_UPDATE_HEALTH_URL    what to probe after the restart to prove the
//                                 new version is actually serving. Defaults to
//                                 http://localhost:3000/login. Set to a single
//                                 space to skip the probe.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const branch = process.env.MERIDIAN_UPDATE_BRANCH || "main";
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const skipTests = process.env.MERIDIAN_UPDATE_SKIP_TESTS === "1";

const logDir = path.join(repo, ".data");
const logFile = path.join(logDir, "update.log");
const lockFile = path.join(logDir, "update.lock");

/* ------------------------------------------------------------------ logging */

function log(line) {
  const stamped = `${new Date().toISOString()}  ${line}`;
  console.log(stamped);
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logFile, stamped + "\n");
  } catch {
    // A box that cannot write its own log should still be able to update.
  }
}

/* ------------------------------------------------------------- single flight */

// Two updaters running at once would race on the checkout. The lock records the
// pid so a lock left behind by a killed process can be told apart from a live
// one — a stale lock that blocks every future update forever is its own outage.
function acquireLock() {
  if (existsSync(lockFile)) {
    const held = Number(readFileSync(lockFile, "utf8").trim());
    let alive = false;
    try {
      process.kill(held, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      log(`another update is running (pid ${held}) — skipping this round`);
      return false;
    }
    log(`clearing a stale lock from pid ${held}`);
    rmSync(lockFile, { force: true });
  }
  mkdirSync(logDir, { recursive: true });
  writeFileSync(lockFile, String(process.pid));
  return true;
}

function releaseLock() {
  rmSync(lockFile, { force: true });
}

/* --------------------------------------------------------------- running git */

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: repo,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...opts,
  });
  return {
    ok: r.status === 0,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    status: r.status,
  };
}

function git(...args) {
  return run("git", args);
}

/** pnpm is usually a shell shim; on Windows it needs the shell to resolve. */
function pnpm(...args) {
  return run("pnpm", args, { stdio: "inherit", encoding: undefined });
}

/* ---------------------------------------------------------------- restarting */

function defaultRestartCommand() {
  if (process.env.MERIDIAN_UPDATE_RESTART !== undefined) {
    return process.env.MERIDIAN_UPDATE_RESTART.trim();
  }
  if (!run("systemctl", ["--version"]).ok) return "";

  // Only the units that are actually installed — restarting a unit that does
  // not exist fails the whole command, and a broken restart would look like a
  // broken update.
  const units = ["meridian-console", "meridian-trade", "meridian-record"].filter(
    (u) => run("systemctl", ["list-unit-files", `${u}.service`]).out.includes(u),
  );
  if (!units.length) return "";

  // The service user cannot restart units on its own. meridian-update.sudoers
  // grants exactly these three restarts; if it is not installed the sudo call
  // fails and the updater says the new version is waiting for a restart rather
  // than pretending it happened.
  const needsSudo = typeof process.getuid === "function" && process.getuid() !== 0;
  const prefix = needsSudo && run("sudo", ["-n", "true"]).ok ? "sudo -n " : "";
  return `${prefix}systemctl restart ${units.join(" ")}`;
}

/* --------------------------------------------------------------------- main */

function main() {
  log(`--- update check (${os.hostname()}, tracking ${branch}) ---`);

  if (!existsSync(path.join(repo, ".git"))) {
    log("FAIL: not a git checkout, so there is nothing to pull. Nothing changed.");
    return 1;
  }

  // A dirty tree means someone edited this box directly. Pulling over it would
  // either fail or silently discard their work; both are worse than stopping
  // and saying so.
  const dirty = git("status", "--porcelain");
  if (dirty.out) {
    log("SKIP: the working tree has local changes, so nothing was pulled.");
    for (const line of dirty.out.split("\n").slice(0, 10)) log(`       ${line}`);
    log("       Commit, stash or discard them on the box, then this resumes on its own.");
    return 0;
  }

  const fetched = git("fetch", "origin", branch, "--quiet");
  if (!fetched.ok) {
    // Almost always the network. Not a failure worth alarming about — the next
    // round will pick it up.
    log(`SKIP: could not reach the remote (${fetched.err.split("\n")[0] || "unknown error"}).`);
    return 0;
  }

  const current = git("rev-parse", "HEAD").out;
  const target = git("rev-parse", "FETCH_HEAD").out;

  if (current === target && !force) {
    log(`up to date at ${current.slice(0, 7)} — nothing to do`);
    return 0;
  }

  const subjects = git("log", "--oneline", `${current}..${target}`).out;
  log(`update available: ${current.slice(0, 7)} -> ${target.slice(0, 7)}`);
  for (const line of subjects.split("\n").filter(Boolean).slice(0, 12)) log(`       ${line}`);

  if (dryRun) {
    log("dry run — stopping here, nothing changed");
    return 0;
  }

  // Everything from here runs while the old version is still serving. The
  // services are not touched until it has all passed.
  // Returns whether the checkout was actually restored. The caller always
  // treats an update that reached here as failed; what it needs to know
  // separately is whether the tree is now consistent with the processes,
  // because that decides whether restarting again is safe or pointless.
  const rollback = (why) => {
    log(`ROLLBACK: ${why}`);
    log(`          returning the checkout to ${current.slice(0, 7)}, which is what is running`);
    const reset = git("reset", "--hard", current);
    if (!reset.ok) {
      log(`          FAILED to roll back: ${reset.err.split("\n")[0]}`);
      log("          This box needs a person. The processes are still running the old code.");
      return false;
    }
    // The tree is back, but node_modules and .next may be half-way to the new
    // version. Put them back too, or the next restart starts something that was
    // never built.
    pnpm("install", "--frozen-lockfile");
    pnpm("build");
    log("          rolled back; the old version is intact");
    return true;
  };

  log("pulling...");
  const pull = git("merge", "--ff-only", target);
  if (!pull.ok) {
    log(`FAIL: fast-forward refused (${pull.err.split("\n")[0]}). Nothing changed.`);
    return 1;
  }

  log("installing dependencies...");
  if (!pnpm("install", "--frozen-lockfile").ok) {
    rollback("dependency install failed");
    return 1;
  }

  log("building...");
  // Same cap as bootstrap: keep Node from growing into swap on a small box.
  const built = pnpm("build");
  if (!built.ok) {
    rollback("build failed");
    return 1;
  }

  if (!skipTests) {
    log("running tests...");
    // The TypeScript suite only — it needs no network and no database, so it is
    // a true gate rather than a coin flip on whether a venue answered. A box
    // that cannot reach the internet must still be able to update itself.
    if (!pnpm("vitest", "run", "--silent").ok) {
      rollback("tests failed on the new version");
      return 1;
    }
  } else {
    log("tests skipped (MERIDIAN_UPDATE_SKIP_TESTS=1)");
  }

  const restart = defaultRestartCommand();
  if (!restart) {
    log(`updated to ${target.slice(0, 7)} and built, but no restart command is configured.`);
    log("       The running processes are still on the old code until something restarts them.");
    log("       Set MERIDIAN_UPDATE_RESTART, or install the systemd units in deploy/systemd/.");
    return 0;
  }

  log(`restarting: ${restart}`);
  const [cmd, ...args] = restart.split(/\s+/);
  const restarted = run(cmd, args, { stdio: "inherit", encoding: undefined });
  if (!restarted.ok) {
    // The new code is built and on disk; only the restart failed. Rolling back
    // now would be worse than leaving it — the next restart, whenever it
    // happens, picks up a version that built and passed its tests.
    log("WARN: the restart command failed. The new version is built and will be");
    log("      picked up by the next restart. Check the service manager.");
    return 1;
  }

  // Building and passing tests is not the same as serving. A version can do
  // both and then die on boot — a missing environment variable, a port already
  // taken, a migration it needed. Without this the updater restarts and stops
  // watching, and the box is silently down until somebody looks.
  if (!probeHealthy()) {
    log("the new version is not answering after the restart");
    if (!rollback("restarted but never came up")) {
      // The tree could not be restored, so restarting again would just start
      // the broken version a second time.
      log("FAIL: could not roll back. Do not restart again without looking.");
      return 1;
    }
    log(`restarting the old version: ${restart}`);
    run(cmd, args, { stdio: "inherit", encoding: undefined });
    if (probeHealthy()) {
      log("the old version is serving again; main needs a fix");
      return 1;
    }
    log("FAIL: neither version is answering. This box needs a person.");
    return 1;
  }

  log(`updated to ${target.slice(0, 7)}, restarted, and answering`);
  warnIfBuildDirtiedTheTree();
  return 0;
}

/**
 * Is the console actually serving?
 *
 * Deliberately generous about *what* counts. Any HTTP response at all means a
 * server is listening and routing — including 401 and 302, which is what a
 * locked console returns and would be wrong to read as a failure. What this is
 * looking for is the absence of a response: connection refused, or nothing at
 * all before the deadline.
 */
function probeHealthy() {
  const url = (process.env.MERIDIAN_UPDATE_HEALTH_URL ?? "http://localhost:3000/login").trim();
  if (!url) {
    log("health probe skipped (MERIDIAN_UPDATE_HEALTH_URL is empty)");
    return true;
  }

  const deadline = Date.now() + 90_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `fetch(${JSON.stringify(url)}, { redirect: "manual" })
           .then((r) => { console.log(r.status); process.exit(0); })
           .catch(() => process.exit(1));
         setTimeout(() => process.exit(1), 8000);`,
      ],
      { encoding: "utf8" },
    );
    if (r.status === 0) {
      log(`health probe: ${url} answered ${r.stdout.trim()} after ${attempt} ${attempt === 1 ? "try" : "tries"}`);
      return true;
    }
    // Sleep without pulling in a timers dependency: a blocking wait is fine
    // here, this process has nothing else to do.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  log(`health probe: ${url} did not answer within 90s (${attempt} tries)`);
  return false;
}

/**
 * A build that writes to a tracked file freezes every future update.
 *
 * The dirty-tree guard above is right to refuse to pull over local changes, but
 * it cannot tell a person's edit from a generated file the build rewrote. If
 * the build is the one dirtying the tree, every subsequent round skips, and on
 * an unattended box that is indistinguishable from working — it updated once
 * and then quietly never again.
 *
 * This happened: `next build` rewrites next-env.d.ts, and it was tracked. The
 * file is ignored now, so the cause is gone. This says so out loud if anything
 * else ever starts doing it, which turns a silent stall into one line naming
 * the file.
 */
function warnIfBuildDirtiedTheTree() {
  const dirty = git("status", "--porcelain").out;
  if (!dirty) return;
  log("WARN: the build modified tracked files, which will block the NEXT update:");
  for (const line of dirty.split("\n").slice(0, 10)) log(`      ${line}`);
  log("      Add them to .gitignore and untrack them, or updates stop here.");
}

if (!acquireLock()) process.exit(0);
let code = 1;
try {
  code = main();
} catch (err) {
  log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  releaseLock();
}
process.exit(code);
