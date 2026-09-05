import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'map/**', 'data/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Node-run maintenance scripts and root config modules (plain JS, no TS project
    // behind them). `aliases.mjs` is named explicitly: it is not a `*.config.js`, but
    // it is the shared alias table Vite, Vitest and the smoke spec all import.
    files: ['scripts/**/*.{js,mjs}', '*.config.{js,mjs,ts}', 'aliases.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  prettier,
);
