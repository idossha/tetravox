import { defineConfig } from 'vitest/config';

// Unit tests only (ARCHITECTURE.md §11 (1)). Golden PNG and Playwright-Electron E2E live under
// `pnpm e2e`, never here: goldens are captured only under headless Chromium/SwiftShader.
//
// One vitest project per package, each carrying its own config, so a package's include/exclude rules
// live next to the package and `vitest --project engine` works.
export default defineConfig({
  test: {
    projects: [
      'packages/protocol/vitest.config.ts',
      'packages/wasm/vitest.config.ts',
      'packages/engine/vitest.config.ts',
      'packages/app/vitest.config.ts',
    ],
    passWithNoTests: true,
  },
});
