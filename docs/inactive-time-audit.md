# Inactive-time accounting audit

Working time must be backed by agent-turn evidence. Thread status, a plugin
heartbeat, and a later archive timestamp cannot establish a historical duration.

| Inflation path | Correction | Regression coverage |
| --- | --- | --- |
| Archive/delete replays an old start and closes its session at notification time | Close turn segments at their actual lifecycle boundaries; sessions are attribution only | Archive, delete, idle, failure and duplicate notifications on month-old turns |
| Thread is active before a turn starts or after it completes | Require an outstanding logical turn and an active runtime | No start; completed turn with stale active status |
| Completed historical turns separated by idle days share a session | Derive all totals, profiles, and breakdowns from turn segments | Multiple historical turns; legacy inflated session with retained source rows |
| Missing completion is closed at a later start | Use only the previous segment's last confirmation, or zero if never observed | Superseded turn separated by a month |
| An unfinished historical start is mistaken for current work | Begin a newly verified segment at observation time | Old open turn on an active thread; archived unmatched start |
| Idle/failed/deleted notifications are lost | Reconcile previously watched threads as well as the current active list | Missed idle event; terminal event replay |
| Persisted active status masks host disconnection, stopping, or waiting | Check `runtime.displayStatus` too | Reconnecting, waiting-for-host, stopping, idle runtime |
| History or status checks fail | Freeze at last successful per-turn observation and split on recovery | History/status failures and day-long outages |
| The plugin keeps running while an agent is gone | Never use a process heartbeat or `Date.now()` as an open interval's end | Frozen open totals and expired activity status |
| Event history spans multiple pages | Drain the entire backlog before confirming any live interval | Completion on page two; later-page failure |
| Pending/resolving interactions or interrupted approvals look active | Pause both waiting states; only a matching resolution resumes; interruption invalidates the logical turn | Multiple waits, resolving, interruption, unrelated resolution, live pending fallback |
| Crash/reload bridges an unobserved gap or leaves an orphan turn | Close all open turns at their own evidence, including turns without sessions; resume at a fresh observation | Reload after a day, orphan turn, no heartbeat grace |
| Old completed turns already include approval waits | Recheck retained lifecycle history and persist separate verified segments; exclude until checked | Historical day-long approval, idempotence, missing metadata, failure/retry |
| Database rollback leaves phantom cached sessions | Persist intervals and cursor transactionally without mutating a session cache | Injected cursor-write failure and clean replay |
| Parallel agents multiply wall-clock working time | Union evidenced intervals | Two simultaneous agents count once as working time |

The existing RPC shape is retained. `workingMs` and `agentCoverageMs` now use the
same evidence; `agentRuntimeMs` still sums overlapping agents. The obsolete
always-100% busy-share row is removed from the dashboard.

The collector cannot reconstruct activity whose lifecycle and observation
records are missing. It deliberately excludes unverified legacy closures and
unobserved gaps. Live totals refresh in polling increments rather than running
an unchecked clock. These limits favor undercounting uncertain time over
inventing continuous work.

Legacy verification runs in batches of ten threads per background sweep. Failed
histories do not starve later threads. `bb wakatime recheck-history` processes
up to 10,000 pending threads immediately and reports any still awaiting evidence.
Neither original session rows nor closed turn timestamps are rewritten.
