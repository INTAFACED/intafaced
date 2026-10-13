import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { logTrpcServerFault } from './trpc-error-log.js';

describe('logTrpcServerFault', () => {
  it('logs the underlying cause of an INTERNAL_SERVER_ERROR with the procedure path', () => {
    const log = { error: vi.fn() };
    const cause = new Error('getTxByKey is not exposed over the internal ledger API');
    logTrpcServerFault(log, {
      path: 'convert.accept',
      type: 'mutation',
      error: new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause }),
    });
    expect(log.error).toHaveBeenCalledTimes(1);
    const [obj, msg] = log.error.mock.calls[0] as [Record<string, any>, string];
    expect(msg).toBe('trpc procedure failed');
    expect(obj.path).toBe('convert.accept');
    expect(obj.type).toBe('mutation');
    expect(obj.err.name).toBe('Error');
    expect(obj.err.message).toBe('getTxByKey is not exposed over the internal ledger API');
    expect(typeof obj.err.stack).toBe('string');
  });

  it('falls back to the tRPC error itself when there is no cause', () => {
    const log = { error: vi.fn() };
    logTrpcServerFault(log, {
      path: 'convert.accept',
      type: 'mutation',
      error: new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed' }),
    });
    expect((log.error.mock.calls[0] as [Record<string, any>])[0].err.message).toBe('Request failed');
  });

  it('logs other 5xx faults too, such as a 503', () => {
    const log = { error: vi.fn() };
    logTrpcServerFault(log, {
      path: 'orders.create',
      type: 'mutation',
      error: new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'authority.unavailable' }),
    });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('never logs the whole error object: only name, message, code and stack', () => {
    const log = { error: vi.fn() };
    const cause = Object.assign(new Error('insert failed'), {
      code: '23505',
      detail: 'Key (user_id)=(secret-user) already exists.',
      where: 'row values',
      query: 'INSERT ...',
    });
    logTrpcServerFault(log, {
      path: 'x.y',
      type: 'mutation',
      error: new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause }),
    });
    const err = (log.error.mock.calls[0] as [Record<string, any>])[0].err;
    expect(Object.keys(err).sort()).toEqual(['code', 'message', 'name', 'stack']);
    expect(err.code).toBe('23505');
    expect(JSON.stringify(err)).not.toContain('secret-user');
  });

  it('stays quiet for typed refusals', () => {
    const log = { error: vi.fn() };
    for (const code of ['BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_FAILED', 'UNAUTHORIZED'] as const) {
      logTrpcServerFault(log, { path: 'convert.accept', type: 'mutation', error: new TRPCError({ code, message: 'refused' }) });
    }
    expect(log.error).not.toHaveBeenCalled();
  });
});
