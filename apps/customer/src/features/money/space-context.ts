import { z } from 'zod';
import type { Space } from './client';

export type SpaceContext = { status: 'none' } | { status: 'invalid' } | { status: 'valid'; id: string };

/** A link supplies context, never authority. Preserve the whole observed search. */
export function spaceContext(search: string, key: 'space' | 'from'): SpaceContext {
  const values = new URLSearchParams(search).getAll(key);
  if (!values.length) return { status: 'none' };
  if (values.length !== 1 || !z.string().guid().safeParse(values[0]).success) return { status: 'invalid' };
  return { status: 'valid', id: values[0]! };
}

export function currentSpace(rows: Space[], id: string, owner: string): Space | undefined {
  const matches = rows.filter((row) => row.id === id);
  if (matches.length !== 1) return undefined;
  const space = matches[0]!;
  const account = space.ledgerAccount;
  return account.kind === 'available' &&
    account.assetId === space.assetId &&
    (space.kind === 'primary'
      ? account.ownerType === 'user' && account.ownerId === owner
      : account.ownerType === 'subaccount' && account.ownerId === space.id)
    ? space
    : undefined;
}
