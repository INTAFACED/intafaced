import { defineCopy } from '../../shared/i18n';

// Refusal sentences and the password hint live in shared/password-copy.ts.
const messages = {
  title: 'Password',
  body: 'Change the password you sign in with. You stay signed in here; every other device is signed out.',
  currentField: 'Current password',
  newField: 'New password',
  confirmField: 'Repeat the new password',
  submit: 'Change password',
  sending: 'Changing…',
  currentMissing: 'Enter your current password.',
  changed: 'Your password was changed. Every other device was signed out. This device stays signed in.',
  again: 'Change it again',
} as const;

export const changePasswordCopy = defineCopy('account.change-password', messages, {
  es: {
    title: 'Contraseña',
    body: 'Cambia la contraseña con la que inicias sesión. Aquí sigues conectado; se cierra la sesión en todos los demás dispositivos.',
    currentField: 'Contraseña actual',
    newField: 'Contraseña nueva',
    confirmField: 'Repite la contraseña nueva',
    submit: 'Cambiar contraseña',
    sending: 'Cambiando…',
    currentMissing: 'Escribe tu contraseña actual.',
    changed: 'Tu contraseña ha cambiado. Se cerró la sesión en todos los demás dispositivos. Este dispositivo sigue conectado.',
    again: 'Cambiarla de nuevo',
  },
  fr: {
    title: 'Mot de passe',
    body: 'Changez le mot de passe avec lequel vous vous connectez. Vous restez connecté ici ; tous les autres appareils sont déconnectés.',
    currentField: 'Mot de passe actuel',
    newField: 'Nouveau mot de passe',
    confirmField: 'Répétez le nouveau mot de passe',
    submit: 'Changer le mot de passe',
    sending: 'Changement…',
    currentMissing: 'Saisissez votre mot de passe actuel.',
    changed: 'Votre mot de passe a été changé. Tous les autres appareils ont été déconnectés. Cet appareil reste connecté.',
    again: 'Le changer à nouveau',
  },
});
