import { Panel, Micro } from "./ui";

export function Placeholder({
  title,
  spec,
  items,
}: {
  title: string;
  spec: string;
  items: string[];
}) {
  return (
    <div className="p-3">
      <Panel label={title} hint={spec}>
        <div className="max-w-2xl">
          <Micro className="mb-3">PLANNED CONTENT</Micro>
          <ul className="space-y-2">
            {items.map((i) => (
              <li key={i} className="flex gap-2.5 text-[12px] text-muted">
                <span className="mt-[7px] size-1 shrink-0 bg-accent" />
                <span className="leading-relaxed">{i}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            Not yet built. Command, Markets, Signals, Control and Treasury are
            live on real data — this surface is specced in DESIGN.md §8 and needs
            the engine (orders, fills, positions) behind it before it can show
            anything true.
          </p>
        </div>
      </Panel>
    </div>
  );
}
