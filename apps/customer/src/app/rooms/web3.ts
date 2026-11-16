import { WEB3_ROUTES } from '../../features/protocol/routes';
import { areaRooms, type RoomIn } from './room';

const WEB3_DESCRIPTION = {
  chain: 'Blocks, validators and chain status',
  dex: 'Swap and liquidity',
  protocol: 'Contracts, rails and audit',
  wallet: 'Your wallet and its activity',
} as const;

/** The web3 area's rooms, in the order lookup and search meet them (`rooms` in ../navigation.ts). */
export const web3Rooms = areaRooms('web3', [
  // The Web3 rooms (IA-SPEC 2.8). Every route comes from the Protocol route table; the room roots are searchable and the
  // detail routes are not. The network is Base Sepolia, which is not INTACHAIN and is not audited.
  ...WEB3_ROUTES.map((route): RoomIn<'web3'> => ({
    path: route.path,
    title: route.room,
    description: WEB3_DESCRIPTION[route.room],
    area: 'web3',
    ...(route.path === `/${route.room}` ? {} : { hidden: true }),
  })),
  // Unknown sub-paths open the room, which answers them with its not-found page.
  ...(['chain', 'dex', 'protocol', 'wallet'] as const).map((slug): RoomIn<'web3'> => ({
    path: `/${slug}/*`,
    title: slug,
    description: WEB3_DESCRIPTION[slug],
    area: 'web3',
    hidden: true,
  })),
]);
