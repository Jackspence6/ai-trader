import { Placeholder } from "@/components/placeholder";

export default function Page() {
  return (
    <Placeholder
      title="STRATEGIES"
      spec="CONFIG · ALLOCATION · PERFORMANCE"
      items={["Card per strategy with mode selector: shadow / paper / live","Parameter forms generated from each strategy's schema","Per-strategy equity curve, Sharpe, hit rate, fill quality","Capital allocation sliders bounded by the active risk tier"]}
    />
  );
}
