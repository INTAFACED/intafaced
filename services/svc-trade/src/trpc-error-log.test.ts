import { describe, expect, it, vi } from 'vitest';
import { logTrpcServerFault } from './trpc-error-log.js';

describe('logTrpcServerFault', () => {
  it('logs the underlying cause of an INTERNAL_SERVER_ERROR with the procedure path', () => {
    const log = { error: vi.fn() };
    const cause = new Error('getTxByKey is not exposed over the internal ledger API');
    logTrpcServerFault(log, {
      path: 'convert.accept',
      type: 'mutation',
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause },
    });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith({ err: cause, path: 'convert.accept', type: 'mutation' }, 'trpc procedure failed');
  });

  it('falls back to the tRPC error itself when there is no cause', () => {
    const log = { error: vi.fn() };
    const error = { code: 'INTERNAL_SERVER_ERROR', message: 'Request failed' };
    logTrpcServerFault(log, { path: 'convert.accept', type: 'mutation', error });
    expect(log.error).toHaveBeenCalledWith({ err: error, path: 'convert.accept', type: 'mutation' }, 'trpc procedure failed');
  });

  it('stays quiet for typed refusals', () => {
    const log = { error: vi.fn() };
    for (const code of ['BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_FAILED', 'UNAUTHORIZED']) {
      logTrpcServerFault(log, { path: 'convert.accept', type: 'mutation', error: { code, message: 'refused' } });
    }
    expect(log.error).not.toHaveBeenCalled();
  });
});
