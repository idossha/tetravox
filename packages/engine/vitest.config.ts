import { defineConfig } from 'vitest/config';

/**
 * Unit tests for `@tetravox/engine` (§11 (1) is the *rendering* half; this is the plain-logic half).
 *
 * `test/e2e/**` is excluded on purpose: those are Playwright specs and run under `pnpm e2e`, because a
 * golden may only be captured under headless Chromium/SwiftShader at a fixed size (§11).
 */
export default defineConfig({
  test: {
    name: 'engine',
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/e2e/**', 'test/pages/**', 'dist/**'],
    environment: 'node',
  },
});
