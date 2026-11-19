import { z } from 'zod';
import { routePath, type HttpTransport, type ProcedureRecord } from './procedure.js';

type HttpRecord = ProcedureRecord & HttpTransport;

/**
 * Calls a plain HTTP door through its record: the route, method and body come from the record, the
 * input is checked against it before sending, and the reply is parsed by it. The caller supplies only where the service
 * is, how it signs, and how it reads that service's error body: one each per caller, never per call.
 */
export async function callHttpRecord<R extends HttpRecord>(
  record: R,
  options: {
    baseUrl: string;
    input: z.input<R['input']>;
    params?: Readonly<Record<string, string>>;
    sign: (payload: string, request: { method: string; url: URL; contentType: string }) => Record<string, string>;
    errorOf: (path: string, status: number, detail: string) => Error;
    fetcher?: typeof fetch;
  },
): Promise<z.output<R['output']>> {
  const path = routePath(record, options.params ?? {});
  const target = `${options.baseUrl.replace(/\/$/, '')}${path}`;
  const payload = JSON.stringify(record.input.parse(options.input));
  const response = await (options.fetcher ?? fetch)(target, {
    method: record.method,
    headers: {
      'content-type': 'application/json',
      ...options.sign(payload, { method: record.method, url: new URL(target), contentType: 'application/json' }),
    },
    ...(record.method === 'GET' ? {} : { body: payload }),
  });
  if (!response.ok) throw options.errorOf(path, response.status, await response.text().catch(() => ''));
  return z.parse<R['output']>(record.output, await response.json());
}

/** The serving side of a plain HTTP door: parse the body by the record, answer what the record says comes back. */
export function httpRecordHandler<R extends HttpRecord, S>(
  record: R,
  handle: (service: S, input: z.output<R['input']>) => Promise<z.input<R['output']>>,
): (service: S, body: unknown) => Promise<z.output<R['output']>> {
  return async (service, body) => {
    const reply = await handle(service, z.parse<R['input']>(record.input, body));
    const checked = z.safeParse<R['output']>(record.output, reply);
    // The server's own reply breaking its record is the server's fault: never a 400 that blames the caller.
    if (!checked.success) throw new OutputBreaksRecordError(record.name, checked.error.message);
    return checked.data;
  };
}

/** A reply that does not match the record it is served from. Not a ZodError, so no door maps it to the caller's 400. */
export class OutputBreaksRecordError extends Error {
  constructor(record: string, detail: string) {
    super(`${record}: the reply does not match its record: ${detail}`);
    this.name = 'OutputBreaksRecordError';
  }
}
