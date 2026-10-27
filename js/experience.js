// Shared, local-only data for search grouping, resume and source preference.
(() => {
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    const identity = item => window.QuickPlay.logic.identity(item);
    const year = value => String(value || '').match(/(?:19|20)\d{2}/)?.[0] || '';
    function groupResults(items) {
        const groups = new Map();
        for (const item of items) {
            const info = identity(item);
            // Missing identity fields cannot safely merge distinct versions.
            const key = info.title && info.year && info.kind
                ? [normalize(info.title), info.year, info.kind].join('|')
                : `${item.source_code || ''}:${item.vod_id || ''}`;
            if (!groups.has(key)) groups.set(key, []);
            const group = groups.get(key);
            if (!group.some(entry => entry.source_code === item.source_code && String(entry.vod_id) === String(item.vod_id))) group.push(item);
        }
        return [...groups.values()];
    }
    function unfinishedHistory(records) {
        return (Array.isArray(records) ? records : []).filter(item =>
            item?.title && item?.url && Number(item.playbackPosition) > 10 &&
            (!Number(item.duration) || Number(item.playbackPosition) < Number(item.duration) * 0.95)
        ).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
    const watchLaterKey = 'watchLaterV1';
    function watchLater() {
        try { const list = JSON.parse(localStorage.getItem(watchLaterKey) || '[]'); return Array.isArray(list) ? list : []; }
        catch { return []; }
    }
    function laterKey(item) { return [normalize(item.title), item.year || '', item.kind || ''].join('|'); }
    function addWatchLater(item) {
        if (!item?.title) return;
        const list = watchLater().filter(entry => laterKey(entry) !== laterKey(item));
        list.unshift({title:String(item.title), year:year(item.year), kind:item.kind || '', source:item.source || '', id:item.id || ''});
        localStorage.setItem(watchLaterKey, JSON.stringify(list.slice(0, 50)));
    }
    function removeWatchLater(item) { localStorage.setItem(watchLaterKey, JSON.stringify(watchLater().filter(entry => laterKey(entry) !== laterKey(item)))); }
    const qualityKey = 'sourcePlaybackQualityV1';
    function qualityData() { try { return JSON.parse(localStorage.getItem(qualityKey) || '{}'); } catch { return {}; } }
    function recordQuality(source, { started = false, firstFrameMs = 0, stalls = 0 } = {}) {
        if (!source) return;
        const data = qualityData();
        const observations = Array.isArray(data[source]) ? data[source] : [];
        observations.push({ at: Date.now(), started: Boolean(started), firstFrameMs: Math.max(0, Number(firstFrameMs) || 0), stalls: Math.max(0, Number(stalls) || 0) });
        data[source] = observations.slice(-12);
        localStorage.setItem(qualityKey, JSON.stringify(data));
    }
    function recordStall(source) {
        const data = qualityData();
        const list = data[source];
        if (!Array.isArray(list) || !list.length) return;
        const last = list[list.length - 1];
        if (!last.started || Date.now() - last.at > 3600000) return;
        last.stalls = (last.stalls || 0) + 1;
        localStorage.setItem(qualityKey, JSON.stringify(data));
    }
    function qualityScore(source, now = Date.now()) {
        const observations = (qualityData()[source] || []).filter(item => now - item.at < 14 * 86400000);
        if (!observations.length) return 0;
        const recent = observations.slice(-6);
        return recent.reduce((sum, item, index) => {
            const weight = (index + 1) / recent.length;
            return sum + weight * (item.started ? 10 - Math.min(item.firstFrameMs / 1000, 8) - Math.min(item.stalls * 2, 6) : -12);
        }, 0);
    }
    function matchingRecord(record, item) {
        const info = identity(item);
        if (normalize(record.title) !== normalize(info.title)) return false;
        if (record.sourceName === item.source_code && String(record.vod_id) === String(item.vod_id)) return true;
        return Boolean(record.movieYear && record.movieKind && record.movieYear === info.year && record.movieKind === info.kind);
    }
    function chooseCandidate(items, request, records = []) {
        const valid = items.filter(item => window.QuickPlay.logic.matches(item, request));
        const history = unfinishedHistory(records).find(record => valid.some(item => matchingRecord(record, item)));
        return [...valid].sort((a, b) => {
            const historyA = history && matchingRecord(history, a) && history.sourceName === a.source_code && String(history.vod_id) === String(a.vod_id) ? 1000 : 0;
            const historyB = history && matchingRecord(history, b) && history.sourceName === b.source_code && String(history.vod_id) === String(b.vod_id) ? 1000 : 0;
            const health = source => window.SourceAutopilot?.score(source) ?? qualityScore(source);
            return (historyB + health(b.source_code)) - (historyA + health(a.source_code));
        })[0] || null;
    }
    function seriesStem(title, kind) {
        let stem = String(title || '').normalize('NFKC').trim();
        if (kind === 'tv') stem = stem.replace(/[\s·:：\-]*(?:第\s*)?[一二三四五六七八九十百零两\d]{1,4}季$/u, '').replace(/[\s·:：\-]*(?:season|s)\s*\d{1,3}$/i, '');
        else if (kind === 'movie') stem = stem.replace(/[\s·:：\-]*(?:第\s*)?[一二三四五六七八九十\d]{1,3}(?:部|集)?$/u, '');
        return normalize(stem);
    }
    function releaseValue(item) {
        const date = String(item.vod_pubdate || item.vod_year || item.year || '').match(/((?:19|20)\d{2})(?:[-/.年](\d{1,2}))?(?:[-/.月](\d{1,2}))?/);
        return date ? Number(date[1]) * 10000 + Number(date[2] || 0) * 100 + Number(date[3] || 0) : 99999999;
    }
    function franchiseRecommendations(items, current) {
        const stem = seriesStem(current.title, current.kind);
        if (stem.length < 2 || !['movie', 'tv'].includes(current.kind)) return [];
        const found = new Map();
        for (const item of items || []) {
            const info = identity(item);
            if (info.kind !== current.kind || seriesStem(info.title, info.kind) !== stem) continue;
            if (/解说|预告|花絮|剪辑/.test(`${info.title} ${item.type_name || ''}`)) continue;
            if (normalize(info.title) === normalize(current.title) && (!info.year || info.year === year(current.year))) continue;
            const key = [normalize(info.title), info.year, info.kind].join('|');
            if (!found.has(key)) found.set(key, item);
        }
        return [...found.values()].sort((a, b) => releaseValue(a) - releaseValue(b) ||
            String(a.vod_name).localeCompare(String(b.vod_name), 'zh-Hans-CN'));
    }
    function metric(value) {
        const raw = String(value ?? '').replace(/,/g, '').trim();
        const match = raw.match(/^(\d+(?:\.\d+)?)(万|亿)?$/);
        return match ? Number(match[1]) * ({'万':10000,'亿':100000000}[match[2]] || 1) : null;
    }
    function relatedRecommendations(items, current) {
        const found = new Map();
        const currentStem = seriesStem(current.title, current.kind);
        for (const item of items || []) {
            const info = identity(item);
            if (info.kind !== current.kind || !info.title) continue;
            if (currentStem && seriesStem(info.title, info.kind) === currentStem) continue;
            if (/解说|预告|花絮|剪辑/.test(`${info.title} ${item.type_name || ''}`)) continue;
            if (current.type && normalize(item.type_name || item.type) !== normalize(current.type) &&
                !(current.categoryId && String(item.type_id) === String(current.categoryId))) continue;
            const key = [normalize(info.title), info.year, info.kind].join('|');
            if (!found.has(key)) found.set(key, { ...item });
            else {
                const saved = found.get(key);
                const score = [metric(saved.vod_score ?? saved.rate ?? saved.rating), metric(item.vod_score ?? item.rate ?? item.rating)].filter(value => value !== null);
                const hits = [metric(saved.vod_hits ?? saved.vod_hits_all ?? saved.hits), metric(item.vod_hits ?? item.vod_hits_all ?? item.hits)].filter(value => value !== null);
                if (item.source_code && item.vod_id && !(saved.source_code && saved.vod_id)) {
                    const cover = saved.vod_pic;
                    Object.assign(saved, item);
                    if (!saved.vod_pic) saved.vod_pic = cover;
                }
                if (score.length) saved.vod_score = Math.max(...score);
                if (hits.length) saved.vod_hits = Math.max(...hits);
            }
        }
        const rank = item => {
            const hits = metric(item.vod_hits ?? item.vod_hits_all ?? item.hits);
            const score = metric(item.vod_score ?? item.rate ?? item.rating);
            return [hits > 0 ? 2 : score > 0 ? 1 : 0, hits || 0, score || 0, -releaseValue(item)];
        };
        return [...found.values()].sort((a, b) => {
            const left = rank(a), right = rank(b);
            for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return right[i] - left[i];
            return 0;
        });
    }
    window.LibreExperience = { groupResults, unfinishedHistory, watchLater, addWatchLater, removeWatchLater, recordQuality, recordStall, qualityScore, chooseCandidate, year, seriesStem, franchiseRecommendations, relatedRecommendations };
})();
