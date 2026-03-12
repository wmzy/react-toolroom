const path = require('path');
const eslintPluginPrettier = require('eslint-plugin-prettier');
const eslintPluginImport = require('eslint-plugin-import');
const eslintPluginReact = require('eslint-plugin-react');
const eslintPluginReactHooks = require('eslint-plugin-react-hooks');
const eslintPluginJsxA11y = require('eslint-plugin-jsx-a11y');
const tsEslintPlugin = require('@typescript-eslint/eslint-plugin');
const tsEslintParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['dist', 'node_modules', 'coverage', 'eslint.config.js']
  },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        browser: true,
        node: true,
        es6: true,
        __DEV__: true
      },
      parser: tsEslintParser,
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    plugins: {
      prettier: eslintPluginPrettier,
      import: eslintPluginImport,
      react: eslintPluginReact,
      'react-hooks': eslintPluginReactHooks,
      'jsx-a11y': eslintPluginJsxA11y,
      '@typescript-eslint': tsEslintPlugin
    },
    rules: {
      'prettier/prettier': 'error',
      'react/jsx-props-no-spreading': 'off',
      'no-return-assign': ['error', 'except-parens'],
      'no-sequences': 'off',
      'no-shadow': 'off',
      'no-plusplus': 'off',
      'no-param-reassign': 'off',
      'no-void': 'off',
      'react/require-default-props': 'off',
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-use-before-define': ['error', {functions: false}],
      'no-use-before-define': ['error', {functions: false}],
      'import/no-extraneous-dependencies': [
        'error',
        {devDependencies: ['demos/**/*', 'test/**/*']}
      ],
      'no-console': process.env.NODE_ENV === 'production' ? 'error' : 'warn',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off'
    },
    settings: {
      react: {
        version: 'detect'
      },
      'import/resolver': {
        typescript: {}
      }
    }
  }
];
