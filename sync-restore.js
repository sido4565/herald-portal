const fs = require('fs');
const path = require('path');
const { downloadBackup, ENABLED } = require('./backup');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'herald.db');

(async () => {
  try {
    if (!ENABLED) {
      console.log('sync-restore: cloud backup disabled');
      process.exit(0);
    }
    if (fs.existsSync(DB_PATH)) {
      console.log('sync-restore: local DB exists, skipping');
      process.exit(0);
    }
    console.log('sync-restore: downloading DB from Google Drive...');
    const result = await downloadBackup(DB_PATH);
    if (result.ok) {
      console.log('sync-restore: DB downloaded (' + result.size + ' bytes)');
    } else if (result.notFound) {
      console.log('sync-restore: no cloud backup, will seed fresh');
    }
  } catch (err) {
    console.error('sync-restore failed:', err.message);
  }
  process.exit(0);
})();
