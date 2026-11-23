// The shared data pieces this screen reads: the data layer in ../../data and the app's navigation. No drawing parts: the
// notifications centre draws with the Volt kit, and the bell takes the old kit from ./deps.
export { refusalCopy, useDataEnv, useSource } from '../../data';
export type { Loadable } from '../../data';
export { navigate } from '../../app/location';
