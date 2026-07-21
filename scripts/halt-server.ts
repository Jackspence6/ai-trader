#!/usr/bin/env tsx
/**
 * Standalone kill-switch endpoint.
 *
 *   pnpm halt:server            listen on 127.0.0.1:3999
 *
 * DESIGN.md §6: "The kill switch must work when everything else is broken."
 *
 * This is a separate process from the dashboard, with a separate port and
 * deliberately minimal dependencies — `node:http`, the halt state file, and the
 * venue cancel calls. No Next.js, no React, no database, no config parsing. If
 * the dashboard is wedged, mid-rebuild, or crashed, this still answers.
 *
 * It binds to loopback only. A kill switch reachable from the network is an
 * off switch for anyone who finds it.
 *
 *   curl localhost:3999/status
 *   curl -X POST localhost:3999/halt   -d 'reason=manual'
 *   curl -X POST localhost:3999/resume -d 'reason=investigated, all clear'
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { clear, readAudit, trip } from "@/lib/killswitch";
import { readHaltSync } from "@/lib/killswitch/state";

const PORT = Number(process.env.HALT_PORT ?? 3999);
const HOST = "127.0.0.1";

function json(res: ServerResponse, code: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};

  // Accept both form-encoded and JSON, so `curl -d` works without ceremony.
  // In an emergency nobody should have to remember a content type.
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === "/status") {
      // Synchronous read: if you are asking this, something may already be
      // wrong, and the answer should not wait on the event loop.
      return json(res, 200, { state: readHaltSync(), audit: await readAudit(10) });
    }

    if (url.pathname === "/halt" && req.method === "POST") {
      const body = await readBody(req);
      const reason = body.reason?.trim() || "Manual halt via standalone endpoint";
      const result = await trip(reason, "http", body.actor ?? null);
      console.log(
        `[${new Date().toISOString()}] HALT — ${reason} · swept ${result.sweep.succeeded}/${result.sweep.attempted} venues`,
      );
      return json(res, 200, result);
    }

    if (url.pathname === "/resume" && req.method === "POST") {
      const body = await readBody(req);
      const reason = body.reason?.trim();
      if (!reason) {
        // Resuming is the dangerous direction, so it is the one that requires
        // an explanation.
        return json(res, 400, {
          error: "A reason is required to resume. Restarting a system that stopped itself is a decision worth recording.",
        });
      }
      const state = await clear(reason, "http", body.actor ?? null);
      console.log(`[${new Date().toISOString()}] RESUME — ${reason}`);
      return json(res, 200, { state });
    }

    return json(res, 404, {
      error: "Not found",
      endpoints: ["GET /status", "POST /halt", "POST /resume"],
    });
  } catch (e) {
    console.error("[halt-server]", e);
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  const state = readHaltSync();
  console.log(`Kill switch listening on http://${HOST}:${PORT}`);
  console.log(`Current state: ${state.halted ? "HALTED" : "running"}`);
  console.log("");
  console.log(`  curl ${HOST}:${PORT}/status`);
  console.log(`  curl -X POST ${HOST}:${PORT}/halt -d 'reason=why'`);
  console.log(`  curl -X POST ${HOST}:${PORT}/resume -d 'reason=why'`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} — kill switch shutting down. Halt state is unchanged.`);
    server.close(() => process.exit(0));
  });
}
