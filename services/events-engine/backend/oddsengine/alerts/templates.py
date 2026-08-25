"""Telegram alert formatting (spec §14.6 template, verbatim layout)."""

from __future__ import annotations

from zoneinfo import ZoneInfo

from ..compat import UTC
from ..models import Opportunity, Urgency

SAST = ZoneInfo("Africa/Johannesburg")

URGENCY_EMOJI = {
    Urgency.LOW: "🟢", Urgency.MEDIUM: "🟡", Urgency.HIGH: "🟠", Urgency.CRITICAL: "🔴",
}
URGENCY_LABEL = {
    Urgency.LOW: "open", Urgency.MEDIUM: "today", Urgency.HIGH: "near kickoff",
    Urgency.CRITICAL: "LIVE — measure only",
}


def _fmt_zar(v: float) -> str:
    return f"{v:,.0f}".replace(",", " ")


def format_alert(opp: Opportunity) -> str:
    emoji = URGENCY_EMOJI.get(opp.urgency, "🟢")
    start = "TBA"
    if opp.start_time:
        st = opp.start_time
        if st.tzinfo is None:
            st = st.replace(tzinfo=UTC)
        start = st.astimezone(SAST).strftime("%d %b %H:%M")
    mtype, _, rest = opp.market_key.partition("|")
    line = rest.split("|")[0] if rest else ""
    lines = [
        f"{emoji} ARB #{opp.id}  score {opp.score:g}/100  ⏱{URGENCY_LABEL.get(opp.urgency, opp.urgency)}",
        f"{opp.sport.value} · {opp.league or '—'}",
        f"{opp.event_label}  ({start} SAST)",
        f"Market: {mtype} {line}".rstrip(),
    ]
    for leg in sorted(opp.legs, key=lambda x: x.order_index):
        marker = " ①place first" if leg.order_index == 1 and len(opp.legs) > 1 else ""
        lines.append(
            f"─ Leg {leg.order_index}: {leg.venue_name} {leg.selection_label} @ {leg.odds:g}"
            f"  → stake R{_fmt_zar(leg.stake_zar)}{marker}"
        )
    lines.append(
        f"Margin: {opp.margin_pct:.2f}%   Executable: R{_fmt_zar(opp.executable_zar_per_leg)}/leg"
    )
    fx = f"{opp.fx_rate:.2f}" if opp.fx_rate else "n/a"
    rulerisk = "⚠ " + (opp.rule_risk_note or "yes") if opp.rule_risk else "clean"
    lines.append(f"FX: {fx}  RuleRisk: {rulerisk}")
    lines.append(f"Profit locked: R{_fmt_zar(opp.guaranteed_profit_zar)} on R{_fmt_zar(opp.total_stake_zar)}")
    if opp.notes:
        lines.append("· " + "\n· ".join(opp.notes[:3]))
    return "\n".join(lines)


def inline_keyboard(opp: Opportunity, dashboard_url: str | None) -> dict:
    """Telegram inline keyboard: deep links per venue + one-tap feedback buttons."""
    venue_buttons = []
    seen = set()
    for leg in sorted(opp.legs, key=lambda x: x.order_index):
        if leg.venue_id in seen or not leg.deep_link:
            continue
        seen.add(leg.venue_id)
        venue_buttons.append({"text": f"Open {leg.venue_name}", "url": leg.deep_link})
    rows = []
    if venue_buttons:
        rows.append(venue_buttons[:3])
    if dashboard_url:
        rows.append([{"text": "🧮 Calc", "url": f"{dashboard_url.rstrip('/')}/?opp={opp.id}"}])
    rows.append([
        {"text": "✅ Placed", "callback_data": f"fb:{opp.id}:placed"},
        {"text": "⌛ Missed", "callback_data": f"fb:{opp.id}:missed"},
        {"text": "🚫 Void", "callback_data": f"fb:{opp.id}:voided"},
    ])
    return {"inline_keyboard": rows}
