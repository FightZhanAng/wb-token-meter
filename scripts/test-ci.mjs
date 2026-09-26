/**
 * CI 等价自检 —— 把「家目录」指到一个空目录再跑 core-test。
 *   pnpm test:ci
 *
 * 为什么需要它：core-test 里凡带真实数据的断言，只有本机存在那些目录时才会执行，
 * 否则整段跳过。于是同一份断言在两种环境下走的是两条路 ——
 * v0.6.0 第一次打标签就是这么挂的：两条缓存隔离断言顺手写成了「缓存非空」，
 * 本机有 ~/.reasonix 所以永远是绿的，CI 上目录根本不存在，必然判死。
 *
 * 这个脚本把本机也变成 CI 的条件：空家目录，外加清掉所有 WB_TOKEN_METER_*
 * 覆盖变量（否则你本机设过的目录覆盖会把「空家目录」这一条架空）。
 * 跑通它，「本机通过」和「CI 通过」才是同一件事。
 *
 * 编译那一步留在 npm script 里（`tsc -p tsconfig.test.json && node scripts/test-ci.mjs`），
 * 这样 tsc 由 pnpm 从 node_modules/.bin 解析，和 test:core 走同一条路。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENTRY = join('.tmp-test', 'scripts', 'core-test.js')

// 空的「家」：WorkBuddy / Kimi / ZCode / MiMo / Reasonix / DSH / OpenCode
// 全都查不到，真实数据断言整段跳过 —— 和 CI runner 上的情形一致
const fakeHome = mkdtempSync(join(tmpdir(), 'wbtm-ci-home-'))

const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('WB_TOKEN_METER_')) delete env[key]
}
// Windows 认 USERPROFILE，类 Unix 认 HOME；两个都给，脚本到哪都能用
env['USERPROFILE'] = fakeHome
env['HOME'] = fakeHome

console.log('=== CI 等价自检（家目录指向空目录，真实数据断言会整段跳过）===')
console.log(`    模拟家目录 ${fakeHome}`)

let status = 1
try {
  // stdio 用 inherit：输出直接流到终端，别攒在管道里（某些受限环境也不允许管道）
  const result = spawnSync(process.execPath, [ENTRY], { stdio: 'inherit', env })
  status = result.status ?? 1
  if (result.error) {
    console.error(`    启动 core-test 失败：${result.error.message}`)
  }
} finally {
  // 临时家目录用完就删，不留垃圾
  try {
    rmSync(fakeHome, { recursive: true, force: true })
  } catch {
    /* 删不掉也不该让自检结果变样 */
  }
}

process.exit(status)
