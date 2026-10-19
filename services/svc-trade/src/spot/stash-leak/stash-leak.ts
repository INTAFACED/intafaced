import Fastify from 'fastify';
export async function leak(attach: (app: any) => void, body: Record<string, unknown>) {
  const app = Fastify();
  attach(app);
  app.post('/o', async (_req, reply) => reply.code(401).send({ error: 'unauth' }));
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/o', payload: body });
  await app.close();
  return res.statusCode;
}
