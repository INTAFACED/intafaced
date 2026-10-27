import { VIDEO_STORE_ACCESS_KEY, VIDEO_STORE_BUCKET, VIDEO_STORE_REGION } from '../local-video-store.mjs';

// LOCAL TEST video storage: the stack's own TEST video store (local-video-store.mjs) plays one TEST video behind signed,
// expiring URLs. `LOCAL_STACK_ACADEMY_VIDEO_STORAGE=off` on a start or restart leaves storage blank instead, so the
// "video storage is not configured" refusal can be seen too (J-academy-01 #7).
const videoStorage = ({ secrets, urlOf }) =>
  process.env.LOCAL_STACK_ACADEMY_VIDEO_STORAGE === 'off'
    ? {}
    : {
        ACADEMY_VIDEO_S3_ENDPOINT: urlOf('video-store'),
        ACADEMY_VIDEO_S3_BUCKET: VIDEO_STORE_BUCKET,
        ACADEMY_VIDEO_S3_ACCESS_KEY: VIDEO_STORE_ACCESS_KEY,
        ACADEMY_VIDEO_S3_SECRET_KEY: secrets.academyVideoStore,
        ACADEMY_VIDEO_S3_REGION: VIDEO_STORE_REGION,
        // TEST owner values, not decisions: link lifetime, who may watch, the watch threshold and the save interval.
        ACADEMY_VIDEO_URL_TTL_SECONDS: '300',
        ACADEMY_VIDEO_MIN_TIER: 'none',
        ACADEMY_VIDEO_MIN_STAKE: '0',
        ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS: '4',
        ACADEMY_VIDEO_POSITION_SAVE_SECONDS: '2',
      };

// LOCAL TEST outline limits (TEST owner values, not decisions). `LOCAL_STACK_ACADEMY_OUTLINE_LIMITS=off` on a start or
// restart leaves them blank, so the "limits not set" refusal of an outline save can be seen too (J-academy-11 #3).
const outlineLimits = () =>
  process.env.LOCAL_STACK_ACADEMY_OUTLINE_LIMITS === 'off' ? {} : { ACADEMY_OUTLINE_MAX_SECTIONS: '20', ACADEMY_OUTLINE_MAX_ITEMS: '200' };

// LOCAL TEST lesson import size limit (a TEST owner value): 8 KiB, so the journey's 20 KiB file is over it
// (J-academy-11 #5). `LOCAL_STACK_ACADEMY_IMPORT_LIMIT=off` leaves it blank.
const importLimit = () => (process.env.LOCAL_STACK_ACADEMY_IMPORT_LIMIT === 'off' ? {} : { ACADEMY_LESSON_IMPORT_MAX_BYTES: '8192' });

// LOCAL TEST upload limits (TEST owner values, not decisions): 1 MiB, WebM video, PDF and PNG handouts (J-academy-11 #7).
// `LOCAL_STACK_ACADEMY_UPLOAD_LIMITS=off` leaves them blank, so the "upload limits not set" refusal can be seen too.
const uploadLimits = () =>
  process.env.LOCAL_STACK_ACADEMY_UPLOAD_LIMITS === 'off'
    ? {}
    : {
        ACADEMY_UPLOAD_MAX_BYTES: '1048576',
        ACADEMY_UPLOAD_VIDEO_TYPES: 'video/webm',
        ACADEMY_UPLOAD_HANDOUT_TYPES: 'application/pdf,image/png',
      };

// LOCAL TEST topic list limit (a TEST owner value): 100 (J-academy-11 #8).
const topicsLimit = () => (process.env.LOCAL_STACK_ACADEMY_TOPICS_LIMIT === 'off' ? {} : { ACADEMY_TOPICS_LIST_LIMIT: '100' });

// LOCAL TEST grader lease (a TEST owner value): 15 minutes (J-academy-04 #6).
const graderLease = () => (process.env.LOCAL_STACK_ACADEMY_GRADER_LEASE === 'off' ? {} : { ACADEMY_GRADER_LEASE_SECONDS: '900' });

// LOCAL TEST grade report size (a TEST owner value): 500 learner rows (J-academy-13 #7). `LOCAL_STACK_ACADEMY_REPORT_ROWS=off`
// leaves it blank, so the "report limit not set" refusal can be seen too.
const reportRows = () => (process.env.LOCAL_STACK_ACADEMY_REPORT_ROWS === 'off' ? {} : { ACADEMY_GRADE_REPORT_ROWS: '500' });

// LOCAL TEST certificate issue sweep (a TEST owner value): every 5 seconds, so a one-minute delayed certificate is issued
// within the journey (J-academy-05 #1). `LOCAL_STACK_ACADEMY_CERT_SWEEP=off` leaves it blank.
const certSweep = () => (process.env.LOCAL_STACK_ACADEMY_CERT_SWEEP === 'off' ? {} : { ACADEMY_CERT_ISSUE_SWEEP_SECONDS: '5' });

// LOCAL TEST public certificate check rate (TEST owner values): 10 checks per address per 30 seconds, so the journey
// sees a valid check and then the typed rate refusal (J-academy-05 #4). `LOCAL_STACK_ACADEMY_VERIFY_RATE=off` leaves it blank.
const verifyRate = () =>
  process.env.LOCAL_STACK_ACADEMY_VERIFY_RATE === 'off'
    ? {}
    : { ACADEMY_CERT_VERIFY_RATE_MAX: '10', ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS: '30' };

// LOCAL TEST programme size (a TEST owner value): four courses, every published course (J-academy-06 #1).
// `LOCAL_STACK_ACADEMY_PROGRAMME_MAX=off` leaves it blank.
const programmeMax = () => (process.env.LOCAL_STACK_ACADEMY_PROGRAMME_MAX === 'off' ? {} : { ACADEMY_PROGRAMME_MAX_COURSES: '4' });

// LOCAL TEST discussion and course-team message limits (TEST owner values): 4000 characters a post or message, a 256 KiB
// image (J-academy-08 #2, #5). `LOCAL_STACK_ACADEMY_POST_LIMITS=off` leaves all three blank.
const postLimits = () =>
  process.env.LOCAL_STACK_ACADEMY_POST_LIMITS === 'off'
    ? {}
    : { ACADEMY_POST_MAX_CHARS: '4000', ACADEMY_POST_IMAGE_MAX_BYTES: '262144', ACADEMY_MESSAGE_MAX_CHARS: '4000' };

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'academy',
  env: () => ({
    ...c('svc-academy', PORTS.academy),
    DATABASE_URL: dbUrl('svc_academy', secrets),
    TOKEN_URL: urlOf('token'),
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    ACADEMY_STREAM_PROVIDER: 'none', // no LiveKit: live classes stay unconnected
    ACADEMY_PLANNER_TODO_LIMIT: '50', // TEST: the owner sets the real cap; the stack needs one so the planner journey can add
    ...videoStorage({ secrets, urlOf }),
    ...outlineLimits(),
    ...importLimit(),
    ...uploadLimits(),
    ...topicsLimit(),
    ...graderLease(),
    ...reportRows(),
    ...certSweep(),
    ...programmeMax(),
    ...postLimits(),
    ...verifyRate(),
  }),
});
