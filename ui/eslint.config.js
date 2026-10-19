// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', '*.config.js', 'src/generated-*.ts'],
  },
  {
    languageOptions: {
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        fetch: 'readonly',
        EventSource: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        navigator: 'readonly',
        ClipboardItem: 'readonly',
        XMLSerializer: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
      },
    },
  },
  {
    rules: {
      // A leading underscore is the codebase's "deliberately unused"
      // marker (e.g. an EventSource subclass must accept the URL argument
      // it never reads).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);