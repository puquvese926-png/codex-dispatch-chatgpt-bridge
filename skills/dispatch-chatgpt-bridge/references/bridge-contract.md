# Bridge contract

## Routing

Bridge jobs must be self-contained. GPT chats cannot read local paths; the calling Codex agent attaches or otherwise supplies user-authorized visual inputs through the supported visible workflow and keeps local file operations, validation and project edits in Codex.

The integrated ChatGPT route is a version-gated UI adapter. Production defaults
to the verified `serial-main-chat` mode. Native Quick Chat is disabled unless the
caller explicitly passes `-ExperimentalQuickChat`; it is an opportunistic
parallel route, not guaranteed capacity.

Before a mutating batch, `plan` validates the same manifest and references,
performs the current read-only probe, reads the session-scoped Quick Chat health
cache, and writes a route decision containing:

- `selectedMode` and `selectedSurface`;
- effective concurrency and number of waves;
- per-job timeout and serial worst-case collection time;
- whether Quick Chat will be attempted and why;
- a user-facing notice that must be shown before sending.

`batch` recomputes this plan immediately before submission and embeds it in the
progress sidecar and final report. A stale plan never authorizes a send.

## Preflight path ownership

Every command with a business input or output runs this order before discovery,
controller/checkpoint locking, CDP access, UI evaluation or output writes:

1. parse and normalize CLI arguments;
2. read the command input once and strictly validate it;
3. resolve and audit the complete role-tagged path set;
4. preload state needed by the operation when the contract permits it;
5. discover the bridge and only then acquire locks, touch the UI or write results.

`discover` and `probe` have no business manifest; their read-only preflight only
audits the standalone bridge state path. A prepared manifest object, rather than
its path, is passed to every plan, batch, resume, watch, approve and cleanup
runner. Batch lifecycle state is also preloaded before discovery so the runner
does not reread the manifest or ledger by path after discovery.

The audit assigns roles to the CLI input, report/output, derived progress file,
standalone state, controller lock, capability cache, schema-v2 lifecycle ledger,
watch checkpoint and its lock/audit metadata, reference files and cleanup
artifacts. It compares three identities: case-insensitive normalized Win32
lexical identity, canonical identity from `realpath` (including the nearest
existing ancestor for a missing output), and physical `dev:ino` identity for
existing files. Symlink/junction/reparse aliases and hardlinks therefore fail
closed. Two references or two artifacts that resolve to the same identity also
fail. A path used once for one logical object is represented by one role; the
audit does not manufacture a self-collision.

Preflight is read-only: it may use `lstat`, `stat` and `realpath`, but never
creates directories or files and never renames, unlinks or deletes. A collision
returns `EPATHCOLLISION` with the conflicting roles; discovery, CDP, UI and
output writes must all remain at zero. Missing output/progress/ledger/checkpoint
paths may be audited from their nearest existing ancestor but are not
pre-created.

This protects the command from accidental aliases and path-role collisions at
the time of preflight. It is not a claim to defeat a malicious concurrent file
system replacement after preflight (TOCTOU). The runner uses the validated
in-memory manifest thereafter; callers needing stronger hostile-filesystem
guarantees must add an operation-specific identity recheck immediately before
the write.

## Generic batch schema v1

Use for independent text, review or transformation jobs:

```json
{
  "schemaVersion": 1,
  "jobs": [
    { "id": "review-a", "prompt": "完整提示词" }
  ]
}
```

## Image batch schema v2

All image generation and image editing use:

```json
{
  "schemaVersion": 2,
  "jobType": "image-generation",
  "conversationMode": "fresh-per-job",
  "retentionDays": 7,
  "lifecycleLedgerPath": "C:\\absolute\\state\\chatgpt-generation-conversations.json",
  "jobs": [
    {
      "id": "candidate-a",
      "prompt": "完整且已批准的提示词 A",
      "references": []
    }
  ]
}
```

`jobType` is `image-generation` or `image-edit`. Every v2 job requires an explicit `references` array and receives a unique new conversation:

- Original `image-generation` uses `references: []`.
- Reference-guided `image-generation` accepts 1–8 local PNG/JPEG/WebP references with approved hashes.
- `image-edit` requires 1–8 local PNG/JPEG/WebP references with approved hashes.

Native Quick chat uses `local-chatgpt:<uuid>`; the full integrated main ChatGPT surface may use its exact active `local:<uuid>` thread identity. Before opening any chat, the bridge verifies every supplied file's absolute path, supported type, size and SHA-256. It skips the visible attachment workflow only when an original `image-generation` job has an empty list. Empty references never weaken the fresh-conversation, prompt, lifecycle, artifact or cleanup checks. A later iteration is another batch and another conversation.

Prompts are non-empty, at most 30,000 characters and preserved exactly. IDs are unique lowercase kebab-case. Unknown fields are rejected.

## Resume

Resume performs no send. Every job must copy its exact per-job `surface`, `conversationId`, `marker` and `promptHash` from the original report. `surface` is mandatory: use `chatgpt-quick-chat` for a native Quick chat renderer and `chatgpt-main-chat` for the retained embedded/main surface. A `local-chatgpt:<uuid>` value can occur on either surface, so its shape is not a routing signal. The report's top-level `surface` is a command transport summary; only the per-job field is authoritative for recovery.

With a title, native Quick chat recovery opens a fresh recovery window, selects that exact visible history title and accepts the result only when the original marker is present. If a submitted native Quick chat job has no captured title, omit `title`: the bridge first reopens the exact original `local-chatgpt:<uuid>` read-only. If that local route no longer contains the marker, it may open a fresh blank recovery window and scan visible history rows that have their own item menu. This history fallback does not require the blank window to assume a synthetic conversation route; it must instead prove a blank composer and zero rendered conversation units before enumeration. Main-surface recovery attaches only to the verified retained renderer, tries the exact active conversation identity plus marker, and may then scan visible titled history rows with the same exact identity and marker guard. It never returns unrelated content and accepts only the unique proven conversation. A marker miss is `not-recovered`, never a resend.

```json
{
  "schemaVersion": 1,
  "jobs": [{
    "id": "candidate-a",
    "conversationId": "local-chatgpt:00000000-0000-4000-8000-000000000000",
    "marker": "CODEX-BRIDGE-12345678-candidate-a",
    "promptHash": "64-character-lowercase-sha256",
    "surface": "chatgpt-quick-chat",
    "title": "ChatGPT 历史列表中的唯一标题"
  }]
}
```

Direct recovery without a captured title:

```json
{
  "schemaVersion": 1,
  "jobs": [{
    "id": "candidate-a",
    "conversationId": "local-chatgpt:00000000-0000-4000-8000-000000000000",
    "marker": "CODEX-BRIDGE-12345678-candidate-a",
    "promptHash": "64-character-lowercase-sha256",
    "surface": "chatgpt-main-chat"
  }]
}
```

Never convert `unknown-after-submit` or `timeout-after-submit` into a new send.

## Watch / handoff

`watch` implements the bounded, read-only GPT-to-Codex protocol defined in [handoff-contract.md](handoff-contract.md). It observes only rendered message units inside the exact active `chatgpt-main-chat` identity. GPT must emit a schema-valid `CODEX_HANDOFF` proposal, and a later user-role message must exactly approve the same task ID.

The watch manifest contains `schemaVersion`, the pinned `conversationId`, `surface: "chatgpt-main-chat"`, and an absolute `checkpointPath`; watch passes that validated manifest surface to every read. A successful handoff is a cross-process transaction: the watcher acquires the deterministic Windows named-pipe resource derived from the checkpoint path, writes adjacent `owner.json` audit metadata containing a random owner ID, PID, exact checkpoint path and acquisition time, then re-reads and strictly validates the checkpoint from disk while holding the OS lease. It selects the next approved handoff from that fresh state, records the task ID and normalized plan hash with the hardened adjacent-temp atomic JSON writer, and only then returns `handoff-ready`; the owned pipe is released in `finally`. The named pipe, not the metadata directory, is the exclusion truth and Windows releases it when the process exits. A second watcher that observed the same proposal before locking must wait boundedly for the pipe, re-read the committed checkpoint and return `no-new-delivery`, never a second ready result. Young, incomplete or stale metadata is never used to delete or fence a live pipe; once the pipe is acquired, the new owner overwrites the audit record. Corrupt, rebound or identity-mismatched checkpoints fail closed and are never replaced. If report writing fails after the checkpoint commit, the checkpoint remains the deduplication fact and a later watcher must not redeliver. This local checkpoint mutation is not a ChatGPT history mutation. Identity mismatch, unreadable surface, malformed protocol, changed-plan task ID reuse, lock contention at the deadline and timeout all fail closed without sending.

`approve` is the only supported Codex-relayed second turn. It requires `-AllowSend`, an exact conversation ID, original bridge marker and task ID, then verifies the visible schema-valid proposal and idle blank composer. Its focus and submit expressions both receive the actually opened prepared `surface` plus expected conversation ID and reuse the exact owner resolver; Main and Quick Chat never guess each other. Focus checks only the exact root's unique blank composer and busy/stop state. The click-capable expression resolves that root again in the same evaluation, requires the unique same-root composer to equal exactly `CODEX_APPROVE <taskId>` and requires the unique same-root send control before clicking. Its read-only proposal/acknowledgement checks use the surface of the actually opened prepared session, so direct recovery may use Quick Chat without guessing from the ID. It sends only `CODEX_APPROVE <taskId>`. It is not an arbitrary continuation API. For embedded no-title Quick chat, start `watch` first and keep it active across approval; the surface may unmount before a later process can recover it by ID.

## Lifecycle ledger

Schema-v2 batches append one entry per GPT conversation. Current entries preserve the per-job `surface` used for recovery. A failed read-only recovery remains in its own report and does not overwrite the original submitted status, run ID or report path in the ledger. Existing older entries without `surface` remain readable but must obtain the recovery surface from their original batch report. An entry is cleanup-eligible only when:

- job type is image generation/edit;
- status is `complete`;
- at least one downloaded local artifact has absolute path, bytes and SHA-256;
- a unique visible history title was captured;
- the retention deadline has passed;
- `userRetention` is not `keep`.

Ambiguous, incomplete, title-missing and missing-artifact entries remain blocked.

## Cleanup

`cleanup` reads the lifecycle ledger and requires `-AllowDelete`. For every due entry it:

1. rereads local artifacts and verifies bytes and SHA-256;
2. opens a fresh temporary GPT window;
3. selects the exact history title;
4. verifies the original marker in the conversation;
5. uses visible menu and confirmation controls to delete that one conversation;
6. verifies the title disappeared;
7. records the result without deleting images, reports or reviews.

Any selector, identity or hash uncertainty fails closed. Failed deletion remains pending for a later safe retry.

## Operation matrix

| Action | Sends content | Mutates history | Authorization |
| --- | ---: | ---: | --- |
| `discover` | No | No | none |
| `probe` | No | No | none |
| `status` | No | No | runner-only read-only launch inspection; no Node/CDP |
| `wait` | No | No | runner-only bounded read-only launch polling; no Node/CDP |
| `plan` | No | No | none; requires the intended batch manifest |
| `batch` | Yes | Creates new chats | `-AllowSend` |
| `resume` | No | No | `-AllowSend` forbidden |
| `watch` | No | No | exact later user approval inside the pinned conversation; `-AllowSend` forbidden |
| `approve` | Exact approval only | Appends one user turn | `-AllowSend` plus exact conversation, marker, proposal and task ID |
| `cleanup` | No | Deletes eligible chats | `-AllowDelete` |

## Results

Reports preserve job status, conversation ID, marker, promptHash, per-job `surface`, `submittedAt`, routing (`requestedSurface`, `selectedSurface`, and nullable `fallbackReason`), captured history title, assistant text metadata, image dimensions, artifact paths, bytes and SHA-256. The top-level `surface` is a transport summary: `chatgpt-quick-chat`, `chatgpt-main-chat`, `mixed`, or `unknown`; it is not a durable conversation identity. Reports omit credentials and embedded image bytes.

Image materialization is deliberately local and bounded. Only a strict
`data:image/png|jpeg|webp;base64,...` value, or an exact renderer-owned
`blob:app://-/<strict-id>` first materialized by the renderer canvas/chunk path
into that PNG data form, may become a local artifact. MIME, magic bytes, header
dimensions and the decoded limits are checked before allocation and before the
`wx` write: at most 30 MiB, 40,000,000 pixels and 16,384 pixels on either side.
Across one result, at most 20 images and 120 MiB of decoded image bytes are
accepted. Direct strict data URLs are reported as `sourceType:
"renderer-data-url"`; only data produced by the exact app-blob materializer is
reported as `sourceType: "materialized-app-blob"`.
PNG IHDR, JPEG SOF and WebP VP8/VP8L/VP8X headers are the dimension authority;
DOM-reported dimensions do not authorize a file.

HTTP(S), loopback, metadata-service, redirect-shaped and `blob:https` image
sources are metadata-only. The bridge never fetches or follows them, never
puts their URL in the final report, and never treats them as artifacts. The
report may retain bounded width/height/alt with
`sourceType: "remote-image"` and `materializationStatus: "metadata-only"`.
SVG, GIF, percent-encoded data URLs, non-canonical base64, unknown blob
protocols, malformed headers, MIME/magic mismatches and incomplete/oversized
blob chunks fail closed without a file. A remote-only result therefore needs a
renderer-provided materialized value or a user-supplied local save if a local
artifact is required.

Plan reports and final batch reports preserve the full `dispatchPlan`. Final
batch reports also preserve `runState: "complete"`, the effective `timeoutMs`,
and `progressPath` when the command actually implements a progress sidecar.
During batch execution, that sidecar records `state: "running"`, `currentJobId`,
the dispatch plan, submitted/completed counts, per-job identity, `submittedAt`,
status, routing and artifact counts. `resume` and `watch` do not write a fake
progress sidecar; their detached records have `progressPath: null`.

`-Detach` creates a durable launch record before starting the child and returns
`launchId`, `launchPath`, `reportPath`, `progressPath`, `stdoutPath`,
`stderrPath`, PID/start-time identity and the recorded authorization facts.
All runner JSON emitted to stdout or stderr is UTF-8 without a BOM, including
detached launch handles and runner-only `status`/`wait` results; callers must
parse those bytes as UTF-8 even when PowerShell has no interactive console.
`launchId` is also injected as a validated, ignored bridge launch token into the
final Node command line. Process attribution matches that token, never merely a
report path; two callers sharing an output path cannot adopt each other's PID.
`wrapperPid` is retained only as a legacy diagnostic alias; on the current
direct-CIM path it equals the final Node PID and is not a second process. Logs
live inside the random launch directory, not beside the business output.
On Windows the production detached path creates the final Node process directly
through `Win32_Process.Create`; it does not pass the command through `cmd.exe`
or rely on a PowerShell argument-list join. Arguments use Windows CRT quoting,
including trailing backslashes before quotes. The launcher passes the two
launch-bound `--bridge-stdout-log` and `--bridge-stderr-log` arguments to that
same final Node process. Node appends bounded JSON success/error records there;
the durable report remains the result source and the logs never replace it. A
synchronous CLI may omit both launch-log arguments; in that mode no launch-log
append is attempted. Detached execution must pass both absolute `stdout.log` and
`stderr.log` paths inside the UUID launch directory. A missing pair member, empty,
relative, malformed, overlong, wrong-name or wrong-directory path fails before the
operation. A failure while appending a diagnostic record is swallowed after the
command result is known and cannot change a completed/submitted/unknown result or
invite a resend.
The launch record is atomically rewritten from `starting` to `running` (or a
durable `failed` record if start fails). `status` reads only a bounded,
strictly validated launch record; `wait` performs the same inspection in a
bounded loop. Neither starts Node, contacts CDP, mutates a report, resumes a
job, resends content or deletes anything. A valid report is terminal; a
corrupt/oversized report or progress file is surfaced as `report-corrupt` or
`progress-corrupt`, never silently treated as absent. PID reuse is rejected by
matching the recorded process start time.

If Windows creates the detached final Node process but it cannot be uniquely
attributed, the record remains `state: "starting"` with
`errorClass: "created-but-unattributed"` and `unknown-after-launch` status.
`wrapperPid` is retained for schema compatibility as a legacy diagnostic alias;
on the current direct CIM path it equals the final Node PID, not a second worker
PID. This is not a pre-start failure and is never an automatic retry permission.
Only a proven final-process creation failure may become a durable
`failed`/`not-created` launch.

The Codex bootstrap restart handoff has a separate durable ready/ack contract.
The request is schema version 2 and binds `operationId`, `requestPath`,
`reportPath`, `readyPath`, `ackPath`, `statePath`, `packageFullName`,
`processIds`, `port`, `requestedAt` and `dispatchDeadline` to one non-reparse
state directory. The worker reads the request as strict UTF-8, rejects unknown
fields, wrong JSON types, expired deadlines, package identity changes and path
rebinding, then atomically writes `worker-ready` with its actual PID. The parent
must observe that exact ready record and write one matching `ack` before the
worker may write `stopping-existing` or call `Stop-Process`. The worker repeats
the ack, identity and deadline check immediately before that boundary.

Restart reports preserve the ordered states `dispatching` → `worker-created` →
`worker-ready` → `restart-dispatched` → `stopping-existing` → `starting` →
`complete` (with `failed` on any closed failure). `created-but-unattributed`,
missing ready, missing/invalid ack, expired request and any path mismatch are
not a success and never imply retry permission: the report must say
`retryAllowed: false` and `recoveryRequired: true` unless the process service
definitively returned `not-created`. `allowSend`/restart authorization remains
the caller's parameter fact, not cryptographic proof of the user's identity.
The production handoff invokes the absolute Windows PowerShell 5.1 executable,
not a PATH lookup. `discover`/`probe` can diagnose a missing endpoint, but the
bootstrap must not promise that a running Electron instance can hot-enable CDP;
real restart still requires explicit authorization. The protocol self-test is a
test-only gated harmless worker and never stops or closes Codex.

The launch handle is the supported semi-automatic wait interface:
`plan -> explicit authorization -> detach -> status/wait -> report or one
read-only recovery decision`. It is not a persistent daemon, automatic reply
service, password-cryptographic proof of user approval, or a way to avoid Codex
quota. The two-directory install remains transactional-with-rollback rather
than truly cross-directory atomic.

Every `batch`, `resume`, `approve`, and `cleanup` obtains one atomic controller
lock beside the standalone bridge state. The lock is shared across all report
paths and records only process/control metadata. A live owner blocks the second
controller; a dead owner can be reclaimed only after the operating system proves
that PID absent. Invalid lock state fails closed. The same-report progress guard
remains an additional idempotency check.

Quick Chat health is cached beside the standalone state for fifteen minutes and
is scoped to the exact Codex version plus CDP browser identity. A failure in one
experimental batch prevents later batches in that session from repeating the
same native wait. Browser restart, client version change, or cache expiry returns
the capability to unknown.

The default generation collection window is 600,000 ms. Values remain bounded to 5,000–900,000 ms. A `timeout-after-submit` is a valid durable outcome, not a pre-submit failure: content may have been sent and the exact job must remain sealed for read-only resume.

Main-surface submission and collection hold an atomic rendered lease: the exact
conversation identity and original marker must match in the same scoped snapshot
before acknowledgement, before any launcher action, and on every collection
poll. The `聊天` / `Quick chat` launcher is a toggle. Its missing or stale
`aria-pressed` value is never permission to click while the task-owned dialog is
already visible. Collection may reopen the entry only after the current lease is
not visible, and it must prove the same lease again before consuming a result.

Read-only snapshots, result collection and handoff-unit reads must receive the
expected `surface` and conversation ID explicitly. The surface must be exactly
`chatgpt-main-chat` or `chatgpt-quick-chat`; the bridge never invents a
`chatgpt-handoff` surface and never guesses Main versus Quick Chat from the
current DOM or route. Each read reuses the corresponding exact ChatGPT owner
resolver: one visible owner, one verifiable DOM identity, and for native Quick
Chat the current strict `app:` route checked inside the same
`Runtime.evaluate`. Marker, rendered message units, image/blob sources,
composer/stop/send state and handoff code blocks are read only from that root.
Zero or multiple owners, identity or route drift, a missing expected ID or an
invalid surface return an unreadable result or fail at expression construction.
The main submission lease resolves the owner once and derives both its identity
and snapshot from that same root; it never chains two independent root
selections. Explicit identity attributes are authoritative: exactly one must
equal the expected ID. The active-sidebar fallback is allowed only for a Main
surface with no explicit identity and an explicit ChatGPT mode/composer; an
expected-plus-other or other-only identity conflict fails closed.

The fresh-conversation gate accepts an exact visible `新聊天` / `New chat`
semantic label from `aria-label`, title or rendered text. Icon-only controls
therefore remain usable without broadening the selector to unrelated Codex
buttons. A successful click is not enough: blank-surface and new exact-identity
checks remain mandatory before send.

Ordinary batch submission binds composer focus, readiness and send to the
prepared job's exact `surface` and `conversationId`; readiness and send also bind
the original marker. A native Quick Chat renderer may use its document root only
after the outer CDP session has verified the exact conversation route, and that
prepared flag is not a continuing lease. Focus, readiness and send each parse
their current `location.href` using the same strict `app:`/`initialRoute` rules
as target discovery and require the live route to equal the expected
`local-chatgpt:<uuid>`. Missing, malformed, credential-bearing, prewarm,
non-`app:` and stale routes fail before control use; send repeats this check
inside the click-capable evaluation. Embedded Quick Chat and the full main
ChatGPT surface must resolve exactly one visible
ChatGPT owner whose real DOM identity equals the expected `local-chatgpt:<uuid>`
or `local:<uuid>`. Composer and send must be unique descendants of that same
owner. A global active sidebar identity, an earlier Codex composer, another
dialog, or a second matching owner cannot authorize submission.

For jobs with references, the attachment button, file input,
`DOM.setFileInputFiles` node and acknowledgement poll use that same prepared
surface and conversation identity. The bridge resolves exactly one visible
attachment control and exactly one `input[type="file"]` inside the leased owner.
The button is clicked at most once; after that, input appearance is polled with
a read-only exact-root count expression, and a count above one fails
immediately. The bridge obtains the input through a CDP remote object followed
by `DOM.requestNode`, then releases the remote object on both success and
failure. Attachment acknowledgement inspects only that owner's `input.files`
or visible attachment/file-semantic `aria-label`, `title`, `img[alt]` or
explicit attachment/file `data-testid`; arbitrary root text, history units,
composer text and ordinary div text never prove an upload. Every expected
basename must be proven there while the identity/Quick Chat route remains
current. A portal input outside the exact owner, zero or multiple
controls/inputs, or any identity drift fails closed before send. Original
generation with `references: []` skips all attachment UI/CDP calls; this
paragraph does not claim snapshot or approval root isolation.

The send expression rechecks exact identity, same-root composer marker and
same-root send ownership atomically before clicking. A returned `clicked: false`
is durable `not-submitted`. Once the bridge enters that click-capable
`Runtime.evaluate`, a lost or exceptional CDP response is
`unknown-after-submit`; the report preserves `attemptedAt`, expected conversation
identity, surface and marker and must never be downgraded by an outer pre-submit
catch or retried automatically.

Approval follows the same boundary with its own exact attempt record. Focus or
`Input.insertText` failures occur before the click attempt and remain
`not-submitted` with `submittedAt: null`. An explicit `{ ok: false }` or
`{ clicked: false }` from the approval expression is also `not-submitted` and
never enters acknowledgement. Only `{ ok: true, clicked: true }` becomes
submitted; if CDP/`Runtime.evaluate` fails after the click-capable evaluation
has begun, the result is sealed as `unknown-after-submit` with `attemptedAt`,
`submittedAt`, expected surface and conversation ID. Identity, route or
acknowledgement drift after a possible click is read-only recovery territory;
it never authorizes an automatic second approval.

The pinned client currently permits two owned Quick Chat windows per wave only
when `-ExperimentalQuickChat` is explicitly selected and the current route plan
allows an attempt. Existing user windows reduce capacity and are never closed or
deleted by the bridge. The production default remains one serial main-surface
job at a time.

## Deployment version gate

The repository is the distribution source. `bridge-version.json` is the only
version metadata source and supplies `bridgeVersion` and `protocolVersion`.
`install-global.ps1` creates one canonical `deployment-manifest.json` for both
the Skill target and the Runtime target. Its manifest hash is computed from
canonical content with `manifestHash` excluded, so either copy can verify it
without a self-hash cycle. The manifest includes the schema/version fields,
source commit status, normalized absolute target bindings, and the SHA-256 of
every managed file. Skill inventory paths are relative to the Skill root;
Runtime inventory paths are relative to the Runtime deployment root and include
`windows/scripts/...`, which is the path the runner executes. The two manifests
must be byte-equivalent after canonicalization. Extra files under either target
are preserved and ignored; they are never used to satisfy a managed entry or
overwritten as part of an upgrade.

Every managed path is a strict normalized forward-slash relative path: no
backslashes, drive/UNC prefixes, colon, NUL, leading/trailing slash, empty
segment, `.` or `..` segment, Windows-invalid filename character or trailing
dot/space is accepted. Runtime entries must start with the exact
`windows/scripts/` prefix. Before any `Join-Path`, the same validator is used by
manifest shape validation and inventory resolution. Paths are sorted with ordinal
comparers, and case-insensitive Windows duplicates are rejected explicitly rather
than delegated to locale-sensitive sorting.

The manifest schema is strict for version/protocol/commit/status/transaction
types and known keys. A clean exact status, dirty status or Git-status-unavailable
status requires a lowercase 40-hex commit; unavailable requires the literal
`unavailable`. Invalid or unknown fields fail before target tree reads, Node or
CDP.

`sourceCommitStatus=exact-clean` means the recorded Git HEAD was read from a
clean worktree. `dirty-worktree` means the HEAD is only provenance and the file
hashes are authoritative; `unavailable` means Git could not provide a commit.
No dirty tree is presented as an exact release.

Installation is transactional but not two-directory atomic: it builds both
trees in same-volume sibling staging paths, validates the complete pair, journals
precise backup/target paths, switches the two targets, then removes owned
residue. On failure it restores the old pair. A journal left by process death is
recovered only when its transaction ID, parent, prefix, target and manifest are
verified; unknown/corrupt residue is refused, not blindly deleted. The next
install is the recovery command. It does not restart Codex.

Journal recovery also requires schema version 1, one of the known transaction
states, strict absolute path/string fields, a lowercase manifest hash and real
JSON booleans for the original-target flags. Unknown state, wrong field type or
malformed path leaves the journal and all staging/backup residue untouched.

Before Node, CDP, UI mutation or business output, `run-bridge.ps1` requires the
current Skill manifest and selected Runtime manifest to match in canonical hash,
bridge/protocol version, target binding and managed-file hashes. `plan`,
`batch`, `resume`, `watch`, `approve` and `cleanup` fail closed with zero Node/CDP
calls when this gate fails. `discover` and `probe` are the only allowed
manifest-diagnostic paths; an explicit `-Root` does not bypass the gate for
mutating or operational actions.
