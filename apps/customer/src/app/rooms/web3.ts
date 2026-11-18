import { WEB3_ROUTES } from '../../features/protocol/routes';
import { areaCopy, areaRooms, type RoomIn } from './room';

const WEB3_DESCRIPTION = {
  chain: 'Blocks, validators and chain status',
  dex: 'Swap and liquidity',
  protocol: 'Contracts, rails and audit',
  wallet: 'Your wallet and its activity',
} as const;

/**
 * The web3 area's room labels, in English and as written in each other language: every title and description of a row
 * in `web3Rooms` is a key here, or one that more than one area uses (`sharedNavigationCopy` in ../navigation-copy.ts).
 */
export const web3Copy = areaCopy({
  en: {
    'Blocks, validators and chain status': 'Blocks, validators and chain status',
    'Swap and liquidity': 'Swap and liquidity',
    'Contracts, rails and audit': 'Contracts, rails and audit',
    chain: 'Chain',
    dex: 'DEX',
    protocol: 'Protocol',
    wallet: 'Wallet',
    'Your wallet and its activity': 'Your wallet and its activity',
  },
  es: {
    'Blocks, validators and chain status': 'Bloques, validadores y estado de la cadena',
    'Swap and liquidity': 'Intercambio y liquidez',
    'Contracts, rails and audit': 'Contratos, vías y auditoría',
    chain: 'Cadena',
    dex: 'DEX',
    protocol: 'Protocolo',
    wallet: 'Monedero',
  },
  fr: {
    'Blocks, validators and chain status': 'Blocs, validateurs et état de la chaîne',
    'Swap and liquidity': 'Échange et liquidité',
    'Contracts, rails and audit': 'Contrats, rails et audit',
    chain: 'Chaîne',
    dex: 'DEX',
    protocol: 'Protocole',
    wallet: 'Portefeuille',
  },
});

/** A web3 row, labelled from `web3Copy`. */
type Web3Row = RoomIn<'web3'> & { title: keyof typeof web3Copy.en; description: keyof typeof web3Copy.en };

/** The web3 area's rooms, in the order lookup and search meet them (`rooms` in ../navigation.ts). */
export const web3Rooms = areaRooms('web3', web3Copy, [
  // The Web3 rooms (IA-SPEC 2.8). Every route comes from the Protocol route table; the room roots are searchable and the
  // detail routes are not. The network is Base Sepolia, which is not INTACHAIN and is not audited.
  ...WEB3_ROUTES.map((route): Web3Row => ({
    path: route.path,
    title: route.room,
    description: WEB3_DESCRIPTION[route.room],
    area: 'web3',
    ...(route.path === `/${route.room}` ? {} : { hidden: true }),
  })),
  // Unknown sub-paths open the room, which answers them with its not-found page.
  ...(['chain', 'dex', 'protocol', 'wallet'] as const).map((slug): Web3Row => ({
    path: `/${slug}/*`,
    title: slug,
    description: WEB3_DESCRIPTION[slug],
    area: 'web3',
    hidden: true,
  })),
]);
