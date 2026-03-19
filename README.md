# OneDrive → Google Photos Migration

Migrates all images & videos from OneDrive to Google Photos.
- ✅ Resumes from where it left off (safe to restart anytime)
- ✅ Downloads one file at a time — no bulk storage on your Mac
- ✅ Uploads byte-for-byte — original quality, full EXIF metadata preserved
- ✅ Tracks everything in SQLite (status, metadata, errors)
- ✅ One command handles fresh start, resume, and retry

---

## Quick Start

```bash
npm install
cp .env.example .env      # fill in credentials (see below)
node migrate.js           # run migration
node migrate.js --status  # check progress anytime
```

---

## Getting Credentials

### OneDrive (Microsoft Azure)
1. Go to https://portal.azure.com
2. Search **"App registrations"** → **New registration**
3. Name: `OneDrive Migration`, Account type: `Personal Microsoft accounts only`
4. Click **Register** → copy the **Application (client) ID** → paste as `ONEDRIVE_CLIENT_ID`
5. Go to **Authentication** → enable **"Allow public client flows"** → Save
6. Go to **API permissions** → Add → Microsoft Graph → Delegated → `Files.Read` + `offline_access`

### Google Photos (Google Cloud Console)
1. Go to https://console.cloud.google.com
2. Create/select a project
3. **APIs & Services → Library** → search **"Photos Library API"** → Enable
4. **APIs & Services → Credentials** → Create → OAuth 2.0 Client ID → Desktop app
5. Copy **Client ID** and **Client Secret** → paste into `.env`
6. **OAuth consent screen** → add your Gmail as a Test user

---

## How It Works

```
node migrate.js
      │
      ├─ 1. Auth OneDrive + Google Photos (cached after first run)
      │
      ├─ 2. SCAN (only on first run)
      │      Fetches all files from OneDrive in pages of 100
      │      Filters images + videos, saves to DB with status=pending
      │
      └─ 3. UPLOAD LOOP
             For each pending/failed file:
               ↓  download into memory  (status: downloading)
               ↓  upload to Google Photos  (status: uploading)
               ↓  free memory
               ↓  mark done in DB  (status: done)
             
             If anything fails → status=failed, error logged
             Next run picks up failed files automatically
```

---

## Log Output

Everything is logged to console AND `migration.log`:

```
[2024-01-15T10:23:01] [INFO ] Starting up...
[2024-01-15T10:23:02] [INFO ] Scanning OneDrive for all images and videos...
[2024-01-15T10:23:04] [INFO ]   Scan page 1: 100 media files found so far...
[2024-01-15T10:23:06] [INFO ]   Scan page 2: 200 media files found so far...
[2024-01-15T10:23:12] [DONE ] Scan complete — 847 images/videos queued for upload
[2024-01-15T10:23:13] [INFO ] Processing: "IMG_2045.jpg" (3.2 MB) [retry: 0]
[2024-01-15T10:23:13] [DEBUG]   → Downloading from OneDrive...
[2024-01-15T10:23:15] [DEBUG]   → Uploading to Google Photos...
[2024-01-15T10:23:17] [DONE ]   ✓ Uploaded: "IMG_2045.jpg" → Google Photos ID: abc123
...
[2024-01-15T14:45:00] [INFO ] ── Progress: 420 done | 3 failed | 424 remaining ──
```

---

## Files Created

| File | Purpose |
|------|---------|
| `migration.db` | SQLite DB — tracks every file |
| `migration.log` | Full log of everything that happened |
| `.onedrive_token.json` | Cached OneDrive auth token |
| `.google_token.json` | Cached Google Photos auth token |

⚠️ Never share or commit `.env` or `*_token.json` files.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Token expired | Delete `.onedrive_token.json` or `.google_token.json` and re-run |
| Files.Read denied | Re-grant permissions in Azure portal |
| Photos API error | Enable Photos Library API in Google Cloud Console |
| Upload slow | Normal for 30GB — leave overnight, it will resume if interrupted |
| Stuck files | Handled automatically — any `downloading`/`uploading` status is reset on startup |
