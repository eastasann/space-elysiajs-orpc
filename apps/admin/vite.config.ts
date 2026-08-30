import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

/**
 * The browser always calls the API at the same-origin path `/api`, which the
 * reverse proxy forwards. In host-mode development there is no proxy, so the
 * dev server stands in for it — keeping one code path for both workflows.
 */
const devApiTarget = process.env.DEV_API_PROXY_TARGET ?? 'http://localhost:3001'

export default defineConfig({
  server: {
    port: Number(process.env.ADMIN_PORT ?? 3000),
    proxy: {
      '/api': {
        target: devApiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [tanstackStart({ srcDirectory: 'src' }), viteReact(), nitro()],
})
