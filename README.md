# dsh-error-digest · 错误汇总

把 DSH 对话日志里的**出错事实**收集起来，跨会话合并、按出现频次排序，并在每条错误后面给出
两个按钮：

| 按钮 | 做什么 |
| --- | --- |
| **分析** | 开启一个新对话，把这条错误的类别 / 来源 / 错误码 / 出现次数 / 最近时间 / 摘要填进输入框，任务是「查根因 + 影响范围 + 修复或规避步骤」 |
| **防范** | 开启一个新对话，任务是「判断该在哪一层拦住它（AGENTS.md 规则 / skill 说明 / 工具校验 / 插件代码 / 文档）+ 最小改动落地 + 后期自查清单」，目标是**以后不再发生** |

两个按钮走的都是宿主自己的「新建对话」通路（`uiWorkspace.startSession`），提示词落在
**新对话的草稿输入框**里：发送这一步仍由用户确认，不会替你按下回车。

打开方式：左侧栏底部的面板图标「错误汇总」。

## 收集哪些错误

| 会话事件 | 含义 | 归类 |
| --- | --- | --- |
| `tool/result` + `data.error` 或 `message.isError` | 工具执行失败（命令非零退出、编辑找不到唯一匹配、参数校验拒绝……） | 工具失败 |
| `turn/end` 且 `reason.kind === 'error'` | 整轮失败（重试耗尽后模型请求仍失败） | 回合失败 |
| `llm/retry` | 一次模型请求失败并触发重试（限流 / 5xx / 超时） | 模型重试 |

## 为什么「合并」和「排序」

同一条错误在一个会话里常常重复几十次。每条错误写入时就压成一个**签名**
（类别 + 工具名/提供方 + 错误码 + 归一化后的首段摘要），同签名累加次数；归一化会抹掉
UUID、长十六进制、绝对路径、行列号、耗时与字节数，但**保留** HTTP 状态码、退出码这类
真正的区分信息。界面上再按签名做一次**跨会话**合并，于是「同一个错误在 20 个会话里各出现
3 次」显示为一行 ×60。

## 实现

- **宿主半**（`index.js` + `src/digest-fold.js`）：注册 `dialogErrors` 会话投影，
  由框架驱动折叠**所有**会话（含未打开的冷会话），并随会话列表 RPC 自动到达客户端。
  附一个只读诊断路由 `POST /dsh-error-digest/debug`（`ping` / `debug`），回答
  「投影注册没有、每个会话折叠出了什么」。
- **客户端半**（`src/digest-model.js` + `src/digest-ui.js` + `src/client-main.js`
  → 构建成 `lib/client.js`）：订阅会话列表快照，只做合并、排序、渲染与按钮动作。
  不 retain 任何会话，因此不会激活别人的历史。

### 按钮是怎么「开启新对话」的

1. `layout.selectPanel(null)` 先切回对话主面板——草稿初始化要求 composer 已挂载，
   否则宿主内部的 `beforeOpen` 会抛错并**静默**中止整次打开；
2. 下一帧调 `uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })`，
   与官方「新建对话」完全同一条通路，且不覆盖用户已有草稿；
3. 300ms 后用「主视图是否变成空白会话」反查结果；没生效就再试一次，
   仍不行则把提示词复制到剪贴板并在控制台留一份——绝不出现「点了没反应」。

`uiWorkspace` / `layout` 都声明为**硬依赖**（`export const inject`）：它们必须由
客户端 ctx 注入，只靠 `ctx.get()` 取服务会出现「点了没反应」。

排障入口（控制台）：

```js
__DSH_ERROR_DIGEST__.snapshot()            // 当前合并结果（与面板同一份逻辑）
__DSH_ERROR_DIGEST__.lastAction()          // 最近一次按钮动作：{ mode, opened, reason, retries }
__DSH_ERROR_DIGEST__.canOpenConversation() // 新建对话通路是否可见
__DSH_ERROR_DIGEST__.trigger('analyze')    // 直接触发第一条的分析动作
```

宿主侧只读诊断：`POST /dsh-error-digest/debug`，回答「投影键注册没有、
每个在挂会话折叠出了什么」。注册失败时界面只会「一条错误都没有」，
这个入口是唯一能区分「没错误」与「没工作」的证据。

状态的形状与上限：

```
{ entries: [{ sig, kind, key, code, detail, count, firstTime, lastTime, lastSeq }],
  calls: { [callId]: toolName } }        // 在途工具调用，仅用于给结果认出工具名
```

- 每个会话最多 60 条不同签名（超出时先砍次数最少的）；
- 在途调用表最多 128 项；
- 摘要最长 240 字符。

## 开发

```powershell
npm run check   # 校验 lib/client.js 与源码一致 + 跑全部单测
npm run build   # 只重新生成 lib/client.js
```

`lib/client.js` 是**生成产物**（`build/bundle.mjs` 把三个源文件内联进
`window.__ModuleLoader__` 工厂），不要手改；改了 `src/` 必须重新构建，
`npm run check` 会在忘记构建时直接失败。

单测分四层：

| 文件 | 覆盖 |
| --- | --- |
| `test/digest-fold-test.mjs` | 哪些事件算错误、同类错误怎么合并、上限、schema、视图引用稳定性 |
| `test/digest-model-test.mjs` | 跨会话合并、频次排序、范围口径、提示词 |
| `test/bundle-test.mjs` | 产物是否最新、是否可解析、协议要素齐不齐 |
| `test/client-half-test.mjs` | 用假 React / 假 ctx 真跑一遍 `apply`：插槽注册、文案键对齐、面板渲染、两个按钮实际调用 |

## 已知边界

- 只统计**本机可见会话**的错误；投影是懒物化的，很久没打开过的历史会话要等它被
  物化一次（打开一次、或产生新事件）才会出现在统计里。
- 分叉出来的会话会把继承前缀里的错误再记一次（分叉即复制历史，符合预期）。
- 按钮把提示词放进草稿，不自动发送：这是刻意的取舍，避免在用户来不及调整目录 / 模型时
  自动消耗一次请求。
