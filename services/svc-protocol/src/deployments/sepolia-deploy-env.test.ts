import { describe, expect, it } from 'vitest';
import { KNOWN_DEV_PRIVATE_KEYS } from '@intafaced/config';
import { getContractAddress, type Address } from 'viem';
import {
  BANNED_LIVE_CHAIN_IDS,
  CIRCLE_USDC_BASE_SEPOLIA,
  createAddressAfterOneTx,
  ENTRYPOINT_V07,
  namedAddress,
  parseSepoliaDeployEnv,
  SEPOLIA_CHAIN_ID,
} from './sepolia-deploy-env.js';
import { assertSepoliaRegistry, parseDeploymentRegistry } from './registry.js';

const KEY = `0x${'ab'.repeat(32)}`;
const RPC = 'https://sepolia.base.org';

function base(over: Record<string, string | undefined> = {}) {
  return {
    PROTOCOL_CHAIN_ID: String(SEPOLIA_CHAIN_ID),
    PROTOCOL_RPC_URL: RPC,
    PROTOCOL_DEPLOYER_KEY: KEY,
    PROTOCOL_ENTRYPOINT_ADDRESS: ENTRYPOINT_V07,
    PROTOCOL_USDC_ADDRESS: CIRCLE_USDC_BASE_SEPOLIA,
    ...over,
  };
}

describe('parseSepoliaDeployEnv', () => {
  it('accepts Base Sepolia + Circle USDC + canonical EntryPoint', () => {
    const cfg = parseSepoliaDeployEnv(base());
    expect(cfg.chainId).toBe(84532);
    expect(cfg.usdc.toLowerCase()).toBe(CIRCLE_USDC_BASE_SEPOLIA.toLowerCase());
    expect(cfg.entryPoint.toLowerCase()).toBe(ENTRYPOINT_V07.toLowerCase());
    expect(cfg.deployerKey).toBe(KEY);
  });

  it('refuses Arc 5042, anvil 31337, Base mainnet 8453', () => {
    for (const id of BANNED_LIVE_CHAIN_IDS) {
      expect(() => parseSepoliaDeployEnv(base({ PROTOCOL_CHAIN_ID: String(id) }))).toThrow(/PROTOCOL_CHAIN_ID/);
    }
  });

  it('refuses missing deployer key', () => {
    expect(() => parseSepoliaDeployEnv(base({ PROTOCOL_DEPLOYER_KEY: undefined }))).toThrow(/PROTOCOL_DEPLOYER_KEY is unset/);
    expect(() => parseSepoliaDeployEnv(base({ PROTOCOL_DEPLOYER_KEY: '' }))).toThrow(/PROTOCOL_DEPLOYER_KEY is unset/);
  });

  it('refuses USDC that is not Circle Base Sepolia', () => {
    expect(() => parseSepoliaDeployEnv(base({ PROTOCOL_USDC_ADDRESS: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' }))).toThrow(
      /Circle native USDC/,
    );
  });

  it('refuses missing RPC', () => {
    expect(() => parseSepoliaDeployEnv(base({ PROTOCOL_RPC_URL: undefined }))).toThrow(/PROTOCOL_RPC_URL is unset/);
  });

  it('refuses a ws RPC: svc-indexer reads the chain over HTTP', () => {
    expect(() => parseSepoliaDeployEnv(base({ PROTOCOL_RPC_URL: 'wss://base-sepolia-rpc.publicnode.com' }))).toThrow(
      /PROTOCOL_RPC_URL must be an http\(s\) URL/,
    );
  });

  it('refuses every public Anvil/Hardhat key, with or without 0x', () => {
    for (const key of KNOWN_DEV_PRIVATE_KEYS) {
      expect(() => parseSepoliaDeployEnv(base({ PROTOCOL_DEPLOYER_KEY: key }))).toThrow(/public Anvil\/Hardhat key/);
      expect(() => parseSepoliaDeployEnv(base({ PROTOCOL_DEPLOYER_KEY: key.slice(2).toUpperCase() }))).toThrow(/public Anvil\/Hardhat key/);
    }
  });
});

describe('base-sepolia registry shape', () => {
  it('parses a 84532 row and refuses 5042', () => {
    const ok = parseDeploymentRegistry({
      chainId: 84532,
      chainName: 'base-sepolia',
      rpcNote: 'Base Sepolia testnet. Not INTACHAIN. audited:false.',
      contracts: [
        {
          name: 'SovereignVenue',
          address: '0x1111111111111111111111111111111111111111',
          sourceHash: `0x${'11'.repeat(32)}`,
          suite: 'venue',
          explorerUrl: 'https://sepolia.basescan.org/address/0x1111111111111111111111111111111111111111',
          verified: false,
        },
      ],
    });
    expect(ok.chainId).toBe(84532);
    expect(ok.rpcNote).toMatch(/not INTACHAIN/i);
    expect(JSON.stringify(ok)).not.toMatch(/"audited":\s*true/);

    expect(() => assertSepoliaRegistry({ ...ok, chainId: 5042 })).toThrow(/84532/);
  });
});

describe('createAddressAfterOneTx (LaunchVesting approve-then-CREATE)', () => {
  const from = '0xeDc808aaCf685c713C50DfDfa0888420c59B9D2D' as Address;

  it('is nonce+1, not the approve nonce', () => {
    const nonce = 90n;
    const predicted = createAddressAfterOneTx(from, nonce);
    expect(predicted).toBe(getContractAddress({ from, nonce: nonce + 1n }));
    expect(predicted).not.toBe(getContractAddress({ from, nonce }));
  });
});

describe('namedAddress skip-if-named', () => {
  const contracts = [
    {
      name: 'FairLaunch',
      address: '0xbc5227e71f456e3910ba7b5382054c8f1b2bfaf3',
    },
  ];

  it('returns the existing row and undefined when absent', () => {
    expect(namedAddress(contracts, 'FairLaunch')?.toLowerCase()).toBe('0xbc5227e71f456e3910ba7b5382054c8f1b2bfaf3');
    expect(namedAddress(contracts, 'LaunchVesting')).toBeUndefined();
  });
});
