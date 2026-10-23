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
  }),
});
