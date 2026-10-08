import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'tests',timeout:45000,workers:1,fullyParallel:false,
 use:{baseURL:'https://127.0.0.1:8443',ignoreHTTPSErrors:true,headless:true,screenshot:'only-on-failure'},
 webServer:{command:'cd .. && go run -tags testtools ./cmd/testserver',url:'https://127.0.0.1:8443/healthz',ignoreHTTPSErrors:true,timeout:120000,reuseExistingServer:!process.env.CI},
});
