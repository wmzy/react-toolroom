import * as path from 'path';
import {defineConfig, PluginOption} from 'vite';
import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';

const buildDemo = process.env.BUILD_DEMO === 'true';
const base = buildDemo ? '/react-toolroom/demos/' : '/demos/';

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
  // vite 8 resolves bare imports to optimized deps (.vite/deps) which breaks
  // @linaria's wyw-in-js tag discovery (the optimized file has no package.json
  // next to it). Exclude it so the evaluator sees the real package.
  optimizeDeps: {
    exclude: ['@linaria/core']
  },
  esbuild: false,
  build: buildDemo
    ? {
        outDir: 'dist/demos'
      }
    : {
        target: false, // skip vite:esbuild-transpile
        minify: 'terser',
        sourcemap: true,
        lib: {
          name: 'react-toolroom',
          entry: {
            index: 'src/index.ts',
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
    // `hybrid` resolver handles Vite virtual modules (e.g. react-refresh's
    // /@react-refresh) which the evaluator hits when components use inline
    // `css` tags. `@linaria/vite` 5.x is unmaintained and breaks on Vite 8.
    wyw({
      sourceMap: true,
      exclude: ['node_modules/**'],
      eval: {
        resolver: 'hybrid'
      }
    }) as PluginOption,
    react({
      exclude: ['node_modules/**'],
      babel: {
        configFile: true,
        babelrc: true
      }
    })
  ]
});
