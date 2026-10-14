import {defineConfig} from '@playwright/test';
const port='8743',origin='https://127.0.0.1:'+port;
export default defineConfig({testDir:'lan-tests',outputDir:'../artifacts/lan-playwright',timeout:60000,workers:1,fullyParallel:false,use:{baseURL:origin,ignoreHTTPSErrors:true,headless:true,screenshot:'only-on-failure'},webServer:{env:{WEBZOOM_TEST_PORT:port,WEBZOOM_TEST_LAN:'true',WEBZOOM_TEST_TOKEN_SECONDS:'3600'},command:'cd .. && go run -tags testtools ./cmd/testserver',url:origin+'/healthz',ignoreHTTPSErrors:true,timeout:120000,reuseExistingServer:false}});
