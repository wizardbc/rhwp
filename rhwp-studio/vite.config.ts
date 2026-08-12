import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const studioBase = process.env.RHWP_STUDIO_BASE || '/hwp/studio/';
const previewAllowedHosts = (process.env.RHWP_STUDIO_ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  base: studioBase,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@wasm': resolve(__dirname, '..', 'pkg'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 7700,
    allowedHosts: true,
    fs: {
      allow: ['..'],
    },
  },
  preview: {
    ...(previewAllowedHosts.length ? { allowedHosts: previewAllowedHosts } : {}),
  },
});
