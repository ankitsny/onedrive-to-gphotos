const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'migration.log');

if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

const LEVELS = {
  INFO:    { label: 'INFO ', color: '\x1b[36m' },
  SUCCESS: { label: 'DONE ', color: '\x1b[32m' },
  WARN:    { label: 'WARN ', color: '\x1b[33m' },
  ERROR:   { label: 'ERROR', color: '\x1b[31m' },
  DEBUG:   { label: 'DEBUG', color: '\x1b[90m' },
};

const RESET = '\x1b[0m';

function write(level, message) {
  const now = new Date().toISOString();
  const { label, color } = LEVELS[level];
  console.log(`${color}[${now}] [${label}]${RESET} ${message}`);
  fs.appendFileSync(LOG_FILE, `[${now}] [${label}] ${message}\n`);
}

const logger = {
  info:    (msg) => write('INFO', msg),
  success: (msg) => write('SUCCESS', msg),
  warn:    (msg) => write('WARN', msg),
  error:   (msg) => write('ERROR', msg),
  debug:   (msg) => write('DEBUG', msg),

  section: (title) => {
    const line = '─'.repeat(60);
    const msg = `\n${line}\n  ${title}\n${line}`;
    console.log(`\x1b[1m${msg}${RESET}`);
    fs.appendFileSync(LOG_FILE, `${msg}\n`);
  },

  summary: (stats) => {
    const total = stats.done + stats.failed + stats.pending;
    const pct   = total > 0 ? Math.round((stats.done / total) * 100) : 0;

    // Each row: '║  ' (3) + label (15) + ' : ' (3) + value.padEnd(18) + '║' (1) = 40 total
    const row = (label, value) => `║  ${label} : ${String(value).padEnd(18)}║`;

    const lines = [
      '',
      '╔══════════════════════════════════════╗',
      '║         MIGRATION SUMMARY            ║',
      '╠══════════════════════════════════════╣',
      row('Total scanned  ', total),
      row('Uploaded       ', stats.done),
      row('Failed         ', stats.failed),
      row('Pending        ', stats.pending),
      row('Progress       ', pct + '%'),
      '╚══════════════════════════════════════╝',
      '',
    ].join('\n');
    console.log(`\x1b[32m${lines}${RESET}`);
    fs.appendFileSync(LOG_FILE, lines + '\n');
  },
};

module.exports = { logger };