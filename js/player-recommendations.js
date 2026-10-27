// Optional discovery content below playback. None of these requests block video startup.
(() => {
    let activeKey = '';
    let activeRequest = null;
    const text = value => String(value ?? '').trim();
    const normalizeTitle = value => text(value).normalize('NFKC').toLowerCase().replace(/[\s·:：]+/g, '');

    // ---- 豆瓣信息：资源站自带 vod_douban_id / vod_douban_score；只有封面挂了才按 ID 取一次豆瓣海报 ----
    const POSTER_CACHE_KEY = 'doubanPosterCacheV1';
    const POSTER_CACHE_LIMIT = 300;
    const posterRequests = new Map();
    const posterQueue = [];
    let postersInFlight = 0;

    function doubanId(item) {
        const id = Number(item?.vod_douban_id ?? item?.doubanId);
        return Number.isInteger(id) && id > 0 ? id : 0;
    }

    // Only scores tied to a Douban entry are shown; sources' own vod_score values are unreliable.
    function doubanScore(item) {
        if (!doubanId(item)) return 0;
        const score = Number.parseFloat(item?.vod_douban_score ?? item?.doubanScore);
        return score > 0 && score <= 10 ? score : 0;
    }

    function readPosterCache() {
        try { return JSON.parse(localStorage.getItem(POSTER_CACHE_KEY) || '{}') || {}; } catch { return {}; }
    }

    function writePosterCache(id, url) {
        try {
            const cache = readPosterCache();
            delete cache[id];
            cache[id] = url;
            const keys = Object.keys(cache);
            for (const key of keys.slice(0, Math.max(0, keys.length - POSTER_CACHE_LIMIT))) delete cache[key];
            localStorage.setItem(POSTER_CACHE_KEY, JSON.stringify(cache));
        } catch { /* storage full or blocked */ }
    }

    function runPosterQueue() {
        while (postersInFlight < 2 && posterQueue.length) {
            const job = posterQueue.shift();
            postersInFlight++;
            job().finally(() => { postersInFlight--; runPosterQueue(); });
        }
    }

    function doubanPoster(id, kind) {
        const cached = readPosterCache()[id];
        if (cached) return Promise.resolve(cached);
        if (!posterRequests.has(id)) {
            posterRequests.set(id, new Promise(resolve => {
                posterQueue.push(async () => {
                    let url = '';
                    for (const type of kind === 'movie' ? ['movie', 'tv'] : ['tv', 'movie']) {
                        try {
                            const data = await window.fetchVodApiJson(`https://m.douban.com/rexxar/api/v2/${type}/${id}`, API_CONFIG.search.headers);
                            url = text(data?.pic?.large || data?.pic?.normal || data?.cover_url);
                            if (url) break;
                        } catch { /* wrong subject type or blocked: try the other one */ }
                    }
                    if (url) writePosterCache(id, url);
                    resolve(url);
                });
                runPosterQueue();
            }));
        }
        return posterRequests.get(id);
    }

    // Poster chain: source covers → (optional) covers of the same title from other sources →
    // Douban poster by ID → the Douban poster through the proxy → placeholder.
    function loadPoster(image, { title, covers = [], moreCovers = null, item = null, kind = '' }) {
        const queue = covers.filter(Boolean);
        let stage = 'covers';
        let doubanUrl = '';
        const advance = async () => {
            if (!queue.length && stage === 'covers' && moreCovers) {
                stage = 'more';
                queue.push(...(await moreCovers().catch(() => [])).filter(Boolean));
            }
            if (queue.length) { image.src = queue.shift(); return; }
            if (stage === 'covers' || stage === 'more') {
                stage = 'douban';
                const id = doubanId(item);
                doubanUrl = id ? await doubanPoster(id, kind) : '';
                if (doubanUrl) { image.src = doubanUrl; return; }
            }
            if (stage === 'douban' && doubanUrl) {
                stage = 'proxy';
                const proxied = PROXY_URL + encodeURIComponent(doubanUrl);
                image.src = window.ProxyAuth?.addAuthToProxyUrl ? await window.ProxyAuth.addAuthToProxyUrl(proxied) : proxied;
                return;
            }
            image.onerror = null;
            window.setImagePlaceholder(image, title);
        };
        image.onerror = () => { void advance(); };
        void advance();
    }

    function card(item, kind) {
        const title = text(item.vod_name || item.title);
        const year = window.LibreExperience.year(item.vod_year || item.year);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'player-recommendation-card';
        button.setAttribute('aria-label', `播放${title}${year ? `，${year}年` : ''}`);
        const image = document.createElement('img');
        const sourceUrl = item.api_url || window.API_SITES?.[item.source_code]?.api || '';
        const cover = window.normalizeImageUrl(item.vod_pic || item.cover, sourceUrl);
        image.loading = 'lazy';
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        loadPoster(image, { title, covers: [cover], item, kind });
        const poster = document.createElement('span');
        poster.className = 'player-recommendation-poster';
        poster.appendChild(image);
        const score = doubanScore(item);
        if (score) {
            const rating = document.createElement('span');
            rating.className = 'player-recommendation-rating';
            rating.textContent = `★ ${score.toFixed(1)}`;
            rating.title = '豆瓣评分';
            poster.appendChild(rating);
        }
        const name = document.createElement('strong');
        name.textContent = title;
        const caption = document.createElement('small');
        caption.textContent = [year, item.source_name || (item.source_code ? window.API_SITES?.[item.source_code]?.name : '热门推荐')].filter(Boolean).join(' · ');
        button.append(poster, name, caption);
        button.onclick = () => window.QuickPlay.open({title, year, kind, source:item.source_code || '', id:item.vod_id || ''});
        // 豆瓣热门条目不一定有播放源：确认所有已选源都没有时移除，免得点进去找不到资源
        if (!item.source_code && window.SourceAvailability) {
            window.SourceAvailability.check({ title, year, kind, isWanted: () => button.isConnected })
                .then(available => { if (available === false) button.remove(); });
        }
        return button;
    }

    function renderCards(target, items, kind) {
        target.replaceChildren(...items.map(item => card(item, kind)));
    }

    function renderSynopsis(info, fallbackTitle, source, { kind = '', moreCovers = null } = {}) {
        const target = document.getElementById('playerSynopsis');
        if (!target) return;
        target.replaceChildren();
        const layout = document.createElement('div');
        layout.className = 'player-synopsis-layout';
        if (info.cover || doubanId(info)) {
            const cover = document.createElement('img');
            cover.className = 'player-synopsis-cover';
            cover.alt = '';
            cover.referrerPolicy = 'no-referrer';
            loadPoster(cover, {
                title: fallbackTitle,
                covers: [window.normalizeImageUrl(info.cover, window.API_SITES?.[source]?.api || '')],
                moreCovers,
                item: info,
                kind
            });
            layout.appendChild(cover);
        }
        const copy = document.createElement('div');
        copy.className = 'player-synopsis-copy';
        const heading = document.createElement('strong');
        heading.textContent = text(info.title) || fallbackTitle;
        copy.appendChild(heading);
        const metadata = document.createElement('div');
        metadata.className = 'player-synopsis-meta';
        const subjectId = doubanId(info);
        if (subjectId) {
            const score = doubanScore(info);
            const douban = document.createElement('a');
            douban.className = 'player-synopsis-douban';
            douban.href = `https://movie.douban.com/subject/${subjectId}/`;
            douban.target = '_blank';
            douban.rel = 'noopener noreferrer';
            douban.textContent = score ? `豆瓣 ${score.toFixed(1)}` : '豆瓣页面';
            douban.title = '在豆瓣查看';
            metadata.appendChild(douban);
        }
        for (const value of [info.year, info.type, info.area, info.remarks, info.source_name]) {
            if (!text(value)) continue;
            const badge = document.createElement('span');
            badge.textContent = text(value);
            metadata.appendChild(badge);
        }
        copy.appendChild(metadata);
        for (const [label, value] of [['导演', info.director], ['主演', info.actor]]) {
            if (!text(value)) continue;
            const line = document.createElement('p');
            line.textContent = `${label}：${text(value)}`;
            copy.appendChild(line);
            // 主演常有几十个名字：默认两行，可展开
            if (label === '主演' && text(value).length > 60) {
                line.className = 'player-synopsis-cast';
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'player-synopsis-cast-toggle';
                toggle.textContent = '展开全部主演';
                toggle.setAttribute('aria-expanded', 'false');
                toggle.onclick = () => {
                    const expanded = line.classList.toggle('expanded');
                    toggle.textContent = expanded ? '收起主演' : '展开全部主演';
                    toggle.setAttribute('aria-expanded', String(expanded));
                };
                copy.appendChild(toggle);
            }
        }
        const description = document.createElement('p');
        description.className = 'player-synopsis-description';
        const plain = new DOMParser().parseFromString(text(info.desc), 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() || '';
        description.textContent = plain || '暂无简介';
        copy.appendChild(description);
        if (plain.length > 220) {
            const expand = document.createElement('button');
            expand.type = 'button';
            expand.className = 'player-synopsis-expand';
            expand.textContent = '展开简介';
            expand.onclick = () => {
                const expanded = description.classList.toggle('expanded');
                expand.textContent = expanded ? '收起简介' : '展开简介';
                expand.setAttribute('aria-expanded', String(expanded));
            };
            expand.setAttribute('aria-expanded', 'false');
            copy.appendChild(expand);
        }
        layout.appendChild(copy);
        target.appendChild(layout);
    }

    function selectedSources(source) {
        let chosen;
        try { chosen = JSON.parse(localStorage.getItem('selectedAPIs') || 'null'); } catch { chosen = null; }
        const ids = [source, ...(Array.isArray(chosen) ? chosen : window.DEFAULT_SELECTED_APIS || [])];
        const filtered = localStorage.getItem('yellowFilterEnabled') === 'true';
        return [...new Set(ids.filter(Boolean))].filter(id => {
            const context = window.getApiSearchContext(id);
            const isAdult = window.API_SITES?.[id]?.adult ||
                (id.startsWith('custom_') && window.getCustomApiInfo?.(id.slice(7))?.isAdult);
            return context && (!filtered || !isAdult);
        }).slice(0, 5);
    }

    async function firstPage(source, query, signal, category = false) {
        const context = window.getApiSearchContext(source);
        if (!context) return [];
        const path = category
            ? `?ac=videolist&t=${encodeURIComponent(query)}&pg=1`
            : API_CONFIG.search.path + encodeURIComponent(query);
        const data = await window.fetchVodApiJson(context.apiBaseUrl + path, API_CONFIG.search.headers, signal);
        return window.normalizeApiList(data, source, context);
    }

    // Same-series search across sources. Also yields covers of this very title from other
    // sources, used when the current source's cover host is dead.
    async function findFranchise(current, source, signal) {
        const root = window.LibreExperience.seriesStem(current.title, current.kind);
        if (root.length < 2 || !['movie', 'tv'].includes(current.kind)) return { items: [], covers: [] };
        const pages = await Promise.allSettled(selectedSources(source).map(id => firstPage(id, root, signal)));
        const items = pages.flatMap(page => page.status === 'fulfilled' ? page.value : []);
        const titleKey = normalizeTitle(current.title);
        const covers = items.filter(item =>
            (current.doubanId && doubanId(item) === current.doubanId) ||
            (normalizeTitle(item.vod_name) === titleKey && (!current.year || !item.vod_year || String(item.vod_year).includes(current.year))))
            .map(item => item.vod_pic)
            .filter(Boolean);
        return { items: window.LibreExperience.franchiseRecommendations(items, current).slice(0, 8), covers: [...new Set(covers)] };
    }

    function doubanTag(info, kind) {
        const genres = text(info.className || info.type);
        const options = kind === 'tv'
            ? ['国产剧','美剧','英剧','韩剧','日剧','港剧','日本动画','综艺','纪录片']
            : ['动作','喜剧','爱情','科幻','悬疑','恐怖','动画','纪录片','剧情'];
        return options.find(tag => genres.includes(tag)) || '热门';
    }

    async function doubanPopular(current, info, signal) {
        if (!['movie', 'tv'].includes(current.kind)) return [];
        const tag = doubanTag(info, current.kind);
        const url = `https://movie.douban.com/j/search_subjects?type=${current.kind}&tag=${encodeURIComponent(tag)}&sort=recommend&page_limit=24&page_start=0`;
        const data = await window.fetchVodApiJson(url, API_CONFIG.search.headers, signal);
        return (Array.isArray(data?.subjects) ? data.subjects : []).map(item => ({
            vod_name:item.title, vod_year:item.year, vod_pic:item.cover,
            vod_douban_id:item.id, vod_douban_score:item.rate,
            type_name:current.type || current.kind, source_name:'豆瓣热门'
        }));
    }

    async function findRelated(current, info, source, signal, onPartial) {
        const collected = [];
        const add = items => {
            collected.push(...items);
            const ranked = window.LibreExperience.relatedRecommendations(collected, current).slice(0, 16);
            if (ranked.length) onPartial(ranked);
        };
        const tasks = [doubanPopular(current, info, signal).then(add)];
        if (info.categoryId && source && selectedSources(source).includes(source)) {
            tasks.push(firstPage(source, info.categoryId, signal, true).then(add));
        }
        await Promise.allSettled(tasks);
        return window.LibreExperience.relatedRecommendations(collected, current).slice(0, 16);
    }

    function renderUnavailable(target, message, retry) {
        target.replaceChildren();
        const note = document.createElement('p');
        note.textContent = message;
        target.appendChild(note);
        if (retry) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'player-recommendation-retry'; button.textContent = '重试推荐';
            button.onclick = retry;
            target.appendChild(button);
        }
    }

    async function load(force = false) {
        const params = new URLSearchParams(location.search);
        const title = text(params.get('title'));
        const source = text(params.get('source'));
        const id = text(params.get('id'));
        const key = [title, source, id, params.get('year'), params.get('kind')].join('|');
        if (!force && key === activeKey && activeRequest) return activeRequest;
        activeKey = key;
        const signal = AbortSignal.timeout(10000);
        const relatedTarget = document.getElementById('relatedRecommendations');
        const franchiseSection = document.getElementById('franchiseSection');
        const franchiseTarget = document.getElementById('franchiseRecommendations');
        if (!relatedTarget || !franchiseSection || !franchiseTarget) return;
        renderSynopsis({}, title || '当前视频', source);
        relatedTarget.textContent = '正在查找同类型作品…';
        franchiseSection.hidden = true;
        activeRequest = (async () => {
            let detail = window.QuickPlay?.currentDetail?.();
            if (!detail && source && id) {
                try {
                    const response = await fetch(`/api/detail?id=${encodeURIComponent(id)}${window.getDetailApiParamsForSource(source)}`, {signal});
                    if (response.ok) detail = await response.json();
                } catch { /* Direct links still show title and broad recommendations. */ }
            }
            const info = detail?.videoInfo || {};
            const inferred = window.QuickPlay.logic.identity({vod_name:title, vod_year:info.year, type_name:info.type});
            const current = {
                title:title || info.title || '', year:params.get('year') || info.year || '',
                kind:params.get('kind') || inferred.kind, type:info.type || '', categoryId:info.categoryId || '',
                doubanId:doubanId(info)
            };
            const franchiseSearch = findFranchise(current, source, signal);
            renderSynopsis(info, title || '当前视频', source, {
                kind: current.kind,
                moreCovers: () => franchiseSearch.then(result => result.covers, () => [])
            });
            const franchise = franchiseSearch.then(({ items }) => {
                if (activeKey !== key) return;
                franchiseSection.hidden = !items.length;
                if (items.length) renderCards(franchiseTarget, items, current.kind);
            }).catch(() => { franchiseSection.hidden = true; });
            const related = findRelated(current, info, source, signal, items => {
                if (activeKey === key) renderCards(relatedTarget, items, current.kind);
            }).then(items => {
                if (activeKey !== key) return;
                if (items.length) renderCards(relatedTarget, items, current.kind);
                else renderUnavailable(relatedTarget, '暂无同类型推荐', () => load(true));
            }).catch(() => { if (activeKey === key) renderUnavailable(relatedTarget, '推荐暂时无法加载', () => load(true)); });
            await Promise.allSettled([franchise, related]);
        })();
        return activeRequest;
    }

    window.PlayerRecommendations = {load, logic: {doubanId, doubanScore}};
})();
