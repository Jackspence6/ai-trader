import { Suspense } from "react";
import { EventsBoard } from "@/components/events/board";

export const metadata = { title: "Board · Event Markets · Meridian" };

export default function EventsBoardPage() {
  return (
    <Suspense>
      <EventsBoard />
    </Suspense>
  );
}
