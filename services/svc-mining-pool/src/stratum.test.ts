import { describe, expect, it } from 'vitest';
import { acceptShare, parseRequest } from './stratum.js';

describe('Stratum share protocol', () => {
  it('rejects an unknown job and an empty jobId by named reason', () => {
    expect(parseRequest('{"id":1,"method":"mining.submit","params":["worker","job","abcd"]}')).toMatchObject({ id: 1 });
    expect(acceptShare({ minerId: 'm', worker: 'w', jobId: 'j', nonce: 'abcd', shareHash: '00ff', target: '00ff' })).toEqual({
      accepted: false,
      reason: 'job_not_found',
    });
    expect(acceptShare({ minerId: 'm', worker: 'w', jobId: '', nonce: 'abcd', shareHash: '00ff', target: '00ff' })).toEqual({
      accepted: false,
      reason: 'job_not_found',
    });
  });

  it('refuses jobId not-a-job instead of trusting the caller shareHash and target', () => {
    expect(acceptShare({ minerId: 'm', worker: 'w', jobId: 'not-a-job', nonce: 'abcd', shareHash: '0', target: 'ff' })).toEqual({
      accepted: false,
      reason: 'job_not_found',
    });
  });
});
