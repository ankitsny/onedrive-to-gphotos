const axios = require('axios');
const https = require('https');
const { PassThrough } = require('stream');
const { PublicClientApplication } = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const TOKEN_CACHE = path.join(__dirname, '.onedrive_token.json');

const IMAGE_EXTENSIONS = new Set([
  // Photos
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.heic', '.heif', '.bmp', '.tiff', '.tif',
  '.raw', '.arw', '.cr2', '.cr3', '.nef',   // RAW (Sony, Canon, Nikon)
  '.dng', '.orf', '.rw2', '.pef',            // RAW (Adobe, Olympus, Panasonic, Pentax)
  '.svg',
  // Videos
  '.mp4', '.mov', '.avi', '.mkv', '.3gp',
  '.m4v', '.wmv', '.flv', '.webm', '.mts',
  '.m2ts', '.mpg', '.mpeg',
]);

class OneDriveClient {
  constructor() {
    this.accessToken = null;
    this.msalClient = new PublicClientApplication({
      auth: {
        clientId: process.env.ONEDRIVE_CLIENT_ID,
        authority: 'https://login.microsoftonline.com/consumers',
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (ctx) => {
            if (fs.existsSync(TOKEN_CACHE)) {
              ctx.tokenCache.deserialize(fs.readFileSync(TOKEN_CACHE, 'utf8'));
            }
          },
          afterCacheAccess: async (ctx) => {
            if (ctx.cacheHasChanged) {
              fs.writeFileSync(TOKEN_CACHE, ctx.tokenCache.serialize());
            }
          },
        },
      },
    });
  }

  // ── Auth ──────────────────────────────────────────────────────

  async authenticate() {
    const scopes = ['Files.Read', 'offline_access'];

    try {
      const accounts = await this.msalClient.getTokenCache().getAllAccounts();
      if (accounts.length > 0) {
        const result = await this.msalClient.acquireTokenSilent({ scopes, account: accounts[0] });
        this.accessToken = result.accessToken;
        logger.success('OneDrive → authenticated via cached token');
        return;
      }
    } catch (err) {
      logger.debug(`OneDrive → silent auth failed (${err.errorCode || err.message}), clearing cache`);
      if (fs.existsSync(TOKEN_CACHE)) fs.unlinkSync(TOKEN_CACHE);
    }

    const result = await this.msalClient.acquireTokenByDeviceCode({
      scopes,
      deviceCodeCallback: async (response) => {
        logger.section('OneDrive Authentication Required');
        const url  = response.verificationUri || response.verification_uri || response.verificationUrl;
        const code = response.userCode || response.user_code;
        if (url && code) {
          logger.info(`Code   : ${code}`);
          logger.info('Opening browser for sign-in...');
          try {
            const open = (await import('open')).default;
            await open(url);
            logger.info(`If browser does not open, visit:\n  ${url}\n  and enter the code: ${code}`);
          } catch {
            logger.info(`Visit:\n  ${url}\n  and enter the code: ${code}`);
          }
        } else {
          logger.info(response.message || 'Check terminal for sign-in instructions');
        }
        logger.info('Waiting for sign-in... (you have ~15 minutes)');
      },
    });

    this.accessToken = result.accessToken;
    logger.success('OneDrive → authenticated successfully');
  }

  // ── Scan all files (paginated) ────────────────────────────────

  async *scanAllFiles() {
    let url =
      `https://graph.microsoft.com/v1.0/me/drive/root/delta`
      + `?$select=id,name,size,lastModifiedDateTime,file,parentReference`
      + `&$top=100`;

    let pageNum = 0;

    while (url) {
      pageNum++;
      logger.debug(`OneDrive → fetching page ${pageNum} of file list...`);

      const response = await this._get(url);
      const items = response.value || [];

      const media = items.filter((f) => {
        if (!f.file) return false;
        const dot = f.name.lastIndexOf('.');
        if (dot === -1) return false;
        const ext = f.name.toLowerCase().slice(dot);
        return IMAGE_EXTENSIONS.has(ext);
      });

      logger.debug(`  Page ${pageNum}: ${items.length} items fetched, ${media.length} are media`);
      if (media.length > 0) yield media;

      url = response['@odata.nextLink'] || null;
    }

    logger.debug(`OneDrive → scan complete, ${pageNum} pages fetched`);
  }

  // ── Resolve download URL (follow redirects, return final CDN URL) ──

  async getDownloadStream(onedriveId, filename, fileSize) {
    logger.debug(`OneDrive → resolving download URL for "${filename}"`);

    const meta = await this._get(
      `https://graph.microsoft.com/v1.0/me/drive/items/${onedriveId}`
      + `?$select=@microsoft.graph.downloadUrl`
    );

    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) throw new Error('No download URL returned from OneDrive');

    const finalUrl = await resolveRedirect(downloadUrl);
    logger.debug(`OneDrive → resolved CDN URL for "${filename}"`);

    return { finalUrl, fileSize };
  }

  // ── Internal helpers ──────────────────────────────────────────

  async _get(url) {
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        timeout: 30_000,
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 401) {
        throw new Error('OneDrive token expired. Delete .onedrive_token.json and re-run.');
      }
      throw new Error(`OneDrive API error: ${err.response?.data?.error?.message || err.message}`);
    }
  }
}

// ── resolveRedirect ───────────────────────────────────────────
// Follows redirects via HEAD requests and returns the final URL.
// OneDrive pre-auth URLs redirect to a CDN — we resolve upfront
// so the actual data stream goes directly to the CDN, not through
// an extra redirect hop.

function resolveRedirect(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const attempt = (reqUrl, remaining) => {
      const urlObj = new URL(reqUrl);
      const r = https.request({
        hostname: urlObj.hostname,
        path:     urlObj.pathname + urlObj.search,
        method:   'HEAD',
        timeout:  15_000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (remaining <= 0) return reject(new Error('Too many redirects resolving download URL'));
          attempt(res.headers.location, remaining - 1);
        } else {
          resolve(reqUrl);
        }
      });
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout resolving download URL')); });
      r.on('error', reject);
      r.end();
    };
    attempt(url, maxRedirects);
  });
}

// ── createDownloadStream ──────────────────────────────────────
// Opens a streaming GET to the final CDN URL.
// Returns a PassThrough stream — data flows chunk by chunk, never
// accumulates in RAM. The caller is responsible for destroying
// the stream on error (call stream.destroy(err)).

function createDownloadStream(finalUrl, fileSize) {
  const pass = new PassThrough();
  const urlObj = new URL(finalUrl);
  let received = 0;
  const total = fileSize || 0;

  // Timeout scales with file size: minimum 2 min, +1s per MB, max 6 hours
  const timeoutMs = Math.min(
    Math.max(120_000, (total / 1024 / 1024) * 1000),
    6 * 60 * 60 * 1000
  );

  const r = https.request({
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   'GET',
    timeout:  timeoutMs,
  }, (res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      pass.destroy(new Error(`Download failed with HTTP ${res.statusCode}`));
      return;
    }

    res.on('data', (chunk) => {
      received += chunk.length;
      if (total) {
        const pct     = Math.round((received / total) * 100);
        const doneMB  = (received / 1024 / 1024).toFixed(1);
        const totalMB = (total    / 1024 / 1024).toFixed(1);
        const filled  = Math.floor(pct / 5);
        const bar     = '█'.repeat(filled) + '░'.repeat(20 - filled);
        process.stdout.write(`\r  Downloading: [${bar}] ${pct}% — ${doneMB}MB / ${totalMB}MB`);
      }

      // Respect PassThrough backpressure — pause CDN if upload can't keep up
      const ok = pass.write(chunk);
      if (!ok) res.pause();
    });

    // Resume CDN download when downstream (upload) drains
    pass.on('drain', () => res.resume());

    res.on('end',   ()    => { process.stdout.write('\n'); pass.end(); });
    res.on('error', (err) => { process.stdout.write('\n'); pass.destroy(err); });
  });

  r.on('timeout', () => {
    r.destroy();
    pass.destroy(new Error(`Download timed out after ${Math.round(timeoutMs / 60000)} minutes`));
  });

  // When the stream is destroyed externally (e.g. upload failed),
  // abort the underlying HTTP request immediately to free the connection
  pass.on('close', () => {
    if (!r.destroyed) r.destroy();
  });

  r.on('error', (err) => { process.stdout.write('\n'); pass.destroy(err); });
  r.end();

  return pass;
}

module.exports = { OneDriveClient, createDownloadStream };
