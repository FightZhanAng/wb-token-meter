/**
 * Trae CN 的机密捞取 —— 数据库密钥与云端积分的登录凭证，**都只能从运行中的
 * 进程内存里拿**，所以这里一次扫描把两样都捞出来。
 *
 * 为什么不拆成两次扫描：扫一遍全量内存实测 ~12 秒，而这两支凭证锁在**同一批
 * 进程**里（见下面 Restart Manager 那段）—— 为第二支凭证再付一遍扫描的钱不划算。
 *
 * ── 数据库密钥（32 字节裸密钥，SQLCipher 那本账的钥匙）─────────────
 *
 * 为什么不能像别的源那样直接读盘：磁盘 5.7 万个文件（hex / 大写 hex / 0x / 原始字节 /
 * base64 三种变体）、注册表 HKCU\Software、Windows 凭据管理器、DPAPI 块、
 * 进程环境块，以及由 ICUBE_MACHINE_ID 派生的 69 种组合，全部 0 命中。
 * 唯一能拿到的地方就是那个独占锁着 database.db 的进程的内存
 * （Restart Manager 实测：app 名 'Trae CN'，旧版为 'TRAE SOLO CN'）。
 *
 * 所以这条链路是：Restart Manager 问「谁锁着这个库」→ 扫那个进程的可读内存捞
 * 64 位 hex 候选 → 逐个拿第 1 页的 HMAC 验（见 shared/traecn-collector.ts 的
 * probeTraeCnKey）。**验签才是真正的判据**，扫描只是把范围缩小，
 * 捞到什么不算数 —— 内存里全是噪声（DLL 模板、FIPS 测试向量、我自己的对话文本）。
 *
 * 为什么走 PowerShell 而不是原生模块：ReadProcessMemory / VirtualQueryEx 只有
 * P/Invoke 能碰，装 koffi 之类的原生模块要跟着 Electron 的 ABI 重编、还要过
 * electron-builder 的 unpack 白名单，为一个数据源不值当。脚本用 `-EncodedCommand`
 * 内联送进去，不落盘 —— 免得在 userData 里留一个 "扫内存" 的脚本被安全软件盯上。
 *
 * 实测一次全量扫描 ~680MB、20~30 秒（JWT 那条要求同一块内存按两种编码各扫一遍，
 * 比只扫 hex 时再慢一截；具体多久看 Trae CN 那边进程内存多大）。所以主进程那侧
 * **必须缓存**：同一份 Trae CN 不重启，密钥就一直有效，只有验签失败（重启换钥）
 * 才重扫；而那批 JWT 候选同理 —— 它就是靠这趟扫描顺带捞出来的。
 *
 * 已知边界：极端情况下（脚本里 `$DbPath` 的路径含单引号）会被字符串拼接弄丢，
 * 但这里传进来的永远是 app.getPath('appData') 拼出来的固定路径，不接用户输入。
 *
 * ── 登录凭证（云端积分那支 JWT）────────────────────────────────
 *
 * 磁盘上 `%USERPROFILE%\.trae-cn\trae-jwt-token` 那支是过期的 CLI token，恒 401，
 * 不能用；有效的那支只在进程内存里（实测主进程与渲染进程都有）。这里按 JWT 的形状
 * 捞候选，**但判据不在这一侧** —— 它要拿去打积分接口，200 才算数
 * （见 main/traecn-usage.ts）。所以这里只负责把范围缩小。
 *
 * 两点别动坏：
 * - 同一块内存要按 **ASCII 与 UTF-16 两种编码各扫一遍**：V8 的字符串可能是两字节
 *   存储（Latin-1 解出来是 "e\0y\0J\0…"），只扫一种会漏掉一半。
 * - 候选会**长过真身**：正则在内存里是贪婪的，token 后面挨着的可打印字符会被一起
 *   吃掉（实测同一次扫描出现 1004 / 1005 / 1007 三种长度）。这不是 bug，验签那边
 *   会一支一支试到 200 为止 —— 别在这里自作聪明地截断。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { probeTraeCnKey } from '../shared/traecn-collector'

const run = promisify(execFile)

/** 全量扫内存是半分钟量级，留够余量；超时按「取不到」处理 */
const SCAN_TIMEOUT_MS = 120_000

/**
 * 扫内存的 PowerShell 脚本。
 *
 * 几个踩过的点，改的时候别动坏：
 * - `GetEncoding(28591)` = Latin-1。PowerShell 5.1 没有 `Encoding.Latin1`，
 *   而按 UTF-8 解会把二进制内存解成占位符、把 hex 串拆散。
 * - 循环里**每次都重算** `$base` / `$next`：`$mbi` 是 out 参数复用的结构体，
 *   图省事在循环外取一次 base 的话，第二轮开始就偏了。
 * - `[IntPtr]($base + $size)` 不能写成 `[IntPtr]::Add`：x64 上 64 位地址会溢出。
 * - `$tp` 而不是 `$pid`：`$pid` 是只读自动变量，赋值会直接把脚本搞挂。
 * - 8MB 一个 chunk：再大 ReadProcessMemory 会在跨不可读页时整块失败。
 */
const SCAN_SCRIPT = `
$DbPath = '__DB_PATH__'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WbtmMem {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [StructLayout(LayoutKind.Sequential)] public struct MBI {
    public IntPtr BaseAddress, AllocationBase; public uint AllocationProtect, __a;
    public IntPtr RegionSize; public uint State, Protect, Type, __b;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);

  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint h, int flags, System.Text.StringBuilder key);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvc, string[] svc);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint h, out uint needed, ref uint have, [In, Out] RM_PROCESS_INFO[] apps, ref uint reason);
}
'@

# —— 谁锁着这个库（Restart Manager 的 RmGetList 返回 234 = ERROR_MORE_DATA，要二次调用）——
$pids = New-Object 'System.Collections.Generic.HashSet[int]'
$sb = New-Object System.Text.StringBuilder 64
[void]$sb.Append('wbtm0000000000000000000000000000')
$h = [uint32]0
if ([WbtmMem]::RmStartSession([ref]$h, 0, $sb) -eq 0) {
  $names = @($DbPath)
  if ([WbtmMem]::RmRegisterResources($h, 1, $names, 0, $null, 0, $null) -eq 0) {
    $needed = [uint32]0; $have = [uint32]0; $reason = [uint32]0
    if ([WbtmMem]::RmGetList($h, [ref]$needed, [ref]$have, $null, [ref]$reason) -eq 234) {
      $arr = New-Object 'WbtmMem+RM_PROCESS_INFO[]' $needed
      $have = $needed
      if ([WbtmMem]::RmGetList($h, [ref]$needed, [ref]$have, $arr, [ref]$reason) -eq 0) {
        for ($i = 0; $i -lt $have; $i++) { [void]$pids.Add($arr[$i].Process.dwProcessId) }
      }
    }
  }
  [void][WbtmMem]::RmEndSession($h)
}
if ($pids.Count -eq 0) { Write-Output 'PID none'; exit 0 }
foreach ($p in $pids) { Write-Output ("PID {0}" -f $p) }

# —— 捞候选（只捞，不判 —— 判据分别是 Node 侧的逐页 HMAC 与积分接口的 200）——
$VM_READ = 0x0010; $QUERY = 0x0400
[System.Text.Encoding]$enc = [System.Text.Encoding]::GetEncoding(28591)
$CHUNK = 8MB
$rx = [regex]'(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])'
$rxJwt = [regex]'eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}'
$cands = New-Object 'System.Collections.Generic.HashSet[string]'
$toks = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($tp in $pids) {
  $ph = [WbtmMem]::OpenProcess([uint32]($VM_READ -bor $QUERY), $false, $tp)
  if ($ph -eq [IntPtr]::Zero) { continue }
  $mbi = New-Object WbtmMem+MBI; $addr = [IntPtr]::Zero
  while ($true) {
    $r = [WbtmMem]::VirtualQueryEx($ph, $addr, [ref]$mbi, [IntPtr]([Runtime.InteropServices.Marshal]::SizeOf($mbi)))
    if ($r -eq [IntPtr]::Zero) { break }
    $base = $mbi.BaseAddress.ToInt64(); $size = $mbi.RegionSize.ToInt64()
    if ($size -le 0) { break }
    $readable = ($mbi.State -eq 0x1000) -and (($mbi.Protect -band 0x02) -ne 0 -or ($mbi.Protect -band 0x04) -ne 0 -or ($mbi.Protect -band 0x20) -ne 0 -or ($mbi.Protect -band 0x40) -ne 0)
    if ($readable) {
      $off = 0L
      while ($off -lt $size) {
        $len = [int][Math]::Min([int64]$CHUNK, $size - $off); $buf = New-Object byte[] $len; $got = [IntPtr]::Zero
        if ([WbtmMem]::ReadProcessMemory($ph, [IntPtr]($base + $off), $buf, $len, [ref]$got)) {
          $one = $enc.GetString($buf)
          foreach ($m in $rx.Matches($one)) { [void]$cands.Add($m.Value.ToLower()) }
          foreach ($m in $rxJwt.Matches($one)) { [void]$toks.Add($m.Value) }
          # V8 的字符串可能是两字节存储：Latin-1 解出来是 "e\0y\0J\0…"，
          # 上面那条 JWT 正则就全落空 —— 同一块内存按 UTF-16 再扫一遍。
          # 64-hex 那条**不重复扫**：它在 ASCII 下已经捞到过，多扫一遍只会
          # 让候选翻倍、验签变慢，救不了任何东西。
          foreach ($m in $rxJwt.Matches([System.Text.Encoding]::Unicode.GetString($buf))) { [void]$toks.Add($m.Value) }
        }
        $off += $len
      }
    }
    $next = $base + $size; if ($next -le $base) { break }; $addr = [IntPtr]$next
  }
  [WbtmMem]::CloseHandle($ph) | Out-Null
}
foreach ($c in $cands) { Write-Output ("CAND {0}" -f $c) }
foreach ($t in $toks) { Write-Output ("JWT {0}" -f $t) }
`

export interface TraeCnKeyProbe {
  /** 排他锁定用量库的进程；空数组 = Trae CN 没在运行（或它没打开这个库） */
  pids: number[]
  /** 通过第 1 页 HMAC 校验的密钥；没找到就是 null */
  key: Buffer | null
  /**
   * 内存里按形状捞到的候选 JWT（去重后的原样串）。
   * **它们还没验过** —— 真伪只有积分接口答得上来（见 main/traecn-usage.ts），
   * 所以这里只当「缩小后的搜索范围」用，绝不能拿去当凭证直接显示。
   */
  tokens: string[]
}

const NOT_FOUND: TraeCnKeyProbe = { pids: [], key: null, tokens: [] }

/**
 * 取一次密钥与登录凭证候选。取不到（没装 PowerShell、App 没跑、脚本被拦）一律
 * 返回空结果，不抛异常 —— 调用方拿它去拼一条 warning，而不是让轮询崩掉。
 *
 * 函数名还叫 readTraeCnKey 是因为它的主产出仍是那把库密钥；tokens 是同一趟扫描
 * 顺带捞的，见文件头「登录凭证」那节。
 */
export async function readTraeCnKey(dbPath: string): Promise<TraeCnKeyProbe> {
  if (process.platform !== 'win32') return NOT_FOUND

  const script = SCAN_SCRIPT.replace('__DB_PATH__', dbPath.replace(/'/g, "''"))
  let stdout = ''
  try {
    const result = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS, windowsHide: true }
    )
    stdout = result.stdout
  } catch {
    return NOT_FOUND
  }

  const lines = stdout.split(/\r?\n/)
  const pids: number[] = []
  const tokens: string[] = []
  for (const line of lines) {
    const pid = line.match(/^PID (\d+)$/)
    if (pid) {
      pids.push(Number(pid[1]))
      continue
    }
    const jwt = line.match(/^JWT (\S+)$/)
    if (jwt) tokens.push(jwt[1])
  }

  // 短的排前面 —— 这不是随手排的：正则在内存里贪婪，同一支 token 常常会连尾巴上
  // 挨着的可打印字符一起捞出来（`真身` 与 `真身+后缀`），**真身一定是那一族里最短的**。
  // 排好序，验签那边就能几下试中；否则遇到几十支候选时，那支对的可能排在很后面。
  tokens.sort((a, b) => a.length - b.length)

  // token 先收齐再判密钥：密钥一旦验上就在下面提前 return 了，
  // 顺手在里面收 token 会漏掉排在它后面的那几行。
  for (const line of lines) {
    const m = line.match(/^CAND ([0-9a-f]{64})$/)
    if (!m) continue
    const key = Buffer.from(m[1], 'hex')
    // 验签才是判据：候选里 99% 是噪声
    if (probeTraeCnKey(dbPath, key)) return { pids, key, tokens }
  }
  return { pids, key: null, tokens }
}
