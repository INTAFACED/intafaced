import { RAIL_POSTURE_ENFORCED_ENVS } from '../../rails/posture.js';

/**
 * WHICH NETWORKS HAVE A CUSTODY SIGNER (J-wallet-05 #6 and #7, issue #6517).
 *
 * A withdrawal to a wallet outside the platform needs something that signs and sends on the network it goes on. No live
 * signer exists for any network: that is the owner's to buy, and until then every outside send on every network refuses
 * `pay.wallet_withdraw_unavailable` before anything is claimed or held, as it did when the whole door was shut.
 *
 * A TEST signer may be connected per network for a development or test deployment only: `PAY_TEST_WITHDRAW_SIGNER_NETWORKS`
 * names the networks (comma-separated network ids, as the network registry and the address book name them), blank or unset
 * names none. It is not a key and holds none: it lets the existing `crypto-native` rail send for that network, and that
 * rail is the dev `MemoryChain` (or a test chain) wherever this setting is allowed. It never speaks for any other rail.
 *
 * ONE NETWORK AT MOST. The `crypto-native` rail is one chain and its payout names no network, so a second network with a
 * signer would send on the first one's chain while the address book and the quote said the second. Naming more than one
 * refuses to boot, so the network a send names is always the chain it goes out on.
 *
 * TWO GATES, as `rails/posture.ts` does for sandbox rails:
 *   1. BOOT. A non-blank setting refuses to start unless `APP_ENV` is exactly `dev` or `test` (read raw: unset, blank and
 *      typos are not dev), so staging and prod can never boot with one.
 *   2. RUNTIME. `signerFor` asks again at every send, from the posture boot decided, so a posture built by hand (a test, a
 *      later caller) with an enforced environment still finds no signer.
 *
 * Issue #6517 binds this: no signer, TEST or live, is connected until `withdrawal.create` takes the network and the accepted
 * quote and posts the quoted fee through the fee-carrying recipes. Those are the checks in `send-out/door.ts` and the claim.
 */
export const PAY_TEST_WITHDRAW_SIGNER_NETWORKS_ENV = 'PAY_TEST_WITHDRAW_SIGNER_NETWORKS';

/** The one rail a network signer sends through. */
export const SIGNED_SEND_RAIL = 'crypto-native';

/** Where a TEST signer may be connected: development and test only, by exact name. */
const TEST_SIGNER_ENVS: readonly string[] = ['dev', 'test'];

/** A network id as a quote and a send name it (`sendNetworkIdSchema`), so a named signer can always be matched. */
const NETWORK_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface WithdrawSignerPosture {
  /** `APP_ENV` as read at boot, raw. */
  readonly appEnv: string;
  /** Networks with a TEST signer. Empty: no network has one. */
  readonly testNetworks: ReadonlySet<string>;
}

/** No signer for any network: the posture of every deployment that names none. */
export const NO_WITHDRAW_SIGNER: WithdrawSignerPosture = Object.freeze({ appEnv: '', testNetworks: new Set<string>() });

/** The boot gate. Throws on a setting this deployment may not have, or one that does not parse. */
export function assertWithdrawSignerPosture(env: Record<string, string | undefined> = process.env): WithdrawSignerPosture {
  const appEnv = env.APP_ENV ?? '';
  const raw = env[PAY_TEST_WITHDRAW_SIGNER_NETWORKS_ENV]?.trim() ?? '';
  if (!raw) return { appEnv, testNetworks: new Set() };
  if (!TEST_SIGNER_ENVS.includes(appEnv)) {
    throw new Error(
      `${PAY_TEST_WITHDRAW_SIGNER_NETWORKS_ENV} connects a TEST withdrawal signer, which only APP_ENV dev or test may have ` +
        `(APP_ENV is ${JSON.stringify(env.APP_ENV ?? null)}); refusing to boot`,
    );
  }
  const networks = raw.split(',').map((part) => part.trim());
  if (networks.length > 1) {
    throw new Error(
      `${PAY_TEST_WITHDRAW_SIGNER_NETWORKS_ENV} names ${networks.length} networks; the crypto-native rail is one chain, so at most ` +
        'one network can have a TEST signer; refusing to boot',
    );
  }
  for (const network of networks) {
    if (!NETWORK_ID.test(network)) {
      throw new Error(
        `${PAY_TEST_WITHDRAW_SIGNER_NETWORKS_ENV} names ${JSON.stringify(network)}, which is not a network id; refusing to boot`,
      );
    }
  }
  return { appEnv, testNetworks: new Set(networks) };
}

/**
 * The runtime gate: the signer that would send `rail` on `networkId`, or null when none is connected. Only a TEST signer
 * exists today, and only on the signed rail, for a named network, in an environment allowed one.
 */
export function signerFor(posture: WithdrawSignerPosture, rail: string, networkId: string | null | undefined): 'test' | null {
  if (rail !== SIGNED_SEND_RAIL || !networkId) return null;
  if ((RAIL_POSTURE_ENFORCED_ENVS as readonly string[]).includes(posture.appEnv)) return null;
  if (!TEST_SIGNER_ENVS.includes(posture.appEnv)) return null;
  return posture.testNetworks.has(networkId) ? 'test' : null;
}
