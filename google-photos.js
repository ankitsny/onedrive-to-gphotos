const { google } = require('googleapis');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const { logger } = require('./logger');

const TOKEN_FILE = path.join(__dirname, '.google_token.json');
const ALBUM_NAME = process.env.GOOGLE_ALBUM_NAME || 'From OneDrive';
const UPLOAD_CHUNK = 256 * 1024; // 256 KB per chunk for progress tracking

class GooglePhotosClient {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3000/callback'
    );
    this.albumId = null; // cached after first creation/lookup
  }

  // ── Auth ──────────────────────────────────────────────────────

  async authenticate() {
    if (fs.existsSync(TOKEN_FILE)) {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      this.oauth2Client.setCredentials(tokens);

      if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
        logger.debug('Google Photos → token expired, refreshing...');
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(credentials));
        logger.debug('Google Photos → token refreshed');
      }

      logger.success('Google Photos → authenticated via cached token');
      return;
    }

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/photoslibrary.appendonly',
        'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
      ],
    });

    logger.section('Google Photos Authentication Required');
    logger.info('Opening browser for sign-in...');
    logger.info(`If browser does not open, visit:\n  ${authUrl}`);

    try {
      const open = (await import('open')).default;
      await open(authUrl);
    } catch {
      logger.warn('Could not open browser automatically — please open the URL manually');
    }

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const { query } = url.parse(req.url, true);
        if (query.code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h2 style="font-family:sans-serif;color:green">✅ Authenticated! You can close this tab.</h2>');
          server.close();
          resolve(query.code);
        } else {
          res.end('<h2 style="color:red">❌ Auth failed. Please try again.</h2>');
          reject(new Error('No auth code received'));
        }
      });

      server.listen(3000, () => logger.info('Waiting for Google sign-in on http://localhost:3000...'));
      setTimeout(() => { server.close(); reject(new Error('Auth timed out after 5 minutes')); }, 5 * 60 * 1000);
    });

    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
    logger.success('Google Photos → authenticated successfully');
  }

  // ── Album management ──────────────────────────────────────────

  async getOrCreateAlbum() {
    if (this.albumId) return this.albumId;

    const accessToken = (await this.oauth2Client.getAccessToken()).token;

    logger.debug(`Google Photos → looking for existing "${ALBUM_NAME}" album...`);
    let pageToken = null;
    do {
      const res = await axios.get('https://photoslibrary.googleapis.com/v1/albums', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { pageSize: 50, ...(pageToken && { pageToken }) },
        timeout: 15_000,
      });

      const albums = res.data.albums || [];
      const existing = albums.find(a => a.title === ALBUM_NAME);
      if (existing) {
        this.albumId = existing.id;
        logger.success(`Google Photos → found existing album "${ALBUM_NAME}" (id: ${this.albumId})`);
        return this.albumId;
      }
      pageToken = res.data.nextPageToken || null;
    } while (pageToken);

    logger.info(`Google Photos → creating album "${ALBUM_NAME}"...`);
    const createRes = await axios.post(
      'https://photoslibrary.googleapis.com/v1/albums',
      { album: { title: ALBUM_NAME } },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    );

    this.albumId = createRes.data.id;
    logger.success(`Google Photos → album "${ALBUM_NAME}" created (id: ${this.albumId})`);
    return this.albumId;
  }

  // ── Upload ────────────────────────────────────────────────────

  async uploadPhoto(buffer, filename, mimeType, modifiedDate, onPhotoIdReceived = null) {
    const accessToken = (await this.oauth2Client.getAccessToken()).token;

    logger.debug(`Google Photos → uploading "${filename}" (${(buffer.length / 1024).toFixed(0)} KB, ${mimeType})`);

    // Step 1: Upload raw bytes in chunks → shows real progress
    // axios onUploadProgress fires only once for Buffer payloads (jumps to 100% instantly)
    // so we use Node's built-in https with manual chunking instead
    const uploadToken = await new Promise((resolve, reject) => {
      const total = buffer.length;
      let sent = 0;

      const req = https.request({
        hostname: 'photoslibrary.googleapis.com',
        path:     '/v1/uploads',
        method:   'POST',
        headers: {
          'Authorization':              `Bearer ${accessToken}`,
          'Content-Type':               'application/octet-stream',
          'Content-Length':             total,
          'X-Goog-Upload-Content-Type': mimeType,
          'X-Goog-Upload-Protocol':     'raw',
          'X-Goog-Upload-File-Name':    encodeURIComponent(filename),
        },
      }, (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => {
          process.stdout.write('\n');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body.trim());
          } else {
            reject(new Error(`Upload failed with status ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (err) => {
        process.stdout.write('\n');
        reject(err);
      });

      // Write buffer in 256KB chunks — update progress bar after each chunk
      const writeChunk = (offset) => {
        if (offset >= total) {
          req.end();
          return;
        }
        const chunk = buffer.slice(offset, Math.min(offset + UPLOAD_CHUNK, total));
        const ok = req.write(chunk);
        sent += chunk.length;

        const pct     = Math.round((sent / total) * 100);
        const doneMB  = (sent  / 1024 / 1024).toFixed(1);
        const totalMB = (total / 1024 / 1024).toFixed(1);
        const filled  = Math.floor(pct / 5);
        const bar     = '█'.repeat(filled) + '░'.repeat(20 - filled);
        process.stdout.write(`\r  Uploading:   [${bar}] ${pct}% — ${doneMB}MB / ${totalMB}MB`);

        // Respect backpressure — wait for drain if write buffer is full
        if (ok) {
          setImmediate(() => writeChunk(offset + UPLOAD_CHUNK));
        } else {
          req.once('drain', () => writeChunk(offset + UPLOAD_CHUNK));
        }
      };

      writeChunk(0);
    });

    if (!uploadToken) throw new Error('Google Photos returned empty upload token');
    logger.debug(`Google Photos → got upload token for "${filename}"`);

    // Step 2: Create media item in library and add to album
    const albumId = await this.getOrCreateAlbum();

    const createRes = await axios.post(
      'https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate',
      {
        albumId,
        newMediaItems: [{ simpleMediaItem: { fileName: filename, uploadToken } }],
      },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
      }
    );

    const result = createRes.data.newMediaItemResults?.[0];
    const status = result?.status;

    if (status?.code && status.code !== 0) {
      throw new Error(`Google Photos rejected file: ${status.message}`);
    }

    const photoId = result?.mediaItem?.id;
    if (!photoId) throw new Error('Google Photos did not return a media item ID');

    // Persist photoId immediately via callback — crash-safe
    if (onPhotoIdReceived) onPhotoIdReceived(photoId);

    logger.debug(`Google Photos → uploaded to album "${ALBUM_NAME}", id: ${photoId}`);
    return photoId;
  }
}

module.exports = { GooglePhotosClient };