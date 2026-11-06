// ESLint (flat config). Formatting is Prettier's job, so no stylistic rules here:
// these catch real defects and unsafe habits.

import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'data/**', 'e2e/out/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    // A disable comment that no longer suppresses anything is itself an error.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'no-implicit-coercion': ['error', { allow: ['!!'] }],
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      curly: ['error', 'multi-line'],
    },
  },
  // The rules engine and AI run in the browser, in a worker and in Node.
  { files: ['src/**/*.js'], languageOptions: { globals: { performance: 'readonly' } } },
  {
    files: ['src/ui.js', 'src/online.js', 'src/push-client.js', 'signin.js'],
    languageOptions: { globals: globals.browser },
  },
  { files: ['src/ai/worker.js', 'sw.js'], languageOptions: { globals: globals.serviceworker } },
  {
    files: ['server/**', 'tools/**', 'test/**', 'e2e/**', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
];
