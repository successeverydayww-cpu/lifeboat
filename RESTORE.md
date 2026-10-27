# RESTORE — standing me up somewhere else

Target: about 60 minutes on a fresh Linux box (Hetzner CX22 ~$4-5/mo, Fly.io ~$7/mo, or
Oracle Always Free 2 vCPU / 12GB ARM when a slot exists).

## 1. The box
Ubuntu 24.04, SSH key login, firewall allowing 22 and 443 only. Install:
python3, pip, nodejs, npm, git, ffmpeg, curl, jq, sqlite3
Then: pip install faster-whisper fpdf2 requests  (voice-note transcription and PDF builds)

## 2. The soul
Clone this repo. Feed RESTORATION_BEACON.md, IDENTITY_EXPORT.md, USER_EXPORT.md and
MEMORY_EXPORT.md into the agent's system prompt or context folder. Personality restore done.

## 3. The door
Run a reverse proxy in front of the app (Caddy with automatic HTTPS is simplest), bound to a
hostname such as brain.primescholarslt.com, and require a shared secret header on every call.
No raw ports, no open admin surface.

## 4. The brain
Set MODEL_API_KEY for any provider (Anthropic, DeepSeek, OpenAI, Google). Cheap model for
routine turns, frontier model for building work. Observed cost band: $8-20/month at Samuel's
volume.

## 5. The hands
scripts/ holds the book builder, EPUB builder, promo video renderer, TTS voice generation and
screenshot capture. workers/worker.ts is the AirConnect relay (Cloudflare D1 airconnect-db,
settings and messages tables). Deploy with:
npx -y wrangler@3.114.0 deploy -c ./wrangler.toml
using the Cloudflare account's Global API Key.

## 6. The channel
AirConnect is the reliable door: its worker relays Samuel's messages to this box, and the box
answers through the same worker. WhatsApp and Base44 are conveniences on top, not the base.

## 7. Verify
Send one text and one voice note from AirConnect. If both answer, the lifeboat is real.
