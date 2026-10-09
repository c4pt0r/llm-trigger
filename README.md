# llm-trigger

Describe a trigger in natural language, store it as a structured `IF / THEN` rule, and let a deterministic engine evaluate and execute it on a cron schedule. The model runs at compile time; at fire time it is only consulted when a rule explicitly opted into a semantic condition — and then only as a yes/no judge.

```
$ llm-trigger add "when github repo c4pt0r/jmp2.io publishes a new release that is not a prerelease, log it"
id: r_7dcc60f4
IF/THEN: IF github.release.published (repo=c4pt0r/jmp2.io) WHEN prerelease eq false EVERY "*/10 * * * *" THEN log(text="New release {{tag}}: {{url}}")
note: Log when a new non-prerelease is published in c4pt0r/jmp2.io.
model: qwen3.8-flash-next-iq3_s
```

Natural language in, structured rule out. Input can be Chinese or English; the stored artifact is always the same `{if, then}` object.

## Core design: compile with a model, fire deterministically

| Stage | Who does it | How often |
|---|---|---|
| Natural language → structured rule | **the configured agent** (`src/agent.js`; pi preset with a local model by default) | every time a rule is written or edited |
| Rule validity | `src/schema.js` validator, checked against the catalog in `src/catalog.js` | every write |
| Event detection + action execution | `src/engine.js` + `src/sources.js` + `src/actions.js`, plain code | every cron hit |
| Slow judges (`script` / `agent` conditions) | `src/judge.js` — local command / one agent yes/no call | only fresh facts that passed the deterministic conditions |

Conditions come in three tiers. Deterministic ops (`eq`/`contains`/...) are pure code. On top of them a rule may opt into **slow judges**, which run only on **fresh** facts that already passed the deterministic filters, at most once per event (dedup), never during baseline:

- `script` — a local command; the event JSON arrives on stdin, exit code 0 = pass (`LT_EVENT`/`LT_FIELD` in env). Gated by `ALLOW_SHELL=1`, like the `shell.exec` action.
- `agent` — the local model answers a yes/no question about the event ("does this look like a security fix?"); the verdict and its reason are logged in `fires`.

Scripts run before the model and short-circuit, so an `agent` condition behind a failing `script` costs nothing.

This is what makes "firing" reproducible, auditable and testable: a model can't hallucinate a POST to your webhook at 3am. The model may only pick events/fields/ops/actions that are **actually implemented** in `catalog.js`; if the sentence isn't expressible, it refuses outright:

```
$ llm-trigger parse "remind me to drink water when my boss messages me on Slack"
rejected:
- model refused: The catalog does not support Slack message events. A source and event for
  monitoring Slack messages (e.g., 'slack.message.received') would be needed.
```

When validation fails, the errors are fed back to the model for one repair round (`maxRounds`). If it is still invalid, the API returns 422 — a half-valid rule is never stored.

## Agent backend (pi is just one example)

The compiler and the runtime judges talk to "an agent": any CLI that takes a system prompt + a user prompt and prints a reply. `src/agent.js` holds the abstraction; pick a backend with `LT_AGENT`:

```bash
llm-trigger parse "..."                        # default: the pi preset (local model, no API key)
LT_AGENT=claude llm-trigger parse "..."        # claude preset (claude -p)
LT_AGENT=./my-agent.json llm-trigger parse ... # any CLI, via a JSON config:
# { "cmd": "my-agent", "args": ["--system", "{system}", "{user}"], "output": "text" }
```

Placeholders in `args`: `{system}` `{user}` `{thinking}` `{model}` `{provider}` `{modelId}`. An arg whose placeholder resolves to nothing is dropped together with the flag before it, so `["--model", "{model}"]` vanishes when no model is set. `output` is `"text"` (stdout is the reply) or `"pi-jsonl"` (pi's `--mode json` event stream).

The pi preset spawns a one-shot, tool-less process:

```
pi -p --mode json --no-session -nt -ns -np -nc --thinking off \
   --provider <provider> --model <id> --system-prompt <compiler prompt> -- <natural language>
```

- `-nt -ns -np -nc` disables tools / skills / prompt templates / AGENTS.md. One compile costs ~60 input tokens and ~1s.
- Model resolution for pi: `LT_MODEL=provider/id` if set, else the **current pi session model** (`PI_PROVIDER/PI_MODEL`), else the built-in fallback `strata/qwen3.8-flash-next-iq3_s` — pi's configured default provider may fail with `Connection error.`, so a model is always pinned explicitly.
- Cron is UTC, but the compiler prompt carries the machine's timezone, so "every morning at 9" (or "每天早上9点" — input can be Chinese or English) is converted to the right UTC cron line.

## Storage (SQLite via Node 22's built-in `node:sqlite`, zero dependencies)

`~/.llm-trigger/llm-trigger.db` (global install) or `./data/llm-trigger.db` (dev checkout), `LT_DB` overrides:

- `rules`: `raw` (the original sentence) + `if_json` / `then_json` (structured) + `rendered` (a deterministic `IF ... WHEN ... EVERY ... THEN ...` string) + `source/event/action/every` **flattened into real columns**, so "which rules watch GitHub releases?" is one SQL statement. `state_json` holds the dedup keys (`seen`) and, for `observe` rules, the last snapshot.
- `fires`: every fact seen, whether it matched the conditions, the action status (`baseline` / `fired` / `no_match` / `dry` / `error` / `skipped`), and the judge's verdict + reason when a slow judge ran.

`rendered` is generated by code from the structured data, **not** written by the model — so the IF/THEN line in the UI is guaranteed to equal what actually executes.

## Event catalog (the extension point)

| event | source | dedup key | fields |
|---|---|---|---|
| `github.release.published` | github | tag | tag,name,url,published_at,prerelease,body |
| `github.issue.opened` | github | number | number,title,author,url,labels,created_at,body |
| `github.pr.opened` | github | number | number,title,author,url,draft,created_at |
| `github.pr.merged` | github | number | number,title,author,url,merged_at |
| `github.commit.pushed` | github | sha | sha,message,author,url,date |
| `github.star.count` | github | stars | stars,url |
| `http.json.changed` | http | value | value,status,url |
| `time.schedule` | time | now | now,date,time,weekday |
| `observe.changed` | observe | digest | what,content,previous,changed,digest,url |

Condition ops: `eq ne contains not_contains matches gt gte lt lte in exists` + slow judges `script` (local command, exit 0 = pass, needs `ALLOW_SHELL=1`) and `agent` (yes/no judged by the local model); for both, `field` may be `*` for the whole event
Actions: `log`, `webhook.post`, `lark.webhook`, `shell.exec` (requires `ALLOW_SHELL=1`)

Adding an event = one line in `catalog.js` (fields + dedup key) + one branch in `sources.js`. The validator and the prompt follow automatically, because all three read the same catalog.

`observe.changed` is the open-world escape hatch for everything the predefined events can't express ("the competitor cut prices", "the API section of the docs changed"): it snapshots a URL (HTML stripped to text) or a local command's output (`ALLOW_SHELL=1` gated), diffs against the previous snapshot stored in rule state, and hands `previous` + `content` to an `agent` condition that answers "did the thing the user described happen?". The snapshot digest is the dedup key, so an unchanged page costs zero model calls, and the model still only ever answers yes/no — fetching and actions stay whitelisted.

## Install

Needs Node >= 22.5 and the `pi` CLI with a working local model.

```bash
npm install -g github:c4pt0r/llm-trigger
# or hack on a checkout:
git clone https://github.com/c4pt0r/llm-trigger && cd llm-trigger && npm link
```

The database lives in `~/.llm-trigger/llm-trigger.db` for a global install, or `./data/` in a dev checkout; override with `LT_DB=path`.

## Usage

```bash
llm-trigger add "when someone opens a PR on c4pt0r/jmp2.io with OOM in the title and it is not a draft, POST to https://x/hook, check hourly"

llm-trigger add "<sentence>" [--run [--all]]   # compile and store (--run = check immediately)
llm-trigger parse "<sentence>"                 # compile only, do not store
llm-trigger edit <id> "<sentence>"             # recompile and overwrite (re-baselines)
llm-trigger list | show <id> | on <id> | off <id> | rm <id>
llm-trigger run <id> [--dry] [--all]           # --dry = don't execute actions; --all = replay dedup history
llm-trigger run-all [--dry]
llm-trigger fires [id] [--limit N]             # fire log, incl. judge verdicts and reasons
llm-trigger stats | events | actions           # db stats / inspect the catalog
llm-trigger serve [--port 8787] [-d]           # HTTP API + web UI + scheduler (127.0.0.1:8787)
npm test
```

`serve` blocks in the foreground and logs every poll; `-d` daemonizes instead (pid and log land next to the db, `kill $(cat .../llm-trigger.pid)` to stop):

```
llm-trigger on http://127.0.0.1:8787  (agent: pi, model: strata/qwen3.8-flash-next-iq3_s)
2026-10-09T18:16:42Z scheduler: tick every 60000ms, 2 enabled rule(s)
2026-10-09T18:16:43Z r_5ecded6f github.release.published baseline: 10 existing event(s) recorded, nothing fires
2026-10-09T18:26:43Z r_5ecded6f github.release.published checked=10 fresh=1 matched=1 fired=1
2026-10-09T18:26:43Z   fired v2.103.0: New release v2.103.0: https://github.com/cli/cli/releases/tag/v2.103.0
```

The recommended loop: `add`, eyeball the rendered IF/THEN, `run <id> --dry --all` to rehearse the rule against real history, then leave `serve` running.

HTTP API: `POST /api/parse` (compile only), `POST /api/rules` (compile and store), `POST /api/rules/:id/compile` (recompile from a new sentence), `PUT /api/rules/:id` (hand-edited structured JSON, same validator), `PATCH /api/rules/:id` (enable/disable), `POST /api/rules/:id/run {dry,force}`, `GET /api/fires?rule=&limit=`, `GET /api/catalog`, `GET /api/health`.

## Configuration

All optional (see `.env.example`):

| env | default | meaning |
|---|---|---|
| `LT_AGENT` | `pi` | agent preset (`pi`, `claude`) or path to a JSON agent config |
| `LT_MODEL` | `$PI_PROVIDER/$PI_MODEL`, then `strata/qwen3.8-flash-next-iq3_s` | model handed to the agent (`provider/id` for pi) |
| `LT_DB` | `~/.llm-trigger/llm-trigger.db`, or `./data/` in a checkout | SQLite path |
| `LT_SCHEDULER` | `on` | `off` = serve API/UI only, no polling |
| `LT_TICK_MS` | `60000` | scheduler tick; cron granularity is 1 minute, so smaller buys nothing |
| `LT_EVERY` | `*/10 * * * *` | default cadence when the sentence gives no rhythm |
| `ALLOW_SHELL` | unset | enables the `shell.exec` action, `script` conditions and `observe` commands |
| `GITHUB_TOKEN` | unset | raises the GitHub API limit (60 req/h unauthenticated) |
| `PI_BIN` | `pi` | binary used by the pi preset |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | server bind |

## Four behaviours worth knowing

1. **The first check is a baseline.** A brand-new rule records the events that already exist as `baseline` and does not fire (otherwise adding a release rule would immediately hit your webhook 10 times). Baselines also skip the slow judges. Replay deliberately with `--all` / `{"force":true}`.
2. **Dedup is once per event.** Every evaluated fact is written to `seen`, matched or not. A failing action or judge is logged as `error` but is **not** retried automatically — that keeps a broken webhook from being hammered forever; retry manually with `run --all`.
3. **Editing re-baselines.** `edit` / `PUT` / `POST .../compile` reset the dedup history *and* the baseline marker, so the next check records the existing events under the new semantics instead of firing on all of them.
4. **Triggers are recurring by default.** Say "just once" and the compiler sets `if.mode: "once"` (rendered with an `ONCE` suffix); the rule disables itself after its first fire — re-arm with `on <id>`.

## Security boundaries

- Binds to `127.0.0.1` by default; `shell.exec` only runs when the server has `ALLOW_SHELL=1`, otherwise it is logged as `skipped`.
- There is **no** API authentication yet. Do not expose this to the public internet.
- Unauthenticated GitHub API is limited to 60 req/h; set `GITHUB_TOKEN` for more.

## Known limits / next steps

- Everything is polling. Webhook-in ("fire the moment someone pushes") needs an inbound route that feeds facts straight into `engine`.
- Single-process scheduler, no distributed lock; running several instances fires twice.
- Rules cannot be composed (no cross-event AND/OR) and there is no aggregation over time windows ("three days in a row") — one event plus a conjunction of conditions.
