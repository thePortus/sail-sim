/**
 * Profanity filter — server-authoritative. The word list is SOURCED from the maintained external package
 * `profane-words` (https://github.com/zautumnz/profane-words — a lowercased array), NOT a list we
 * hand-maintain, and it's pulled in via npm so it's built into the image at `npm install` (the pipeline).
 * Update the list by bumping the dependency.
 *
 * Two uses:
 *   • hasProfanity(text) — HARD BLOCK, always enforced: reject profane usernames / callsigns / ship names
 *     at the moment they're set. Users can NEVER register/keep a profane name.
 *   • maskText(text)     — CHAT display filter: replace profane words with **** for players who keep the
 *     (default-on) filter on; the raw text is shown to players who opt out.
 *
 * Matching is WHOLE-WORD, case-insensitive, with light leet-normalization (@→a, $→s, 0→o, 3→e, 1→i, …) and
 * edge/embedded punctuation stripped per token — so "damn!", "sh1t" and "@ss" match, but "assassin" does NOT
 * match "ass" (avoids the Scunthorpe false-positive problem). Determined letter-spacing evasion ("f u c k")
 * is not caught; this is a best-effort filter, not a guarantee.
 */
'use strict';

let WORDS = [];
try { WORDS = require('profane-words/words.json'); }        // plain JSON array — CJS-safe
catch (e1) { try { WORDS = require('profane-words'); } catch (e2) { WORDS = []; } }
if (!Array.isArray(WORDS)) { WORDS = []; }

const SET = new Set(WORDS.map((w) => String(w).toLowerCase()));

/** Normalize a single token for matching: lowercase, undo common leet substitutions, strip non-letters. */
function norm(tok) {
  return String(tok).toLowerCase()
    .replace(/[@4]/g, 'a').replace(/[$5]/g, 's').replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
}

/** True if a single whitespace-delimited token is a profane word. */
function tokenProfane(tok) {
  const w = norm(tok);
  return w.length > 0 && SET.has(w);
}

/** True if ANY whole word in `text` is profane. Use to REJECT usernames / callsigns / ship names. */
function hasProfanity(text) {
  if (typeof text !== 'string' || !SET.size) { return false; }
  return text.split(/\s+/).some(tokenProfane);
}

/** Replace each profane whole word in `text` with asterisks (same length). Use for the CHAT display filter. */
function maskText(text) {
  if (typeof text !== 'string' || !SET.size) { return text; }
  return text.replace(/\S+/g, (tok) => (tokenProfane(tok) ? '*'.repeat(tok.length) : tok));
}

module.exports = { hasProfanity, maskText, size: SET.size };
