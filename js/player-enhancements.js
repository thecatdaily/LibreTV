// Player conveniences: episode labels, remembered playback speed, an in-player
// episode drawer (usable in fullscreen) and the next-episode countdown card.
(() => {
    const RATE_STORAGE_KEY = 'libretvPlaybackRate';
    const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    const NEXT_CARD_MAX_SECONDS = 10;
    const NEXT_CARD_MIN_DURATION = 30;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Names such as "第01集", "EP1" or "1" add nothing to the number; anything
    // else (dated variety episodes, "上/下", versions) is worth showing.
    function episodeLabel(index, name) {
        const number = index + 1;
        const text = String(name || '').trim();
        if (!text) return { number, title: '' };
        const plain = /^(?:第\s*)?(?:ep|e)?\s*0*(\d+)\s*(?:集|话|話|回|期)?$/i.exec(text);
        if (plain && Number(plain[1]) === number) return { number, title: '' };
        return { number, title: text };
    }

    function shouldMuteAfterPlayRejection(error) {
        // Only an autoplay-policy block justifies muting. AbortError means the
        // play() call was interrupted by a newer load (fast episode switching).
        return error?.name === 'NotAllowedError';
    }

    function clampSeek(current, delta, duration) {
        const target = Number(current || 0) + delta;
        const max = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.5) : target;
        return Math.max(0, Math.min(max, target));
    }

    function readStoredRate(storage = window.localStorage) {
        try {
            const rate = Number(storage.getItem(RATE_STORAGE_KEY));
            return PLAYBACK_RATES.includes(rate) ? rate : 1;
        } catch {
            return 1;
        }
    }

    function storeRate(rate, storage = window.localStorage) {
        if (!PLAYBACK_RATES.includes(Number(rate))) return;
        try { storage.setItem(RATE_STORAGE_KEY, String(Number(rate))); } catch {}
    }

    function rateLabel(rate) {
        return Number(rate) === 1 ? '倍速' : `${Number(rate)}x`;
    }

    function nextCardThreshold(duration) {
        if (!Number.isFinite(duration) || duration < NEXT_CARD_MIN_DURATION) return 0;
        return Math.min(NEXT_CARD_MAX_SECONDS, duration * 0.15);
    }

    // Episode list overlay that lives inside the player so it also works in fullscreen.
    function createEpisodeDrawer({ host, getEpisodes, getNames, getIndex, isReversed, onSelect }) {
        const drawer = document.createElement('div');
        drawer.className = 'player-episode-drawer';
        drawer.hidden = true;
        drawer.dataset.videoInteractive = 'true';
        drawer.setAttribute('role', 'dialog');
        drawer.setAttribute('aria-label', '选集');
        host.appendChild(drawer);

        function render() {
            const episodes = getEpisodes() || [];
            const names = getNames() || [];
            const current = getIndex();
            const order = episodes.map((_, index) => index);
            if (isReversed?.()) order.reverse();
            const labels = order.map(index => ({ index, ...episodeLabel(index, names[index]) }));
            const withTitles = labels.some(item => item.title);
            drawer.innerHTML = `
                <div class="player-episode-drawer-head">
                    <strong>选集</strong><span>共 ${episodes.length} 集</span>
                    <button type="button" class="player-episode-drawer-close" aria-label="关闭选集">✕</button>
                </div>
                <div class="player-episode-drawer-list ${withTitles ? 'is-titled' : ''}">
                    ${labels.map(item => `
                        <button type="button" class="player-episode-item ${item.index === current ? 'is-current' : ''}"
                                data-episode-index="${item.index}" title="${escapeHtml(item.title || `第 ${item.number} 集`)}"
                                ${item.index === current ? 'aria-current="true"' : ''}>
                            <span class="player-episode-number">${item.number}</span>${item.title ? `<span class="player-episode-title">${escapeHtml(item.title)}</span>` : ''}
                        </button>`).join('')}
                </div>`;
        }

        function open() {
            render();
            drawer.hidden = false;
            host.classList.add('player-episode-drawer-open');
            drawer.querySelector('.is-current')?.scrollIntoView({ block: 'center' });
        }

        function close() {
            drawer.hidden = true;
            host.classList.remove('player-episode-drawer-open');
        }

        const onClick = event => {
            event.stopPropagation();
            if (event.target.closest('.player-episode-drawer-close')) {
                close();
                return;
            }
            const item = event.target.closest('[data-episode-index]');
            if (!item) return;
            close();
            onSelect(Number(item.dataset.episodeIndex));
        };
        drawer.addEventListener('click', onClick);

        return {
            element: drawer,
            open,
            close,
            toggle() { if (drawer.hidden) open(); else close(); },
            refresh() { if (!drawer.hidden) render(); },
            get isOpen() { return !drawer.hidden; },
            destroy() {
                drawer.removeEventListener('click', onClick);
                host.classList.remove('player-episode-drawer-open');
                drawer.remove();
            }
        };
    }

    // "Next episode in N s" card shown during the last seconds of an episode.
    function createNextEpisodeCard({ host, video, getNext, isEnabled, onPlayNext }) {
        const card = document.createElement('div');
        card.className = 'player-next-card';
        card.hidden = true;
        card.dataset.videoInteractive = 'true';
        card.setAttribute('role', 'status');
        host.appendChild(card);
        let dismissed = false;

        function hide() {
            card.hidden = true;
        }

        function update() {
            const next = getNext();
            const duration = Number(video.duration);
            const threshold = nextCardThreshold(duration);
            const remaining = duration - Number(video.currentTime || 0);
            if (!next || !isEnabled() || dismissed || !threshold || remaining > threshold || remaining <= 0 || video.paused) {
                hide();
                return;
            }
            const seconds = Math.max(1, Math.ceil(remaining));
            const label = next.title ? `第 ${next.number} 集 · ${next.title}` : `第 ${next.number} 集`;
            if (card.hidden || card.dataset.label !== label) {
                card.dataset.label = label;
                card.innerHTML = `
                    <div class="player-next-card-text">
                        <span class="player-next-card-count"></span>
                        <strong>${escapeHtml(label)}</strong>
                    </div>
                    <div class="player-next-card-actions">
                        <button type="button" data-next-action="play">立即播放</button>
                        <button type="button" data-next-action="cancel">取消</button>
                    </div>`;
            }
            card.querySelector('.player-next-card-count').textContent = `${seconds} 秒后播放`;
            card.hidden = false;
        }

        const onClick = event => {
            event.stopPropagation();
            const action = event.target.closest('[data-next-action]')?.dataset.nextAction;
            if (action === 'cancel') {
                dismissed = true;
                hide();
            } else if (action === 'play') {
                hide();
                onPlayNext();
            }
        };
        card.addEventListener('click', onClick);
        video.addEventListener('timeupdate', update);
        video.addEventListener('pause', update);
        video.addEventListener('seeking', update);

        return {
            element: card,
            // A new episode starts with the countdown enabled again.
            reset() { dismissed = false; hide(); },
            get dismissed() { return dismissed; },
            destroy() {
                card.removeEventListener('click', onClick);
                video.removeEventListener('timeupdate', update);
                video.removeEventListener('pause', update);
                video.removeEventListener('seeking', update);
                card.remove();
            }
        };
    }

    window.PlayerEnhancements = {
        PLAYBACK_RATES,
        episodeLabel,
        shouldMuteAfterPlayRejection,
        clampSeek,
        readStoredRate,
        storeRate,
        rateLabel,
        nextCardThreshold,
        createEpisodeDrawer,
        createNextEpisodeCard
    };
})();
