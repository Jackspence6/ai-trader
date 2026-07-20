import { Placeholder } from "@/components/placeholder";

export default function Page() {
  return (
    <Placeholder
      title="RISK"
      spec="LIMITS · BREACHES · CIRCUIT BREAKERS"
      items={["Every limit editable with live utilisation bars","Breach history and circuit-breaker cool-down states","Kill switch history: who, when, why","Exchange-side dead-man timer registration status"]}
    />
  );
}
