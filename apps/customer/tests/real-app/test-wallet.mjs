import { encodeAbiParameters, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// A TEST browser wallet for the Web3 journeys. A real wallet extension cannot be installed in the headless browser, so
// this stands in for one: it announces itself the standard way (EIP-6963) and answers the EIP-1193 calls the app makes
// for a fresh TEST key made for this run only. It signs messages and typed data with that key, in this test process, and
// answers `eth_call` only for the TEST tokens a test hands it (its own stand-in for a node). Nothing it does reaches a
// chain or the platform. The app under test is the real one; only the person's own wallet is the stand-in.
export const TEST_WALLET = { name: 'TEST Wallet', rdns: 'test.intafaced.wallet' };

/** A fresh TEST key for one journey run, kept in its journey state so every step's wallet is the same one. */
export const testWalletKey = () => generatePrivateKey();

const EIP712_DOMAIN_RESULT = [
  { type: 'bytes1' },
  { type: 'string' },
  { type: 'string' },
  { type: 'uint256' },
  { type: 'address' },
  { type: 'bytes32' },
  { type: 'uint256[]' },
];

/** The `eth_call` answers a TEST token gives: its EIP-5267 domain, its decimals and the owner's permit nonce. */
function tokenAnswers(chainId, owner, token) {
  const word = (type, value) => encodeAbiParameters([{ type }], [value]);
  return {
    [`${token.address.toLowerCase()}:0x84b0196e`]: encodeAbiParameters(EIP712_DOMAIN_RESULT, [
      '0x0f',
      token.name,
      token.version,
      BigInt(chainId),
      getAddress(token.address),
      `0x${'0'.repeat(64)}`,
      [],
    ]),
    [`${token.address.toLowerCase()}:0x313ce567`]: word('uint8', token.decimals),
    [`${token.address.toLowerCase()}:0x7ecebe00${owner.slice(2).toLowerCase().padStart(64, '0')}`]: word('uint256', BigInt(token.nonce)),
  };
}

/**
 * Installs the TEST wallet in `page` before any app script runs. The wallet starts on `chainId` and follows
 * `wallet_switchEthereumChain` like a real one. `setChain` changes the network from the wallet's side, as a person
 * would in the extension, and the page hears `chainChanged`. `privateKey` keeps one TEST key across a journey's steps,
 * so a later step's page is the same wallet as an earlier one's (`testWalletKey` makes one).
 */
export async function installTestWallet(page, { chainId, tokens = [], privateKey = generatePrivateKey() }) {
  const account = privateKeyToAccount(privateKey);
  const address = account.address.toLowerCase();
  const calls = Object.assign({}, ...tokens.map((token) => tokenAnswers(chainId, address, token)));
  const requests = [];
  const sends = [];
  let rejectNext = false;
  let otherKeyNext = false;
  // Signing runs here, outside the page: the key never enters the browser.
  await page.exposeFunction('__testWalletSign', async (method, params) => {
    requests.push({ method, params });
    if (rejectNext) {
      rejectNext = false;
      return { rejected: true };
    }
    if (otherKeyNext) {
      otherKeyNext = false;
      // A different key signs the same message, as a wallet answering for the wrong account would.
      return { signature: await privateKeyToAccount(generatePrivateKey()).signMessage({ message: { raw: params[0] } }) };
    }
    if (method === 'personal_sign') return { signature: await account.signMessage({ message: { raw: params[0] } }) };
    const { domain, types, primaryType, message } = JSON.parse(params[1]);
    const { EIP712Domain: _domain, ...rest } = types;
    return { signature: await account.signTypedData({ domain, types: rest, primaryType, message }) };
  });
  // A transaction the page asks to send is kept, so a test can read what was built; with no TEST chain it is never sent.
  await page.exposeFunction('__testWalletSend', (method, params) => {
    sends.push({ method, params });
  });
  await page.addInitScript(
    ({ info, address, startChain, calls }) => {
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
          if (method === 'eth_call') {
            const answer = calls[`${String(params[0].to).toLowerCase()}:${String(params[0].data).toLowerCase()}`];
            if (answer) return answer;
            throw Object.assign(new Error('execution reverted'), { code: -32000 });
          }
          if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
            const answer = await window.__testWalletSign(method, params);
            if (answer.rejected) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
            return answer.signature;
          }
          if (method === 'wallet_switchEthereumChain') {
            chain = Number.parseInt(params[0].chainId, 16);
            emit('chainChanged', hex(chain));
            return null;
          }
          if (method === 'eth_sendTransaction') await window.__testWalletSend(method, params);
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
    { info: { uuid: crypto.randomUUID(), ...TEST_WALLET }, address, startChain: chainId, calls },
  );
  return {
    address,
    /** Every signature the page asked for, in order: `{ method, params }`. */
    requests,
    /** Every transaction the page asked the wallet to send, in order: `{ method, params }`. None reaches a chain. */
    sends,
    /** The next signature request is refused the way a person pressing Reject in the wallet refuses it (code 4001). */
    rejectNext: () => {
      rejectNext = true;
    },
    /** The next message is signed by another, throwaway key while the wallet still names its own address. */
    signWithOtherKeyNext: () => {
      otherKeyNext = true;
    },
    /** Moves the wallet to another network from the wallet's side, as a person does in the extension. */
    setChain: (id) => page.evaluate((next) => window.__testWallet.setChain(next), id),
  };
}
