import { defineConfig } from 'vitest/config';

/**
 * Unit tests for `@tetravox/app` — the store, the reducers behind it, and the pure helpers the §8
 * panels render (`lib/*`).
 *
 * `e2e/**` is excluded on purpose: those are Playwright-Electron specs and run under `pnpm e2e`. A
 * component is only worth mounting when the assertion is about *state*, so these run under `node`
 * with no DOM — `ShellController` was written against a store and an `Engine`, never against React,
 * for exactly that reason.
 */
export default defineConfig({
  test: {
    name: 'app',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'e2e/**', 'out/**', 'release/**', 'dist/**'],
    environment: 'node',
  },
});
