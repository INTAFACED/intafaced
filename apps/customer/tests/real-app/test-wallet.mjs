import { randomBytes } from 'node:crypto';

// A TEST browser wallet for the Web3 journeys. A real wallet extension cannot be installed in the headless browser, so
// this stands in for one: it announces itself the standard way (EIP-6963) and answers the EIP-1193 calls the app makes
// for a fresh TEST address made for this run only. It holds no key and signs nothing yet; the journey's signing step adds
// that when its slice lands. Nothing it does reaches a chain or the platform. The app under test is the real one; only
// the person's own wallet is the stand-in.
export const TEST_WALLET = { name: 'TEST Wallet', rdns: 'test.intafaced.wallet' };

/**
 * Installs the TEST wallet in `page` before any app script runs. The wallet starts on `chainId` and follows
 * `wallet_switchEthereumChain` like a real one. `setChain` changes the network from the wallet's side, as a person
 * would in the extension, and the page hears `chainChanged`.
 */
export async function installTestWallet(page, { chainId }) {
  const address = `0x${randomBytes(20).toString('hex')}`;
  await page.addInitScript(
    ({ info, address, startChain }) => {
      let chain = startChain;
      let connected = false;
      const listeners = new Map();
      const emit = (event, value) => (listeners.get(event) ?? []).forEach((listener) => listener(value));
      const hex = (id) => `0x${id.toString(16)}`;
      const provider = {
        async request({ method, params }) {
          if (method === 'eth_requestAccounts') return ((connected = true), [address]);
          if (method === 'eth_accounts') return connected ? [address] : [];
          if (method === 'eth_chainId') return hex(chain);
          if (method === 'wallet_switchEthereumChain') {
            chain = Number.parseInt(params[0].chainId, 16);
            emit('chainChanged', hex(chain));
            return null;
          }
          throw Object.assign(new Error(`The TEST wallet does not answer ${method}`), { code: 4200 });
        },
        on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
        removeListener: (event, listener) =>
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((entry) => entry !== listener),
          ),
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { ...info, icon: '' }, provider }) }),
        );
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
      window.__testWallet = {
        setChain(id) {
          chain = id;
          emit('chainChanged', hex(chain));
        },
      };
    },
    { info: { uuid: crypto.randomUUID(), ...TEST_WALLET }, address, startChain: chainId },
  );
  return {
    address,
    /** Moves the wallet to another network from the wallet's side, as a person does in the extension. */
    setChain: (id) => page.evaluate((next) => window.__testWallet.setChain(next), id),
  };
}
