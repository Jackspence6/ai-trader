/**
 * Engine configuration read/write.
 *
 * POST clamps every field to its documented bounds and reports what it changed
 * rather than rejecting the whole payload. A config save that silently
 * half-applies is the worst outcome — the operator believes a limit is in force
 * that isn't.
 */

import { readAudit, readConfig, writeConfig } from "@/lib/engine/store";

export async function GET() {
  const [config, audit] = await Promise.all([readConfig(), readAudit(20)]);
  return Response.json({ config, audit }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reason =
    typeof (body as { reason?: unknown })?.reason === "string"
      ? ((body as { reason: string }).reason || undefined)
      : undefined;
  const { config, adjustments } = await writeConfig(body, reason);
  return Response.json(
    { config, adjustments },
    { headers: { "cache-control": "no-store" } },
  );
}
