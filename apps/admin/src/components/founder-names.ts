'use client';
import { useResource } from '@/lib/hooks/use-resource';

export type FounderOwner = { userId: string; displayName: 'Nitro' | 'Phantom' };

async function loadOwners(signal: AbortSignal): Promise<FounderOwner[]> {
  const response = await fetch('/api/crm?view=owners', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Founder directory unavailable');
  return ((await response.json()) as { owners: FounderOwner[] }).owners;
}

/** Names come from the protected, configured founder pair; IDs stay internal. */
export function useFounderOwners(): FounderOwner[] {
  const { resource } = useResource(loadOwners, 'founder-owners');
  return resource.status === 'ready' ? resource.data : [];
}
export function founderName(owners: FounderOwner[], userId: string): string {
  return owners.find((owner) => owner.userId === userId)?.displayName ?? 'Founder';
}
