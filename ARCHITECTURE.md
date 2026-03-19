# Architecture & Control Flow

This document explains how the migration tool works internally, with diagrams for each major flow.

---

## 1. Startup flow

How `node migrate.js` boots up — initializing the DB, authenticating both services, then deciding whether to scan or resume.

```
node migrate.js
       │
       ├── db.init()
       │     Load migration.db from disk, or create fresh
       │     Run CREATE TABLE IF NOT EXISTS for all tables
       │
       ├── db.resetStuckFiles()
       │     Any file stuck as 'downloading' or 'uploading' → reset to 'pending'
       │     Any file stuck as 'uploaded' → mark 'done' (no re-upload needed)
       │
       ├── onedrive.authenticate()        gphotos.authenticate()
       │     Try cached token               Try cached token
       │     If expired/missing:            If expired/missing:
       │       Device code flow               OAuth browser flow
       │       Open browser → sign in        Open browser → sign in
       │
       └── files in DB?
             ├── NO  → scanOneDrive() → delta API pages → insert all as 'pending'
             └── YES → skip scan, log "Resuming"
                   └── pendingCount == 0? → print summary, exit
                         └── NO → uploadAll()
```

---

## 2. Streaming pipeline

The core of the tool. For each file, bytes flow directly from OneDrive CDN to Google Photos — the full file is never held in RAM.

```
uploadAll() loop — for each pending/failed file:
       │
       ├── retry_count >= MAX_RETRIES? → skip (permanently)
       ├── size > MAX_FILE_SIZE_MB?    → skip (until env var removed)
       │
       ├── db.markDownloading(id)
       │
       ├── onedrive.getDownloadStream(id)
       │     GET /me/drive/items/{id}?select=downloadUrl   ← Graph API
       │     resolveRedirect() HEAD request → final CDN URL
       │
       ├── createDownloadStream(finalUrl, fileSize)
       │     HTTPS GET to CDN — returns a PassThrough stream
       │     Backpressure: pauses CDN if upload can't keep up
       │
       ├── db.markUploading(id)
       │
       ├── gphotos.uploadPhoto(stream, ...)
       │     HTTPS POST to photoslibrary.googleapis.com/v1/uploads
       │     Chunks pipe from download stream → upload request
       │     ~256KB in memory at any point regardless of file size
       │     Google returns uploadToken
       │         │
       │         └── batchCreate with albumId + uploadToken
       │               Google returns photoId
       │                   │
       │                   └── onPhotoIdReceived(photoId)
       │                         db.markUploaded(id, photoId)  ← crash-safe checkpoint
       │
       ├── db.markDone(id, photoId)
       │
       └── every 10 files → log progress snapshot
```

---

## 3. DB status state machine

Every file in `migration.db` moves through these states. The `uploaded` state is a crash-safe checkpoint — if the process dies after Google confirms the photo but before `done` is written, the next run recovers it without re-uploading.

```
                  ┌─────────────────────────────────────────┐
                  │           CRASH RECOVERY                 │
                  │  downloading/uploading → pending          │
                  │  (re-download + re-upload on next run)   │
                  └──────┬──────────────────┬────────────────┘
                         │                  │
  [scan inserts file]    │                  │
         │               │                  │
         ▼               │                  │
      pending  ──markDownloading()──▶  downloading
                                           │
                                     markUploading()
                                           │
                                           ▼
                  ┌──────────────────  uploading  ──────────────────┐
                  │                                                  │
                  │ error                                        error│
                  ▼                                                  ▼
               failed  ◀─────────────────────────────────────────  failed
          (retry_count++)
               │
          next run auto-retries
          (picked up by getPendingBatch)


      uploading ──markUploaded()──▶  uploaded  ──markDone()──▶  done
                                        │
                          ┌─────────────┘
                          │  CRASH RECOVERY
                          │  uploaded → done
                          │  (no re-upload, photoId already saved)
                          └─────────────────────────────────────────┘
```

---

## 4. File structure

```
migrate.js          Entry point — main(), scanOneDrive(), uploadAll()
onedrive.js         OneDrive API client — auth, scan (delta API), streaming download
google-photos.js    Google Photos API client — auth, album management, streaming upload
db.js               SQLite job queue — all status transitions live here
logger.js           Colored console + file logging, summary box
```

---

## 5. Why streaming matters

| Approach | 4GB video RAM usage | Risk |
|---|---|---|
| Old (buffer) | ~8GB peak (file + concat copy) | OOM crash, swap thrash |
| Current (stream) | ~256KB at any point | None |

The download and upload happen simultaneously — as each 256KB chunk arrives from OneDrive CDN it is immediately written to the Google Photos upload request. Neither side waits for the other to finish.

Backpressure is handled: if Google Photos can't accept data as fast as OneDrive sends it, the CDN download is paused (`res.pause()`) until the upload socket drains (`req.on('drain')`).

---

## 6. Token caching

```
OneDrive token  →  .onedrive_token.json   (MSAL cache, refreshed automatically)
Google token    →  .google_token.json     (OAuth2, refreshed on expiry)
```

Both files are gitignored. Delete either to force re-authentication.
