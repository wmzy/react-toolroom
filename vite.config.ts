/* eslint-disable import/no-extraneous-dependencies */

import * as path from 'path';
import {defineConfig, PluginOption} from 'vite';
import react from '@vitejs/plugin-react';
import linaria from '@linaria/rollup';

const buildDemo = process.env.BUILD_DEMO === 'true';
const base = buildDemo ? '/react-toolroom/' : '/demos/';

export default defineConfig({
  base,
  resolve: {
    alias: [
      {
        find: 'react-toolroom/async',
        replacement: `${path.join(__dirname, 'src/async/index.ts')}`
      },
      {
        find: 'react-toolroom',
        replacement: `${path.join(__dirname, 'src/index.ts')}`
      },
      {
        find: /^@\/(.*)/,
        replacement: `${path.join(__dirname, 'demos/$1')}`
      },
      {
        find: /^@@\/(.*)/,
        replacement: `${path.join(__dirname, 'src/$1')}`
      }
    ]
  },
  define: {
    'process.env.BASE_URL': JSON.stringify(base)
  },
  esbuild: false,
  build: buildDemo
    ? {}
    : {
        target: false, // skip vite:esbuild-transpile
        minify: 'terser',
        sourcemap: true,
        lib: {
          name: 'react-toolroom',
          entry: {
            async: 'src/async/index.ts'
          },
          formats: ['es']
        },
        rollupOptions: {
          external: (id) =>
            !(
              id.startsWith('.') ||
              id.startsWith('@@/') ||
              id.startsWith(`${__dirname}/src`)
            )
        }
      },
  server: {
    open: '/demos/'
  },
  plugins: [
    {
      apply: buildDemo ? 'build' : 'serve',
      enforce: 'pre',
      ...linaria({
        sourceMap: true,
        exclude: ['node_modules/**']
      })
    } as PluginOption,
    react({
      exclude: ['node_modules/**'],
      babel: {
        configFile: true,
        babelrc: true
      }
    })
  ]
});
