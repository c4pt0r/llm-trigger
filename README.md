# llm-trigger

用自然语言描述触发器，存成结构化的 `IF / THEN` 规则，然后由一个**不调用模型**的引擎按 cron 去判定和执行。

```
$ node src/cli.js add "当 github 上 c4pt0r/jmp2.io 有新 release 而且不是预发布版时，记一条日志"
id: r_015fbbf9
IF/THEN: IF github.release.published (repo=c4pt0r/jmp2.io) WHEN prerelease eq false EVERY "*/10 * * * *" THEN log(text="新 release {{tag}}: {{url}}")
note: 当 c4pt0r/jmp2.io 发布非预发布版的新 release 时，记录一条日志。
guessed: every
model: qwen3.8-flash-next-iq3_s
```

## 核心设计：模型只在编译期

| 阶段 | 谁在做 | 频率 |
|---|---|---|
| 自然语言 → 结构化规则 | **pi 上的本地模型**（`pi -p --mode json`，默认当前会话模型） | 每次编辑规则 |
| 规则合法性 | `src/schema.js` 校验器，对着 `src/catalog.js` 的目录 | 每次写入 |
| 事件判定 + 执行动作 | `src/engine.js` + `src/sources.js` + `src/actions.js`，纯代码 | 每次 cron 命中 |

这样"触发"这件事是可复现、可审计、可测试的：模型不会在半夜因为一次幻觉去 POST 你的 webhook。模型只能从 `catalog.js` 里**已实现**的事件/字段/操作/动作中选择，选不出来就明确拒绝：

```
$ node src/cli.js parse "当我飞书里收到老板消息时提醒我喝水"
rejected:
- model refused: The catalog does not support monitoring incoming messages from Feishu (Lark)...
```

校验失败会带错误信息回灌给模型重试一轮（`maxRounds`），仍不合法就返回 422，绝不存半吊子规则。

## LLM 后端 = pi（不需要 OpenAI key）

`src/pi.js` 起一个一次性、无工具的 pi 进程，读它的 JSONL 事件流：

```
pi -p --mode json --no-session -nt -ns -np -nc --thinking off \
   --model $PI_PROVIDER/$PI_MODEL --system-prompt <compiler prompt> -- <自然语言>
```

- `-nt -ns -np -nc`：关掉工具/skills/prompt 模板/AGENTS.md，编译一次约 60 input tokens、~1s。
- 模型默认取**当前 pi 会话的模型**（`PI_PROVIDER/PI_MODEL`）。不设的话会落到 pi 默认模型，本机默认那个 provider 连不上（`Connection error.`），所以 `pi.js` 里显式钉住。
- 覆盖：`LT_MODEL=provider/id`。

## 存储（SQLite，Node 22 内置 `node:sqlite`，零依赖）

`data/llm-trigger.db`：

- `rules`：`raw`（原句）+ `if_json`/`then_json`（结构化）+ `rendered`（确定性的 `IF ... WHEN ... EVERY ... THEN ...` 文本）+ 把 `source/event/action/every` **摊平成列**，于是"哪些规则在看 github release"是一句 SQL；`state_json.seen` 是去重键集合。
- `fires`：每次检查的事件、是否命中条件、动作状态（`baseline`/`fired`/`no_match`/`dry`/`error`/`skipped`）。

`rendered` 由代码从结构化数据生成，**不是**模型写的，所以 UI 上那行 IF/THEN 一定等于实际执行语义。

## 事件目录（可扩展点）

| event | 源 | 去重键 | 可用字段 |
|---|---|---|---|
| `github.release.published` | github | tag | tag,name,url,published_at,prerelease,body |
| `github.issue.opened` | github | number | number,title,author,url,labels,created_at,body |
| `github.pr.opened` | github | number | number,title,author,url,draft,created_at |
| `github.pr.merged` | github | number | number,title,author,url,merged_at |
| `github.commit.pushed` | github | sha | sha,message,author,url,date |
| `github.star.count` | github | stars | stars,url |
| `http.json.changed` | http | value | value,status,url |
| `time.schedule` | time | now | now,date,time,weekday |

条件 op：`eq ne contains not_contains matches gt gte lt lte in exists`
动作：`log`、`webhook.post`、`lark.webhook`、`shell.exec`（需 `ALLOW_SHELL=1`）

加一个新事件 = 在 `catalog.js` 加一行（字段 + 去重键）+ 在 `sources.js` 加取数分支。校验器和提示词会自动跟上，因为它们都读同一份 catalog。

## 用法

```bash
npm run cli -- add "有人在 c4pt0r/jmp2.io 提 PR，标题带 OOM 且不是 draft，就 POST 到 https://x/hook，每小时查一次"
npm run cli -- list
npm run cli -- run <id> --dry        # 试运行：判定但不执行动作
npm run cli -- run <id> --all        # 忽略去重历史，重放全部已知事件
npm run cli -- fires <id> --limit 20
npm run cli -- events | actions      # 看目录
npm start                            # HTTP API + 网页 + 调度器（默认 127.0.0.1:8787）
npm test
```

HTTP API：`POST /api/parse`（只编译）、`POST /api/rules`（编译并保存）、`PUT /api/rules/:id`（人工编辑结构化 JSON，走同一个校验器）、`PATCH`（启停）、`POST /api/rules/:id/run {dry,force}`、`GET /api/fires`、`GET /api/catalog`。

## 两个容易踩的行为

1. **首次检查是 baseline**：新规则第一次只把已存在的历史事件记成 `baseline`，不触发（否则新加一条 release 规则会立刻打 10 次 webhook）。要重放用 `--all` / `{"force":true}`。
2. **去重是"每事件一次"**：命中与否都会把该事件写进 `seen`。动作失败会记成 `error` 但不会自动重试——避免坏 webhook 被无限打；要重试就手动 `run --all`。

## 安全边界

- 默认只监听 `127.0.0.1`；`shell.exec` 必须服务端 `ALLOW_SHELL=1` 才启用，否则记 `skipped`。
- 目前**没有** API 鉴权，别把它暴露到公网。
- GitHub 未认证限 60 req/h；设 `GITHUB_TOKEN` 提高配额。

## 已知边界 / 下一步

- 事件目录是白名单，github/http/timer 三类源；要 webhook-in（"有人 push 就立刻"）需要加一条入站路由，把 fact 直接喂给 `engine`。
- 单进程调度，无分布式锁；多实例会重复触发。
- 规则没有"组合"（AND/OR 跨事件），只有单事件 + 条件合取。
