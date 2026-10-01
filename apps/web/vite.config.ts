import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiProxy = env.VITE_API_PROXY || 'http://localhost:4100';
  if (mode === 'demo') {
    // static web demo: single page, relative asset paths, recorded API (src/demo/install.ts)
    return {
      base: './',
      plugins: [react(), tailwindcss()],
      define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
      build: {
        target: 'es2022',
        outDir: 'dist-demo',
        sourcemap: false,
        chunkSizeWarningLimit: 2000,
        rollupOptions: { input: 'demo.html' },
      },
    };
  }
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env.WEB_PORT || 5173),
      strictPort: false,
      proxy: {
        '/v1': { target: apiProxy, changeOrigin: true },
      },
    },
    preview: {
      port: Number(env.WEB_PORT || 4173),
      proxy: {
        '/v1': { target: apiProxy, changeOrigin: true },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 900,
    },
  };
});
