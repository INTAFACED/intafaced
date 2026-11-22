import { useSession } from '../../session';
import { useResource } from '../../../shared/resource';
import { readSandbox } from './sandbox-api';

/** One sandbox and its keys, read for the signed-in account (nothing is read signed out). */
export function useSandbox(id: string) {
  const { api, userId } = useSession();
  return useResource(
    (signal) => (userId ? readSandbox(api, id, signal) : Promise.resolve({ ok: true as const, data: null })),
    `developer-sandbox:${userId ?? 'out'}:${id}`,
  );
}
