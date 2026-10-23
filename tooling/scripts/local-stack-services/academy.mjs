export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'academy',
  env: () => ({
    ...c('svc-academy', PORTS.academy),
    DATABASE_URL: dbUrl('svc_academy', secrets),
    TOKEN_URL: urlOf('token'),
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    ACADEMY_STREAM_PROVIDER: 'none', // no LiveKit / video storage: live classes and video stay unconnected
    ACADEMY_PLANNER_TODO_LIMIT: '50', // TEST: the owner sets the real cap; the stack needs one so the planner journey can add
  }),
});
