import { defineConfig } from 'vitest/config';

/**
 * Unit tests for `@tetravox/embed` — the protocol guards and the ViewSpec normaliser.
 *
 * `test/e2e/**` is excluded: those are Playwright specs and need a real browser with a real WebGL2
 * context and real files on disk. What runs here is the half that must be provable without one —
 * the trust boundary above all, because a boundary that can only be exercised end to end is one
 * whose failure modes are never exercised at all.
 */
export default defineConfig({
  test: {
    name: 'embed',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/e2e/**', 'dist/**'],
    environment: 'node',
  },
});
