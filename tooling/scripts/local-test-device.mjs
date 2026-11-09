// The one TEST browser key the local stack's journeys sign in with, and its cookies: kept in local-test-facts.mjs, so
// the journeys read them without this script. Re-exported here under the same names for every other user.
export { LOCAL_TEST_DEVICE_KEY, localTestAdminDeviceCookie, localTestDeviceCookie, localTestDeviceState } from './local-test-facts.mjs';
