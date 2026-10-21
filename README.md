# mcp-toolbox

**A sandboxed Model Context Protocol server that gives an AI assistant read-only SQLite, an allowlisted filesystem subtree and allowlisted HTTP fetch, with every call audited and every guard proven by a test.**

[![CI](https://github.com/rohanreddy79/mcp-toolbox/actions/workflows/ci.yml/badge.svg)](https://github.com/rohanreddy79/mcp-toolbox/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

Most MCP servers that expose a database or a directory trust the model with the whole thing: any SQL, any path, any URL. That is the wrong default for a tool that runs on a developer's machine next to their secrets. The interesting engineering is not the protocol plumbing but the sandbox: a read-only SQL gate that cannot be talked around with comments or `;` chaining, path containment that survives symlinks, a fetch tool that re-checks the allowlist on every redirect, and an audit trail you can grep. This repo shows how to build those guards small, how to prove each one with a test, and how to ship the result as a server that Claude Desktop and Claude Code can use over stdio or Streamable HTTP. It uses the built-in `node:sqlite`, so there is nothing native to compile.

## Features

- 8 tools: `sqlite_list_tables`, `sqlite_describe_table`, `sqlite_query`, `fs_list`, `fs_read`, `fs_search`, `fs_write` (off unless enabled), `http_fetch`
- Resources `sqlite://<db>/schema` (full DDL) and `file://<root-relative path>`; prompts `explain_schema` and `summarize_file`
- SQL gate: single `SELECT`/`WITH` statement, token-based keyword blocklist, parameter binding, row cap, database opened read-only
- Path gate: lexical containment plus `realpath`, so `..`, absolute paths and symlinks pointing outside a root are all rejected; walks never follow symlinks
- HTTP gate: GET only, exact or `*.example.com` host allowlist, manual redirects re-checked per hop, total timeout, streaming byte cap, HTML to text with no dependencies
- Audit log: one JSON line per tool call, resource read or prompt (timestamp, name, summarised args, ok/error, ms)
- Transports: stdio (default) and Streamable HTTP with sessions and a loopback-only Host header check
- Config file plus CLI flags; errors reach the model as `[CODE] message` results it can act on
- 100 offline tests in about 1.3 s, including an end-to-end test that spawns the built CLI over stdio

## Quickstart

```bash
git clone https://github.com/rohanreddy79/mcp-toolbox && cd mcp-toolbox
pnpm install
pnpm build
pnpm demo     # seeds examples/demo.db, starts dist/cli.js over stdio, exercises every tool family
```

Trimmed output of `pnpm demo`:

```text
== tools
sqlite_list_tables — List SQLite tables
sqlite_query — Run a read-only SQL query
fs_search — Search file contents
http_fetch — Fetch a URL
...
== sqlite_query (top customers by revenue)
{ "columns": ["customer", "eur"], "rows": [["Grace Hopper", 720], ["Margaret Hamilton", 456], ["Linus Torvalds", 315]], "rowCount": 3, "truncated": false }

== sqlite_query rejected
[SQL_REJECTED] only SELECT or WITH statements are allowed (statement starts with "DROP")

== fs_read rejected
[PATH_OUTSIDE_ROOT] "../../etc/passwd" is outside every allowed root

== fs_write rejected (writes disabled)
[WRITE_DISABLED] writes are disabled; start the server with --write-enabled or "writeEnabled": true
```

### Configure it for your data

Copy `toolbox.config.example.json` to `toolbox.config.json` and edit it. Relative paths are resolved against the config file's directory; roots and database files must exist, or the server refuses to start.

```json
{
  "roots": ["./examples/data"],
  "databases": { "demo": "./examples/demo.db" },
  "allowedHosts": ["127.0.0.1", "localhost", "*.example.com"],
  "maxBytes": 1048576,
  "maxRows": 500,
  "writeEnabled": false,
  "auditLog": "./toolbox-audit.jsonl"
}
```

Every key has a flag (`--root DIR`, `--db NAME=PATH`, `--allow-host HOST`, `--max-bytes N`, `--max-rows N`, `--write-enabled`, `--audit-log FILE`). Flags are merged on top of the file: lists are appended, scalars replaced. `node dist/cli.js --help` lists them.

### Claude Desktop

Add to `claude_desktop_config.json` (use absolute paths; the `NODE_OPTIONS` line silences Node's `ExperimentalWarning` for `node:sqlite`, which is harmless but noisy in the logs):

```json
{
  "mcpServers": {
    "toolbox": {
      "command": "node",
      "args": ["/abs/path/mcp-toolbox/dist/cli.js", "--config", "/abs/path/toolbox.config.json"],
      "env": { "NODE_OPTIONS": "--disable-warning=ExperimentalWarning" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add mcp-toolbox -- node /abs/path/mcp-toolbox/dist/cli.js --config /abs/path/toolbox.config.json
```

### Streamable HTTP

```bash
node dist/cli.js --config toolbox.config.json --http --port 3333   # endpoint: http://127.0.0.1:3333/mcp, health: /healthz
claude mcp add --transport http toolbox http://127.0.0.1:3333/mcp
```

The HTTP transport has no authentication. It binds to `127.0.0.1` by default and, while bound to loopback, rejects requests whose `Host` header is not a loopback name, which blocks DNS-rebinding attacks from a browser tab. Binding elsewhere (`--host 0.0.0.0`) turns that check off and expects an authenticating proxy in front.

## How it works

```text
 Claude Desktop / Claude Code / any MCP client
      │ stdio (default)                 │ Streamable HTTP (--http)
      ▼                                 ▼
 transports/stdio.ts              transports/http.ts   one session = one McpServer, loopback Host check
      └───────────────┬─────────────────┘
                      ▼
               server.ts  createToolboxServer(config, { audit })
                      │
      ┌───────────────┼───────────────────┬─────────────────────┐
      ▼               ▼                   ▼                     ▼
 tools/sqlite.ts   tools/fs.ts        tools/http.ts     resources.ts / prompts.ts
 safety/sql.ts     safety/paths.ts    safety/hosts.ts   (reuse the same checks)
 node:sqlite       util/glob.ts       safety/html.ts
 (readOnly)
      └──────── tooling.ts: [CODE] results, timing ──── audit.ts: JSON Lines ────┘
```

| Module | Responsibility |
|---|---|
| `src/config.ts` | zod schema, file + CLI merge, realpath and existence checks (fails fast) |
| `src/safety/sql.ts` | SQL tokenizer and the read-only statement gate |
| `src/safety/paths.ts` | `resolveExisting` / `resolveForWrite`: lexical containment then `realpath` |
| `src/safety/hosts.ts`, `src/safety/html.ts` | host allowlist and URL rules; regex HTML-to-text |
| `src/tools/*.ts` | tool implementations plus their MCP registrations |
| `src/tooling.ts`, `src/audit.ts` | result shaping, error-to-result conversion, audit log |
| `src/transports/*.ts`, `src/cli.ts` | stdio and HTTP serving, argument parsing |

### Design decisions

**Read-only SQL is two layers, not one.** The handle is opened with `readOnly: true`, so SQLite itself refuses writes (`tests/sqlite.test.ts` proves an `INSERT` through the raw handle fails). On top of that, `sqlite_query` only admits a single statement whose first token is `SELECT` or `WITH`, with no `;` except one trailing, and with no `PRAGMA/ATTACH/DETACH/VACUUM/INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/REINDEX` token anywhere. The check is token based rather than regex based: string literals, quoted identifiers and comments are skipped, so `SELECT 'DROP'` and a column called `"delete"` pass while `WITH x AS (...) DELETE FROM t` does not. A full SQL parser would be more precise but is a large dependency for a question the handle already answers; the gate exists so that the model gets a clear `[SQL_REJECTED]` instead of a SQLite error, and so that `PRAGMA`/`ATTACH` (which a read-only handle still allows) stay out.

**Paths are resolved physically, not just lexically.** `path.resolve` normalises `..` and absolute paths; that alone misses symlinks, which are how a sandbox usually leaks. Every target is therefore `realpath`ed and must land inside a root that is itself a realpath. Writes are the hard case: the target may not exist yet, so the parent directory is realpathed instead and the final name must not be a dangling symlink (writing through one would create the file wherever it points). Directory walks report symlinks but never follow them, so `fs_list` and `fs_search` cannot wander out of a root even through a link that the read path would have rejected.

**Guard failures are tool results, not protocol errors.** A tool returns `isError: true` with `[CODE] message`, so the model sees why it was refused and can try a different path or query. Codes are stable strings the tests assert on (`PATH_OUTSIDE_ROOT`, `SQL_REJECTED`, `HOST_NOT_ALLOWED`, `SIZE_CAP`, `WRITE_DISABLED`, ...). Resources and prompts have no error-result shape in MCP, so there the same `ToolboxError` becomes a JSON-RPC `InvalidParams` error whose message keeps the code.

**Redirects are followed by hand.** `fetch` with `redirect: 'follow'` would let `allowed.example.com` bounce the request to any host. The tool uses `redirect: 'manual'`, re-runs the allowlist on every hop (max 5), shares one timeout across hops, and reads the body through a reader so it can cancel the stream the moment the byte cap is exceeded instead of buffering first. The allowlist matches hostnames, not resolved IPs: it stops the model from choosing an arbitrary host, not an allowlisted host from resolving somewhere surprising.

**Audit logs are JSON Lines with summarised arguments.** One line per call with the tool name, truncated arguments (never a whole file body), ok/error and elapsed ms. Writes are serialised through a promise chain so lines never interleave, and a failing log write is reported on stderr but does not take the tools down. The log is what lets a user answer "what did the assistant actually look at?" after the fact.

## Security model

| Check | Where | Proven by |
|---|---|---|
| `..` traversal rejected before touching the disk | `safety/paths.ts` lexical candidates | `tests/paths.test.ts` "rejects ../ traversal"; `tests/server.test.ts` "rejects traversal, absolute paths…" |
| Absolute path outside every root rejected | `safety/paths.ts` | `tests/paths.test.ts` "rejects absolute paths outside every root" |
| Symlink (file or directory) pointing outside a root rejected | `safety/paths.ts` realpath | `tests/paths.test.ts` "rejects symlinks whose target is outside"; `tests/server.test.ts` same block |
| Write through dangling symlink / symlinked parent rejected | `resolveForWrite` | `tests/paths.test.ts` "rejects escapes…"; `tests/server.test.ts` "writes inside the root and still refuses every escape" |
| Walks do not follow symlinks; `.git`/`node_modules` ignored | `tools/fs.ts` `walk` | `tests/server.test.ts` "lists recursively, ignoring .git…" |
| Binary files refused; size cap on reads and writes; line-range slicing | `tools/fs.ts` | `tests/server.test.ts` "rejects binary files and files above the size cap…" |
| `fs_write` refused unless `writeEnabled` | `tools/fs.ts` | `tests/server.test.ts` "refuses writes when writeEnabled is false" |
| Only `SELECT`/`WITH`; no `;` chaining; blocked keywords as tokens | `safety/sql.ts` | `tests/sql.test.ts` (20 rejected and 10 accepted statements) |
| Database handle read-only even if the gate were bypassed | `tools/sqlite.ts` `readOnly: true` | `tests/sqlite.test.ts` "opens handles read-only…" |
| Table names never spliced into SQL (`pragma_*` with bound params) | `tools/sqlite.ts` | `tests/sqlite.test.ts` "describes columns… without splicing" |
| Row cap enforced with `truncated` flag; larger `maxRows` rejected by schema | `tools/sqlite.ts` | `tests/server.test.ts` "caps rows at maxRows…" |
| Host allowlist (exact, `*.domain`, apex excluded); http/https only; no credentials in URL | `safety/hosts.ts` | `tests/hosts.test.ts`; `tests/server.test.ts` "rejects hosts outside the allowlist…" |
| Redirect to a non-allowlisted host rejected; redirect loops capped | `tools/http.ts` | `tests/server.test.ts` same test, `/redirect-out` and `/loop` |
| Byte cap (declared and streamed), binary refusal, timeout | `tools/http.ts` | `tests/server.test.ts` "enforces the byte cap, binary refusal and the timeout" |
| HTML scripts/styles stripped; entities decoded only after tags are removed | `safety/html.ts` | `tests/html.test.ts` |
| Non-loopback `Host` header rejected on the HTTP transport | `transports/http.ts` | `tests/http-transport.test.ts` "rejects non-loopback Host headers" |
| Resources and prompts apply the same path and database checks | `resources.ts`, `prompts.ts` | `tests/server.test.ts` "serves the schema and files, and applies the same path checks" |
| Every call audited with outcome | `tooling.ts`, `audit.ts` | `tests/server.test.ts` "writes one audit entry per call"; `tests/stdio.test.ts` |

## Tool reference

| Tool | Arguments | Returns |
|---|---|---|
| `sqlite_list_tables` | `database` | tables and views |
| `sqlite_describe_table` | `database`, `table` | columns, indexes, row count, DDL |
| `sqlite_query` | `database`, `sql`, `params?` (array or object), `maxRows?` | `columns`, `rows`, `rowCount`, `truncated` |
| `fs_list` | `path?`, `depth?` (1–8, default 2) | entries with type and size |
| `fs_read` | `path`, `startLine?`, `endLine?` | file text (slices carry a header line) |
| `fs_search` | `pattern`, `path?`, `include?`, `exclude?`, `maxMatches?`, `contextLines?`, `ignoreCase?` | matches with line numbers and context |
| `fs_write` | `path`, `content` | path and bytes written (needs `writeEnabled`) |
| `http_fetch` | `url`, `raw?`, `maxBytes?`, `timeoutMs?` | status line plus body text |

Paths are root-relative (`notes/todo.md`) or absolute inside a root; with several roots a relative path resolves against the first root that contains it.

## Results

Per-call latency of each tool, 200 sequential calls per cell after 5 warm-ups, against the example data (4 tables, 40 orders, 4 text files). Apple M3, 8 GB RAM, macOS, Node v25.5.0, CPU only.

| tool | in-memory p50 | in-memory p95 | stdio p50 | stdio p95 |
|---|---:|---:|---:|---:|
| sqlite_query | 0.06 ms | 0.10 ms | 0.10 ms | 0.17 ms |
| sqlite_describe_table | 0.08 ms | 0.11 ms | 0.12 ms | 0.17 ms |
| fs_list | 0.15 ms | 0.18 ms | 0.17 ms | 0.27 ms |
| fs_read | 0.12 ms | 0.19 ms | 0.14 ms | 0.16 ms |
| fs_search | 0.26 ms | 0.34 ms | 0.28 ms | 0.53 ms |
| fs_read (rejected path) | 0.02 ms | 0.03 ms | 0.05 ms | 0.07 ms |

Reproduce with `pnpm build && node examples/bench.mjs 200`. The sandbox checks cost tens of microseconds; the stdio round trip adds roughly 0.03–0.05 ms over the in-memory transport.

## Testing

```bash
pnpm lint   # tsc --noEmit over src and tests
pnpm test   # builds dist/ then runs vitest: 11 files, 100 tests, ~1.3 s, no network
```

Unit tests cover the SQL tokenizer and gate, path containment on a temp tree with escape symlinks, host matching, HTML conversion, globs, config merging and the audit log. Integration tests connect an SDK `Client` to the server over `InMemoryTransport` and exercise every tool, resource and prompt, including each rejection, against a temp SQLite file and a local `http.Server` (no internet). `tests/http-transport.test.ts` runs the Streamable HTTP server on an ephemeral port, and `tests/stdio.test.ts` spawns the built `dist/cli.js` with `StdioClientTransport` to prove the shipped artifact answers `initialize`, `tools/list` and tool calls, and writes the audit file.

## Roadmap / Limitations

- The HTTP transport has no authentication; it is loopback-only by design. The SDK's OAuth router could be wired in for remote use.
- No statement timeout: `node:sqlite` exposes no progress handler, so a pathological recursive CTE blocks the (single-threaded) server until it finishes or the row cap is hit.
- `fs_search` runs user-supplied regular expressions; a catastrophic pattern can be slow within one file (bounded by `maxBytes`), and there is no per-search deadline.
- The host allowlist is by hostname; it does not pin resolved IPs or block private ranges for an allowlisted name.
- The HTML converter is regex based: `<pre>` whitespace is collapsed and links are not extracted.
- `fs_write` cannot create directories, delete or rename, on purpose; a dry-run/diff mode would be a useful addition.
- `node:sqlite` prints an `ExperimentalWarning` on Node 22–25; it is stderr-only and can be silenced with `--disable-warning=ExperimentalWarning`. Requires Node ≥ 22.13 (where the module is unflagged).

## License

MIT, Copyright (c) 2026 Rohan Reddy Jakkam.
