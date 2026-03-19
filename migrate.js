require('dotenv').config();

const { OneDriveClient } = require('./onedrive');
const { GooglePhotosClient } = require('./google-photos');
const { Database } = require('./db');
const { logger } = require('./logger');

// ── Config ────────────────────────────────────────────────────
const BATCH_SIZE = 5;      // files processed concurrently
const MAX_RETRIES = 3;     // skip a file after this many failures
const MAX_FILE_SIZE_MB = process.env.MAX_FILE_SIZE_MB ? parseInt(process.env.MAX_FILE_SIZE_MB) : null; // null = no limit

// ── Entry point ───────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    return showStatus();
  }

  logger.section('OneDrive → Google Photos Migration');
  logger.info('Starting up...');

  // Init DB
  const db = new Database();
  await db.init();

  // Reset any files stuck mid-transfer from a previous crash
  db.resetStuckFiles();

  // Init API clients
  const onedrive = new OneDriveClient();
  const gphotos = new GooglePhotosClient();

  // Authenticate both services
  logger.section('Authentication');
  await onedrive.authenticate();
  await gphotos.authenticate();

  // Decide: fresh scan needed, or resume?
  const totalInDb = db.getTotalCount();
  const pendingCount = db.getPendingCount();

  if (totalInDb === 0) {
    // ── Fresh migration ──────────────────────────────────────
    logger.section('Phase 1 — Scanning OneDrive');
    logger.info('No files in DB yet. Scanning OneDrive for all images and videos...');
    await scanOneDrive(onedrive, db);
  } else {
    // ── Resume or retry ──────────────────────────────────────
    logger.section('Phase 1 — Scan Skipped (Resuming)');
    logger.info(`Found ${totalInDb} files already in DB`);
    logger.info(`${pendingCount} files pending/failed → will upload those`);

    if (pendingCount === 0) {
      logger.success('Nothing left to do! All files already uploaded.');
      logger.summary(db.getStats());
      return;
    }
  }

  // ── Upload phase ─────────────────────────────────────────────
  logger.section('Phase 2 — Uploading to Google Photos');
  await uploadAll(onedrive, gphotos, db);

  // ── Final summary ─────────────────────────────────────────────
  logger.section('Migration Complete');
  const stats = db.getStats();
  logger.summary(stats);

  if (stats.failed > 0) {
    logger.warn(`${stats.failed} files failed. Run again to retry them automatically.`);
    logger.warn('Run  node migrate.js --status  to see error details.');
  }
}

// ── Scan all OneDrive files and insert into DB ────────────────

async function scanOneDrive(onedrive, db) {
  let totalFound = 0;
  let pageNum = 0;

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

// ── Upload all pending/failed files ──────────────────────────

async function uploadAll(onedrive, gphotos, db) {
  let uploaded = 0;
  let failed   = 0;
  let skipped  = 0;

  while (true) {
    const batch = db.getPendingBatch(BATCH_SIZE);
    if (batch.length === 0) break;

    for (const file of batch) {
      // Skip files that have failed too many times
      if (file.retry_count >= MAX_RETRIES) {
        logger.warn(`Skipping "${file.name}" — failed ${file.retry_count} times already`);
        skipped++;
        continue;
      }

      // Skip files exceeding size limit if MAX_FILE_SIZE_MB is set
      if (MAX_FILE_SIZE_MB && file.size && file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        logger.warn(`Skipping "${file.name}" (${formatSize(file.size)}) — exceeds MAX_FILE_SIZE_MB limit of ${MAX_FILE_SIZE_MB}MB`);
        skipped++;
        continue;
      }

      logger.info(`Processing: "${file.name}" (${formatSize(file.size)}) [retry: ${file.retry_count}]`);

      let buffer = null;

      // ── Step 1: Download from OneDrive ──────────────────────
      try {
        db.markDownloading(file.id);
        logger.debug(`  → Downloading from OneDrive...`);
        buffer = await onedrive.downloadFile(file.onedrive_id, file.name);
        logger.debug(`  → Download complete (${formatSize(buffer.length)})`);
      } catch (err) {
        const msg = `Download failed: ${err.message}`;
        logger.error(`  ✗ ${file.name} — ${msg}`);
        db.markFailed(file.id, 'download', msg);
        failed++;
        continue;
      }

      // ── Step 2: Upload to Google Photos ────────────────────
      try {
        db.markUploading(file.id);
        logger.debug(`  → Uploading to Google Photos...`);
        // onPhotoIdReceived is called inside uploadPhoto the moment Google confirms
        // the photo ID — before uploadPhoto even returns. This means even if the
        // process crashes on the next line, the ID is already in the DB and
        // resetStuckFiles() will recover it to 'done' without re-uploading.
        const photoId = await gphotos.uploadPhoto(
          buffer, file.name, file.mime_type, file.modified_date,
          (id) => db.markUploaded(file.id, id)
        );
        buffer = null; // free memory immediately
        db.markDone(file.id, photoId);
        logger.success(`  ✓ Uploaded: "${file.name}" → Google Photos ID: ${photoId}`);
        uploaded++;
      } catch (err) {
        buffer = null; // free memory
        const msg = `Upload failed: ${err.message}`;
        logger.error(`  ✗ ${file.name} — ${msg}`);
        db.markFailed(file.id, 'upload', msg);
        failed++;
      }

      // Progress snapshot every 10 files
      if ((uploaded + failed) % 10 === 0) {
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
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});