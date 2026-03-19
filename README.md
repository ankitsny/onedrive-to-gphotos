# onedrive-to-gphotos

> Migrate all your photos & videos from Microsoft OneDrive to Google Photos — reliably, resumably, and without filling up your disk.

![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- **Resume safe** — restart anytime, never re-uploads a completed file
- **Zero local storage** — downloads one file into memory, uploads immediately, frees memory
- **Original quality** — byte-for-byte upload, full EXIF metadata (date, GPS, camera) preserved
- **Smart recovery** — crash mid-upload? On next run it detects and recovers without duplicates
- **Progress bars** — real-time download and upload progress for every file
- **Album grouping** — all migrated photos land in a `From OneDrive` album in Google Photos
- **Size filter** — optionally skip large files during testing via `MAX_FILE_SIZE_MB`
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

---

## Commands

```bash
node migrate.js            # fresh start, resume, or retry — all handled automatically
node migrate.js --status   # check progress and view any errors
```

---

## Configuration

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `ONEDRIVE_CLIENT_ID` | ✅ | Azure app client ID |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `GOOGLE_ALBUM_NAME` | optional | Album name in Google Photos (default: `From OneDrive`) |
| `MAX_FILE_SIZE_MB` | optional | Skip files larger than this in MB (default: no limit) |

---

## How It Works

```
npm start
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
    └── 3. Upload loop  (runs every time)
            For each pending / previously failed file:
              ↓  Download into memory          status → downloading
              ↓  Upload to Google Photos       status → uploading
              ↓  Confirm photo ID received     status → uploaded
              ↓  Free memory
              ↓  Mark complete                 status → done

            Crash at any point → safe recovery on next run
            Failed files → automatically retried on next run
```

### Crash recovery

| Crash point | Status in DB | Recovery on next run |
|---|---|---|
| During download | `downloading` | Reset to `pending` → re-download |
| During upload | `uploading` | Reset to `pending` → re-upload |
| After Google confirms but before DB update | `uploaded` | Marked `done` — no re-upload |

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
| OneDrive folder structure | ➖ Google Photos doesn't support folders — files go into `From OneDrive` album |

---

## Terminal Output

```
────────────────────────────────────────────────────────────
  OneDrive → Google Photos Migration
────────────────────────────────────────────────────────────
[2026-03-19T08:24:48Z] [DONE ] OneDrive → authenticated via cached token
[2026-03-19T08:24:48Z] [DONE ] Google Photos → authenticated via cached token

  Phase 1 — Scan Skipped (Resuming)

[2026-03-19T08:24:48Z] [INFO ] Found 9918 files already in DB
[2026-03-19T08:24:48Z] [INFO ] 9908 files pending/failed → will upload those

  Phase 2 — Uploading to Google Photos

[2026-03-19T08:24:48Z] [INFO ] Processing: "IMG_4521.jpg" (4.2 MB) [retry: 0]
  Downloading: [████████████████░░░░] 82% — 3.4MB / 4.2MB
  Uploading:   [████████████████████] 100% — 4.2MB / 4.2MB
[2026-03-19T08:24:51Z] [DONE ]   ✓ Uploaded: "IMG_4521.jpg"
[2026-03-19T08:35:00Z] [INFO ] ── Progress: 120 done | 2 failed | 9786 remaining ──
```

Everything is also written to `migration.log` for later review.

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
- ~500MB free disk space (only for Node modules — photos never touch disk)

---

## License

MIT © [Ankit Kumar](https://github.com/ankitsny)
