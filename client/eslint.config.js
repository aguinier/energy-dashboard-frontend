import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'node_modules', 'public'],
  },

  // Application + test source. Everything under src/ ships to the browser;
  // the tests are pure-function tests that run in vitest's default (node)
  // environment but touch no node globals, so browser globals cover both.
  //
  // Type-aware: tsconfig.json's `include` is exactly ["src"], so every file
  // matched here is in the program and projectService can resolve it. The
  // package-root config files below deliberately are not.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // tsc already reports unused locals/params (noUnusedLocals /
      // noUnusedParameters), so this rule exists to add the one thing tsc
      // does not offer: an opt-out convention. A leading underscore marks a
      // binding that is deliberately unused.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },

  // Test files. They are not components, so the react-refresh export rule
  // does not apply; and a non-null assertion in a test is an assertion about
  // the fixture, which is exactly what a test is allowed to make.
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Build/tooling config at the package root (vite/tailwind/postcss) runs in
  // node, not the browser. It sits outside tsconfig's `include` — which is
  // exactly ["src"] — so it cannot be type-aware linted without adding it to
  // a tsconfig; it gets the non-type-aware ruleset instead. Lint it we must,
  // though: leaving these files matched by a block with no `extends` is how
  // they end up reported as "linted" with zero rules actually applied.
  {
    files: ['*.{js,ts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
)
