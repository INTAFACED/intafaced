import { defineCopy } from '../../../shared/i18n';

/**
 * Authored copy for the chain explorer on Chain home. English only for now; other languages fall back to it. Nothing
 * here calls a test network INTACHAIN or mainnet, and nothing claims a result the indexer did not give.
 */
const en = {
  homeTitle: 'Explorer',
  searchLabel: 'Search by address, transaction or block',
  searchPlaceholder: 'Address, transaction hash or block height',
  searchSubmit: 'Search',
  resultsLabel: 'Search results',
  resultAddress: 'Address',
  resultTx: 'Transaction',
  resultBlock: 'Block',
  textNoTokenSource:
    'Token names are searched in the token list, and this build has no token list to search. Paste an address, a transaction hash or a block height.',
  networksSearched: 'Networks searched',
  searchingNetwork: 'Checking {network}…',
  networkFound: '{network}: Found ({status})',
  networkNotFound: '{network}: Not found on this network',
  networkNotChecked: '{network}: not checked: {reason}',
  reasonOtherNetwork: 'this explorer reads only {network}',
  reasonChainUnknown: 'the network this explorer reads could not be confirmed',
  reasonIndexerNotConnected: 'the indexer service is not running here',
  reasonIndexerNoAnswer: 'the indexer service didn’t answer',
  openTx: 'Open transaction',
  latestBlocks: 'Latest blocks',
  latestTxs: 'Latest transactions',
  hdrBlock: 'Block',
  hdrTime: 'Time',
  hdrTxs: 'Transactions',
  hdrGas: 'Gas used',
  hdrHash: 'Hash',
  hdrFrom: 'From',
  hdrTo: 'To',
  hdrStatus: 'Status',
  blocksAsOf: 'As of {time}',
  blocksNone: 'The indexer has read no blocks on this network.',
  blockOrphaned: 'Reorged: {reason}',
  blocksChainUnknown: 'The network this explorer reads could not be confirmed, so no blocks are listed.',
  blocksRefused: 'No blocks listed: {reason}',
  txsNoList: 'The indexer has no list of recent transactions in this build. Search a transaction hash to read one.',
  intachainLine: 'INTACHAIN: not launched. Blocked: no INTACHAIN chain service or validator set is running. This explorer reads {network}.',
  intachainLineUnknown: 'INTACHAIN: not launched. Blocked: no INTACHAIN chain service or validator set is running.',
} as const;

export const explorerCopy = defineCopy('customer.protocol.explorer', en);
export type ExplorerTranslate = ReturnType<typeof explorerCopy.forLocale>['t'];
