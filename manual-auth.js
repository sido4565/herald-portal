const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
  console.error('   Run: export $(cat .env.gdrive | xargs)');
  process.exit(1);
}

// OOB flow — Google deprecated this, but it still works with a workaround.
// Use a redirect URI that Google shows as "copy this code"
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
}).toString();

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  STEP 1: Open this URL in your LOCAL browser');
console.log('═══════════════════════════════════════════════════════════════\n');
console.log(authUrl);
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  STEP 2: Sign in, approve, copy the code Google shows');
console.log('  STEP 3: Paste the code below and press Enter');
console.log('═══════════════════════════════════════════════════════════════\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste authorization code here: ', (code) => {
  rl.close();
  const trimmed = code.trim();

  if (!trimmed) {
    console.error('❌ No code provided');
    process.exit(1);
  }

  const postData = new URLSearchParams({
    code: trimmed,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  const req = https.request({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      try {
        const tokens = JSON.parse(body);

        if (tokens.error) {
          console.error('\n❌ Token exchange failed:', tokens.error);
          console.error('   Description:', tokens.error_description);
          process.exit(1);
        }

        // Prepare the token JSON in the format sqlite-cloud-backup expects
        const tokenData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          scope: tokens.scope,
          token_type: tokens.token_type,
          expiry_date: Date.now() + (tokens.expires_in * 1000),
        };

        // Save to .gdrive-tokens/tokens.json
        const dir = path.join(__dirname, '.gdrive-tokens');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tokenPath = path.join(dir, 'tokens.json');
        fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));

        console.log('\n✅ Success! Tokens saved to:', tokenPath);
        console.log('\nRefresh token:', tokens.refresh_token ? '✅ present' : '❌ missing');
        console.log('Access token: ✅ present');
        console.log('\nYou can now run:');
        console.log('  node backup-gdrive.js push\n');
      } catch (e) {
        console.error('\n❌ Failed to parse response:', e.message);
        console.error('   Raw response:', body);
        process.exit(1);
      }
    });
  });

  req.on('error', (e) => {
    console.error('\n❌ Network error:', e.message);
    process.exit(1);
  });

  req.write(postData);
  req.end();
});
