# onedrive-to-gphotos

> Migrate all your photos & videos from Microsoft OneDrive to Google Photos — reliably, resumably, and without any RAM or disk bottleneck.

![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- **Resume safe** — restart anytime, never re-uploads a completed file
- **Streaming pipeline** — OneDrive and Google Photos connected directly, only ~256KB in RAM at any point regardless of file size
- **Original quality** — byte-for-byte upload, full EXIF metadata (date, GPS, camera) preserved
- **Crash recovery** — mid-upload crash? On next run it detects and recovers without creating duplicates
- **Progress bars** — live download and upload progress for every file
- **Album grouping** — all migrated photos land in a `From OneDrive` album in Google Photos
- **Size filter** — skip large files during testing via `MAX_FILE_SIZE_MB`, remove for full migration
- **Full audit trail** — SQLite DB tracks every file's status, errors, and retry count

---

## Quick Start

```bash
git clone https://github.com/ankitsny/onedrive-to-gphotos
cd onedrive-to-gphotos
npm install
cp .env.example .env       # fill in your credentials
node migrate.js            # start migrating
```

See [credentials.md](./credentials.md) for step-by-step credential setup.

For control flow diagrams and internal architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md).

> **⚠️ Google "Unverified App" Warning**
> On first sign-in, Google will show a warning screen saying **"Google hasn't verified this app"**. This is expected — the app is in Testing mode and only you can access it.
>
> To continue:
> 1. Click **"Advanced"** (bottom left of the warning screen)
> 2. Click **"Go to Photos Migration (unsafe)"**
> 3. Review the permissions and click **"Continue"**
>
> You will only see this once — the token is cached after the first sign-in.

---

## Commands

```bash
node migrate.js            # fresh start, resume, or retry — all handled automatically
node migrate.js --status   # check progress and view any errors
```

---

## Configuration

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `ONEDRIVE_CLIENT_ID` | ✅ | Azure app client ID |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `GOOGLE_ALBUM_NAME` | optional | Album name in Google Photos (default: `"From OneDrive"`) |
| `MAX_FILE_SIZE_MB` | optional | Skip files larger than this in MB (default: no limit) |

---

## How It Works

```
node migrate.js
    │
    ├── 1. Authenticate
    │       OneDrive  → browser opens, sign in once, token cached
    │       Google    → browser opens, sign in once, token cached
    │
    ├── 2. Scan OneDrive  (first run only)
    │       Fetches all files recursively via delta API (100 per page)
    │       Filters to images + videos only
    │       Saves every file to SQLite DB with status = pending
    │
    └── 3. Stream loop  (runs every time)
            For each pending / previously failed file:
              ↓  Resolve CDN URL from OneDrive     status → downloading
              ↓  Open download stream
              ↓  Pipe chunks → Google Photos       status → uploading
              ↓  Google confirms photo ID          status → uploaded  ← crash-safe checkpoint
              ↓  Mark complete                     status → done

            The full file is never held in RAM.
            Crash at any point → safe recovery on next run.
            Failed files → automatically retried on next run.
```

### Crash recovery

| Crash point | Status in DB | Recovery on next run |
|---|---|---|
| Resolving URL / before stream opens | `downloading` | Reset to `pending` → retry |
| Mid-stream, before Google confirms | `uploading` | Reset to `pending` → retry |
| After Google confirms, before `done` | `uploaded` | Marked `done` — no re-upload |

---

## Supported File Types

**Images:** `.jpg` `.jpeg` `.png` `.gif` `.webp` `.heic` `.heif` `.bmp` `.tiff` `.raw` `.arw` `.cr2` `.cr3` `.nef` `.dng` `.orf` `.rw2` `.svg`

**Videos:** `.mp4` `.mov` `.avi` `.mkv` `.3gp` `.m4v` `.wmv` `.flv` `.webm` `.mts` `.m2ts` `.mpg`

---

## What Gets Preserved

| Metadata | Preserved |
|---|---|
| Original filename | ✅ |
| Photo taken date / time | ✅ via EXIF |
| GPS location | ✅ via EXIF |
| Camera model, lens, ISO | ✅ via EXIF |
| Original file quality | ✅ byte-for-byte |
| OneDrive folder structure | ➖ Google Photos doesn't support folders — files go into the `From OneDrive` album |

---

## Terminal Output

First run — scans OneDrive then starts uploading:

```
────────────────────────────────────────────────────────────
  OneDrive → Google Photos Migration
────────────────────────────────────────────────────────────
[2026-03-19T08:24:48.450Z] [INFO ] Starting up...
[2026-03-19T08:24:48.463Z] [INFO ] DB created fresh → /path/to/migration.db

────────────────────────────────────────────────────────────
  Authentication
────────────────────────────────────────────────────────────
[2026-03-19T08:24:48.788Z] [DONE ] OneDrive → authenticated via cached token
[2026-03-19T08:24:48.811Z] [DONE ] Google Photos → authenticated via cached token

────────────────────────────────────────────────────────────
  Phase 1 — Scanning OneDrive
────────────────────────────────────────────────────────────
[2026-03-19T08:24:48.812Z] [INFO ] No files in DB yet. Scanning OneDrive...
[2026-03-19T08:24:49.010Z] [INFO ]   Scan page 1: 100 media files found so far...
[2026-03-19T08:24:49.380Z] [INFO ]   Scan page 2: 200 media files found so far...
[2026-03-19T08:24:52.901Z] [DONE ] Scan complete — 9918 images/videos queued for upload

────────────────────────────────────────────────────────────
  Phase 2 — Uploading to Google Photos
────────────────────────────────────────────────────────────
[2026-03-19T08:24:52.902Z] [INFO ] Processing: "IMG_4521.jpg" (4.2 MB) [retry: 0]
[2026-03-19T08:24:52.905Z] [DEBUG]   → Resolving download URL...
  Downloading: [████████████████████] 100% — 4.2MB / 4.2MB
  Uploading:   [████████████████████] 100% — 4.2MB / 4.2MB
[2026-03-19T08:24:55.120Z] [DONE ]   ✓ Uploaded: "IMG_4521.jpg" → Google Photos ID: Abc123...
[2026-03-19T08:24:55.121Z] [INFO ] Processing: "VID_20191002_120847.mp4" (47.0 MB) [retry: 0]
[2026-03-19T08:24:55.124Z] [DEBUG]   → Resolving download URL...
  Downloading: [████████░░░░░░░░░░░░] 42% — 19.7MB / 47.0MB
  Uploading:   [██████░░░░░░░░░░░░░░] 32% — 15.0MB / 47.0MB
```

Resuming after restart — skips scan, continues from where it left off:

```
[2026-03-19T08:29:28.203Z] [WARN ] Reset 1 stuck in-progress files → pending (will retry)

────────────────────────────────────────────────────────────
  Phase 1 — Scan Skipped (Resuming)
────────────────────────────────────────────────────────────
[2026-03-19T08:29:28.216Z] [INFO ] Found 9918 files already in DB
[2026-03-19T08:29:28.250Z] [INFO ] 9909 files pending/failed → will upload those

────────────────────────────────────────────────────────────
  Phase 2 — Uploading to Google Photos
────────────────────────────────────────────────────────────
[2026-03-19T08:29:28.251Z] [WARN ] Skipping "VID_20190918_170111.mp4" (1.70 GB) — exceeds MAX_FILE_SIZE_MB limit of 200MB
[2026-03-19T08:29:28.252Z] [INFO ] Processing: "IMG_2045.heic" (8.1 MB) [retry: 0]
  Downloading: [████████████████████] 100% — 8.1MB / 8.1MB
  Uploading:   [████████████████████] 100% — 8.1MB / 8.1MB
[2026-03-19T08:29:31.440Z] [DONE ]   ✓ Uploaded: "IMG_2045.heic" → Google Photos ID: Xyz789...
[2026-03-19T08:35:00.000Z] [INFO ] ── Progress: 120 done | 2 failed | 9786 remaining ──
```

Final summary:

```
╔══════════════════════════════════════╗
║         MIGRATION SUMMARY            ║
╠══════════════════════════════════════╣
║  Total scanned   : 9954              ║
║  Uploaded        : 15                ║
║  Failed          : 0                 ║
║  Pending         : 9939              ║
║  Progress        : 0%                ║
╚══════════════════════════════════════╝
```

Everything is also written to `migration.log`.

---

## Files Generated at Runtime

| File | Purpose |
|---|---|
| `migration.db` | SQLite DB — every file's status, metadata, errors |
| `migration.log` | Full timestamped log of every action |
| `.onedrive_token.json` | Cached OneDrive auth token |
| `.google_token.json` | Cached Google Photos auth token |

> ⚠️ All of these are gitignored. Never commit them — they contain auth tokens.

---

## Requirements

- Node.js 18+
- A Microsoft account with OneDrive
- A Google account with Google Photos
- ~500MB free disk space (only for Node modules — photos and videos never touch disk)

---

## License

MIT © [Ankit Kumar](https://github.com/ankitsny)

---

## Credits

Built with the help of [Claude](https://claude.ai) by Anthropic — from code to debugging every 403 along the way. 🤖
