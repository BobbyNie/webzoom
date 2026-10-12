import {defineConfig} from '@playwright/test';
const origin=`https://127.0.0.1:${process.env.WEBZOOM_TEST_PORT??'8443'}`;
export default defineConfig({
 testDir:'tests',timeout:45000,workers:1,fullyParallel:false,
 use:{baseURL:origin,ignoreHTTPSErrors:true,headless:true,screenshot:'only-on-failure'},
 webServer:{env:{WEBZOOM_TEST_TOKEN_SECONDS:process.env.WEBZOOM_TEST_TOKEN_SECONDS??'12'},command:'cd .. && go run -tags testtools ./cmd/testserver',url:`${origin}/healthz`,ignoreHTTPSErrors:true,timeout:120000,reuseExistingServer:!process.env.CI},
});
