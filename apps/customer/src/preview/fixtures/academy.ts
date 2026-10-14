import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the Academy Preview. Invented courses, hosts and certificates; never mixed with real data.
 * Counts are whole numbers; nothing here is money. See ../README.md.
 */

export type CourseLevel = 'Beginner' | 'Intermediate' | 'Advanced';
export type CourseTopic = 'Basics' | 'Trading' | 'Risk' | 'Money';
export type LobbyState = 'live' | 'upcoming';
export type CertStatus = 'earned' | 'in-progress' | 'locked';

export interface AcademyCourse {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly level: CourseLevel;
  readonly topic: CourseTopic;
  readonly lessons: number;
  readonly lessonsDone: number;
  readonly minutes: number;
}
export interface AcademyLobby {
  readonly id: string;
  readonly title: string;
  readonly host: string;
  readonly hostRole: string;
  readonly topic: CourseTopic;
  readonly state: LobbyState;
  /** Relative, so no time zone is involved. */
  readonly timing: string;
  readonly seats: number;
  readonly taken: number;
  readonly minutes: number;
}
export interface AcademyCert {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly status: CertStatus;
  readonly requirements: readonly { readonly label: string; readonly done: boolean }[];
  readonly unlocks: string;
}
export interface AcademyFixtureRows {
  readonly continueCourseId: string;
  readonly topics: readonly CourseTopic[];
  readonly courses: readonly AcademyCourse[];
  readonly lobbies: readonly AcademyLobby[];
  readonly certs: readonly AcademyCert[];
}

export const academyFixture = definePreviewFixture<AcademyFixtureRows>(
  'academy',
  'Academy: sample courses, live lobbies and certificates.',
  {
    continueCourseId: 'order-book',
    topics: ['Basics', 'Trading', 'Risk', 'Money'],
    courses: [
      {
        id: 'first-order',
        title: 'Start here: how an order works',
        summary: 'Market and limit orders, fills and fees, in plain words.',
        level: 'Beginner',
        topic: 'Basics',
        lessons: 8,
        lessonsDone: 8,
        minutes: 96,
      },
      {
        id: 'wallet-safety',
        title: 'Keep your keys and logins safe',
        summary: 'Passkeys, backups and the scams that target new traders.',
        level: 'Beginner',
        topic: 'Basics',
        lessons: 6,
        lessonsDone: 6,
        minutes: 54,
      },
      {
        id: 'order-book',
        title: 'Reading an order book',
        summary: 'Depth, spread and why prices move when you trade.',
        level: 'Beginner',
        topic: 'Trading',
        lessons: 7,
        lessonsDone: 3,
        minutes: 84,
      },
      {
        id: 'position-size',
        title: 'Sizing a position',
        summary: 'How much to risk on one trade, and how to stop out.',
        level: 'Intermediate',
        topic: 'Risk',
        lessons: 9,
        lessonsDone: 0,
        minutes: 110,
      },
      {
        id: 'p2p-safely',
        title: 'Trading with people safely',
        summary: 'Escrow, payment proof and what to do when a trade stalls.',
        level: 'Intermediate',
        topic: 'Money',
        lessons: 6,
        lessonsDone: 0,
        minutes: 60,
      },
      {
        id: 'derivatives',
        title: 'Futures and options, step by step',
        summary: 'Leverage, margin and expiry, with worked examples.',
        level: 'Advanced',
        topic: 'Trading',
        lessons: 12,
        lessonsDone: 0,
        minutes: 180,
      },
    ],
    lobbies: [
      {
        id: 'l1',
        title: 'Weekly market walkthrough',
        host: 'Ada N.',
        hostRole: 'Ambassador',
        topic: 'Trading',
        state: 'live',
        timing: 'Live now',
        seats: 24,
        taken: 17,
        minutes: 45,
      },
      {
        id: 'l2',
        title: 'Ask a risk reviewer',
        host: 'Mateo R.',
        hostRole: 'Mentor',
        topic: 'Risk',
        state: 'upcoming',
        timing: 'Starts in 2 hours',
        seats: 12,
        taken: 8,
        minutes: 30,
      },
      {
        id: 'l3',
        title: 'First trade, live',
        host: 'Yuki T.',
        hostRole: 'Ambassador',
        topic: 'Basics',
        state: 'upcoming',
        timing: 'Starts tomorrow',
        seats: 24,
        taken: 11,
        minutes: 60,
      },
      {
        id: 'l4',
        title: 'P2P tips from a top merchant',
        host: 'Zainab O.',
        hostRole: 'Mentor',
        topic: 'Money',
        state: 'upcoming',
        timing: 'Starts in 3 days',
        seats: 16,
        taken: 4,
        minutes: 45,
      },
    ],
    certs: [
      {
        id: 'c-basics',
        title: 'Trading basics certificate',
        summary: 'Shows you know how orders, fees and safety work.',
        status: 'earned',
        requirements: [
          { label: 'Finish “Start here: how an order works”', done: true },
          { label: 'Finish “Keep your keys and logins safe”', done: true },
          { label: 'Pass the 20-question check', done: true },
        ],
        unlocks: 'Shown on your profile',
      },
      {
        id: 'c-risk',
        title: 'Risk basics certificate',
        summary: 'Shows you can size a position and set a stop.',
        status: 'in-progress',
        requirements: [
          { label: 'Finish “Reading an order book”', done: false },
          { label: 'Finish “Sizing a position”', done: false },
          { label: 'Pass the 20-question check', done: false },
        ],
        unlocks: 'Counts toward a lobby host role',
      },
      {
        id: 'c-host',
        title: 'Lobby host certificate',
        summary: 'Lets you host a live lobby once the Risk certificate is done.',
        status: 'locked',
        requirements: [
          { label: 'Earn the Risk basics certificate', done: false },
          { label: 'Co-host two lobbies with a mentor', done: false },
        ],
        unlocks: 'Lobby host rights',
      },
    ],
  },
);
