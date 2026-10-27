import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)), values };
}

async function loadAvailability({ responses = {}, storage = memoryStorage({ selectedAPIs: JSON.stringify(['a', 'b']) }) } = {}) {
  const calls = [];
  const sandbox = {
    console, URL, setTimeout, localStorage: storage,
    API_CONFIG: { search: { path: '?wd=' } },
    window: {
      DEFAULT_SELECTED_APIS: ['a', 'b'],
      API_SITES: { a: { api: 'https://a.example' }, b: { api: 'https://b.example' } },
      getApiSearchContext: id => ({ apiBaseUrl: `https://${id}.example` }),
      fetchVodApiJson: async url => {
        calls.push(url);
        const host = new URL(url).hostname.split('.')[0];
        const answer = responses[host];
        if (answer instanceof Error) throw answer;
        return answer ?? { list: [] };
      }
    }
  };
  sandbox.window.localStorage = storage;
  vm.runInNewContext(await read('js/source-availability.js'), sandbox);
  return { api: sandbox.window.SourceAvailability, calls, storage };
}

const m3u8 = n => Array.from({ length: n }, (_, i) => `第${i + 1}集$https://cdn.example/${i}/index.m3u8`).join('#');

test('a Douban title counts as available only for a matching playable copy', async () => {
  const { api } = await loadAvailability();
  const film = { title: '隔山有眼3：起源', year: '2026', kind: 'movie' };
  assert.equal(api.isPlayableMatch({ vod_name: '隔山有眼3:起源', vod_year: '2026', type_name: '恐怖片', vod_play_url: m3u8(1) }, film), true);
  // A neighbouring release year is the same film (festival vs. theatrical release).
  assert.equal(api.isPlayableMatch({ vod_name: '旷野', vod_year: '2025', type_name: '剧情片', vod_play_url: m3u8(1) }, { title: '旷野', year: '2026', kind: 'movie' }), true);
  assert.equal(api.isPlayableMatch({ vod_name: '一九八四', vod_year: '1956', type_name: '科幻片', vod_play_url: m3u8(1) }, { title: '一九八四', year: '2026', kind: 'movie' }), false);
  // A 60-episode short drama with the same name is not the film.
  assert.equal(api.isPlayableMatch({ vod_name: '旷野', vod_year: '2026', type_name: '现代都市', vod_play_url: m3u8(60) }, { title: '旷野', year: '2026', kind: 'movie' }), false);
  assert.equal(api.isPlayableMatch({ vod_name: '旷野', vod_year: '2026', type_name: '短剧', vod_play_url: m3u8(1) }, { title: '旷野', year: '2026', kind: 'movie' }), false);
  assert.equal(api.isPlayableMatch({ vod_name: '某剧', vod_year: '2026', type_name: '剧情片', vod_play_url: m3u8(1) }, { title: '某剧', kind: 'tv' }), false);
  assert.equal(api.isPlayableMatch({ vod_name: '某剧', vod_year: '2026', type_name: '国产剧', vod_play_url: m3u8(30) }, { title: '某剧', kind: 'tv' }), true);
  // Web-page links in the first line, m3u8 in the second.
  const twoLines = '正片$https://vv.example/play/abc$$$正片$https://vv.example/play/abc/index.m3u8';
  assert.equal(api.isPlayableMatch({ vod_name: '它渴求梦魇', vod_year: '2026', type_name: '恐怖片', vod_play_url: twoLines }, { title: '它渴求梦魇', year: '2026', kind: 'movie' }), true);
  assert.equal(api.isPlayableMatch({ vod_name: '它渴求梦魇', vod_year: '2026', type_name: '恐怖片', vod_play_url: '正片$https://vv.example/play/abc' }, { title: '它渴求梦魇', kind: 'movie' }), false);
  assert.equal(api.isPlayableMatch({ vod_name: '三体', type_name: '电影解说', vod_play_url: m3u8(1) }, { title: '三体', kind: 'movie' }), false);
});

test('availability checks stop at the first source that has it and are cached', async () => {
  const found = { list: [{ vod_name: '复仇深潜', vod_year: '2026', type_name: '动作片', vod_play_url: m3u8(1) }] };
  const { api, calls } = await loadAvailability({ responses: { a: found } });
  assert.equal(await api.check({ title: '复仇深潜', year: '2026', kind: 'movie' }), true);
  assert.equal(calls.length, 1);
  assert.equal(await api.check({ title: '复仇深潜', year: '2026', kind: 'movie' }), true);
  assert.equal(calls.length, 1, 'second check is served from the cache');

  assert.equal(await api.check({ title: '一九八四', year: '2026', kind: 'movie' }), false);
  assert.equal(calls.length, 3, 'a missing title asks every selected source');

  const down = await loadAvailability({ responses: { a: new Error('down'), b: new Error('down') } });
  assert.equal(await down.api.check({ title: '某片', kind: 'movie' }), null, 'unknown when no source answered');
  assert.equal(down.storage.values.has('sourceAvailabilityV1'), false, 'unknown results are not cached');

  const skipped = await loadAvailability();
  assert.equal(await skipped.api.check({ title: '某片', kind: 'movie', isWanted: () => false }), null);
  assert.equal(skipped.calls.length, 0, 'cards that are gone are not searched');
});

test('player discovery shows Douban data and hides unverified ratings', async () => {
  const sandbox = { window: {}, console, URL };
  vm.runInNewContext(await read('js/player-recommendations.js'), sandbox);
  const { doubanId, doubanScore } = sandbox.window.PlayerRecommendations.logic;
  assert.equal(doubanId({ vod_douban_id: 25853071 }), 25853071);
  assert.equal(doubanId({ vod_douban_id: 0 }), 0);
  assert.equal(doubanScore({ vod_douban_id: 25853071, vod_douban_score: '7.9' }), 7.9);
  // A source's own score without a Douban entry is not shown.
  assert.equal(doubanScore({ vod_douban_id: 0, vod_douban_score: '0.0', vod_score: '10.0' }), 0);
  assert.equal(doubanScore({ doubanId: 1, doubanScore: '8.1' }), 8.1);

  const api = await read('js/api.js');
  assert.match(api, /doubanId: Number\(videoDetail\.vod_douban_id\) > 0/);
  const recommendations = await read('js/player-recommendations.js');
  assert.match(recommendations, /rexxar\/api\/v2\/\$\{type\}\/\$\{id\}/);
  assert.match(recommendations, /SourceAvailability\.check/);
});

test('player page header, layout and error overlay', async () => {
  const html = await read('player.html');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(header, /class="lt-brand-mark"/);
  assert.match(header, /onsubmit="return submitPlayerSearch\(event\)"/);
  assert.match(header, /id="goBack"/);
  assert.ok(html.indexOf('js/source-availability.js') < html.indexOf('js/player-recommendations.js'));
  const css = await read('css/player.css');
  assert.match(css, /#playerContainer:has\(#error\[style\*="display: flex"\]\) \.art-loading/);
  assert.match(css, /\.player-stage\.has-side-episodes ~ #resourceInfoBarContainer #quickEpisodesButton \{ display: none; \}/);
  // The compact mobile error rules must come after the base rules to take effect.
  assert.ok(css.indexOf('.error-icon { font-size: 26px') > css.indexOf('.error-icon {\n    font-size: 48px'));
  const player = await read('js/player.js');
  assert.match(player, /window\.location\.href = `\/\?s=\$\{encodeURIComponent\(query\)\}`/);
  const index = await read('index.html');
  assert.match(index, /<script src="js\/source-availability\.js"><\/script>/);
  assert.match(await read('service-worker.js'), /'\/js\/source-availability\.js'/);
});
