import { describe, expect, it } from 'vitest';
import { parseFeeScheduleJson } from './fee-schedule.js';
import { VIP_PROOF_MAX_BYTES_CEILING, VipError, checkProof, parseVipProofKey, type VipApplicationInput } from './vip-applications.js';

/** VIP applications (SP-fees-vip-04, J-cex-spot-10 #7): TEST rules, never owner values. */

const RULES = { proofTypes: ['application/pdf', 'image/png'], maxBytes: 64 };
const KEY = Buffer.alloc(32, 7);
const PDF = Buffer.from('%PDF-1.7 TEST proof of status');
const input = (over: Partial<VipApplicationInput> = {}): VipApplicationInput => ({
  requestId: 'vip-req-0001',
  fileName: 'statement.pdf',
  contentType: 'application/pdf',
  bytesBase64: PDF.toString('base64'),
  ...over,
});
const codeOf = (run: () => unknown) => {
  try {
    run();
    return undefined;
  } catch (err) {
    return err instanceof VipError ? err.code : String(err);
  }
};

describe("the owner's application rules in the tier programme", () => {
  const program = (application: unknown) =>
    JSON.stringify({
      published: true,
      version: 'test',
      defaultPairGroup: 'g',
      rows: [
        { pairGroup: 'g', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null },
        { pairGroup: 'g', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null },
      ],
      tierProgram: {
        thresholds: [{ tierId: 'test-vip-1', minVolume30d: '1000' }],
        volumeQuotes: ['USDT'],
        snapshotTimeUtc: null,
        downgradeGraceDays: null,
        subAccounts: null,
        botsAndCopy: null,
        ...(application === undefined ? {} : { application }),
      },
    });
  const rules = (application: unknown) => {
    const parsed = parseFeeScheduleJson(program(application));
    return parsed.published === true ? parsed.tierProgram?.application : undefined;
  };

  it('reads the accepted types and the largest file; absent or null is not open', () => {
    expect(rules(RULES)).toEqual(RULES);
    expect(rules(undefined)).toBeNull();
    expect(rules(null)).toBeNull();
  });

  it.each([
    [
      'a type the service cannot check against the file',
      { ...RULES, proofTypes: ['text/plain'] },
      /must be one of application\/pdf, image\/png, image\/jpeg/,
    ],
    ['no types', { ...RULES, proofTypes: [] }, /proofTypes must name/],
    ['a repeated type', { ...RULES, proofTypes: ['image/png', 'image/png'] }, /repeats a type/],
    ['a size as text', { ...RULES, maxBytes: '64' }, /maxBytes must be a whole number/],
    ['a size above what the service reads', { ...RULES, maxBytes: VIP_PROOF_MAX_BYTES_CEILING + 1 }, /maxBytes must be a whole number/],
    ['an unknown field', { ...RULES, autoApprove: true }, /unknown fields: autoApprove/],
  ])('refuses %s as a blank schedule', (_name, application, message) => {
    expect(() => rules(application)).toThrow(
      expect.objectContaining({ code: 'trade.fee_schedule_blank', message: expect.stringMatching(message) }),
    );
  });
});

describe('checking a proof before anything is kept', () => {
  it('takes a file of an accepted type whose bytes are that type', () => {
    const kept = checkProof(RULES, KEY, input({ contentType: 'Application/PDF', note: '  TEST note  ' }));
    expect(kept).toMatchObject({ contentType: 'application/pdf', fileName: 'statement.pdf', note: 'TEST note' });
    expect(kept.bytes.equals(PDF)).toBe(true);
    expect(kept.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['no rules are published', null, KEY, input(), 'vip.application_unset'],
    ['no key is set', RULES, null, input(), 'vip.proof_key_unset'],
    [
      'the type is not on the list',
      RULES,
      KEY,
      input({ contentType: 'text/plain', bytesBase64: Buffer.from('hi').toString('base64') }),
      'vip.file_type_unsupported',
    ],
    ['the bytes are not the type named', RULES, KEY, input({ contentType: 'image/png' }), 'vip.file_not_its_type'],
    ['the file is over the size', { ...RULES, maxBytes: 8 }, KEY, input(), 'vip.file_too_large'],
    ['the file is empty', RULES, KEY, input({ bytesBase64: '' }), 'vip.file_empty'],
    ['the base64 is not canonical', RULES, KEY, input({ bytesBase64: `${PDF.toString('base64')}!` }), 'vip.file_invalid'],
    ['the request id is short', RULES, KEY, input({ requestId: 'x' }), 'vip.request_invalid'],
    ['the file name is a path', RULES, KEY, input({ fileName: '../etc/passwd' }), 'vip.request_invalid'],
  ] as const)('refuses when %s', (_name, rules, key, given, code) => {
    expect(codeOf(() => checkProof(rules, key, given))).toBe(code);
  });

  it('says which types are accepted when it refuses one', () => {
    try {
      checkProof(RULES, KEY, input({ contentType: 'text/plain' }));
    } catch (err) {
      expect((err as VipError).data).toEqual({ accepted: RULES.proofTypes });
    }
    expect.assertions(1);
  });

  it('reads the key as 64 hex characters or 32 bytes of base64, and nothing else', () => {
    expect(parseVipProofKey('ab'.repeat(32))?.length).toBe(32);
    expect(parseVipProofKey(Buffer.alloc(32, 1).toString('base64'))?.length).toBe(32);
    expect(parseVipProofKey('')).toBeNull();
    expect(parseVipProofKey('short')).toBeNull();
  });
});
