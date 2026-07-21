/**
 * Kill switch, over the dashboard's API.
 *
 * One of three access paths, alongside the CLI (`pnpm halt`) and the standalone
 * endpoint (`pnpm halt:server`, port 3999). This is the convenient one; the
 * other two are the ones that still work when this process does not.
 */

import { clear, readAudit, readHalt, trip } from "@/lib/killswitch";

export async function GET() {
  const [state, audit] = await Promise.all([readHalt(), readAudit(25)]);
  return Response.json({ state, audit }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  let body: { action?: string; reason?: string; actor?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const actor = body.actor ?? null;

  if (body.action === "halt") {
    const reason = body.reason?.trim() || "Manual halt from the dashboard";
    const result = await trip(reason, "dashboard", actor);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  }

  if (body.action === "resume") {
    const reason = body.reason?.trim();
    if (!reason) {
      // Halting is cheap and reversible; resuming is the direction that can
      // lose money, so it is the one that must be justified.
      return Response.json(
        {
          error:
            "A reason is required to resume. Restarting a system that stopped itself is a decision worth recording.",
        },
        { status: 400 },
      );
    }
    const state = await clear(reason, "dashboard", actor);
    return Response.json({ state }, { headers: { "cache-control": "no-store" } });
  }

  return Response.json({ error: "action must be 'halt' or 'resume'" }, { status: 400 });
}
