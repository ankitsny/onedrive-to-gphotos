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
    // Just ensures an account is in the MSAL cache.
    // The actual access token is fetched fresh on every API call via getAccessToken()
    // so it is always valid — MSAL uses the refresh token automatically when needed.
    const scopes = ['Files.Read', 'offline_access'];

    try {
      const accounts = await this.msalClient.getTokenCache().getAllAccounts();
      if (accounts.length > 0) {
        // Warm up — verify the cached account still works
        await this.msalClient.acquireTokenSilent({ scopes, account: accounts[0] });
        logger.success('OneDrive → authenticated via cached token');
        return;
      }
    } catch (err) {
      logger.debug(`OneDrive → silent auth failed (${err.errorCode || err.message}), clearing cache`);
      if (fs.existsSync(TOKEN_CACHE)) fs.unlinkSync(TOKEN_CACHE);
    }

    await this.msalClient.acquireTokenByDeviceCode({
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

    logger.success('OneDrive → authenticated successfully');
  }

  // Get a fresh access token on every call — MSAL handles refresh automatically
  // This is the correct way to use MSAL: never cache the access token yourself
  async getAccessToken() {
    const scopes = ['Files.Read', 'offline_access'];
    try {
      const accounts = await this.msalClient.getTokenCache().getAllAccounts();
      if (accounts.length > 0) {
        const result = await this.msalClient.acquireTokenSilent({ scopes, account: accounts[0] });
        return result.accessToken;
      }
    } catch (err) {
      logger.warn(`OneDrive → token refresh failed: ${err.message}`);
      throw new Error('OneDrive token expired. Delete .onedrive_token.json and re-run.');
    }
    throw new Error('No OneDrive account in cache. Delete .onedrive_token.json and re-run.');
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
      const accessToken = await this.getAccessToken();
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
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

// ── makeProgressState ─────────────────────────────────────────
// Shared state between download and upload so both bars render
// atomically in one write — no two writers racing over the terminal.

// Detect ANSI support — works on macOS, Linux, and Windows Terminal
// Falls back to single-line mode on classic Windows CMD / old PowerShell
const SUPPORTS_ANSI = process.platform !== 'win32'
  || !!process.env.WT_SESSION          // Windows Terminal
  || process.env.TERM_PROGRAM === 'vscode'
  || process.env.TERM === 'xterm-256color';

function makeProgressState(fileSize) {
  const totalMB = (fileSize / 1024 / 1024).toFixed(1);
  const state = { dlPct: 0, dlMB: '0.0', ulPct: 0, ulMB: '0.0', totalMB };

  const mkBar = (pct) => '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));

  let firstRender = true;

  state.render = () => {
    const dl = `  Downloading: [${mkBar(state.dlPct)}] ${String(state.dlPct).padStart(3)}% — ${state.dlMB}MB / ${state.totalMB}MB`;
    const ul = `  Uploading:   [${mkBar(state.ulPct)}] ${String(state.ulPct).padStart(3)}% — ${state.ulMB}MB / ${state.totalMB}MB`;

    if (SUPPORTS_ANSI) {
      if (firstRender) {
        // No leading \n — the logger already ends its last line with \n
        // so cursor is already at the start of a fresh line
        process.stdout.write(dl + '\n' + ul);
        firstRender = false;
      } else {
        // Move up 1 line, overwrite both bars in place
        process.stdout.write('\x1B[1A\r' + dl + '\n\r' + ul);
      }
    } else {
      // Windows fallback — single overwriting line showing upload progress
      // Download bar scrolls past on first render only
      if (firstRender) {
        process.stdout.write(dl + '\n' + ul);
        firstRender = false;
      } else {
        process.stdout.write('\r' + ul);
      }
    }
  };

  state.finish = () => process.stdout.write('\n');

  return state;
}

// ── createDownloadStream ──────────────────────────────────────
// Opens a streaming GET to the final CDN URL.
// Returns a PassThrough stream — data flows chunk by chunk, never
// accumulates in RAM. The caller is responsible for destroying
// the stream on error (call stream.destroy(err)).

function createDownloadStream(finalUrl, fileSize, progressState) {
  const pass = new PassThrough();
  const urlObj = new URL(finalUrl);
  let received = 0;
  const total = fileSize || 0;

  // Inactivity timeout — 60s of silence = stalled connection
  // Resets on every chunk received, so slow-but-active downloads never time out
  // No assumption about network speed — only detects truly stuck connections
  const INACTIVITY_MS = 60_000;
  let inactivityTimer = null;

  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      r.destroy();
      pass.destroy(new Error('Download stalled — no data received for 60 seconds'));
    }, INACTIVITY_MS);
  };

  const clearInactivityTimer = () => {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
  };

  const r = https.request({
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   'GET',
  }, (res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      clearInactivityTimer();
      pass.destroy(new Error(`Download failed with HTTP ${res.statusCode}`));
      return;
    }

    resetInactivityTimer(); // start timer when response headers arrive

    res.on('data', (chunk) => {
      resetInactivityTimer(); // reset on every chunk — slow but active = fine
      received += chunk.length;
      if (total && progressState) {
        progressState.dlPct = Math.round((received / total) * 100);
        progressState.dlMB  = (received / 1024 / 1024).toFixed(1);
        progressState.render();
      }

      // Respect PassThrough backpressure — pause CDN if upload can't keep up
      const ok = pass.write(chunk);
      if (!ok) res.pause();
    });

    // Resume CDN download when downstream (upload) drains
    pass.on('drain', () => res.resume());

    res.on('end',   ()    => { clearInactivityTimer(); pass.end(); });
    res.on('error', (err) => { clearInactivityTimer(); pass.destroy(err); });
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

module.exports = { OneDriveClient, createDownloadStream, makeProgressState };