#!/usr/bin/env node
// CLI: the same pipeline as the HTTP API, for quick terminal use.
import * as db from "./db.js";
import { compileTrigger } from "./parse.js";
import { runRule } from "./engine.js";
import { EVENTS, ACTIONS } from "./catalog.js";

const DB = process.env.LT_DB || new URL("../data/llm-trigger.db", import.meta.url).pathname;
const [cmd, ...rest] = process.argv.slice(2);
const BOOL = new Set(["run", "all", "dry", "enabled", "help"]);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) { args.push(a); continue; }
  const k = a.slice(2);
  if (k.includes("=")) flags[k] = a.slice(k.indexOf("=") + 1);
  else if (BOOL.has(k)) flags[k] = true;
  else flags[k] = rest[++i];
}
const d = db.open(DB);

const pad = (s, n) => String(s).padEnd(n);
const ts = (t) => (t ? new Date(t * 1000).toISOString().slice(5, 16).replace("T", " ") : "-");

async function main() {
  switch (cmd) {
    case "parse": {
      const text = args.join(" "); if (!text) return usage();
      const r = await compileTrigger(text);
      if (!r.ok) return fail(r.errors);
      printCompiled(r);
      break;
    }
    case "add": {
      const text = args.join(" "); if (!text) return usage();
      const r = await compileTrigger(text);
      if (!r.ok) return fail(r.errors);
      const rule = db.insertRule(d, { raw: text, rule: r.rule, note: r.note, missing: r.missing, model: r.model });
      printCompiled(r, rule.id, text);
      if (flags.run) console.log(JSON.stringify(await runRule(d, rule, { force: flags.all }), null, 2));
      break;
    }
    case "edit": {
      const id = args[0], text = args.slice(1).join(" ");
      if (!id || !text) return usage();
      const r = await compileTrigger(text);
      if (!r.ok) return fail(r.errors);
      const rule = db.recompile(d, id, { raw: text, rule: r.rule, note: r.note, missing: r.missing, model: r.model });
      printCompiled(r, rule.id, text);
      break;
    }
    case "list": {
      const rows = db.listRules(d);
      if (!rows.length) return console.log("(no rules yet — try: npm run cli -- add \"当 ... 就 ...\")");
      for (const r of rows) {
        console.log(`${r.id}  ${r.enabled ? "on " : "off"}  ${r.rendered}`);
        console.log(`      “${r.raw}”  last_check=${ts(r.last_check_at)}${r.missing?.length ? `  missing=${r.missing.join(",")}` : ""}`);
      }
      break;
    }
    case "show": {
      const r = db.getRule(d, args[0]); if (!r) return fail(["no such rule"]);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "on": case "off": {
      db.setEnabled(d, args[0], cmd === "on"); console.log(`${args[0]} ${cmd}`);
      break;
    }
    case "rm": {
      console.log(db.deleteRule(d, args[0]) ? `deleted ${args[0]}` : "no such rule");
      break;
    }
    case "run": {
      const r = db.getRule(d, args[0]); if (!r) return fail(["no such rule"]);
      const s = await runRule(d, r, { dryRun: flags.dry, force: flags.all });
      report(s);
      break;
    }
    case "run-all": {
      for (const r of db.listRules(d, { all: !flags.enabled })) report(r.id, await runRule(d, r, { dryRun: flags.dry, force: flags.all }));
      break;
    }
    case "fires": {
      for (const f of db.listFires(d, { ruleId: args[0], limit: Number(flags.limit || 30) }))
        console.log(`${f.created_at}  ${pad(f.rule_id, 11)} ${pad(f.status, 9)} ${pad(f.key, 18)} ${f.detail || ""}`);
      break;
    }
    case "stats": console.log(JSON.stringify(db.stats(d), null, 2)); break;
    case "events": console.log(Object.entries(EVENTS).map(([k, v]) => `${k}  ${v.summary}  fields: ${Object.keys(v.fields).join(",")}`).join("\n")); break;
    case "actions": console.log(Object.entries(ACTIONS).map(([k, v]) => `${k}  ${v.note}  params: ${Object.keys(v.params).join(",")}`).join("\n")); break;
    case "serve": process.env.PORT = flags.port || process.env.PORT; await import("./server.js"); break;
    default: usage();
  }
}

function report(idOrS, maybeS) {
  const s = maybeS ?? idOrS, id = maybeS ? idOrS : "";
  console.log(`${id ? id + " " : ""}checked=${s.checked} fresh=${s.fresh} matched=${s.matched} fired=${s.fired} errors=${s.errors} skipped=${s.skipped}${s.baseline ? " (baseline: 首次检查只记录历史，不触发)" : ""}`);
  for (const r of s.results ?? []) console.log(`  ${pad(r.status, 9)} ${pad(r.key, 18)} ${r.detail ?? ""}`);
}

function printCompiled(r, id, raw) {
  if (id) console.log(`id: ${id}`);
  if (raw) console.log(`raw : ${raw}`);
  console.log(`IF/THEN: ${r.rendered}`);
  if (r.note) console.log(`note: ${r.note}`);
  if (r.missing?.length) console.log(`guessed: ${r.missing.join(", ")}`);
  console.log(`model: ${r.model}`);
  console.log(JSON.stringify({ if: r.rule.if, then: r.rule.then }, null, 2));
}

const fail = (errors) => { console.error("rejected:\n- " + errors.join("\n- ")); process.exitCode = 1; };

function usage() {
  console.log(`llm-trigger — 自然语言 -> IF/THEN 规则（编译器是 pi 上的本地模型）

  cli add "<自然语言>" [--run [--all]]   编译并存为规则
  cli parse "<自然语言>"                 只编译，不存
  cli edit <id> "<自然语言>"             重新编译覆盖
  cli list | show <id> | on|off <id> | rm <id>
  cli run <id> [--dry] [--all]           立即检查一次（--all = 忽略去重历史，重放全部事件）
  cli run-all [--dry] | fires [id] [--limit N] | stats | events | actions
  cli serve [--port 8787]                HTTP API + 网页 + 调度器
`);
}

main().catch((e) => fail([e.message]));
