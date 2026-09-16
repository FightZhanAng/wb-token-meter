# Token 计量器

**一个给 [WorkBuddy](https://www.workbuddy.cn/) 用的本地用量面板。**

WorkBuddy 采用积分制，界面上只显示积分、看不到 token 消耗。但每次模型调用的
官方 token 数据其实都写在本地磁盘上 —— 这个工具把它读出来，做成常驻托盘的用量面板。

> 非官方第三方工具，与 WorkBuddy 官方无关。
> 所有数据都在本地读取和计算：不联网、不上传、不修改任何原始文件。

## 下载

到 [Releases](https://github.com/FightZhanAng/wb-token-meter/releases) 下载：

- `wb-token-meter-<版本>-setup.exe` —— 安装版，带开始菜单与桌面快捷方式
- `wb-token-meter-<版本>-portable.exe` —— 免安装版，双击即用

![界面预览](docs/preview.png)

## 数据从哪来

**不需要估算，也不需要调接口。** WorkBuddy 把精确的 token 用量写在本地磁盘上，
只是没在界面上展示。三处数据源：

| 数据源 | 位置 | 内容 |
|---|---|---|
| 会话记录 | `~/.workbuddy/projects/<项目>/<会话id>.jsonl` | 每次模型调用的 `providerData.usage`：输入 / 输出 / 总量 / 缓存命中 / 思考 token，外加模型名与 traceId |
| 积分明细 | `~/.workbuddy/workbuddy.db` → `session_usage` | `credit_json` = `{traceId: 积分数}`；另有上下文水位 `used / size` |
| 会话元数据 | 同库 `sessions` 表 | 标题、模型、工作目录、状态 |

`providerData.traceId` 是串联三者的钥匙 —— 它同时出现在会话记录和积分明细里，
所以 token 消耗和积分扣费可以逐回合对上。

### 积分口径

积分以数据库记录为**权威口径**，不是用 token 反推的：

- `credits` —— 数据库里所有计费记录的总和
- `attributedCredits` —— 其中能对应到本地会话明细的部分
- `unattributedCredits` —— 只有计费记录、会话明细已被清理的部分

界面底部会把最后一项单独列出来，避免总额平白少一截。

### 两点实测结论

- 累计输入 token 远大于「信息量」，因为每轮都要重发完整上下文。
  本机实测缓存命中占了输入的 ~96%，讨论用量时得看这一项。
- token 与积分**不是线性关系**（本机实测在 12 万 ~ 120 万 token/积分之间浮动），
  推测缓存命中和思考 token 的计价权重不同。界面上的比价是全局粗算，仅供参考。

## 运行

```bash
pnpm install
pnpm gen:icons     # 生成应用图标与 11 帧托盘进度环（纯 Node，无原生依赖）
pnpm dev           # 开发模式
pnpm typecheck
pnpm test:core     # 无头验证解析与聚合逻辑，不依赖 Electron
pnpm build         # 产物到 out/
pnpm dist          # 打包 Windows 安装包与免安装版到 release/
```

> 如果 `node_modules/electron/` 下缺 `dist/` 和 `path.txt`（pnpm 有时会静默跳过
> postinstall），从同机另一个 Electron 项目复制这两样即可，两边版本要一致 ——
> 本机的 43.3.0 二进制是从 `../water-reminder` 复制过来的。

### 环境变量

| 变量 | 用途 |
|---|---|
| `WB_TOKEN_METER_DIR` | 覆盖数据目录，默认 `~/.workbuddy`（便于测试） |
| `WB_TOKEN_METER_SMOKE=1` | 冒烟自检：把启动状态写到 `%TEMP%\wbtm-smoke\` |
| `WB_TOKEN_METER_SMOKE_EXIT=1` | 自检报告写完后自动退出 |

启动后**不会弹主窗口** —— 看右下角的托盘图标：单击打开面板，右键出菜单，
菜单里能控制桌面胶囊。关窗只是隐藏，要退出得点菜单里的「退出」。

## 发布

推一个 `v*` 标签，GitHub Actions 会自动打包并创建 Release：

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

也可以在仓库的 Actions 页面手动触发 —— 手动跑只把安装包留档成 artifact，不发 Release。

CI 用 GitHub 官方下载源；本地 `pnpm dist` 默认走 npmmirror（这台机器直连
GitHub Downloads 会卡在证书吊销检查上）。两边都靠 `ELECTRON_MIRROR` 环境变量切换，
`scripts/dist.mjs` 只在未设置时才补默认值。

## 界面

- **今日** —— token 与积分，以及今日的 token/积分比价
- **当前会话上下文** —— 上下文水位进度条，超过 70% 转琥珀、90% 转红
- **Token 结构** —— 输入 / 缓存命中 / 输出 / 思考 的分布
- **近 14 天** —— 每日 token 柱状图（悬停看当日积分）
- **活跃热力图** —— 近 26 周，GitHub 贡献图那种格子；越深表示当天 token 越多
- **按模型 / 按项目** —— 用量排行
- **会话排行** —— 每个会话的 token、积分、调用次数、上下文水位

![热力图](docs/preview-heat.png)

托盘图标是一圈进度环，表示当前活跃会话的上下文水位，颜色随水位变化；
悬停显示今日 token 与积分；右键菜单可以刷新、控制桌面胶囊、打开数据目录、退出。

关窗即隐藏到托盘，只有菜单里的「退出」才会真正结束进程。

## 桌面胶囊

常驻桌面的小胶囊，显示今日 token、积分与上下文水位环。拖动移动并自动记住位置，
单击打开主面板。

![胶囊](docs/preview-float.png)

**在胶囊上右键、在托盘图标上右键，弹出来的是同一份菜单。**

| 菜单项 | 能改什么 |
|---|---|
| 桌面胶囊 | 显示 / 隐藏 |
| 胶囊尺寸 | 小 / 中 / 大（胶囊本体 152×44、198×56、252×68） |
| 胶囊不透明度 | 100% ~ 50% |
| 胶囊始终置顶 | 是否压在其它窗口之上 |
| 复位胶囊位置 | 丢回主屏右下角 |
| 胶囊实心底色 | 关掉透明，改用白色矩形窗口（见下方取舍） |

设置存在 `%APPDATA%/wb-token-meter/wb-token-meter.json`（开发态则在 Electron 的默认 userData 下）。

**四个刻意的取舍**：

- 窗口比胶囊大 12px（`SHADOW_PAD`）。这圈留白不是装饰：`box-shadow` 画在元素
  外侧，窗口若和胶囊一样大，阴影会被窗口边界切平、露出一条直边，看起来就像
  胶囊外面糊了一层底色。所以阴影的 `|offset-y| + blur` 必须小于这个留白
  —— 别随手把 blur 调到 20px 以上。
- 胶囊默认是**半透明圆角**。透明窗口在部分 Windows 环境（显示缩放非 100%、
  特定显卡驱动）会「窗口存在但屏幕上看不见」，所以留了**实心底色**当降级开关。
  切换它会重建窗口 —— `transparent` 是创建参数，运行期改不了。
- 单击与拖动**共用一套指针事件**，位移超过 3px 才算拖动。用 CSS 的
  `-webkit-app-region: drag` 拖动更顺，但它会把 click 事件整个吃掉，
  就没法「点击打开面板」了。
- 胶囊最大档也只有 252×68。透明窗口不做逐像素命中测试，整块矩形都会挡住
  下面窗口的点击，做大了很烦人。

## 已知限制

- 少数计费回合（本机实测约 4/47）找不到对应的会话明细，通常是会话已被清理 —— 界面会提示这部分「未归因」积分。
- 会话记录是 JSONL，体量可能到几 MB。首次扫描本机 25 个会话约 0.6 秒，之后靠文件 mtime 缓存增量跳过。
- `workbuddy.db` 带 `-wal` / `-shm`，且可能被运行中的 WorkBuddy 持有。程序先尝试只读直开，失败就把三件套复制到临时目录再读。

## 许可

MIT
