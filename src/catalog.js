// The contract between "LLM-authored rules" and "deterministic runtime".
// Anything not listed here cannot be produced by the parser, so a rule can
// never reference an event/field/op/action the engine doesn't actually implement.

export const SOURCES = {
  github: { required: ["repo"], optional: ["token_env"], note: "repo = owner/name" },
  http: { required: ["url"], optional: ["path", "headers"], note: "path = dot path into JSON body" },
  time: { required: [], optional: [], note: "pure schedule, no external fact" },
  observe: { required: ["what"], optional: ["url", "command"], note: "open-world watch: url or command is required; what = what the user wants to detect, in their words" },
};

// event -> { source, summary, fields, key }
// `key` is the field(s) used for once-per-event dedup.
export const EVENTS = {
  "github.release.published": {
    source: "github",
    summary: "a new release is published",
    fields: { tag: "string", name: "string", url: "string", published_at: "datetime", prerelease: "bool", body: "string" },
    key: ["tag"],
  },
  "github.issue.opened": {
    source: "github",
    summary: "a new issue is opened (PRs excluded)",
    fields: { number: "int", title: "string", author: "string", url: "string", labels: "list", created_at: "datetime", body: "string" },
    key: ["number"],
  },
  "github.pr.opened": {
    source: "github",
    summary: "a new pull request is opened",
    fields: { number: "int", title: "string", author: "string", url: "string", draft: "bool", created_at: "datetime" },
    key: ["number"],
  },
  "github.pr.merged": {
    source: "github",
    summary: "a pull request is merged",
    fields: { number: "int", title: "string", author: "string", url: "string", merged_at: "datetime" },
    key: ["number"],
  },
  "github.commit.pushed": {
    source: "github",
    summary: "a new commit lands on the default branch",
    fields: { sha: "string", message: "string", author: "string", url: "string", date: "datetime" },
    key: ["sha"],
  },
  "github.star.count": {
    source: "github",
    summary: "repo star count (threshold / change triggers)",
    fields: { stars: "int", url: "string" },
    key: ["stars"],
  },
  "http.json.changed": {
    source: "http",
    summary: "poll a JSON URL, fire when the value changes",
    fields: { value: "any", status: "int", url: "string" },
    key: ["value"],
  },
  "time.schedule": {
    source: "time",
    summary: "pure schedule (no external fact)",
    fields: { now: "datetime", date: "string", time: "string", weekday: "string" },
    key: ["now"],
  },
  "observe.changed": {
    source: "observe",
    summary: "open-world watch: snapshot a url (or local command output), fire when it changes; the fact carries previous/content so an agent condition can decide whether the described thing happened",
    fields: { what: "string", content: "string", previous: "string", changed: "bool", digest: "string", url: "string" },
    key: ["digest"],
  },
};

export const OPS = {
  eq: { args: 1, note: "strict equality (bool/int/string normalized before compare)" },
  ne: { args: 1, note: "not equal" },
  contains: { args: 1, note: "string contains, or list has the element; case-insensitive" },
  not_contains: { args: 1, note: "negation of contains" },
  matches: { args: 1, note: "regex (JS RegExp, case-insensitive)" },
  gt: { args: 1, note: "number/date greater than" },
  gte: { args: 1, note: "number/date greater than or equal" },
  lt: { args: 1, note: "number/date less than" },
  lte: { args: 1, note: "number/date less than or equal" },
  in: { args: 1, note: "value is an array: field value is in the set" },
  exists: { args: 0, note: "field present and non-empty" },
  agent: { args: 1, note: "semantic judgement: value is one yes/no question, answered by the local model against the event at check time; field is an event field or * for the whole event. The only op that calls a model at runtime; runs only on fresh events that passed the deterministic conditions" },
  script: { args: 1, note: "script judgement: value is a local command; the event JSON arrives on stdin (LT_EVENT/LT_FIELD env vars carry context), exit code 0 = pass. field is an event field or *; runs only on fresh events that passed the deterministic conditions" },
};

export const ACTIONS = {
  log: { params: { text: "template" }, note: "local fire log only (default, safest)" },
  "webhook.post": {
    params: { url: "template", body: "template" },
    required: ["url"],
    note: "POST JSON to any URL",
  },
  "lark.webhook": {
    params: { url: "template", text: "template" },
    required: ["url"],
    note: "Lark/Feishu custom bot webhook (msg_type=text)",
  },
  "shell.exec": {
    params: { command: "template" },
    required: ["command"],
    note: "run a local command (on by default; disable with ALLOW_SHELL=0)",
    gated: "ALLOW_SHELL",
  },
  "agent.run": {
    params: { task: "template" },
    required: ["task"],
    note: "hand the fired event to the local agent WITH TOOLS and let it carry out the task (send an email, file a ticket, ...). Use when no other action can do what the user asked",
    gated: "ALLOW_SHELL",
  },
};

// Shell-powered capabilities (shell.exec, agent.run, script conditions, observe
// commands) are ON by default; set ALLOW_SHELL=0 to disable them all.
export const shellAllowed = () => process.env.ALLOW_SHELL !== "0";

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
