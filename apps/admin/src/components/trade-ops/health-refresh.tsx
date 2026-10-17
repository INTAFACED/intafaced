'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@intafaced/ui';

/** Re-reads the page's data from the services (the page is rendered fresh on each visit; this runs it again). Also used as a per-panel retry. */
export function HealthRefresh({ label = 'Refresh' }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [clicks, setClicks] = useState(0);
  return (
    <Button
      variant="secondary"
      shape="rounded"
      size={28}
      loading={pending}
      data-clicks={clicks}
      onClick={() => {
        setClicks((n) => n + 1);
        start(() => router.refresh());
      }}
    >
      {label}
    </Button>
  );
}
