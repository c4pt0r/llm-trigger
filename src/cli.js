#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// CLI: the same pipeline as the HTTP API, for quick terminal use.
import * as db from "./db.js";
import { compileTrigger } from "./parse.js";
import { runRule } from "./engine.js";
import { EVENTS, ACTIONS } from "./catalog.js";

const DB = db.defaultDbPath();
const [cmd, ...rest] = process.argv.slice(2);
const BOOL = new Set(["run", "all", "dry", "enabled", "help"]);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "-d") { flags.d = true; continue; }
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
      if (flags.run) report(await runRule(d, rule, { force: flags.all }));
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
      if (!rows.length) return console.log('(no rules yet — try: llm-trigger add "when ..., do ...")');
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
    case "rm": case "del": case "delete": {
      if (!args.length) return usage();
      for (const id of args) console.log(db.deleteRule(d, id) ? `deleted ${id}` : `no such rule: ${id}`);
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
    case "serve": {
      if (flags.port) process.env.PORT = flags.port;
      if (!flags.d) { await import("./server.js"); break; } // foreground: blocks, polling logs go to stdout
      const { spawn } = await import("node:child_process");
      const { openSync, writeFileSync, mkdirSync } = await import("node:fs");
      const { dirname, join } = await import("node:path");
      const dir = dirname(DB);
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, "llm-trigger.log");
      const fd = openSync(logPath, "a");
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", new URL("./server.js", import.meta.url).pathname],
        { detached: true, stdio: ["ignore", fd, fd], env: process.env });
      child.unref();
      writeFileSync(join(dir, "llm-trigger.pid"), String(child.pid));
      console.log(`daemonized: pid ${child.pid} (kill $(cat ${join(dir, "llm-trigger.pid")}) to stop)`);
      console.log(`logs: ${logPath}`);
      break;
    }
    default: usage();
  }
}

function report(idOrS, maybeS) {
  const s = maybeS ?? idOrS, id = maybeS ? idOrS : "";
  console.log(`${id ? id + " " : ""}checked=${s.checked} fresh=${s.fresh} matched=${s.matched} fired=${s.fired} errors=${s.errors} skipped=${s.skipped}${s.baseline ? " (baseline: first check only records history, nothing fires)" : ""}${s.disabled ? " (once: rule disabled)" : ""}`);
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
  console.log(`llm-trigger — natural language -> IF/THEN rules (compiled by a local model via pi)

  llm-trigger add "<sentence>" [--run [--all]]   compile and store as a rule
  llm-trigger parse "<sentence>"                 compile only, do not store
  llm-trigger edit <id> "<sentence>"             recompile and overwrite
  llm-trigger list | show <id> | on|off <id>
  llm-trigger rm <id> [<id>...]                  delete trigger(s); del/delete work too
  llm-trigger run <id> [--dry] [--all]           check once now (--all = ignore dedup history, replay all events)
  llm-trigger run-all [--dry] | fires [id] [--limit N] | stats | events | actions
  llm-trigger serve [--port 8787] [-d]           HTTP API + web UI + scheduler; blocks and logs
                                                 each poll unless -d (daemonize, log to file)
`);
}

main().catch((e) => fail([e.message]));
