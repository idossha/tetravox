import { defineConfig } from 'vitest/config';

// Unit tests only (ARCHITECTURE.md §11 (1)). Golden PNG and Playwright-Electron E2E live under
// `pnpm e2e`, never here: goldens are captured only under headless Chromium/SwiftShader.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'packages/wasm/pkg/**', 'target/**', '**/dist/**', '**/out/**'],
    environment: 'node',
    passWithNoTests: true,
  },
});
