import { areaRooms } from './room';

/** The home area's rooms, in the order lookup and search meet them (`rooms` in ../navigation.ts). */
export const homeRooms = areaRooms('home', [
  { path: '/home', title: 'Home', description: 'Your money and markets', door: 'Home', area: 'home', screen: 'home' },
]);
