# bb-plugin-wakatime

Time tracking for [bb](https://getbb.app) — like WakaTime, but for your AI agent work.

## What it measures

- **Working time** — wall-clock while at least one thread is running. Parallel
  threads don't inflate it (capped at 24h/day by definition).
- **Agent compute** — sum of turn durations (prompt → agent finished), attributed
  to the model configured at each turn start. Turns that started before the
  plugin was installed are recorded with model `unknown`.
- **Breakdowns** — working time per project and machine (interval union);
  compute time and turn count per model.
- **Parallelism** — agent compute ÷ working time (>1× means agents were
  running concurrently).

Threads waiting for a permission approval still count as active in v1.

## Install

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-wakatime.git@main
```

Or pin a release:

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-wakatime.git@semver:^0.1.0 --tag-prefix ""
```

## Use

- **Dashboard** — sidebar → Time (today / 7d / 30d / all).
- **CLI** — `bb wakatime today` or `bb wakatime week`.

## Privacy & data

- 100% local: everything is stored in the plugin's own SQLite database on your
  bb server (`<dataDir>/plugins/wakatime/data.db`). No network calls, no
  telemetry.
- Never stored: thread titles, prompts, messages, or file contents. Only
  intervals, project/machine names, provider/model strings, and turn counts.
- Day boundaries use the bb server's local timezone.

## How it works

Thread lifecycle events open/close "sessions"; a background poller drains
turn-started/turn-completed events to record per-model "turns". All stats are
computed from these interval rows at query time. After a crash or restart,
startup reconciliation adopts or closes any intervals left open.

## License

MIT
