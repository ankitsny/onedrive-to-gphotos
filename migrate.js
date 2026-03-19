require('dotenv').config();

const { OneDriveClient, createDownloadStream, makeProgressState } = require('./onedrive');
const { GooglePhotosClient } = require('./google-photos');
const { Database } = require('./db');
const { logger } = require('./logger');

// ── Config ────────────────────────────────────────────────────
const BATCH_SIZE       = 5;
const MAX_RETRIES      = 3;
const MAX_FILE_SIZE_MB = process.env.MAX_FILE_SIZE_MB
  ? parseInt(process.env.MAX_FILE_SIZE_MB)
  : null; // null = no limit

// ── Entry point ───────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    return showStatus();
  }

  logger.section('OneDrive → Google Photos Migration');
  logger.info('Starting up...');

  const db = new Database();
  await db.init();

  db.resetStuckFiles();

  const onedrive = new OneDriveClient();
  const gphotos  = new GooglePhotosClient();

  logger.section('Authentication');
  await onedrive.authenticate();
  await gphotos.authenticate();

  const totalInDb    = db.getTotalCount();
  const pendingCount = db.getPendingCount();

  if (totalInDb === 0) {
    logger.section('Phase 1 — Scanning OneDrive');
    logger.info('No files in DB yet. Scanning OneDrive for all images and videos...');
    await scanOneDrive(onedrive, db);
  } else {
    logger.section('Phase 1 — Scan Skipped (Resuming)');
    logger.info(`Found ${totalInDb} files already in DB`);
    logger.info(`${pendingCount} files pending/failed → will upload those`);

    if (pendingCount === 0) {
      logger.success('Nothing left to do! All files already uploaded.');
      logger.summary(db.getStats());
      return;
    }
  }

  logger.section('Phase 2 — Uploading to Google Photos');
  await uploadAll(onedrive, gphotos, db);

  logger.section('Migration Complete');
  const stats = db.getStats();
  logger.summary(stats);

  if (stats.failed > 0) {
    logger.warn(`${stats.failed} files failed. Run again to retry them automatically.`);
    logger.warn('Run  node migrate.js --status  to see error details.');
  }
}

// ── Scan ──────────────────────────────────────────────────────

async function scanOneDrive(onedrive, db) {
  let totalFound = 0;
  let pageNum    = 0;

  for await (const batch of onedrive.scanAllFiles()) {
    pageNum++;
    for (const file of batch) {
      db.insertFile({
        onedrive_id:   file.id,
        name:          file.name,
        size:          file.size,
        modified_date: file.lastModifiedDateTime,
        mime_type:     file.file?.mimeType || 'application/octet-stream',
        onedrive_path: file.parentReference?.path || '/',
      });
      totalFound++;
    }
    logger.info(`  Scan page ${pageNum}: ${totalFound} media files found so far...`);
  }

  logger.success(`Scan complete — ${totalFound} images/videos queued for upload`);
}

// ── Upload ────────────────────────────────────────────────────

async function uploadAll(onedrive, gphotos, db) {
  let uploaded = 0;
  let failed   = 0;
  let skipped  = 0;

  while (true) {
    const batch = db.getPendingBatch(BATCH_SIZE);
    if (batch.length === 0) break;

    for (const file of batch) {
      // Skip files that have permanently failed too many times
      if (file.retry_count >= MAX_RETRIES) {
        logger.warn(`Skipping "${file.name}" — failed ${file.retry_count} times, exceeded MAX_RETRIES`);
        skipped++;
        continue;
      }

      // Skip files exceeding size limit (if set)
      if (MAX_FILE_SIZE_MB && file.size && file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        logger.warn(`Skipping "${file.name}" (${formatSize(file.size)}) — exceeds MAX_FILE_SIZE_MB limit of ${MAX_FILE_SIZE_MB}MB`);
        skipped++;
        continue;
      }

      logger.info(`Processing: "${file.name}" (${formatSize(file.size)}) [retry: ${file.retry_count}]`);

      // ── Stream: OneDrive → Google Photos ─────────────────────
      // Bytes flow chunk by chunk (~256KB at a time).
      // The full file is never held in RAM — safe for files of any size.
      let stream = null;

      try {
        db.markDownloading(file.id);
        logger.debug(`  → Resolving download URL...`);

        const { finalUrl, fileSize } = await onedrive.getDownloadStream(
          file.onedrive_id, file.name, file.size
        );

        // Open stream — data starts flowing immediately
        // progressState is shared between download and upload so both bars
        // render atomically on two dedicated lines without overwriting each other
        const progressState = makeProgressState(fileSize);
        stream = createDownloadStream(finalUrl, fileSize, progressState);

        db.markUploading(file.id);
        logger.debug(`  → Streaming to Google Photos...`);

        // onPhotoIdReceived is called the moment Google confirms the photo ID,
        // before uploadPhoto returns — crash-safe checkpoint in DB
        const photoId = await gphotos.uploadPhoto(
          stream,
          file.name,
          file.mime_type,
          fileSize,
          file.modified_date,
          (id) => db.markUploaded(file.id, id),
          progressState
        );

        // stream is destroyed inside uploadPhoto on success — no cleanup needed here
        stream = null;

        db.markDone(file.id, photoId);
        logger.success(`  ✓ Uploaded: "${file.name}" → Google Photos ID: ${photoId}`);
        uploaded++;

      } catch (err) {
        // Ensure stream is always destroyed on any error —
        // this aborts the OneDrive CDN connection and frees the socket
        if (stream && !stream.destroyed) {
          stream.destroy();
          stream = null;
        }

        // Classify error stage for accurate DB logging
        const isDownloadErr = err.message.includes('Download') || err.message.includes('timed out');
        const stage = isDownloadErr ? 'download' : 'upload';
        const msg   = `${stage === 'download' ? 'Download' : 'Upload'} failed: ${err.message}`;

        logger.error(`  ✗ ${file.name} — ${msg}`);
        db.markFailed(file.id, stage, msg);
        failed++;
      }

      // Progress snapshot every 10 files
      if ((uploaded + failed) % 10 === 0 && (uploaded + failed) > 0) {
        const stats = db.getStats();
        logger.info(`── Progress: ${stats.done} done | ${stats.failed} failed | ${stats.pending} remaining ──`);
      }
    }
  }

  logger.info(`Upload phase complete: ${uploaded} uploaded, ${failed} failed, ${skipped} skipped`);
}

// ── Status command ────────────────────────────────────────────

async function showStatus() {
  const db = new Database();
  await db.init();

  const stats = db.getStats();
  logger.summary(stats);

  if (stats.failed > 0) {
    const logs = db.getErrorLogs();
    logger.section('Recent Errors');
    logs.forEach((log) => {
      logger.error(`[${log.timestamp}] ${log.file_name} (stage: ${log.stage})`);
      logger.error(`  → ${log.error}`);
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────

function formatSize(bytes) {
  if (!bytes) return '?';
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
