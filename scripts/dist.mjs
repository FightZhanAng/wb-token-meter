/**
 * electron-builder 启动器。
 *
 * 存在的唯一理由：打包需要从 GitHub Releases 下载 winCodeSign / nsis 等二进制，
 * 而这台机器访问 GitHub 会卡在证书吊销检查上（CRYPT_E_NO_REVOCATION_CHECK），
 * 直接跑 electron-builder 必定失败。这里统一把镜像注入环境变量，
 * 并用 Node 直接拉起 CLI（不走 .cmd / shell），避免路径里带中文和空格时被截断。
 *
 * 用法与 electron-builder 完全一致：
 *   node scripts/dist.mjs --win
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 项目根要用脚本自身位置推算。
// 在 pnpm 下 require.resolve 会返回 .pnpm 里的真实路径，
// 从那个路径往上两层拿到的是 node_modules 而不是项目根。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const require = createRequire(import.meta.url)
const packageFile = require.resolve('electron-builder/package.json')
const pkg = JSON.parse(readFileSync(packageFile, 'utf-8'))
const binField = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-builder']
const cli = join(dirname(packageFile), binField)

const env = {
  ...process.env,
  // 镜像地址允许被外部环境变量覆盖，换网络环境时不用改代码
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/'
}

console.log(`[dist] 项目根    = ${ROOT}`)
console.log(`[dist] 二进制镜像 = ${env.ELECTRON_BUILDER_BINARIES_MIRROR}`)

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: ROOT,
  env,
  stdio: 'inherit'
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[dist] 被信号 ${signal} 终止`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
