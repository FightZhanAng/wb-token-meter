# 代码规范

这份文件管**写代码时怎么判断**。跑什么命令、本机有哪些坑、怎么发版，在
[AGENTS.md](../AGENTS.md)；**验收标准**在 [Review 检查清单](./review-checklist.md)。

适用范围：`src/`、`scripts/`、配置与文档。其中「分层」「数据口径」「IPC 与安全」
三节是硬规则，违反要打回；其余按「有没有更好的写法」讨论，不卡人。

---

## 0. 一句话前提

这个工具的 bug 不长成崩溃，长成**一个看起来合理、其实错的数字**。

崩溃会被发现，数字不会 —— 用户只会默默按错的数据做决定。下面所有规则都是从这句话
推出来的：宁可显示「还没读到」，也不要显示一个编出来的 0。

---

## 1. 分层与依赖方向

| 层 | 可以依赖 | 禁止 |
| --- | --- | --- |
| `src/shared` 纯逻辑模块 | `./types`、彼此 | `electron`、`node:*`、任何 IO |
| `src/shared` 采集器 | `node:fs` / `node:sqlite` / `node:crypto`、`./types` | `electron`（要能在纯 Node 下跑测试） |
| `src/main` | `electron`、`node:*`、shared 全部 | 碰 DOM |
| `src/preload` | `electron`、shared 纯逻辑模块 | 业务逻辑、`node:fs` |
| `src/renderer` | `react`、shared 纯逻辑模块、`window.meter` | `node:*`、`electron`、直接读磁盘 |

**渲染层可达的 shared 模块是一份白名单**：`types` / `format` / `capsule` / `layout` /
`update` / `opencode-quota` / `traecn-credits`。往这个集合里加模块前先问一句
「它要碰 fs 或 electron 吗」—— 要碰就不能进。

- 采集器放 `shared/` 且**不引 `electron`**，这样 `test:core` 能在纯 Node 下直接跑。
  需要 `app.getPath()` 的那一层（`main/traecn-usage.ts`、`main/opencode-usage.ts`）
  放主进程，采集器只收路径参数。
- `@shared/*` 别名只在 `tsconfig.web.json` 里配了。主进程写相对路径 `../shared/...`，
  别在 main 里用别名。
- 新窗口、新页面都要走 `loadRenderer()` + `hardenWindow()`，不要自己拼 `loadURL`。

## 2. 命名

- 文件 kebab-case。采集器统一 `<source>-collector.ts`；主进程按能力命名
  （`settings.ts` / `tray.ts` / `float.ts` / `updater.ts`），不按技术名词命名。
- 类型 / 接口 PascalCase，不加 `I` 前缀。对象形状用 `interface`（报错信息更可读），
  联合、映射、工具类型用 `type`。本项目不靠 declaration merge，别为它留口子。
- 模块级常量与配置表统一 UPPER_SNAKE（`REFRESH_MS`、`DEFAULT_SETTINGS`、
  `SOURCE_ORDER`、`CAPSULE_SIZES`）；函数内的局部缓存用小写 camelCase（`trayCache`）。
- 有序数组命名以 `*_ORDER` 结尾，白名单直接跟着它走 ——
  `isSourceKind` / `isThemeMode` / `isCapsuleTheme` 都是这么写的，
  这样加一档不用回来改校验函数。
- 布尔值以 `is` / `has` / `can` / `should` 或状态形容词开头：
  `isSourceKind`、`hasCredits`、`canDownload`、`stale`、`packaged`。
- **单位进名字，比例与百分比分开**：
  - `*Ms` 毫秒、`*Tokens` token 数、`*Bytes` 字节
  - `ratio` = 0..1，`percent` = 0..100。`contextRatio` 与 `percent` 的区分不是巧合，
    混用一次就会出现「上下文 1%」或「上下文 10000%」。
- IPC 通道 `域:动作`，动作 kebab-case：`snapshot:get`、`float:toggle-card`、
  `update:open-page`。新通道沿用，不要出现 `getSnapshot` 这种无域名的。
- 测试标签写中文短句，描述的是「什么不许发生」：`骨架在时不画数字`、`缓存不得被污染`。

## 3. TypeScript

两套 tsconfig 都开了 `strict` / `noUnusedLocals` / `noUnusedParameters`。
**不要为了让报错消失去关它们**，也不要靠 `_` 前缀留参数 —— 本项目没有这个习惯，
直接删掉参数或调用点。

- **`any` 只允许出现在「外部 JSON 刚进来」的那一行**，并且必须在同一个函数里收窄完。
  现状唯一豁免是 `parseUsageLine` 的 `Record<string, any>`。新代码用
  `Record<string, unknown>` + 守卫函数（`num()` / `sumDetail()` 就是范式）。
- **三种「没有」要分清**，别用一个 0 打天下：

  | 语义 | 表达方式 | 例子 |
  | --- | --- | --- |
  | 这个概念不存在 | 字段可选 | `credits?: number`（只有 Qoder 有） |
  | 暂时读不到 | 显式状态 | `pending` / `stale` / `error` |
  | 数值未知 | 0 + 另一个字段说明 | `contextUsed: 0` + `contextRatio` |

  禁止用 `NaN` 或 `-1` 当哨兵值。
- 判别联合优先于布尔组合：`UpdateStatus` 八态一个字段，比
  `isChecking + isDownloading + error` 好读也好画。
- 跨 IPC 的 `as` 只允许出现在 `preload`（那是契约声明，不是类型断言）。主进程收到
  renderer 的参数一律当 `unknown`：`settings:update` 走 `parseSettings` 是标准做法，
  `float:move` 的 `Number(dx) || 0` 是最低下限。
- 类型导入写 `import type` / `export type`（`isolatedModules` 下必须）。
- 不写 `enum`，用字符串字面量联合。
- `!` 非空断言只在「上一行刚判过、中间没有 await」时使用，且注释说明原因。

## 4. 数据口径（最高优先级）

- **一个口径只有一处实现。** 积分对账只走 `billingKey()` + `creditOf()`；
  任何地方不得自己拼 `traceId` / `conversationRequestId` 去查表。
- **去重粒度要对。** 一个计费键可能对应多轮工具调用，也可能同时出现在父会话与
  `subagents/` 的 transcript 里。会话维用 `creditedKeys`、日 / 模型维用
  `billingRounds()` 的 `seen` —— 这是两处实现，改一处必须同时改另一处，并说明口径。
- **新增维度必须能交叉验算**：token 与积分都要满足
  `Σsessions = Σdays = Σmodels = Σprojects = totals`。测试里已有这条断言，
  新维度照抄一条，加起来对不上就是错，不用讨论。
- **只 round 一次，且只在出口。** 内部累加用原值，`round2()` 只在上赋值时调用。
  中途四舍五入会累积误差，最后总额必然对不上。
- **时间只走 `localDate()` / `dayKeyOf()`。** 禁止 `toISOString().slice(0, 10)` ——
  那是 UTC 日期，东八区每天 00:00–08:00 会算到昨天。
- **缓存返回的对象不许被调用方改。** 要么冻结，要么浅拷贝后再改。`traeCnStampCache`
  那段 `warnings: [...snapshot.warnings]` 就是踩过之后的写法。
- **缓存键必须能感知内容变化，也要能支撑增量读取**：`mtime + size + offset + identity`。
  只看 mtime 会漏掉同一毫秒内的写入（Windows 时间戳精度有限）；只记 mtime + size
  则每次追加都得全文重读。`identity`（`ino:birthtime`）管的是另一种情况 ——
  同一路径换了另一个文件，旧 offset 指向的是别人的字节。
- **「读不到」永远不许变成 0。** 要么 `pending`，要么 `warnings`，要么 `stale + error`。
  界面上 0 只有一个含义：真的读到了 0。

## 5. 采集器（读别人家的磁盘）

- **绝不 throw。** 顶层 `collect*` 内部兜住，失败返回空账 + 一条说人话的 warning。
  `refresh()` 里那层 catch 是最后一道保险，不是第一道。
- **只读。** 不写、不加锁、不删源文件。要打开被占用的库就复制三件套到临时目录
  （`readDatabase` 的 db / -wal / -shm）。临时目录用完即删，失败也不留。
- **先探测再解析。** `line.indexOf('"usage"')` 快筛，别对每一行 `JSON.parse`。
- **外部数据一律不可信。** `typeof` / `Array.isArray` / `Number.isFinite` 三件套；
  解析失败返回 `null`，不要返回半成品对象。
- **同步采集目标 < 200ms。** 超了就要缓存，或挪到异步。`traecn` 扫密钥是唯一
  允许几十秒的路径，代价是必须先把「还在读」推给界面（`pending: 'key-scan'`）。
- **网络请求不许进同步采集路径。** 先画缓存，再 `pull()` 异步补，回来后再
  `refresh()` 广播。`pull` 必须自带去重与节流，否则会自己触发自己
  （`traecn` 那段注释记了卡死根因）。
- **凭证只读不打印。** 日志、`warnings`、`error`、`credential` 字段都只能写来源描述
  （"从 Trae CN 进程内存取到"），绝不写值。README 与提交信息同理。
- **目录与环境变量统一放 `main/paths.ts`。** 采集器只接收路径参数 —— 这样测试能把
  它指到夹具目录，也是 `test:ci` 能跑的前提。

## 6. IPC 与安全

- `invoke` 用于要回值；`send` 用于高频、无回值（拖动、点击、握手）。
- **新增 API 必须同时改三处**：`main/index.ts` 的 handler、`preload/index.ts` 的 `api`、
  `renderer/global.d.ts` 的 `Window` 声明。少一处不是类型报错就是运行时 `undefined`。
- `preload` 只做转发与最小适配（如把启动参数落到 `<html>`），不放业务逻辑。
- 主进程不信任 renderer：参数校验（§3）、**不接收 URL、不接收文件路径**。
  外部打开只能由主进程写死地址（`app:open-home` 是范式）。
- 每个新建 `BrowserWindow` 都要 `hardenWindow(win)`：禁 `window.open`、禁外部导航。
- `webPreferences` 现状与前提：
  - `contextIsolation: true`、`nodeIntegration: false` —— 不动。
  - `sandbox: false` —— 当前唯一理由是 preload 要读 Node 侧的 `process.argv`
    （胶囊主题是启动参数带进来的，见 `main/float.ts`）。**新增 preload 代码不要再去
    碰别的 Node API**，否则这个口子只会越开越大。
  - 若要打开 sandbox，先解决主题传递（`additionalArguments` + `process.argv`），
    并且确认首帧仍然不闪 —— 这是当初不走 IPC 的唯一原因。
- 待办：两个 HTML 目前**没有 CSP**。加之前注意 `index.html` 里有内联脚本（首帧主题），
  不能直接 `default-src 'self'`，需要 hash 或 nonce。

## 7. 渲染层

- 组件只负责渲染。能算的都在 shared 里算完（`format` / `opencode-quota` / `update`
  都是这么拆的），这样能在 Node 下测，也避免同一公式在面板和胶囊里各写一遍。
- 订阅一律在 `useEffect` 里退订。`preload` 的 `onSnapshot` / `onSettings` / `onUpdate` /
  `onFloatExpanded` 都返回 unsubscribe，直接把返回值当 cleanup。
- `window.meter` 可能不存在（浏览器直开、preload 挂了）。调用前判空，界面降级到
  「无数据」，不能白屏 —— 这也是 `global.d.ts` 里写成 `meter?` 的原因。
- **三态必须画全**：正常 / 正在读（`pending`）/ 读到旧值（`stale + error`）。
  把未知画成 0、或把旧值画成「已是最新」，都是 bug。
- 主题落在 `<html data-theme>` / `data-capsule`，CSS 用属性选择器。不要在 TSX 里按
  主题分支写颜色；唯一例外是数据驱动的色值（`Bars` 的 `color`）。
- 格式化只走 `shared/format.ts`（`compact` / `grouped` / `credits` / `percent` /
  `relativeTime`）。别在组件里 `toFixed(2)` 或 `toLocaleString()` 各写一遍。
- 分支按**账本性质**，不按源名字：`hasCredits` / `hasTokens` / `hasReasoning` /
  `hasQuota` 四个谓词决定整块收不放。JSX 里散落 `kind === 'qoder'` 是待清理的写法。
- 交互元素用 `<button>`，装饰层 `aria-hidden`；新增动画要能被
  `prefers-reduced-motion` 关掉。
- 体量：`App.tsx` 已 1546 行、`float.tsx` 723 行。新增功能优先新建组件文件，
  再往这两个文件里堆之前先拆。

## 8. 注释

这个仓库的注释是资产，不是装饰。规则：

- 写**为什么**和**不这样会怎样**，用可搜索的症状原话
  （"今日 0 积分、新会话 0 积分"、"收起卡片闪一下"）。半年后排查靠的就是这几句。
- 一段坑只写一次，写在最靠近它的地方。同一件事在三个文件里各解释一遍，改的时候必漏两处。
- 中文叙述，专有名词保留原文（`traceId` / SQLCipher / WAL / DWM）。
- 反例：`// 累加 token`（把代码翻译了一遍，没信息量）。
- `TODO` 必须带条件与触发时机：`TODO(2026-Q4): WorkBuddy 去掉 subagents 后删掉这条分支`。
  裸 `TODO` 视为未完成。
- 注释里不要写行号（会漂），写函数名。

## 9. 错误处理

| 情形 | 做法 |
| --- | --- |
| 可选数据源不存在 / 库被锁 | 静默降级 + 空账 + 一条 warning（用户能看到原因） |
| 口径对不上（有积分、一条都对不上） | **必须**显式 warning —— 这是最容易静默错的地方 |
| 网络失败 | `stale: true` + `error`，保留旧值，界面标「上次成功于」 |
| 写设置失败 | 静默，但内存值要生效，保证本次会话一致 |
| 清理临时文件失败 | 静默，`/* ignore */` 要写清为什么安全 |

- 禁止 `catch {}` 之后返回 0 冒充真实值。
- `catch { /* ignore */ }` 必须写原因（清理、关闭已失效句柄）。写不出原因，说明它不该被忽略。

## 10. 性能

- 主进程是单线程：一次超过 16ms 的同步工作就会卡托盘与窗口动画。
- 轮询间隔 20 秒，采集必须增量：transcript 按 `offset` 续读，且只吃到最后一个 `\n`
  （半行留给下一轮）；文件变小或 identity 变了就整份重来。见 `parseTranscriptFile`。
- 已知复杂度点：`countSessionsForModel` 与模型积分统计是 O(模型 × 会话 × 调用) /
  O(模型 × 轮次)。当前规模没问题，数据量再涨一个数量级前要改成单遍累加
  （一次遍历同时累加 model → credits、model → sessions）。
- 渲染层 20 秒一次整树更新。派生数据用 `useMemo`，重列表别每次重建对象/数组。

## 11. 测试

- 解析器 / 聚合器改动**必须有夹具用例**：临时目录造文件，不依赖本机真实数据。
- 断言不变量，不写易碎快照：求和一致、去重后计数、边界（0、负数、NaN、缺字段、
  半行 JSON、坏 JSON）。
- 网络一律本地 mock server（`scripts/core-test.ts` 里的 `createServer` 是范例），
  不许打真实接口。
- 时间相关逻辑用注入的 `now`，禁止依赖运行时刻与系统时区。
- `test:core` 与 `test:ci` **都要绿**。只跑一条等于没跑（v0.6.0 的教训在 AGENTS.md §1）。
- 不为「覆盖率」写只调用、不判定的测试。

## 12. 提交与发版

流程见 AGENTS.md §4，这里只补两条判断标准：

- **一个 commit 一件事。**「顺手重构」和「修口径」分开，否则 review 时说不清哪一行
  真的改了数字。
- **改口径必须在正文写「旧值 / 新值 / 差异原因」。** 这是以后唯一能查的线索；
  只写「修复积分统计」等于没写。

## 13. 新增数据源的落地清单

按顺序做完再提 review：

1. `shared/types.ts`：`SourceKind` 加成员（并想清楚它填不填 `credits` / `quota`）
2. `shared/format.ts`：`SOURCE_ORDER`、`sourceLabel`、`hasCredits` / `hasTokens` /
   `hasReasoning` / `hasQuota`
3. `main/paths.ts`：目录 + `WB_TOKEN_METER_*` 覆盖变量
4. `shared/<source>-collector.ts`：纯函数、不引 electron、失败返回空账 + warning、
   支持注入目录与 `now`
5. `main/index.ts`：`currentSource()` / `sourceDir()` / `refresh()` 分支 + 独立的
   ParseCache 实例
6. `main/settings.ts`：白名单跟 `SOURCE_ORDER` 自动生效，仍要确认一遍
7. 测试：夹具 + 交叉验算 + 空目录用例
8. `README.md` 数据来源一节、面板与胶囊的空态 / 加载态

漏掉第 2 步的症状是「源切不过去」；漏掉第 7 步的症状是「CI 绿、本机错」。
