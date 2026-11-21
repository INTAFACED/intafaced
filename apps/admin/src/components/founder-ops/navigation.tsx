'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
export function LiveRefresh({ readAt }: { readAt: string }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
    if (paused) return;
    const timer = setInterval(() => router.refresh(), 15000);
    return () => clearInterval(timer);
  }, [paused, router]);
  return (
    <div className="mp-asof" role="status">
      <span>
        Snapshot checked at <time dateTime={readAt}>{readAt}</time>. {paused ? 'Refresh paused.' : 'Refresh every 15 seconds.'} Event feed
        lag: unavailable.
      </span>
      <button
        type="button"
        className="mp-btn"
        disabled={!ready}
        title={ready ? undefined : 'Refresh controls are connecting.'}
        aria-pressed={paused}
        onClick={() => setPaused((p) => !p)}
      >
        {paused ? 'Resume refresh' : 'Pause refresh'}
      </button>
    </div>
  );
}
