/** Types for local-test-device.mjs, which the customer journeys (TypeScript) import. */
export declare const LOCAL_TEST_DEVICE_KEY: string;
export declare function localTestDeviceCookie(options?: { secure?: boolean }): string;
export declare function localTestDeviceState(hosts?: string[]): {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: never[];
};
