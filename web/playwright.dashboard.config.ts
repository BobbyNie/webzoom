import {defineConfig} from '@playwright/test';

// UI contracts only. HTTP is not used to validate screen capture or media transport.
export default defineConfig({
  testDir: 'tests', testMatch: 'my-meetings.spec.ts', timeout: 30000, workers: 1,
  use: {baseURL: 'http://127.0.0.1:4173', screenshot: 'only-on-failure'},
  webServer: {command: 'npm run dev -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: false},
});
