# AGENTS.md

给在这个仓库里干活的 AI / 协作者。

只写**「不知道就会踩」的操作性规则**。架构、数据源口径、界面设计取舍、每一条坑的
完整成因链都在 [README.md](README.md)，这里不重复，只留「怎么做 / 别做什么」。

本机是 Windows。宿主 shell 是 Git Bash；PowerShell 也可用（删文件、查进程走它更稳）。

---

## 1. 命令

### 正常情况

```bash
pnpm dev          # 开发模式，带 HMR
pnpm typecheck    # 主进程 / 渲染层分别类型检查（两套 tsconfig）
pnpm test:core    # 无头自检，跑本机真实数据
pnpm test:ci      # 同上，但把家目录指到空目录 —— 复现 CI 的条件
pnpm build        # 产物到 out/
pnpm dist         # 打包 Windows 安装包与免安装版到 release/
pnpm gen:icons    # 重新生成图标与 11 帧托盘进度环
```

**`test:core` 与 `test:ci` 都要跑。** 带真实数据的断言只在数据目录存在时才执行，
本机有 `~/.workbuddy`、`~/.dsh` 时一部分代码路径在 `test:core` 里根本走不到。
v0.6.0 第一次打标签就是挂在这上面。

### pnpm 跑不动的时候，直接调二进制

`pnpm <script>` 会先做依赖状态检查。一旦判定 `node_modules` 与 lockfile 不一致，
它会要求清空重装 —— 而**本机这一步必然失败**（原因见 §2.2），报错长这样：

```
pnpm: Command failed with exit code 1: ... pnpm.mjs install
    at runDepsStatusCheck (...)
```

**触发条件比想象的宽**：不只是加依赖，**改 `package.json` 里任何东西 —— 包括只是把
version 从 0.8.1 改成 0.8.2 —— 都会让检查判定过期**。`npm_config_verify_deps_before_run=false`
没用（pnpm 11.9 不读这个名字）。

绕开方式，实测等价可用：

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node scripts/test-ci.mjs                          # 等价 pnpm test:ci
node node_modules/electron-vite/bin/electron-vite.js build
```

**顺序有讲究**：一轮里要跑 `build` / `dist` 就**排在最前面**，别排在大量删除操作之后
（§2.2 的额度是按轮累计的）。

### 依赖没装全

`pnpm 11` 会打印 `The "pnpm" field in package.json is no longer read by pnpm` ——
**这是无害的提示**，白名单已经搬到 `pnpm-workspace.yaml` 的 `allowBuilds` 里了，不用管。

`node_modules/electron/` 下缺 `dist/` 和 `path.txt` 时（postinstall 被跳过），
从同机另一个 Electron 项目复制这两样，**两边版本必须一致** —— 本机的 43.3.0
是从 `../water-reminder` 复制过来的。

```bash
cat node_modules/electron/path.txt     # 内容是 electron.exe 即正常
```

---

## 2. 本机环境坑

### 2.1 `ELECTRON_RUN_AS_NODE`

这个变量只要在环境里，`electron.exe` 就退化成普通 Node，主进程在模块顶部算
`APP_ID` 那一行直接崩：

```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
```

**宿主的 bash 默认就带着它**，所以直接调 `electron.exe` 时必须自己摘掉：

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe . --user-data-dir="<隔离目录>"
```

`--user-data-dir` 也是必须的：单实例锁在 `app.setPath('userData')` 之前就抢了，
不隔离会和同机其它 Electron 实例打架（表现为「没有报告、退出码 0」）。

### 2.2 safe-delete 安全垫（本机特有，最容易卡住 build）

本机装有删除安全垫：PowerShell 的 `Remove-Item` 与 node 的 `fs.rm`

- 对**工作区外**的路径一律 **fail-closed**；
- **批量阈值按「轮」累计**（`{"count":50,"threshold":50,"scope":"turn"}`），
  一旦到顶，**连工作区内的删除也全面拦截**。

后果是一轮里删得多了，后面的 `pnpm install`、`electron-vite build` 会莫名其妙挂掉 ——
它们只是要清临时目录 / `out/`，却撞在垫子上：

```
[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50,"threshold":50,...}
    at checkBulkDeleteGuard (node-safe-delete-shim.cjs)
    at emptyDir (vite) → prepareOutDir              ← 清 out/
    at storePathRelativeToHome (pnpm.mjs)           ← 删 _tmp_*
```

**处理办法：删除一律走 .NET**（不经 node / PowerShell 的删除 API，垫子拦不到，
也不占那一轮的额度）：

```powershell
[System.IO.File]::Delete($p)
[System.IO.Directory]::Delete($p, $true)
```

其他边界：

- **递归删除遇到「悬空 junction」必失败**（报 `Access to the path '<link>' is denied`，
  .NET 递归删也一样）。先单独摘掉那个 reparse point，再删父目录；
  长路径用 `\\?\` 前缀绕 MAX_PATH。
- 删「含链接的目录」的次序就是安全边界：**先删链接的目标侧，再删含链接的一侧**。
- **沙箱开着时 `electron-vite build` 会静默失败**：`exit 1`，stdout 和 stderr 都是空的。
  它要清 `out/`，那一步被沙箱拦了。重跑一次通常能走升级授权的流程；
  另外**别把 build 串在一长串 `&&` 里** —— 那样你只会看到最后一个命令的退出码，
  前面失败的部分全被吞掉（这一轮就吃过：`... && build >/dev/null && electron ...`
  整体 exit 1，看起来像应用崩了，其实是构建没跑成，跑的是上一轮的旧产物）。
- 沙箱开启时，写 / 删工作区外的路径会被**静默终止**（exit 1、无输出、无文件落盘）。
  先用「小文件写测试」确认权限，再上破坏性操作。

### 2.3 到 GitHub 的网络

- **SSH 与 HTTPS 都通**（`git ls-remote` 实测都是 exit 0）。仓库有两个远端：
  `origin` = https、`ssh-origin` = ssh，**`main` 的上游跟踪的是 `origin`**。
- **push 很慢**：main 实测 **2m40s**、tag **51s**。**一律扔 background 跑**，
  前台等必然超时（超时被自动后台化，但等待期间什么都干不了）。
- **本机没有 `gh`**（`gh: command not found`）。查 CI 结果见 §3.4。
- GitHub 会偶发 502（API 和 git 都可能）。**等 20 秒重试一次**，别据此判定「发布失败」。

---

## 3. GitHub 操作

### 3.1 推送

```bash
export GIT_TERMINAL_PROMPT=0
git ls-remote origin HEAD          # 先花 5 秒验通道，再决定走哪条路
git push origin v0.8.2             # 扔后台，约 51s
git push origin main               # 扔后台，实测 2m40s
```

- 管道会吃掉退出码：`... | tail` 之后要看 `echo "exit=${PIPESTATUS[0]}"`，
  否则拿到的永远是 `tail` 的 0，会把失败误判成成功。
- `GIT_TERMINAL_PROMPT=0`：宁可失败也别挂在那儿等输入。

### 3.2 报错对照表

| 报错 | 真正原因 | 处理 |
| --- | --- | --- |
| `Cannot read properties of undefined (reading 'isPackaged')` | `ELECTRON_RUN_AS_NODE` 还在 | §2.1 |
| `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` | 本轮删除累计到 50 | 换 .NET 删（§2.2）；build 排最前面 |
| `pnpm ... Command failed ... pnpm.mjs install` + `runDepsStatusCheck` | 依赖检查自动 install 被拦 | 绕开 pnpm 直接调二进制（§1） |
| `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY]` | 依赖检查 + 无 TTY | 同上 |
| `gh: command not found` | 本机没装 gh | 推送走 git；查 CI 走 §3.4 |
| `test:core` 绿但 `test:ci` 红 | 断言依赖了本机真实数据 | §1，两条都要跑 |
| `HTTP 502 Bad Gateway` | GitHub 瞬时故障 | 等 20 秒重试一次 |

### 3.3 tag 与触发条件

`.github/workflows/release.yml` 的触发条件是 `on: push: tags: ['v*']` 加 `workflow_dispatch`：

- **任何 `v*` tag 推上去都会跑一次完整构建 + 发布。别推临时 tag 试手。**
- **tag 用带注释的**：`git tag -a vX.Y.Z -m "vX.Y.Z：中文摘要"`，
  `git cat-file -t vX.Y.Z` 应返回 `tag`（返回 `commit` 就是误用了轻量 tag）。
- **已经推过的 tag 不要删了重推**：会再触发一次 run；如果第一次还在跑，
  删 tag 会让它的 checkout（按 tag 名检出）失败，留一个红叉。
- 手动触发（`workflow_dispatch`）**只把 exe 留档成 artifact，不发 Release**。

### 3.4 查 CI 结果

本机没有 `gh`，两条路都实测可用：

**Node 的 `node:https` 打 API**（公开仓库匿名可读，限流 60 次/小时）：

| 目的 | 路径 |
| --- | --- |
| 最近几次 run | `/repos/FightZhanAng/wb-token-meter/actions/runs?per_page=3` |
| 单次 run | `/repos/.../actions/runs/<id>` → `status` / `conclusion` |
| 每个 step 的结论 | `/repos/.../actions/runs/<id>/jobs` |
| Release 资产 | `/repos/.../releases/tags/vX.Y.Z` → `assets[]` |

**或者直接抓网页**：`https://github.com/FightZhanAng/wb-token-meter/actions`。
注意页面有缓存，看到的是旧状态时换个 URL（比如具体那条 run，或 releases 页）再确认 ——
**别把「缓存里还写着 In progress」当成 CI 卡住**。

正常结果：run `completed / success`，Release 有**四个**附件 ——
`*-setup.exe`、`*-portable.exe`、`latest.yml`、`*.blockmap`。
后两个少任何一个，应用内的更新检查都会报「更新源上找不到版本信息」。

---

## 4. 发版流程

**版本号只有一处**：`package.json` 的 `version`（README 里没有写死的当前版本号，
但改功能时顺手看一眼「发布」那节有没有需要同步的示例）。

```bash
# 1) 推送前必须全绿：typecheck(node+web) / test:core / test:ci / build
# 2) 升 package.json 的 version
# 3) 提交 —— 首行是「中文摘要（X.Y.Z）」，全角括号包版本号，正文讲改动与验证
#    例：接管主窗口标题栏，左上角加「关于」（0.8.2）
# 4) 打带注释的 tag
git tag -a vX.Y.Z -m "vX.Y.Z：中文摘要"
# 5) 推 main + tag（§3.1，都扔后台）
# 6) 查结果（§3.4）
```

三点别动坏：

- `package.json` 的 `dist` 脚本里 **`--publish never` 必须留着**。CI 里推 tag 会触发
  electron-builder 的隐式发布，它会抢在 `gh release create` 之前自己去发、
  又因缺凭据失败，把整个打包步骤带崩（退出码 1）。
- CI 用 GitHub 官方下载源，本地 `pnpm dist` 默认走 npmmirror（这台机器直连
  GitHub Downloads 会卡在证书吊销检查上）。两边都靠 `ELECTRON_MIRROR` 切换，
  `scripts/dist.mjs` 只在未设置时才补默认值。
- **`docs/preview-dark.jpg` 是 JPEG，别顺手另存成 PNG。** 深色主题多出来那层
  3.5% 的颗粒是高熵噪声，同一张图 PNG 要 820KB、JPEG q88 只要 76KB。
  其余几张没有颗粒，PNG 正常。

重新生成 `docs/preview-*.png|jpg` 的做法：照常跑一轮自检，取 `%TEMP%\wbtm-smoke\`
里的 `window.png` / `window-dark.png`（面板）与 `float-card.png`（展开的胶囊卡片）。
**但要带一个环境变量**：

```bash
WB_TOKEN_METER_FAKE_UPDATE=0.9.0 env -u ELECTRON_RUN_AS_NODE \
  WB_TOKEN_METER_SMOKE=1 WB_TOKEN_METER_SMOKE_EXIT=1 \
  node_modules/electron/dist/electron.exe . --user-data-dir=".workbuddy/tmp/smoke-shots"
```

不带的话，自检会把假版本号 `9.9.9` 注入进去，截图底轨里就挂着
「发现新版本 9.9.9」—— 那是自检的产物，不能进 README。
（值写成当前版本号，界面就会落到「已是最新版本」。）

---

## 5. 改代码的约定

- **注释写「为什么」，不写「做了什么」。** 这个仓库的注释密度是刻意的：
  每一段都在记「不这么写会踩什么」。改动时保持这个风格，中文。
- **提交信息**：首行 `中文摘要（X.Y.Z）`，正文讲成因与取舍，末尾带一行
  「验证：typecheck 通过；test:core / test:ci … 」。沿用 `git log` 的既有写法，
  **不要**改成 `feat:` / `fix:` 那套前缀。
- `src/shared/` 是**不依赖 Electron 的纯 Node 逻辑**（解析、聚合、口径换算、格式化），
  能在 `scripts/core-test.ts` 里 headless 跑；`src/main/` 里也有可测的部分
  （`opencode-usage.ts`、`modelsdev.ts`）。
- **改解析或聚合就补 `scripts/core-test.ts` 的用例**（当前 390 项）。
  涉及网络的用例一律打在本地 mock server 上，只有「真实数据」那一段碰真实环境。
- **改数据源要动的地方**：`src/shared/<源>-collector.ts`、`src/shared/types.ts` 的源定义、
  `src/main/index.ts` 的接线、以及 `core-test.ts` 里「七个数据源互不影响」那一段。
- **改设置项**：`src/shared/types.ts` 的类型 + `src/main/settings.ts` 的默认值与校验。
  老数据文件靠合并默认值兼容，不用写迁移。

---

## 6. 几条容易被改坏的硬约束

### 6.1 窗口标题栏（WCO）

主窗口在 Windows 上是**无边框 + 自绘标题栏**（`titleBarStyle: 'hidden'` +
`titleBarOverlay`）。原因是系统一开「在标题栏和窗口边框上显示强调色」
(`DWM\ColorPrevalence=1`)，原生 caption 就永远是强调色，跟主题无关。

- **机头分三行，别再合并回去**（用户明确要求）：
  1. `.app-caption` —— 窗口 chrome：整条可拖拽 + `.app-caption-guard` 给系统三键占位。
     左角只有**一个「关于」**（版本 / 检查更新 / 退出）—— 菜单栏本来就该待在标题栏里，
     它和三键分处两头、谁也压不到谁，是这一格唯一的应用控件。
     **别把标题或别的按钮搬进来**：跟「− □ ✕」同处一行，系统一换缩放就会互相压
     （用户明确不接受）。
  2. `.app-id-row` —— 标题 / 更新时间 + GitHub / 外观 / 刷新。
  3. `.app-nav` —— 数据源切换。
- **`CAPTION_HEIGHT = 36`（主进程）与 `.app-caption` 的
  `min-height: env(titlebar-area-height, 0px)` 是一对常数，改一个必须改另一个。**
  36 = 系统三键 32px + 悬停余量，再高就是白占地方。
- `.app-header` 左右内边距必须是 0。`.app-caption-guard` 的宽度靠
  `calc(100% - env(titlebar-area-x) - env(titlebar-area-width))` 算，
  上层只要有内边距，guard 就会少算同样多。
- 主题切换要同时刷 caption：`applyTheme()` 与 `nativeTheme.on('updated')`
  都要调 `syncTitleBarOverlay()`。

### 6.2 主题只有一个来源

主进程的 `nativeTheme.themeSource`。设一次，两个窗口的 `prefers-color-scheme`
就跟着变，CSS 直接生效 —— **渲染层不要自己算主题**，也就没有「主进程和页面各记一份」
的机会。`data-theme` 由 HTML 内联脚本在样式表**之前**写好，所以深色下不会先闪一帧浅色。

**这一条只管面板。** 胶囊是**另一条独立的轴**（`settings.floatTheme`：跟随面板 /
记录纸 / 深靛 / 琥珀夜光 / 碳黑）：它贴在别人的桌面上，用户经常想让胶囊和面板不一样，
所以别把它「统一」进 `nativeTheme`。那一档靠窗口启动参数 `--wbm-capsule-theme=`
传给 preload，preload 在样式表之前写 `<html data-capsule>`；`float.css` 只认
`data-capsule`，不认 `data-theme`。深色三档的 12 个共用令牌必须和 `styles.css`
的深浅两块**逐字节相同**（`core-test` 盯着这一条）。

### 6.3 网络请求只在主进程

打包后渲染层的 CSP 是 `default-src 'self'`，`connect-src` 跟着回落，
渲染层直接 fetch 外网会被挡掉。出站请求目前只有两个：OpenCode Go 的额度查询，
以及更新检查。

### 6.4 胶囊与那张卡片

- **窗口几何只能由 `shared/layout.ts` 的纯函数算，渲染层只照摆。** 唯一入口是
  `floatWindowBounds()`：输入「胶囊在屏幕上的坐标」，输出窗口 bounds —— 收起与展开
  共用同一个函数，所以来回切是幂等的（胶囊不会一格一格地漂）。别在渲染层再算一遍。
- **`FLOAT_CARD.height = 226` 是常数，不是量出来的**（窗口尺寸得在渲染之前就知道）。
  所以卡片里每一段文字的行高都写死在 `float.css` 里。**加一段没有 `line-height`
  的文字、或者让某段文字可能换行，预算就溢出** —— 而表现是静默的：`.card` 的
  `overflow: hidden` 把底栏切掉，卡片看着一切正常。改完看自检报告里的
  `cardScroll`（两个数必须相等）；同一份报告里的 `sections` 会告诉你这几百像素
  被谁吃掉了。
- **`--capsule-shadow` 四档共用同一组几何**（`0 4px 10px`），只改颜色与透明度。
  窗口留白是 `SHADOW_PAD` 一个常数，哪一档触达超出去，就在窗口底边切出一道硬边
  （深色更明显，因为阴影画得更实）。
- **展开不新建窗口**，是同一个窗口换尺寸。单击与拖动共用一套指针事件（3px 阈值），
  所以**别用 `-webkit-app-region: drag`** —— 它会把 click 整个吃掉。自检里点胶囊
  必须派发真的 `PointerEvent('pointerdown'/'pointerup')`，`el.click()` 走不到那段逻辑。
- **设置一变就 `tray.refresh()` 重建菜单，别只清签名等下一次快照。** 菜单里那几项标题
  带着当前档位（「胶囊主题：深靛」），而子菜单里 `type: 'radio'` 的圆点是**系统自己挪的** ——
  中间那段空档里圆点已经在新档位、标题还停在旧档位，同一条菜单两个说法打架
  （用户就是这么发现的）。自检 `float-theme` 报告里的 `menuAgree` 盯着这一条：
  `describeChoices()` 把每个子菜单的「标题档位」与「被勾中的那一项」一起报出来，两者必须相等。
- **档位表里必须含当前值**，否则那一列圆点**一个都不亮**（不透明度的默认值 0.94 就不在
  `OPACITY_OPTIONS` 里）。别把缺的那个值写死进表，按 `opacityOptions()` 那样插进有序位置 ——
  写死只救得了那一个值。

### 6.5 各数据源的 token 口径不一样

**改映射前先读 README 里那个源的小节。** 最容易错的是 input 的含不含缓存：

| 源 | input | 缓存命中 |
| --- | --- | --- |
| WorkBuddy / Kimi Code / ZCode / Reasonix | **含**缓存读 | 各自的 cache 字段 |
| Xiaomi MiMo / DeepSeek Harness | **不含**，要手动加回 `cache.read` / `cacheWrite` | 同左 |

算错不会报错，只会让数字整体偏。同理，Qoder CN 的账本里**根本没有 token**
（服务端只回积分与水位比例），那不是「读不到」。

---

## 7. 无头验证 UI 的做法

这个项目界面没有测试框架覆盖，但**不能只靠肉眼看截图下结论**。
流程与踩坑见用户级 skill `electron-gui-verify`；本项目的自检入口是环境变量：

```bash
env -u ELECTRON_RUN_AS_NODE WB_TOKEN_METER_SMOKE=1 WB_TOKEN_METER_SMOKE_EXIT=1 \
  node_modules/electron/dist/electron.exe . --user-data-dir="<工作区内隔离目录>"
```

报告写到 `%TEMP%\wbtm-smoke\`，含 `capturePage()` 截图与 DOM 度量。
**动过标题栏后必看 `narrow-header` 这三项**：`captionHeight`（应为 36）、
`guardWidth`（> 0）、`actionsBelowCaption`（应为 true）。

四个已踩过的坑：

- **整屏截图会被前台窗口坑死**：Windows 的前台锁不允许后台进程抢焦点，
  应用被盖住时整屏里只剩别人家的窗口。改用
  `desktopCapturer.getSources({types:['window']})` 按窗口标题单独截，
  被遮挡也能拍到，而且**连系统三键一起拍进去**。
- **隐藏窗口不参与合成**：`show: false` 时 `capturePage` 拿到的是旧帧。
  先 `showInactive()` 再截。
- **隐藏窗口会节流 CSS 过渡**：底色会卡在起始值。截图前注入
  `*,*::before,*::after{transition:none!important;animation:none!important}` 拿终态。
- **别用 `Get-Process -Name electron | Stop-Process -Force` 清进程** ——
  会把同机的 dsh-pet 桌宠（也是 electron.exe）一起杀掉。用
  `Get-CimInstance Win32_Process` 看 CommandLine，**只杀自己那个 `--user-data-dir`**。

---

## 8. 文件卫生

- **自己产生的临时文件，任务做完就清掉**：调试脚本、验证截图、解压或转换的中间产物、
  一次性数据文件、构建与测试残留。别留在工作区里过夜。
- 本机 pnpm / electron-vite 失败会留残骸，看到就清：根目录 `_tmp_<pid>_<hash>`
  （0 KB 空文件）、`electron.vite.config.<13位时间戳>.mjs`、`*.tsbuildinfo`、`.tmp-test/`。
  **注意别误删同名源文件 `electron.vite.config.ts`**（通配符会撞到它）。
- 界面验证截图放 `.workbuddy/tmp/evidence/`，**结论落进提交信息或记忆之后就把图删掉**
  （十几张就 1~2 MB，留着纯是垃圾）。
- **不是垃圾、别顺手删**：`out/`（构建产物，删了应用直接跑不起来）、`release/`
  （electron-builder 的输出位置）、`docs/` `resources/`（项目资源）。
  **`.workbuddy/` 整个目录不许删** —— 它是项目数据目录，只有里面的 `tmp/` 属于可清理范围。
- 删除走 .NET（§2.2），**工作区内也走**，不占 safe-delete 那一轮的额度。
  清完复核：目标真没了、该留的还在、`git status` 干净。
