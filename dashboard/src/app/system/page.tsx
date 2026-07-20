import { Placeholder } from "@/components/placeholder";

export default function Page() {
  return (
    <Placeholder
      title="SYSTEM"
      spec="HEALTH · LOGS · ALERTS"
      items={["Structured log stream with per-service filtering","WebSocket reconnect counts, ingest lag, error rates","Telegram alert routing and severity thresholds","Balance reconciliation status per venue"]}
    />
  );
}
