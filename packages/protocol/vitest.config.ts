import { defineConfig } from 'vitest/config';

/** Unit tests for `@tetravox/protocol` — the frozen §6.5 wire types and their guards (§12.3 item 1). */
export default defineConfig({
  test: {
    name: 'protocol',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
