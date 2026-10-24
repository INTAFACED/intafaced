// The one TEST browser key the local stack's journeys sign in with (I-signin-sessions-07). Identity trusts a browser by
// its device key; every journey context, and every scripted sign-in that stands for the same person, presents this one,
// so a journey account is asked to authorise a device only where a journey means to ask (J-identity-02 #5 clears it).
// It is a LOCAL TEST value with no meaning outside the stack: identity keeps only its hash, per account.
export const LOCAL_TEST_DEVICE_KEY = 'LOCAL-TEST-journey-browser-device-key';

/** The device cookie as a Playwright storage state, for the customer app on the stack. */
export function localTestDeviceState(host = '127.0.0.1') {
  return {
    cookies: [
      {
        name: 'ifc_dk',
        value: LOCAL_TEST_DEVICE_KEY,
        domain: host,
        path: '/api/identity/trpc',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      },
    ],
    origins: [],
  };
}
