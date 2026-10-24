import type { z } from 'zod';
import { kybRequestResultSchema, kybRequestsViewSchema } from '@intafaced/contracts/kyb-information-requests';
import type { PortalTools } from '../../api-tools';
import './requests-refusals';

// Information requests (J-merchant-02 step 4): svc-pay `kyb.requests.list` and `kyb.requests.answer`, parsed with the
// service's own schemas.

export type RequestsView = z.infer<typeof kybRequestsViewSchema>;
export type InformationRequest = RequestsView['requests'][number];

/** The business is the page's resolved one; the service checks again that the signed-in person owns it and the request. */
export const requestsApi = ({ query, mutate }: PortalTools) => ({
  kybRequests: (merchantId: string, signal?: AbortSignal) => query('kyb.requests.list', { merchantId }, kybRequestsViewSchema, signal),
  kybRequestAnswer: (requestId: string, note: string | null, file: { contentType: string; bytesBase64: string } | null) =>
    mutate('kyb.requests.answer', { requestId, ...(note ? { note } : {}), ...(file ? { file } : {}) }, kybRequestResultSchema),
});
