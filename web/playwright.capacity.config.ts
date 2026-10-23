import {defineConfig} from '@playwright/test';
// Fixed loopback-only fixture; deployment URLs are not accepted as input.
const origin='https://127.0.0.1:19443';
export default defineConfig({
 testDir:'relay-capacity-tests',testMatch:'capacity.spec.ts',timeout:600000,workers:1,fullyParallel:false,maxFailures:1,
 outputDir:'test-results/relay-capacity',reporter:[['line'],['json',{outputFile:'test-results/relay-capacity/results.json'}]],
 use:{baseURL:origin,ignoreHTTPSErrors:true,headless:true,screenshot:'only-on-failure'},
 webServer:{env:{WEBZOOM_TEST_PORT:'19443',WEBZOOM_TEST_TOKEN_SECONDS:'86400',BROWSER_RELAY_ENABLED:'true'},command:'cd .. && go run -tags testtools ./cmd/testserver',url:`${origin}/healthz`,ignoreHTTPSErrors:true,timeout:120000,reuseExistingServer:false},
});
