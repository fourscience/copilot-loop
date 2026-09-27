import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', '*.vsix', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': 'off',
    },
  },
  {
    // The core must stay framework-independent: only adapters may import 'vscode'.
    files: ['src/**/*.ts'],
    ignores: ['src/extension.ts', 'src/copilot/**', 'src/ui/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'Core modules must not depend on VS Code. Use an adapter in src/copilot or src/ui.' }] }],
    },
  },
);
