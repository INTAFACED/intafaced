import { defineCopy } from '../../shared/i18n';

// English source only. Every page here says what exists and what does not; nothing is promised that the product cannot do today.
export const pagesCopy = defineCopy('public-pages', {
  // Partner
  partnerTitle: 'Work with Intafaced',
  partnerLead: 'Partner, integration and referral enquiries are read by a person.',
  partnerFormTitle: 'Send an enquiry',
  partnerFormBody:
    'The enquiry form is on our invitation site. Choose Partner there, tell us about your business and what you want to build with us.',
  partnerOpenForm: 'Open the partner enquiry form',
  partnerNoFormBody:
    'The enquiry form is on our invitation site, and this app has not been given that address. Email us instead and say what you have in mind.',
  partnerEmail: 'Email a partnership enquiry',
  partnerEmailNotSet: 'Support email is not set, so there is no email link on this page.',
  partnerMailSubject: 'Partnership enquiry',
  partnerMailBody: 'About my business:\n\nWhat I would like to do with Intafaced:\n\nWhere we operate:\n',
  partnerIncludeTitle: 'What helps us answer',
  partnerInclude1: 'Who you are and what your business does.',
  partnerInclude2: 'What you want to do with us: connect a product, refer customers, or something else.',
  partnerInclude3: 'Where you operate and who your customers are.',
  partnerBoundary: 'This page does not submit an application. No partner tiers, terms or prices are published, so none are shown.',
  partnerMerchantTitle: 'Taking payments for a business?',
  partnerMerchantBody: 'Merchant accounts are opened from Pay, with business verification, not through a partner enquiry.',
  partnerMerchantOpen: 'Open merchant set-up',
  // Notices
  noticeTitle: 'Notices',
  noticeAccountTitle: 'Notices about your account',
  noticeAccountBody: 'Order fills, verification results and rank changes arrive in your private inbox, not on this page.',
  noticeInbox: 'Open your inbox',
  noticeSignIn: 'Sign in to see your inbox',
  noticeStuckTitle: 'Something not working?',
  noticeStuckBody: 'Search the help centre first. If it does not cover it, write to us.',
  noticeHelp: 'Open the help centre',
  noticeBack: 'Back to notices',
  // App
  appTitle: 'Get the app',
  appNoneTitle: 'There is no store app',
  appNoneBody: 'No App Store or Google Play release has been published. The web app works in your phone browser and uses the same account.',
  appHomeTitle: 'Put it on your home screen',
  appIphone: 'iPhone or iPad: open this site in Safari, tap Share, then Add to Home Screen.',
  appAndroid: 'Android: open this site in Chrome, open the menu, then choose Add to Home screen or Install app.',
  appOpen: 'Open the web app',
  // Campaigns
  campTitle: 'Activities and campaigns',
  campNoneTitle: 'No campaign is running right now',
  campNoneBody:
    'No campaign service is publishing timed activities, so there are no tasks, prizes or leaderboards to show, and none are made up.',
  campTodayTitle: 'What you can take part in today',
  participationInvite: 'Create an invitation link and follow who joined through it.',
  participationAcademy: 'Follow a learning path, join rooms and work towards a certificate.',
  participationToken: 'Stake, vote on proposals and read how the token economy works.',
  participationBlueprint: 'Build a private profile that you choose whether to share.',
  campOpen: 'Open',
  campSignIn: 'Sign in to open',
  campDetailTitle: 'This campaign is not published',
  campDetailBody: 'No campaign with this reference exists.',
  campBack: 'Back to campaigns',
  // About and landing
  insideTitle: 'What is inside today',
  insideIntro: 'Every room below is part of the app now. Some wait on a connected service and say so when you open them.',
  rooms: '{count} rooms',
  roomsOne: '1 room',
  andMore: 'and {count} more',
  openDoor: 'Open {door}',
  reachTitle: 'Talk to us',
});
