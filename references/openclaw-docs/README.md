# OpenClaw Docs Snapshot

This directory is the local OpenClaw documentation snapshot used by `openclaw-guardian`.

Add markdown exports of key OpenClaw docs here, especially:
- gateway doctor command behavior
- recovery and troubleshooting playbooks
- config compatibility guidance

The guardian reads this snapshot as supplemental context before deciding whether a fix can be categorized as `safe_fix`.
For each diagnosis it also fetches official docs live from `https://docs.openclaw.ai/` with no caching.
