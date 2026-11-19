import 'server-only';

/**
 * The desk's entry: what another console feature's server code uses to call an owning service as the signed-in founder,
 * run an approved request and show a refusal in words. Another feature imports the desk only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 *
 * This entry is for server code: it holds the founder call, which never runs in the browser.
 */
export type { DeskRequest } from './approval-packet';
export { payloadHashFor } from './approval-hash';
export type { ExecuteFn } from './approval-steps';
export type { ExecuteReply } from './approval-types';
export { failureRefusal } from './failure-refusal';
export { edgeCall, founderCall, parseWith, type FounderCallContext, type FounderCallResult } from './founder-call';
export { partFrom, type Part } from './part';
export { codeInText, explainRefusal, isKnownCode, type RefusalView } from './refusal-copy';
export { handleStep } from './step-route';
