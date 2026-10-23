export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'academy',
  env: () => ({
    ...c('svc-academy', PORTS.academy),
    DATABASE_URL: dbUrl('svc_academy', secrets),
    TOKEN_URL: urlOf('token'),
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    ACADEMY_STREAM_PROVIDER: 'none', // no LiveKit / video storage: live classes and video stay unconnected
  }),
});
