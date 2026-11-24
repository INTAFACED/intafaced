export declare const BANNER_TEXT: string;
export declare const BANNER_ID: string;
export declare const BANNER_HTML: string;
export declare function moneyMode(env?: Record<string, string | undefined>): 'test' | 'real';
export declare function withTestBanner(html: string, env?: Record<string, string | undefined>): string;
export declare function testBanner(env?: Record<string, string | undefined>): {
  name: string;
  transformIndexHtml: (html: string) => string;
};
