#!/usr/bin/env node
'use strict';

/**
 * Native client release tooling for the Sparkle (macOS) / WinSparkle (Windows) auto-updater.
 *
 *   node scripts/client-release.js keygen
 *       Generate the Ed25519 update-signing keypair in server/.sparkle/ (git-ignored) and print the PUBLIC key
 *       to embed in the client build. Refuses to overwrite an existing key. BACK UP THE PRIVATE KEY.
 *
 *   node scripts/client-release.js publish --platform mac|win --version X.Y.Z --file <artifact> \
 *        [--base-url https://host/client] [--notes "..."] [--min-os 11.0]
 *       Copy the artifact into assets/client/, sign it, and (re)write appcast-<platform>.xml pointing at it.
 *
 * The signature is Ed25519 over the raw enclosure bytes, base64-encoded — the exact format Sparkle/WinSparkle
 * verify (`sparkle:edSignature`). The public key is the raw 32-byte Ed25519 key, base64 (Info.plist
 * SUPublicEDKey on macOS, win_sparkle_set_eddsa_public_key on Windows). This is Sparkle's OWN update signature,
 * independent of Apple notarization / Windows Authenticode.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SPARKLE_DIR = path.join(__dirname, '..', '.sparkle');
const PRIV_PEM = path.join(SPARKLE_DIR, 'ed25519_private.pem');
const PUB_TXT = path.join(SPARKLE_DIR, 'ed25519_public.txt');   // base64 raw key, for reference
const CLIENT_DIR = path.join(__dirname, '..', 'assets', 'client');
const DEFAULT_BASE_URL = process.env.SAILSIM_CLIENT_BASE_URL || 'http://localhost:9080/client';

// Raw 32-byte Ed25519 public key (base64) from a KeyObject — Sparkle's SUPublicEDKey format. Ed25519 SPKI DER
// is a fixed 44 bytes (12-byte header + 32-byte key), so the raw key is the trailing 32 bytes.
function rawPublicKeyB64(pubKey) {
  const der = pubKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64');
}

function keygen() {
  if (fs.existsSync(PRIV_PEM)) {
    console.error(`Refusing to overwrite existing key at ${PRIV_PEM}\n` +
                  `(delete it deliberately only if you accept breaking updates for installed clients).`);
    process.exit(1);
  }
  fs.mkdirSync(SPARKLE_DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(PRIV_PEM, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const pubB64 = rawPublicKeyB64(publicKey);
  fs.writeFileSync(PUB_TXT, pubB64 + '\n');
  console.log('Generated Ed25519 update-signing keypair:');
  console.log(`  private: ${PRIV_PEM}   (git-ignored — BACK THIS UP; losing it breaks updates)`);
  console.log(`  public : ${PUB_TXT}`);
  console.log('\nEmbed this PUBLIC key in the client build (Info.plist SUPublicEDKey / win_sparkle_set_eddsa_public_key):');
  console.log(`\n  ${pubB64}\n`);
}

function loadKeys() {
  if (!fs.existsSync(PRIV_PEM)) {
    console.error(`No signing key found. Run:  node scripts/client-release.js keygen`);
    process.exit(1);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIV_PEM));
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey };
}

// Ed25519 sign raw bytes → base64, and self-verify so a bad key/format can't slip into a release.
function signBytes(bytes, privateKey, publicKey) {
  const sig = crypto.sign(null, bytes, privateKey);
  if (!crypto.verify(null, bytes, publicKey, sig)) {
    console.error('FATAL: signature failed self-verification — aborting.');
    process.exit(1);
  }
  return sig.toString('base64');
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function buildAppcast({ platform, version, fileName, length, edSig, baseUrl, notes, minOs, pubDate }) {
  const title = platform === 'mac' ? 'SailSim (macOS)' : 'SailSim (Windows)';
  const url = `${baseUrl.replace(/\/+$/, '')}/${fileName}`;
  const minOsTag = minOs ? `\n      <sparkle:minimumSystemVersion>${xmlEscape(minOs)}</sparkle:minimumSystemVersion>` : '';
  const notesTag = notes ? `\n      <description>${xmlEscape(notes)}</description>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${title}</title>
    <item>
      <title>Version ${xmlEscape(version)}</title>${notesTag}
      <pubDate>${pubDate}</pubDate>
      <sparkle:version>${xmlEscape(version)}</sparkle:version>
      <sparkle:shortVersionString>${xmlEscape(version)}</sparkle:shortVersionString>${minOsTag}
      <enclosure url="${xmlEscape(url)}"
                 sparkle:version="${xmlEscape(version)}"
                 sparkle:shortVersionString="${xmlEscape(version)}"
                 sparkle:edSignature="${edSig}"
                 length="${length}"
                 type="application/octet-stream" />
    </item>
  </channel>
</rss>
`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) { console.error(`Unexpected argument: ${argv[i]}`); process.exit(1); }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function publish(argv) {
  const a = parseArgs(argv);
  const platform = a.platform;
  if (platform !== 'mac' && platform !== 'win') { console.error('--platform must be "mac" or "win"'); process.exit(1); }
  if (!a.version) { console.error('--version X.Y.Z is required'); process.exit(1); }
  if (!a.file || !fs.existsSync(a.file)) { console.error(`--file <artifact> is required and must exist (${a.file})`); process.exit(1); }

  const { privateKey, publicKey } = loadKeys();
  fs.mkdirSync(CLIENT_DIR, { recursive: true });

  // Standardised, version-unique name so the artifact can be cached hard (immutable).
  const ext = path.extname(a.file) || '.zip';
  const fileName = `SailSim-${a.version}-${platform}${ext}`;
  const dest = path.join(CLIENT_DIR, fileName);
  fs.copyFileSync(a.file, dest);

  const bytes = fs.readFileSync(dest);
  const edSig = signBytes(bytes, privateKey, publicKey);
  const appcast = buildAppcast({
    platform, version: a.version, fileName, length: bytes.length, edSig,
    baseUrl: a['base-url'] || DEFAULT_BASE_URL, notes: a.notes,
    minOs: a['min-os'] || (platform === 'mac' ? '11.0' : undefined),
    pubDate: new Date().toUTCString(),
  });
  const appcastPath = path.join(CLIENT_DIR, `appcast-${platform}.xml`);
  fs.writeFileSync(appcastPath, appcast);

  console.log(`Published ${platform} v${a.version}:`);
  console.log(`  artifact: ${dest}  (${bytes.length} bytes)`);
  console.log(`  appcast : ${appcastPath}`);
  console.log(`  ed sig  : ${edSig}`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'keygen') return keygen();
  if (cmd === 'publish') return publish(rest);
  console.error('Usage:\n  client-release.js keygen\n  client-release.js publish --platform mac|win --version X.Y.Z --file <artifact> [--base-url URL] [--notes "..."] [--min-os 11.0]');
  process.exit(1);
}

main();
