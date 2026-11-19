import { lazy } from 'react';

// A guest's support links (SP-tickets-01) load only when one is opened.
export const GuestVerify = lazy(() => import('./SupportGuest').then((m) => ({ default: m.GuestVerify })));
export const GuestRequest = lazy(() => import('./SupportGuest').then((m) => ({ default: m.GuestRequest })));
// Live chat as a guest (SP-chat-01).
export const GuestChat = lazy(() => import('./SupportChat').then((m) => ({ default: m.SupportChatRoom })));
export const GuestNewRequest = lazy(() => import('./SupportGuest').then((m) => ({ default: m.GuestNewRequest })));
