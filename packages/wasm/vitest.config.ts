import { defineConfig } from 'vitest/config';

/**
 * Unit tests for `@tetravox/wasm`. `pkg/` is wasm-pack output and is never a workspace member (§2), so
 * it is excluded from collection; `pkg/tvx_wasm.d.ts` is read as *data* by the export-surface test.
 */
export default defineConfig({
  test: {
    name: 'wasm',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'pkg/**', 'dist/**'],
    environment: 'node',
  },
});
