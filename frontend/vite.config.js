import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
  build: {
    rollupOptions: {
      input: {
        main: './index.html',
        embed: './embed.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.url?.includes('/stream')) {
              proxyReq.setHeader('Accept', 'text/event-stream');
            }
          });
        },
      },
      '/embed': {
        target: 'http://localhost:5173',
        rewrite: (path) => '/embed.html',
      },
    },
  },
}));
