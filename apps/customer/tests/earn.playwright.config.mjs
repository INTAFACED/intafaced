import { defineConfig } from '@playwright/test';
const compiled=Boolean(process.env.REVIEW_CUSTOMER_ARTIFACT);
export default defineConfig({
 testDir:'.',testMatch:'earn.pw.mjs',workers:1,fullyParallel:false,reporter:'list',
 outputDir:compiled?'/tmp/intafaced-earn-compiled-browser-results':'/tmp/intafaced-earn-browser-results',
 use:{baseURL:'http://127.0.0.1:3228',headless:true,timezoneId:'UTC'},
 webServer:{
 command:compiled?'pnpm --filter @intafaced/customer exec vite preview --host 127.0.0.1 --port 3228 --strictPort --outDir "$REVIEW_CUSTOMER_ARTIFACT"':'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3228',
 url:'http://127.0.0.1:3228',cwd:new URL('../../..',import.meta.url).pathname,reuseExistingServer:false,timeout:30000
 }
});
