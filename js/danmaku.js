// 弹幕：按片名在 360 影视找到同一部作品在腾讯视频 / 爱奇艺 / 芒果 TV 的对应集，取那一集的公开弹幕。
// Comments are fetched from the platforms' public, unauthenticated endpoints: Tencent and iQiyi
// directly (they allow cross-origin reads), Mango TV through the site's proxy. Youku and
// Bilibili are not used: Youku needs signed requests and 360 rarely lists Bilibili.
(() => {
    const SEARCH_URL = 'https://api.so.360kan.com/index?force_v=1&from=&pageno=1&v_ap=1&tab=all&kw=';
    const SITE_NAMES = { qq: '腾讯视频', qiyi: '爱奇艺', imgo: '芒果TV' };
    const SITE_ORDER = ['qq', 'qiyi', 'imgo'];
    const CATEGORY = { 1: 'movie', 2: 'tv', 3: 'variety', 4: 'anime' };
    const CONCURRENCY = 8;
    const MAX_TEXT = 40;
    const ENOUGH = 100; // comments that make a platform worth stopping at

    const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
        .replace(/<[^>]+>/g, '').replace(/[\s·・:：,，.。!！?？'"“”‘’《》「」【】()（）\-—_]+/g, '');
    const yearOf = value => Number(String(value || '').match(/(?:19|20)\d{2}/)?.[0] || 0);

    // The 360 row for this title: same normalized title (or one containing the other with the same
    // year), a compatible category, and the release year within one year when both are known.
    function pickRow(rows, { title, year, kind }) {
        const want = normalize(title);
        const wantYear = yearOf(year);
        let best = null;
        for (const row of Array.isArray(rows) ? rows : []) {
            const name = normalize(row?.titleTxt || row?.title);
            if (!name || !want) continue;
            const category = CATEGORY[row.cat_id] || '';
            if (kind === 'movie' && !['movie', 'anime'].includes(category)) continue;
            if (kind === 'tv' && category === 'movie') continue;
            const rowYear = yearOf(row.year);
            const yearOk = !wantYear || !rowYear || Math.abs(wantYear - rowYear) <= 1;
            let score = 0;
            if (name === want && yearOk) score = 3;
            else if ((name.includes(want) || want.includes(name)) && wantYear && rowYear && Math.abs(wantYear - rowYear) <= 1 && Math.min(name.length, want.length) >= 2) score = 2;
            if (!score) continue;
            if (sourceFor(row, 0)) score += 0.5;
            if (!best || score > best.score) best = { row, score };
        }
        return best?.row || null;
    }

    // Play pages on supported platforms for the given episode (0-based), best first. Series list one
    // platform per episode; films may be on several, tried in turn until one has comments.
    function sourcesFor(row, index) {
        const series = Array.isArray(row?.seriesPlaylinks) ? row.seriesPlaylinks : [];
        if (series.length) {
            const item = series[index];
            const parsed = parseSourceUrl(typeof item === 'string' ? item : item?.url);
            return parsed ? [parsed] : [];
        }
        if (index > 0) return [];
        const links = row?.playlinks || {};
        return SITE_ORDER.map(site => links[site] && parseSourceUrl(links[site])).filter(Boolean);
    }

    const sourceFor = (row, index) => sourcesFor(row, index)[0] || null;

    function parseSourceUrl(url) {
        const text = String(url || '');
        let match = text.match(/v\.qq\.com\/x\/(?:cover\/[^/?#]+|page)\/([a-z0-9]+)\.html/i);
        if (match) return { site: 'qq', vid: match[1] };
        match = text.match(/iqiyi\.com\/v_([a-z0-9]+)\.html/i);
        if (match) return { site: 'qiyi', id: match[1] };
        match = text.match(/mgtv\.com\/b\/(\d+)\/(\d+)\.html/i);
        if (match) return { site: 'imgo', cid: match[1], vid: match[2] };
        return null;
    }

    // Busy scenes carry dozens of comments a second: keep the most liked ones, at most `perSecond`
    // in each second, drop very long ones and repeats of the same text close together.
    function thin(comments, perSecond) {
        const buckets = new Map();
        for (const item of comments) {
            const text = String(item.text || '').trim();
            if (!text || text.length > MAX_TEXT || !Number.isFinite(item.time) || item.time < 0) continue;
            const second = Math.floor(item.time);
            if (!buckets.has(second)) buckets.set(second, []);
            buckets.get(second).push({ ...item, text });
        }
        const recent = new Map();
        const result = [];
        for (const second of [...buckets.keys()].sort((a, b) => a - b)) {
            const picked = buckets.get(second).sort((a, b) => (b.likes || 0) - (a.likes || 0));
            let kept = 0;
            for (const item of picked) {
                if (kept >= perSecond) break;
                const key = normalize(item.text);
                if (recent.has(key) && second - recent.get(key) < 10) continue;
                recent.set(key, second);
                result.push({ text: item.text, time: item.time, color: item.color, mode: 0 });
                kept++;
            }
        }
        return result;
    }

    function color(value) {
        const hex = String(value || '').replace(/^#/, '').toLowerCase();
        return /^[0-9a-f]{6}$/.test(hex) && hex !== 'ffffff' ? `#${hex}` : undefined;
    }

    function parseIqiyiXml(text) {
        const items = [];
        for (const block of String(text).split('<bulletInfo>').slice(1)) {
            const field = name => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
            const content = field('content').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
            items.push({ text: content, time: Number(field('showTime')), color: color(field('color')), likes: Number(field('likeCount')) || 0 });
        }
        return items;
    }

    // Runs tasks a few at a time; onEach receives every result as it arrives.
    async function pool(tasks, limit, signal, onEach) {
        const results = new Array(tasks.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
            while (next < tasks.length) {
                if (signal?.aborted) return;
                const index = next++;
                try { results[index] = await tasks[index](); } catch { results[index] = null; }
                if (results[index]) onEach?.(results[index]);
            }
        }));
        return results;
    }

    // Segment start times in the order to fetch them: nearest to where playback is first.
    function nearestFirst(starts, from) {
        return starts.map((start, index) => ({ start, index }))
            .sort((a, b) => Math.abs(a.start - from) - Math.abs(b.start - from) || a.start - b.start)
            .map(item => item.index);
    }

    async function getJson(url, signal) {
        const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    const qqItems = page => (page?.barrage_list || []).map(item => {
        let style = {};
        try { style = JSON.parse(item.content_style || '{}') || {}; } catch { style = {}; }
        return { text: item.content, time: Number(item.time_offset) / 1000, color: color(style.color), likes: Number(item.up_count) || 0 };
    });

    async function loadQq({ vid }, { signal, from, onItems }) {
        const base = await getJson(`https://dm.video.qq.com/barrage/base/${vid}`, signal);
        const segments = Object.values(base?.segment_index || {}).sort((a, b) => Number(a.segment_start) - Number(b.segment_start));
        const order = nearestFirst(segments.map(segment => Number(segment.segment_start) / 1000), from);
        const pages = await pool(order.map(i => () => getJson(`https://dm.video.qq.com/barrage/segment/${vid}/${segments[i].segment_name}`, signal).then(qqItems)), CONCURRENCY, signal, onItems);
        return pages.flat().filter(Boolean);
    }

    async function loadQiyi({ id }, { signal, duration, from, onItems }) {
        const response = await fetch(`https://pcw-api.iq.com/api/decode/${id}?platformId=3&modeCode=intl&langCode=sg`, { signal, credentials: 'omit' });
        // Keep the id as text: some exceed the safe integer range of JSON numbers.
        const tvid = (await response.text()).match(/"data"\s*:\s*"?(\d{5,})/)?.[1];
        if (!tvid) return [];
        const files = Math.max(1, Math.ceil((duration || 7200) / 300));
        const path = `https://cmts.iqiyi.com/bullet/${tvid.slice(-4, -2)}/${tvid.slice(-2)}/${tvid}_300_`;
        const order = nearestFirst(Array.from({ length: files }, (_, i) => i * 300), from);
        const pages = await pool(order.map(i => async () => {
            const file = await fetch(`${path}${i + 1}.z`, { signal, credentials: 'omit' });
            if (!file.ok) return [];
            const stream = file.body.pipeThrough(new DecompressionStream('deflate'));
            return parseIqiyiXml(await new Response(stream).text());
        }), CONCURRENCY, signal, onItems);
        return pages.flat().filter(Boolean);
    }

    async function loadMgtv({ cid, vid }, { signal, duration, from, onItems }) {
        const minutes = Math.max(1, Math.ceil((duration || 7200) / 60));
        const order = nearestFirst(Array.from({ length: minutes }, (_, i) => i * 60), from);
        const pages = await pool(order.map(i => () => window.fetchVodApiJson(
            `https://galaxy.bz.mgtv.com/rdbarrage?version=3.0.0&vid=${vid}&abroad=0&pid=0&os&uuid&deviceid&cid=${cid}&ticket&time=${i * 60000}&mac&platform=0`,
            API_CONFIG.search.headers, signal).then(page => (page?.data?.items || []).map(item => ({
            text: item.content, time: Number(item.time) / 1000, likes: Number(item.up) || 0
        })))), CONCURRENCY, signal, onItems);
        return pages.flat().filter(Boolean);
    }

    const LOADERS = { qq: loadQq, qiyi: loadQiyi, imgo: loadMgtv };

    // 360 search results per title, kept for the session: every episode of a series needs the same
    // rows, and the search sometimes answers with no rows at all, so empty answers are retried.
    const searches = new Map();
    async function searchRows(title, signal) {
        const key = normalize(title);
        if (searches.has(key)) return searches.get(key);
        let rows = [];
        for (let attempt = 0; attempt < 3 && !rows.length; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
            if (signal?.aborted) return [];
            const found = (await getJson(SEARCH_URL + encodeURIComponent(title), signal).catch(() => null))?.data?.longData?.rows;
            rows = Array.isArray(found) ? found : [];
        }
        if (rows.length) searches.set(key, rows);
        return rows;
    }

    // Find and load the comments of one episode. Resolves { raw, site, siteName, matched } or null;
    // `thin` picks what is shown, so a density change needs no new download. onPartial gets the same
    // shape while segments are still arriving (those near `from`, the playback position, come first).
    async function load({ title, year, kind, index = 0, duration = 0, from = 0, signal, onPartial }) {
        if (!title || typeof DecompressionStream === 'undefined') return null;
        const row = pickRow(await searchRows(title, signal), { title, year, kind });
        if (!row) return null;
        // A platform with only a handful of comments is not enough: try the next and keep the fullest.
        let best = null;
        for (const source of sourcesFor(row, index)) {
            const meta = { site: source.site, siteName: SITE_NAMES[source.site], matched: row.titleTxt };
            const partial = [];
            const onItems = items => {
                partial.push(...items);
                if (partial.length && !best) onPartial?.({ ...meta, raw: partial.slice() });
            };
            const raw = await LOADERS[source.site](source, { signal, duration, from, onItems }).catch(() => []);
            if (signal?.aborted) return null;
            if (raw.length > (best?.raw.length || 0)) best = { ...meta, raw };
            if (raw.length >= ENOUGH) break;
        }
        return best;
    }

    window.Danmaku = { load, thin, SITE_NAMES, logic: { normalize, pickRow, sourceFor, sourcesFor, parseSourceUrl, thin, parseIqiyiXml, color, nearestFirst } };
})();
