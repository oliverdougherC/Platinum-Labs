"use client";

import { useEffect, useState } from "react";

/**
 * Minimal client component used to (a) prove the client boundary works in the
 * scaffold and (b) give the ambient header a gently updating time. Real ambient
 * behavior and progressive disclosure land in PLA-174/PLA-175.
 */
export function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Render nothing until mounted to avoid a server/client hydration mismatch.
  const label = now
    ? now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : " ";

  return (
    <time className="tnum text-muted" suppressHydrationWarning>
      {label}
    </time>
  );
}
