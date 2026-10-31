import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'workspace/', 'test-results/', 'playwright-report/', '.pramaan-cache/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vm', message: 'vm is forbidden (§2.1).' },
            { name: 'node:vm', message: 'vm is forbidden (§2.1).' },
            { name: 'jsonpath-plus', message: 'jsonpath-plus uses eval (§2.1).' },
          ],
        },
      ],
    },
  },
  {
    // §2.4: only src/llm/client.ts may import the Anthropic SDK.
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/llm/client.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vm', message: 'vm is forbidden (§2.1).' },
            { name: 'node:vm', message: 'vm is forbidden (§2.1).' },
            { name: 'jsonpath-plus', message: 'jsonpath-plus uses eval (§2.1).' },
            { name: '@anthropic-ai/sdk', message: 'Only src/llm/client.ts may import @anthropic-ai/sdk (§2.4).' },
          ],
          patterns: [{ group: ['@anthropic-ai/sdk/*'], message: 'Only src/llm/client.ts (§2.4).' }],
        },
      ],
    },
  },
  {
    files: ['fixtures/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', fetch: 'readonly',
        console: 'readonly', process: 'readonly', URL: 'readonly', setTimeout: 'readonly',
        Blob: 'readonly', location: 'readonly', history: 'readonly', Buffer: 'readonly', URLSearchParams: 'readonly',
      },
    },
  },
);
