import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { validateRule, evalRule, evalCondition, renderRule, factKey } from "../src/schema.js";
import { parseCron, cronMatch, cronDue } from "../src/cron.js";
import * as db from "../src/db.js";
import { runRule } from "../src/engine.js";
import { buildArgs, parseAgentOutput, PRESETS } from "../src/agent.js";

const good = {
  if: { source: "github", event: "github.release.published", target: { repo: "c4pt0r/jmp2.io" }, when: [{ field: "prerelease", op: "eq", value: false }], every: "*/10 * * * *" },
  then: { action: "log", params: { text: "新 release {{tag}}" } },
};

test("validator accepts a well-formed rule and renders IF/THEN", () => {
  const v = validateRule(good);
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(v.rendered, 'IF github.release.published (repo=c4pt0r/jmp2.io) WHEN prerelease eq false EVERY "*/10 * * * *" THEN log(text="新 release {{tag}}")');
});

test("validator rejects invented events, fields, ops and actions", () => {
  const cases = [
    { ...good, if: { ...good.if, event: "github.star.dropped" } },
    { ...good, if: { ...good.if, when: [{ field: "stars", op: "gt", value: 10 }] } }, // stars is not a release field
    { ...good, if: { ...good.if, when: [{ field: "tag", op: "starts_with", value: "v" }] } },
    { ...good, then: { action: "slack.post", params: {} } },
    { ...good, if: { ...good.if, target: {} } },
    { ...good, if: { ...good.if, target: { repo: "not-a-repo" } } },
    { ...good, if: { ...good.if, every: "every 10 min" } },
    { ...good, then: { action: "lark.webhook", params: { text: "x" } } }, // missing url
  ];
  for (const c of cases) {
    const v = validateRule(c);
    assert.equal(v.ok, false, `should reject: ${JSON.stringify(c)}`);
    assert.ok(v.errors.length);
  }
});

test("conditions evaluate deterministically", () => {
  const f = { number: 42, title: "Fix OOM in parser", labels: ["bug", "perf"], draft: false, stars: 120 };
  assert.equal(evalCondition({ field: "title", op: "contains", value: "oom" }, f), true);
  assert.equal(evalCondition({ field: "labels", op: "contains", value: "perf" }, f), true);
  assert.equal(evalCondition({ field: "labels", op: "contains", value: "docs" }, f), false);
  assert.equal(evalCondition({ field: "title", op: "matches", value: "^fix" }, f), true);
  assert.equal(evalCondition({ field: "stars", op: "gte", value: 100 }, f), true);
  assert.equal(evalCondition({ field: "stars", op: "lt", value: 100 }, f), false);
  assert.equal(evalCondition({ field: "draft", op: "eq", value: false }, f), true);
  assert.equal(evalCondition({ field: "number", op: "in", value: [1, 42] }, f), true);
  assert.equal(evalCondition({ field: "author", op: "exists" }, f), false);
  assert.equal(evalRule({ if: { when: [{ field: "number", op: "gt", value: 10 }, { field: "title", op: "not_contains", value: "wip" }] } }, f), true);
});

test("cron: */10 matches every 10th minute; due-window works across gaps", () => {
  assert.equal(cronMatch("*/10 * * * *", new Date("2026-10-09T08:20:00Z")), true);
  assert.equal(cronMatch("*/10 * * * *", new Date("2026-10-09T08:21:00Z")), false);
  assert.equal(cronMatch("0 8 * * *", new Date("2026-10-09T08:00:00Z")), true);
  assert.equal(cronMatch("0 8 * * 1", new Date("2026-10-12T08:00:00Z")), true); // Monday
  assert.equal(cronDue("0 8 * * *", new Date("2026-10-09T07:59:00Z"), new Date("2026-10-09T08:01:00Z")), true);
  assert.equal(cronDue("0 8 * * *", new Date("2026-10-09T08:01:00Z"), new Date("2026-10-09T08:02:00Z")), false);
  // regression: a check at :22 must still see the :00 minute of the next minute
  assert.equal(cronDue("* * * * *", new Date("2026-10-09T07:05:22Z"), new Date("2026-10-09T07:06:00Z")), true);
  assert.equal(cronDue("*/5 * * * *", new Date("2026-10-09T07:00:00Z"), new Date("2026-10-09T07:04:59Z")), false);
  assert.equal(cronDue("*/5 * * * *", new Date("2026-10-09T07:00:00Z"), new Date("2026-10-09T07:05:00Z")), true);
  assert.throws(() => parseCron("bad"));
});

test("engine: first check baselines history, then fires exactly once per new fact", async () => {
  const d = db.open(":memory:");
  let rows = [rel("v1.0.0"), rel("v0.9.0")];
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) });

  const rule = db.insertRule(d, { raw: "当 jmp2.io 有新 release 就记下来", rule: good });

  const s1 = await runRule(d, rule);
  assert.equal(s1.baseline, true);
  assert.equal(s1.fired, 0, "history must not fire");

  rows = [rel("v1.1.0"), rel("v1.0.0"), rel("v0.9.0")];
  const s2 = await runRule(d, db.getRule(d, rule.id));
  assert.equal(s2.fresh, 1);
  assert.equal(s2.fired, 1);

  const s3 = await runRule(d, db.getRule(d, rule.id));
  assert.equal(s3.fresh, 0);
  assert.equal(s3.fired, 0, "same fact must not fire twice");

  const fires = db.listFires(d, { ruleId: rule.id });
  assert.equal(fires.length, 3); // 2 baseline + 1 fired; the repeat is dropped before logging
});

test("recompile forgets history and re-baselines, so an edited rule never replays old events", async () => {
  const d = db.open(":memory:");
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([rel("v1.0.0"), rel("v0.9.0")]) });
  const rule = db.insertRule(d, { raw: "x", rule: good });
  await runRule(d, rule); // baseline
  const edited = db.recompile(d, rule.id, { raw: "y", rule: good, note: "", missing: [], model: null });
  assert.equal(edited.last_check_at, null, "edit must reset last_check_at");
  const s = await runRule(d, edited);
  assert.equal(s.baseline, true, "first check after edit is a baseline again");
  assert.equal(s.fired, 0, "historical events must not fire after an edit");
});

test("once mode: renders ONCE and the rule disables itself after firing", async () => {
  const v = validateRule({ ...good, if: { ...good.if, mode: "once" } });
  assert.ok(v.ok, v.errors.join("; "));
  assert.ok(v.rendered.endsWith(" ONCE"));
  assert.equal(validateRule({ ...good, if: { ...good.if, mode: "daily" } }).ok, false);
  assert.equal(validateRule(good).rule.if.mode, "recurring", "default is recurring");

  const d = db.open(":memory:");
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([rel("v1.0.0")]) });
  const rule = db.insertRule(d, { raw: "once", rule: v.rule });
  const s = await runRule(d, rule, { force: true });
  assert.equal(s.fired, 1);
  assert.equal(s.disabled, true);
  assert.equal(db.getRule(d, rule.id).enabled, false, "once rule disables itself after firing");
});

test("engine: conditions gate the action, and dry run never acts", async () => {
  const d = db.open(":memory:");
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([rel("v2.0.0-rc1", true), rel("v2.0.0")]) });
  const rule = db.insertRule(d, {
    raw: "只关心正式版",
    rule: { if: { ...good.if, when: [{ field: "prerelease", op: "eq", value: false }] }, then: { action: "log", params: {} } },
  });
  const s = await runRule(d, rule, { force: true });
  assert.equal(s.checked, 2);
  assert.equal(s.matched, 1);
  assert.equal(s.fired, 1);
  assert.equal(s.results.find((r) => r.key === "v2.0.0-rc1").status, "no_match");
});

test("agent op: validated, rendered, and judged at fire time via injected judge", async () => {
  // validator: "*" and real fields allowed, empty question rejected
  const withAgent = { ...good, if: { ...good.if, when: [{ field: "prerelease", op: "eq", value: false }, { field: "*", op: "agent", value: "这个 release 是否包含安全修复?" }] } };
  const v = validateRule(withAgent);
  assert.ok(v.ok, v.errors.join("; "));
  assert.match(v.rendered, /\* agent "这个 release 是否包含安全修复\?"/);
  assert.equal(validateRule({ ...good, if: { ...good.if, when: [{ field: "*", op: "agent", value: " " }] } }).ok, false);
  assert.equal(validateRule({ ...good, if: { ...good.if, when: [{ field: "*", op: "eq", value: 1 }] } }).ok, false, "* is only for agent");

  // deterministic evalRule ignores agent conditions; engine judges them via `judge`
  const d = db.open(":memory:");
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([rel("v3.0.0"), rel("v3.1.0"), rel("v3.2.0-rc1", true)]) });
  const rule = db.insertRule(d, { raw: "安全修复才触发", rule: v.rule });

  const asked = [];
  const judge = async (conds, fact) => { asked.push(fact.tag); return { yes: fact.tag === "v3.1.0", why: fact.tag === "v3.1.0" ? "提到 CVE" : "无安全内容" }; };
  const s = await runRule(d, rule, { force: true, judge });
  assert.deepEqual(asked.sort(), ["v3.0.0", "v3.1.0"], "judge runs only on facts that passed deterministic conditions");
  assert.equal(s.fired, 1);
  assert.ok(s.results.find((r) => r.key === "v3.1.0").detail.includes("judge"));
  assert.equal(s.results.find((r) => r.key === "v3.0.0").status, "no_match");

  // judge failure -> error status, not fired
  const rule2 = db.insertRule(d, { raw: "x", rule: v.rule });
  const s2 = await runRule(d, rule2, { force: true, judge: async () => { throw new Error("model down"); } });
  assert.equal(s2.fired, 0);
  assert.equal(s2.errors, 2); // two facts pass the deterministic filter, both judgements fail
  assert.ok(s2.results.every((r) => r.status === "error" || r.status === "no_match"));
});

test("script op: gated by ALLOW_SHELL, fact arrives on stdin, exit code decides", async () => {
  const { judgeConditions } = await import("../src/judge.js");
  const conds = [{ field: "*", op: "script", value: `grep -q '"prerelease":false'` }];

  // validator: same rules as agent (field "*", non-empty command)
  assert.ok(validateRule({ ...good, if: { ...good.if, when: conds } }).ok);
  assert.equal(validateRule({ ...good, if: { ...good.if, when: [{ field: "*", op: "script", value: "" }] } }).ok, false);

  const prev = process.env.ALLOW_SHELL;
  process.env.ALLOW_SHELL = "0"; // shell is on by default; "0" is the explicit opt-out
  await assert.rejects(() => judgeConditions(conds, { prerelease: false }), /ALLOW_SHELL/);

  process.env.ALLOW_SHELL = "1";
  const y = await judgeConditions(conds, { prerelease: false }); // grep hits -> exit 0 -> pass
  const n = await judgeConditions(conds, { prerelease: true });
  assert.equal(y.yes, true);
  assert.equal(n.yes, false);
  assert.match(n.why, /exit 1/);
  if (prev === undefined) delete process.env.ALLOW_SHELL; else process.env.ALLOW_SHELL = prev;
});

test("observe: snapshot diff feeds the judge previous+content, unchanged costs nothing", async () => {
  const obsRule = {
    if: {
      source: "observe", event: "observe.changed",
      target: { what: "竞品降价了", url: "https://x/pricing" },
      when: [{ field: "*", op: "agent", value: "对比 previous 和 content，价格是否下降了？" }],
      every: "*/10 * * * *",
    },
    then: { action: "log", params: { text: "降价了: {{content}}" } },
  };
  // validator: url or command is mandatory, "what" always
  assert.ok(validateRule(obsRule).ok, validateRule(obsRule).errors.join("; "));
  assert.equal(validateRule({ ...obsRule, if: { ...obsRule.if, target: { what: "x" } } }).ok, false, "needs url or command");

  const d = db.open(":memory:");
  let page = "Pro plan: $99/mo";
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "text/plain" }, text: async () => page });
  const rule = db.insertRule(d, { raw: "盯着竞品定价页", rule: obsRule });

  const seenByJudge = [];
  const judge = async (conds, fact) => {
    seenByJudge.push({ prev: fact.previous, cur: fact.content });
    const drop = fact.previous.includes("$99") && fact.content.includes("$89");
    return { yes: drop, why: drop ? "99 -> 89" : "未下降" };
  };

  const s1 = await runRule(d, rule, { judge }); // first check: baseline, no judging
  assert.equal(s1.baseline, true);
  assert.equal(seenByJudge.length, 0, "baseline must not judge");

  const s2 = await runRule(d, db.getRule(d, rule.id), { judge }); // unchanged: digest seen, zero judge calls
  assert.equal(s2.fresh, 0);
  assert.equal(seenByJudge.length, 0, "unchanged snapshot must not judge");

  page = "Pro plan: $89/mo"; // price drop
  const s3 = await runRule(d, db.getRule(d, rule.id), { judge });
  assert.equal(s3.fired, 1);
  assert.deepEqual(seenByJudge.at(-1), { prev: "Pro plan: $99/mo", cur: "Pro plan: $89/mo" }, "judge sees both snapshots");

  page = "Pro plan: $120/mo"; // price up: fresh fact, judge says no
  const s4 = await runRule(d, db.getRule(d, rule.id), { judge });
  assert.equal(s4.fresh, 1);
  assert.equal(s4.fired, 0);
  assert.equal(s4.results[0].status, "no_match");
});

test("agent.run action: validated, gated by ALLOW_SHELL, exec args keep tools enabled", async () => {
  const { runAction } = await import("../src/actions.js");
  const withAgentRun = { ...good, then: { action: "agent.run", params: { task: "email me about {{tag}}" } } };
  assert.ok(validateRule(withAgentRun).ok);
  assert.equal(validateRule({ ...good, then: { action: "agent.run", params: {} } }).ok, false, "task is required");

  const prev = process.env.ALLOW_SHELL;
  process.env.ALLOW_SHELL = "0"; // shell is on by default; "0" is the explicit opt-out
  const out = await runAction(validateRule(withAgentRun).rule, { tag: "v1" });
  assert.equal(out.status, "skipped", "ALLOW_SHELL=0 -> skipped, agent never spawned");
  if (prev !== undefined) process.env.ALLOW_SHELL = prev; else delete process.env.ALLOW_SHELL;

  // executor invocation keeps tools: no -nt/-ns in pi exec args
  const exec = buildArgs({ ...PRESETS.pi, args: PRESETS.pi.execArgs }, { system: "s", user: "u" });
  assert.ok(!exec.includes("-nt") && !exec.includes("-ns"));
  assert.ok(exec.includes("--system-prompt"));
});

test("agent backend: pi preset runs tool-less and pins the model; custom configs substitute and drop empty flags", () => {
  const a = buildArgs(PRESETS.pi, { system: "s", user: "u", model: "strata/qwen3.8-flash-next-iq3_s" });
  assert.ok(a.includes("-nt") && a.includes("-ns") && a.includes("-nc"));
  assert.ok(a.includes("--no-session"));
  // "provider/id" is split into pi's canonical --provider X --model Y form
  assert.equal(a[a.indexOf("--provider") + 1], "strata");
  assert.equal(a[a.indexOf("--model") + 1], "qwen3.8-flash-next-iq3_s");
  assert.equal(a.at(-2), "--");

  // no model configured -> --provider/--model drop out, pi's own default applies
  const bare = buildArgs({ ...PRESETS.pi, model: "" }, { system: "s", user: "u" });
  assert.ok(!bare.includes("--provider") && !bare.includes("--model"));
  assert.ok(bare.includes("--system-prompt"));

  // custom agent config: placeholders substituted, empty {model} drops its flag too
  const custom = { name: "x", cmd: "x", args: ["--system", "{system}", "--model", "{model}", "{user}"], output: "text", model: "" };
  assert.deepEqual(buildArgs(custom, { system: "SYS", user: "hello" }), ["--system", "SYS", "hello"]);
  assert.deepEqual(buildArgs(custom, { system: "SYS", user: "hello", model: "m1" }), ["--system", "SYS", "--model", "m1", "hello"]);

  // output parsing: text mode is the raw reply; pi-jsonl digs out the assistant message
  assert.equal(parseAgentOutput("text", ' {"a":1} \n', 0).text, '{"a":1}');
  assert.throws(() => parseAgentOutput("text", "", 0), /empty/);
  const jsonl = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", model: "m", content: [{ type: "text", text: "ok" }] } });
  assert.equal(parseAgentOutput("pi-jsonl", `noise\n${jsonl}\n`, 0).text, "ok");
});

test("server: API routes match when the URL has a query string", async () => {
  const { createServer } = await import("../src/server.js");
  const { server } = createServer(":memory:", { quiet: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) =>
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve({ status: res.statusCode, body: s }));
    }).on("error", reject));

  assert.equal((await get("/api/fires?limit=5")).status, 200);
  assert.equal((await get("/api/rules?x=1")).status, 200);
  assert.equal((await get("/api/nope?x=1")).status, 404);
  server.close();
});

const rel = (tag, prerelease = false) => ({ tag_name: tag, name: tag, html_url: `https://x/${tag}`, published_at: "2026-10-01T00:00:00Z", prerelease, body: "" });
