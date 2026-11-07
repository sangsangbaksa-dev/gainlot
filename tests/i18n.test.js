import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as I from '../i18n.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const LANG_CODES = Object.keys(I.LANGS);
const KO_KEYS = Object.keys(I.DICT.ko).sort();

test('every language has exactly the keys of ko (missing keys fail)', () => {
  for (const l of LANG_CODES) {
    const missing = KO_KEYS.filter((k) => !(k in I.DICT[l]));
    const extra = Object.keys(I.DICT[l]).filter((k) => !(k in I.DICT.ko));
    assert.deepEqual(missing, [], `${l} is missing keys`);
    assert.deepEqual(extra, [], `${l} has keys that ko lacks`);
  }
});

test('every translation is a non-empty string', () => {
  for (const l of LANG_CODES) {
    for (const [k, v] of Object.entries(I.DICT[l])) {
      assert.equal(typeof v, 'string', `${l}.${k}`);
      assert.ok(v.trim().length > 0, `${l}.${k} is empty`);
    }
  }
});

test('placeholders match across languages', () => {
  const slots = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const k of KO_KEYS) {
    for (const l of LANG_CODES) {
      assert.equal(slots(I.DICT[l][k]), slots(I.DICT.ko[k]), `${l}.${k}`);
    }
  }
});

test('no emoji, pictographs or exclamation marks in any language', () => {
  const emoji = /[☀-➿⬀-⯿\u{1F000}-\u{1FAFF}✨]/u;
  for (const l of LANG_CODES) {
    for (const [k, v] of Object.entries(I.DICT[l])) {
      assert.doesNotMatch(v, emoji, `${l}.${k} contains an emoji or symbol`);
      assert.doesNotMatch(v, /[!！]/, `${l}.${k} contains an exclamation mark`);
    }
  }
});

test('every t() literal and data-i18n key used in the source exists in the dictionary', () => {
  const used = new Set();
  for (const f of ['logic.js', 'app.js', 'ai.js']) {
    for (const m of read(f).matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*[,)]/g)) used.add(m[1]);
  }
  const html = read('index.html');
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) used.add(pair.split('=')[1]);
  }
  const missing = [...used].filter((k) => !(k in I.DICT.ko));
  assert.deepEqual(missing, [], 'keys used in the source but not in the dictionary');
});

test('t interpolates, falls back to ko and shows missing keys visibly', () => {
  I.setLang('ja');
  assert.match(I.t('wonAmt', { n: '1,000' }), /1,000/);
  assert.equal(I.t('nope_key'), 'missing:nope_key');
  I.setLang('ko');
  assert.equal(I.t('deleteBtn'), '삭제');
});

test('detectLang: saved choice, then browser language, then Korean', () => {
  assert.equal(I.detectLang('ja', ['ko']), 'ja');
  assert.equal(I.detectLang(null, ['fr-FR', 'es-MX']), 'es');
  assert.equal(I.detectLang(null, ['zh-TW']), 'zh');
  assert.equal(I.detectLang(null, ['de']), 'ko');
  assert.equal(I.detectLang('xx', ['en-US']), 'en');
  assert.equal(I.detectLang(null, []), 'ko');
});

test('setLang ignores unknown codes and stays on the default', () => {
  I.setLang('fr');
  assert.equal(I.getLang(), 'ko');
});
