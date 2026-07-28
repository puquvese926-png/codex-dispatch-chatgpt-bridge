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

The watch manifest contains `schemaVersion`, the pinned `conversationId`, `surface: "chatgpt-main-chat"`, and an absolute `checkpointPath`. A successful handoff atomically records the task ID and normalized plan hash before reporting `handoff-ready`. This local checkpoint mutation is not a ChatGPT history mutation. Identity mismatch, unreadable surface, malformed protocol, changed-plan task ID reuse, and timeout all fail closed without sending.

`approve` is the only supported Codex-relayed second turn. It requires `-AllowSend`, an exact conversation ID, original bridge marker and task ID, then verifies the visible schema-valid proposal and idle blank composer. It sends only `CODEX_APPROVE <taskId>`. It is not an arbitrary continuation API. For embedded no-title Quick chat, start `watch` first and keep it active across approval; the surface may unmount before a later process can recover it by ID.

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
| `plan` | No | No | none; requires the intended batch manifest |
| `batch` | Yes | Creates new chats | `-AllowSend` |
| `resume` | No | No | `-AllowSend` forbidden |
| `watch` | No | No | exact later user approval inside the pinned conversation; `-AllowSend` forbidden |
| `approve` | Exact approval only | Appends one user turn | `-AllowSend` plus exact conversation, marker, proposal and task ID |
| `cleanup` | No | Deletes eligible chats | `-AllowDelete` |

## Results

Reports preserve job status, conversation ID, marker, promptHash, per-job `surface`, `submittedAt`, routing (`requestedSurface`, `selectedSurface`, and nullable `fallbackReason`), captured history title, assistant text metadata, image dimensions, artifact paths, bytes and SHA-256. The top-level `surface` is a transport summary: `chatgpt-quick-chat`, `chatgpt-main-chat`, `mixed`, or `unknown`; it is not a durable conversation identity. Reports omit credentials and embedded image bytes.

Plan reports and final batch reports preserve the full `dispatchPlan`. Final
batch reports also preserve `runState: "complete"`, the effective `timeoutMs`,
and `progressPath`. During execution, the sidecar at `progressPath` records
`state: "running"`, `currentJobId`, the dispatch plan, submitted/completed
counts, per-job identity, `submittedAt`, status, routing and artifact counts. It
is the durable status source when an outer shell returns before the bridge child
finishes. `-Detach` intentionally starts that child hidden and returns the
report, progress and log paths without waiting.

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

The pinned client currently permits two owned Quick Chat windows per wave only
when `-ExperimentalQuickChat` is explicitly selected and the current route plan
allows an attempt. Existing user windows reduce capacity and are never closed or
deleted by the bridge. The production default remains one serial main-surface
job at a time.
