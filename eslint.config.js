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
      // Bundled extensions: downloaded, hash-verified module artefacts placed by
      // scripts/fetch-locked-modules.mjs and rebuilt from modules.lock on every packaging run
      // (§13.8). Not committed, not ours to lint.
      'packages/app/resources/modules/**',
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
        // scripts/smoke-artefact.mjs kills a hung packaged binary rather than letting the CI job's
        // timeout do it, so the failure names the artefact instead of the workflow.
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        // scripts/fetch-locked-modules.mjs downloads the release assets `modules.lock` pins.
        fetch: 'readonly',
      },
    },
  },
  {
    // ARCHITECTURE.md §13.1's **module wall**, and the reason stage 3 (§13.9) is a one-file change
    // rather than a redesign: a module may reach `../host` for its types, the shared control kit
    // under `ui/`, and `@tetravox/engine` **types only** — never the store, the engine's runtime,
    // `bridge()`, the automation surface or a panel's internals.
    //
    // Two globs because minimatch's `**` and a single-segment `*` do not both cover
    // `modules/<id>/index.ts` and `modules/<id>/kernels/x.ts`. The host's own files — `host.ts`,
    // `hostImpl.ts`, the slot, the switcher — sit **directly** in `modules/` and are deliberately
    // outside this rule: `hostImpl.ts` is the one file that is allowed to see both sides.
    //
    // A lint rule can be switched off inline, so `modules.test.ts` re-proves the same thing by
    // reading the sources. This is the wall; that is the guard.
    files: [
      'packages/app/src/renderer/src/modules/*/*.{ts,tsx}',
      'packages/app/src/renderer/src/modules/*/**/*.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tetravox/engine',
              // `allowTypeImports` is the whole point: a module names `Layer` and `vec3` all day and
              // must never *call* the engine. Everything it can do goes through `ModuleHost`.
              allowTypeImports: true,
              message:
                'A module may import engine TYPES only (§13.1). Everything it can do goes through ModuleHost.',
            },
          ],
          patterns: [
            {
              group: [
                '**/store',
                '**/store/*',
                '**/engine/*',
                '**/automation/*',
                '**/panels/**',
                '**/lib/*',
                '**/bridge',
                '**/preload/*',
                '**/../../../preload',
              ],
              message:
                'A module reaches the shell only through ModuleHost (§13.1): no store, no Engine, no bridge, no automation.',
            },
          ],
        },
      ],
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
