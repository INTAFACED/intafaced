import { useMemo } from 'react';
import { z } from 'zod';
import {
  HOME_CONFIG_PROCEDURE,
  homeConfigOutputSchema,
  WORK_ITEMS_PROCEDURE,
  type WorkItemSource,
} from '@intafaced/contracts/home-work-items';
import { useSession } from '../../features/session/session';
import { authoredRefusal, isServiceNotConnected, type ApiResult } from '../../shared/api';
import { useResource, type Resource } from '../../shared/resource';
import { sourceAnswer, workList, WORK_SOURCES, type ConfigRead, type SourceRead, type WorkList } from './work-list';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * No such procedure, or the gateway says the service is not connected here: the owner does not answer this read on this
 * deployment yet. A crash, restart or timeout is a failure the person can retry, never "not connected".
 */
const unwired = (failure: Failure) => failure.reason === 'not_mounted' || isServiceNotConnected(failure.code);

/** One read, keyed by person, so another person's answer is never shown. */
function useRead<T>(module: string, procedure: string, schema: z.ZodType<T>, key: string): { resource: Resource<T>; reload: () => void } {
  const { api, userId } = useSession();
  return useResource(
    (signal) =>
      userId
        ? api.query(module, procedure, undefined, schema, { signal })
        : Promise.resolve(authoredRefusal('aborted', { key: 'beforeDispatch' })),
    `work-${key}:${userId}`,
  );
}

function configRead(resource: Resource<z.infer<typeof homeConfigOutputSchema>>): ConfigRead {
  if (resource.status === 'loading') return { state: 'loading' };
  if (resource.status === 'ready') return { state: 'ready', config: resource.data };
  return unwired(resource.failure) ? { state: 'unwired' } : { state: 'failed', code: resource.failure.code };
}

function sourceRead(source: WorkItemSource, resource: Resource<unknown>): SourceRead {
  if (resource.status === 'loading') return { state: 'loading' };
  if (resource.status === 'ready') return sourceAnswer(source, resource.data);
  if (unwired(resource.failure)) return { state: 'unwired' };
  const { code, status } = resource.failure;
  return { state: 'failed', ...(code === undefined ? {} : { code }), ...(status === undefined ? {} : { status }) };
}

/** The owner's answer is checked against the contract in `sourceAnswer`, where a wrong row drops the whole answer. */
const anyAnswer = z.unknown();

/** Home's work list: the owner values from svc-ops, then each owner's own items. */
export function useWorkList(): { list: WorkList; retry: () => void } {
  const config = useRead('ops', HOME_CONFIG_PROCEDURE, homeConfigOutputSchema, 'config');
  const identity = useRead('identity', WORK_ITEMS_PROCEDURE, anyAnswer, 'identity');
  const bank = useRead('bank', WORK_ITEMS_PROCEDURE, anyAnswer, 'bank');
  const pay = useRead('pay', WORK_ITEMS_PROCEDURE, anyAnswer, 'pay');
  const reads = { identity, bank, pay } satisfies Record<(typeof WORK_SOURCES)[number], unknown>;

  const list = useMemo(
    () =>
      workList(configRead(config.resource), {
        identity: sourceRead('identity', identity.resource),
        bank: sourceRead('bank', bank.resource),
        pay: sourceRead('pay', pay.resource),
      }),
    [config.resource, identity.resource, bank.resource, pay.resource],
  );
  const retry = () => {
    config.reload();
    for (const source of WORK_SOURCES) reads[source].reload();
  };
  return { list, retry };
}
