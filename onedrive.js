const axios = require('axios');
const { PublicClientApplication } = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const TOKEN_CACHE = path.join(__dirname, '.onedrive_token.json');
const IMAGE_EXTENSIONS = new Set([
  // Common photos
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.heic', '.heif', '.bmp', '.tiff', '.tif',
  '.raw', '.arw', '.cr2', '.cr3', '.nef',   // RAW (Sony, Canon, Nikon)
  '.dng', '.orf', '.rw2', '.pef',            // RAW (Adobe, Olympus, Panasonic, Pentax)
  '.svg',
 
  // Videos
  '.mp4', '.mov', '.avi', '.mkv', '.3gp',
  '.m4v', '.wmv', '.flv', '.webm', '.mts',  // MTS = Sony/Panasonic cameras
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

    // Try silent first (cached token)
    try {
      const accounts = await this.msalClient.getTokenCache().getAllAccounts();
      if (accounts.length > 0) {
        const result = await this.msalClient.acquireTokenSilent({ scopes, account: accounts[0] });
        this.accessToken = result.accessToken;
        logger.success('OneDrive → authenticated via cached token');
        return;
      }
    } catch (err) {
      // Stale/invalid cache — wipe it and fall through to device code flow
      logger.debug(`OneDrive → silent auth failed (${err.errorCode || err.message}), clearing cache`);
      if (fs.existsSync(TOKEN_CACHE)) fs.unlinkSync(TOKEN_CACHE);
    }

    // Device code flow — MSAL returns different field names depending on version
    // so we check all known variants to be safe
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
            logger.info(`If browser does not open, visit:\n  ${url}\n  and enter the code: ${code}`);
          }
        } else {
          logger.info(response.message || 'Check MSAL output for sign-in instructions');
        }
        logger.info('Waiting for sign-in... (you have ~15 minutes)');
      },
    });

    this.accessToken = result.accessToken;
    logger.success('OneDrive → authenticated successfully');
  }

  // ── Scan all files (paginated) ────────────────────────────────

  async *scanAllFiles() {
    // Use delta API — lists ALL files across all folders recursively, no empty query needed
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

      // Filter to media files only (skip folders and non-media)
      const media = items.filter((f) => {
        if (!f.file) return false;
        const dot = f.name.lastIndexOf('.');
        if (dot === -1) return false;
        const ext = f.name.toLowerCase().slice(dot);
        return IMAGE_EXTENSIONS.has(ext);
      });

      logger.debug(`  Page ${pageNum}: ${items.length} items fetched, ${media.length} are media`);

      if (media.length > 0) yield media;

      // nextLink = more pages to fetch, deltaLink = done
      url = response['@odata.nextLink'] || null;
    }

    logger.debug(`OneDrive → scan complete, ${pageNum} pages fetched`);
  }


  // ── Download a single file into memory ───────────────────────

  async downloadFile(onedriveId, filename) {
    logger.debug(`OneDrive → downloading "${filename}" (id: ${onedriveId})`);

    const meta = await this._get(
      `https://graph.microsoft.com/v1.0/me/drive/items/${onedriveId}`
      + `?$select=@microsoft.graph.downloadUrl`
    );

    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) throw new Error('No download URL returned from OneDrive');

    // Use https directly — axios onDownloadProgress fires too infrequently
    const buffer = await new Promise((resolve, reject) => {
      const https  = require('https');
      const urlObj = new URL(downloadUrl);

      const doRequest = (reqUrl) => {
        const r = https.request({
          hostname: reqUrl.hostname,
          path:     reqUrl.pathname + reqUrl.search,
          method:   'GET',
          timeout:  120_000,
        }, (res) => {
          // Follow redirect (OneDrive URLs redirect to CDN)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(new URL(res.headers.location));
            return;
          }
          collectResponse(res, resolve, reject);
        });
        r.on('error', (err) => { process.stdout.write('\n'); reject(err); });
        r.end();
      };

      doRequest(urlObj);
    });

    logger.debug(`OneDrive → downloaded "${filename}" (${(buffer.length / 1024).toFixed(0)} KB)`);
    return buffer;
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

// Collects streamed response into a Buffer with progress bar
function collectResponse(res, resolve, reject) {
  const total = parseInt(res.headers['content-length'] || '0', 10);
  const chunks = [];
  let received = 0;

  res.on('data', (chunk) => {
    chunks.push(chunk);
    received += chunk.length;
    if (total) {
      const pct     = Math.round((received / total) * 100);
      const doneMB  = (received / 1024 / 1024).toFixed(1);
      const totalMB = (total    / 1024 / 1024).toFixed(1);
      const filled  = Math.floor(pct / 5);
      const bar     = '█'.repeat(filled) + '░'.repeat(20 - filled);
      process.stdout.write(`\r  Downloading: [${bar}] ${pct}% — ${doneMB}MB / ${totalMB}MB`);
    }
  });

  res.on('end', () => {
    process.stdout.write('\n');
    resolve(Buffer.concat(chunks));
  });

  res.on('error', (err) => {
    process.stdout.write('\n');
    reject(err);
  });
}

module.exports = { OneDriveClient };