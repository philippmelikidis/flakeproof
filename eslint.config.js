import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.venv/', 'examples/', 'test-results/', '.superpowers/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // In-page code (serializer, mutation catalogs) runs in the browser.
    files: ['src/probe/**'],
    languageOptions: { globals: globals.browser },
  },
];
