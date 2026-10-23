# pi-timeout-policy

English | [简体中文](README.zh-CN.md)

One timeout policy for Pi's foreground tools. In Pi 1.3 and 1.4, `bash` has an optional timeout with no default, and `grep` and `find` have no timeout at all—a single hung command can stall the agent indefinitely. With this extension:

> **No explicit timeout: 60 s. A command that needs longer: explicit timeout, at most 7200 s (2 h).**
> **A command whose output is not needed this turn: run it as a background job. Work that must outlive Pi: systemd or tmux.**

```text
bash(command="rg foo .")                     -> 60s
bash(command="cargo test", timeout=1800)    -> 1800s
bash(command="sleep 1", timeout=7201)       -> rejected
grep(pattern="foo", path=".")               -> 60s
grep(pattern="foo", path=".", timeout=600) -> 600s
```

## Why it is built this way

- **A policy, not a new bash.** The extension does not replace `bash`. It layers one timeout rule over whichever tools already own foreground execution, so shell settings, custom renderers, spawn hooks, and other bash extensions keep working.
- **Every foreground wait is bounded.** Foreground calls never wait indefinitely. Long work either declares an explicit budget of up to two hours or moves to the background with [pi-background-job](https://github.com/GhabiX/pi-background-job).
- **The model sees the rule.** Tool schemas state both the default and the upper limit, and schema validation rejects out-of-range values before anything runs.

## Features

- `bash` and `powershell`: an omitted timeout defaults to 60 s; explicit values must fall in `(0, 7200]`.
- `grep` and `find`: gain a `timeout` parameter governed by the same rule.
- Installing the package does not enable `grep` or `find`; the active tool set stays unchanged.
- Schema changes are reverted on session shutdown, touching only fields that still hold this extension's values.

## Install

```sh
pi install npm:@spinejit/pi-timeout-policy
```

If Pi is already running, restart it or run `/reload`.

Try it for one session without installing:

```sh
pi -e npm:@spinejit/pi-timeout-policy
```

## How it works

Pi has no API to wrap the current owner of a tool in place, so the overlay uses two adapters:

- **Native timeout** (`bash`, `powershell`): Pi already exposes `timeout` on these tools. On `session_start`, the extension aligns the live schema with the policy: the optional value is in seconds with `0 < timeout <= 7200`, and the description states the 60 s runtime default. On `session_shutdown`, it restores only fields that still hold this extension's values, so later sessions do not inherit the alignment and third-party schema edits are preserved. A `tool_call` hook fills in `60` when omitted; schema validation rejects values outside `(0, 7200]` before the hook runs. The original implementation remains the execution owner, so shell settings, renderers, spawn hooks, and other bash extensions keep working.
- **Signal wrap** (`grep`, `find`): the built-in schemas have no timeout field. On `session_start`, the overlay adds `timeout?: number`, delegates execution to Pi's public tool factories, and races owner completion against the deadline. At the deadline, the wrapper releases the caller immediately while the deadline `AbortSignal` asks the owner to stop its child process and clean up. Because owner cleanup is cooperative rather than a forced kill of arbitrary processes, slow owner work may finish in the background after the caller returns. Registration runs after Pi initializes the default active tool set and restores the previous active set immediately, so installing this package does **not** enable grep/find.

Explicit positive timeouts within the limit pass through unchanged. Parent aborts remain cancellations rather than timeouts.

The policy upper bound on foreground timeouts is 7200 s (2 h); Node's timer limit (about 24.8 days) is not a practical wait budget. `timeout <= 0` is invalid.

## Limits

- Same-name extension tools are first-wins in Pi. The overlay wraps the built-in tools when no earlier extension registered the same name; it cannot stack on top of an earlier same-name override.
- For `grep` and `find`, reaching the deadline releases the agent immediately, while stopping the underlying search process remains cooperative.

## Compatibility

Tested with Pi 1.3.0 and 1.4.0 on Node 22.23. Requires Node >= 22.19. Pi's packages are `"*"` peer dependencies.

## Development

```sh
npm test          # timeout policy and overlay helpers
npm run test:e2e  # loads the extension through the pi on PATH
```

## More from @spinejit

- [pi-background-job](https://github.com/GhabiX/pi-background-job): background jobs and output monitors that wake the agent when events occur.
- [pi-btw-cached](https://github.com/GhabiX/pi-btw-cached): `/btw` side questions on the main session's own request.
- [pi-compact-tree](https://github.com/GhabiX/pi-compact-tree): a compact process tree for Pi's terminal UI.

## License

Apache-2.0. See [LICENSE](LICENSE).
