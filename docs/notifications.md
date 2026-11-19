# Get pinged

Bridge prints a boxed **Bridge result** card at the end of every `bridge patch`
and can optionally post to Slack via an incoming webhook. The event schema is
`bridge-notify.v1`.

Channels:

- **terminal** — always, last output on a standalone patch
- **slack** — incoming webhook from `~/.bridge/settings.json` or `BRIDGE_SLACK_WEBHOOK_URL`
- **command / macOS** — existing local hook (`BRIDGE_NOTIFY_COMMAND`, `BRIDGE_NOTIFY_TITLE`, `BRIDGE_NOTIFY_BODY`, `BRIDGE_SUMMARY_PATH`)

The webhook is **never** read from the repo’s `bridge.config.json`. Putting one
there is ignored.

## Defaults

`notifications.on` defaults to:

```json
["pr_created", "pr_updated", "blocked", "error"]
```

`no_updates` and `pr_reused` are a heartbeat. They are **off** so a quiet day
does not ping Slack. Turn them on for a demo (for example Marcus’s walkthrough):

```json
{
  "notifications": {
    "on": [
      "pr_created",
      "pr_updated",
      "pr_reused",
      "no_updates",
      "blocked",
      "error"
    ],
    "slack": {
      "webhookUrl": "https://hooks.slack.com/services/T.../B.../..."
    }
  }
}
```

Store that file at `~/.bridge/settings.json` and lock it down:

```bash
chmod 600 ~/.bridge/settings.json
```

Bridge warns if the file is readable by group or others. Environment variable
`BRIDGE_SLACK_WEBHOOK_URL` overrides the file.

## Slack incoming webhook (sandbox, 5 steps)

Use a **sandbox** Slack workspace, not production.

1. Create or open a Slack sandbox workspace you control.
2. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**. Name it `Bridge` and pick the sandbox workspace.
3. Open **Incoming Webhooks** → toggle **Activate Incoming Webhooks** → **Add New Webhook to Workspace**.
4. Choose a private channel (for example `#bridge-sandbox`) and copy the URL (`https://hooks.slack.com/services/...`).
5. Put the URL only in `~/.bridge/settings.json` (mode `600`) or `BRIDGE_SLACK_WEBHOOK_URL`, then run:

```bash
bridge notify test
bridge doctor
```

`bridge notify test` posts a sample card and prints `ok` / `fail` per channel.
It never prints the URL. `bridge doctor` shows `Slack: configured`,
`Slack: not configured`, or `Slack: last send failed`.

A failed Slack post is logged as `notify_failed` with a redacted reason and
**does not** change the patch exit code. Bridge retries once, with a 5s timeout,
using Node’s built-in `fetch`.

## Batch digest

`bridge schedule run` sends **one** digest (one line per repo) to Slack when any
repo outcome is in `notifications.on`. Per-repo `bridge patch` runs inside that
batch stay silent (`BRIDGE_BATCH_ID`), matching the local-notify fix: you do not
get one message per repo plus one for the batch.

A standalone `scripts/bridge-daily.sh --notify` still fires its local hook;
inside a batch it stays quiet.

## Event fields

| Field | Meaning |
| --- | --- |
| `schema` | `bridge-notify.v1` |
| `repo` | Repository name |
| `baseBranch` | Base branch |
| `outcome` | `pr_created` \| `pr_updated` \| `pr_reused` \| `no_updates` \| `blocked` \| `error` |
| `prUrl` | Pull request URL when one exists |
| `packages` | `direct`, `transitive`, `patch`, `minor`, `major` counts |
| `security` | Audit counts before/after by severity |
| `blockedReason` | Gate or error headline |
| `runId` | Patch run id (or batch id for a digest) |
| `durationMs` | Wall time |
| `bridgeVersion` | CLI version |
| `reportPath` | `bridge-report.v1.json` or `LATEST.md` for a digest |
