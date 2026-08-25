// Telegram alerts from the serverless scanner.
//
// Mirrors backend/oddsengine/alerts/templates.py (spec §14.6) so an alert looks the
// same whether the engine or the hosted scanner found it. Dry-run by default: with
// no bot token configured, alerts are logged and reported, never sent.

export interface AlertLeg {
  venueName: string;
  selectionLabel: string;
  odds: number;
  stakeZar: number;
  orderIndex: number;
  rawPrice?: number | null;
  feeRate?: number | null;
}

export interface AlertOpportunity {
  id: string;
  eventLabel: string;
  sport: string;
  league: string | null;
  startTime: string | null;
  marketType: string;
  legs: AlertLeg[];
  marginPct: number;
  executableZarPerLeg: number;
  guaranteedProfitZar: number;
  totalStakeZar: number;
  score: number;
  urgency: "low" | "medium" | "high" | "critical";
  ruleRisk: boolean;
  ruleRiskNote?: string | null;
  fxRate: number | null;
  notes?: string[];
}

const URGENCY_EMOJI: Record<string, string> = {
  low: "🟢", medium: "🟡", high: "🟠", critical: "🔴",
};
const URGENCY_LABEL: Record<string, string> = {
  low: "open", medium: "today", high: "near KO", critical: "LIVE — measure only",
};

function zar(v: number): string {
  return Math.round(v).toLocaleString("en-ZA").replace(/,/g, " ");
}

function sast(iso: string | null): string {
  if (!iso) return "TBA";
  try {
    return new Date(iso).toLocaleString("en-ZA", {
      timeZone: "Africa/Johannesburg", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "TBA";
  }
}

export function formatAlert(o: AlertOpportunity): string {
  const lines = [
    `${URGENCY_EMOJI[o.urgency] ?? "🟢"} ARB #${o.id}  score ${o.score}/100  ⏱${URGENCY_LABEL[o.urgency] ?? o.urgency}`,
    `${o.sport} · ${o.league ?? "—"}`,
    `${o.eventLabel}  (${sast(o.startTime)} SAST)`,
    `Market: ${o.marketType}`,
  ];
  for (const leg of [...o.legs].sort((a, b) => a.orderIndex - b.orderIndex)) {
    const price = leg.rawPrice != null
      ? ` [${leg.rawPrice.toFixed(3)}¢${leg.feeRate ? ` +${(leg.feeRate * 100).toFixed(0)}% fee` : ""}]`
      : "";
    lines.push(
      `─ Leg ${leg.orderIndex}: ${leg.venueName} ${leg.selectionLabel} @ ${leg.odds.toFixed(4)}${price}` +
      `  → stake R${zar(leg.stakeZar)}`,
    );
  }
  lines.push(`Margin: ${o.marginPct.toFixed(2)}%   Executable: R${zar(o.executableZarPerLeg)}/leg`);
  lines.push(
    `FX: ${o.fxRate ? o.fxRate.toFixed(2) : "n/a"}  RuleRisk: ${o.ruleRisk ? `⚠ ${o.ruleRiskNote ?? "yes"}` : "clean"}`,
  );
  lines.push(`Profit locked: R${zar(o.guaranteedProfitZar)} on R${zar(o.totalStakeZar)}`);
  for (const note of (o.notes ?? []).slice(0, 3)) lines.push(`· ${note}`);
  return lines.join("\n");
}

export function inlineKeyboard(o: AlertOpportunity, dashboardUrl: string | null) {
  const rows: unknown[][] = [];
  if (dashboardUrl) {
    rows.push([
      { text: "📈 Open Polymarket", url: "https://polymarket.com" },
      { text: "🧮 Terminal", url: `${dashboardUrl.replace(/\/$/, "")}/?opp=${o.id}` },
    ]);
  }
  return { inline_keyboard: rows };
}

export interface SendResult { ok: boolean; dryRun: boolean; error?: string }

export async function sendAlert(o: AlertOpportunity): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;
  const text = formatAlert(o);

  if (!token || !chatId) {
    console.log("[telegram:dry-run]\n" + text);
    return { ok: true, dryRun: true };
  }
  try {
    const dashboardUrl = process.env.NEXT_PUBLIC_DASHBOARD_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        reply_markup: inlineKeyboard(o, dashboardUrl),
      }),
    });
    if (!res.ok) return { ok: false, dryRun: false, error: `${res.status} ${res.statusText}` };
    return { ok: true, dryRun: false };
  } catch (err) {
    return { ok: false, dryRun: false, error: (err as Error).message };
  }
}
