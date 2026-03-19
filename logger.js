const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'migration.log');

// Ensure log file exists
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

const LEVELS = {
  INFO:    { label: 'INFO ', color: '\x1b[36m' },  // cyan
  SUCCESS: { label: 'DONE ', color: '\x1b[32m' },  // green
  WARN:    { label: 'WARN ', color: '\x1b[33m' },  // yellow
  ERROR:   { label: 'ERROR', color: '\x1b[31m' },  // red
  DEBUG:   { label: 'DEBUG', color: '\x1b[90m' },  // grey
};

const RESET = '\x1b[0m';

function write(level, message) {
  const now = new Date().toISOString();
  const { label, color } = LEVELS[level];

  // Console: colored
  console.log(`${color}[${now}] [${label}]${RESET} ${message}`);

  // File: plain text
  fs.appendFileSync(LOG_FILE, `[${now}] [${label}] ${message}\n`);
}

const logger = {
  info:    (msg) => write('INFO', msg),
  success: (msg) => write('SUCCESS', msg),
  warn:    (msg) => write('WARN', msg),
  error:   (msg) => write('ERROR', msg),
  debug:   (msg) => write('DEBUG', msg),

  // Section dividers for readability
  section: (title) => {
    const line = '─'.repeat(60);
    const msg = `\n${line}\n  ${title}\n${line}`;
    console.log(`\x1b[1m${msg}${RESET}`);
    fs.appendFileSync(LOG_FILE, `${msg}\n`);
  },

  // Final summary box
  summary: (stats) => {
    const total = stats.done + stats.failed + stats.pending;
    const pct = total > 0 ? Math.round((stats.done / total) * 100) : 0;
    const lines = [
      '',
      '╔══════════════════════════════════════╗',
      '║         MIGRATION SUMMARY            ║',
      '╠══════════════════════════════════════╣',
      `║  Total scanned   : ${String(total).padEnd(17)}║`,
      `║  ✅ Uploaded     : ${String(stats.done).padEnd(17)}║`,
      `║  ❌ Failed       : ${String(stats.failed).padEnd(17)}║`,
      `║  ⏳ Pending      : ${String(stats.pending).padEnd(17)}║`,
      `║  📈 Progress     : ${String(pct + '%').padEnd(17)}║`,
      '╚══════════════════════════════════════╝',
      '',
    ].join('\n');
    console.log(`\x1b[32m${lines}${RESET}`);
    fs.appendFileSync(LOG_FILE, lines + '\n');
  },
};

module.exports = { logger };
