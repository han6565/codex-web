# Task callback persistence

Worker progress, thread identity, context usage and quota callbacks are processed
by a per-Job ordered `SqliteJobEventQueue` in the Runner. This applies to the host
bridge, isolated tenant Worker, Remote Worker and direct execution paths.

- Successful callbacks still apply synchronously. On SQLite BUSY/LOCKED, the
  callback and subsequent callbacks are buffered and retried asynchronously every
  100 ms. Callback attempts temporarily set the connection busy timeout to zero
  and restore it before returning; a lock must not block the Web event loop.
- Buffering is limited to 4,096 callbacks, 16 MiB of payload and 30 seconds of
  contention per queued callback. Non-contention errors are not retried.
- The awaited Worker result is not finalized until buffered callbacks have been
  persisted. Callback errors fail only the current execution; they cannot escape
  a socket/IPC event handler or trigger an automatic model-turn replay.
- Queue failure stops the affected execution. Terminal failure persistence has
  an additional bounded asynchronous retry, and failures are logged with Job ID.
  If storage stays unavailable beyond that retry, the persisted running row still
  needs existing startup recovery; this is not a durable queue for a database
  outage or Web restart.
- Cancellation/Runner cleanup discards pending callbacks and clears retry timers.
- `appendEvent` uses a savepoint for sequence allocation, event insertion and Job
  timestamp update. A failed second write must not leave an event that will be
  duplicated when its callback is retried. Existing enclosing transactions remain
  owned by their callers.

Use supported application APIs for online data changes. When a scoped maintenance
transaction is unavoidable, perform full-database scans and file operations
outside the write transaction. Inside the transaction, validate only the intended
rows, write the bounded changes and commit promptly. Keep a scoped before-image
and compare current values on recovery; do not restore an old full database over
new user activity or replay an interrupted migration blindly.

Regression coverage includes a real SQLite writer held for more than five seconds,
non-blocking callback delivery, ordering/no duplicates, finalization draining,
bounded failure, memory limits, cancellation, atomic rollback and Runner integration.

## Final result persistence and publication

Finalization status, staging journal, files-ready journal, result transaction and
completion publication use the same bounded asynchronous SQLite write retry.
Only the failed persistence operation is retried; file preparation, model turns
and executed tools are not replayed. The personal-context revision travels in the
optional recovery payload field and commits in the result transaction, so there
is no separate metadata write after the answer has been committed.

Once `finalizeJob` commits the answer and files, late notification or cleanup
errors cannot change its completed status into failed/cancelled or reset the
conversation while a newer turn is running. A publication error preserves the
`db_committed` journal and records `finalization_error` for diagnostics. The Web
process retries only inactive, completed, database-committed publications every
30 seconds and waits for any in-flight recovery during shutdown. It never resumes
model execution or changes historical failed jobs in that background pass.
Startup recovery retains the existing handling of pre-commit journals.

Completion events are checked before retry, and publishing the journal is
idempotent. Errors before a durable result exists, including actual file integrity
or storage failures, retain the failure path. A prolonged database outage is not
reported as successful delivery before the result transaction commits.

The finalization regression uses a second real SQLite connection to contend at
each phase, including a writer held for over five seconds. It verifies event-loop
responsiveness, one execution/message/file/completion event, deferred publication,
newer-turn preservation and atomic context revision rollback.
