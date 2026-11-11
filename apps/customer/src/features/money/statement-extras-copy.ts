import { defineCopy } from '../../shared/i18n';

const en = {
  lettersTitle: 'Letters and certificates',
  lettersLead: 'An account ownership letter or a balance certificate, for a landlord, an employer or an auditor.',
  letterOwnership: 'Ask for an ownership letter',
  letterBalance: 'Ask for a balance certificate',
  letterAction: 'A bank letter',
  letterAsking: 'Asking the bank…',
  letterRefused: 'The bank refused this letter.',
  taxTitle: 'Tax statements',
  taxLead: 'Statements of your income for a tax year, for your tax return.',
  taxYear: 'Tax year',
  taxAction: 'A tax statement',
  taxLoading: 'Opening tax statements…',
  taxEmpty: 'No tax statement for this year.',
  taxRefused: 'The bank refused to list tax statements.',
  totalsTitle: 'Total of these lines, per coin (money in minus money out; not a balance)',
  totalsNone: 'No lines in these dates.',
  totalLine: '{asset}: {net} ({lines} lines)',
} as const;

const es: Record<keyof typeof en, string> = {
  lettersTitle: 'Cartas y certificados',
  lettersLead: 'Una carta de titularidad de la cuenta o un certificado de saldo, para un arrendador, una empresa o un auditor.',
  letterOwnership: 'Pedir una carta de titularidad',
  letterBalance: 'Pedir un certificado de saldo',
  letterAction: 'Una carta del banco',
  letterAsking: 'Preguntando al banco…',
  letterRefused: 'El banco rechazó esta carta.',
  taxTitle: 'Extractos fiscales',
  taxLead: 'Extractos de tus ingresos de un año fiscal, para tu declaración.',
  taxYear: 'Año fiscal',
  taxAction: 'Un extracto fiscal',
  taxLoading: 'Abriendo los extractos fiscales…',
  taxEmpty: 'No hay extracto fiscal para este año.',
  taxRefused: 'El banco rechazó listar los extractos fiscales.',
  totalsTitle: 'Total de estos movimientos, por moneda (entradas menos salidas; no es un saldo)',
  totalsNone: 'No hay movimientos en estas fechas.',
  totalLine: '{asset}: {net} ({lines} movimientos)',
};

const fr: Record<keyof typeof en, string> = {
  lettersTitle: 'Lettres et attestations',
  lettersLead: 'Une lettre de titularité du compte ou une attestation de solde, pour un bailleur, un employeur ou un auditeur.',
  letterOwnership: 'Demander une lettre de titularité',
  letterBalance: 'Demander une attestation de solde',
  letterAction: 'Une lettre de la banque',
  letterAsking: 'Demande à la banque…',
  letterRefused: 'La banque a refusé cette lettre.',
  taxTitle: 'Relevés fiscaux',
  taxLead: 'Les relevés de vos revenus d’une année fiscale, pour votre déclaration.',
  taxYear: 'Année fiscale',
  taxAction: 'Un relevé fiscal',
  taxLoading: 'Ouverture des relevés fiscaux…',
  taxEmpty: 'Aucun relevé fiscal pour cette année.',
  taxRefused: 'La banque a refusé de lister les relevés fiscaux.',
  totalsTitle: 'Total de ces lignes, par actif (entrées moins sorties ; pas un solde)',
  totalsNone: 'Aucune ligne à ces dates.',
  totalLine: '{asset} : {net} ({lines} lignes)',
};

export const statementExtrasCopy = defineCopy('customer.money.statement-extras', en, { es, fr });
