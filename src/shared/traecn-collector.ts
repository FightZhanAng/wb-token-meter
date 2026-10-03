/**
 * TRAE SOLO CN（TraeWork CN）桌面端用量采集。
 *
 * 账本只有一个文件：
 *   %APPDATA%\TRAE SOLO CN\ModularData\ai-agent\database.db   —— SQLCipher 4 加密的 SQLite
 * 旁边还有 -wal / -shm。用量记在 server_history_info 表里 `source = 'llm_default'`
 * 那些行的 extra_info JSON 上（exact_* 系列）。顶层的 token_usage 列与
 * exact_total_tokens_v1 逐行相等（实测 246/246，0 失配），所以只认 extra_info。
 *
 * 口径（本机 246 次调用逐行对过账）：
 *
 *   input  = exact_prompt_tokens_v1          ← **已含缓存读**，跟 WorkBuddy / Kimi Code
 *                                              那一档一样，别再 + cache_read
 *                                              （要加回去的是 MiMo / DSH 那套）
 *   输出   = exact_output_tokens_v1
 *   缓存读 = exact_cache_read_input_tokens_v1
 *   思考   = exact_reasoning_tokens_v1        ← **是 output 的子集**
 *              （exact_token_semantics_v1 = provider_raw_usage_completion_includes_reasoning）
 *              input + output === total 严格成立（246/246），所以思考只当明细显示，
 *              绝不能加进合计 —— 它已经在 output 里了。
 *   模型   = config_name（auto_router_model_name_v1 是它的路由名，作兜底）
 *
 * ── 两个必须记住的坑 ─────────────────────────────────────────────
 *
 * 1) 密钥是**裸 32 字节**（`PRAGMA key = "x'…'"` 那一档）：enc_key = rawkey，
 *    **不做 PBKDF2**；mac_key = PBKDF2-HMAC-SHA512(rawkey, salt ^ 0x3A, 2 轮, 32B)。
 *    更麻烦的是它**只在 TraeWork 进程的内存里** —— 磁盘 5.7 万个文件、注册表、
 *    凭据管理器、DPAPI 块、进程环境块、以及由 ICUBE_MACHINE_ID 派生的 69 种组合，
 *    全都 0 命中。所以密钥得由主进程先去取（main/traecn-key.ts），
 *    拿不到时整个源显示 0 —— 这不是「读不到数据」，是「压根没有钥匙」。
 *
 * 2) SQLCipher 的 CBC **不做 PKCS#7 校验**，Node/OpenSSL 这边必须
 *    `setAutoPadding(false)`。不设的话会出现「逐页 HMAC 全对、AES 解密全错」
 *    （ERR_OSSL_BAD_DECRYPT），而且错得很像密钥不对，能白查半天。
 *
 * ── WAL 回放 ───────────────────────────────────────────────────
 *
 * 必须按**帧头 salt** 过滤，并以最后一个 commit 帧（dbSize != 0）截断到 mxFrame。
 * checkpoint 之后 WAL 会被复用，上一代的残留旧帧因为密钥相同、HMAC 照样通过，
 * 一起回放就把库污染成 malformed —— 实测不修是 0/4 干净快照，修完 4/4，
 * 而且四次报的错一模一样（Freelist / btreeInitPage），很像是「库坏了」而不是
 * 「快照没拍好」，特别容易查错方向。
 *
 * 库在被写入时快照**仍可能撕裂**，所以这里带重试，拿 integrity_check 兜底。
 *
 * ── 已知边界 ───────────────────────────────────────────────────
 *
 * - 上下文窗口大小库里没有（contextSize 恒 0），界面会退化成「只报已用 token」。
 * - 会话标题取 chat_session.session_title，按 conversation_id 关联
 *   （server_history_info.conversation_id === chat_session.session_id，实测对得上）。
 * - 压缩标记（summarized_above / micro_compacted）本机全为 0。库里若哪天按压缩
 *   重写历史行，逐行累加的账会重 —— 本地没有样本可验，先按「一行一次调用」记。
 * - created_at 是**秒**，不是毫秒。
 */
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createDecipheriv, createHmac, pbkdf2Sync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildSnapshot, type SourceSession } from './aggregate'
import type { CallRecord, Snapshot } from './types'

/* ------------------------------------------------------------ 常量 */

const PAGE = 4096
/** 文件头 16 字节是随机 salt（不加密，明写在最前面） */
const SALT_SZ = 16
/** 每页尾部的保留区：16 字节 IV + 64 字节 HMAC-SHA512 */
const RESERVE = 80
const IV_SZ = 16
const HMAC_SZ = 64
const KEY_SZ = 32
/** 每页真正承载数据的长度 */
const RSTART = PAGE - RESERVE

const WAL_HEADER = 32
const WAL_FRAME_HEADER = 24

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')

/** 快照拍糊了就重拍。库一直在写，单次撕裂是常态而不是异常 */
const SNAPSHOT_TRIES = 3

/* ------------------------------------------------------------ SQLCipher 4 */

/** mac key = PBKDF2-HMAC-SHA512(key, salt ^ 0x3A, 2 轮)。裸 key 模式下 enc key 就是 key 本身 */
function macKeyOf(salt: Buffer, key: Buffer): Buffer {
  return pbkdf2Sync(key, Buffer.from(salt.map((b) => b ^ 0x3a)), 2, KEY_SZ, 'sha512')
}

/** 每页 HMAC 覆盖「密文 + IV」，末尾再接 LE32 的页码 */
function macOf(macKey: Buffer, page: Buffer, no: number): Buffer {
  const start = no === 1 ? SALT_SZ : 0
  const tail = Buffer.alloc(4)
  tail.writeUInt32LE(no >>> 0, 0)
  return createHmac('sha512', macKey)
    .update(page.subarray(start, RSTART + IV_SZ))
    .update(tail)
    .digest()
}

/**
 * 只读库的第 1 页验一下 HMAC —— 密钥对不对，这一页就能判死。
 * 主进程那侧靠它决定「缓存的密钥还能不能用」，比整库解密便宜得多。
 */
export function probeTraeCnKey(dbPath: string, key: Buffer): boolean {
  if (key.length !== KEY_SZ) return false
  const head = Buffer.alloc(PAGE)
  try {
    const fd = openSync(dbPath, 'r')
    try {
      if (readSync(fd, head, 0, PAGE, 0) < PAGE) return false
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
  const want = head.subarray(RSTART + IV_SZ, RSTART + IV_SZ + HMAC_SZ)
  return macOf(macKeyOf(head.subarray(0, SALT_SZ), key), head, 1).equals(want)
}

/**
 * db + -wal 的文件戳（size + mtime）。20 秒一轮的刷新拿它判「库动没动」：
 * 没动就不必把「拷库 + 逐页 AES + 回放 WAL」整价再付一遍。库不存在返回 null
 * —— 没法判「没变」；-wal 不存在是合法状态（刚 checkpoint 完），按占位值参与比较。
 */
export function traeCnFileStamp(dbPath: string): string | null {
  try {
    const db = statSync(dbPath)
    let wal = '-'
    try {
      const s = statSync(`${dbPath}-wal`)
      wal = `${s.size}@${s.mtimeMs}`
    } catch {
      /* 占位值不可能与真实戳撞车：真实戳里必有 @ */
    }
    return `${db.size}@${db.mtimeMs}/${wal}`
  } catch {
    return null
  }
}

/**
 * 解一页。
 *
 * 第 1 页的密文从 salt 之后开始（前 16 字节是明文 salt），且明文里要补回
 * `SQLite format 3\0` —— 这个头部在 SQLCipher 里不加密，但也不在密文里。
 * 其余页密文从 0 开始。保留区（IV/HMAC）本来就不参与加密，输出里留 0 即可。
 */
function decryptPage(page: Buffer, no: number, key: Buffer): Buffer {
  const first = no === 1
  const d = createDecipheriv('aes-256-cbc', key, page.subarray(RSTART, RSTART + IV_SZ))
  d.setAutoPadding(false) // 见文件头：SQLCipher 不做 PKCS#7，设了就会 ERR_OSSL_BAD_DECRYPT
  const body = Buffer.concat([d.update(page.subarray(first ? SALT_SZ : 0, RSTART)), d.final()])
  if (!first) return body
  return Buffer.concat([SQLITE_HEADER, body.subarray(0, RSTART - SALT_SZ)])
}

/* ------------------------------------------------------------ 快照 + WAL 回放 */

interface SnapshotAttempt {
  plainPath: string
  pages: number
  walFrames: number
  integrity: string
}

/**
 * 拷贝一份 → 解密 → 回放 WAL → 落成明文库，再跑一次 integrity_check。
 * 返回 integrity 本身而不是布尔：撕裂与「密钥不对」要能分辨，报错才有用。
 */
function decryptOnce(dbPath: string, key: Buffer, dir: string): SnapshotAttempt {
  for (const ext of ['', '-wal', '-shm']) {
    const target = join(dir, 'database.db' + ext)
    if (existsSync(target)) rmSync(target, { force: true })
    if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, target)
  }

  const buf = readFileSync(join(dir, 'database.db'))

  // WAL：只有帧头 salt 与 WAL 头一致的那些帧属于「当前这一代」，见文件头注释
  const frames = new Map<number, Buffer>()
  const walPath = join(dir, 'database.db-wal')
  if (existsSync(walPath) && statSync(walPath).size > WAL_HEADER) {
    const wal = readFileSync(walPath)
    const stride = WAL_FRAME_HEADER + PAGE
    const salt1 = wal.readUInt32BE(16)
    const salt2 = wal.readUInt32BE(20)
    const list: Array<[number, Buffer]> = []
    let mxFrame = 0
    for (let f = 0; WAL_HEADER + (f + 1) * stride <= wal.length; f++) {
      const base = WAL_HEADER + f * stride
      if (wal.readUInt32BE(base + 8) !== salt1 || wal.readUInt32BE(base + 12) !== salt2) break
      list.push([
        wal.readUInt32BE(base),
        wal.subarray(base + WAL_FRAME_HEADER, base + WAL_FRAME_HEADER + PAGE)
      ])
      // dbSize != 0 是 commit 帧；mxFrame 取最后一个 commit，之后的属于未提交的尾巴
      if (wal.readUInt32BE(base + 4)) mxFrame = list.length
    }
    for (let i = 0; i < mxFrame; i++) {
      const [no, frame] = list[i]
      // 全 0 的帧是 WAL 复用后的空洞，跳过：写进去反而把好页抹平
      if (!frame.every((b) => b === 0)) frames.set(no, frame)
    }
  }

  const mainPages = (buf.length / PAGE) | 0
  const lastFramePage = frames.size ? Math.max(...frames.keys()) : 0
  const pages = Math.max(mainPages, lastFramePage)
  const plain = Buffer.alloc(pages * PAGE)
  for (let i = 1; i <= mainPages; i++) {
    decryptPage(buf.subarray((i - 1) * PAGE, i * PAGE), i, key).copy(plain, (i - 1) * PAGE)
  }
  for (const [no, frame] of frames) decryptPage(frame, no, key).copy(plain, (no - 1) * PAGE)
  // 头部记的页数要跟上：WAL 里可能已经长出比主库更多的新页
  plain.writeUInt32BE(pages, 28)

  const plainPath = join(dir, 'plain.db')
  writeFileSync(plainPath, plain)

  const db = new DatabaseSync(plainPath, { readOnly: true })
  let integrity = 'ok'
  try {
    integrity = String(db.prepare('PRAGMA integrity_check(1)').all()[0]?.integrity_check ?? 'unknown')
  } catch (error) {
    integrity = String(error)
  }
  db.close()
  return { plainPath, pages, walFrames: frames.size, integrity }
}

/* ------------------------------------------------------------ 行 → 调用 */

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function count(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/* ------------------------------------------------------------ 聚合 */

export interface TraeCnCollectOptions {
  /** database.db 的完整路径 */
  dbPath: string
  /** 32 字节裸密钥；null 表示还没取到（TraeWork 没在运行） */
  key: Buffer | null
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

/**
 * 读一次 TRAE SOLO CN 的账，摊成一张 Snapshot。
 *
 * 密钥缺失、库不存在、快照反复拍糊，都**不抛异常** —— 只留一条 warning 与一张
 * 全 0 的快照。主进程的轮询是 20 秒一次，在这里抛异常只会让整个面板停摆，
 * 而用户看到的应该是「这个源暂时读不到」，不是「整个工具坏了」。
 */
export function collectTraeCnSnapshot(options: TraeCnCollectOptions): Snapshot {
  const now = options.now ?? Date.now()
  const dir = dirname(options.dbPath)
  const warnings: string[] = []
  const empty = (): Snapshot =>
    buildSnapshot([], { kind: 'traecn', dir, files: 0, dbRows: 0, now, warnings })

  if (!options.key) {
    warnings.push('没取到 TRAE SOLO CN 的数据库密钥（TraeWork CN 没在运行？），用量将显示为 0')
    return empty()
  }
  if (!existsSync(options.dbPath)) {
    warnings.push(`未找到 TRAE SOLO CN 的用量库（${options.dbPath}），用量将显示为 0`)
    return empty()
  }

  const work = mkdtempSync(join(tmpdir(), 'wbtm-traecn-'))
  try {
    let plainPath = ''
    let lastIntegrity = ''
    for (let attempt = 1; attempt <= SNAPSHOT_TRIES; attempt++) {
      const shot = decryptOnce(options.dbPath, options.key, work)
      if (shot.integrity === 'ok') {
        plainPath = shot.plainPath
        break
      }
      lastIntegrity = shot.integrity
    }
    if (!plainPath) {
      warnings.push(
        `TRAE SOLO CN 的用量库连拍 ${SNAPSHOT_TRIES} 次都不完整（${lastIntegrity}），本次用量显示为 0`
      )
      return empty()
    }

    const db = new DatabaseSync(plainPath, { readOnly: true })
    let dbRows = 0
    const calls: CallRecord[] = []
    try {
      // is_deleted 现在是 NULL（没删过）；留着这层过滤，删过的行不该再算一次
      const rows = db
        .prepare(
          `SELECT history_id, session_id, conversation_id, created_at, extra_info
             FROM server_history_info
            WHERE source = 'llm_default' AND COALESCE(is_deleted, 0) = 0`
        )
        .all()

      for (const row of rows) {
        dbRows += 1
        let extra: Record<string, unknown> = {}
        try {
          extra = JSON.parse(text(row.extra_info) || '{}') as Record<string, unknown>
        } catch {
          // 单行 JSON 坏了只丢这一行，别把整段账赔进去
        }
        const inputTokens = count(extra['exact_prompt_tokens_v1'])
        const outputTokens = count(extra['exact_output_tokens_v1'])
        // 一个分项都没有的行进不了这本账：TokenBundle 只有 input/output/cache/reasoning
        // 四个格子，凑成一次「0 token 调用」只会让「调用次数」虚高
        if (!inputTokens && !outputTokens) continue

        const workspace = text(extra['workspace_folder']) || text(extra['workspace_path'])
        calls.push({
          traceId: '',
          conversationRequestId: '',
          sessionId: text(row.conversation_id) || text(row.session_id),
          projectDir: workspace || text(extra['workspace_id']) || text(row.conversation_id),
          model: text(extra['config_name']) || text(extra['auto_router_model_name_v1']) || '未知模型',
          timestamp: count(row.created_at) * 1000, // 库里是秒
          inputTokens,
          outputTokens,
          cachedTokens: count(extra['exact_cache_read_input_tokens_v1']),
          // 思考是 output 的子集，只作明细
          reasoningTokens: count(extra['exact_reasoning_tokens_v1'])
        })
      }

      const titles = new Map<string, string>()
      for (const row of db.prepare('SELECT session_id, session_title FROM chat_session').all()) {
        const id = text(row.session_id)
        const title = text(row.session_title)
        if (id && title) titles.set(id, title)
      }

      const grouped = new Map<string, CallRecord[]>()
      for (const call of calls) {
        const list = grouped.get(call.sessionId)
        if (list) list.push(call)
        else grouped.set(call.sessionId, [call])
      }

      const sessions: SourceSession[] = []
      for (const [sessionId, sessionCalls] of grouped) {
        sessionCalls.sort((a, b) => a.timestamp - b.timestamp)
        const last = sessionCalls[sessionCalls.length - 1]
        sessions.push({
          sessionId,
          projectDir: last.projectDir,
          cwd: last.projectDir,
          title: titles.get(sessionId) ?? '',
          // 窗口大小库里没有，只能报已用；界面会退化成「上下文 N token」
          contextUsed: last.inputTokens,
          contextSize: 0,
          lastActivity: last.timestamp,
          archived: false,
          calls: sessionCalls
        })
      }

      if (!calls.length) warnings.push('TRAE SOLO CN 的账本里没有读到任何模型调用，用量将显示为 0')
      return buildSnapshot(sessions, {
        kind: 'traecn',
        dir,
        files: 1,
        dbRows,
        now,
        warnings
      })
    } finally {
      db.close()
    }
  } finally {
    // 明文副本用完就删：这是用户整份历史记录，不该在 %TEMP% 里过夜
    rmSync(work, { recursive: true, force: true })
  }
}

/** 解密后一共读了多少页 / 回放了多少帧 —— 只给自检与调试用 */
export function traeCnPageStats(dbPath: string, key: Buffer): { pages: number; walFrames: number; integrity: string } {
  const work = mkdtempSync(join(tmpdir(), 'wbtm-traecn-stat-'))
  try {
    const shot = decryptOnce(dbPath, key, work)
    return { pages: shot.pages, walFrames: shot.walFrames, integrity: shot.integrity }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
