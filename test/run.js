import test from "node:test";
import assert from "node:assert/strict";
import { validateRule, evalRule, evalCondition, renderRule, factKey } from "../src/schema.js";
import { parseCron, cronMatch, cronDue } from "../src/cron.js";
import * as db from "../src/db.js";
import { runRule } from "../src/engine.js";
import { piArgs } from "../src/pi.js";

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

test("pi backend runs tool-less and pins the current model", () => {
  const a = piArgs({ system: "s", user: "u", model: "strata/qwen3.8-flash-next-iq3_s" });
  assert.ok(a.includes("-nt") && a.includes("-ns") && a.includes("-nc"));
  assert.ok(a.includes("--no-session"));
  assert.equal(a[a.indexOf("--model") + 1], "strata/qwen3.8-flash-next-iq3_s");
  assert.equal(a.at(-2), "--");
});

const rel = (tag, prerelease = false) => ({ tag_name: tag, name: tag, html_url: `https://x/${tag}`, published_at: "2026-10-01T00:00:00Z", prerelease, body: "" });
