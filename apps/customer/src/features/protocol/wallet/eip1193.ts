/**
 * The wallet side of the Web3 rooms, as plain EIP-1193 / EIP-6963 calls. No wallet brand is named in our copy: a wallet
 * shows the name and icon it announces itself. Nothing here holds a key; every signature is the wallet's own.
 */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

/** The chain the Web3 rooms work on until the owner says otherwise: Base Sepolia, which is not INTACHAIN. */
export const APP_CHAIN_ID = 84532;

const ANNOUNCE = 'eip6963:announceProvider';
const REQUEST = 'eip6963:requestProvider';

/** Wallets announce themselves on request (EIP-6963). Returns what has announced so far through `onChange`, and a stop function. */
export function discoverWallets(
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>,
  onChange: (wallets: DiscoveredWallet[]) => void,
): () => void {
  const found = new Map<string, DiscoveredWallet>();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: Partial<WalletInfo>; provider?: Eip1193Provider }>).detail;
    const info = detail?.info;
    if (!info || typeof info.uuid !== 'string' || typeof info.name !== 'string' || typeof info.rdns !== 'string' || !detail.provider)
      return;
    // An icon is only ever shown as an image source, and only when it is an inline image.
    const icon = typeof info.icon === 'string' && /^data:image\//.test(info.icon) ? info.icon : '';
    found.set(info.uuid, { info: { uuid: info.uuid, name: info.name, rdns: info.rdns, icon }, provider: detail.provider });
    onChange([...found.values()]);
  };
  target.addEventListener(ANNOUNCE, listener);
  target.dispatchEvent(new Event(REQUEST));
  return () => target.removeEventListener(ANNOUNCE, listener);
}

/** `0x14a34` becomes 84532; anything that is not a hex quantity becomes null, never 0. */
export function parseChainId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
export function toHexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function firstAddress(accounts: unknown): string | null {
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  return typeof first === 'string' && ADDRESS.test(first) ? first : null;
}
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export type ChainGuard = { ok: true } | { ok: false; code: 'chain_mismatch'; configured: number; observed: number | null };
export function chainGuard(observed: number | null, configured: number = APP_CHAIN_ID): ChainGuard {
  return observed === configured ? { ok: true } : { ok: false, code: 'chain_mismatch', configured, observed };
}

/** What a signature request returns. A rejection is a normal answer, not an error. */
export type SignResult =
  | { status: 'signed'; signature: string }
  | { status: 'sent'; hash: string }
  | { status: 'rejected' }
  | { status: 'failed'; reason: 'timeout' | 'wallet_error' | 'chain_mismatch' | 'not_connected' | 'invalid_request'; message: string };

export type SignRequest =
  | { kind: 'typedData'; typedData: TypedDataDocument }
  | { kind: 'message'; message: string }
  | {
      kind: 'transaction';
      to: string;
      value?: string;
      data?: string;
      /**
       * The network fee the person chose, as hex wei per gas (EIP-1559): both or neither. Absent, the wallet sets the fee
       * itself. Shown on the sheet and sent in the same object.
       */
      maxFeePerGas?: string;
      maxPriorityFeePerGas?: string;
    };

export interface TypedDataDocument {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: { name?: string; version?: string; chainId?: number | string; verifyingContract?: string };
  message: Record<string, unknown>;
}

const REJECTED_CODES = new Set([4001, 'ACTION_REJECTED']);
function isRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && REJECTED_CODES.has((error as { code?: number | string }).code as number);
}

export const SIGN_TIMEOUT_MS = 120_000;

/** Runs one signature through the wallet. The caller has already shown the plain-words sheet. */
export async function runSignRequest(
  provider: Eip1193Provider,
  account: string,
  request: SignRequest,
  timeoutMs: number = SIGN_TIMEOUT_MS,
  configuredChain: number = APP_CHAIN_ID,
): Promise<SignResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SignResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: 'failed', reason: 'timeout', message: 'The wallet did not answer in time. Nothing was signed or sent.' }),
      timeoutMs,
    );
  });
  const call = (async (): Promise<SignResult> => {
    try {
      const refused = refuseReason(request);
      if (refused) return { status: 'failed', reason: 'invalid_request', message: `${refused} Nothing was signed or sent.` };
      // The wallet may have changed chain or account while the sheet was open: ask it again, right before the request.
      const wrongChain: SignResult = {
        status: 'failed',
        reason: 'chain_mismatch',
        message: 'Your wallet is on another network. Switch it and try again. Nothing was signed or sent.',
      };
      if (!chainGuard(parseChainId(await provider.request({ method: 'eth_chainId' })), configuredChain).ok) return wrongChain;
      if (firstAddress(await provider.request({ method: 'eth_accounts' }))?.toLowerCase() !== account.toLowerCase())
        return { status: 'failed', reason: 'not_connected', message: 'The wallet account changed. Nothing was signed or sent.' };
      if (request.kind === 'typedData') {
        const domainChain = request.typedData.domain.chainId;
        if (
          domainChain !== undefined &&
          parseChainId(typeof domainChain === 'string' && /^\d+$/.test(domainChain) ? Number(domainChain) : domainChain) !== configuredChain
        )
          return wrongChain;
        const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(request.typedData)] });
        return typeof signature === 'string' && signature.startsWith('0x')
          ? { status: 'signed', signature }
          : { status: 'failed', reason: 'wallet_error', message: 'The wallet returned no signature.' };
      }
      if (request.kind === 'message') {
        const signature = await provider.request({ method: 'personal_sign', params: [utf8Hex(request.message), account] });
        return typeof signature === 'string' && signature.startsWith('0x')
          ? { status: 'signed', signature }
          : { status: 'failed', reason: 'wallet_error', message: 'The wallet returned no signature.' };
      }
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [transactionParams(request, account, configuredChain)],
      });
      return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)
        ? { status: 'sent', hash }
        : { status: 'failed', reason: 'wallet_error', message: 'The wallet returned no transaction hash.' };
    } catch (error) {
      if (isRejection(error)) return { status: 'rejected' };
      return {
        status: 'failed',
        reason: 'wallet_error',
        message: 'The wallet could not complete the request. Nothing was signed or sent.',
      };
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function utf8Hex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The plain-words facts for the sheet that comes before every wallet prompt. Every fact is read from the payload itself. */
export interface SheetFact {
  label:
    | 'contract'
    | 'spender'
    | 'amount'
    | 'expiry'
    | 'action'
    | 'recipient'
    | 'value'
    | 'message'
    | 'calldata'
    | 'domain'
    | 'token'
    | 'maxFee'
    | 'priorityFee';
  value: string;
}
const SPENDER_KEYS = ['spender', 'operator', 'delegate'];
const AMOUNT_KEYS = ['value', 'amount', 'amountIn', 'amountOut', 'inputAmount'];
const EXPIRY_KEYS = ['expiry', 'deadline', 'expiration', 'validBefore', 'sigDeadline'];
const TOKEN_KEYS = ['token', 'tokenIn', 'tokenOut'];

type Leaf = { name: string; value: string };

/**
 * Walks `message` exactly as `types[typeName]` declares it (nested structs and arrays included) and returns every leaf
 * with its field name. A field the types do not declare is never read, and `undeclared` lists the names so they can be refused.
 */
export function walkTyped(typedData: TypedDataDocument): { leaves: Leaf[]; undeclared: string[] } {
  const leaves: Leaf[] = [];
  const undeclared: string[] = [];
  const visit = (typeName: string, value: unknown, depth: number) => {
    const fields = Object.hasOwn(typedData.types, typeName) ? typedData.types[typeName] : undefined;
    if (!Array.isArray(fields) || typeof value !== 'object' || value === null || depth > 6) return;
    const record = value as Record<string, unknown>;
    const declared = new Set(fields.map((field) => field.name));
    for (const key of Object.keys(record)) if (!declared.has(key)) undeclared.push(key);
    for (const field of fields) {
      const base = field.type.replace(/(\[\d*\])+$/, '');
      const isArray = base !== field.type;
      const entry = record[field.name];
      const items = isArray ? (Array.isArray(entry) ? entry.flat(Infinity) : []) : [entry];
      for (const item of items) {
        if (Object.hasOwn(typedData.types, base)) visit(base, item, depth + 1);
        else if (item !== undefined && item !== null && typeof item !== 'object') leaves.push({ name: field.name, value: String(item) });
      }
    }
  };
  visit(typedData.primaryType, typedData.message, 0);
  return { leaves, undeclared };
}

/** Why a request is refused before any sheet or wallet prompt, or null. Typed data must name its chain and declare every field it carries. */
export function refuseReason(request: SignRequest): string | null {
  if (request.kind === 'transaction') {
    if (!ADDRESS.test(request.to)) return 'The recipient is not a valid address.';
    if (request.value !== undefined && !/^0x[0-9a-fA-F]+$/.test(request.value)) return 'The value is not a hex amount.';
    if (request.data !== undefined && !/^0x([0-9a-fA-F]{2})*$/.test(request.data)) return 'The calldata is not valid hex.';
    const fee = [request.maxFeePerGas, request.maxPriorityFeePerGas];
    if (fee.some((entry) => entry !== undefined)) {
      if (fee.some((entry) => entry === undefined || !/^0x[0-9a-fA-F]{1,64}$/.test(entry)))
        return 'The network fee is not a pair of hex amounts per gas.';
      if (BigInt(request.maxPriorityFeePerGas!) > BigInt(request.maxFeePerGas!)) return 'The priority fee is above the most per gas.';
    }
  }
  if (request.kind === 'typedData') {
    const { domain, types, primaryType } = request.typedData;
    if (domain.chainId === undefined) return 'The signature does not name a chain.';
    if (!Object.hasOwn(types, primaryType) || !Array.isArray(types[primaryType])) return 'The signature does not declare its own fields.';
    // The wallet hashes the domain from the fields EIP712Domain declares, so only declared domain fields are signed.
    const declared =
      Object.hasOwn(types, 'EIP712Domain') && Array.isArray(types.EIP712Domain) ? types.EIP712Domain.map((field) => field.name) : null;
    if (!declared || !declared.includes('chainId')) return 'The signature does not declare its chain in its domain.';
    if (Object.keys(domain).some((key) => !declared.includes(key))) return 'The signature domain carries fields it does not declare.';
    if (declared.some((name) => (domain as Record<string, unknown>)[name] === undefined))
      return 'The signature domain is missing a declared field.';
    if (walkTyped(request.typedData).undeclared.length > 0) return 'The signature carries fields it does not declare.';
  }
  return null;
}

export function describeRequest(request: SignRequest): SheetFact[] {
  if (request.kind === 'message') return [{ label: 'message', value: request.message }];
  if (request.kind === 'transaction')
    return [
      { label: 'recipient', value: request.to },
      { label: 'value', value: request.value ?? '0x0' },
      { label: 'calldata', value: request.data && request.data !== '0x' ? request.data : 'none' },
      ...(request.maxFeePerGas !== undefined && request.maxPriorityFeePerGas !== undefined
        ? [
            { label: 'maxFee' as const, value: `${BigInt(request.maxFeePerGas).toString()} wei` },
            { label: 'priorityFee' as const, value: `${BigInt(request.maxPriorityFeePerGas).toString()} wei` },
          ]
        : []),
    ];
  const { domain, primaryType } = request.typedData;
  const facts: SheetFact[] = [{ label: 'action', value: primaryType }];
  facts.push({ label: 'domain', value: JSON.stringify(domain) });
  // Every occurrence is listed, in the order the types declare them: a batch shows every token and amount.
  const { leaves } = walkTyped(request.typedData);
  if (domain.verifyingContract) facts.push({ label: 'contract', value: domain.verifyingContract });
  // An EIP-2612 permit is signed in the token's own domain, so its verifying contract is also the token being allowed.
  if (domain.verifyingContract && primaryType === 'Permit' && !leaves.some((leaf) => TOKEN_KEYS.includes(leaf.name)))
    facts.push({ label: 'token', value: domain.verifyingContract });
  const labelOf = (name: string): SheetFact['label'] | undefined =>
    TOKEN_KEYS.includes(name)
      ? 'token'
      : SPENDER_KEYS.includes(name)
        ? 'spender'
        : AMOUNT_KEYS.includes(name)
          ? 'amount'
          : EXPIRY_KEYS.includes(name)
            ? 'expiry'
            : undefined;
  for (const leaf of leaves) {
    const label = labelOf(leaf.name);
    if (label) facts.push({ label, value: leaf.value });
  }
  return facts;
}

/** The one object both the sheet and the wallet call use, so what is shown is what is sent. */
export function transactionParams(request: Extract<SignRequest, { kind: 'transaction' }>, account: string, chainId: number) {
  return {
    from: account,
    to: request.to,
    chainId: toHexChainId(chainId),
    value: request.value ?? '0x0',
    data: request.data ?? '0x',
    // The person's chosen network fee, when there is one; otherwise the wallet sets it.
    ...(request.maxFeePerGas !== undefined && request.maxPriorityFeePerGas !== undefined
      ? { maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas }
      : {}),
  };
}

/** The exact payload the wallet will be asked to sign or send, rendered from the same object that is sent. */
export function payloadText(request: SignRequest, account: string, chainId: number): string {
  if (request.kind === 'typedData') return JSON.stringify(request.typedData, null, 2);
  if (request.kind === 'message') return request.message;
  return JSON.stringify(transactionParams(request, account, chainId), null, 2);
}
