'use strict';

const path = require('path');
const fs   = require('fs');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

/** Derive a human-friendly title from a filename like "drunken_sailor.mid" → "Drunken Sailor" */
function titleFromFilename(filename) {
  return filename
    .replace(/\.mid$/i, '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── GET /music ────────────────────────────────────────────────────────────────
// Returns [{filename, name, url}, …] for every .mid file in assets/

exports.listTracks = (req, res) => {
  let files;
  try {
    files = fs.readdirSync(ASSETS_DIR).filter(f => /\.mid$/i.test(f));
  } catch (err) {
    return res.status(500).json({ error: 'Could not read assets directory', detail: err.message });
  }

  const tracks = files.map(filename => ({
    filename,
    name: titleFromFilename(filename),
    url:  `/music/${encodeURIComponent(filename)}`,
  }));

  res.json(tracks);
};

// ── GET /music/:filename ──────────────────────────────────────────────────────
// Streams the requested .mid file with CORS-safe headers.

exports.streamTrack = (req, res) => {
  const filename = req.params.filename;

  // Safety: disallow path traversal
  if (!filename || /[/\\]/.test(filename) || !/\.mid$/i.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(ASSETS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Track not found' });
  }

  res.setHeader('Content-Type', 'audio/midi');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(filePath).pipe(res);
};
