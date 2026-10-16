# voxtakes-mcp

MCP server for [Voxtakes](https://voxtakes.com) — AI video dubbing, translation,
subtitles and hard-subtitle removal in 9 languages, with line-level control.

## Setup

1. Create an API key at **app.voxtakes.com → API keys** (`vt_live_…`, shown once).
2. Add to your MCP client config (Claude Desktop / Cline / any stdio MCP host):

```json
{
  "mcpServers": {
    "voxtakes": {
      "command": "node",
      "args": ["/path/to/voxtakes-mcp/server.js"],
      "env": { "VOXTAKES_API_KEY": "vt_live_…" }
    }
  }
}
```

Or with npx once published: `npx voxtakes-mcp`.

Requirements: Node ≥ 18. Zero dependencies.

## Tools

| tool | what it does |
|---|---|
| `presign_upload` / `upload_video` | get the video into Voxtakes (PUT slot, or one-shot base64) |
| `dub_video` | translate + dub + subtitle a job (`gate:true` = free preview first) |
| `get_job` / `wait_job` | poll / block until terminal or the script gate |
| `get_script` | at the gate: full translation, QC scores, preview sample |
| `approve_script` | release the render, optionally fixing lines (`edits`) |
| `redub_line` | re-record one line on a finished job — **1 line = 1 minute**, never a full re-render |
| `download_master` / `get_lines` | final mp4 URL (600 s) / per-line transcript with QC |
| `get_credits` / `cancel_job` | balance / cancel (cancelling at the gate is free) |

## The happy path an agent should follow

```
presign_upload → PUT bytes → dub_video(gate:true) → wait_job
→ get_script (review translation + hear the ~45 s cloned-voice preview)
→ approve_script (billing starts here) → wait_job → download_master
```

Billing: 1 credit-minute per finished minute per language; subtitles-only
delivery costs 0.4×; hard-subtitle erase adds +0.5×. Free-trial accounts:
1 language, ≤3 min, watermarked output.

## Notes

- Base URL override: `VOXTAKES_BASE` (default `https://app.voxtakes.com`).
- The key inherits the account: same credits, same plan limits, revocable instantly.
- MIT licensed.
