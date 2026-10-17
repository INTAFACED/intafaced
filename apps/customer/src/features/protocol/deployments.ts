/**
 * Deployment record for Base Sepolia (chain 84532, "Base Sepolia testnet. Not INTACHAIN. audited:false.").
 * Copied by hand from services/svc-protocol/deployments/base-sepolia.json (deployedAt 2026-09-18T09:56:56.596Z); the service does not serve
 * this list yet, so it can drift. None of these contracts is verified or audited. Never label them INTACHAIN.
 */
export const BASE_SEPOLIA_DEPLOYMENT = {
  chainId: 84532,
  chainName: 'Base Sepolia',
  deployedAt: '2026-09-18T09:56:56.596Z',
  contracts: [
    { name: 'TEST', suite: 'vaults', address: '0x780627a9d781edf08bd81fbf2263fa85dd8c135e' },
    { name: 'SmartAccount', suite: 'accounts', address: '0x0f06b94ed8fbede67c5da6e566855ebe4fd8d0df' },
    { name: 'AccountFactory', suite: 'accounts', address: '0x6573a525de6c7428a8b1c07fb5986d789f7694f4' },
    { name: 'TokenFactory', suite: 'launch', address: '0x2df184ca3191285b772b6f65bb310ff8117bf5fd' },
    { name: 'PoolFactory', suite: 'amm', address: '0x0ddaf1c1d7b3cabb38b083052e73d4285dce8611' },
    { name: 'ConstantProductPool', suite: 'amm', address: '0x19F9639830DC27093Ff34f7E01Da8a26f1aE3D28' },
    { name: 'SovereignVenue', suite: 'venue', address: '0x78fbe21605d9424efdd6b2fddc4e846e8c746a4b' },
    { name: 'ScopedPaymaster', suite: 'paymaster', address: '0xa5b27bcd2b1a5c0335d5929cac9a093a238ec7d6' },
    { name: 'SovereignEscrow', suite: 'escrow', address: '0xc8ab604a513ec25752fed1a3f0037bec208e7384' },
    { name: 'SovereignRouter', suite: 'router', address: '0x8d28045bbe8a1aed986751257c5711524a7ec73f' },
    { name: 'StealthAnnouncer', suite: 'privacy', address: '0x5744f51ca4856643cac0cd241df1883244a48936' },
    { name: 'RankAttestation', suite: 'attestations', address: '0xd2a07c89f8b84e0e4e9d4b54509cd2ee25407828' },
    { name: 'DeployerReputation', suite: 'vaults', address: '0x0291749959de97b688658babc05445389d651540' },
    { name: 'RoyaltyMarket', suite: 'nft', address: '0xb53c0ad55ef393a5d768b9e595319ed5f60233d3' },
    { name: 'PasskeyOwner', suite: 'passkey', address: '0x8e6c9bca18fda27d4742cabfaa12312f4e5f461c' },
    { name: 'UserElectedRecovery', suite: 'recovery', address: '0x65dd45d6c42b17c3ffb9e4f8b058f9fdcaea9c90' },
    { name: 'SovereignNft', suite: 'nft', address: '0x03e61ab30f38708daa30b87db14a7f4f6cb01407' },
    { name: 'RwaRegistry', suite: 'rwa', address: '0x7ba4298c20f914f45574c601183b917350b9406a' },
    { name: 'TreasuryYieldVault', suite: 'vaults', address: '0x2392ab33626314fc7561f00473029e8c500c143c' },
    { name: 'MerchantAccept', suite: 'merchant', address: '0x6d890d08afd61a067aad1acc3532b55109a5e296' },
    { name: 'MemeLaunch', suite: 'meme', address: '0x211ab60691cb309505f6ce3c1761ad362d05506a' },
    { name: 'CrewVault', suite: 'vaults', address: '0xcbf56214139bf9698ba7f2b1231f1f87f86b0903' },
    { name: 'LegacyVault', suite: 'vaults', address: '0xc5abd1ec4bec16f2066e47042cf8482e4694b31f' },
    { name: 'FailClosedOracle', suite: 'oracle', address: '0x630b0e0df4edc7423a36f3afca477819d6581678' },
    { name: 'IsolatedLendingMarket', suite: 'lending', address: '0x7abcf6cdb6bdf481c318562a075369160c575e7d' },
    { name: 'LaunchLpLock', suite: 'vaults', address: '0x8425454b749c6898afd573cb230bba991ed79215' },
    { name: 'FairLaunch', suite: 'launchpad', address: '0xbc5227e71f456e3910ba7b5382054c8f1b2bfaf3' },
    { name: 'LaunchVesting', suite: 'vaults', address: '0x6813b7f4215bc3b9658080900e97322122a3f475' },
  ],
} as const;
