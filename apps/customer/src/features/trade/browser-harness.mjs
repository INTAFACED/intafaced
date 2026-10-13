// Browser test entry only. No financial fixtures are served by this harness.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
const require = createRequire(import.meta.url),
  feature = dirname(fileURLToPath(import.meta.url)),
  app = resolve(feature, '../../..'),
  workspace = resolve(app, '../..'),
  root = await mkdtemp(resolve(tmpdir(), 'intafaced-trade-test-'));
await writeFile(
  resolve(root, 'index.html'),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
);
await writeFile(
  resolve(root, 'main.tsx'),
  `import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import {SessionProvider,useSession} from '/@fs${feature}/../session/session.tsx';import {useLocation} from '/@fs${feature}/../../app/location.ts';import {App} from '/@fs${feature}/../../app/App.tsx';import {TradeRoutes} from '/@fs${feature}/TradeRoutes.tsx';import {ApplyView,View} from '/@fs${feature}/../account/View.tsx';import '/@fs${feature}/../../shared/tokens.css';import '/@fs${feature}/../../shared/styles.css';import '/@fs${feature}/../account/account.css';const fullApp=new URLSearchParams(location.search).has('fullApp');function TestSession(){const {commit}=useSession(),path=useLocation();useEffect(()=>{commit({accessToken:'browser-test-token',refreshToken:'browser-test-refresh',userId:'00000000-0000-4000-8000-000000000001',expiresAt:new Date(Date.now()+3600000).toISOString()});},[]);return fullApp?<App/>:<><ApplyView/>{path==='/account/view'?<View/>:<TradeRoutes path={path}/>}</>;}createRoot(document.getElementById('root')!).render(<SessionProvider><TestSession/></SessionProvider>);`,
);
const server = await createServer({
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
  server: { host: '127.0.0.1', port: 3291, strictPort: true, fs: { allow: [workspace, root] } },
  optimizeDeps: { include: [] },
});
await server.listen();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
