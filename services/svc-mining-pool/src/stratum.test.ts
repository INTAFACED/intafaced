import { describe, expect, it } from 'vitest';
import { acceptShare, parseRequest } from './stratum.js';
import { memoryJobSource } from './job-source.js';

const share = {
  minerId: 'm',
  worker: 'w',
  jobId: 'j',
  nonce: 'abcd',
  shareHash: '00ff',
  target: '00ff',
};

describe('Stratum share protocol', () => {
  it('parses a submit and refuses every share when no job source is configured', () => {
    expect(parseRequest('{"id":1,"method":"mining.submit","params":["worker","job","abcd"]}')).toMatchObject({ id: 1 });
    const refused = acceptShare(share);
    expect(refused).toEqual({ accepted: false, reason: 'mining.job_source_unconfigured' });
    expect(refused).not.toHaveProperty('amount');
    expect(acceptShare({ ...share, jobId: '' })).toEqual({ accepted: false, reason: 'mining.job_source_unconfigured' });
  });

  it('a configured source that does not know the id returns job_not_found and credits nothing', () => {
    const jobs = memoryJobSource(['j']);
    expect(acceptShare({ ...share, jobId: 'not-a-job' }, jobs)).toEqual({ accepted: false, reason: 'job_not_found' });
    expect(acceptShare({ ...share, jobId: '' }, jobs)).toEqual({ accepted: false, reason: 'job_not_found' });
  });

  it('a known job accepts and does not credit', () => {
    const jobs = memoryJobSource(['j']);
    expect(acceptShare(share, jobs)).toEqual({ accepted: true });
    expect(acceptShare({ ...share, nonce: 'zz' }, jobs)).toEqual({ accepted: false, reason: 'invalid_nonce' });
  });
});
