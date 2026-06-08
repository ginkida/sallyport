import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        chrome: 'readonly',
        WebSocket: 'readonly',
        crypto: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off', // chrome.tabs APIs return id?: number
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // tests sometimes intentionally use private internals
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
