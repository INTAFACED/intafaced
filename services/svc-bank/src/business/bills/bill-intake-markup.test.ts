import { describe, expect, it } from 'vitest';
import { sniffBillType } from './bill-intake.js';

const refused = expect.objectContaining({ code: 'bank.bill_file_type' });

describe('BK-bill-01 sniff refuses unsigned markup declared as PDF (DR3 delta)', () => {
  it('refuses HTML with <body', () => {
    expect(() => sniffBillType('application/pdf', Buffer.from('TEST\n<body onload="x">TEST</body>'))).toThrow(refused);
  });
  it('refuses HTML with <iframe', () => {
    expect(() => sniffBillType('application/pdf', Buffer.from('TEST <iframe src="x"></iframe>'))).toThrow(refused);
  });
  it('refuses a leading HTML comment', () => {
    expect(() => sniffBillType('application/pdf', Buffer.from('<!-- TEST --><p>TEST</p>'))).toThrow(refused);
  });
  it('refuses BOM-prefixed HTML (UTF-8 and UTF-16)', () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<html><body>TEST</body></html>')]);
    expect(() => sniffBillType('application/pdf', utf8)).toThrow(refused);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html>TEST</html>', 'utf16le')]);
    expect(() => sniffBillType('application/pdf', utf16)).toThrow(refused);
  });
  it('still accepts a signed PDF that mentions tags later', () => {
    expect(sniffBillType('application/pdf', Buffer.from('%PDF-1.7 TEST <body>'))).toBe('application/pdf');
  });
});
