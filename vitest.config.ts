import {defineConfig} from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90
      }
    }
  },
  resolve: {
    alias: {
      // Map the published entry names to source so recipe templates — which
      // import 'react-toolroom/async' exactly as a user project would — are
      // drift-tested against src/ instead of a stale dist build. Mirrors the
      // same mappings in tsconfig.json "paths". More specific key first:
      // string aliases also match their prefix.
      'react-toolroom/async': path.resolve(__dirname, './src/async/index.ts'),
      '@@': path.resolve(__dirname, './src'),
      '@': path.resolve(__dirname, './demos')
    }
  }
});
