// sync-restore.js — runs as a child process to restore DB before parent requires it
const fs = require('fs');
const path = require('path');
const { downloadBackup, ENABLED } = require('./backup');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'herald.db');

(async () => {
  if (!ENABLED) {
    console.log('ℹ️  Sync restore: cloud backup disabled');
    process.exit(0);
  }

  if (fs.existsSync(DB_PATH)) {
    console.log('ℹ️  Sync restore: local DB exists, skipping');
    process.exit(0);
  }

  try {
    const result = await downloadBackup(DB_PATH);
    if (result.ok) {
      console.log(`✅ Sync restore: DB downloaded (${result.size} bytes)`);
    } else if (result.notFound) {
      console.log('ℹ️  Sync restore: no cloud backup — will seed fresh');
    }
  } catch (err) {
    console.error('⚠️  Sync restore failed:', err.message);
  }
  process.exit(0);
})();