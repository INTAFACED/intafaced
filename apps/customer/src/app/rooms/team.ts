import { areaCopy, areaRooms } from './room';

/**
 * The team area's room labels, in English and as written in each other language: every title and description of a row
 * in `teamRooms` is a key here, or one that more than one area uses (`sharedNavigationCopy` in ../navigation-copy.ts).
 */
export const teamCopy = areaCopy({
  en: {
    'Team desk': 'Team desk',
    'Separate operator console': 'Separate operator console',
    'Team inspection': 'Team inspection',
    'Operator module inspection': 'Operator module inspection',
  },
  es: {
    'Team desk': 'Mesa del equipo',
    'Separate operator console': 'Consola independiente del operador',
    'Team inspection': 'Inspección del equipo',
    'Operator module inspection': 'Inspección de módulos del operador',
  },
  fr: {
    'Team desk': 'Console de l’équipe',
    'Separate operator console': 'Console opérateur séparée',
    'Team inspection': 'Inspection de l’équipe',
    'Operator module inspection': 'Inspection des modules opérateur',
  },
});

/** The team area's rooms, in the order lookup and search meet them (`rooms` in ../navigation.ts). */
export const teamRooms = areaRooms('team', teamCopy, [
  { path: '/ops', title: 'Team desk', description: 'Separate operator console', area: 'team', hidden: true },
  { path: '/platform', title: 'Team inspection', description: 'Operator module inspection', area: 'team', hidden: true },
]);
