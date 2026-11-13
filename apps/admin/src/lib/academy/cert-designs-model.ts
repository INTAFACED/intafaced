import type {
  AcademyCertDesign,
  AcademyCertDesigns,
  AcademyCertExport,
  AcademyCertExports,
  AcademyIssuedCerts,
} from '@intafaced/contracts/academy-cert-designs';
import type { Part } from '@/lib/desk/part';

/**
 * Certificate designs and the issued-certificates list on the founder console (AC-certificates-03). Pure, so the server
 * loader, the route and the browser components share it.
 */
export type { AcademyCertDesign, AcademyCertExport, AcademyIssuedCerts };

export interface CertDesignsView {
  readonly designs: Part<AcademyCertDesigns>;
  readonly asOf: string;
}

export interface IssuedCertsView {
  readonly issued: Part<AcademyIssuedCerts>;
  /** The stored exports, newest first. */
  readonly exports: Part<AcademyCertExports>;
  readonly certificate: string | null;
  readonly asOf: string;
}

export type CertDeskReply =
  | {
      readonly ok: true;
      readonly what: string;
      /** Set when an active design with issued certificates was edited: those keep printing their earlier revision. */
      readonly warning: string | null;
    }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
