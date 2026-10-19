# Upstream routing recovery

`workspace routing discovery failed` is handled as a recoverable provider routing
failure. It does not indicate that a local project directory should be recreated.
Authentication failures, permission failures and missing local directories are
not classified by a generic `workspace` or `routing` substring.

The Runner persists a retry on the existing Job, releasing its execution slot.
It reuses the capacity backoff (10/30 seconds, then 1/2/3/4/5 minutes; every five
minutes afterward, every thirty minutes after one hour) until recovery or user
cancellation. `retryKind=routing` and an `upstream` recovery checkpoint distinguish
this condition from model capacity; old attempt records remain valid.

Once input has been accepted or work observed, the next attempt continues the
same thread with a short recovery instruction. It does not resend the original
prompt, images, or accepted personal context. Runtime files and original output
baselines survive waiting and process restart. Without a known thread for observed
work, it follows the interrupted path instead of starting a replacement thread.
Cancelled Jobs cannot be revived; later work in the same conversation remains
ordered and unrelated conversations can run while this Job waits.

This recovery requires a terminal upstream failure and the previous execution to
have stopped. It does not automatically replay arbitrary connection interruptions
or mask permanent errors. Existing generic pre-execution transport retries and
post-execution interruption handling retain their separate boundaries.
