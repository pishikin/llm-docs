import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/commands/*.ts'],
  format: ['esm'],
  target: 'node18',
  shims: true,
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  dts: true,
});
