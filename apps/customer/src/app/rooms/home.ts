import { areaCopy, areaRooms } from './room';

/**
 * The home area's room labels, in English and as written in each other language: every title and description of a row
 * in `homeRooms` is a key here, or one that more than one area uses (`sharedNavigationCopy` in ../navigation-copy.ts).
 */
export const homeCopy = areaCopy({
  en: {
    'Your money and markets': 'Your money and markets',
  },
  es: {
    'Your money and markets': 'Tu dinero y los mercados',
  },
  fr: {
    'Your money and markets': 'Votre argent et les marchés',
  },
});

/** The home area's rooms, in the order lookup and search meet them (`rooms` in ../navigation.ts). */
export const homeRooms = areaRooms('home', homeCopy, [
  { path: '/home', title: 'Home', description: 'Your money and markets', door: 'Home', area: 'home', screen: 'home' },
]);
