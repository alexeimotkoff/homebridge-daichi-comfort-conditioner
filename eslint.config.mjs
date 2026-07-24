import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'],
    rules: {
      curly: ['warn', 'all'],
      eqeqeq: 'warn',
      'no-console': 'warn',
      'prefer-const': 'warn',
    },
  },
);
