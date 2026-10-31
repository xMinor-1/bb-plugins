import { useEffect, useState } from "react";

import { localNow, type LocalNow } from "../src/dates";

/** The user's local date and time, refreshed every 30 seconds. */
export function useNow(): LocalNow {
  const [now, setNow] = useState(() => localNow());
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = localNow();
      setNow((prev) => (prev.date === next.date && prev.time === next.time ? prev : next));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
