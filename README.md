# OpenCode 额度

一个 Hana v2 App。一张卡片，上下两段，把 OpenCode Go 和 Command Code 两套额度放在一页里，不用再分别登录两个网页。

## 一页看什么

**上面一段：OpenCode Go**

| 窗口 | 含义 |
|---|---|
| 5 小时 | 滚动窗口，占月额度的 20%，用满会立刻卡住 |
| 本周 | 占月额度的 50% |
| 本月 | 月额度基准，100% |

**下面一段：Command Code**

| 行 | 含义 |
|---|---|
| 5 小时 | 滚动窗口的已用额度 / 上限 |
| 本周 | 本周窗口的已用额度 / 上限 |
| 本月 | 已用金额占本月额度池的比例 |

最后一行显示 `余额 $x / $y` 和当前套餐。

每个窗口压成一行：标签、进度条、百分比、重置倒计时。用量过 70% 转黄，过 90% 转红，阈值可在设置里改。副标题会主动指出当前最紧的是哪个窗口，省得自己比较六个数字。

## 它同时是一个工具

除了卡片，还注册了一个 `opencode_quota` 工具给 Agent 用。人看到 62% 只能决定「省着点」，Agent 看到同一个数能决定「这个任务换便宜模型跑，把额度留给关键判断」。

在 Hana 设置里给对应 Agent 开启这个 App 的工具权限后，Agent 就能在跑长任务前自己先查一次。

## 安装

1. 在 Hana 的应用管理里导入这个目录，或 `dist/` 下的安装包
2. 确认安装卡（只申请两样：访问 `opencode.ai` 与 `api.commandcode.ai` 两个域名的 GET 权限、把工具暴露给模型）
3. 打开 Hana 设置页，左侧导航里找「OpenCode 额度」，填 key

两把 key 都是可选的：只填一把，另一段会安静地写「还没填 key」，不报错也不占版面。

## 拿 key

**OpenCode**：登录 [opencode.ai/console](https://opencode.ai/console)，账户菜单 → Personal API keys → 新建。权限选只读，有效期按需，30 天也够用，到期重建。

**Command Code**：登录 [commandcode.ai](https://commandcode.ai) 后台，建一把 API key，通常以 `user_` 开头。

两把都只需要读额度，不需要付费、预算或写权限，随时可以吊销。

## 刷新节奏

- **取数 5 分钟一次**，且只在卡片可见时发生。切走或卡片被遮住就不刷，切回来补一次
- **倒计时每秒在走**，但那是本地算的，不发请求
- 两段共用同一个定时器和同一次请求，一次刷新等于上游 4 个请求
- 「刷新」按钮走同一条路，点一下两段一起重取

## 数据从哪来

**OpenCode**：`GET https://opencode.ai/zen/go/v1/usage`，Bearer 认证，返回三档窗口的百分比和重置时间。

**Command Code**：四个端点，同样 Bearer 认证。

| 端点 | 用途 |
|---|---|
| `/alpha/whoami` | 账户与组织 |
| `/alpha/billing/credits` | 余额、两个窗口的用量与重置 |
| `/alpha/billing/subscriptions` | 套餐与计费周期 |
| `/alpha/usage/summary` | 本周期已用金额 |

**这两个服务的接口都没有正式文档。** OpenCode 公开的 Console API 只有 budgets 那一条（返回月度花费而非套餐窗口），相关请求见 [anomalyco/opencode#31084](https://github.com/anomalyco/opencode/issues/31084)；Command Code 的 alpha 端点是社区从 CLI 的 `/usage` 命令里摸出来的。

所以它们随时可能变。这个 App 的设计原则是：**接口一坏就明确说坏了，不拿上一次的数据装作还在工作。**

## 已知的边界

- **OpenCode 只有百分比，没有金额。** 端点不返回美元数。
- **OpenCode 没有按模型的明细。** 传 `?model=` 参数无效，返回的始终是套餐整体视角。
- **Command Code 的月度额度是算出来的，不是接口直接给的。** 它只提供 5 小时和本周两个窗口，月度用「已用 ÷（已用 + 余额）」推得。
- **Command Code 的 5 小时窗口在没用量时没有重置时间。** 接口此时返回 `0`，卡片显示「未开始」，因为这个窗口里还没有任何请求，没有东西会滑出去。

## 错误怎么读

卡片不会只说「失败」，每种失败都有对应的话：

| 代码 | 意思 |
|---|---|
| `NO_KEY` | 那一段还没填 key |
| `KEY_MALFORMED` | key 那一栏里有中文或全角符号（会指出是第几个字符） |
| `KEY_MASKED` | 读到的是 `********` 掩码，真正的值没存进去 |
| `KEY_INVALID` | 401，key 失效或过期 |
| `NO_ACCESS` | 403，key 没有该服务的权限 |
| `ENDPOINT_MOVED` | 404，接口搬家了，需要更新这个 App |
| `NETWORK` | 请求真的没发出去 |
| `SURFACE_EXPIRED` | 卡片挂太久，会话过期，关掉重开或重载应用 |

## 设置项

| 字段 | 说明 |
|---|---|
| `apiKey` | OpenCode API key，敏感字段 |
| `commandCodeKey` | Command Code API key，敏感字段 |
| `warnPercent` | 转黄阈值，默认 70 |
| `dangerPercent` | 转红阈值，默认 90 |

## 开发

```sh
# 静态校验
node <hana-app-creator>/scripts/validate_app.mjs --dir . --json

# 启动冒烟（需要 Electron 运行时）
node <hana-app-creator>/scripts/validate_app.mjs --dir . --smoke --json

# 打包
node <hana-app-creator>/scripts/pack_app.mjs --dir . --publisher "Allan" --out ./dist
```

目录结构：

- `index.js` 后端入口：两段取数、错误分类、注册工具与路由
- `ui/panel.html` + `ui/assets/panel.js` 卡片界面
- `sdk/` 随包携带的 Hana App SDK，运行时不依赖宿主 `node_modules`

## 许可

MIT
