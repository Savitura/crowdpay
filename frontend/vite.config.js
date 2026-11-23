import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === 'production' && process.env.SENTRY_AUTH_TOKEN
      ? [
          sentryVitePlugin({
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: process.env.SENTRY_AUTH_TOKEN,
            release: process.env.SENTRY_RELEASE || process.env.VITE_SENTRY_RELEASE || 'unknown',
            telemetry: false,
          }),
        ]
      : []),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
  build: {
    sourcemap: process.env.SENTRY_UPLOAD_SOURCEMAPS === 'true',
    rollupOptions: {
      input: {
        main: './index.html',
        embed: './embed.html',
      },
      output: {
        manualChunks(id) {
          if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) {
            return 'recharts';
          }
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-is|prop-types|scheduler)[\\/]/.test(id)
          ) {
            return 'react-vendor';
          }
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
            return 'router';
          }
          if (/[\\/]node_modules[\\/]@sentry[\\/]/.test(id)) {
            return 'sentry';
          }
          if (
            /[\\/]node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector)[\\/]/.test(
              id
            )
          ) {
            return 'i18n';
          }
        },
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
        rewrite: (_path) => '/embed.html',
      },
    },
  },
}));
