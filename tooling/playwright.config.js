import { defineConfig } from '@playwright/test';

// Serves the repo root (one level up from /tooling) as a static site, exactly
// as it is deployed, and runs the headless smoke against it.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    baseURL: 'http://localhost:8080',
  },
  webServer: {
    command: 'python3 -m http.server 8080 --directory ..',
    url: 'http://localhost:8080/index.html',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
