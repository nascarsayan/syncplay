# syncplay

Dead-simple synced video playback for multiple browsers on the same network.

## Local setup

```bash
bun install
mkdir -p videos
bun run index.ts
```

Open `http://localhost:3000`.

## Env vars

```bash
# Server
PORT=3000
HOST=0.0.0.0
DATA_DIR=./data
DB_PATH=./data/syncplay.db
VIDEO_DIR=./videos
APP_BASE_URL=http://localhost:3000
NODE_ENV=development
SESSION_TTL_HOURS=168

# Users
ADMIN_EMAILS=admin@example.com
TEST_USERS=admin@example.com,user1@example.com,user2@example.com
```

## Login

Login is invite-only. Use the invite link and you are signed in immediately.

## Invites via CLI

```bash
bun run invite -- user1@example.com user2@example.com
```

## Convert videos to MP4

Browsers typically require MP4 (H.264 + AAC). Convert any `.mkv`, `.mov`, `.webm`, or `.avi` in `VIDEO_DIR`:

```bash
bun run convert
```

Requires `ffmpeg` installed on the system.

## Extract subtitles & organize videos

`bun run subs` will:

- extract archives (`.zip`, `.tar`, `.tar.gz`, `.tgz`) inside `VIDEO_DIR`
- ensure each video under `videos/` lives in its own folder
- extract embedded subtitles to `<video-filename>.d/` (VTT)

```bash
bun run subs
```

Requires `ffmpeg`, `tar`, and `unzip`.

## Notes

- Admins can create invite links and pick the active video.
- Invite acceptance whitelists the email and signs the user in.
- Video files are served from `VIDEO_DIR` and can be `.mp4`, `.webm`, `.mkv`, or `.mov`.
- For manual subtitles, drop `.srt` or `.vtt` files inside `<video-filename>.d/` next to the video.

## Caddy

A `Caddyfile` is included to route `syncplay.riddhayan.dpdns.org` to the app.
