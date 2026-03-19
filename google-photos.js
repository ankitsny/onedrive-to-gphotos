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

class GooglePhotosClient {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3000/callback'
    );
    this.albumId = null;
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
  // stream     — readable stream from OneDrive (createDownloadStream)
  // fileSize   — total bytes, required for Content-Length header
  // onPhotoIdReceived — called immediately when Google confirms the ID,
  //                     before this function returns, for crash-safe DB write

  async uploadPhoto(stream, filename, mimeType, fileSize, modifiedDate, onPhotoIdReceived = null, progressState = null) {
    const accessToken = (await this.oauth2Client.getAccessToken()).token;
    const totalMB = (fileSize / 1024 / 1024).toFixed(1);

    logger.debug(`Google Photos → uploading "${filename}" (${totalMB} MB, ${mimeType})`);

    // Timeout scales with file size: minimum 3 min, +2s per MB, max 6 hours
    const timeoutMs = Math.min(
      Math.max(180_000, (fileSize / 1024 / 1024) * 2000),
      6 * 60 * 60 * 1000
    );

    // Step 1: Stream bytes directly into Google Photos upload endpoint
    // The download stream and upload request are piped together —
    // only one chunk (~256KB from CDN) is in memory at any point.
    const uploadToken = await new Promise((resolve, reject) => {
      let settled = false;
      let sent = 0;

      const done = (err, val) => {
        if (settled) return;
        settled = true;
        // Always destroy the stream when we're done — whether success or failure.
        // This aborts the OneDrive CDN connection immediately, freeing the socket.
        if (!stream.destroyed) stream.destroy(err || undefined);
        if (err) reject(err);
        else resolve(val);
      };

      const req = https.request({
        hostname: 'photoslibrary.googleapis.com',
        path:     '/v1/uploads',
        method:   'POST',
        timeout:  timeoutMs,
        headers: {
          'Authorization':              `Bearer ${accessToken}`,
          'Content-Type':               'application/octet-stream',
          'Content-Length':             fileSize,
          'X-Goog-Upload-Content-Type': mimeType,
          'X-Goog-Upload-Protocol':     'raw',
          'X-Goog-Upload-File-Name':    encodeURIComponent(filename),
        },
      }, (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => {
          if (progressState) progressState.finish();
          else process.stdout.write('\n');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            done(null, body.trim());
          } else {
            done(new Error(`Upload failed with status ${res.statusCode}: ${body}`));
          }
        });
        res.on('error', (err) => { if (progressState) progressState.finish(); else process.stdout.write('\n'); done(err); });
      });

      req.on('timeout', () => {
        req.destroy();
        done(new Error(`Upload timed out after ${Math.round(timeoutMs / 60000)} minutes`));
      });

      // Upload req error → destroy stream + reject
      req.on('error', (err) => { if (progressState) progressState.finish(); else process.stdout.write('\n'); done(err); });

      // Stream download → upload with backpressure
      stream.on('data', (chunk) => {
        const ok = req.write(chunk);
        sent += chunk.length;

        if (progressState) {
          progressState.ulPct = Math.round((sent / fileSize) * 100);
          progressState.ulMB  = (sent / 1024 / 1024).toFixed(1);
          progressState.render();
        }

        // If upload socket buffer full, pause CDN download until drained
        if (!ok) stream.pause();
      });

      // Upload drained → resume CDN download
      req.on('drain', () => { if (!stream.destroyed) stream.resume(); });

      // Download finished → close upload request
      stream.on('end', () => req.end());

      // Download stream error → abort upload + reject
      stream.on('error', (err) => { if (progressState) progressState.finish(); else process.stdout.write('\n'); req.destroy(); done(err); });
    });

    if (!uploadToken) throw new Error('Google Photos returned empty upload token');
    logger.debug(`Google Photos → got upload token for "${filename}"`);

    // Step 2: Create media item and add to album
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

    // Persist photoId immediately — crash-safe checkpoint
    if (onPhotoIdReceived) onPhotoIdReceived(photoId);

    logger.debug(`Google Photos → uploaded to album "${ALBUM_NAME}", id: ${photoId}`);
    return photoId;
  }
}

module.exports = { GooglePhotosClient };
