'use strict';
// Looks for a newer Mjolnir on GitHub. It only tells the user; installing is their choice.
// The "latest" release endpoint skips drafts and pre-releases, so those never show up as updates.

const REPO = 'mprateek14/mjolnir';
const RELEASE_URL_PREFIX = `https://github.com/${REPO}/`;

// "v0.1.12" or "0.1.12-beta" -> [0, 1, 12]
function parse(v) {
  return String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
}

// Positive when a is newer than b, negative when older, 0 when the same.
function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Only addresses inside this project's releases may be opened from an update notice.
const isReleaseUrl = (u) => typeof u === 'string' && u.startsWith(RELEASE_URL_PREFIX);

// Resolves to { current, latest: { version, name, url } | null, newer }. Throws a plain message when GitHub cannot be reached.
async function check(current, fetchImpl = fetch) {
  let r;
  try {
    r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Mjolnir' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new Error('Could not reach GitHub. Check your internet connection.');
  }
  if (r.status === 404) return { current, latest: null, newer: false };   // nothing published yet
  if (!r.ok) throw new Error(`GitHub answered ${r.status}. Try again later.`);
  const j = await r.json();
  const version = String(j.tag_name || '').replace(/^v/i, '');
  if (!version) throw new Error('GitHub sent a release without a version.');
  const url = isReleaseUrl(j.html_url) ? j.html_url : `${RELEASE_URL_PREFIX}releases/latest`;
  return { current, latest: { version, name: j.name || `Mjolnir ${version}`, url }, newer: compare(version, current) > 0 };
}

module.exports = { check, compare, parse, isReleaseUrl, REPO };
