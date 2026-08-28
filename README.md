# bb-plugin-wakatime

Time tracking for [bb](https://getbb.app) — like WakaTime, but for your AI agent work.

## What it measures

- **Working time** — wall-clock while at least one thread is running. Parallel
  threads don't inflate it (capped at 24h/day by definition).
- **Agent runtime** — the sum of observed turn durations. Parallel turns add
  together, so runtime can be greater than wall-clock time.
- **Agent coverage** — wall-clock union of turn intervals. This answers “for
  how long was at least one observed turn running?” without double-counting.
- **Breakdowns** — unioned working intervals per project and machine, plus
  sampled runtime and turn count per model. Project and machine categories may
  overlap, so they are not presented as shares of a whole.
- **Concurrency** — duration-weighted average and peak simultaneous turns,
  plus swarm time with two or more turns running.
- **Rhythm** — median/p90 turn duration, turns per active hour, streaks,
  busiest day, and working time not covered by an observed turn.
- **Daily shape** — unioned working time bucketed by the dashboard viewer's
  local hour and weekday, so a session crossing midnight is charged to both
  sides in the timezone where the dashboard is being viewed.
- **Trend** — the same totals for the equal-length window immediately before the
  selected one, which the dashboard shows as a change against it. "All time" has
  no window before it, so it reports no change.

Threads waiting for a permission approval still count as active working time.
Model attribution is sampled near live turn starts because bb's persisted turn
events do not contain a model field; historical turns remain `unknown`.

## Install

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-wakatime.git@main
```

Or pin a release:

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-wakatime.git@semver:^0.5.0 --tag-prefix ""
```

## Use

- **Dashboard** — sidebar → Activity (today / 7d / 30d / all).
- **CLI** — `bb wakatime today` or `bb wakatime week`.

## Privacy & data

- 100% local: everything is stored in the plugin's own SQLite database on your
  bb server (`<dataDir>/plugins/wakatime/data.db`). No network calls, no
  telemetry.
- Never stored: thread titles, prompts, messages, or file contents. Only
  intervals, stable project/host IDs for new rows, project/machine names,
  provider/model strings, attribution quality, closure reason, and turn counts.
- The dashboard sends the browser's IANA timezone with each query. Stored
  intervals are absolute timestamps, so agents and the bb server may run in
  different timezones without shifting the chart. If the server does not
  recognise the zone it falls back to its own and says so in the response, which
  the hour and activity-graph panels label. The CLI uses the bb server's
  timezone because a terminal invocation does not expose the viewer's browser
  timezone.

## How it works

Thread lifecycle events open/close sessions; a background poller drains
turn-started/turn-completed events to record turns. One SQLite transaction
persists each drained event page together with its replay cursor. All stats are
computed from clipped intervals at query time. After a crash, startup recovery
closes persisted open intervals at the last heartbeat plus a short grace period
and starts a new session for threads still running, so unobserved downtime is
not charged as work.

## Development

```sh
npm run typecheck
npm test
npm run build
```

## License

MIT
