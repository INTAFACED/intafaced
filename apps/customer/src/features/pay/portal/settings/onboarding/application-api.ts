import type { z } from 'zod';
import { kybApplicationViewSchema, type KybApplicationSection, type KybApplicationSectionData } from '@intafaced/contracts/kyb-application';
import { kybDocumentChecklistViewSchema, kybDocumentsUploadResultSchema } from '@intafaced/contracts/kyb-documents';
import { kybEntityTypesViewSchema } from '@intafaced/contracts/kyb-entity-types';
import type { PortalTools } from '../../api-tools';
import './application-refusals';

// The business application (J-merchant-02 steps 2 and 3): svc-pay `kyb.entityTypes.*`, `kyb.application.*` and
// `kyb.documents.*`, parsed with the service's own schemas.

export type Application = z.infer<typeof kybApplicationViewSchema>;
export type ApplicationSection = KybApplicationSection;
export type Answers = KybApplicationSectionData;
export type EntityType = z.infer<typeof kybEntityTypesViewSchema>['entityTypes'][number];
export type Checklist = z.infer<typeof kybDocumentChecklistViewSchema>;
export type DocumentRow = Checklist['rows'][number];

/** The business is the page's resolved one; the service checks again that the signed-in person owns it and the application. */
export const applicationApi = ({ query, mutate }: PortalTools) => ({
  kybEntityTypes: (signal?: AbortSignal) => query('kyb.entityTypes.read', undefined, kybEntityTypesViewSchema, signal),
  kybApplication: (merchantId: string, signal?: AbortSignal) =>
    query('kyb.application.current', { merchantId }, kybApplicationViewSchema.nullable(), signal),
  kybApplicationStart: (merchantId: string, entityType: string, country: string) =>
    mutate('kyb.application.start', { merchantId, entityType, country }, kybApplicationViewSchema),
  kybApplicationChangeType: (applicationId: string, entityType: string, country: string) =>
    mutate('kyb.application.changeType', { applicationId, entityType, country }, kybApplicationViewSchema),
  kybApplicationSave: (applicationId: string, section: ApplicationSection, expectedVersion: number, complete: boolean, data: Answers) =>
    mutate('kyb.application.saveSection', { applicationId, section, expectedVersion, complete, data }, kybApplicationViewSchema),
  kybApplicationRestart: (applicationId: string) =>
    mutate('kyb.application.restart', { applicationId, confirm: true }, kybApplicationViewSchema),
  kybApplicationSubmit: (applicationId: string) => mutate('kyb.application.submit', { applicationId }, kybApplicationViewSchema),
  kybDocuments: (applicationId: string, signal?: AbortSignal) =>
    query('kyb.documents.checklist', { applicationId }, kybDocumentChecklistViewSchema, signal),
  kybDocumentUpload: (applicationId: string, key: string, contentType: string, bytesBase64: string) =>
    mutate('kyb.documents.upload', { applicationId, key, contentType, bytesBase64 }, kybDocumentsUploadResultSchema),
});
