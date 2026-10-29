import type { ContractPart } from '../mock-contract-kit';
import { accountContract } from './account/contract-cases';

const write = 'a write: the stand-in answers it, and the Playwright run exercises it';
export const settingsContract: ContractPart = {
  cases: [
    ...accountContract.cases,
    { method: 'kybCurrent', run: (p) => p.kybCurrent() },
    { method: 'activation', run: (p) => p.activation() },
    { method: 'kybHistory', run: (p) => p.kybHistory(undefined) },
    { method: 'teamList', run: (p) => p.teamList(undefined, '') },
    { method: 'teamHistory', run: (p) => p.teamHistory(undefined) },
    { method: 'myInvitations', run: (p) => p.myInvitations() },
    { method: 'invite', run: (p) => p.invite({ email: 'New.Person@Test.Invalid', role: 'viewer', label: 'TEST new person' }) },
    { method: 'invite', run: (p) => p.invite({ userId: 'TEST-user-new', role: 'viewer' }) },
    { method: 'exportsList', run: (p) => p.exportsList(undefined, '', '') },
    { method: 'exportDownload', run: (p) => p.exportDownload('f1000000-0000-4000-8000-000000000001') },
    { method: 'kybEntityTypes', run: (p) => p.kybEntityTypes() },
    { method: 'kybApplication', run: (p) => p.kybApplication('11111111-1111-4111-8111-111111111111') },
    { method: 'kybDocuments', run: (p) => p.kybDocuments('ab000001-0000-4000-8000-000000000001') },
    { method: 'kybRequests', run: (p) => p.kybRequests('11111111-1111-4111-8111-111111111111') },
    { method: 'merchantCategory', run: (p) => p.merchantCategory('11111111-1111-4111-8111-111111111111') },
  ],
  notMocked: {
    ...accountContract.notMocked,
    createMerchant: write,
    submitKyb: write,
    setPayoutDestination: write,
    changeRole: write,
    removeMember: write,
    acceptInvite: write,
    declineInvite: write,
    createExport: write,
    kybApplicationStart: write,
    kybApplicationChangeType: write,
    kybApplicationSave: write,
    kybApplicationRestart: write,
    kybApplicationSubmit: write,
    kybDocumentUpload: write,
    kybRequestAnswer: write,
    merchantCategoryChoose: write,
  },
};
