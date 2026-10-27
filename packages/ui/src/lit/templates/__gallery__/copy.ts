/**
 * Gallery copy switches: 130% copy length (every room must survive longer translations) and sample Arabic for the
 * right-to-left shots. Dev tool only.
 */

const ARABIC: Readonly<Record<string, string>> = {
  Home: 'الرئيسية',
  Activity: 'النشاط',
  Bitcoin: 'بيتكوين',
  'Send money': 'إرسال المال',
  Security: 'الأمان',
  Earn: 'الادخار',
  'Spot BTC-USDT': 'التداول الفوري BTC-USDT',
  Fees: 'الرسوم',
};

const ARABIC_SENTENCE = 'هذا نص تجريبي باللغة العربية لاختبار الاتجاه من اليمين إلى اليسار.';

export interface CopyOptions {
  stretch: boolean;
  rtl: boolean;
}

let options: CopyOptions = { stretch: false, rtl: false };

export function setCopyOptions(o: CopyOptions): void {
  options = o;
}

const FILL = ' and a little more text so it runs longer';

/** A copy string as the gallery shows it: as written, 30% longer, or (for titles and sentences) in Arabic. */
export function t(s: string): string {
  let out = s;
  if (options.rtl) {
    out = ARABIC[s] ?? (s.length > 40 ? ARABIC_SENTENCE : s);
  }
  if (options.stretch) {
    const target = Math.ceil(out.length * 1.3);
    while (out.length < target) out += FILL;
    out = out.slice(0, target);
  }
  return out;
}
