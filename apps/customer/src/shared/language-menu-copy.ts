import { defineCopy } from './i18n';

// The language switcher on the sign-in pages and in the account menu (RC-home-ia-05). It states what is written, never how many languages exist.
const en = {
  label: 'Language',
  groupWritten: 'Written in the app',
  groupUnwritten: 'Not written, shows English',
  optionShare: '{share}% written',
  machine: 'Machine-translated',
  noteEnglish: 'English is the language the app is written in.',
  noteWritten: '{language}: {share}% of the app is written in it. The rest shows English.',
  noteAll: '{language}: all of the app is written in it.',
  noteMachine: 'Machine-translated and not read by a person.',
  noteUnwritten: '{language} has no written copy, so the app shows English. Your choice is kept.',
  noteDevice: 'Saved in this browser only.',
  noteNotSaved: 'Not saved to your account. It is kept on this device.',
} as const;

export const languageMenuCopy = defineCopy('customer.languageMenu', en, {
  es: {
    label: 'Idioma',
    groupWritten: 'Escrito en la app',
    groupUnwritten: 'Sin texto escrito, se muestra inglés',
    optionShare: '{share}% escrito',
    machine: 'Traducción automática',
    noteEnglish: 'El inglés es el idioma en que está escrita la app.',
    noteWritten: '{language}: el {share}% de la app está escrito en este idioma. El resto se muestra en inglés.',
    noteAll: '{language}: toda la app está escrita en este idioma.',
    noteMachine: 'Traducción automática, no revisada por una persona.',
    noteUnwritten: '{language} no tiene texto escrito, así que la app se muestra en inglés. Tu elección se conserva.',
    noteDevice: 'Se guarda solo en este navegador.',
    noteNotSaved: 'No se guardó en tu cuenta. Se conserva en este dispositivo.',
  },
  fr: {
    label: 'Langue',
    groupWritten: "Rédigé dans l'app",
    groupUnwritten: "Pas de texte rédigé, l'anglais s'affiche",
    optionShare: '{share} % rédigé',
    machine: 'Traduction automatique',
    noteEnglish: "L'anglais est la langue dans laquelle l'app est rédigée.",
    noteWritten: "{language} : {share} % de l'app est rédigé dans cette langue. Le reste s'affiche en anglais.",
    noteAll: "{language} : toute l'app est rédigée dans cette langue.",
    noteMachine: 'Traduction automatique, non relue par une personne.',
    noteUnwritten: "{language} n'a pas de texte rédigé, donc l'app s'affiche en anglais. Votre choix est conservé.",
    noteDevice: 'Enregistré dans ce navigateur uniquement.',
    noteNotSaved: 'Non enregistré dans votre compte. Il est conservé sur cet appareil.',
  },
});
