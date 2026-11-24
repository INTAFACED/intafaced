import { kybRequestResultSchema } from '@intafaced/contracts/kyb-information-requests';
import type { PortalTools } from '../../api-tools';
import { sizedOut } from './application-refusals';
import './requests-refusals';
import { PAY_KYB_REQUESTS_LIST } from '@intafaced/contracts/pay-kyb-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

// Information requests (J-merchant-02 step 4): svc-pay `kyb.requests.list` and `kyb.requests.answer`, parsed with the
// service's own schemas.

export type RequestsView = ProcedureOutput<typeof PAY_KYB_REQUESTS_LIST>;
export type InformationRequest = RequestsView['requests'][number];

/** The business is the page's resolved one; the service checks again that the signed-in person owns it and the request. */
export const requestsApi = ({ mutate, queryRecord }: PortalTools) => ({
  kybRequests: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_KYB_REQUESTS_LIST, { merchantId }, signal),
  kybRequestAnswer: (requestId: string, note: string | null, file: { contentType: string; bytesBase64: string } | null) =>
    mutate('kyb.requests.answer', { requestId, ...(note ? { note } : {}), ...(file ? { file } : {}) }, kybRequestResultSchema).then(
      sizedOut,
    ),
});
