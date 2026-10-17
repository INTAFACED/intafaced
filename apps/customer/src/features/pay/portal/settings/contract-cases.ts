import type { ContractPart } from '../mock-contract-kit';

const write = 'a write: the stand-in answers it, and the Playwright run exercises it';
export const settingsContract: ContractPart = {
  cases: [
    { method: 'kybCurrent', run: (p) => p.kybCurrent() },
    { method: 'kybHistory', run: (p) => p.kybHistory(undefined) },
    { method: 'teamList', run: (p) => p.teamList(undefined, '') },
    { method: 'teamHistory', run: (p) => p.teamHistory(undefined) },
    { method: 'myInvitations', run: (p) => p.myInvitations() },
    { method: 'exportsList', run: (p) => p.exportsList(undefined, '', '') },
    { method: 'exportDownload', run: (p) => p.exportDownload('f0000001-0000-4000-8000-000000000001') },
  ],
  notMocked: {
    createMerchant: write,
    submitKyb: write,
    setPayoutDestination: write,
    invite: write,
    changeRole: write,
    removeMember: write,
    acceptInvite: write,
    declineInvite: write,
    createExport: write,
  },
};
