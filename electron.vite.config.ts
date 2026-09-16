import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// electron 必须显式外部化：一旦被 vite 打进产物，构建时就地解析成了
// node_modules/electron 的「路径转发壳」，运行时会去找根本不存在的
// out/main/dist/electron.exe 然后报 "Electron failed to install correctly"。
const nodeExternals = ['electron', ...builtinModules.flatMap((name) => [name, `node:${name}`])]

// 主进程与 preload 强制产出 CommonJS。
// electron-vite 5 默认出 ESM，但 Electron 的 `electron` 模块是 CJS，
// Node 的具名导出探测在它身上不生效，会直接报
// "does not provide an export named 'BrowserWindow'"。
const cjsOutput = {
  format: 'cjs' as const,
  entryFileNames: '[name].js'
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: nodeExternals,
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        output: cjsOutput
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: nodeExternals,
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: cjsOutput
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    server: {
      fs: { allow: [resolve(__dirname)] }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // 多页面：每个 HTML 都要有自己的入口去 createRoot().render()，
          // 只写组件、让 HTML 直接引 .tsx 的话页面会加载但 DOM 永远是空的
          float: resolve(__dirname, 'src/renderer/float.html')
        }
      }
    }
  }
})
