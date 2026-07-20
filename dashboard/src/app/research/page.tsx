import { Placeholder } from "@/components/placeholder";

export default function Page() {
  return (
    <Placeholder
      title="RESEARCH"
      spec="BACKTEST · SWEEPS · WALK-FORWARD"
      items={["Replay engine modelling queue position, latency and real L2 depth","Fill-realism setting from optimistic to pessimistic","Parameter sweep heatmaps to expose overfitting at a glance","Walk-forward analysis and side-by-side run comparison"]}
    />
  );
}
