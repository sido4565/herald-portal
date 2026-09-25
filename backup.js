const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

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

  // Auto-save refreshed tokens
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

// ---------- Helpers ----------
const FILE_NAME = 'herald.db';

async function findFileId(drive) {
  const res = await drive.files.list({
    q: `name='${FILE_NAME}' and trashed=false`,
    fields: 'files(id, name, modifiedTime, size)',
    spaces: 'drive',
  });
  const files = res.data.files || [];
  return files.length ? files[0] : null;
}

// ---------- Public API ----------
async function uploadBackup(localPath) {
  if (!ENABLED) return { skipped: true };
  if (!fs.existsSync(localPath)) throw new Error(`Local file not found: ${localPath}`);

  const auth = getClient();
  const drive = google.drive({ version: 'v3', auth });

  const existing = await findFileId(drive);
  const media = {
    mimeType: 'application/octet-stream',
    body: fs.createReadStream(localPath),
  };

  if (existing) {
    const res = await drive.files.update({
      fileId: existing.id,
      media,
    });
    const size = fs.statSync(localPath).size;
    return { ok: true, size, id: res.data.id, updated: true };
  } else {
    const res = await drive.files.create({
      requestBody: { name: FILE_NAME },
      media,
      fields: 'id, name',
    });
    const size = fs.statSync(localPath).size;
    return { ok: true, size, id: res.data.id, created: true };
  }
}

async function downloadBackup(localPath) {
  if (!ENABLED) return { skipped: true };

  const auth = getClient();
  const drive = google.drive({ version: 'v3', auth });

  const existing = await findFileId(drive);
  if (!existing) return { notFound: true };

  const res = await drive.files.get(
    { fileId: existing.id, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(localPath);
    res.data
      .on('end', resolve)
      .on('error', reject)
      .pipe(dest);
  });

  const size = fs.statSync(localPath).size;
  return { ok: true, size };
}

async function remoteExists() {
  if (!ENABLED) return false;
  try {
    const auth = getClient();
    const drive = google.drive({ version: 'v3', auth });
    const existing = await findFileId(drive);
    return !!existing;
  } catch {
    return false;
  }
}

module.exports = { uploadBackup, downloadBackup, remoteExists, ENABLED };