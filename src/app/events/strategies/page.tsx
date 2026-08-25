import { Panel, Micro, Tag, Stat, cx } from "@/components/ui";
import { EVENT_STRATEGIES, STANDING_META } from "@/lib/events/strategies";

export const metadata = { title: "Strategies · Event Markets · Meridian" };

export default function EventStrategiesPage() {
  const funded = EVENT_STRATEGIES.filter((s) => s.standing === "funded").length;
  const ready = EVENT_STRATEGIES.filter((s) => s.standing === "ready").length;

  return (
    <div className="space-y-3">
      <Panel label="The playbook" hint="Event Markets desk">
        <p className="max-w-3xl text-[12px] leading-relaxed text-muted">
          Five edges, and the honest standing of each. This desk holds no live capital:
          nothing is <Tag tone="up">FUNDED</Tag>, one strategy is built and waiting on
          accounts, one is running live and measuring, one is a validated negative, and
          two have never produced a number. Each card carries the measurement that set
          its standing and what would move it up a rung — the same discipline the Asset
          Markets desk runs on, applied to a book that has not started yet.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-4">
          <Stat label="Funded">
            <span className="tnum text-ink">{funded}</span>
          </Stat>
          <Stat label="Ready to fund" sub={<span className="micro text-dim">blocked outside the code</span>}>
            <span className="tnum text-accent">{ready}</span>
          </Stat>
          <Stat label="Live capital">
            <span className="tnum text-ink">R0</span>
          </Stat>
          <Stat label="Positive measured edges" sub={<span className="micro text-dim">promotional hedging only</span>}>
            <span className="tnum text-up">1</span>
          </Stat>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {EVENT_STRATEGIES.map((s) => {
          const meta = STANDING_META[s.standing];
          return (
            <Panel
              key={s.code}
              label={`${s.code} · ${s.name.toUpperCase()}`}
              right={<Tag tone={meta.tone}>{meta.label}</Tag>}
              className={cx(
                (s.standing === "unbuilt" || s.standing === "unmeasured") && "opacity-90",
              )}
            >
              <p className="text-[12px] leading-relaxed text-muted">{s.plain}</p>

              {s.metric && (
                <div className="mt-3 flex items-baseline gap-2">
                  <Micro className="text-dim">{s.metric.label.toUpperCase()}</Micro>
                  <span
                    className={cx(
                      "tnum text-[15px]",
                      s.metric.tone === "up"
                        ? "text-up"
                        : s.metric.tone === "down"
                          ? "text-down"
                          : "text-ink",
                    )}
                  >
                    {s.metric.value}
                  </span>
                </div>
              )}

              <div className="mt-3 border-t border-line pt-3">
                <Micro className="mb-1.5 block text-dim">EVIDENCE</Micro>
                <p className="text-[11px] leading-relaxed text-muted">{s.evidence}</p>
              </div>

              <div className="mt-3 border-t border-line pt-3">
                <Micro className="mb-1.5 block text-dim">WHAT WOULD CHANGE IT</Micro>
                <p className="text-[11px] leading-relaxed text-muted">{s.next}</p>
              </div>

              <p className="mt-3 border-t border-line pt-2 text-[10.5px] text-dim">
                {meta.blurb}
              </p>
            </Panel>
          );
        })}
      </div>

      <Panel label="Standing means what it says">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(STANDING_META).map(([k, m]) => (
            <div key={k} className="flex items-baseline gap-2">
              <Tag tone={m.tone}>{m.label}</Tag>
              <span className="text-[11px] text-muted">{m.blurb}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          The last two exist because the alternative is a screen that quietly implies
          more than is true. A strategy card with no numbers reads as &ldquo;nothing
          happening lately&rdquo; when it should read &ldquo;nobody has ever run
          this&rdquo;.
        </p>
      </Panel>
    </div>
  );
}
