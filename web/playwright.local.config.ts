import {defineConfig} from '@playwright/test';

// Opt-in: tests the already-running local Docker stack, not the fixture server.
export default defineConfig({
  testDir: 'local-tests',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'https://webzoom.localhost:8443',
    ignoreHTTPSErrors: true, // Local self-signed certificate only.
    screenshot: 'only-on-failure',
    viewport: {width: 1440, height: 960},
  },
});
