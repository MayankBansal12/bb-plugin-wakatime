# bb-plugin-wakatime

Time tracking for [bb](https://getbb.app) — like WakaTime, but for your AI agent work.

## What it measures

- **Working time** — the wall-clock union of evidenced active agent-turn
  intervals. An active thread status alone never starts a clock. Parallel
  agents do not inflate it (bounded by the length of the local calendar day).
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
  and busiest day. Working time and agent coverage now use the same turn evidence.
- **Daily shape** — unioned working time bucketed by the dashboard viewer's
  local hour and weekday, so a session crossing midnight is charged to both
  sides in the timezone where the dashboard is being viewed.
- **Trend** — the same totals for the equal-length window immediately before the
  selected one, which the dashboard shows as a change against it. "All time" has
  no window before it, so it reports no change.

Threads waiting for permission approvals or user interactions do not count.
Queued, idle, stopping, archived, deleted, and disconnected threads do not
accrue open-ended time. A logical turn start, active runtime, and absence of
pending interactions must all agree before live time is confirmed.
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
- **Legacy history** — `bb wakatime recheck-history` finishes the automatic
  history verification immediately. Unavailable histories stay excluded and
  the command reports how many threads still await evidence.

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

Turn lifecycle events define intervals, with pending/resolving interactions
splitting out waiting time. The collector drains all event pages before
confirming activity. Every 10 seconds it checks both thread/runtime status and
pending interactions, including threads whose idle notification was missed.
Open intervals contribute only through their last successful check; the
plugin does not extrapolate their end to the current time. A gap over 30 seconds,
a failed check, or a restart closes the segment at its last confirmed time and
requires a fresh observation to resume. A later turn start cannot supply a
missing completion timestamp.

Sessions retain project/machine attribution but never independently contribute
time. Existing inflated session rows remain available for audit and rollback;
loading this version corrects their effect on every summary without deleting
historical data. Legacy turns are rechecked against retained lifecycle events in bounded background
batches; pending waits are removed even from old rows marked completed. Verified
segments are stored separately, preserving the original timestamps and model
attribution. Rows without retained evidence or per-turn observations are
conservatively excluded, not guessed.
This can undercount older activity or the last few seconds before a missed
completion; it prevents those gaps from becoming hours or days of work.

## Development

```sh
npm run typecheck
npm test
npm run build
```

## License

MIT
