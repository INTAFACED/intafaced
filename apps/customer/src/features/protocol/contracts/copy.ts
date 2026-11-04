import { defineCopy } from '../../../shared/i18n';

/**
 * Authored copy for a contract's page (/protocol/contracts/:address, D-explorer-06): its source status, its proxy and the
 * Read and Write tabs. English only for now; other languages fall back to it.
 */
const en = {
  pageTitle: 'Contract {address}',
  notFoundTitle: 'Not a contract address',
  notFoundBody: 'A contract address is 0x followed by 40 hex characters.',
  back: 'Back to contracts',
  checking: 'Reading the contract',
  sourceTitle: 'Source status',
  status_exact: 'Exact match: {name} ({sourceName}, {compiler})',
  status_similar: 'Similar match: {name} ({sourceName}, {compiler})',
  status_unverified_no_code: 'Unverified: there is no contract code at this address on this network',
  status_unverified_no_matching_source: 'Unverified: no source on file compiles to this code',
  reason_exact: 'The code on chain is this build byte for byte, apart from the values its constructor set.',
  reason_similar:
    'The code on chain is this build except for its metadata hash: the same program, compiled from a source written differently (comments, names or layout).',
  reason_unverified_no_code: 'Nothing is deployed here, so there is no source to match and no interface to call.',
  reason_unverified_no_matching_source:
    'None of the sources this platform compiled produces this code, so its source and its interface are unknown.',
  sourceHash: 'Source hash',
  readAt: 'Read at block {block}',
  proxyTitle: 'Proxy',
  proxy_eip1167: 'EIP-1167 minimal proxy',
  proxy_eip1967: 'EIP-1967 proxy',
  implementation: 'Implementation {address} ({standard})',
  implementationSource: 'Implementation source: {status}',
  tabs: 'Contract tabs',
  tab_read: 'Read',
  tab_write: 'Write',
  interface_implementation: "Functions from {name}, the implementation's interface, called at this proxy's address.",
  interface_contract: "Functions from {name}, this contract's interface.",
  noInterface: 'Read and Write need the contract’s interface, and it is unknown: {status}.',
  noReads: 'This interface has no read functions.',
  noWrites: 'This interface has no write functions.',
  query: 'Query',
  write: 'Write',
  value: 'Value to send (wei)',
  argJson: 'JSON',
  resultAt: 'At block {block}',
  writeConnect: 'Connect a wallet to write. A Write call is signed and sent by your own wallet, never by this platform.',
  writeConnectLink: 'Connect a wallet',
  writeWrongChain: 'Your wallet is on another network. Switch it to this network to write.',
  writeNote: 'Each Write builds the call here and asks your wallet to sign and send it. Nothing is sent without your wallet.',
  writeSent: 'Sent: {hash}. Waiting for it to be mined.',
  writeMined: 'Mined in block {block}: {hash}.',
  writeReverted: 'Mined but reverted: {hash}. Nothing changed; the network fee was paid.',
  writeNotMined: 'Sent: {hash}. It is still waiting to be mined, and your wallet holds it.',
  writeRejected: 'Your wallet declined. Nothing was sent.',
  writeFailed: 'Not sent: {message}',
  lookupLabel: 'Contract address',
  lookupOpen: 'Open contract',
  lookupInvalid: 'Enter 0x followed by 40 hex characters.',
} as const;

export const contractCopy = defineCopy('customer.protocol.contract', en);
export type ContractTranslate = ReturnType<typeof contractCopy.forLocale>['t'];
