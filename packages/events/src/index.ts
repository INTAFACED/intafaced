/**
 * @intafaced/events — the NATS subject law, the event catalog, and the bus.
 *
 * §2: cross-service calls go through packages/contracts (tRPC) or
 *     packages/events (NATS). Nothing else.
 */
export * from './subject.js';
export * from './envelope.js';
export * from './catalog.js';
export * from './socket-inventory.js';
export * from './bus.js';
export * from './memory-bus.js';
export {
  JetStreamEventBus,
  ensureStream,
  nakBackoffMs,
  retryTransientJetStream,
  DEFAULT_MAX_DELIVER,
  ACK_WAIT_MS,
  ACK_WAIT_NS,
  JS_API_TIMEOUT_MS,
  JS_SETUP_RETRY_FOR_MS,
  TRANSIENT_JS_CODES,
  type JetStreamBusOptions,
  type JetStreamRetryOptions,
} from './jetstream-bus.js';
