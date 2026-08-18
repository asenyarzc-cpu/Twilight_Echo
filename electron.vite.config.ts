import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          pluginHost: resolve(__dirname, 'src/main/plugins/host.ts'),
          audioEngineService: resolve(__dirname, 'src/main/audioEngineService.ts'),
          audioAnalysisService: resolve(__dirname, 'src/main/audioAnalysisService.ts'),
          libraryScanService: resolve(__dirname, 'src/main/library/libraryScanService.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    publicDir: resolve('resources'),
    plugins: [vue()],
    build: {
      manifest: true,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-vue': ['vue'],
            'vendor-music-metadata': ['music-metadata'],
            'vendor-qrcode': ['qrcode']
          }
        }
      }
    }
  }
})
