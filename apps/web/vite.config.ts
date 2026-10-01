import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiProxy = env.VITE_API_PROXY || 'http://localhost:4100';
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
