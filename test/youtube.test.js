'use strict';
// Offline checks for the parts of the YouTube downloader that do not need yt-dlp or the network.
const assert = require('assert');
const { normalize, buildArgs, parseLine, friendly } = require('../src/downloaders/youtube/ytdlp');

// playlist listing: numbering, private videos disabled, total time
const list = normalize({
  _type: 'playlist', id: 'PLx', title: 'My list', uploader: 'Me',
  entries: [
    { id: 'aaaaaaaaaaa', title: 'One', duration: 60 },
    { id: 'bbbbbbbbbbb', title: '[Private video]', duration: 0 },
    null,
    { id: 'ccccccccccc', title: 'Three', duration: 90 },
  ],
}, 'https://www.youtube.com/playlist?list=PLx');
assert.strictEqual(list.kind, 'playlist');
assert.strictEqual(list.count, 3);
assert.deepStrictEqual(list.entries.map((e) => e.index), [1, 2, 3]);
assert.strictEqual(list.entries[1].unavailable, true);
assert.strictEqual(list.entries[0].unavailable, false);
assert.strictEqual(list.duration, 150);
assert(list.thumbnail.includes('aaaaaaaaaaa'));
console.log('ok  playlist listing numbers videos and disables private ones');

// file names: number prefix, quality tag, repeat suffix
const arg = (a, flag) => a[a.indexOf(flag) + 1];
let a = buildArgs({ mode: 'video', height: 1080, container: 'compat', prefix: '07 - ', suffix: ' (1)' }, { dir: 'D:/x', cookiesFrom: '' });
assert.strictEqual(arg(a, '-o'), '07 - %(title).150B [%(height)sp] (1).%(ext)s');
assert.strictEqual(arg(a, '-P'), 'D:/x');
assert(arg(a, '-f').includes('height<=1080'));
a = buildArgs({ mode: 'video', height: 0, container: 'best', formatId: '399', audioId: '251' }, { dir: 'd', cookiesFrom: 'chrome' });
assert(arg(a, '-f').startsWith('399+251/'));
assert.strictEqual(arg(a, '--merge-output-format'), 'mkv');
assert.strictEqual(arg(a, '--cookies-from-browser'), 'chrome');
a = buildArgs({ mode: 'audio', audioFormat: 'mp3' }, { dir: 'd', cookiesFrom: '' });
assert.strictEqual(arg(a, '-o'), '%(title).150B.%(ext)s');
console.log('ok  command lines: names, exact formats, containers, cookies');

// progress lines and the real file path (JSON keeps look-alike characters intact)
const events = [];
const st = { stream: '', finished: 0, lastTotal: 0, files: [] };
const on = { progress: (p) => events.push(p), file: (f) => events.push(f), stage: (s) => events.push(s) };
parseLine('SGP|downloading|1000|4000|NA|500|6|137|NA|NA', st, on);
parseLine('SGP|downloading|2000|4000|NA|500|4|137|NA|NA', st, on);
parseLine('SGP|downloading|100|900|NA|50|3|140|NA|NA', st, on);      // audio starts: the video bytes are folded in
parseLine('SGPP|started|Merger', st, on);
parseLine('SGDONE|' + JSON.stringify('C:\\v\\\uff02Quote\uff02 [144p].mp4'), st, on);
assert.strictEqual(events[0].done, 1000);
assert.strictEqual(events[2].finished, 4000);
assert.strictEqual(events[2].done, 4100);
assert.strictEqual(events[3], 'merging');
assert.strictEqual(events[4], 'C:\\v\\\uff02Quote\uff02 [144p].mp4');
console.log('ok  progress, stages and unicode file paths are read correctly');

assert(/sign-in|signed-in/i.test(friendly('ERROR: [youtube] x: Sign in to confirm you\u2019re not a bot')));
assert(/private/i.test(friendly('ERROR: [youtube] x: Private video. Sign in if you\u2019ve been granted access')));
console.log('ok  errors are translated');
console.log('all passed');
