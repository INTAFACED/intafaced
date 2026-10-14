/**
 * "About {Name}" (UI-SPEC 5.5): static, plain-language copy for the four assets the app can name. Two or three
 * sentences each, no prices, no rankings, no claims that need a source. IFC has no entry on purpose: its section is
 * left out until Nitro approves the wording. Any other asset has none either.
 */
export const ABOUT: Readonly<Record<string, readonly string[]>> = {
  BTC: [
    'Bitcoin is a digital currency that runs on its own network of computers instead of being issued by a bank or a company.',
    'People use it to hold value and to send money to anyone, anywhere, at any hour.',
    'Its price moves with what buyers and sellers are willing to pay, so it can change quickly.',
  ],
  ETH: [
    'Ether is the coin of the Ethereum network, a shared computer that runs programs and records who owns what.',
    'It pays the fees for using that network, and people also hold it as an investment.',
    'Its price moves with what buyers and sellers are willing to pay, so it can change quickly.',
  ],
  USDT: [
    'Tether (USDT) is a stablecoin: a coin designed to stay worth one US dollar.',
    'People use it to hold dollars on a crypto network and to buy and sell other coins without leaving crypto.',
    'On INTAFACED it is counted at 1 USD in your total.',
  ],
  USDC: [
    'USD Coin (USDC) is a stablecoin: a coin designed to stay worth one US dollar.',
    'People use it to hold dollars on a crypto network and to buy and sell other coins without leaving crypto.',
    'On INTAFACED it is counted at 1 USD in your total.',
  ],
};

/** The paragraphs for an asset, or null when it has no approved text. */
export const aboutFor = (asset: string): readonly string[] | null => ABOUT[asset] ?? null;
