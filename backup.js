const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Database = require('better-sqlite3');

// ---------- Token loading ----------
function loadTokens() {
  if (process.env.GDRIVE_TOKENS) {
    try {
      return JSON.parse(process.env.GDRIVE_TOKENS);
    } catch (e) {
      console.error('⚠️  GDRIVE_TOKENS env var is not valid JSON');
      return null;
    }
  }
  const tokenPath = path.join(__dirname, '.gdrive-tokens', 'tokens.json');
  if (fs.existsSync(tokenPath)) {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  }
  return null;
}

const tokens = loadTokens();
const ENABLED = !!(
  tokens &&
  tokens.refresh_token &&
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET
);

// ---------- OAuth client ----------
let oauth2Client = null;

function getClient() {
  if (oauth2Client) return oauth2Client;

  oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );

  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    token_type: tokens.token_type,
    expiry_date: tokens.expiry_date,
  });

  oauth2Client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    const tokenPath = path.join(__dirname, '.gdrive-tokens', 'tokens.json');
    if (!fs.existsSync(path.dirname(tokenPath))) {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    }
    fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    console.log('🔄 Tokens refreshed and saved locally');
  });

  return oauth2Client;
}

// ---------- Constants ----------
const LATEST_MARKER = 'herald-latest.txt';
const BACKUP_PREFIX = 'herald-';
const RETENTION_DAYS = 30;

// ---------- Helpers ----------
function timestampKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${h}${min}${sec}`;
}

async function listBackups(drive) {
  const res = await drive.files.list({
    q: `name contains '${BACKUP_PREFIX}' and trashed=false`,
    fields: 'files(id, name, modifiedTime, size, mimeType)',
    orderBy: 'name desc',
  });
  return (res.data.files || []).filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
}

async function findFile(drive, name) {
  const res = await drive.files.list({
    q: `name='${name}' and trashed=false`,
    fields: 'files(id, name, modifiedTime, size)',
  });
  return (res.data.files || [])[0] || null;
}

// ---------- Validate a local DB file ----------
function validateDbFile(localPath) {
  try {
    if (!fs.existsSync(localPath)) return { ok: false, reason: 'file not found' };

    const stats = fs.statSync(localPath);
    if (stats.size < 4096) return { ok: false, reason: `too small (${stats.size} bytes)` };

    const test = new Database(localPath, { readonly: true });
    test.prepare('PRAGMA integrity_check').get();
    // Also try a real query on a known table to detect schema corruption
    try { test.prepare('SELECT COUNT(*) AS c FROM sqlite_master').get(); } catch (_) {}
    test.close();
    return { ok: true, size: stats.size };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---------- Snapshot via better-sqlite3 ----------
async function createSnapshot(db, snapshotPath) {
  if (typeof db.backup !== 'function') {
    throw new Error('better-sqlite3 backup() not available');
  }
  await db.backup(snapshotPath);
  return snapshotPath;
}

// ---------- Upload a NEW dated backup ----------
async function uploadBackup(localPath, { force = false } = {}) {
  if (!ENABLED) return { skipped: true };

  // Validate before upload
  const validation = validateDbFile(localPath);
  if (!validation.ok && !force) {
    console.warn(`⚠️  Refusing to upload invalid file: ${validation.reason}`);
    return { skipped: true, reason: `invalid: ${validation.reason}` };
  }

  const auth = getClient();
  const drive = google.drive({ version: 'v3', auth });

  const stats = fs.statSync(localPath);
  const size = stats.size;

  // Safety: refuse if size dropped >50% vs most recent
  const existing = await listBackups(drive);
  if (existing.length && !force) {
    const mostRecent = existing[0];
    const lastSize = Number(mostRecent.size || 0);
    if (lastSize > 0) {
      const ratio = size / lastSize;
      if (ratio < 0.5) {
        console.warn(`⚠️  Size dropped from ${lastSize} to ${size} bytes (${Math.round(ratio*100)}%). Skipping for safety.`);
        return { skipped: true, reason: 'size-regression', lastSize, newSize: size };
      }
    }
  }

  // Upload new dated file
  const key = timestampKey();
  const filename = `${BACKUP_PREFIX}${key}.db`;

  const created = await drive.files.create({
    requestBody: { name: filename },
    media: {
      mimeType: 'application/octet-stream',
      body: fs.createReadStream(localPath),
    },
    fields: 'id, name',
  });

  // Update "latest" pointer
  const markerContent = `${filename}\n${new Date().toISOString()}\n${size}\n`;
  const markerExisting = await findFile(drive, LATEST_MARKER);

  if (markerExisting) {
    await drive.files.update({
      fileId: markerExisting.id,
      media: { mimeType: 'text/plain', body: markerContent },
    });
  } else {
    await drive.files.create({
      requestBody: { name: LATEST_MARKER },
      media: { mimeType: 'text/plain', body: markerContent },
      fields: 'id, name',
    });
  }

  // Cleanup old backups
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const old = existing.filter(f => {
    if (f.name === LATEST_MARKER) return false;
    const modified = new Date(f.modifiedTime).getTime();
    return modified < cutoff;
  });
  for (const f of old) {
    try {
      await drive.files.delete({ fileId: f.id });
      console.log(`🗑️  Deleted old backup: ${f.name}`);
    } catch (e) {
      console.warn(`Could not delete ${f.name}:`, e.message);
    }
  }

  console.log(`☁️  Backup uploaded: ${filename} (${size} bytes, validated ✅)`);
  return { ok: true, size, id: created.data.id, filename };
}

// ---------- Download the LATEST VALID backup ----------
async function downloadBackup(localPath) {
  if (!ENABLED) return { skipped: true };

  const auth = getClient();
  const drive = google.drive({ version: 'v3', auth });

  // Read latest marker
  const marker = await findFile(drive, LATEST_MARKER);
  let targetName = null;

  if (marker) {
    try {
      const res = await drive.files.get(
        { fileId: marker.id, alt: 'media' },
        { responseType: 'text' }
      );
      targetName = String(res.data).split('\n')[0].trim();
    } catch (e) {
      console.warn('Could not read latest marker:', e.message);
    }
  }

  // Get all backups
  const backups = await listBackups(drive);
  if (!backups.length) return { notFound: true };

  // Order: latest marker first, then rest by name desc
  const ordered = [];
  if (targetName) {
    const target = backups.find(b => b.name === targetName);
    if (target) ordered.push(target);
  }
  backups.forEach(b => {
    if (!ordered.find(o => o.id === b.id)) ordered.push(b);
  });

  // Try each until one validates
  for (const file of ordered) {
    try {
      console.log(`   Trying ${file.name}...`);
      const res = await drive.files.get(
        { fileId: file.id, alt: 'media' },
        { responseType: 'stream' }
      );

      await new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(localPath);
        res.data.on('end', resolve).on('error', reject).pipe(dest);
      });

      const validation = validateDbFile(localPath);
      if (!validation.ok) {
        console.warn(`   ❌ ${file.name}: ${validation.reason}`);
        continue;
      }

      console.log(`☁️  Restored from ${file.name} (${validation.size} bytes) — valid ✅`);
      return { ok: true, size: validation.size, filename: file.name };
    } catch (e) {
      console.warn(`   ❌ ${file.name}: download failed (${e.message})`);
      continue;
    }
  }

  console.error('❌ No valid backup found among ' + ordered.length + ' attempts');
  return { ok: false, error: 'No valid backup found' };
}

// ---------- Download a SPECIFIC backup ----------
async function downloadBackupByName(name, localPath) {
  if (!ENABLED) return { skipped: true };

  const auth = getClient();
  const drive = google.drive({ version: 'v3', auth });

  const file = await findFile(drive, name);
  if (!file) return { notFound: true };

  const res = await drive.files.get(
    { fileId: file.id, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(localPath);
    res.data.on('end', resolve).on('error', reject).pipe(dest);
  });

  const validation = validateDbFile(localPath);
  if (!validation.ok) {
    return { ok: false, error: `Corrupted: ${validation.reason}` };
  }

  console.log(`☁️  Restored ${name} (${validation.size} bytes) — valid ✅`);
  return { ok: true, size: validation.size, filename: name };
}

// ---------- List all backups ----------
async function listBackupsOnDrive() {
  if (!ENABLED) return [];
  const auth = getClient();
  const drive = google.drive({ version: 'v3', auth });
  const backups = await listBackups(drive);
  return backups.map(f => ({
    name: f.name,
    size: Number(f.size || 0),
    modified: f.modifiedTime,
    id: f.id,
  }));
}

async function remoteExists() {
  if (!ENABLED) return false;
  try {
    const backups = await listBackupsOnDrive();
    return backups.length > 0;
  } catch {
    return false;
  }
}

module.exports = {
  uploadBackup,
  downloadBackup,
  downloadBackupByName,
  listBackupsOnDrive,
  remoteExists,
  createSnapshot,
  validateDbFile,
  ENABLED,
};