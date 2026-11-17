import 'server-only';
import {
  bankCardAuthorizationDetailSchema,
  bankCardholderDetailSchema,
  bankCardholdersSchema,
  bankCardProgrammeDeskSchema,
  bankCardProgrammeFiguresSchema,
  type BankCardProgrammeFigures,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { refusalWords, type Authorization, type Cardholder, type CardholderDetail, type Desk } from './model';

const labels = {
  service: 'svc-bank',
  forbiddenMessage: 'svc-bank did not accept this founder session for the card programme. Reading needs admin:read.',
  refusedMessage: refusalWords,
} as const;

export async function readDesk(ctx: FounderCallContext): Promise<{ asOf: string; desk: Part<Desk> }> {
  const result = await founderCall(ctx, 'bank', 'ops.cardProgrammeDesk', 'GET', undefined, parseWith(bankCardProgrammeDeskSchema));
  return { asOf: new Date().toISOString(), desk: partFrom(result, (d) => d, labels) };
}

export async function searchCardholders(ctx: FounderCallContext, query: string): Promise<Part<Cardholder[]>> {
  const result = await founderCall(ctx, 'bank', 'ops.cardProgrammeCardholders', 'GET', { query }, parseWith(bankCardholdersSchema));
  return partFrom(result, (d) => d, labels);
}

export async function readAuthorization(ctx: FounderCallContext, id: string): Promise<{ asOf: string; part: Part<Authorization> }> {
  const result = await founderCall(
    ctx,
    'bank',
    'ops.cardProgrammeAuthorization',
    'GET',
    { id },
    parseWith(bankCardAuthorizationDetailSchema),
  );
  return { asOf: new Date().toISOString(), part: partFrom(result, (d) => d, labels) };
}

export async function readCardholder(
  ctx: FounderCallContext,
  cardholderId: string,
): Promise<{ asOf: string; part: Part<CardholderDetail> }> {
  const result = await founderCall(
    ctx,
    'bank',
    'ops.cardProgrammeCardholder',
    'GET',
    { cardholderId },
    parseWith(bankCardholderDetailSchema),
  );
  return { asOf: new Date().toISOString(), part: partFrom(result, (d) => d, labels) };
}

/** The programme's own figures as the card partner reports them, from the funding read (J-bank-26 #5). */
export type ProgrammeFigures = BankCardProgrammeFigures;
export async function readProgrammeFigures(ctx: FounderCallContext): Promise<Part<ProgrammeFigures>> {
  const result = await founderCall(ctx, 'bank', 'ops.cardProgrammeFunding', 'GET', undefined, parseWith(bankCardProgrammeFiguresSchema));
  return partFrom(result, (d) => d, labels);
}
