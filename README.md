# pi-tool-timeout

Pi coding-agent extension for one timeout policy over foreground execution.

> **No explicit budget -> 60s. This turn needs stdout/exit beyond 60s -> explicit timeout, max 7200s (2h).**
> **This turn does not need stdout/exit -> use an installed background-job capability. Outlive Pi -> systemd/tmux.**

Compatible with `@earendil-works/pi-coding-agent` `>=0.87.1 <0.88.0`.

## Design

This package does not own `bash`. It overlays a single timeout policy onto whoever already owns foreground tools. Detached background jobs are provided by the separate `pi-background-job` package.

The host has no wrap-current-tool API, so the overlay uses two adapters:

- **Native timeout** (`bash`, `powershell`): Pi already exposes `timeout`. On `session_start`, this extension aligns the live schema with the policy: the optional value is in seconds, with `0 < timeout <= 7200`, and the description states the 60s runtime default. On `session_shutdown`, it restores only fields that still contain this extension's values, so later sessions do not inherit the alignment and third-party schema edits are preserved. A `tool_call` hook fills `60` when omitted; schema validation rejects values outside `(0, 7200]` before the hook runs. The live implementation stays owner, so shell settings, renderers, spawn hooks, and other bash extensions keep working.
- **Signal wrap** (`grep`, `find`): native schemas have no timeout field. On `session_start`, the overlay adds `timeout?: number`, delegates to Pi's public factories, and races owner completion against the deadline. The caller is released at the deadline; the deadline `AbortSignal` asks the owner to stop its child and finish cleanup. Owner cleanup is cooperative, not a hard kill of arbitrary work, so late owner work may still finish in the background. Registration happens after the default active set exists, and the previous active set is restored, so installing this package does **not** enable grep/find.

Explicit positive timeouts are preserved. Parent cancellation is not turned into a timeout.

The policy upper bound on foreground timeout is 7200s (2h). Node's timer limit (~24.8 days) is not a wait budget. `timeout<=0` is invalid. There is no infinite foreground timeout.

Same-name extension tools are first-wins in Pi. This overlay wraps builtins when no earlier extension registered the same name. It cannot compose on top of an earlier same-name override.

## Install

Local path:

```bash
pi install /absolute/path/to/pi-tool-timeout
```

Project-local:

```bash
pi install -l /absolute/path/to/pi-tool-timeout
```

Git:

```bash
pi install git:github.com/GhabiX/pi-tool-timeout
```

Then restart Pi or run `/reload`.

## Semantics

```text
bash(command="rg foo .")                     -> 60s
bash(command="cargo test", timeout=1800)    -> 1800s
bash(command="sleep 1", timeout=7201)       -> blocked
grep(pattern="foo", path=".")               -> 60s
grep(pattern="foo", path=".", timeout=600) -> 600s
```

Use the separate `pi-background-job` package when a detached command is appropriate. Do not use a background job for a finite test whose result is needed next.

## Develop

```bash
npm test
npm run test:e2e
```

Requires Node `>=22.19.0`. `npm test` covers the timeout policy and overlay helpers. `npm run test:e2e` loads the extension through a local Pi 0.87.1 install.

## License

Apache-2.0. See [LICENSE](LICENSE).
