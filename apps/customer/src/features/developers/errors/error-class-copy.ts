import type { ErrorCategory, ErrorSeverity } from '@intafaced/contracts/trade-errors';
import { defineCopy } from '../../../shared/i18n';

// The names of an error's severity and category, the same in every catalogue (J-cex-spot-15 #2). The values come from
// `@intafaced/contracts/trade-errors` (ERROR_SEVERITIES, ERROR_CATEGORIES); each catalogue entry names one of each.
export const errorClassCopy = defineCopy(
  'developers-error-class',
  {
    colSeverity: 'Severity',
    colCategory: 'Category',
    severity_error: 'Error: change the request',
    severity_temporary: 'Temporary: the same request may succeed later',
    severity_uncertain: 'Uncertain: read the state before sending again',
    category_request: 'Request',
    category_authentication: 'Authentication',
    category_signature: 'Signature',
    category_permission: 'Permission',
    category_account: 'Account',
    category_platform: 'Platform',
  },
  {
    es: {
      colSeverity: 'Gravedad',
      colCategory: 'Categoría',
      severity_error: 'Error: cambia la solicitud',
      severity_temporary: 'Temporal: la misma solicitud puede funcionar más tarde',
      severity_uncertain: 'Incierto: consulta el estado antes de volver a enviar',
      category_request: 'Solicitud',
      category_authentication: 'Autenticación',
      category_signature: 'Firma',
      category_permission: 'Permiso',
      category_account: 'Cuenta',
      category_platform: 'Plataforma',
    },
    fr: {
      colSeverity: 'Gravité',
      colCategory: 'Catégorie',
      severity_error: 'Erreur : modifiez la requête',
      severity_temporary: 'Temporaire : la même requête peut réussir plus tard',
      severity_uncertain: 'Incertain : lisez l’état avant de renvoyer',
      category_request: 'Requête',
      category_authentication: 'Authentification',
      category_signature: 'Signature',
      category_permission: 'Autorisation',
      category_account: 'Compte',
      category_platform: 'Plateforme',
    },
  },
);

export const severityKey = (severity: ErrorSeverity) => `severity_${severity}` as const;
export const categoryKey = (category: ErrorCategory) => `category_${category}` as const;
