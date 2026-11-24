import { createECDH, createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { isRecord } from '@intafaced/contracts/guards';
import type { ProtocolEmbeddedWalletProvider } from '@intafaced/contracts/protocol-embedded-wallet';
import { getAddress, isAddress, type Address } from 'viem';
import {
  PROVIDER_TIMEOUT_MS,
  ProviderRefusedError,
  ProviderUnavailableError,
  type EmbeddedWalletProviderAdapter,
  type ProviderWallet,
} from './provider.js';

/**
 * THE OWNER'S EMBEDDED-WALLET PROVIDER, the one the owner's settings name `turnkey`. Server side only, with no vendor SDK: svc-protocol signs each request with the
 * organisation's backend API key (P-256), the way the provider's own Apache-2.0 `api-key-stamper` does, and asks two
 * things:
 *
 *   - make the person's wallet: one sub-organisation per person, named `intafaced:<personId>`, whose only root user is the
 *     person's own passkey (its WebAuthn registration), holding one Ethereum account. INTAFACED's key is not a member of
 *     the sub-organisation, so it can never sign for the wallet. No seed phrase is shown or stored anywhere;
 *   - return the one already made: the provider is asked for the sub-organisation by that name first, so a retry after a
 *     crash between the provider's answer and our record gets the same wallet, never a second.
 *
 * The API key is read once at boot from settings, checked against its public half, and held only as a KeyObject. It is
 * never logged, never put in an error, and nothing the provider answers is logged.
 */

export const TURNKEY_API_BASE_URL = 'https://api.turnkey.com';
const STAMP_SCHEME = 'SIGNATURE_SCHEME_TK_API_P256';
const CREATE_SUB_ORG = 'ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8';
/** The first Ethereum account of the wallet's seed (BIP-44). */
const ETH_ACCOUNT = {
  curve: 'CURVE_SECP256K1',
  pathFormat: 'PATH_FORMAT_BIP32',
  path: "m/44'/60'/0'/0/0",
  addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
} as const;
const TRANSPORTS: Record<string, string> = {
  ble: 'AUTHENTICATOR_TRANSPORT_BLE',
  internal: 'AUTHENTICATOR_TRANSPORT_INTERNAL',
  nfc: 'AUTHENTICATOR_TRANSPORT_NFC',
  usb: 'AUTHENTICATOR_TRANSPORT_USB',
  hybrid: 'AUTHENTICATOR_TRANSPORT_HYBRID',
  'smart-card': 'AUTHENTICATOR_TRANSPORT_SMART_CARD',
};
/** The room names where the key is kept without naming the vendor (user-facing copy names no partner). */
export const TURNKEY_DISPLAY_NAME = 'your wallet provider';

export interface TurnkeySettings {
  readonly organizationId: string | undefined;
  readonly apiPublicKey: string | undefined;
  readonly apiPrivateKey: string | undefined;
  /** Tests only; production is always the provider's own API. */
  readonly baseUrl?: string;
}

/** The sub-organisation one person's wallet lives in. */
export const turnkeySubOrgName = (ownerRef: string) => `intafaced:${ownerRef}`;

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * The API key pair, checked at boot. Each missing or malformed part refuses to boot with a message that names the setting
 * and never its value.
 */
export function turnkeyApiKey(settings: TurnkeySettings): { organizationId: string; publicKey: string; key: KeyObject } {
  const organizationId = settings.organizationId?.trim() ?? '';
  const publicKey = settings.apiPublicKey?.trim().toLowerCase() ?? '';
  const privateKey = settings.apiPrivateKey?.trim().toLowerCase() ?? '';
  const missing = [
    !organizationId && 'TURNKEY_ORGANIZATION_ID',
    !publicKey && 'TURNKEY_API_PUBLIC_KEY',
    !privateKey && 'TURNKEY_API_PRIVATE_KEY',
  ].filter(Boolean);
  if (missing.length)
    throw new Error(`PROTOCOL_EMBEDDED_WALLET_PROVIDER=turnkey needs ${missing.join(', ')}, which is blank. Refusing to boot.`);
  if (!/^[0-9a-f-]{1,64}$/.test(organizationId)) throw new Error('TURNKEY_ORGANIZATION_ID is not an organisation id. Refusing to boot.');
  if (!/^(02|03)[0-9a-f]{64}$/.test(publicKey))
    throw new Error('TURNKEY_API_PUBLIC_KEY is not a compressed P-256 public key in hex. Refusing to boot.');
  if (!/^[0-9a-f]{64}$/.test(privateKey)) throw new Error('TURNKEY_API_PRIVATE_KEY is not a P-256 private key in hex. Refusing to boot.');
  let uncompressed: Buffer;
  let compressed: string;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'hex'));
    uncompressed = ecdh.getPublicKey();
    compressed = ecdh.getPublicKey('hex', 'compressed');
  } catch {
    throw new Error('TURNKEY_API_PRIVATE_KEY is not a usable P-256 private key. Refusing to boot.');
  }
  if (compressed !== publicKey)
    throw new Error('TURNKEY_API_PUBLIC_KEY is not the public half of TURNKEY_API_PRIVATE_KEY. Refusing to boot.');
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(Buffer.from(privateKey, 'hex')),
      x: b64url(uncompressed.subarray(1, 33)),
      y: b64url(uncompressed.subarray(33, 65)),
    },
    format: 'jwk',
  });
  return { organizationId, publicKey, key };
}

/** The `X-Stamp` header: the API key's DER ECDSA-SHA256 signature over the exact body, with its public key and scheme. */
export function turnkeyStamp(body: string, publicKey: string, key: KeyObject): string {
  const signer = createSign('SHA256');
  signer.update(body);
  signer.end();
  const signature = signer.sign(key, 'hex');
  return b64url(Buffer.from(JSON.stringify({ publicKey, scheme: STAMP_SCHEME, signature })));
}

const providerId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);

export function turnkeyAdapter(settings: TurnkeySettings, fetcher: typeof fetch = fetch): EmbeddedWalletProviderAdapter {
  const { organizationId, publicKey, key } = turnkeyApiKey(settings);
  const base = settings.baseUrl ?? TURNKEY_API_BASE_URL;
  const info: ProtocolEmbeddedWalletProvider = {
    id: 'turnkey',
    displayName: TURNKEY_DISPLAY_NAME,
    test: false,
    // Export and a second passkey run in the provider's own browser flow, which this build's page does not carry yet:
    // the room says so in words instead of offering a button that fails.
    capabilities: { export: false, recovery: false },
  };

  /** One signed call. 5xx, no answer, a non-JSON answer or our own key refused (401/403) is down; any other 4xx refused. */
  async function call(path: string, payload: unknown): Promise<unknown> {
    const body = JSON.stringify(payload);
    let res: Response;
    try {
      res = await fetcher(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Stamp': turnkeyStamp(body, publicKey, key) },
        body,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderUnavailableError(info.displayName, 'did not answer');
    }
    if (res.status >= 500 || res.status === 401 || res.status === 403)
      throw new ProviderUnavailableError(info.displayName, `answered ${res.status}`);
    if (res.status >= 400) throw new ProviderRefusedError(info.displayName, res.status);
    try {
      return await res.json();
    } catch {
      throw new ProviderUnavailableError(info.displayName, 'answered with something that is not JSON');
    }
  }

  /** The wallet's Ethereum address in one sub-organisation; null when it holds none. */
  async function addressOf(subOrgId: string, walletId: string): Promise<Address | null> {
    const answer = await call('/public/v1/query/list_wallet_accounts', { organizationId: subOrgId, walletId });
    const accounts = isRecord(answer) && Array.isArray(answer.accounts) ? answer.accounts : [];
    for (const account of accounts)
      if (
        isRecord(account) &&
        account.path === ETH_ACCOUNT.path &&
        typeof account.address === 'string' &&
        isAddress(account.address, { strict: false })
      )
        return getAddress(account.address);
    return null;
  }

  /** The wallet already made for this person, if the provider holds one. */
  async function existing(ownerRef: string): Promise<ProviderWallet | null> {
    const found = await call('/public/v1/query/list_suborgs', {
      organizationId,
      filterType: 'NAME',
      filterValue: turnkeySubOrgName(ownerRef),
    });
    const ids = isRecord(found) && Array.isArray(found.organizationIds) ? found.organizationIds.filter(providerId) : [];
    const [subOrgId, ...others] = ids;
    if (subOrgId === undefined) return null;
    if (others.length > 0) throw new ProviderUnavailableError(info.displayName, 'holds more than one wallet for this person');
    const listed = await call('/public/v1/query/list_wallets', { organizationId: subOrgId });
    const wallets = isRecord(listed) && Array.isArray(listed.wallets) ? listed.wallets : [];
    const walletId = wallets.map((w) => (isRecord(w) ? w.walletId : null)).find(providerId);
    if (!walletId) throw new ProviderUnavailableError(info.displayName, 'holds this person but no wallet');
    const address = await addressOf(subOrgId, walletId);
    if (!address) throw new ProviderUnavailableError(info.displayName, 'holds a wallet with no Ethereum account');
    return { walletId: `${subOrgId}/${walletId}`, address, ownerRef };
  }

  return {
    info,
    async createWallet(input) {
      const registration = input.passkey.registration;
      // The provider binds a passkey only from its WebAuthn registration; a passkey without one cannot be bound.
      if (!registration) throw new ProviderRefusedError(info.displayName, 400);
      const already = await existing(input.ownerRef);
      if (already) return already;
      const answer = await call('/public/v1/submit/create_sub_organization', {
        type: CREATE_SUB_ORG,
        timestampMs: String(Date.now()),
        organizationId,
        parameters: {
          subOrganizationName: turnkeySubOrgName(input.ownerRef),
          rootQuorumThreshold: 1,
          rootUsers: [
            {
              userName: 'wallet owner',
              apiKeys: [],
              oauthProviders: [],
              authenticators: [
                {
                  authenticatorName: 'passkey',
                  challenge: registration.challenge,
                  attestation: {
                    credentialId: input.passkey.credentialId,
                    clientDataJson: registration.clientDataJson,
                    attestationObject: registration.attestationObject,
                    transports: registration.transports.map((t) => TRANSPORTS[t]).filter(Boolean),
                  },
                },
              ],
            },
          ],
          wallet: { walletName: 'INTAFACED wallet', accounts: [ETH_ACCOUNT] },
        },
      });
      const activity = isRecord(answer) && isRecord(answer.activity) ? answer.activity : null;
      const status = activity?.status;
      if (status === 'ACTIVITY_STATUS_FAILED' || status === 'ACTIVITY_STATUS_REJECTED')
        throw new ProviderRefusedError(info.displayName, 400);
      if (status !== 'ACTIVITY_STATUS_COMPLETED' || !isRecord(activity?.result))
        throw new ProviderUnavailableError(info.displayName, 'did not finish making the wallet');
      const result = Object.entries(activity.result).find(([k, v]) => k.startsWith('createSubOrganizationResult') && isRecord(v))?.[1];
      const subOrgId = isRecord(result) ? result.subOrganizationId : null;
      const wallet = isRecord(result) && isRecord(result.wallet) ? result.wallet : null;
      const walletId = wallet?.walletId;
      const address = Array.isArray(wallet?.addresses) ? wallet.addresses[0] : null;
      if (!providerId(subOrgId) || !providerId(walletId) || typeof address !== 'string' || !isAddress(address, { strict: false }))
        throw new ProviderUnavailableError(info.displayName, 'answered with no wallet');
      return { walletId: `${subOrgId}/${walletId}`, address: getAddress(address), ownerRef: input.ownerRef };
    },
  };
}
