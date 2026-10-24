// The one TEST browser key the local stack's journeys sign in with (I-signin-sessions-07). Identity trusts a browser by
// its device key; every journey context, and every scripted sign-in that stands for the same person, presents this one,
// so a journey account is asked to authorise a device only where a journey means to ask (J-identity-02 #5 clears it).
// It is a LOCAL TEST value with no meaning outside the stack: identity keeps only its hash, per account.
export const LOCAL_TEST_DEVICE_KEY = 'LOCAL-TEST-journey-browser-device-key';

/**
 * The device cookie as a Playwright storage state, for the customer app on the stack: on 127.0.0.1 and on localhost
 * (the passkey journeys' origin), since a cookie belongs to one host name.
 */
export function localTestDeviceState(hosts = ['127.0.0.1', 'localhost']) {
  return {
    cookies: hosts.map((domain) => ({
      name: 'ifc_dk',
      value: LOCAL_TEST_DEVICE_KEY,
      domain,
      path: '/api/identity/trpc',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    })),
    origins: [],
  };
}

/** The same cookie as a `Set-Cookie` value, for a door that hands the stack's TEST browser key to a visitor (Try it). */
export function localTestDeviceCookie({ secure = false } = {}) {
  return `ifc_dk=${LOCAL_TEST_DEVICE_KEY}; Path=/api/identity/trpc; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`;
}

/**
 * The founder console's own device cookie (apps/admin), holding the same TEST key, as a Playwright cookie for `adminUrl`'s
 * host. It is given by domain and path: Chromium refuses a Secure cookie given with an http URL, but sends it to http on
 * 127.0.0.1 and localhost.
 */
export function localTestAdminDeviceCookie(adminUrl) {
  return {
    name: '__Host-intafaced-admin-device',
    value: LOCAL_TEST_DEVICE_KEY,
    domain: new URL(adminUrl).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
  };
}
