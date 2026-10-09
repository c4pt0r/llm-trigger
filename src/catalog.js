// The contract between "LLM-authored rules" and "deterministic runtime".
// Anything not listed here cannot be produced by the parser, so a rule can
// never reference an event/field/op/action the engine doesn't actually implement.

export const SOURCES = {
  github: { required: ["repo"], optional: ["token_env"], note: "repo = owner/name" },
  http: { required: ["url"], optional: ["path", "headers"], note: "path = dot path into JSON body" },
  time: { required: [], optional: [], note: "pure schedule, no external fact" },
  observe: { required: ["what"], optional: ["url", "command"], note: "开放观察：url 或 command 必须给一个；what = 用户想盯的事（原话）。command 需 ALLOW_SHELL=1" },
};

// event -> { source, summary, fields, key }
// `key` is the field(s) used for once-per-event dedup.
export const EVENTS = {
  "github.release.published": {
    source: "github",
    summary: "仓库发布了新的 release",
    fields: { tag: "string", name: "string", url: "string", published_at: "datetime", prerelease: "bool", body: "string" },
    key: ["tag"],
  },
  "github.issue.opened": {
    source: "github",
    summary: "有人新建 issue（不含 PR）",
    fields: { number: "int", title: "string", author: "string", url: "string", labels: "list", created_at: "datetime", body: "string" },
    key: ["number"],
  },
  "github.pr.opened": {
    source: "github",
    summary: "有人提交了 PR",
    fields: { number: "int", title: "string", author: "string", url: "string", draft: "bool", created_at: "datetime" },
    key: ["number"],
  },
  "github.pr.merged": {
    source: "github",
    summary: "有 PR 被合并",
    fields: { number: "int", title: "string", author: "string", url: "string", merged_at: "datetime" },
    key: ["number"],
  },
  "github.commit.pushed": {
    source: "github",
    summary: "默认分支上有新 commit",
    fields: { sha: "string", message: "string", author: "string", url: "string", date: "datetime" },
    key: ["sha"],
  },
  "github.star.count": {
    source: "github",
    summary: "仓库 star 数（阈值/变化触发）",
    fields: { stars: "int", url: "string" },
    key: ["stars"],
  },
  "http.json.changed": {
    source: "http",
    summary: "轮询一个返回 JSON 的 URL，值变化时触发",
    fields: { value: "any", status: "int", url: "string" },
    key: ["value"],
  },
  "time.schedule": {
    source: "time",
    summary: "纯定时（没有外部事件）",
    fields: { now: "datetime", date: "string", time: "string", weekday: "string" },
    key: ["now"],
  },
  "observe.changed": {
    source: "observe",
    summary: "通用观察：轮询 url（或本地命令输出）做快照，内容变化时触发；fact 带 previous/content 两个快照，配合 agent 条件判定“用户描述的事是否发生”",
    fields: { what: "string", content: "string", previous: "string", changed: "bool", digest: "string", url: "string" },
    key: ["digest"],
  },
};

export const OPS = {
  eq: { args: 1, note: "严格相等（bool/int/string 归一化后比较）" },
  ne: { args: 1, note: "不等" },
  contains: { args: 1, note: "字符串包含，或 list 含某元素；大小写不敏感" },
  not_contains: { args: 1, note: "上述取反" },
  matches: { args: 1, note: "正则（JS RegExp，大小写不敏感）" },
  gt: { args: 1, note: "数值/日期大于" },
  gte: { args: 1, note: "数值/日期大于等于" },
  lt: { args: 1, note: "数值/日期小于" },
  lte: { args: 1, note: "数值/日期小于等于" },
  in: { args: 1, note: "value 是数组：字段值落在集合内" },
  exists: { args: 0, note: "字段存在且非空" },
  agent: { args: 1, note: "语义判定：value 是一句 yes/no 问题，检查时由本地模型对事件裁决；field 可为具体字段或 * 表示整个事件。运行期唯一会调模型的 op，仅对通过确定性条件的新事件调用" },
  script: { args: 1, note: "脚本判定：value 是本地命令，事件 JSON 从 stdin 传入（LT_EVENT/LT_FIELD 环境变量带上下文），退出码 0 = 通过。需 ALLOW_SHELL=1；field 可为具体字段或 *。仅对通过确定性条件的新事件调用" },
};

export const ACTIONS = {
  log: { params: { text: "template" }, note: "只写本地 fire 日志（默认，最安全）" },
  "webhook.post": {
    params: { url: "template", body: "template" },
    required: ["url"],
    note: "POST JSON 到任意 URL",
  },
  "lark.webhook": {
    params: { url: "template", text: "template" },
    required: ["url"],
    note: "飞书自定义机器人 webhook（msg_type=text）",
  },
  "shell.exec": {
    params: { command: "template" },
    required: ["command"],
    note: "执行本地命令；需服务端 ALLOW_SHELL=1 才启用",
    gated: "ALLOW_SHELL",
  },
};

// {{field}} templates are rendered from the fact object.
export function eventsForSource(source) {
  return Object.entries(EVENTS).filter(([, e]) => e.source === source).map(([k]) => k);
}

export function catalogAsJson() {
  return {
    sources: SOURCES,
    events: EVENTS,
    ops: Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.note])),
    actions: ACTIONS,
  };
}
