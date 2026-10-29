import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { walletCopy } from './copy';
import {
  APP_CHAIN_ID,
  chainGuard,
  describeRequest,
  payloadText,
  refuseReason,
  discoverWallets,
  firstAddress,
  parseChainId,
  runSignRequest,
  toHexChainId,
  type ChainGuard,
  type DiscoveredWallet,
  type Eip1193Provider,
  type SignRequest,
  type SignResult,
} from './eip1193';

/** Remembered only to restore the same wallet without a prompt. Storage may be absent or blocked; the page works without it. */
const REMEMBER_KEY = 'if.web3.wallet';
function remembered(store: Pick<Storage, 'getItem'> | undefined): string | null {
  try {
    return store?.getItem(REMEMBER_KEY) ?? null;
  } catch {
    return null;
  }
}
function remember(store: Pick<Storage, 'setItem' | 'removeItem'> | undefined, rdns: string | null) {
  try {
    if (rdns) store?.setItem(REMEMBER_KEY, rdns);
    else store?.removeItem(REMEMBER_KEY);
  } catch {
    /* blocked storage */
  }
}
function browserStore(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';
export interface WalletState {
  status: WalletStatus;
  wallets: DiscoveredWallet[];
  /** The wallet's own announced name and icon. */
  connected: DiscoveredWallet | null;
  address: string | null;
  chainId: number | null;
  guard: ChainGuard | null;
  /** The last connect or switch failure in plain words; cleared on the next attempt. */
  problem: string | null;
}
export interface WalletApi extends WalletState {
  connect(wallet: DiscoveredWallet): Promise<void>;
  disconnect(): void;
  switchNetwork(): Promise<void>;
  /** Shows the plain-words sheet, then asks the wallet. Resolves `rejected` if the person cancels the sheet. */
  sign(request: SignRequest): Promise<SignResult>;
  /** A read-only `eth_call` through the connected wallet's own network connection. Resolves null when it cannot answer. */
  call(to: string, data: string): Promise<string | null>;
  /** The code at `address` through the wallet's own network connection: '0x' for a plain wallet, null when it cannot answer. */
  code(address: string): Promise<string | null>;
  /** "Disconnect on idle": minutes chosen by the person; null means never. A convenience, not a security control. */
  idleMinutes: number | null;
  setIdleMinutes(minutes: number | null): void;
}

const empty: WalletApi = {
  status: 'disconnected',
  wallets: [],
  connected: null,
  address: null,
  chainId: null,
  guard: null,
  problem: null,
  connect: async () => undefined,
  disconnect: () => undefined,
  switchNetwork: async () => undefined,
  sign: async () => ({ status: 'failed', reason: 'not_connected', message: 'No wallet is connected.' }),
  call: async () => null,
  code: async () => null,
  idleMinutes: null,
  setIdleMinutes: () => undefined,
};
const Context = createContext<WalletApi>(empty);
/** Outside a provider (a server render, a test) the wallet is simply not connected. */
export const useWallet = (): WalletApi => useContext(Context);

interface Pending {
  request: SignRequest;
  account: string;
  chainId: number;
  resolve: (result: SignResult) => void;
  /** Asks the wallet. Called only after the person continues from the sheet. */
  run: () => Promise<SignResult>;
  started?: boolean;
}

export function WalletProvider({ children, discovery = true }: { children: ReactNode; discovery?: boolean }) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [connected, setConnected] = useState<DiscoveredWallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [idleMinutes, setIdleMinutes] = useState<number | null>(null);
  const store = useMemo(browserStore, []);
  const restored = useRef(false);

  useEffect(() => {
    if (!discovery || typeof window === 'undefined') return;
    return discoverWallets(window, setWallets);
  }, [discovery]);

  const adopt = useCallback((wallet: DiscoveredWallet, accounts: unknown, chain: unknown) => {
    const next = firstAddress(accounts);
    setAddress(next);
    setChainId(parseChainId(chain));
    setConnected(next ? wallet : null);
    setStatus(next ? 'connected' : 'disconnected');
  }, []);

  const disconnect = useCallback(() => {
    setStatus('disconnected');
    setConnected(null);
    setAddress(null);
    setChainId(null);
    remember(store, null);
    setPending((current) => {
      current?.resolve({ status: 'rejected' });
      return null;
    });
  }, [store]);

  const connect = useCallback(
    async (wallet: DiscoveredWallet) => {
      setProblem(null);
      setStatus('connecting');
      try {
        const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' });
        const chain = await wallet.provider.request({ method: 'eth_chainId' });
        adopt(wallet, accounts, chain);
        if (firstAddress(accounts)) remember(store, wallet.info.rdns);
        else setProblem(t('connectNoAccount'));
      } catch (error) {
        setStatus('disconnected');
        const rejected = typeof error === 'object' && error !== null && (error as { code?: number }).code === 4001;
        setProblem(rejected ? t('connectRejected') : t('connectFailed'));
      }
    },
    [adopt, store, t],
  );

  // A wallet that is still authorised comes back without a prompt (eth_accounts never asks).
  useEffect(() => {
    if (restored.current || status !== 'disconnected') return;
    const rdns = remembered(store);
    const wallet = rdns ? wallets.find((entry) => entry.info.rdns === rdns) : undefined;
    if (!wallet) return;
    restored.current = true;
    void (async () => {
      try {
        const accounts = await wallet.provider.request({ method: 'eth_accounts' });
        if (!firstAddress(accounts)) return remember(store, null);
        adopt(wallet, accounts, await wallet.provider.request({ method: 'eth_chainId' }));
      } catch {
        /* the wallet will be asked again when the person presses Connect */
      }
    })();
  }, [wallets, status, store, adopt]);

  // Account and chain changes made inside the wallet.
  useEffect(() => {
    const provider: Eip1193Provider | undefined = connected?.provider;
    if (!provider?.on) return;
    // A change made in the wallet while the sheet is open voids the sheet: what it showed is no longer what would be signed.
    const closeOpenRequest = (result: SignResult) =>
      setPending((current) => {
        current?.resolve(result);
        return null;
      });
    const onAccounts = (accounts: unknown) => {
      closeOpenRequest({ status: 'rejected' });
      if (!firstAddress(accounts)) disconnect();
      else setAddress(firstAddress(accounts));
    };
    const onChain = (chain: unknown) => {
      closeOpenRequest({ status: 'failed', reason: 'chain_mismatch', message: t('signWrongNetwork') });
      setChainId(parseChainId(chain));
    };
    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, [connected, disconnect, t]);

  // Disconnect on idle: the person sets the time; blank means never.
  useEffect(() => {
    if (status !== 'connected' || idleMinutes === null || typeof window === 'undefined') return;
    let timer = setTimeout(disconnect, idleMinutes * 60_000);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(disconnect, idleMinutes * 60_000);
    };
    const events = ['pointerdown', 'keydown'] as const;
    for (const name of events) window.addEventListener(name, touch);
    return () => {
      clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, touch);
    };
  }, [status, idleMinutes, disconnect]);

  const switchNetwork = useCallback(async () => {
    if (!connected) return;
    setProblem(null);
    try {
      await connected.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHexChainId(APP_CHAIN_ID) }] });
      setChainId(parseChainId(await connected.provider.request({ method: 'eth_chainId' })));
    } catch {
      setProblem(t('switchFailed'));
    }
  }, [connected, t]);

  const sign = useCallback(
    (request: SignRequest): Promise<SignResult> => {
      if (!connected || !address) return Promise.resolve({ status: 'failed', reason: 'not_connected', message: t('signNotConnected') });
      const refused = refuseReason(request);
      if (refused)
        return Promise.resolve({ status: 'failed', reason: 'invalid_request', message: `${refused} Nothing was signed or sent.` });
      if (!chainGuard(chainId).ok) return Promise.resolve({ status: 'failed', reason: 'chain_mismatch', message: t('signWrongNetwork') });
      const wallet = connected;
      const account = address;
      return new Promise<SignResult>((resolve) => {
        // The sheet comes first. The wallet is asked only after the person continues.
        setPending({
          request,
          account,
          chainId: chainId ?? APP_CHAIN_ID,
          resolve,
          run: () => runSignRequest(wallet.provider, account, request),
        });
      });
    },
    [connected, address, chainId, t],
  );

  const call = useCallback(
    async (to: string, data: string): Promise<string | null> => {
      if (!connected) return null;
      try {
        const result = await connected.provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
        return typeof result === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(result) ? result : null;
      } catch {
        return null;
      }
    },
    [connected],
  );

  const code = useCallback(
    async (target: string): Promise<string | null> => {
      if (!connected) return null;
      try {
        const result = await connected.provider.request({ method: 'eth_getCode', params: [target, 'latest'] });
        // Some nodes answer '0x0' for an account with no code.
        return typeof result === 'string' && /^0x[0-9a-fA-F]*$/.test(result) ? result : null;
      } catch {
        return null;
      }
    },
    [connected],
  );

  const api: WalletApi = {
    status,
    wallets,
    connected,
    address,
    chainId,
    guard: status === 'connected' ? chainGuard(chainId) : null,
    problem,
    connect,
    disconnect,
    switchNetwork,
    sign,
    call,
    code,
    idleMinutes,
    setIdleMinutes,
  };
  return (
    <Context.Provider value={api}>
      {children}
      {pending && (
        <SignSheet
          request={pending.request}
          account={pending.account}
          chainId={pending.chainId}
          onCancel={() => {
            pending.started = true;
            pending.resolve({ status: 'rejected' });
            setPending(null);
          }}
          onContinue={async () => {
            const current = pending;
            if (current.started) return;
            current.started = true;
            setPending(null);
            current.resolve(await current.run());
          }}
        />
      )}
    </Context.Provider>
  );
}

/** The plain-words sheet that comes before every wallet prompt: what, which contract, amount, spender and expiry. */
export function SignSheet({
  request,
  account,
  chainId,
  onCancel,
  onContinue,
}: {
  request: SignRequest;
  account: string;
  chainId: number;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const facts = describeRequest(request);
  return (
    <Dialog title={t('sheetTitle')} onClose={onCancel}>
      <div data-sheet="sign">
        <p>{t(request.kind === 'transaction' ? 'sheetSends' : request.kind === 'message' ? 'sheetSignsMessage' : 'sheetSignsData')}</p>
        <dl className="protocol-facts">
          <div>
            <dt>{t('fact_account')}</dt>
            <dd className="numeric">{account}</dd>
          </div>
          <div>
            <dt>{t('fact_network')}</dt>
            <dd>{chainId}</dd>
          </div>
          {facts.map((fact, index) => (
            <div key={`${fact.label}:${index}`}>
              <dt>{t(`fact_${fact.label}`)}</dt>
              <dd className="numeric">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <details open>
          <summary>{t('sheetExact')}</summary>
          <pre className="numeric" data-sheet-payload>
            {payloadText(request, account, chainId)}
          </pre>
        </details>
        <p className="muted">
          {t(request.kind === 'transaction' ? 'sheetMovesFunds' : request.kind === 'message' ? 'sheetMovesNothing' : 'sheetMayAuthorise')}
        </p>
        <Button onClick={onContinue}>{t('sheetContinue')}</Button>{' '}
        <Button variant="secondary" onClick={onCancel}>
          {t('sheetCancel')}
        </Button>
      </div>
    </Dialog>
  );
}
