import { defineCopy } from './i18n';

/** Plain-English sentences for the password rules and every refusal of the reset and change-password procedures. */
const messages = {
  hint: 'At least 12 characters, up to 72 bytes. Ordinary letters and digits count one each; accented letters and emoji count more.',
  tooShort: 'Use at least 12 characters.',
  tooLong: 'That password is too long. The limit is 72 bytes; accented letters and emoji count as more than one.',
  repeated: 'A password cannot be one character repeated.',
  mismatch: 'The two new passwords do not match.',
  resetOff: 'Password reset is not switched on. Nothing was sent. Contact Support and a person will help you back in.',
  notConnected: 'The sign-in service is not connected right now. Nothing was changed.',
  badCode: 'That code is not valid or has run out. Ask for a new code.',
  policy: 'That password does not meet the rules. Use at least 12 characters, up to 72 bytes, and not one character repeated.',
  unchanged: 'Choose a new password that is different from your current one.',
  wrongCurrent: 'Your current password is not right. Nothing was changed.',
  rateLimited: 'Too many attempts. Wait a few minutes, then try again.',
  secondStep:
    'Your account uses a second sign-in step. Sign out, sign in again with your authenticator code, recovery code or passkey, then change your password. An API key or sub-account cannot change it.',
  inviteNeeded: 'This account needs an invitation before it can set up its second sign-in step. Contact Support.',
  inactive: 'This account is not active, so its password cannot be changed. Contact Support.',
  securityLocked:
    'Your security lock is on, so the password cannot be changed. Ask to unlock in Security; the lock ends after the waiting time.',
  signedOut: 'You were signed out. Sign in again, then try once more.',
  invalidInput: 'Check what you entered and try again.',
  unconfirmed: 'Your password may or may not have changed. Try the new one first.',
  requestUnconfirmed: 'We could not confirm the request went through. If no email arrives in a few minutes, ask again.',
  unreachable: 'We could not reach the sign-in service. Nothing was changed. Try again in a moment.',
  other: 'The request was refused. Try again, or contact Support if it keeps happening.',
} as const;

export const passwordCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('shared.password', messages, {
  es: {
    hint: 'Al menos 12 caracteres y hasta 72 bytes. Las letras y los dígitos normales cuentan uno; las letras con tilde y los emoji cuentan más.',
    tooShort: 'Usa al menos 12 caracteres.',
    tooLong: 'La contraseña es demasiado larga. El límite es de 72 bytes; las letras con tilde y los emoji cuentan más de uno.',
    repeated: 'Una contraseña no puede ser un solo carácter repetido.',
    mismatch: 'Las dos contraseñas nuevas no coinciden.',
    resetOff:
      'La recuperación de contraseña no está activada. No se envió nada. Contacta con soporte y una persona te ayudará a volver a entrar.',
    notConnected: 'El servicio de inicio de sesión no está conectado ahora. No se cambió nada.',
    badCode: 'Ese código no es válido o ha caducado. Pide un código nuevo.',
    policy: 'Esa contraseña no cumple las reglas. Usa al menos 12 caracteres, hasta 72 bytes, y no un solo carácter repetido.',
    unchanged: 'Elige una contraseña nueva distinta de la actual.',
    wrongCurrent: 'Tu contraseña actual no es correcta. No se cambió nada.',
    rateLimited: 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
    secondStep:
      'Tu cuenta usa un segundo paso de inicio de sesión. Cierra sesión, vuelve a entrar con tu código del autenticador, un código de recuperación o una clave de acceso, y cambia la contraseña. Una clave de API o una subcuenta no puede cambiarla.',
    inviteNeeded: 'Esta cuenta necesita una invitación para configurar su segundo paso de inicio de sesión. Contacta con soporte.',
    inactive: 'Esta cuenta no está activa, así que no se puede cambiar su contraseña. Contacta con soporte.',
    securityLocked:
      'Tu bloqueo de seguridad está activo, así que no se puede cambiar la contraseña. Pide el desbloqueo en Seguridad; el bloqueo termina tras el tiempo de espera.',
    signedOut: 'Se cerró tu sesión. Vuelve a iniciar sesión y prueba otra vez.',
    invalidInput: 'Revisa lo que has escrito y vuelve a intentarlo.',
    unconfirmed: 'Es posible que tu contraseña haya cambiado o no. Prueba primero con la nueva.',
    requestUnconfirmed: 'No pudimos confirmar que la solicitud se enviara. Si no llega ningún correo en unos minutos, vuelve a pedirlo.',
    unreachable: 'No pudimos contactar con el servicio de inicio de sesión. No se cambió nada. Inténtalo de nuevo en un momento.',
    other: 'La solicitud fue rechazada. Inténtalo de nuevo o contacta con soporte si sigue ocurriendo.',
  },
  fr: {
    hint: 'Au moins 12 caractères, jusqu’à 72 octets. Les lettres et chiffres ordinaires comptent pour un ; les lettres accentuées et les emoji comptent davantage.',
    tooShort: 'Utilisez au moins 12 caractères.',
    tooLong: 'Ce mot de passe est trop long. La limite est de 72 octets ; les lettres accentuées et les emoji comptent pour plus d’un.',
    repeated: 'Un mot de passe ne peut pas être un seul caractère répété.',
    mismatch: 'Les deux nouveaux mots de passe ne correspondent pas.',
    resetOff:
      'La réinitialisation du mot de passe n’est pas activée. Rien n’a été envoyé. Contactez l’assistance et une personne vous aidera à vous reconnecter.',
    notConnected: 'Le service de connexion n’est pas relié pour le moment. Rien n’a été modifié.',
    badCode: 'Ce code n’est pas valide ou a expiré. Demandez-en un nouveau.',
    policy:
      'Ce mot de passe ne respecte pas les règles. Utilisez au moins 12 caractères, jusqu’à 72 octets, et pas un seul caractère répété.',
    unchanged: 'Choisissez un nouveau mot de passe différent de l’actuel.',
    wrongCurrent: 'Votre mot de passe actuel n’est pas correct. Rien n’a été modifié.',
    rateLimited: 'Trop de tentatives. Attendez quelques minutes, puis réessayez.',
    secondStep:
      'Votre compte utilise une seconde étape de connexion. Déconnectez-vous, reconnectez-vous avec votre code d’authentification, un code de récupération ou une clé d’accès, puis changez le mot de passe. Une clé API ou un sous-compte ne peut pas le changer.',
    inviteNeeded: 'Ce compte a besoin d’une invitation pour configurer sa seconde étape de connexion. Contactez l’assistance.',
    inactive: 'Ce compte n’est pas actif, son mot de passe ne peut donc pas être changé. Contactez l’assistance.',
    securityLocked:
      'Votre verrou de sécurité est actif, le mot de passe ne peut donc pas être changé. Demandez le déverrouillage dans Sécurité ; le verrou prend fin après le délai d’attente.',
    signedOut: 'Vous avez été déconnecté. Reconnectez-vous, puis réessayez.',
    invalidInput: 'Vérifiez ce que vous avez saisi et réessayez.',
    unconfirmed: 'Votre mot de passe a peut-être changé, ou non. Essayez d’abord le nouveau.',
    requestUnconfirmed:
      'Nous n’avons pas pu confirmer que la demande est partie. Si aucun e-mail n’arrive d’ici quelques minutes, redemandez-le.',
    unreachable: 'Nous n’avons pas pu joindre le service de connexion. Rien n’a été modifié. Réessayez dans un instant.',
    other: 'La demande a été refusée. Réessayez, ou contactez l’assistance si cela continue.',
  },
});
