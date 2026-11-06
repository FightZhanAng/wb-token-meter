# Review 检查清单

配套 [代码规范](./code-style.md)。规范说「怎么写」，这里说「怎么验收」。

本仓库没有 PR 上的 CI（`release.yml` 只在推 `v*` 标签时跑），所以**这份清单就是门禁**。
别指望自动化兜底。

---

## 用法

一次 review 分三轮，顺序不要换：

| 轮次 | 看什么 | 产出 |
| --- | --- | --- |
| 第一轮 | 意图与影响面（先不看代码） | 判断这是不是「改口径」的改动 |
| 第二轮 | 按 🔴 / 🟡 / 💭 过一遍 | 具体到函数与行为的意见 |
| 第三轮 | 按改动类型加查 | 该类型专属的遗漏项 |

时间紧就只做第一轮 + 🔴 那一节。**跳过第一轮直接看 diff，最容易放过口径错误** ——
代码本身挑不出毛病，数字整体偏了 30%。

---

## 第一轮：先不看代码，问四个问题

1. 这段改动回答的是**哪个数字 / 哪个动作**？说不出来就是没想清楚。
2. **读不到的时候，用户看到什么？** 是骨架、是「上次成功于 X」，还是一个 0？
3. 什么情况下它会给出一个**看起来合理但错的值**？—— 这一问答不出来，本轮不通过。
4. 影响面是**一个源**还是**所有源**？改 `collector.ts` 与改 `traecn-collector.ts`
   的审查强度不一样。

第 2、3 问是这个项目的核心。绝大多数线上问题不是崩了，是「数字不对但没人发现」。

---

## 第二轮：按优先级过

### 🔴 Blocker（必须改，否则不能合入）

| # | 类别 | 判据 | 本仓库的真实形态 |
| --- | --- | --- | --- |
| 1 | 口径分叉 | 自己拼计费键 / 自己解析 `credit_json` | 必须走 `billingKey()` + `creditOf()`；新增一处就是两个口径 |
| 2 | 重复计数 | 同一计费键在会话维与日/模型维各算一次；父会话与 `subagents/` 重复 | 一个 `conversationRequestId` 下有多轮调用，逐次累加会翻倍 |
| 3 | 未知伪装成 0 | 采集失败返回空账，却没有 `pending` / `warning` / `stale` | 界面画出一个「今天没用」的 0，用户信了 |
| 4 | 时区 | 用 `toISOString()` 当日期 | 东八区 00:00–08:00 全算到昨天 |
| 5 | 缓存被污染 | 返回缓存对象后调用方 `push` / 赋值 | `warnings` 数组曾越积越多，必须浅拷贝 |
| 6 | 采集抛异常 | 未兜住的 `readFileSync` / `openSync` / 解密，打断 20 秒轮询 | 整个源停更，界面显示旧值且不标 stale |
| 7 | 阻塞主进程 | 同步解密、大文件全量解析、网络请求进了 `refresh()` | 托盘卡住、窗口动画掉帧；`traecn` 必须异步 + 缓存 |
| 8 | 自触发循环 | `pull()` 完成后无条件 `refresh()`，且 `pull` 不幂等 | `traecn` 曾因此每圈全量解密，主进程忙死 |
| 9 | 凭证泄漏 | 打印 key / token；把凭证写进 `error`、`warnings`、`credential`、日志、提交信息 | 只允许写来源描述，不写值 |
| 10 | IPC 越权 | 接收 renderer 传来的 URL / 路径；`patch` 不校验；新通道缺 preload 声明 | `settings:update` 必须过 `parseSettings` |
| 11 | 窗口未加固 | 新建 `BrowserWindow` 没调 `hardenWindow()`；动 `contextIsolation` / `nodeIntegration` | 新窗口 = 新攻击面 |
| 12 | 契约破坏 | 改 `Snapshot` / `Settings` / `FloatState` 字段语义，渲染层与测试没跟 | 典型：把「未知」从 0 改成 `null` 却没改 UI |
| 13 | 数据破坏 | 写 / 删用户目录；「清理」逻辑作用到真实数据 | 采集器只读；复制库到临时目录再开 |
| 14 | 关键路径吞错 | `catch` 后继续用未初始化 / 半初始化的值 | 典型：catch 里只留一句日志，随后仍把半成品或上一轮的对象推给界面 |
| 15 | 不可测试 | 采集器直接读 `homedir()`，不接注入的目录参数 | 后果是只能靠本机真实数据验，CI 走不到 |

判定 1、2 时不要凭印象：**打开 `collector.ts` 对照 `billingRounds()` 与主循环的
`creditedKeys`**，确认两处去重口径一致。

### 🟡 Suggestion（应该改，可另起一次）

- **命名与单位**：`ratio`（0..1）和 `percent`（0..100）混用；字段名不带单位。
- **重复代码**：五段 `bundle.x += stat.x` 可以抽 `addBundle()`；两处相同的兜底对象可以抽常量。
- **复杂度**：`countSessionsForModel` 与模型积分是 O(模型 × 会话 × 调用) / O(模型 × 轮次)，
  应改成单遍累加。
- **失控分支**：`refresh()` 已是十段 if-else，新增源应改成
  `Record<SourceKind, () => Snapshot>` 注册表。
- **缺测试**：解析器改动没有夹具用例；只在本机真实数据上验过。
- **文案不可行动**：warning 写「读取失败」，应写清**哪个目录、用户能做什么**
  （启动应用 / 检查权限 / 忽略）。
- **增量解析破了边界**：把末尾半行算进去 / 文件截断后沿用旧 offset / 只按 size 判断
  而不管 identity。三条里任何一条都是**静默丢数据** —— 界面一切正常，数字只是少了。
- **组件体量**：单文件 > 800 行或单组件 > 300 行；`App.tsx` 已到必须拆的阈值。
- **注释只描述行为**：`// 累加` 这种；应写为什么与坑。
- **渲染层散落源判断**：`kind === 'qoder'` 应改走 `hasTokens()` 这类谓词。

### 💭 Nit（可以不改）

- 空行、引号、import 顺序（本项目无 linter / formatter，靠保持一致）。
- 可以去掉的 `as`、可以内联的中间变量。
- 注释里写死了行号（会漂）。
- 测试标签措辞。

**不要**把 nit 混进 blocker 一起说 —— 会让人分不清哪些必须改。

---

## 第三轮：按改动类型加查

### A. 新增数据源

逐条对照 [code-style §13](./code-style.md#13-新增数据源的落地清单) 的 8 步。
最常见的漏项是 `SOURCE_ORDER` / `sourceLabel`（症状：源切不过去、菜单里没有），
以及空目录用例（症状：CI 绿、本机错）。

另外确认：

- [ ] 空目录 / 目录不存在 / 文件正在被写，三种情况都不抛
- [ ] 该源没有的概念（token / 积分 / 思考）整块收起，不画 0
- [ ] 胶囊与面板都能显示这个源（两套界面都要过一眼）
- [ ] README「数据从哪来」补了一节，写清口径（input 含不含缓存）

### B. 改采集口径（风险最高）

- [ ] 旧值 / 新值 / 差异原因写在 commit 正文里
- [ ] 交叉验算仍然成立：`Σsessions = Σdays = Σmodels = Σprojects = totals`
- [ ] 去重逻辑（会话维 + 日/模型维）同步改了
- [ ] 用真实数据跑过一遍，并说明差异量级（例如「总额 +0.4%，来自 xx」）
- [ ] `round2()` 仍只在出口调用
- [ ] 老数据仍能读（口径切换通常有过渡期，两个键都要试）

### C. 改界面

- [ ] 三态齐全：正常 / `pending` / `stale + error`
- [ ] 浅色与深色都看过（截图）；深色下的颗粒层是 3.5%，别调成纯黑
- [ ] 窗口最小宽度 460 下不溢出、不重叠
- [ ] 数字格式走 `shared/format.ts`，没有新写的 `toFixed`
- [ ] 装饰元素 `aria-hidden`，交互元素是 `<button>`
- [ ] 新增文案是中文，且说人话（不出现 `undefined` / `NaN` / 空括号）

### D. 窗口与几何（胶囊 / 标题栏）

- [ ] 胶囊位置唯一真相是 `origin`，不是 `bounds`
- [ ] 收起 / 展开幂等，来回切不漂
- [ ] 透明窗口**不做 resize**（用 `setShape`）；solid 模式才走 resize + 握手
- [ ] 改 `floatTheme` 要重建窗口（`transparent` 是创建参数）
- [ ] 非 100% 缩放下也验过（透明窗口「存在但不可见」的老问题）
- [ ] `CAPTION_HEIGHT` 与 `styles.css` 里 `.app-caption` 对得上

### E. 设置与持久化

- [ ] 新字段进了 `parseSettings` 的白名单 / 类型校验（`patch` 运行期也要过一遍）
- [ ] 有合理默认值，且默认值是「安全」的那一侧（自动下载默认关）
- [ ] 配置文件损坏时只回退单个字段，不整体重置
- [ ] 新增枚举走 `*_ORDER` 数组，别在 `isXxx` 里硬编码列表
- [ ] 敏感值不落盘（明文 key 一律不存）

### F. 更新与发版

- [ ] `unsupported` 不显示「已是最新」，要说明原因
- [ ] `--publish never` 还在 `dist` 脚本里
- [ ] Release 四个附件齐全：`*-setup.exe`、`*-portable.exe`、`latest.yml`、`*.blockmap`
- [ ] 版本号只改 `package.json` 一处；tag 用带注释的
- [ ] 判断发版成功看 Release 附件，不看 Actions 的颜色（可能有重复投递的红叉）

### G. 依赖与构建

- [ ] `electron` 版本与 `../water-reminder` 一致（二进制是复制过来的）
- [ ] 改了 `package.json` 任何字段后，`pnpm <script>` 可能因依赖检查失败 ——
      改用直接调二进制（AGENTS.md §1），别以为是代码坏了
- [ ] `build` 排在一轮命令的最前面（删除额度按轮累计）

### H. 文档与资源

- [ ] `docs/preview-dark.jpg` 仍是 JPEG（转 PNG 会从 76KB 涨到 820KB）
- [ ] 其它截图仍是 PNG（无颗粒，PNG 更小）
- [ ] README 的环境变量表补了新变量
- [ ] AGENTS.md 只加「不知道就会踩」的操作规则，不搬架构说明

---

## 验证证据（缺一项就打回）

提交信息或 PR 描述里必须有：

1. `pnpm typecheck` 通过（node + web 两套）
2. `pnpm test:core` 与 `pnpm test:ci` **都**通过
3. `pnpm build` 通过
4. 行为变更的证据：截图，或 `%TEMP%\wbtm-smoke\*.json` 里的关键字段
5. 一句影响面：「只影响 traecn 的 credits，其余源数字不变」

只有「跑通了」没有输出，不算证据。只贴 `test:core` 不贴 `test:ci`，按未验证处理。

---

## 合并门禁（命令顺序有讲究）

```bash
# 1) 构建类放最前面：safe-delete 的额度按「轮」累计
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
node node_modules/electron-vite/bin/electron-vite.js build

# 2) 测试（两条都要）
node node_modules/typescript/bin/tsc -p tsconfig.test.json && node .tmp-test/scripts/core-test.js
node scripts/test-ci.mjs
```

`pnpm` 版本等价，但改过 `package.json` 后它会触发依赖检查并失败（AGENTS.md §1）。
删除操作放最后，且走 .NET。

---

## 评论怎么写

格式固定四段，缺一段别人就得反问一次：

```text
🔴 数据口径：新增的「按工具」维度会重复计数
位置：collector.ts，新增的 toolMap 累加处
为什么：会话维用的是函数级 creditedKeys，而这段把 seen 建在了会话循环里。
        同一个计费键跨会话出现时（会话分叉、子代理归到父会话），
        sessions 维只算一次、这个维度算两次，求和就对不上 totals。
建议：复用顶部那个去重集合，或把 seen 提到与 creditedKeys 同一层。
验证：跑 test:core 的「各维度求和一致」断言，再对比一次总额。
```

反例（不要这样写）：

- 「这里有点问题」—— 哪个问题？
- 「建议重构一下」—— 改成什么？为什么现在这样不行？
- 「不符合规范」—— 第几条？规范没写的，就别说「不符合」。

**该夸的时候夸一句**：把「先探测再解析」「缓存浅拷贝」这类正确取舍点出来，
比只挑错有用 —— 下次别人会照着做。

---

## 记忆表：这个仓库踩过的坑

Review 时看到相似形状，直接对照。

| 症状 | 根因 | 对应规则 |
| --- | --- | --- |
| 新会话积分 0，累计总额却是对的 | 计费键从 `traceId` 换成 `conversationRequestId` | 两个键都试；见 `billingKey()` |
| 积分被放大数倍 | 一个计费回合多轮工具调用，逐次累加 | 按 key 去重，三个粒度都要 |
| 会话列表两条同 id | `<id>.jsonl` 与 `<id>/subagents/*.jsonl` 未归并 | `scanTranscripts()` 按 sessionId 合并 |
| 缓存里 warning 越积越多 | 复用了缓存对象里的数组 | 缓存对象必须浅拷贝后再改 |
| 界面显示 0，实际在扫密钥 | 缺 `pending` 语义 | 「读不到」不许画成 0 |
| 托盘卡死 / CPU 飙高 | `pull()` 后无条件 `refresh()`，自己触发自己 | `pull` 必须幂等 + 节流 |
| 改了 version 就 `pnpm` 报错 | 依赖检查判定过期 | 直接调二进制（AGENTS.md §1） |
| `build` exit 1 且无任何输出 | 沙箱拦了 `out/` 清理 | 重跑；别串在长 `&&` 里 |
| 打包报 `ECONNREFUSED 127.0.0.1:443` | hosts 把 GitHub 指到黑洞 | 只能走 `node scripts/dist.mjs` |
| `test:core` 偶发「数据源标记没被串改」红 | WorkBuddy 正在写库，直开与副本两份都读失败 → 空表，`dbRows` 掉到 0 | 是 `readDatabase` 的兜底，不是串源 |
| 更新检查报「找不到版本信息」 | Release 缺 `latest.yml` / `blockmap` | 看附件，不看 run 颜色 |

---

## 现有代码的待办（backlog，不算本次 review 的 blocker）

评审时看到这五处，记下来即可，不要顺手在无关改动里改：

1. `collectSnapshot` 里 `countSessionsForModel` + 模型积分是嵌套遍历 → 改单遍累加。
2. `refresh()` 的十段 if-else → 改 `Record<SourceKind, ...>` 注册表，新增源不用动主流程。
3. `parseUsageLine` 的 `Record<string, any>` → `unknown` + 守卫。
4. `index.html` / `float.html` 都没有 CSP → 需先处理内联脚本（hash 或 nonce）。
5. `readDatabase` 两条路径都失败时返回空表，只挂一条「将显示为 0」的 warning →
   应改成 `pending`，和 traecn 取密钥同一套语义（读不到就是读不到，不是 0）。
   它也是 `test:core` 里「数据源标记没被串改」偶发红的原因。

这五条的共同点：**现在能用，但每加一个源/一份数据就更难改**。改的时候单独提交，
别和口径修复混在一起。
