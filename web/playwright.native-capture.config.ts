import {defineConfig} from '@playwright/test';
// A separate opt-in, loopback-only run. Opens only fresh test browser profiles.
const origin='https://127.0.0.1:20443';
export default defineConfig({
 testDir:'native-capture-tests',testMatch:'native-capture.spec.ts',timeout:300000,workers:1,fullyParallel:false,maxFailures:1,
 outputDir:'test-results/native-capture',reporter:[['line'],['json',{outputFile:'test-results/native-capture/results.json'}]],
 use:{baseURL:origin,ignoreHTTPSErrors:true},
 webServer:{env:{WEBZOOM_TEST_PORT:'20443',WEBZOOM_TEST_TOKEN_SECONDS:'3600',BROWSER_RELAY_ENABLED:'true'},command:'cd .. && go run -tags testtools ./cmd/testserver',url:`${origin}/healthz`,ignoreHTTPSErrors:true,timeout:120000,reuseExistingServer:false},
});
