/**
 * connect.data-lake persist consumer status on svc-edge (P-08).
 *
 * Runtime capture → TSDB flush lives in venue-adapter + connect-data-lake.
 * This door exposes owner-wiring honesty for operators.
 */
import { describeIngestCaptureLakeBatch } from '@intafaced/connect-data-lake';
import type { FastifyInstance } from 'fastify';
import { sendOperatorAuthFailure } from './admin-api.js';

export const CONNECT_DATA_LAKE_PERSIST_CONSUMER_PATH = '/connect/data-lake/persist-consumer' as const;

export function describeConnectDataLakePersistConsumerDoor(env: NodeJS.ProcessEnv = process.env) {
  const batch = describeIngestCaptureLakeBatch(env);
  return {
    path: CONNECT_DATA_LAKE_PERSIST_CONSUMER_PATH,
    fabricBridge: '@intafaced/venue-adapter/fabric/capture-lake-bridge.drainFabricCaptureLakeToPersistence',
    persistenceEnvComplete: batch.persistenceEnvComplete,
    captureLogOnly: batch.captureLogOnly,
    inventsRetentionDays: false as const,
  };
}

export function registerConnectDataLakePersistConsumerRoutes(
  app: FastifyInstance,
  authenticate: (header: string | undefined) => Promise<unknown>,
): void {
  app.get(CONNECT_DATA_LAKE_PERSIST_CONSUMER_PATH, async (request, reply) => {
    try {
      await authenticate(request.headers.authorization);
    } catch (err) {
      if (sendOperatorAuthFailure(reply, err)) return;
      throw err;
    }
    return describeConnectDataLakePersistConsumerDoor();
  });
}
