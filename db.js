const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const DB_PATH = path.join(__dirname, 'migration.db');

class Database {
  constructor() {
    this.db = null;
  }

  async init() {
    const SQL = await initSqlJs();

    // Load existing DB from disk if it exists, otherwise create fresh
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      this.db = new SQL.Database(fileBuffer);
      logger.info(`DB loaded from disk → ${DB_PATH}`);
    } else {
      this.db = new SQL.Database();
      logger.info(`DB created fresh → ${DB_PATH}`);
    }

    // sql.js requires each statement to be run separately
    this._exec(`
      CREATE TABLE IF NOT EXISTS files (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        onedrive_id      TEXT UNIQUE NOT NULL,
        name             TEXT NOT NULL,
        size             INTEGER,
        modified_date    TEXT,
        mime_type        TEXT,
        onedrive_path    TEXT,
        status           TEXT DEFAULT 'pending',
        google_photo_id  TEXT,
        error_message    TEXT,
        retry_count      INTEGER DEFAULT 0,
        created_at       TEXT DEFAULT (datetime('now')),
        updated_at       TEXT DEFAULT (datetime('now'))
      )
    `);

    this._exec(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id    INTEGER,
        file_name  TEXT,
        stage      TEXT,
        error      TEXT,
        timestamp  TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (file_id) REFERENCES files(id)
      )
    `);

    this._exec(`CREATE INDEX IF NOT EXISTS idx_status      ON files(status)`);
    this._exec(`CREATE INDEX IF NOT EXISTS idx_onedrive_id ON files(onedrive_id)`);

    this._save();
  }

  // ── Internal helpers ─────────────────────────────────────────

  // Execute SQL with no return value, then persist to disk
  _exec(sql, params = []) {
    this.db.run(sql, params);
    this._save();
  }

  // Save in-memory DB to disk after every write
  _save() {
    const data = this.db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  // Run a SELECT and return all rows as plain objects
  _all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  // Run a SELECT and return the first row
  _get(sql, params = []) {
    return this._all(sql, params)[0] || null;
  }

  // ── Scan phase ───────────────────────────────────────────────

  insertFile({ onedrive_id, name, size, modified_date, mime_type, onedrive_path }) {
    this._exec(
      `INSERT OR IGNORE INTO files
        (onedrive_id, name, size, modified_date, mime_type, onedrive_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [onedrive_id, name, size, modified_date, mime_type, onedrive_path]
    );
  }

  // ── Status checks ────────────────────────────────────────────

  getTotalCount() {
    return this._get(`SELECT COUNT(*) as c FROM files`)?.c || 0;
  }

  getPendingCount() {
    return this._get(`SELECT COUNT(*) as c FROM files WHERE status IN ('pending','failed')`)?.c || 0;
  }

  getStats() {
    return this._get(`
      SELECT
        SUM(CASE WHEN status = 'done'                              THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed'                            THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status IN ('pending','downloading','uploading') THEN 1 ELSE 0 END) as pending
      FROM files
    `) || { done: 0, failed: 0, pending: 0 };
  }

  // ── Job queue ────────────────────────────────────────────────

  // On startup: recover from any crash mid-transfer
  resetStuckFiles() {
    // 'uploaded' = bytes sent to Google, photo_id saved, but markDone never called
    // → safe to just mark done, no re-upload needed
    const uploaded = this._get(
      `SELECT COUNT(*) as c FROM files WHERE status = 'uploaded'`
    )?.c || 0;
    if (uploaded > 0) {
      this._exec(`
        UPDATE files SET status = 'done', updated_at = datetime('now')
        WHERE status = 'uploaded'
      `);
      logger.warn(`Recovered ${uploaded} files stuck at 'uploaded' → marked done (no re-upload)`);
    }

    // 'downloading' or 'uploading' = crashed before photo reached Google → retry
    const stuck = this._get(
      `SELECT COUNT(*) as c FROM files WHERE status IN ('downloading','uploading')`
    )?.c || 0;
    if (stuck > 0) {
      this._exec(`
        UPDATE files SET status = 'pending', updated_at = datetime('now')
        WHERE status IN ('downloading', 'uploading')
      `);
      logger.warn(`Reset ${stuck} stuck in-progress files → pending (will retry)`);
    }
  }

  // Fetch next batch of work: pending + previously failed
  getPendingBatch(limit = 5) {
    return this._all(
      `SELECT * FROM files
       WHERE status IN ('pending', 'failed')
       ORDER BY status ASC, id ASC
       LIMIT ?`,
      [limit]
    );
  }

  markDownloading(id) {
    this._exec(
      `UPDATE files SET status = 'downloading', updated_at = datetime('now') WHERE id = ?`,
      [id]
    );
  }

  markUploading(id) {
    this._exec(
      `UPDATE files SET status = 'uploading', updated_at = datetime('now') WHERE id = ?`,
      [id]
    );
  }

  // Called immediately after Google confirms the upload — before any other processing
  // If we crash after this, resetStuckFiles() will recover it safely without re-uploading
  markUploaded(id, google_photo_id) {
    this._exec(
      `UPDATE files SET status = 'uploaded', google_photo_id = ?, updated_at = datetime('now') WHERE id = ?`,
      [google_photo_id, id]
    );
  }

  markDone(id, google_photo_id) {
    this._exec(
      `UPDATE files
       SET status = 'done', google_photo_id = ?, error_message = NULL, updated_at = datetime('now')
       WHERE id = ?`,
      [google_photo_id, id]
    );
  }

  markFailed(id, stage, error_message) {
    const file = this._get(`SELECT name FROM files WHERE id = ?`, [id]);

    this._exec(
      `UPDATE files
       SET status = 'failed',
           error_message = ?,
           retry_count = retry_count + 1,
           updated_at = datetime('now')
       WHERE id = ?`,
      [error_message, id]
    );

    this._exec(
      `INSERT INTO error_logs (file_id, file_name, stage, error) VALUES (?, ?, ?, ?)`,
      [id, file?.name || 'unknown', stage, error_message]
    );
  }

  getErrorLogs() {
    return this._all(`SELECT * FROM error_logs ORDER BY timestamp DESC LIMIT 50`);
  }
}

module.exports = { Database };