import { isWeb3Path } from './routes';

/**
 * The Exchange | Web3 switch remembers the last route in each shell, per viewer. It is a preference only: it moves no
 * money and reads no account. Storage can be absent or blocked, so every access is guarded and the default is used.
 */
export type ShellName = 'exchange' | 'web3';
const keys: Record<ShellName, string> = { exchange: 'if.shell.exchange', web3: 'if.shell.web3' };
export const SHELL_DEFAULT: Record<ShellName, string> = { exchange: '/', web3: '/dex' };

export function shellOf(path: string): ShellName {
  return isWeb3Path(path) ? 'web3' : 'exchange';
}

export function rememberShellRoute(path: string, store: Pick<Storage, 'setItem'> | undefined = safeStore()): void {
  try {
    store?.setItem(keys[shellOf(path)], path);
  } catch {
    /* private window or blocked storage: the switch falls back to the default */
  }
}

/** The route to open when the switch moves to `shell`; a stored value from the other shell is ignored. */
export function lastShellRoute(shell: ShellName, store: Pick<Storage, 'getItem'> | undefined = safeStore()): string {
  try {
    const stored = store?.getItem(keys[shell]);
    if (stored && stored.startsWith('/') && !stored.startsWith('//') && shellOf(stored) === shell) return stored;
  } catch {
    /* fall through to the default */
  }
  return SHELL_DEFAULT[shell];
}

function safeStore(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
