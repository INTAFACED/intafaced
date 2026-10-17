'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ModuleKillDesk } from '@/components/module-kill-desk';
import { fetchKillSwitches, type ControlPlaneState } from '@/lib/control-plane-browser';
import { decodeSnapshot } from '@/lib/control-plane-contract';

/**
 * Stop or resume the trade module with the console's own two-founder flow: one founder proposes, a different founder approves,
 * and the server runs it with the operator token (`/api/kill-switch`). The desk adds no mutation path of its own. After a
 * change, the state is read again through the same `/api/kill-switch` GET and the page is refreshed.
 */
export function KillSwitchDesk({
  initial,
  initialReadAt,
  writesBlocked,
  userId,
}: {
  initial: ControlPlaneState;
  initialReadAt: string | null;
  writesBlocked: string | null;
  userId: string;
}) {
  const router = useRouter();
  const [plane, setPlane] = useState(initial);
  const [readAt, setReadAt] = useState(initialReadAt);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const next = await fetchKillSwitches();
    setPlane(next);
    setReadAt(next.status === 'reachable' ? new Date().toISOString() : null);
    setLoading(false);
    router.refresh();
  }, [router]);

  return (
    <ModuleKillDesk
      module="trade"
      snapshot={plane.status === 'reachable' ? decodeSnapshot(plane.snapshot) : null}
      readAt={readAt}
      loading={loading}
      writesBlocked={writesBlocked}
      userId={userId}
      onReload={() => void reload()}
    />
  );
}
