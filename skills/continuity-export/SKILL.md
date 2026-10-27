# Continuity Capsule Exporter
Regenerates the Continuity Layer capsule (Identity + Memory + Protocol) from live agent state in one command, and optionally pushes it to skylar's Drive.
Usage: run with no arguments for local export; pass "--upload" to also push to Drive (requires GOOGLEDRIVE_ACCESS_TOKEN in env).
Source: continuity-layer/export_capsule.py in the conversation workspace; outputs capsule.json + RESTORATION_BEACON.md (SHA-256 stamped).
