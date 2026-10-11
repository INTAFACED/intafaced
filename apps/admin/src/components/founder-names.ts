'use client';
import { useEffect, useState } from 'react';

export type FounderOwner = { userId: string; displayName: 'Nitro' | 'Phantom' };
/** Names come from the protected, configured founder pair; IDs stay internal. */
export function useFounderOwners(): FounderOwner[] {
  const [owners, setOwners] = useState<FounderOwner[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/crm?view=owners', { cache: 'no-store', signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Founder directory unavailable');
        return (await response.json()) as { owners: FounderOwner[] };
      })
      .then((value) => {
        if (!abort.signal.aborted) setOwners(value.owners);
      })
      .catch(() => {
        if (!abort.signal.aborted) setOwners([]);
      });
    return () => abort.abort();
  }, []);
  return owners;
}
export function founderName(owners: FounderOwner[], userId: string): string {
  return owners.find((owner) => owner.userId === userId)?.displayName ?? 'Founder';
}
