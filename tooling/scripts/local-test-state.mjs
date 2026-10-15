import os from 'node:os';
import path from 'node:path';

/** One state root for the stack and every helper. Never silently fall back after a typo. */
export function localStackState(home = os.homedir(), env = process.env) {
  if (env.LOCAL_STACK_STATE === undefined) return path.join(home, '.intafaced', 'local-test-stack');
  const state = env.LOCAL_STACK_STATE;
  if (!state.trim() || !path.isAbsolute(state)) throw new Error('LOCAL_STACK_STATE must be an absolute folder path');
  return path.resolve(state);
}
