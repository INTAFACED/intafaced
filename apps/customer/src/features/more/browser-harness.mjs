// Browser test entry only. No financial fixtures are served by this harness.
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, build } from 'vite';
const require = createRequire(import.meta.url),
  feature = dirname(fileURLToPath(import.meta.url)),
  app = resolve(feature, '../../..'),
  workspace = resolve(app, '../..'),
  root = await realpath(await mkdtemp(resolve(tmpdir(), 'intafaced-more-test-')));
await writeFile(
  resolve(root, 'index.html'),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
);
await writeFile(
  resolve(root, 'main.tsx'),
  `import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import {SessionProvider,useSession} from '/@fs${feature}/../session/session.tsx';import {MoreRoutes} from '/@fs${feature}/MoreRoutes.tsx';import '/@fs${require.resolve('@intafaced/ui/theme/tokens.css')}';import '/@fs${require.resolve('@intafaced/ui/theme/customer-legacy.css')}';import '/@fs${feature}/../../shared/styles.css';function TestSession(){const {commit,userId}=useSession();useEffect(()=>{document.documentElement.dataset.testActor=userId??'';},[userId]);useEffect(()=>{commit({accessToken:'browser-test-token',refreshToken:'browser-test-refresh',userId:'00000000-0000-4000-8000-000000000001',expiresAt:new Date(Date.now()+3600000).toISOString()});},[]);return <MoreRoutes path={location.pathname+location.search}/>;}createRoot(document.getElementById('root')!).render(<SessionProvider><TestSession/></SessionProvider>);`,
);
const config = {
  configFile: false,
  root,
  publicDir: resolve(app, 'public'),
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      { find: 'react/jsx-dev-runtime', replacement: require.resolve('react/jsx-dev-runtime') },
      { find: 'react/jsx-runtime', replacement: require.resolve('react/jsx-runtime') },
      { find: 'react-dom/client', replacement: require.resolve('react-dom/client') },
      { find: /^react$/, replacement: require.resolve('react') },
    ],
  },
  server: { host: '127.0.0.1', port: 3292, strictPort: true, fs: { allow: [workspace, root] } },
  optimizeDeps: { include: [] },
};
if (process.argv.includes('--build')) {
  await build({ ...config, build: { outDir: '/tmp/intafaced-more-production-build', emptyOutDir: true } });
  process.exit(0);
}
const server = await createServer(config);
await server.listen();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
