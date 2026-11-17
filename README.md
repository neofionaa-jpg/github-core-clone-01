# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/neofionaa-jpg/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/neofionaa-jpg/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A finished entry for [the contest](https://make.fun/bounty/github-core-clone-01): a single-process,
dependency-free (Node 22 standard library only) forge that speaks git smart HTTP, REST v3, GraphQL
v4 and MCP over one in-memory store. No `git` binary, no network beyond the harness, no wall clock
or randomness in any request path, so the state export is byte-identical across runs.

Local verification (2026-11-17, Node v24.22.1, `sdk/run.ts` against a fresh server): **120/120
conformance checks pass** (git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5),
**perf 147/200** (push p50 664 ms, clone p50 196 ms, read p50 1297 ms, write p50 189 ms),
**score 947/1000**. Two fresh-server runs produce identical check tables.

## What it implements

- **git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 (`ls-refs` with peel/symrefs/
  unborn/ref-prefix, `fetch` with shallow/deepen and `unshallow`) and v0 fetch, receive-pack v0 with
  `report-status`, `side-band-64k`, `delete-refs`. Pack read/write with zlib (plain objects only),
  pkt-line framing, SHA-1 via `node:crypto`. Fast-forward-only pushes; a non-fast-forward ref is
  refused per-ref (`ng <ref> non-fast-forward`) while the other refs in the same push apply.
- **REST v3** (`/api/v3`): repos, branches, commits, contents (create/update/delete with sha
  checks), labels, issues, comments, pull requests with files and squash merge, `Link` pagination,
  `X-GitHub-Request-Id` on every reply, Bearer auth (401 without it), JSON errors.
- **GraphQL v4** (`/api/graphql`): a small lexer/parser/executor for the documents `gh` sends —
  `viewer`, `repository` (+ `issues` with `states`/`orderBy`/cursor pagination, `pullRequests`,
  `pullRequest.files`), `node(id:)` with inline fragments, `__type`/`__schema` introspection, the
  five mutations (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`
  via Relay global ids), batched documents, unknown field → HTTP 200 with `errors`.
- **MCP** (`/mcp`): JSON-RPC 2.0 streamable HTTP, `server/discover` (2026-07-28, `supportedVersions`
  2026-07-28 + 2025-11-25) and legacy `initialize`; six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same
  store as REST; `-32601`/`-32602` for unknown tools/missing args, `-32700` as HTTP 400, 401
  without Authorization.
- **Determinism**: server-created commits use fixed timestamp 1700000000 and identity
  `Forge <forge@make.fun>`; request ids are counter-based; the viewer is always `adaiversen`
  (the scenario viewer, derived from the public `SCENARIO_SEED`).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server. This is the file to grow.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nbzvawaw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
