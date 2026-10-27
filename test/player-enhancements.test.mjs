import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

async function setup(storageValues = {}) {
  const values = new Map(Object.entries(storageValues));
  const localStorage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value))
  };
  const sandbox = { window: { localStorage }, console };
  vm.runInNewContext(await read('js/player-enhancements.js'), sandbox);
  return { api: sandbox.window.PlayerEnhancements, values, localStorage };
}

test('episode labels hide redundant numbering but keep meaningful names', async () => {
  const { api } = await setup();
  const plain = (index, name) => ({ ...api.episodeLabel(index, name) });
  assert.deepEqual(plain(0, '第01集'), { number: 1, title: '' });
  assert.deepEqual(plain(4, 'EP05'), { number: 5, title: '' });
  assert.deepEqual(plain(9, '10'), { number: 10, title: '' });
  assert.deepEqual(plain(2, ''), { number: 3, title: '' });
  assert.deepEqual(plain(2, '20241003期：嘉宾特辑'), { number: 3, title: '20241003期：嘉宾特辑' });
  // A number that does not match the position is real information.
  assert.deepEqual(plain(0, '第2集'), { number: 1, title: '第2集' });
  assert.deepEqual(plain(0, 'HD国语'), { number: 1, title: 'HD国语' });
});

test('only an autoplay-policy rejection mutes playback', async () => {
  const { api } = await setup();
  assert.equal(api.shouldMuteAfterPlayRejection({ name: 'NotAllowedError' }), true);
  // Fast episode switching interrupts play() with AbortError; that must not mute.
  assert.equal(api.shouldMuteAfterPlayRejection({ name: 'AbortError' }), false);
  assert.equal(api.shouldMuteAfterPlayRejection(undefined), false);

  const player = await read('js/player.js');
  const start = player.indexOf('function tryStartPlayback');
  const body = player.slice(start, player.indexOf('\n}\n', start));
  assert.ok(body.indexOf('shouldMuteAfterPlayRejection(error)') > 0);
  assert.ok(body.indexOf('shouldMuteAfterPlayRejection(error)') < body.indexOf('art.muted = true'));
});

test('keyboard seeking clamps to the start and end of the video', async () => {
  const { api } = await setup();
  assert.equal(api.clampSeek(3, -5, 60), 0);
  assert.equal(api.clampSeek(30, -5, 60), 25);
  assert.equal(api.clampSeek(58, 5, 60), 59.5);
  assert.equal(api.clampSeek(10, 5, NaN), 15);
});

test('playback speed is remembered and only accepts offered rates', async () => {
  const { api, values, localStorage } = await setup();
  assert.equal(api.readStoredRate(localStorage), 1);
  api.storeRate(1.5, localStorage);
  assert.equal(values.get('libretvPlaybackRate'), '1.5');
  assert.equal(api.readStoredRate(localStorage), 1.5);
  api.storeRate(7, localStorage);
  assert.equal(api.readStoredRate(localStorage), 1.5);
  assert.equal(api.rateLabel(1), '倍速');
  assert.equal(api.rateLabel(1.25), '1.25x');

  const corrupt = await setup({ libretvPlaybackRate: 'fast' });
  assert.equal(corrupt.api.readStoredRate(corrupt.localStorage), 1);
});

test('next-episode countdown appears only in the last seconds of real episodes', async () => {
  const { api } = await setup();
  assert.equal(api.nextCardThreshold(2700), 10);
  assert.equal(api.nextCardThreshold(60), 9);
  assert.equal(api.nextCardThreshold(20), 0);
  assert.equal(api.nextCardThreshold(NaN), 0);
});

test('player wires the drawer, speed control and countdown into the player', async () => {
  const player = await read('js/player.js');
  const playerHtml = await read('player.html');
  const sw = await read('service-worker.js');
  const mobile = await read('js/mobile-fullscreen.js');

  assert.ok(playerHtml.indexOf('js/player-enhancements.js') < playerHtml.indexOf('js/player.js'));
  assert.match(sw, /'\/js\/player-enhancements\.js'/);
  assert.match(player, /name: 'episodes'/);
  assert.match(player, /name: 'playback-rate'/);
  assert.match(player, /createEpisodeDrawer\(/);
  assert.match(player, /createNextEpisodeCard\(/);
  // Cancelling the countdown stops the automatic next episode.
  assert.match(player, /autoplayEnabled && !nextEpisodeCard\?\.dismissed/);
  // The temporary long-press 3x speed and the browser's reset on load are not remembered.
  assert.match(player, /!temporaryRateActive && art\.video\.readyState >= 1/);
  // Touch: single tap toggles controls, double tap plays/pauses.
  assert.match(player, /toggleControlsFromTap/);
  assert.match(mobile, /mobile-fullscreen-episodes/);
});
