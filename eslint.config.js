// ESLint flat config (ARCHITECTURE.md §10: TypeScript strict, ESLint + Prettier, no `any` in public APIs).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// §7.1: `MAX_CULL_DISTANCES_WEBGL` is 0 on ANGLE/Metal but 8 under headless SwiftShader, so a
// `gl_CullDistance` golden passes in CI and fails on every real Mac. The contract asks for a lint that
// forbids the identifier; this is it. Built from fragments so this config file does not trip its own rule.
const CULL = ['gl', 'CullDistance'].join('_');

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      'target/**',
      // wasm-pack output: generated glue, not ours to lint.
      'packages/wasm/pkg/**',
      'test-results/**',
      'playwright-report/**',
      // Jekyll site assets and any agent worktrees checked out under .claude/ are not ours to lint.
      'docs/**',
      '.claude/**',
      // VitePress docs site: src/ is regenerated from docs/*.md, .vitepress/cache and dist are build
      // output. website/scripts/*.mjs, .vitepress/config.ts and theme/ stay linted.
      'website/src/**',
      'website/.vitepress/cache/**',
      'website/.vitepress/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // §10: no `any` in public APIs.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  {
    // Node scripts: plain ESM, no TypeScript, so `no-undef` is live and the runtime's own globals
    // have to be declared. (`globals` is not a dependency and the lockfile is frozen — §12.3.)
    files: ['scripts/**/*.{mjs,js}', 'website/scripts/**/*.{mjs,js}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // The §7.1 lint applies to our source, including shader strings — not to this config.
    files: ['packages/**/*.{ts,tsx,js,jsx}', 'scripts/**/*.{ts,js}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Identifier[name='${CULL}']`,
          message: `${CULL} is forbidden (ARCHITECTURE.md §7.1): MAX_CULL_DISTANCES_WEBGL is 0 on ANGLE/Metal and 8 on SwiftShader, so CI goldens would pass while every real Mac fails.`,
        },
        {
          selector: `Literal[value=/${CULL}/]`,
          message: `${CULL} is forbidden (ARCHITECTURE.md §7.1), including inside shader source strings.`,
        },
        {
          selector: `TemplateElement[value.raw=/${CULL}/]`,
          message: `${CULL} is forbidden (ARCHITECTURE.md §7.1), including inside shader source strings.`,
        },
      ],
      // `void x;` in the frozen contract files keeps unused parameters honest against
      // `noUnusedParameters` without renaming them away from the signature §4.7/§6.5 pins.
      'no-void': 'off',
    },
  }
);
