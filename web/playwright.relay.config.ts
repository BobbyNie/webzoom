import {defineConfig} from '@playwright/test';
const port='18443',origin=`https://127.0.0.1:${port}`;
export default defineConfig({
 testDir:'relay-tests',timeout:90000,workers:1,fullyParallel:false,
 outputDir:'test-results/browser-relay',
 use:{baseURL:origin,ignoreHTTPSErrors:true,headless:true,screenshot:'only-on-failure'},
 webServer:{env:{ADMIN_USER_IDS:'TestAdmin',WEBZOOM_TEST_PORT:port,WEBZOOM_TEST_TOKEN_SECONDS:'3600',BROWSER_RELAY_ENABLED:'true'},command:'cd .. && go run -tags testtools ./cmd/testserver',url:`${origin}/healthz`,ignoreHTTPSErrors:true,timeout:120000,reuseExistingServer:false},
});
