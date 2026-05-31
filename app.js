const DEFAULT_STREAMERBOT_WS_HOST = '127.0.0.1';

function normalizeWebsocketHost(value) {
    const fallback = DEFAULT_STREAMERBOT_WS_HOST;
    const rawValue = String(value || '').trim();
    if (!rawValue) return fallback;

    try {
        const url = new URL(rawValue.includes('://') ? rawValue : 'ws://' + rawValue);
        return url.hostname || fallback;
    } catch (error) {
        return rawValue
            .replace(/^wss?:\/\//i, '')
            .replace(/^https?:\/\//i, '')
            .replace(/\/.*$/, '')
            .replace(/:\d+$/, '')
            .trim() || fallback;
    }
}

function formatWebsocketHostForUrl(host) {
    if (host.includes(':') && !host.startsWith('[')) return '[' + host + ']';
    return host;
}

function buildStreamerBotWebsocketUrl(host, port) {
    return 'ws://' + formatWebsocketHostForUrl(normalizeWebsocketHost(host)) + ':' + String(port || '8080').trim() + '/';
}

function isTruthyParam(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

if (document.body.classList.contains('now-playing-widget-page')) {
const STORAGE_KEY = 'ytm_now_playing_widget_state';
const CHANNEL_NAME = 'ytm_now_playing_widget';
const root = document.getElementById('widget-root');
const widgetParams = new URLSearchParams(window.location.search || '');
const WIDGET_WS_HOST = normalizeWebsocketHost(widgetParams.get('server') || widgetParams.get('host') || widgetParams.get('wsHost') || DEFAULT_STREAMERBOT_WS_HOST);
const WIDGET_WS_PORT = widgetParams.get('port') || widgetParams.get('wsPort') || '8080';
const WIDGET_WS_PASS = widgetParams.get('pass') || widgetParams.get('password') || widgetParams.get('wsPass') || '';
const WIDGET_LANG = widgetParams.get('lang') || widgetParams.get('language') || '';
const WIDGET_AUDIO_ENABLED = isTruthyParam(widgetParams.get('audio') || widgetParams.get('sound') || widgetParams.get('playAudio'));
const WIDGET_STALE_MS = 3500;
const WIDGET_CONNECTION_MESSAGE_DELAY_MS = 15000;
const WIDGET_AUTO_HIDE_MS = 30000;
const WIDGET_AUDIO_SYNC_THRESHOLD = 1.6;
const WIDGET_AUDIO_LOCK_KEY = 'ytm_widget_audio_master_lock';
const WIDGET_AUDIO_LOCK_TTL_MS = 4500;
const WIDGET_AUDIO_LOCK_RENEW_MS = 1200;
const WIDGET_INSTANCE_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let lastPayload = '';
let activeWidgetSongKey = '';
let lastWidgetStateAt = 0;
let lastWidgetPlayableState = null;
let widgetAutoHideTimeout = null;
let widgetAutoHideMode = '';
let widgetHiddenReason = '';
let widgetStatusKey = '';
let widgetWs = null;
let widgetWsReconnectTimeout = null;
let widgetWsFallbackSubscribeTimeout = null;
let widgetWsSubscribed = false;
let widgetAudioPlayer = null;
let widgetAudioReady = false;
let widgetAudioSongId = '';
let widgetAudioLastState = null;
let widgetAudioLastSeekAt = 0;
let widgetAudioApiLoading = false;
let widgetAudioHasLock = !WIDGET_AUDIO_ENABLED;
let widgetAudioLockInterval = null;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function cleanAuthorName(name) {
    if (!name) return 'YouTube';
    return String(name).replace(/\s*-\s*Topic$/i, '').replace(/\s*-\s*temat$/i, '').trim();
}

function formatTime(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

const coverThemeCache = new Map();

function normalizeCoverThemeColor(color) {
    const luma = (color.r * 0.2126) + (color.g * 0.7152) + (color.b * 0.0722);
    let mixTarget = null;
    let mixAmount = 0;

    if (luma < 58) {
        mixTarget = { r: 125, g: 135, b: 145 };
        mixAmount = 0.38;
    } else if (luma > 178) {
        mixTarget = { r: 64, g: 68, b: 74 };
        mixAmount = 0.42;
    }

    if (!mixTarget) return color;
    return {
        r: Math.round(color.r * (1 - mixAmount) + mixTarget.r * mixAmount),
        g: Math.round(color.g * (1 - mixAmount) + mixTarget.g * mixAmount),
        b: Math.round(color.b * (1 - mixAmount) + mixTarget.b * mixAmount)
    };
}

function readAverageCoverColor(src) {
    if (!src) return Promise.reject(new Error('No cover source'));
    if (coverThemeCache.has(src)) return Promise.resolve(coverThemeCache.get(src));

    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const size = 24;
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(image, 0, 0, size, size);

                const data = ctx.getImageData(0, 0, size, size).data;
                let r = 0;
                let g = 0;
                let b = 0;
                let count = 0;

                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] < 32) continue;
                    r += data[i];
                    g += data[i + 1];
                    b += data[i + 2];
                    count += 1;
                }

                if (!count) throw new Error('No readable cover pixels');
                const color = normalizeCoverThemeColor({
                    r: Math.round(r / count),
                    g: Math.round(g / count),
                    b: Math.round(b / count)
                });
                coverThemeCache.set(src, color);
                resolve(color);
            } catch (error) {
                reject(error);
            }
        };
        image.onerror = reject;
        image.src = src;
    });
}

function applyCoverThemeToNowPlayingCard(card, src) {
    if (!card || !src) return;
    card.dataset.coverThemeSrc = src;

    readAverageCoverColor(src).then(color => {
        if (card.dataset.coverThemeSrc !== src) return;
        card.style.setProperty('--np-cover-rgb', color.r + ', ' + color.g + ', ' + color.b);
    }).catch(() => {});
}

function getNowPlayingWaveBarHeight(index) {
    const height = 55 + Math.sin(index * 0.83) * 11 + Math.sin(index * 1.71 + 0.9) * 8 + Math.sin(index * 0.29 + 2.4) * 6;
    return Math.round(Math.min(78, Math.max(34, height)));
}

function getNowPlayingWaveBarCount(width) {
    if (!width) return 28;
    return Math.min(96, Math.max(18, Math.round(width / 9)));
}

function createNowPlayingWaveBars(count = 28) {
    return Array.from({ length: count }, (_, index) => {
        const height = getNowPlayingWaveBarHeight(index);
        const stagger = (index * 0.026).toFixed(3);
        const skipStagger = ((((index * 37) % 29) * 0.006) + (((index * 11) % 5) * 0.002)).toFixed(3);
        const skipX = ((index % 2 ? -1 : 1) * (4 + (index % 4))).toFixed(1) + 'px';
        const skipXAlt = ((index % 2 ? 1 : -1) * (3 + (index % 5))).toFixed(1) + 'px';
        const skipXSoft = ((index % 2 ? -1 : 1) * (1.5 + (index % 3))).toFixed(1) + 'px';
        const duration = (2.45 + ((index * 7) % 11) * 0.09).toFixed(2);
        return '<i style="--bar-height: ' + height + '%; --bar-stagger: ' + stagger + 's; --bar-skip-stagger: ' + skipStagger + 's; --bar-skip-x: ' + skipX + '; --bar-skip-x-alt: ' + skipXAlt + '; --bar-skip-x-soft: ' + skipXSoft + '; --bar-duration: ' + duration + 's"></i>';
    }).join('');
}

function seededNowPlayingRandom(seed, index, salt = 0) {
    const numericSeed = Number(seed) || 1;
    const value = Math.sin((numericSeed * 12.9898) + (index * 78.233) + (salt * 37.719)) * 43758.5453;
    return value - Math.floor(value);
}

function randomizeNowPlayingSkipBars(waveEl, seed) {
    if (!waveEl) return;
    const bars = Array.from(waveEl.querySelectorAll('i'));
    const ordered = bars
        .map((bar, index) => ({ bar, index, order: seededNowPlayingRandom(seed, index, 1) }))
        .sort((a, b) => a.order - b.order);

    ordered.forEach(({ bar, index }, rank) => {
        const jitter = seededNowPlayingRandom(seed, index, 2);
        const direction = seededNowPlayingRandom(seed, index, 3) > 0.5 ? 1 : -1;
        const strength = 4 + Math.round(seededNowPlayingRandom(seed, index, 4) * 5);
        const reverseStrength = 3 + Math.round(seededNowPlayingRandom(seed, index, 5) * 4);

        bar.style.setProperty('--bar-skip-stagger', (rank * 0.0019 + jitter * 0.014).toFixed(3) + 's');
        bar.style.setProperty('--bar-skip-x', (direction * strength).toFixed(1) + 'px');
        bar.style.setProperty('--bar-skip-x-alt', (-direction * reverseStrength).toFixed(1) + 'px');
        bar.style.setProperty('--bar-skip-x-soft', (direction * strength * 0.35).toFixed(1) + 'px');
    });
}

function syncNowPlayingWaveBars(waveEl) {
    if (!waveEl) return;
    const width = waveEl.clientWidth || waveEl.getBoundingClientRect().width;
    const count = getNowPlayingWaveBarCount(width);
    if (waveEl.dataset.barCount !== String(count)) {
        waveEl.innerHTML = createNowPlayingWaveBars(count);
        waveEl.dataset.barCount = String(count);
    }
}

function getWidgetLanguage() {
    if (WIDGET_LANG) return WIDGET_LANG;

    try {
        return localStorage.getItem('ytm_lang') || document.documentElement.lang || 'en';
    } catch (error) {
        return 'en';
    }
}

function widgetT(key) {
    const fallback = {
        ui_widget_waiting_player: 'Waiting for player connection...'
    };

    try {
        if (typeof i18n !== 'undefined') {
            const lang = getWidgetLanguage();
            const dict = i18n[lang] || i18n.en || {};
            return dict[key] || (i18n.en && i18n.en[key]) || fallback[key] || key;
        }
    } catch (error) {}

    return fallback[key] || key;
}

function ensureWidgetAudioContainer() {
    let container = document.getElementById('widget-audio-player');
    if (container) return container;
    container = document.createElement('div');
    container.id = 'widget-audio-player';
    container.className = 'widget-audio-player';
    document.body.appendChild(container);
    return container;
}

function initWidgetAudioPlayer() {
    if (!WIDGET_AUDIO_ENABLED || widgetAudioPlayer || typeof YT === 'undefined' || !YT.Player) return;
    ensureWidgetAudioContainer();
    widgetAudioPlayer = new YT.Player('widget-audio-player', {
        height: '1',
        width: '1',
        playerVars: {
            enablejsapi: 1,
            controls: 0,
            disablekb: 1,
            playsinline: 1,
            origin: window.location.origin
        },
        events: {
            onReady: () => {
                widgetAudioReady = true;
                if (widgetAudioLastState) syncWidgetAudio(widgetAudioLastState, true);
            }
        }
    });
}

function loadWidgetAudioApi() {
    if (!WIDGET_AUDIO_ENABLED || widgetAudioApiLoading) return;
    widgetAudioApiLoading = true;
    ensureWidgetAudioContainer();

    if (window.YT && window.YT.Player) {
        initWidgetAudioPlayer();
        return;
    }

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
        if (typeof previousReady === 'function') {
            try { previousReady(); } catch (error) {}
        }
        initWidgetAudioPlayer();
    };

    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(script);
    }
}

function readWidgetAudioLock() {
    try {
        const lock = JSON.parse(localStorage.getItem(WIDGET_AUDIO_LOCK_KEY) || 'null');
        if (!lock || typeof lock !== 'object') return null;
        return {
            owner: String(lock.owner || ''),
            updatedAt: Number(lock.updatedAt) || 0
        };
    } catch (error) {
        return null;
    }
}

function writeWidgetAudioLock() {
    localStorage.setItem(WIDGET_AUDIO_LOCK_KEY, JSON.stringify({
        owner: WIDGET_INSTANCE_ID,
        updatedAt: Date.now()
    }));
}

function isWidgetAudioLockExpired(lock, now = Date.now()) {
    return !lock || !lock.owner || now - lock.updatedAt > WIDGET_AUDIO_LOCK_TTL_MS;
}

function acquireWidgetAudioLock() {
    if (!WIDGET_AUDIO_ENABLED) return false;

    const lock = readWidgetAudioLock();
    if (lock && lock.owner !== WIDGET_INSTANCE_ID && !isWidgetAudioLockExpired(lock)) {
        widgetAudioHasLock = false;
        stopWidgetAudio();
        return false;
    }

    try {
        writeWidgetAudioLock();
        const confirmedLock = readWidgetAudioLock();
        widgetAudioHasLock = !!confirmedLock && confirmedLock.owner === WIDGET_INSTANCE_ID;
    } catch (error) {
        widgetAudioHasLock = true;
    }

    if (!widgetAudioHasLock) stopWidgetAudio();
    return widgetAudioHasLock;
}

function renewWidgetAudioLock() {
    if (!WIDGET_AUDIO_ENABLED) return;

    const lock = readWidgetAudioLock();
    if (lock && lock.owner !== WIDGET_INSTANCE_ID && !isWidgetAudioLockExpired(lock)) {
        widgetAudioHasLock = false;
        stopWidgetAudio();
        return;
    }

    acquireWidgetAudioLock();
}

function releaseWidgetAudioLock() {
    if (!WIDGET_AUDIO_ENABLED) return;
    try {
        const lock = readWidgetAudioLock();
        if (lock && lock.owner === WIDGET_INSTANCE_ID) {
            localStorage.removeItem(WIDGET_AUDIO_LOCK_KEY);
        }
    } catch (error) {}
}

function startWidgetAudioLockHeartbeat() {
    if (!WIDGET_AUDIO_ENABLED || widgetAudioLockInterval) return;
    acquireWidgetAudioLock();
    widgetAudioLockInterval = setInterval(renewWidgetAudioLock, WIDGET_AUDIO_LOCK_RENEW_MS);
    window.addEventListener('beforeunload', releaseWidgetAudioLock);
    window.addEventListener('pagehide', releaseWidgetAudioLock);
}

function handleWidgetAudioLockChange() {
    if (!WIDGET_AUDIO_ENABLED) return;
    const lock = readWidgetAudioLock();
    if (lock && lock.owner !== WIDGET_INSTANCE_ID && !isWidgetAudioLockExpired(lock)) {
        widgetAudioHasLock = false;
        stopWidgetAudio();
    }
}

function stopWidgetAudio() {
    widgetAudioSongId = '';
    if (!widgetAudioPlayer || !widgetAudioReady) return;
    try { widgetAudioPlayer.stopVideo(); } catch (error) {}
}

function syncWidgetAudio(state, force = false) {
    if (!WIDGET_AUDIO_ENABLED) return;
    widgetAudioLastState = state;
    startWidgetAudioLockHeartbeat();
    if (!widgetAudioHasLock && !acquireWidgetAudioLock()) return;

    if (!state || !state.hasSong || state.isStopped) {
        stopWidgetAudio();
        return;
    }

    loadWidgetAudioApi();
    if (!widgetAudioPlayer || !widgetAudioReady || !state.id) return;

    const targetTime = Math.max(0, Number(state.currentTime) || 0);
    const shouldPlay = !!state.isPlaying;

    try {
        if (widgetAudioSongId !== state.id) {
            widgetAudioSongId = state.id;
            if (shouldPlay) {
                widgetAudioPlayer.loadVideoById({ videoId: state.id, startSeconds: targetTime });
            } else {
                widgetAudioPlayer.cueVideoById({ videoId: state.id, startSeconds: targetTime });
                setTimeout(() => {
                    try { widgetAudioPlayer.pauseVideo(); } catch (error) {}
                }, 0);
            }
            return;
        }

        const now = Date.now();
        const currentTime = widgetAudioPlayer.getCurrentTime ? widgetAudioPlayer.getCurrentTime() : targetTime;
        const drift = Math.abs(currentTime - targetTime);
        if ((force || drift > WIDGET_AUDIO_SYNC_THRESHOLD) && now - widgetAudioLastSeekAt > 900) {
            widgetAudioPlayer.seekTo(targetTime, true);
            widgetAudioLastSeekAt = now;
        }

        const audioState = widgetAudioPlayer.getPlayerState ? widgetAudioPlayer.getPlayerState() : 0;
        if (shouldPlay) {
            if (audioState !== 1) widgetAudioPlayer.playVideo();
        } else if (audioState === 1 || audioState === 3) {
            widgetAudioPlayer.pauseVideo();
        }
    } catch (error) {}
}

function clearWidgetAutoHide() {
    clearTimeout(widgetAutoHideTimeout);
    widgetAutoHideTimeout = null;
    widgetAutoHideMode = '';
    widgetHiddenReason = '';
}

function showWidgetNow() {
    clearWidgetAutoHide();
    root.classList.add('is-widget-visible');
    root.classList.remove('is-widget-hidden');
}

function shouldKeepWidgetSilent(mode) {
    if (!root.classList.contains('is-widget-hidden')) return false;
    if (!widgetHiddenReason) return false;
    if (widgetHiddenReason === mode) return true;
    return ['paused', 'stopped', 'empty'].includes(widgetHiddenReason);
}

function showWidgetTemporarily(mode) {
    if (shouldKeepWidgetSilent(mode)) return false;

    root.classList.add('is-widget-visible');
    root.classList.remove('is-widget-hidden');
    widgetHiddenReason = '';

    if (widgetAutoHideMode === mode && widgetAutoHideTimeout) return true;

    clearTimeout(widgetAutoHideTimeout);
    widgetAutoHideMode = mode;
    widgetAutoHideTimeout = setTimeout(() => {
        root.classList.add('is-widget-hidden');
        widgetHiddenReason = mode;
        widgetAutoHideTimeout = null;
    }, WIDGET_AUTO_HIDE_MS);
    return true;
}

function renderWidgetStatus(messageKey, mode = 'connection') {
    if (shouldKeepWidgetSilent(mode)) return;

    activeWidgetSongKey = '';
    if (widgetResizeObserver) widgetResizeObserver.disconnect();

    const message = escapeHtml(widgetT(messageKey));
    const statusEl = root.querySelector('.widget-status');

    if (!statusEl || widgetStatusKey !== messageKey) {
        root.innerHTML = '<div class="widget-status" role="status">' + message + '</div>';
    } else {
        statusEl.innerHTML = message;
    }

    widgetStatusKey = messageKey;
    showWidgetTemporarily(mode);
}

function renderEmpty() {
    renderWidgetStatus('ui_widget_waiting_player', 'empty');
}

function getWidgetSongKey(state) {
    return [
        state.id || '',
        state.title || '',
        state.author || '',
        state.user || '',
        state.thumbnail || ''
    ].join('|');
}

function updateWidgetCardState(state, progress) {
    const card = document.getElementById('widget-now-playing-card');
    const currentEl = document.getElementById('widget-now-playing-current');
    const durationEl = document.getElementById('widget-now-playing-duration');
    const progressEl = document.getElementById('widget-now-playing-progress');
    const waveEl = document.getElementById('widget-now-playing-wave');
    const isSkipEffect = state.waveEffect === 'skip';
    const isFadeEffect = state.waveEffect === 'fade';
    const isWaveHeld = !!state.waveHold && !isSkipEffect;

    if (currentEl) currentEl.innerText = formatTime(state.currentTime);
    if (durationEl) durationEl.innerText = formatTime(state.duration);
    if (progressEl) progressEl.style.width = progress + '%';
    if (waveEl) {
        waveEl.style.setProperty('--np-progress', progress + '%');
        syncNowPlayingWaveBars(waveEl);
    }
    if (card) {
        const skipEffectId = String(state.waveEffectId || (isSkipEffect ? state.updatedAt || Date.now() : ''));
        if (isSkipEffect && card.dataset.skipEffectId !== skipEffectId) {
            card.dataset.skipEffectId = skipEffectId;
            randomizeNowPlayingSkipBars(waveEl, skipEffectId);
            card.classList.remove('is-skipping');
            void card.offsetWidth;
        } else if (!isSkipEffect) {
            card.dataset.skipEffectId = '';
        }

        card.classList.toggle('is-playing', !!state.isPlaying && !state.waveEnding && !isSkipEffect && !isFadeEffect && !isWaveHeld);
        card.classList.toggle('is-wave-ending', !!state.waveEnding);
        card.classList.toggle('is-skipping', isSkipEffect);
        card.classList.toggle('is-wave-fading', isFadeEffect);
        card.classList.toggle('is-wave-held', isWaveHeld);
    }
    queueWidgetTextFit();
}

function fitWidgetTextElement(element, minScale) {
    if (!element) return;
    const currentSize = parseFloat(element.dataset.baseFontSize || getComputedStyle(element).fontSize);
    if (!element.dataset.baseFontSize) element.dataset.baseFontSize = String(currentSize);
    const minSize = Math.max(9, currentSize * minScale);
    let size = currentSize;

    element.style.fontSize = currentSize + 'px';
    while (size > minSize && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)) {
        size -= 1;
        element.style.fontSize = size + 'px';
    }
}

let widgetTextFitFrame = 0;
let widgetResizeObserver = null;

function queueWidgetTextFit() {
    cancelAnimationFrame(widgetTextFitFrame);
    widgetTextFitFrame = requestAnimationFrame(() => {
        fitWidgetTextElement(document.querySelector('#widget-now-playing-card .np-card-title'), 0.72);
        fitWidgetTextElement(document.querySelector('#widget-now-playing-card .np-card-author'), 0.68);
    });
}

function observeWidgetCard() {
    const card = document.getElementById('widget-now-playing-card');
    if (!card || !('ResizeObserver' in window)) return;
    if (widgetResizeObserver) widgetResizeObserver.disconnect();
    widgetResizeObserver = new ResizeObserver(() => {
        syncNowPlayingWaveBars(document.getElementById('widget-now-playing-wave'));
        queueWidgetTextFit();
    });
    widgetResizeObserver.observe(card);
}

function renderState(state) {
    syncWidgetAudio(state);

    if (!state || !state.hasSong || state.isStopped) {
        if (state && state.isStopped && lastWidgetPlayableState && document.getElementById('widget-now-playing-card')) {
            if (shouldKeepWidgetSilent('stopped')) return;

            const stoppedState = {
                ...lastWidgetPlayableState,
                isPlaying: false,
                waveEnding: false,
                waveEffect: 'fade'
            };
            const progress = Math.min(100, Math.max(0, stoppedState.progress || 0));
            updateWidgetCardState(stoppedState, progress);
            showWidgetTemporarily('stopped');
            return;
        }

        renderWidgetStatus('ui_widget_waiting_player', state && state.isStopped ? 'stopped' : 'empty');
        return;
    }

    lastWidgetPlayableState = { ...state };
    widgetStatusKey = '';

    const title = escapeHtml(state.title || 'Unknown Title');
    const author = escapeHtml(cleanAuthorName(state.author || 'YouTube'));
    const user = state.user === 'Auto' ? 'Auto' : escapeHtml(state.user || 'Viewer');
    const thumbnailUrl = state.thumbnail || (state.id ? 'https://i.ytimg.com/vi/' + state.id + '/mqdefault.jpg' : '');
    const thumbnail = escapeHtml(thumbnailUrl);
    const progress = Math.min(100, Math.max(0, state.progress || 0));
    const waveEffect = state.waveEffect || '';
    const playingClass = state.isPlaying && !state.waveEnding && waveEffect !== 'skip' && waveEffect !== 'fade' ? ' is-playing' : '';
    const waveEndingClass = state.waveEnding ? ' is-wave-ending' : '';
    const skipClass = waveEffect === 'skip' ? ' is-skipping' : '';
    const fadeClass = waveEffect === 'fade' ? ' is-wave-fading' : '';
    const holdClass = state.waveHold && waveEffect !== 'skip' ? ' is-wave-held' : '';
    const songKey = getWidgetSongKey(state);

    if (songKey === activeWidgetSongKey && document.getElementById('widget-now-playing-card')) {
        updateWidgetCardState(state, progress);
        if (state.isPlaying) {
            showWidgetNow();
        } else {
            showWidgetTemporarily('paused');
        }
        return;
    }

    activeWidgetSongKey = songKey;
    root.innerHTML =
        '<div id="widget-now-playing-card" class="now-playing-card panel-card' + playingClass + waveEndingClass + skipClass + fadeClass + holdClass + '">' +
            '<img class="np-card-cover" src="' + thumbnail + '" alt="">' +
            '<div class="np-card-main">' +
                '<div class="np-card-info">' +
                    '<div class="np-card-title" title="' + title + '">' + title + '</div>' +
                    '<div class="np-card-author" title="' + author + '">' + author + '</div>' +
                '</div>' +
                '<div class="np-card-meter">' +
                    '<span id="widget-now-playing-current" class="np-card-time">' + formatTime(state.currentTime) + '</span>' +
                    '<div id="widget-now-playing-wave" class="np-card-wave" style="--np-progress: ' + progress + '%" aria-hidden="true">' + createNowPlayingWaveBars() + '</div>' +
                    '<span id="widget-now-playing-duration" class="np-card-time">' + formatTime(state.duration) + '</span>' +
                '</div>' +
            '</div>' +
            '<span class="np-card-user">' + user + '</span>' +
            '<div class="np-card-progress"><div id="widget-now-playing-progress" class="np-card-progress-fill" style="width: ' + progress + '%"></div></div>' +
        '</div>';

    updateWidgetCardState(state, progress);
    observeWidgetCard();
    applyCoverThemeToNowPlayingCard(document.getElementById('widget-now-playing-card'), thumbnailUrl);

    if (state.isPlaying) {
        showWidgetNow();
    } else {
        showWidgetTemporarily('paused');
    }
}

function consumePayload(payload, source = 'unknown') {
    if (!payload) return;
    try {
        const state = JSON.parse(payload);
        if (!state || state.type !== 'NOW_PLAYING_STATE') return;

        const now = Date.now();
        if (state.updatedAt && now - state.updatedAt > WIDGET_STALE_MS) {
            const hasFreshState = lastWidgetStateAt && now - lastWidgetStateAt <= WIDGET_STALE_MS;
            if (hasFreshState || source === 'storage' || source === 'storage-event') return;
            if (!lastWidgetStateAt || now - lastWidgetStateAt < WIDGET_CONNECTION_MESSAGE_DELAY_MS) return;

            renderWidgetStatus('ui_widget_waiting_player', 'connection');
            return;
        }

        if (payload === lastPayload) return;

        lastPayload = payload;
        lastWidgetStateAt = now;
        renderState(state);
    } catch (error) {
        renderWidgetStatus('ui_widget_waiting_player', 'connection');
    }
}

function handleWidgetState(state, source = 'message') {
    if (!state || state.type !== 'NOW_PLAYING_STATE') return;
    consumePayload(JSON.stringify(state), source);
}

function readStorageState() {
    try {
        consumePayload(localStorage.getItem(STORAGE_KEY), 'storage');
    } catch (error) {}
}

function unwrapStreamerBotPayload(raw) {
    if (raw && raw.data && typeof raw.data === 'object' && raw.data.data) {
        try { return JSON.parse(raw.data.data); } catch (error) { return null; }
    }
    if (raw && raw.type) return raw;
    return null;
}

async function createStreamerBotAuthentication(password, salt, challenge) {
    const encoder = new TextEncoder();
    const toBase64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const secretBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password + salt));
    const secret = toBase64(secretBuffer);
    const authBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(secret + challenge));
    return toBase64(authBuffer);
}

function clearWidgetFallbackSubscribe() {
    clearTimeout(widgetWsFallbackSubscribeTimeout);
    widgetWsFallbackSubscribeTimeout = null;
}

function subscribeWidgetToStreamerBotEvents(socket = widgetWs) {
    if (socket && socket === widgetWs && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ request: 'Subscribe', events: { General: ['Custom'] }, id: 'WidgetSub' }));
        widgetWsSubscribed = true;
        clearWidgetFallbackSubscribe();
    }
}

async function handleWidgetStreamerBotHello(raw, socket = widgetWs) {
    if (socket !== widgetWs) return;
    clearWidgetFallbackSubscribe();

    if (raw.authentication) {
        if (!WIDGET_WS_PASS) return;
        try {
            const authentication = await createStreamerBotAuthentication(WIDGET_WS_PASS, raw.authentication.salt, raw.authentication.challenge);
            if (socket === widgetWs && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ request: 'Authenticate', authentication, id: 'WidgetAuth' }));
            }
        } catch (error) {}
        return;
    }

    subscribeWidgetToStreamerBotEvents(socket);
}

function connectWidgetWebsocket() {
    if (typeof WebSocket === 'undefined') return;
    clearTimeout(widgetWsReconnectTimeout);
    clearWidgetFallbackSubscribe();
    widgetWsSubscribed = false;
    const socket = new WebSocket(buildStreamerBotWebsocketUrl(WIDGET_WS_HOST, WIDGET_WS_PORT));
    widgetWs = socket;

    socket.onopen = () => {
        if (socket !== widgetWs || WIDGET_WS_PASS) return;
        widgetWsFallbackSubscribeTimeout = setTimeout(() => {
            if (socket === widgetWs && !widgetWsSubscribed) {
                subscribeWidgetToStreamerBotEvents(socket);
            }
        }, 750);
    };

    socket.onmessage = async event => {
        if (socket !== widgetWs) return;
        try {
            const raw = JSON.parse(event.data.toString());
            if (raw.request === 'Hello') {
                await handleWidgetStreamerBotHello(raw, socket);
                return;
            }
            if (raw.id === 'WidgetSub') {
                if (raw.status === 'ok') widgetWsSubscribed = true;
                return;
            }
            if (raw.id === 'WidgetAuth') {
                if (raw.status === 'ok') subscribeWidgetToStreamerBotEvents(socket);
                return;
            }

            handleWidgetState(unwrapStreamerBotPayload(raw), 'streamerbot');
        } catch (error) {}
    };

    socket.onerror = () => {
        if (socket !== widgetWs) return;
        try { socket.close(); } catch (error) {}
    };

    socket.onclose = () => {
        if (socket !== widgetWs) return;
        clearWidgetFallbackSubscribe();
        widgetWsSubscribed = false;
        widgetWsReconnectTimeout = setTimeout(connectWidgetWebsocket, 5000);
    };
}

try {
    if ('BroadcastChannel' in window) {
        const channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = event => handleWidgetState(event.data, 'broadcast');
    }
} catch (error) {}

window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) consumePayload(event.newValue, 'storage-event');
    if (event.key === WIDGET_AUDIO_LOCK_KEY) handleWidgetAudioLockChange();
});

function monitorWidgetConnection() {
    if (!lastWidgetStateAt || Date.now() - lastWidgetStateAt > WIDGET_CONNECTION_MESSAGE_DELAY_MS) {
        stopWidgetAudio();
        renderWidgetStatus('ui_widget_waiting_player', 'connection');
    }
}

renderWidgetStatus('ui_widget_waiting_player', 'connection');
readStorageState();
connectWidgetWebsocket();
setInterval(readStorageState, 500);
setInterval(monitorWidgetConnection, 1000);
} else {
        // =========================================================================
        // PROJECT VERSION AND GITHUB DATA
        // =========================================================================
        const PROJECT_NAME = "Better Song Request";
        const CURRENT_VERSION = "v1.2.4";
        const GITHUB_REPO = "xHackMe/ytm-song-request-streamerbot";
        const REQUIRED_STREAMERBOT_IMPORT_VERSION = "1.0.3";
        const STREAMERBOT_DIAGNOSTICS_ACTION = "YtmImportDiagnostics";
        const SETTINGS_BACKUP_TYPE = "BETTER_SONG_REQUEST_SETTINGS_BACKUP";
        const LEGACY_SETTINGS_BACKUP_TYPES = ["YTM_SONG_REQUEST_SETTINGS_BACKUP"];
        const REQUIRED_IMPORT_FEATURES = [
            { key: 'IMPORT_DIAGNOSTICS', label: 'YtmImportDiagnostics' },
            { key: 'CHAT_MESSAGE', label: 'ChatMessage' },
            { key: 'SONG_REQUEST_SETTINGS', label: 'SongRequestSettings' },
            { key: 'NOW_PLAYING_WIDGET_STATE', label: 'NowPlayingWidgetState' },
            { key: 'VOTE_SKIP', label: 'SongVoteSkip / !voteskip' }
        ];
        const REQUIRED_IMPORT_COMPONENTS = {
            actions: [
                { id: '94d7e904-65a5-4bc9-b740-5db4b15fb384', name: 'SongRequest' },
                { id: '20ca3b4c-2f87-4c87-8fe0-1a45d03fabda', name: 'SongSkip' },
                { id: '1dca93a1-93f4-4ccc-968a-ac0d51a36b48', name: 'SongName' },
                { id: '31afbb0e-1bd6-401d-a688-c74f4638a327', name: 'ChatMessage' },
                { id: '5dbca670-b09f-455c-be38-45efc897449e', name: 'SongWrong' },
                { id: '0ab19324-7816-4a2f-85b6-4485bb7559c2', name: 'SongVolume' },
                { id: '93c93f58-a2c0-44aa-9fcc-21eca6bd3639', name: 'SongRequestForce' },
                { id: '2810ecba-ba84-4a87-a876-db4ee21e7a67', name: 'SongPlay' },
                { id: '0bd4f3b1-a85e-47a5-b555-90047baf9a31', name: 'SongPause' },
                { id: 'dca0e174-4cb8-45aa-b319-254c7969bbf3', name: 'SongStop' },
                { id: '7b511689-cf6f-499e-a06e-980978bb4376', name: 'SongRequestSettings' },
                { id: '481f0f0a-dfae-4152-ad60-90ad1750b981', name: 'NowPlayingWidgetState' },
                { id: 'f878f3d8-096f-4e9a-b9f0-024c1458e8c1', name: 'SongVoteSkip' },
                { name: 'YtmImportDiagnostics' }
            ],
            commands: [
                { id: '16422aad-ca07-43c6-b527-dc8f0a2f7c13', name: '!sr', aliases: ['!sr'], action: 'SongRequest' },
                { id: 'a306e7a2-e751-4f2d-8da9-1cb7190c937a', name: '!srForce', aliases: ['!srForce', '!srforce'], action: 'SongRequestForce' },
                { id: 'cfe7edd2-1ac5-49bf-bc06-1f7f96848937', name: '!song', aliases: ['!song', '!songname'], action: 'SongName' },
                { id: 'f0c06e4b-adf2-4224-9187-7d67a8a83451', name: '!skip', aliases: ['!skip', '!skipsong'], action: 'SongSkip' },
                { id: '5c6af3b5-f713-48ed-83bf-23c948ef9c37', name: '!voteskip', aliases: ['!voteskip', '!skipvote'], action: 'SongVoteSkip' },
                { id: 'c20bddc3-36d8-4a9f-b0e1-a507233b0c40', name: '!wrongsong', aliases: ['!wrongsong', '!songwrong'], action: 'SongWrong' },
                { id: '2c49515d-e91f-4078-a7fb-f24268ea4abb', name: '!volume', aliases: ['!volume', '!vol'], action: 'SongVolume' },
                { id: '20eb9753-9b5e-4e69-b81e-c606903bdc35', name: '!play', aliases: ['!play'], action: 'SongPlay' },
                { id: 'e520cf7f-b787-4ea8-b9c2-9af312730ed5', name: '!pause', aliases: ['!pause'], action: 'SongPause' },
                { id: '33a78c74-c9bd-4ae3-b7ca-2e269967d824', name: '!stop', aliases: ['!stop'], action: 'SongStop' }
            ]
        };
        
        function renderBranding() {
            document.title = `${PROJECT_NAME} ${CURRENT_VERSION}`;
            const brandNameEl = document.getElementById('app-brand-name');
            const footerProjectEl = document.getElementById('footer-project-name');
            const faviconLink = document.querySelector('link[rel~="icon"]');
            const brandFaviconEl = document.getElementById('app-brand-favicon');
            if (brandNameEl) brandNameEl.innerText = PROJECT_NAME;
            if (footerProjectEl) footerProjectEl.innerText = PROJECT_NAME;
            if (brandFaviconEl && faviconLink) brandFaviconEl.src = faviconLink.href;
        }

        renderBranding();
        document.getElementById('app-version-display').innerText = CURRENT_VERSION;
        if (document.getElementById('import-version-display')) {
            document.getElementById('import-version-display').innerText = `Import ${REQUIRED_STREAMERBOT_IMPORT_VERSION}`;
        }

        function isTestVersion(version) {
            return /t$/i.test(String(version || '').trim());
        }

        function renderTestVersionBadge() {
            const updateBtn = document.getElementById('update-btn');
            if (!updateBtn) return;
            updateBtn.style.display = 'block';
            updateBtn.removeAttribute('data-version');
            updateBtn.setAttribute('data-test-version', 'true');
            updateBtn.innerText = t('ui_test_version');
            updateBtn.onclick = null;
        }
        
        async function checkGithubUpdates() {
            const localIsTestVersion = isTestVersion(CURRENT_VERSION);
            if (localIsTestVersion) renderTestVersionBadge();

            try {
                // Use 'no-store' to always fetch fresh data and bypass the browser cache.
                let res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases`, {
                    cache: 'no-store',
                    headers: { 'Accept': 'application/vnd.github.v3+json' }
                });
                
                if (!res.ok) return;
                let releases = await res.json();
                
                if (releases && releases.length > 0) {
                    let latest = releases[0];
                    
                    // Compare versions safely by trimming spaces, lowercasing, and removing the leading "v".
                    let cleanLocalVer = CURRENT_VERSION.trim().toLowerCase().replace(/^v/, '');
                    let cleanGithubVer = latest.tag_name.trim().toLowerCase().replace(/^v/, '');
                    
                    console.log(`[Update Check] Local: ${cleanLocalVer} | GitHub: ${cleanGithubVer}`);

                    // 1. Update button logic
                    if (localIsTestVersion) {
                        renderTestVersionBadge();
                    } else if (cleanLocalVer !== cleanGithubVer) {
                        const updateBtn = document.getElementById('update-btn');
                        updateBtn.style.display = 'block';
                        updateBtn.removeAttribute('data-test-version');
                        updateBtn.setAttribute('data-version', latest.tag_name); 
                        updateBtn.innerText = t('ui_update_btn', {version: latest.tag_name});
                        updateBtn.onclick = () => window.open(latest.html_url, '_blank');
                    } else {
                        document.getElementById('update-btn').style.display = 'none';
                    }

                    // 2. Changelog rendering
                    const clContent = document.getElementById('changelog-content');
                    clContent.innerHTML = '';
                    
                    releases.forEach(rel => {
                        let date = new Date(rel.published_at).toLocaleDateString();
                        
                        // Compare each changelog entry against the current version safely.
                        let cleanRelVer = rel.tag_name.trim().toLowerCase().replace(/^v/, '');
                        let isCurrent = (cleanRelVer === cleanLocalVer) 
                            ? '<span class="ex-style-061">(Your Version)</span>' 
                            : '';
                        
                        let bodyText = rel.body || "No release notes provided.";
                        
                        let formattedBody = bodyText.split('\n').map(line => {
                            let trimmed = line.trim();
                            if(trimmed.length === 0) return "<br>";
                            
                            let hasBadge = false;
                            trimmed = trimmed.replace(/^(NEW|FIX|CHANGE|CHG)\s/i, function(match, type) {
                                hasBadge = true;
                                let cssClass = "cl-chg";
                                let tUpper = type.toUpperCase();
                                if(tUpper === "NEW") cssClass = "cl-new";
                                else if (tUpper === "FIX") cssClass = "cl-fix";
                                return `<span class="cl-badge ${cssClass}">${tUpper}</span> `;
                            });

                            if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                                trimmed = trimmed.substring(2);
                                hasBadge = true;
                            }

                            if(hasBadge) return `<li class="ex-style-062">${trimmed}</li>`;
                            return `<div>${trimmed}</div>`;
                        }).join('');

                        clContent.innerHTML += `
                            <div class="changelog-entry">
                                <h4 class="cl-version">
                                    <a href="${rel.html_url}" target="_blank" title="View this release on GitHub" class="ex-style-063">
                                        ${rel.name || rel.tag_name}
                                    </a> 
                                    ${isCurrent} 
                                    <span class="cl-date">${date}</span>
                                </h4>
                                <div class="cl-body"><ul class="ex-style-064">${formattedBody}</ul></div>
                            </div>
                        `;
                    });
                } else {
                    document.getElementById('changelog-content').innerHTML = '<div class="ex-style-065">No releases found on GitHub.</div>';
                }
            } catch(e) {
                console.error("GitHub API Error:", e);
                document.getElementById('changelog-content').innerHTML = '<div class="ex-style-066">Error loading changelog from GitHub.</div>';
            }
        }

        // =========================================================================
        function normalizePositiveInteger(value, fallback) {
            const parsed = parseInt(value, 10);
            return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
        }

        const CUSTOM_MSGS_DISABLED_PREFIX = 'ytm_custom_msgs_disabled_';

        let currentLang = localStorage.getItem('ytm_lang') || 'en';
        let customMsgs = JSON.parse(localStorage.getItem('ytm_custom_msgs_' + currentLang)) || {};
        let disabledCustomMsgs = JSON.parse(localStorage.getItem(CUSTOM_MSGS_DISABLED_PREFIX + currentLang)) || {};

        function dateOnly(date) {
            return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        }

        function isLocalDateInRange(date, range) {
            const year = date.getFullYear();
            const current = dateOnly(date);
            for (let offset = -1; offset <= 1; offset++) {
                const startYear = year + offset;
                const endYear = range.em < range.sm ? startYear + 1 : startYear;
                const start = dateOnly(new Date(startYear, range.sm, range.sd));
                const end = dateOnly(new Date(endYear, range.em, range.ed));
                if (current >= start && current <= end) return true;
            }
            return false;
        }

        function getHolidayVariant(date = new Date()) {
            return HOLIDAY_VARIANTS.find(variant => variant.ranges.some(range => isLocalDateInRange(date, range))) || null;
        }

        function applyHolidayVariant() {
            const themeClasses = HOLIDAY_VARIANTS.map(variant => variant.className);
            document.body.classList.remove(...themeClasses);
            activeHolidayVariant = getHolidayVariant(new Date());

            const messageEl = document.getElementById('holiday-message');
            if (activeHolidayVariant) {
                document.body.classList.add(activeHolidayVariant.className);
                if (messageEl) messageEl.innerText = t(activeHolidayVariant.messageKey);
            } else if (messageEl) {
                messageEl.innerText = '';
            }
        }

        function isHolidayStartupSong(song) {
            return song && song.user === 'Auto' && HOLIDAY_VARIANTS.some(variant => variant.song.id === song.id);
        }

        function refreshHolidayVariant() {
            const previousHolidayKey = activeHolidayVariant ? activeHolidayVariant.key : null;
            applyHolidayVariant();

            if (previousHolidayKey && !activeHolidayVariant && isHolidayStartupSong(currentSongInfo) && player && player.getPlayerState && player.getPlayerState() !== 1) {
                currentSongInfo = null;
                currentSongStopped = false;
                initialSongLoaded = false;
                renderQueue();
                loadInitialPlayerSong();
            }
        }

        function t(key, vars = {}) {
            let dict = i18n[currentLang] || i18n['en'];
            
            let text = dict[key] || i18n['en'][key] || key;
            if (key.startsWith('msg_') && disabledCustomMsgs[key]) {
                return '';
            }
            if (key.startsWith('msg_') && customMsgs[key]) {
                text = customMsgs[key];
            }

            for (let k in vars) {
                text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), vars[k]);
            }
            return text;
        }

        function changeLanguage(langCode) {
            currentLang = langCode;
            localStorage.setItem('ytm_lang', langCode);
            customMsgs = JSON.parse(localStorage.getItem('ytm_custom_msgs_' + currentLang)) || {};
            disabledCustomMsgs = JSON.parse(localStorage.getItem(CUSTOM_MSGS_DISABLED_PREFIX + currentLang)) || {};
            
            applyTranslations();
            log(`🌐 Language changed to: ${langCode.toUpperCase()}`);

            if(document.getElementById('settings-modal').style.display === 'flex') {
                renderSettingsMessages();
            }

            updateWidgetUrlDisplay();

            if(ws) {
                ws.onclose = null; 
                ws.close();
                clearTimeout(wsReconnectTimeout);
                connectWebsocket();
            }
        }

        function renderFooterVersions() {
            renderBranding();
            const appVersionEl = document.getElementById('app-version-display');
            const importVersionEl = document.getElementById('import-version-display');
            if (appVersionEl) appVersionEl.innerText = CURRENT_VERSION;
            if (importVersionEl) importVersionEl.innerText = `${t('ui_import_version_short')} ${REQUIRED_STREAMERBOT_IMPORT_VERSION}`;
        }

        function applyTranslations() {
            if(document.getElementById('lang-select')) document.getElementById('lang-select').value = currentLang;
            if(document.getElementById('tut-lang-select')) document.getElementById('tut-lang-select').value = currentLang;
            
            applyHolidayVariant();
            document.querySelectorAll('[data-i18n]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n')); });
            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
            document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });

            // UPDATE BUTTON DYNAMIC TRANSLATION:
            const updateBtn = document.getElementById('update-btn');
            if (updateBtn && updateBtn.getAttribute('data-test-version')) {
                updateBtn.innerText = t('ui_test_version');
            } else if (updateBtn && updateBtn.getAttribute('data-version')) {
                updateBtn.innerText = t('ui_update_btn', {version: updateBtn.getAttribute('data-version')});
            }

            renderBaseList();
            renderQueue();
            if(document.getElementById('ban-modal').style.display === 'flex') renderBanList();
            if(document.getElementById('playlist-modal').style.display === 'flex') renderPlaylistManager();
            
            updateApiStatusUI(document.getElementById('api-status-icon').getAttribute('data-last-status') || 'init');
            
            renderBaseActionButtons();
            renderFooterVersions();
            renderViewerHistory();
            
            updateTutLink(); 
            renderWebsocketStatus();
            renderImportStatusBanner();
            renderDiagnosticsResults();
        }

        // =========================================================================
        let API_KEY = localStorage.getItem('ytm_api_key') || ''; 
        let WS_HOST = normalizeWebsocketHost(localStorage.getItem('ytm_ws_host') || DEFAULT_STREAMERBOT_WS_HOST);
        let WS_PORT = localStorage.getItem('ytm_ws_port') || '8080';
        let WS_PASS = localStorage.getItem('ytm_ws_pass') || '';
        let wsConnectionAttempt = 0;
        let wsStreamerBotReady = false;
        let wsStatusKey = 'ui_bot_connecting';
        let wsStatusColor = '#ffaa00';
        const QUEUE_STORAGE_KEY = 'ytm_persisted_queue';
        const FAVORITE_SONGS_STORAGE_KEY = 'ytm_favorite_songs';
        const VIEWER_HISTORY_STORAGE_KEY = 'ytm_viewer_song_history';
        const VIEWER_HISTORY_LIMIT = 1000;
        let SHOULD_PERSIST_QUEUE = localStorage.getItem('ytm_persist_queue') === 'true';
        let queuePersistenceReady = false;
        let SR_MAX_DURATION_MINUTES = normalizePositiveInteger(localStorage.getItem('ytm_sr_max_duration_minutes'), 15);
        let SR_REQUIRE_MUSIC_CATEGORY = localStorage.getItem('ytm_sr_require_music_category') !== 'false';
        let SR_VOTESKIP_REQUIRED = normalizePositiveInteger(localStorage.getItem('ytm_sr_voteskip_required'), 5);
        let SR_USER_QUEUE_LIMIT = normalizePositiveInteger(localStorage.getItem('ytm_sr_user_queue_limit'), 25);
        let SR_GLOBAL_QUEUE_LIMIT = normalizePositiveInteger(localStorage.getItem('ytm_sr_global_queue_limit'), 100);
        let SR_USER_QUEUE_LIMIT_ENABLED = localStorage.getItem('ytm_sr_user_queue_limit_enabled') === 'true';
        let SR_GLOBAL_QUEUE_LIMIT_ENABLED = localStorage.getItem('ytm_sr_global_queue_limit_enabled') === 'true';
        let voteSkipUsers = new Set();
        let initialSongLoaded = false;
        let activeHolidayVariant = null;
        const DEFAULT_STARTUP_SONGS = [
            { id: 'JGwWNGJdvx8', title: 'Ed Sheeran - Shape of You', author: 'Ed Sheeran', duration: 263, user: 'Auto' },
            { id: 'kJQP7kiw5Fk', title: 'Luis Fonsi - Despacito ft. Daddy Yankee', author: 'Luis Fonsi', duration: 282, user: 'Auto' },
            { id: 'fJ9rUzIMcZQ', title: 'Queen - Bohemian Rhapsody', author: 'Queen', duration: 354, user: 'Auto' },
            { id: 'hT_nvWreIhg', title: 'OneRepublic - Counting Stars', author: 'OneRepublic', duration: 257, user: 'Auto' }
        ];
        const HOLIDAY_VARIANTS = [
		//	{ key: 'TEST', className: 'theme-christmas', messageKey: 'ui_holiday_christmas', ranges: [{ sm: 0, sd: 1, em: 11, ed: 31 }], song: { id: 'aAkMkVFwAoo', title: 'Mariah Carey - All I Want for Christmas Is You', author: 'Mariah Carey', duration: 241, user: 'Auto' } },
		//	{ key: 'TEST', className: 'theme-newyear', messageKey: 'ui_holiday_newyear', ranges: [{ sm: 0, sd: 1, em: 11, ed: 31 }], song: { id: '9jK-NcRmVcw', title: 'Europe - The Final Countdown', author: 'Europe', duration: 318, user: 'Auto' } },
		// 	{ key: 'TEST', className: 'theme-valentine', messageKey: 'ui_holiday_valentine', ranges: [{ sm: 0, sd: 1, em: 11, ed: 31 }], song: { id: '2Vv-BfVoq4g', title: 'Ed Sheeran - Perfect', author: 'Ed Sheeran', duration: 263, user: 'Auto' } },
		//	{ key: 'TEST', className: 'theme-april', messageKey: 'ui_holiday_april', ranges: [{ sm: 0, sd: 1, em: 11, ed: 31 }], song: { id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', author: 'Rick Astley', duration: 213, user: 'Auto' } },
            { key: 'christmas', className: 'theme-christmas', messageKey: 'ui_holiday_christmas', ranges: [{ sm: 11, sd: 24, em: 11, ed: 27 }], song: { id: 'aAkMkVFwAoo', title: 'Mariah Carey - All I Want for Christmas Is You', author: 'Mariah Carey', duration: 241, user: 'Auto' } },
            { key: 'newyear', className: 'theme-newyear', messageKey: 'ui_holiday_newyear', ranges: [{ sm: 11, sd: 31, em: 0, ed: 1 }], song: { id: '9jK-NcRmVcw', title: 'Europe - The Final Countdown', author: 'Europe', duration: 318, user: 'Auto' } },
            { key: 'valentine', className: 'theme-valentine', messageKey: 'ui_holiday_valentine', ranges: [{ sm: 1, sd: 14, em: 1, ed: 14 }], song: { id: '2Vv-BfVoq4g', title: 'Ed Sheeran - Perfect', author: 'Ed Sheeran', duration: 263, user: 'Auto' } },
            { key: 'april', className: 'theme-april', messageKey: 'ui_holiday_april', ranges: [{ sm: 3, sd: 1, em: 3, ed: 1 }], song: { id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', author: 'Rick Astley', duration: 213, user: 'Auto' } }
        ];
        const NOW_PLAYING_WIDGET_KEY = 'ytm_now_playing_widget_state';
        const NOW_PLAYING_WIDGET_CHANNEL = 'ytm_now_playing_widget';
        const NOW_PLAYING_STREAMERBOT_ACTION = 'NowPlayingWidgetState';
        const NOW_PLAYING_STREAMERBOT_PUSH_INTERVAL = 500;
        const WIDGET_LAST_COPIED_URL_KEY = 'ytm_widget_url_last_copied';
        let nowPlayingWidgetChannel = null;
        let lastNowPlayingStreamerBotPush = 0;
        let nowPlayingWidgetStartupBurstTimeouts = [];
        let WIDGET_AUDIO_ENABLED_CONFIG = localStorage.getItem('ytm_widget_audio_enabled') === 'true';
        let widgetUrlBaseline = '';
        let widgetUrlWarningEnabled = false;
        let widgetTestState = null;
        let widgetTestStateUntil = 0;
        let importStatusState = 'unknown';
        let importStatusMissingItems = [];
        let importStatusVersion = '';
        let importDiagnosticsWaiters = [];
        let streamerBotRequestWaiters = new Map();
        let importStatusCheckTimeout = null;
        let lastDiagnosticsResults = [];
        try {
            if ('BroadcastChannel' in window) nowPlayingWidgetChannel = new BroadcastChannel(NOW_PLAYING_WIDGET_CHANNEL);
        } catch (error) {
            nowPlayingWidgetChannel = null;
        }
        // =========================================================================
        
        let player, ws, wsReconnectTimeout;
        let masterList = [];   
        let playQueue = [];     
        let playHistory = [];   
        let currentSongInfo = null; 
        let currentSongStopped = false;
        let nowPlayingWaveEffect = '';
        let nowPlayingWaveEffectUntil = 0;
        let nowPlayingWaveEffectId = 0;
        let nowPlayingWaveHoldUntilStart = false;
        let skipTransitionTimeout = null;
        let stopTransitionTimeout = null;
        let titleCache = {};    
        let favoriteSongs = loadFavoriteSongs();
        hydrateFavoriteTitleCache();
        let viewerSongHistory = loadViewerSongHistory();
        hydrateViewerHistoryTitleCache();
        let dragSourceIndex = null;
        let favoriteDragSourceIndex = null;
        let playlistDragSourceIndex = null;
        let isSrEnabled = false; 
        let basePlaybackMode = 'ordered';
        let baseActionButtonMode = API_KEY ? 'downloading' : 'api-required';

        function bindStaticUiEvents() {
            const actionHandlers = {
                openPlaylistManager, startSystem, startSystemShuffle, openSettings, prevSong, togglePlay,
                stopSongUI, skipSong, addManualUrl, openBanList, toggleDebug,
                openChangelog, openTutorial, closeSettings, switchSettingsTab,
                saveWsConfig, toggleApiVisibility, saveApiKey, closeChangelog,
                clearAllBans, closeBanList, closePlaylistManager, addBasePlaylist,
                closeTutorial, copySbCode, copyWidgetUrl, clearQueueWithConfirm,
                runDiagnostics, checkImportStatus, exportSettings, chooseSettingsImport,
                sendWidgetTest, openViewerHistory, closeViewerHistory, clearViewerHistoryWithConfirm
            };

            const changeHandlers = { toggleSR, handleQueuePersistenceToggle, saveSongRequestSettings, handleWidgetAudioToggle, importSettingsFile, renderViewerHistory };
            const inputHandlers = { renderBaseList, updateTutLink, saveSongRequestSettings, updateWidgetUrlDisplay, renderViewerHistory };

            document.querySelectorAll('[data-action]').forEach(el => {
                el.addEventListener('click', () => {
                    const handler = actionHandlers[el.dataset.action];
                    if (!handler) return;
                    if (el.dataset.actionValue !== undefined) handler(el.dataset.actionValue);
                    else handler();
                });
            });

            document.querySelectorAll('[data-change-action]').forEach(el => {
                el.addEventListener('change', () => {
                    if (el.dataset.changeAction === 'changeLanguage') changeLanguage(el.value);
                    else if (changeHandlers[el.dataset.changeAction]) changeHandlers[el.dataset.changeAction]();
                });
            });

            document.querySelectorAll('[data-input-action]').forEach(el => {
                el.addEventListener('input', () => {
                    const handler = inputHandlers[el.dataset.inputAction];
                    if (handler) handler();
                });
            });
        }

        bindStaticUiEvents();
        const wsHostInput = document.getElementById('ws-host-input');
        const wsPortInput = document.getElementById('ws-port-input');
        const wsPassInput = document.getElementById('ws-pass-input');
        const tutWsPortInput = document.getElementById('tut-ws-port');
        const queuePersistInput = document.getElementById('queue-persist-cb');
        const srMaxDurationInput = document.getElementById('sr-max-duration-input');
        const srVoteSkipInput = document.getElementById('sr-voteskip-input');
        const srUserLimitInput = document.getElementById('sr-user-limit-input');
        const srGlobalLimitInput = document.getElementById('sr-global-limit-input');
        const srUserLimitEnabledInput = document.getElementById('sr-user-limit-enabled-cb');
        const srGlobalLimitEnabledInput = document.getElementById('sr-global-limit-enabled-cb');
        const srMusicCategoryInput = document.getElementById('sr-music-category-cb');
        const widgetAudioInput = document.getElementById('widget-audio-cb');

        if (wsHostInput) wsHostInput.value = WS_HOST;
        if (wsPortInput) wsPortInput.value = WS_PORT;
        if (wsPassInput) wsPassInput.value = WS_PASS;
        if (tutWsPortInput) tutWsPortInput.value = WS_PORT;
        if (queuePersistInput) queuePersistInput.checked = SHOULD_PERSIST_QUEUE;
        if (srMaxDurationInput) srMaxDurationInput.value = SR_MAX_DURATION_MINUTES;
        if (srVoteSkipInput) srVoteSkipInput.value = SR_VOTESKIP_REQUIRED;
        if (srUserLimitInput) srUserLimitInput.value = SR_USER_QUEUE_LIMIT;
        if (srGlobalLimitInput) srGlobalLimitInput.value = SR_GLOBAL_QUEUE_LIMIT;
        if (srUserLimitEnabledInput) srUserLimitEnabledInput.checked = SR_USER_QUEUE_LIMIT_ENABLED;
        if (srGlobalLimitEnabledInput) srGlobalLimitEnabledInput.checked = SR_GLOBAL_QUEUE_LIMIT_ENABLED;
        if (srMusicCategoryInput) srMusicCategoryInput.checked = SR_REQUIRE_MUSIC_CATEGORY;
        if (widgetAudioInput) widgetAudioInput.checked = WIDGET_AUDIO_ENABLED_CONFIG;
        updateSongRequestLimitInputStates();

        applyHolidayVariant();
        window.addEventListener('focus', refreshHolidayVariant);
        window.addEventListener('pageshow', refreshHolidayVariant);
        setInterval(refreshHolidayVariant, 30000);
        setInterval(updateNowPlayingProgress, 500);
        
        window.onload = () => { 
            applyTranslations(); 
            checkGithubUpdates(); 
        };

        // ===================== SETTINGS MODAL =====================
        function openSettings() { 
            document.getElementById('api-key-input').value = API_KEY;
            widgetUrlBaseline = getWidgetUrl();
            widgetUrlWarningEnabled = true;
            updateWidgetUrlDisplay();
            renderSettingsMessages();
            document.getElementById('settings-modal').style.display = 'flex'; 
        }
        function closeSettings() { document.getElementById('settings-modal').style.display = 'none'; }
        
        function switchSettingsTab(tabName) {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
            document.getElementById(`tab-btn-${tabName}`).classList.add('active');
            document.getElementById(`tab-content-${tabName}`).classList.add('active');
        }

        function showToast(message, type = 'normal', durationMs = 6500) {
            const rootEl = document.getElementById('toast-root');
            if (!rootEl) return;
            const toast = document.createElement('div');
            toast.className = 'toast' + (type === 'error' ? ' is-error' : (type === 'ok' ? ' is-ok' : (type === 'warn' ? ' is-warn' : '')));
            toast.textContent = message;
            rootEl.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(8px)';
                setTimeout(() => toast.remove(), 180);
            }, Math.max(1200, durationMs));
        }

        function showConfirm(message, onConfirm, options = {}) {
            const modal = document.getElementById('confirm-modal');
            const titleEl = document.getElementById('confirm-title');
            const messageEl = document.getElementById('confirm-message');
            const okBtn = document.getElementById('confirm-ok-btn');
            const cancelBtn = document.getElementById('confirm-cancel-btn');
            if (!modal || !messageEl || !okBtn || !cancelBtn) return;

            titleEl.innerText = options.title || t('ui_confirm_title');
            messageEl.innerText = message;
            okBtn.innerText = options.okText || t('ui_confirm_ok');
            cancelBtn.innerText = options.cancelText || t('ui_confirm_cancel');

            const cleanup = () => {
                modal.style.display = 'none';
                okBtn.onclick = null;
                cancelBtn.onclick = null;
            };

            okBtn.onclick = () => {
                cleanup();
                if (typeof onConfirm === 'function') onConfirm();
            };
            cancelBtn.onclick = cleanup;
            modal.style.display = 'flex';
        }

        function normalizeDiagnosticId(value) {
            return String(value || '').trim().toLowerCase();
        }

        function isComponentEnabled(component) {
            if (!component || typeof component !== 'object') return false;
            if (component.enabled === false || component.isEnabled === false || component.active === false) return false;
            if (component.disabled === true || component.isDisabled === true) return false;
            const textValue = String(component.enabled ?? component.isEnabled ?? component.active ?? '').toLowerCase();
            if (textValue === 'false' || textValue === 'disabled' || textValue === '0') return false;
            return true;
        }

        function componentName(component) {
            return component && (component.name || component.Name || component.title || component.id || component.Id || '');
        }

        function componentId(component) {
            return component && (component.id || component.Id || component.actionId || component.commandId || component.queueId || '');
        }

        function findComponent(list, required) {
            if (!Array.isArray(list)) return null;
            const requiredName = normalizeDiagnosticId(required.name);
            const requiredId = normalizeDiagnosticId(required.id);
            return list.find(item => {
                const itemName = normalizeDiagnosticId(componentName(item));
                const itemId = normalizeDiagnosticId(componentId(item));
                return (requiredId && itemId === requiredId) || (requiredName && itemName === requiredName);
            }) || null;
        }

        function collectArraysByKey(value, keys, found = [], visited = new Set()) {
            if (!value || typeof value !== 'object' || visited.has(value)) return found;
            visited.add(value);

            Object.keys(value).forEach(key => {
                const child = value[key];
                if (keys.includes(key.toLowerCase()) && Array.isArray(child)) found.push(child);
                else if (child && typeof child === 'object') collectArraysByKey(child, keys, found, visited);
            });

            return found;
        }

        function extractComponentList(response, keys) {
            if (!response || typeof response !== 'object') return null;
            const arrays = collectArraysByKey(response, keys.map(key => key.toLowerCase()));
            if (!arrays.length) return null;
            return arrays.find(array => array.length > 0) || arrays[0];
        }

        function getCommandAliases(command) {
            const raw = [
                command.command,
                command.commands,
                command.value,
                command.name
            ].filter(Boolean).join('\n');
            return raw
                .split(/[\r\n,]+/)
                .map(alias => normalizeDiagnosticId(alias))
                .filter(Boolean);
        }

        function getActionTriggerCommandIds(action) {
            const triggers = Array.isArray(action && action.triggers) ? action.triggers : [];
            return triggers.map(trigger => normalizeDiagnosticId(
                typeof trigger === 'string'
                    ? trigger
                    : (trigger.commandId || trigger.command || trigger.id || trigger.Id)
            )).filter(Boolean);
        }

        function summarizeImportProblems(items, limit = 6) {
            if (!Array.isArray(items) || items.length === 0) return '';
            const visible = items.slice(0, limit);
            const extra = items.length - visible.length;
            return visible.join(', ') + (extra > 0 ? ', ' + t('ui_import_problem_more', { count: extra }) : '');
        }

        function resolveStreamerBotRequest(raw) {
            if (!raw || !raw.id || !streamerBotRequestWaiters.has(raw.id)) return false;
            const waiter = streamerBotRequestWaiters.get(raw.id);
            streamerBotRequestWaiters.delete(raw.id);
            clearTimeout(waiter.timeoutId);
            waiter.resolve(raw);
            return true;
        }

        function requestStreamerBotApi(requestName, extra = {}, timeoutMs = 1800) {
            if (!canUseStreamerBotWebsocket()) return Promise.resolve(null);
            const id = requestName + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

            return new Promise(resolve => {
                const timeoutId = setTimeout(() => {
                    streamerBotRequestWaiters.delete(id);
                    resolve(null);
                }, timeoutMs);

                streamerBotRequestWaiters.set(id, { resolve, timeoutId });

                try {
                    ws.send(JSON.stringify({ request: requestName, id, ...extra }));
                } catch (error) {
                    clearTimeout(timeoutId);
                    streamerBotRequestWaiters.delete(id);
                    resolve(null);
                }
            });
        }

        async function inspectStreamerBotImportComponents() {
            if (!canUseStreamerBotWebsocket()) {
                return { issues: [], warnings: [t('ui_diag_ws_fail')], checked: { actions: false, commands: false } };
            }

            const [actionsResponse, commandsResponse] = await Promise.all([
                requestStreamerBotApi('GetActions'),
                requestStreamerBotApi('GetCommands')
            ]);

            const actions = extractComponentList(actionsResponse, ['actions']);
            const commands = extractComponentList(commandsResponse, ['commands']);
            const issues = [];
            const warnings = [];

            if (!actions) {
                warnings.push(t('ui_import_live_actions_unavailable'));
            } else {
                REQUIRED_IMPORT_COMPONENTS.actions.forEach(required => {
                    const action = findComponent(actions, required);
                    if (!action) {
                        issues.push(t('ui_import_problem_missing', { type: t('ui_import_component_action'), name: required.name }));
                        return;
                    }
                    if (!isComponentEnabled(action)) issues.push(t('ui_import_problem_disabled', { type: t('ui_import_component_action'), name: required.name }));
                });
            }

            if (!commands) {
                warnings.push(t('ui_import_live_commands_unavailable'));
            } else {
                REQUIRED_IMPORT_COMPONENTS.commands.forEach(required => {
                    const command = findComponent(commands, required);
                    if (!command) {
                        issues.push(t('ui_import_problem_missing', { type: t('ui_import_component_command'), name: required.name }));
                        return;
                    }
                    if (!isComponentEnabled(command)) issues.push(t('ui_import_problem_disabled', { type: t('ui_import_component_command'), name: required.name }));

                    const aliases = getCommandAliases(command);
                    required.aliases.forEach(alias => {
                        if (!aliases.includes(normalizeDiagnosticId(alias))) {
                            issues.push(t('ui_import_problem_command_alias', { command: required.name, alias }));
                        }
                    });

                    if (actions) {
                        const action = findComponent(actions, { name: required.action });
                        const triggerIds = getActionTriggerCommandIds(action);
                        const commandId = normalizeDiagnosticId(componentId(command));
                        if (action && triggerIds.length > 0 && commandId && !triggerIds.includes(commandId)) {
                            issues.push(t('ui_import_problem_command_link', { command: required.name, action: required.action }));
                        }
                    }
                });
            }

            return {
                issues,
                warnings,
                checked: {
                    actions: !!actions,
                    commands: !!commands
                }
            };
        }

        function getImportValidationResult(payload, componentInspection = null) {
            const version = String((payload && (payload.version || payload.importVersion)) || '').trim();
            const features = new Set(
                Array.isArray(payload && payload.features)
                    ? payload.features.map(feature => String(feature).trim()).filter(Boolean)
                    : []
            );

            const missing = [];
            if (version !== REQUIRED_STREAMERBOT_IMPORT_VERSION) {
                missing.push(t('ui_import_missing_version', {
                    version: REQUIRED_STREAMERBOT_IMPORT_VERSION,
                    current: version || '?'
                }));
            }

            REQUIRED_IMPORT_FEATURES.forEach(feature => {
                if (!features.has(feature.key)) missing.push(feature.label);
            });

            if (componentInspection && Array.isArray(componentInspection.issues)) {
                missing.push(...componentInspection.issues);
            }

            return {
                ok: missing.length === 0,
                version,
                missing,
                warnings: componentInspection && Array.isArray(componentInspection.warnings) ? componentInspection.warnings : [],
                componentInspection
            };
        }

        function renderImportStatusBanner() {
            const banner = document.getElementById('import-status-banner');
            if (!banner) return;

            let message = '';
            let toneClass = '';

            if (importStatusState === 'checking') {
                message = t('ui_import_status_checking');
                toneClass = 'is-warn';
            } else if (importStatusState === 'missing') {
                const missing = importStatusMissingItems.length ? summarizeImportProblems(importStatusMissingItems) : t('ui_import_required');
                message = t('ui_import_status_missing', { missing });
                toneClass = 'is-error';
            }

            banner.className = 'import-status-banner' + (toneClass ? ' ' + toneClass : '') + (message ? '' : ' is-hidden');
            banner.textContent = '';

            if (!message) return;

            const messageEl = document.createElement('span');
            messageEl.className = 'import-status-text';
            messageEl.innerText = message;
            banner.appendChild(messageEl);

            if (importStatusState === 'missing') {
                const helpBtn = document.createElement('button');
                helpBtn.type = 'button';
                helpBtn.className = 'btn-help import-help-btn';
                helpBtn.innerText = t('ui_help_btn');
                helpBtn.addEventListener('click', openTutorial);
                banner.appendChild(helpBtn);
            }
        }

        function setImportStatus(state, missingItems = [], version = '') {
            importStatusState = state;
            importStatusMissingItems = missingItems;
            importStatusVersion = version;
            renderImportStatusBanner();
        }

        function resolveImportDiagnosticsWaiters(payload) {
            const waiters = importDiagnosticsWaiters.splice(0);
            waiters.forEach(waiter => {
                clearTimeout(waiter.timeoutId);
                waiter.resolve(payload);
            });
        }

        function resolveStreamerBotRequestWaiters(payload) {
            streamerBotRequestWaiters.forEach(waiter => {
                clearTimeout(waiter.timeoutId);
                waiter.resolve(payload);
            });
            streamerBotRequestWaiters.clear();
        }

        function handleImportDiagnosticsPayload(payload) {
            const result = getImportValidationResult(payload);
            setImportStatus(result.ok ? 'ok' : 'missing', result.missing, result.version);
            resolveImportDiagnosticsWaiters(payload);
            return result;
        }

        function requestImportDiagnostics(timeoutMs = 2500) {
            if (!canUseStreamerBotWebsocket()) return Promise.resolve(null);

            return new Promise(resolve => {
                const waiter = {
                    resolve,
                    timeoutId: null
                };

                waiter.timeoutId = setTimeout(() => {
                    importDiagnosticsWaiters = importDiagnosticsWaiters.filter(item => item !== waiter);
                    resolve(null);
                }, timeoutMs);

                importDiagnosticsWaiters.push(waiter);

                try {
                    ws.send(JSON.stringify({
                        request: 'DoAction',
                        action: { name: STREAMERBOT_DIAGNOSTICS_ACTION },
                        args: { expectedVersion: REQUIRED_STREAMERBOT_IMPORT_VERSION },
                        id: 'ImportDiagnostics'
                    }));
                } catch (error) {
                    clearTimeout(waiter.timeoutId);
                    importDiagnosticsWaiters = importDiagnosticsWaiters.filter(item => item !== waiter);
                    resolve(null);
                }
            });
        }

        async function checkImportStatus(silent = false) {
            if (!canUseStreamerBotWebsocket()) {
                setImportStatus('unknown');
                if (!silent) showToast(t('ui_diag_ws_fail'), 'error');
                return { ok: false, version: '', missing: [t('ui_diag_ws')] };
            }

            setImportStatus('checking');
            const payload = await requestImportDiagnostics();
            if (!payload) {
                const missing = [
                    t('ui_import_missing_version', { version: REQUIRED_STREAMERBOT_IMPORT_VERSION, current: '?' }),
                    'YtmImportDiagnostics'
                ];
                setImportStatus('missing', missing);
                if (!silent) showToast(t('ui_import_required'), 'error');
                return { ok: false, version: '', missing };
            }

            const componentInspection = await inspectStreamerBotImportComponents();
            const result = getImportValidationResult(payload, componentInspection);
            setImportStatus(result.ok ? 'ok' : 'missing', result.missing, result.version);
            if (!silent) showToast(result.ok ? t('ui_import_status_ok') : t('ui_import_required'), result.ok ? 'ok' : 'error');
            return result;
        }

        function scheduleImportStatusCheck() {
            clearTimeout(importStatusCheckTimeout);
            importStatusCheckTimeout = setTimeout(() => {
                checkImportStatus(true);
            }, 900);
        }

        function renderDiagnosticsResults() {
            const container = document.getElementById('diagnostics-results');
            if (!container) return;

            if (!lastDiagnosticsResults.length) {
                container.innerHTML = `<div class="diagnostic-item diagnostic-muted">${escapeHtml(t('ui_diagnostics_waiting'))}</div>`;
                return;
            }

            container.innerHTML = lastDiagnosticsResults.map(item => {
                const statusClass = item.status === 'ok'
                    ? 'diagnostic-ok'
                    : (item.status === 'warn' ? 'diagnostic-warn' : (item.status === 'error' ? 'diagnostic-error' : 'diagnostic-muted'));
                return `<div class="diagnostic-item ${statusClass}"><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.message)}</div>`;
            }).join('');
        }

        function getRecentWidgetStateAgeSeconds() {
            try {
                const state = JSON.parse(localStorage.getItem(NOW_PLAYING_WIDGET_KEY) || '{}');
                if (!state || state.type !== 'NOW_PLAYING_STATE' || !state.updatedAt) return null;
                return Math.max(0, Math.round((Date.now() - Number(state.updatedAt)) / 1000));
            } catch (error) {
                return null;
            }
        }

        async function runDiagnostics() {
            lastDiagnosticsResults = [
                { title: t('ui_diag_ws'), status: canUseStreamerBotWebsocket() ? 'ok' : 'error', message: canUseStreamerBotWebsocket() ? t('ui_diag_ws_ok') : t('ui_diag_ws_fail') },
                { title: t('ui_diag_import'), status: 'warn', message: t('ui_diag_import_checking') }
            ];
            renderDiagnosticsResults();

            const importResult = await checkImportStatus(true);
            const hasImport = !!(importResult && importResult.ok);
            const componentInspection = importResult && importResult.componentInspection ? importResult.componentInspection : { issues: [], warnings: [] };
            const hasComponentIssues = componentInspection.issues && componentInspection.issues.length > 0;
            const hasComponentWarnings = componentInspection.warnings && componentInspection.warnings.length > 0;
            const hasWidgetStorage = getRecentWidgetStateAgeSeconds() !== null;
            const widgetBridgeReady = hasWidgetStorage || !!nowPlayingWidgetChannel;
            const widgetStateAge = getRecentWidgetStateAgeSeconds();

            lastDiagnosticsResults = [
                { title: t('ui_diag_ws'), status: canUseStreamerBotWebsocket() ? 'ok' : 'error', message: canUseStreamerBotWebsocket() ? t('ui_diag_ws_ok') : t('ui_diag_ws_fail') },
                { title: t('ui_diag_import'), status: hasImport ? 'ok' : 'error', message: hasImport ? t('ui_diag_import_ok', { version: importResult.version || REQUIRED_STREAMERBOT_IMPORT_VERSION }) : t('ui_diag_import_missing', { missing: summarizeImportProblems(importResult.missing || []) }) },
                { title: t('ui_diag_components'), status: hasComponentIssues ? 'error' : (hasComponentWarnings ? 'warn' : 'ok'), message: hasComponentIssues ? t('ui_diag_components_missing', { count: componentInspection.issues.length, details: summarizeImportProblems(componentInspection.issues, 8) }) : (hasComponentWarnings ? summarizeImportProblems(componentInspection.warnings, 4) : t('ui_diag_components_ok')) },
                { title: t('ui_diag_widget_bridge'), status: widgetBridgeReady ? 'ok' : 'error', message: widgetBridgeReady ? t('ui_diag_widget_bridge_ok') : t('ui_diag_widget_bridge_fail') },
                { title: t('ui_diag_settings_sync'), status: hasImport ? 'ok' : 'error', message: hasImport ? t('ui_diag_settings_sync_ok') : t('ui_diag_settings_sync_fail') },
                { title: t('ui_diag_widget_state'), status: widgetStateAge !== null && widgetStateAge <= 10 ? 'ok' : 'warn', message: widgetStateAge !== null && widgetStateAge <= 10 ? t('ui_diag_widget_state_ok', { seconds: widgetStateAge }) : t('ui_diag_widget_state_warn') },
                { title: t('ui_diag_api'), status: API_KEY ? 'ok' : 'warn', message: API_KEY ? t('ui_diag_api_ok') : t('ui_diag_api_warn') }
            ];
            renderDiagnosticsResults();
        }

        function getActiveWidgetPublishState() {
            if (widgetTestState) {
                if (Date.now() < widgetTestStateUntil) {
                    return { ...widgetTestState, updatedAt: Date.now() };
                }
                widgetTestState = null;
            }
            return getNowPlayingWidgetState();
        }

        function sendWidgetTest() {
            widgetTestState = {
                type: 'NOW_PLAYING_STATE',
                hasSong: true,
                id: 'dQw4w9WgXcQ',
                title: t('ui_widget_test_title'),
                author: PROJECT_NAME,
                user: 'OBS',
                thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
                currentTime: 42,
                duration: 180,
                progress: 23,
                isPlaying: false,
                waveEnding: false,
                waveEffect: '',
                waveEffectId: 0,
                waveHold: false,
                isStopped: false,
                playerState: 2,
                updatedAt: Date.now()
            };
            widgetTestStateUntil = Date.now() + 8000;
            publishNowPlayingWidgetState(getActiveWidgetPublishState(), true);
            showToast(t('ui_widget_test_sent'), 'ok');

            setTimeout(() => {
                if (!widgetTestState || Date.now() < widgetTestStateUntil) return;
                widgetTestState = null;
                publishNowPlayingWidgetState(getNowPlayingWidgetState({ ignoreWidgetTestState: true }), true);
            }, 8300);
        }

        function getVarsDesc(key) {
            let text = i18n['en'][key];
            let vars = text.match(/\{[a-zA-Z0-9_]+\}/g) || [];
            return [...new Set(vars)].join(' ');
        }

        function normalizeSongForStorage(song) {
            if (!song || !song.id) return null;
            return {
                id: song.id,
                title: song.title || 'Unknown Title',
                author: song.author || 'Unknown Author',
                user: song.user || 'Auto',
                duration: normalizePositiveInteger(song.duration, 210)
            };
        }

        function normalizeFavoriteSong(song) {
            const normalized = normalizeSongForStorage(song);
            if (!normalized) return null;
            return {
                id: normalized.id,
                title: normalized.title,
                author: normalized.author,
                duration: normalized.duration
            };
        }

        function loadFavoriteSongs() {
            try {
                const parsed = JSON.parse(localStorage.getItem(FAVORITE_SONGS_STORAGE_KEY) || '[]');
                if (!Array.isArray(parsed)) return [];
                const seen = new Set();
                return parsed.map(normalizeFavoriteSong).filter(song => {
                    if (!song || seen.has(song.id)) return false;
                    seen.add(song.id);
                    return true;
                });
            } catch (error) {
                return [];
            }
        }

        function hydrateFavoriteTitleCache() {
            favoriteSongs.forEach(song => {
                if (!song || !song.id) return;
                titleCache[song.id] = {
                    title: song.title,
                    author: song.author,
                    duration: song.duration
                };
            });
        }

        function saveFavoriteSongs() {
            if (favoriteSongs.length > 0) localStorage.setItem(FAVORITE_SONGS_STORAGE_KEY, JSON.stringify(favoriteSongs));
            else localStorage.removeItem(FAVORITE_SONGS_STORAGE_KEY);
            hydrateFavoriteTitleCache();
            updateBaseCount();
            if (baseActionButtonMode === 'ready' || baseActionButtonMode === 'empty') {
                setBaseActionButtonMode(getBasePoolItems().length > 0 ? 'ready' : 'empty');
            }
        }

        function isFavoriteSong(id) {
            return favoriteSongs.some(song => song.id === id);
        }

        function getBaseSongInfo(id) {
            const favorite = favoriteSongs.find(song => song.id === id);
            if (favorite) return favorite;
            return titleCache[id] || null;
        }

        function getBasePoolItems() {
            const seen = new Set();
            const items = [];

            favoriteSongs.forEach((song, index) => {
                if (!song || !song.id || seen.has(song.id)) return;
                seen.add(song.id);
                items.push({ id: song.id, info: song, isFavorite: true, favoriteIndex: index });
            });

            let regularIndex = 1;
            masterList.forEach(id => {
                if (!id || seen.has(id)) return;
                const info = titleCache[id];
                if (!info) return;
                seen.add(id);
                items.push({ id, info, isFavorite: false, originalIndex: regularIndex });
                regularIndex += 1;
            });

            return items;
        }

        function updateBaseCount() {
            const countEl = document.getElementById('base-count');
            if (countEl) countEl.innerText = '\u{1F3B5} ' + getBasePoolItems().length;
        }

        function renderFavoriteButton(songId, onClick) {
            const active = isFavoriteSong(songId);
            const label = active ? t('ui_favorite_remove') : t('ui_favorite_add');
            return `<button class="btn-favorite ${active ? 'is-active' : ''}" draggable="false" onclick="${onClick}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">&#9733;</button>`;
        }

        function toggleFavoriteSong(song) {
            const favorite = normalizeFavoriteSong(song);
            if (!favorite) return;
            const existingIndex = favoriteSongs.findIndex(item => item.id === favorite.id);
            const removing = existingIndex !== -1;

            if (removing) {
                favoriteSongs.splice(existingIndex, 1);
            } else {
                favoriteSongs.push(favorite);
            }

            saveFavoriteSongs();
            renderBaseList();
            renderQueue();
            renderViewerHistory();
            showToast(t(removing ? 'ui_favorite_removed' : 'ui_favorite_added', { title: favorite.title }), removing ? 'warn' : 'ok');
        }

        function toggleFavoriteFromBase(id) {
            const info = getBaseSongInfo(id);
            if (!info) return;
            toggleFavoriteSong({ id, title: info.title, author: info.author, duration: info.duration, user: 'Favorite' });
        }

        function toggleFavoriteFromQueue(index) {
            const song = playQueue[index];
            if (!song) return;
            toggleFavoriteSong(song);
        }

        function toggleFavoriteFromCurrentSong() {
            if (!currentSongInfo) return;
            toggleFavoriteSong(currentSongInfo);
        }

        function addBaseSongToQueue(id) {
            const info = getBaseSongInfo(id);
            if (!info) return;
            addSongFromChat({ id, title: info.title, author: info.author, duration: info.duration, user: 'Streamer' });
        }

        function normalizeViewerHistoryEntry(entry) {
            const normalized = normalizeSongForStorage(entry);
            if (!normalized) return null;

            const fallbackUser = normalized.user && normalized.user !== 'Auto' ? normalized.user : 'Viewer';
            const rawUsers = Array.isArray(entry.users) ? entry.users : [];
            const users = [];
            [entry.lastUser, entry.firstUser, entry.user, fallbackUser, ...rawUsers].forEach(user => {
                const cleanUser = String(user || '').trim();
                if (!cleanUser) return;
                const key = cleanUser.toLowerCase();
                if (users.some(existing => existing.toLowerCase() === key)) return;
                users.push(cleanUser);
            });

            const addedAt = Number.isNaN(Date.parse(entry.addedAt)) ? new Date().toISOString() : entry.addedAt;
            const lastRequestedAt = Number.isNaN(Date.parse(entry.lastRequestedAt)) ? addedAt : entry.lastRequestedAt;

            return {
                id: normalized.id,
                title: normalized.title,
                author: normalized.author,
                duration: normalized.duration,
                user: users[0] || fallbackUser,
                firstUser: entry.firstUser || users[0] || fallbackUser,
                lastUser: entry.lastUser || users[0] || fallbackUser,
                users: users.slice(0, 25),
                addedAt,
                lastRequestedAt,
                requestCount: normalizePositiveInteger(entry.requestCount, 1)
            };
        }

        function loadViewerSongHistory() {
            try {
                const parsed = JSON.parse(localStorage.getItem(VIEWER_HISTORY_STORAGE_KEY) || '[]');
                if (!Array.isArray(parsed)) return [];
                const seen = new Set();
                return parsed.map(normalizeViewerHistoryEntry).filter(entry => {
                    if (!entry || seen.has(entry.id)) return false;
                    seen.add(entry.id);
                    return true;
                }).slice(0, VIEWER_HISTORY_LIMIT);
            } catch (error) {
                return [];
            }
        }

        function hydrateViewerHistoryTitleCache() {
            viewerSongHistory.forEach(song => {
                if (!song || !song.id) return;
                titleCache[song.id] = {
                    title: song.title,
                    author: song.author,
                    duration: song.duration
                };
            });
        }

        function saveViewerSongHistory() {
            if (!viewerSongHistory.length) {
                localStorage.removeItem(VIEWER_HISTORY_STORAGE_KEY);
                return;
            }

            try {
                localStorage.setItem(VIEWER_HISTORY_STORAGE_KEY, JSON.stringify(viewerSongHistory.slice(0, VIEWER_HISTORY_LIMIT)));
            } catch (error) {
                viewerSongHistory = viewerSongHistory.slice(0, Math.min(250, VIEWER_HISTORY_LIMIT));
                try {
                    localStorage.setItem(VIEWER_HISTORY_STORAGE_KEY, JSON.stringify(viewerSongHistory));
                } catch (innerError) {
                    localStorage.removeItem(VIEWER_HISTORY_STORAGE_KEY);
                    viewerSongHistory = [];
                }
                showToast(t('ui_history_storage_full'), 'warn');
            }
            hydrateViewerHistoryTitleCache();
        }

        function recordViewerSongHistory(song) {
            if (!isViewerRequestSong(song)) return;
            const normalized = normalizeSongForStorage(song);
            if (!normalized) return;

            const now = new Date().toISOString();
            const requestUser = String(song.user || 'Viewer').trim() || 'Viewer';
            const existingIndex = viewerSongHistory.findIndex(entry => entry.id === normalized.id);

            if (existingIndex !== -1) {
                const existing = viewerSongHistory.splice(existingIndex, 1)[0];
                const users = [requestUser, ...(existing.users || [])].filter(Boolean);
                const uniqueUsers = [];
                users.forEach(user => {
                    const key = String(user).toLowerCase();
                    if (uniqueUsers.some(existingUser => existingUser.toLowerCase() === key)) return;
                    uniqueUsers.push(String(user));
                });

                viewerSongHistory.unshift({
                    ...existing,
                    title: normalized.title,
                    author: normalized.author,
                    duration: normalized.duration,
                    user: requestUser,
                    lastUser: requestUser,
                    users: uniqueUsers.slice(0, 25),
                    lastRequestedAt: now,
                    requestCount: normalizePositiveInteger(existing.requestCount, 1) + 1
                });
            } else {
                viewerSongHistory.unshift({
                    ...normalized,
                    user: requestUser,
                    firstUser: requestUser,
                    lastUser: requestUser,
                    users: [requestUser],
                    addedAt: now,
                    lastRequestedAt: now,
                    requestCount: 1
                });
            }

            viewerSongHistory = viewerSongHistory.slice(0, VIEWER_HISTORY_LIMIT);
            saveViewerSongHistory();
            renderViewerHistory();
        }

        function openViewerHistory() {
            const modal = document.getElementById('viewer-history-modal');
            if (!modal) return;
            renderViewerHistory();
            modal.style.display = 'flex';
        }

        function closeViewerHistory() {
            const modal = document.getElementById('viewer-history-modal');
            if (modal) modal.style.display = 'none';
        }

        function getViewerHistoryFilters() {
            return {
                search: (document.getElementById('viewer-history-search')?.value || '').trim().toLowerCase(),
                user: (document.getElementById('viewer-history-user')?.value || '').trim().toLowerCase(),
                dateFrom: document.getElementById('viewer-history-date-from')?.value || '',
                dateTo: document.getElementById('viewer-history-date-to')?.value || ''
            };
        }

        function isViewerHistoryEntryInDateRange(entry, filters) {
            const entryDate = new Date(entry.lastRequestedAt || entry.addedAt);
            if (Number.isNaN(entryDate.getTime())) return true;
            if (filters.dateFrom) {
                const from = new Date(filters.dateFrom + 'T00:00:00');
                if (!Number.isNaN(from.getTime()) && entryDate < from) return false;
            }
            if (filters.dateTo) {
                const to = new Date(filters.dateTo + 'T23:59:59');
                if (!Number.isNaN(to.getTime()) && entryDate > to) return false;
            }
            return true;
        }

        function getFilteredViewerHistory() {
            const filters = getViewerHistoryFilters();
            return viewerSongHistory.filter(entry => {
                const usersText = [entry.user, entry.firstUser, entry.lastUser, ...(entry.users || [])].filter(Boolean).join(' ');
                const searchText = [entry.title, entry.author, usersText].join(' ').toLowerCase();
                const userText = usersText.toLowerCase();
                if (filters.search && !searchText.includes(filters.search)) return false;
                if (filters.user && !userText.includes(filters.user)) return false;
                return isViewerHistoryEntryInDateRange(entry, filters);
            });
        }

        function formatViewerHistoryDate(value) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return '-';
            return date.toLocaleString(currentLang, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }

        function renderViewerHistory() {
            const container = document.getElementById('viewer-history-list');
            if (!container) return;

            const filteredHistory = getFilteredViewerHistory();
            const countEl = document.getElementById('viewer-history-count');
            const limitNoteEl = document.getElementById('viewer-history-limit-note');
            if (countEl) countEl.innerText = filteredHistory.length + ' / ' + viewerSongHistory.length;
            if (limitNoteEl) limitNoteEl.innerText = t('ui_history_limit_note', { limit: VIEWER_HISTORY_LIMIT });

            if (viewerSongHistory.length === 0) {
                container.innerHTML = `<div class="history-empty">${t('ui_history_empty')}</div>`;
                return;
            }

            if (filteredHistory.length === 0) {
                container.innerHTML = `<div class="history-empty">${t('ui_history_no_results')}</div>`;
                return;
            }

            container.innerHTML = filteredHistory.map((entry, index) => {
                const userLabel = escapeHtml(entry.lastUser || entry.user || 'Viewer');
                const author = escapeHtml(entry.author || 'YouTube');
                const title = escapeHtml(entry.title || 'Unknown Title');
                const dateLabel = escapeHtml(formatViewerHistoryDate(entry.lastRequestedAt || entry.addedAt));
                const countLabel = t('ui_history_count', { count: entry.requestCount || 1 });

                return `
                <div class="q-item compact request history-item">
                    <div class="track-num">${index + 1}.</div>
                    <img src="https://i.ytimg.com/vi/${entry.id}/default.jpg">
                    <div class="track-info">
                        <div class="track-title" title="${title}">${title}</div>
                        <div class="track-meta">
                            <span class="badge badge-time">${formatTime(entry.duration)}</span>
                            <span class="badge badge-user">${userLabel}</span>
                            <span class="badge badge-author">${author}</span>
                            <span class="badge badge-date">${dateLabel}</span>
                            <span class="badge badge-count">${escapeHtml(countLabel)}</span>
                        </div>
                    </div>
                    ${renderFavoriteButton(entry.id, `toggleFavoriteFromHistory('${entry.id}')`)}
                    <button class="btn-add" onclick="addHistorySongToQueue('${entry.id}')" title="${escapeHtml(t('ui_history_add_to_queue'))}">+</button>
                </div>`;
            }).join('');
        }

        function toggleFavoriteFromHistory(id) {
            const entry = viewerSongHistory.find(song => song.id === id);
            if (!entry) return;
            toggleFavoriteSong(entry);
        }

        function addHistorySongToQueue(id) {
            const entry = viewerSongHistory.find(song => song.id === id);
            if (!entry) return;
            addSongFromChat({ id: entry.id, title: entry.title, author: entry.author, duration: entry.duration, user: 'Streamer' });
        }

        function clearViewerHistoryWithConfirm() {
            if (!viewerSongHistory.length) return;
            showConfirm(t('ui_history_clear_confirm_msg'), () => {
                viewerSongHistory = [];
                localStorage.removeItem(VIEWER_HISTORY_STORAGE_KEY);
                renderViewerHistory();
                showToast(t('ui_history_cleared'), 'ok');
            }, { title: t('ui_history_clear_confirm_title'), okText: t('ui_history_clear') });
        }

        function getQueueSnapshot() {
            return {
                currentSongInfo: currentSongInfo && !currentSongInfo.isStartup ? normalizeSongForStorage(currentSongInfo) : null,
                playQueue: playQueue.map(normalizeSongForStorage).filter(Boolean)
            };
        }

        function savePersistedQueue() {
            if (!queuePersistenceReady || !SHOULD_PERSIST_QUEUE) return;
            localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(getQueueSnapshot()));
        }

        function restorePersistedQueue() {
            if (!SHOULD_PERSIST_QUEUE) return false;
            try {
                const snapshot = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY));
                if (!snapshot || (!snapshot.currentSongInfo && (!Array.isArray(snapshot.playQueue) || snapshot.playQueue.length === 0))) return false;
                currentSongInfo = normalizeSongForStorage(snapshot.currentSongInfo);
                currentSongStopped = false;
                resetVoteSkipVotes();
                playQueue = Array.isArray(snapshot.playQueue) ? snapshot.playQueue.map(normalizeSongForStorage).filter(Boolean) : [];

                if (isHolidayStartupSong(currentSongInfo) && !activeHolidayVariant) {
                    currentSongInfo = null;
                    currentSongStopped = false;
                    if (playQueue.length === 0) {
                        localStorage.removeItem(QUEUE_STORAGE_KEY);
                        return false;
                    }
                }

                if (currentSongInfo && player && player.cueVideoById) {
                    initialSongLoaded = true;
                    player.cueVideoById(currentSongInfo.id);
                    document.getElementById('now-playing-title').innerText = currentSongInfo.title;
                    document.getElementById('now-playing-meta').innerText = currentSongInfo.user === 'Auto' ? 'Auto' : currentSongInfo.user;
                }
                renderQueue();
                return true;
            } catch (error) {
                localStorage.removeItem(QUEUE_STORAGE_KEY);
                return false;
            }
        }

        function handleQueuePersistenceToggle() {
            SHOULD_PERSIST_QUEUE = document.getElementById('queue-persist-cb').checked;
            localStorage.setItem('ytm_persist_queue', SHOULD_PERSIST_QUEUE ? 'true' : 'false');
            if (SHOULD_PERSIST_QUEUE) savePersistedQueue();
            else localStorage.removeItem(QUEUE_STORAGE_KEY);
        }

        function updateSongRequestLimitInputStates() {
            const userLimitInput = document.getElementById('sr-user-limit-input');
            const globalLimitInput = document.getElementById('sr-global-limit-input');
            if (userLimitInput) userLimitInput.disabled = !SR_USER_QUEUE_LIMIT_ENABLED;
            if (globalLimitInput) globalLimitInput.disabled = !SR_GLOBAL_QUEUE_LIMIT_ENABLED;
        }

        function saveSongRequestSettings() {
            const durationInput = document.getElementById('sr-max-duration-input');
            const voteSkipInput = document.getElementById('sr-voteskip-input');
            const userLimitInput = document.getElementById('sr-user-limit-input');
            const globalLimitInput = document.getElementById('sr-global-limit-input');
            const userLimitEnabledInput = document.getElementById('sr-user-limit-enabled-cb');
            const globalLimitEnabledInput = document.getElementById('sr-global-limit-enabled-cb');
            const musicCategoryInput = document.getElementById('sr-music-category-cb');
            if (!durationInput || !voteSkipInput || !userLimitInput || !globalLimitInput || !userLimitEnabledInput || !globalLimitEnabledInput || !musicCategoryInput) return;
            const durationDigitsOnly = durationInput.value.replace(/\D/g, '');
            const voteSkipDigitsOnly = voteSkipInput.value.replace(/\D/g, '');
            const userLimitDigitsOnly = userLimitInput.value.replace(/\D/g, '');
            const globalLimitDigitsOnly = globalLimitInput.value.replace(/\D/g, '');
            SR_MAX_DURATION_MINUTES = normalizePositiveInteger(durationDigitsOnly, SR_MAX_DURATION_MINUTES || 15);
            SR_VOTESKIP_REQUIRED = normalizePositiveInteger(voteSkipDigitsOnly, SR_VOTESKIP_REQUIRED || 5);
            SR_USER_QUEUE_LIMIT = normalizePositiveInteger(userLimitDigitsOnly, SR_USER_QUEUE_LIMIT || 25);
            SR_GLOBAL_QUEUE_LIMIT = normalizePositiveInteger(globalLimitDigitsOnly, SR_GLOBAL_QUEUE_LIMIT || 100);
            SR_USER_QUEUE_LIMIT_ENABLED = userLimitEnabledInput.checked;
            SR_GLOBAL_QUEUE_LIMIT_ENABLED = globalLimitEnabledInput.checked;
            durationInput.value = SR_MAX_DURATION_MINUTES;
            voteSkipInput.value = SR_VOTESKIP_REQUIRED;
            userLimitInput.value = SR_USER_QUEUE_LIMIT;
            globalLimitInput.value = SR_GLOBAL_QUEUE_LIMIT;
            SR_REQUIRE_MUSIC_CATEGORY = musicCategoryInput.checked;
            localStorage.setItem('ytm_sr_max_duration_minutes', SR_MAX_DURATION_MINUTES.toString());
            localStorage.setItem('ytm_sr_voteskip_required', SR_VOTESKIP_REQUIRED.toString());
            localStorage.setItem('ytm_sr_user_queue_limit', SR_USER_QUEUE_LIMIT.toString());
            localStorage.setItem('ytm_sr_global_queue_limit', SR_GLOBAL_QUEUE_LIMIT.toString());
            localStorage.setItem('ytm_sr_user_queue_limit_enabled', SR_USER_QUEUE_LIMIT_ENABLED ? 'true' : 'false');
            localStorage.setItem('ytm_sr_global_queue_limit_enabled', SR_GLOBAL_QUEUE_LIMIT_ENABLED ? 'true' : 'false');
            localStorage.setItem('ytm_sr_require_music_category', SR_REQUIRE_MUSIC_CATEGORY ? 'true' : 'false');
            updateSongRequestLimitInputStates();
            syncSongRequestSettingsToStreamerBot();
        }

        function handleWidgetAudioToggle() {
            const input = document.getElementById('widget-audio-cb');
            WIDGET_AUDIO_ENABLED_CONFIG = !!(input && input.checked);
            localStorage.setItem('ytm_widget_audio_enabled', WIDGET_AUDIO_ENABLED_CONFIG ? 'true' : 'false');
            updateWidgetUrlDisplay();
        }

        function getSettingsBackupPayload() {
            const storageKeys = [
                'ytm_lang',
                'ytm_ws_host',
                'ytm_ws_port',
                'ytm_ws_pass',
                'ytm_persist_queue',
                QUEUE_STORAGE_KEY,
                FAVORITE_SONGS_STORAGE_KEY,
                VIEWER_HISTORY_STORAGE_KEY,
                'ytm_sr_max_duration_minutes',
                'ytm_sr_voteskip_required',
                'ytm_sr_user_queue_limit',
                'ytm_sr_global_queue_limit',
                'ytm_sr_user_queue_limit_enabled',
                'ytm_sr_global_queue_limit_enabled',
                'ytm_sr_require_music_category',
                'ytm_widget_audio_enabled',
                'ytm_base_playlists',
                'ytm_banned_songs',
                'ytm_tutorial_seen'
            ];
            const values = {};
            storageKeys.forEach(key => {
                const value = localStorage.getItem(key);
                if (value !== null) values[key] = value;
            });

            const customMessages = {};
            const customMessagesDisabled = {};
            Object.keys(i18n).forEach(lang => {
                const value = localStorage.getItem('ytm_custom_msgs_' + lang);
                if (value !== null) customMessages[lang] = value;
                const disabledValue = localStorage.getItem(CUSTOM_MSGS_DISABLED_PREFIX + lang);
                if (disabledValue !== null) customMessagesDisabled[lang] = disabledValue;
            });

            return {
                type: SETTINGS_BACKUP_TYPE,
                appVersion: CURRENT_VERSION,
                exportedAt: new Date().toISOString(),
                includesApiKey: false,
                values,
                customMessages,
                customMessagesDisabled
            };
        }

        function exportSettings() {
            const payload = getSettingsBackupPayload();
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const date = new Date().toISOString().slice(0, 10);
            link.href = url;
            link.download = 'better-song-request-settings-' + CURRENT_VERSION.replace(/^v/i, '') + '-' + date + '.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showToast(t('ui_export_done'), 'ok');
        }

        function chooseSettingsImport() {
            const input = document.getElementById('settings-import-input');
            if (!input) return;
            input.value = '';
            input.click();
        }

        function applySettingsBackupPayload(payload) {
            const allowedKeys = new Set([
                'ytm_lang',
                'ytm_ws_host',
                'ytm_ws_port',
                'ytm_ws_pass',
                'ytm_persist_queue',
                QUEUE_STORAGE_KEY,
                FAVORITE_SONGS_STORAGE_KEY,
                VIEWER_HISTORY_STORAGE_KEY,
                'ytm_sr_max_duration_minutes',
                'ytm_sr_voteskip_required',
                'ytm_sr_user_queue_limit',
                'ytm_sr_global_queue_limit',
                'ytm_sr_user_queue_limit_enabled',
                'ytm_sr_global_queue_limit_enabled',
                'ytm_sr_require_music_category',
                'ytm_widget_audio_enabled',
                'ytm_base_playlists',
                'ytm_banned_songs',
                'ytm_tutorial_seen'
            ]);

            Object.keys(payload.values || {}).forEach(key => {
                if (allowedKeys.has(key)) localStorage.setItem(key, String(payload.values[key]));
            });

            Object.keys(payload.customMessages || {}).forEach(lang => {
                if (i18n[lang]) localStorage.setItem('ytm_custom_msgs_' + lang, String(payload.customMessages[lang]));
            });

            Object.keys(payload.customMessagesDisabled || {}).forEach(lang => {
                if (i18n[lang]) localStorage.setItem(CUSTOM_MSGS_DISABLED_PREFIX + lang, String(payload.customMessagesDisabled[lang]));
            });
        }

        function importSettingsFile() {
            const input = document.getElementById('settings-import-input');
            const file = input && input.files ? input.files[0] : null;
            if (!file) return;

            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const payload = JSON.parse(String(reader.result || ''));
                    if (!payload || (payload.type !== SETTINGS_BACKUP_TYPE && !LEGACY_SETTINGS_BACKUP_TYPES.includes(payload.type)) || typeof payload.values !== 'object') {
                        showToast(t('ui_import_invalid'), 'error');
                        return;
                    }

                    showConfirm(t('ui_import_confirm'), () => {
                        applySettingsBackupPayload(payload);
                        showToast(t('ui_import_done'), 'ok');
                        setTimeout(() => window.location.reload(), 900);
                    }, { okText: t('ui_import_settings') });
                } catch (error) {
                    showToast(t('ui_import_invalid'), 'error');
                }
            };
            reader.onerror = () => showToast(t('ui_import_invalid'), 'error');
            reader.readAsText(file);
        }

        function setBaseActionButtonMode(mode) {
            baseActionButtonMode = mode;
            renderBaseActionButtons();
        }

        function renderBaseActionButtons() {
            const startBtn = document.getElementById('btn-run');
            const shuffleBtn = document.getElementById('btn-shuffle');
            if (!startBtn || !shuffleBtn) return;

            const mode = baseActionButtonMode || (API_KEY ? 'downloading' : 'api-required');
            const isReady = mode === 'ready';
            startBtn.disabled = !isReady;
            shuffleBtn.disabled = !isReady;

            if (isReady) {
                startBtn.innerText = t('ui_btn_start_order');
                shuffleBtn.innerText = t('ui_btn_shuffle');
                return;
            }

            const textKey = mode === 'error'
                ? 'ui_btn_start_error'
                : (mode === 'empty' ? 'ui_btn_no_playlists' : (mode === 'api-required' ? 'ui_btn_start_req' : 'ui_btn_downloading'));
            const text = t(textKey);
            startBtn.innerText = text;
            shuffleBtn.innerText = text;
        }

        function syncSongRequestSettingsToStreamerBot() {
            if (!canUseStreamerBotWebsocket()) return;
            const limitState = getSongRequestLimitStatePayload();
            ws.send(JSON.stringify({
                request: 'DoAction',
                action: { name: 'SongRequestSettings' },
                args: {
                    maxDurationMinutes: SR_MAX_DURATION_MINUTES.toString(),
                    voteSkipRequired: SR_VOTESKIP_REQUIRED.toString(),
                    userQueueLimit: SR_USER_QUEUE_LIMIT.toString(),
                    globalQueueLimit: SR_GLOBAL_QUEUE_LIMIT.toString(),
                    userLimitEnabled: limitState.userLimitEnabled,
                    globalLimitEnabled: limitState.globalLimitEnabled,
                    globalRequestCount: limitState.globalRequestCount,
                    userRequestCountsJson: limitState.userRequestCountsJson,
                    requireMusicCategory: SR_REQUIRE_MUSIC_CATEGORY ? 'true' : 'false'
                },
                id: 'SongRequestSettings'
            }));
        }

        function renderSettingsMessages() {
            let html = '';
            let keys = Object.keys(i18n['en']).filter(k => k.startsWith('msg_'));
            
            keys.forEach(k => {
                let defaultTxt = i18n[currentLang][k] || i18n['en'][k];
                let currentTxt = customMsgs[k] !== undefined ? customMsgs[k] : defaultTxt;
                let vars = getVarsDesc(k);
                let isEnabled = !disabledCustomMsgs[k];
                
                html += `
                <div class="msg-setting-item ${isEnabled ? '' : 'is-disabled'}">
                    <div class="msg-setting-header">
                        <span class="msg-key">${k}</span>
                        <span class="msg-vars">${vars}</span>
                    </div>
                    <div class="msg-setting-body">
                        <label class="msg-enable-switch" title="${escapeHtml(isEnabled ? t('ui_msg_enabled') : t('ui_msg_disabled'))}">
                            <input type="checkbox" id="msg_enabled_${k}" ${isEnabled ? 'checked' : ''} onchange="toggleCustomMsgEnabled('${k}')">
                            <span class="queue-switch-track" aria-hidden="true"></span>
                        </label>
                        <input type="text" id="msg_input_${k}" value="${escapeHtml(currentTxt)}" maxlength="500">
                        <button class="btn-msg-action" onclick="saveCustomMsg('${k}')" title="Save">💾</button>
                        <button class="btn-msg-action btn-msg-reset" onclick="resetCustomMsg('${k}')" title="Restore Default">🔄</button>
                    </div>
                </div>`;
            });
            document.getElementById('msg-settings-list').innerHTML = html;
        }

        function saveCustomMsgDisabledState() {
            localStorage.setItem(CUSTOM_MSGS_DISABLED_PREFIX + currentLang, JSON.stringify(disabledCustomMsgs));
        }

        function toggleCustomMsgEnabled(key) {
            const input = document.getElementById(`msg_enabled_${key}`);
            if (input && input.checked) delete disabledCustomMsgs[key];
            else disabledCustomMsgs[key] = true;
            saveCustomMsgDisabledState();
            renderSettingsMessages();
        }

        function saveCustomMsg(key) {
            const val = document.getElementById(`msg_input_${key}`).value.trim();
            if(val === '') return;
            customMsgs[key] = val;
            localStorage.setItem('ytm_custom_msgs_' + currentLang, JSON.stringify(customMsgs));
            log(`💾 Saved custom message for: ${key}`, "normal");
            
            const btn = document.querySelector(`button[onclick="saveCustomMsg('${key}')"]`);
            let oldText = btn.innerHTML;
            btn.innerHTML = "✅";
            setTimeout(() => { btn.innerHTML = oldText; }, 1000);
        }

        function resetCustomMsg(key) {
            delete customMsgs[key];
            localStorage.setItem('ytm_custom_msgs_' + currentLang, JSON.stringify(customMsgs));
            document.getElementById(`msg_input_${key}`).value = i18n[currentLang][key] || i18n['en'][key];
            log(`🔄 Reset custom message for: ${key}`, "normal");
        }

        function saveWsConfig() {
            const newHost = normalizeWebsocketHost(document.getElementById('ws-host-input').value.trim());
            const newPort = document.getElementById('ws-port-input').value.trim();
            const newPass = document.getElementById('ws-pass-input').value.trim();
            
            if(newPort && !isNaN(newPort)) {
                WS_HOST = newHost;
                WS_PORT = newPort;
                WS_PASS = newPass;
                localStorage.setItem('ytm_ws_host', WS_HOST);
                localStorage.setItem('ytm_ws_port', WS_PORT);
                localStorage.setItem('ytm_ws_pass', WS_PASS);
                document.getElementById('tut-ws-port').value = WS_PORT; 
                log(`🔌 WS Server: ${WS_HOST}:${WS_PORT} | Pass: ${WS_PASS ? 'YES' : 'NO'}`, "warn");
                
                updateWidgetUrlDisplay();
                if(ws) {
                    ws.onclose = null; 
                    ws.close();
                    clearTimeout(wsReconnectTimeout);
                    connectWebsocket();
                }
            }
        }

        function getWidgetUrlBase() {
            try {
                if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
                    const url = new URL(window.location.href);
                    const basePath = url.pathname.endsWith('/') ? url.pathname : url.pathname.replace(/[^\/]*$/, '');
                    url.pathname = basePath + 'now-playing-widget.html';
                    url.search = '';
                    url.hash = '';
                    return url;
                }
            } catch (error) {}
            return new URL('http://localhost:7474/betterSongRequest/now-playing-widget.html');
        }

        function getWidgetUrl() {
            const url = getWidgetUrlBase();
            const hostInput = document.getElementById('ws-host-input');
            const portInput = document.getElementById('ws-port-input');
            const passInput = document.getElementById('ws-pass-input');
            const audioInput = document.getElementById('widget-audio-cb');
            const host = normalizeWebsocketHost((hostInput && hostInput.value.trim()) ? hostInput.value.trim() : WS_HOST);
            const port = (portInput && portInput.value.trim()) ? portInput.value.trim() : WS_PORT;
            const pass = passInput ? passInput.value.trim() : WS_PASS;
            const audioEnabled = audioInput ? audioInput.checked : WIDGET_AUDIO_ENABLED_CONFIG;

            if (host && host !== DEFAULT_STREAMERBOT_WS_HOST) url.searchParams.set('server', host);
            if (port && port !== '8080') url.searchParams.set('port', port);
            if (pass) url.searchParams.set('pass', pass);
            if (audioEnabled) url.searchParams.set('audio', '1');
            if (currentLang) url.searchParams.set('lang', currentLang);
            return url.toString();
        }

        function updateWidgetUrlWarning(currentUrl) {
            const warning = document.getElementById('widget-url-warning');
            if (!warning) return;
            const lastCopiedUrl = localStorage.getItem(WIDGET_LAST_COPIED_URL_KEY) || '';
            const changedAfterCopy = !!lastCopiedUrl && lastCopiedUrl !== currentUrl;
            const changedAfterOpen = widgetUrlWarningEnabled && !!widgetUrlBaseline && widgetUrlBaseline !== currentUrl;
            warning.classList.toggle('is-hidden', !changedAfterCopy && !changedAfterOpen);
        }

        function updateWidgetUrlDisplay() {
            const output = document.getElementById('widget-url-output');
            const url = getWidgetUrl();
            if (output) output.value = url;
            updateWidgetUrlWarning(url);
        }

        function copyWidgetUrl() {
            updateWidgetUrlDisplay();
            const output = document.getElementById('widget-url-output');
            if (!output) return;
            output.focus();
            output.select();
            output.setSelectionRange(0, 99999);

            const done = () => {
                localStorage.setItem(WIDGET_LAST_COPIED_URL_KEY, output.value);
                widgetUrlBaseline = output.value;
                widgetUrlWarningEnabled = true;
                updateWidgetUrlWarning(output.value);
                const btn = document.getElementById('btn-copy-widget-url');
                if (!btn) return;
                const oldText = btn.innerText;
                btn.innerText = t('ui_widget_copied');
                setTimeout(() => { btn.innerText = t('ui_widget_copy') || oldText; }, 1200);
            };

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(output.value).then(done).catch(() => {
                    document.execCommand('copy');
                    done();
                });
            } else {
                document.execCommand('copy');
                done();
            }
        }

        // ====================================================================

        function updateApiStatusUI(status) {
            const icon = document.getElementById('api-status-icon');
            const uiIcon = document.getElementById('api-status-ui');
            if(icon) icon.setAttribute('data-last-status', status);
            
            if(status === 'ok') { 
                if(icon) { icon.innerText = '🟢 API OK'; icon.style.color = '#00ff88'; }
                if(uiIcon) { uiIcon.innerText = '🟢 API OK'; uiIcon.style.color = '#00ff88'; }
            }
            else if (status === 'error') { 
                if(icon) { icon.innerText = '🔴 API ERROR'; icon.style.color = 'var(--red)'; }
                if(uiIcon) { uiIcon.innerText = '🔴 API ERROR'; uiIcon.style.color = 'var(--red)'; }
            }
            else { 
                if(icon) { icon.innerText = '⚪ API UNKNOWN'; icon.style.color = '#aaa'; }
                if(uiIcon) { uiIcon.innerText = '⚪ API UNKNOWN'; uiIcon.style.color = '#aaa'; }
            }
        }

        async function verifyApiKey(key) {
            if(!key) { updateApiStatusUI('error'); return false; }
            try {
                let res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id&id=UC_x5XG1OV2P6uZZ5FSM9Ttw&key=${key}`);
                let data = await res.json();
                if(data.error) {
                    updateApiStatusUI('error');
                    return false;
                }
                updateApiStatusUI('ok');
                return true;
            } catch(e) {
                updateApiStatusUI('error');
                return false;
            }
        }

        function checkApiSetup() {
            if (!API_KEY || API_KEY.trim() === '') {
                updateApiStatusUI('error');
                openSettings(); 
                setBaseActionButtonMode('api-required');
                return false;
            }
            return true;
        }

        async function saveApiKey() {
            const inputVal = document.getElementById('api-key-input').value.trim();
            if (inputVal === '') return;
            
            updateApiStatusUI('loading');
            let isValid = await verifyApiKey(inputVal);
            
            if (isValid) {
                API_KEY = inputVal;
                localStorage.setItem('ytm_api_key', API_KEY);
                log("🔑 API Key Verified.");
                if (player && typeof player.getPlayerState === 'function') fetchFullPlaylistFromAPI();
                else setBaseActionButtonMode('downloading');
            } else {
                showToast(t('ui_api_invalid'), 'error');
            }
        }

        function toggleApiVisibility() {
            const input = document.getElementById('api-key-input');
            const btn = document.getElementById('btn-show-api');
            if (input.type === 'password') { input.type = 'text'; btn.innerText = t('ui_api_hide'); } 
            else { input.type = 'password'; btn.innerText = t('ui_api_show'); }
        }

        function updateTutLink() {
            let hp = document.getElementById('tut-http-port').value.trim() || '7474';
            let folder = document.getElementById('tut-folder').value.trim() || 'betterSongRequest';
            let wp = document.getElementById('tut-ws-port').value.trim() || '8080';
            
            folder = folder.replace(/^\/+|\/+$/g, '');
            let finalFolder = folder ? `${folder}/` : '';
            
            let url = `http://localhost:${hp}/${finalFolder}index.html`;
            let a = document.getElementById('tut-final-link');
            if(a) { a.href = url; a.innerText = url; }
            
            let doneTextEl = document.getElementById('tut-done-text');
            let closeBtn = document.getElementById('tut-close-btn');
            
            if (window.location.protocol === 'file:') {
                if(doneTextEl) doneTextEl.innerHTML = t('ui_tut_done_file');
                if(closeBtn) closeBtn.style.display = 'none'; 
            } else {
                if(doneTextEl) doneTextEl.innerHTML = t('ui_tut_done_http');
                if(closeBtn) {
                    closeBtn.style.display = 'inline-block'; 
                    closeBtn.classList.add('btn-pulse');     
                }
            }
        }

        function openTutorial() { 
            updateTutLink(); 
            document.getElementById('tutorial-modal').style.display = 'flex'; 
        }
        
        function closeTutorial() {
            const currentWp = document.getElementById('tut-ws-port').value.trim();
            if(currentWp !== WS_PORT && !isNaN(currentWp)) {
                document.getElementById('ws-port-input').value = currentWp;
                saveWsConfig();
            }

            localStorage.setItem('ytm_tutorial_seen', 'true');
            document.getElementById('tutorial-modal').style.display = 'none';

            if (!API_KEY || API_KEY.trim() === '') openSettings();
        }

        function openChangelog() { document.getElementById('changelog-modal').style.display = 'flex'; }
        function closeChangelog() { document.getElementById('changelog-modal').style.display = 'none'; }

        function copySbCode() {
            const copyText = document.getElementById("sb-import-code");
            copyText.select();
            copyText.setSelectionRange(0, 99999); 
            const done = () => showToast(t('ui_copied_clipboard'), 'ok');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(copyText.value).then(done).catch(() => {
                    document.execCommand('copy');
                    done();
                });
            } else {
                document.execCommand('copy');
                done();
            }
        }

        let savedPlaylists = JSON.parse(localStorage.getItem('ytm_base_playlists')) || [];
        if (savedPlaylists.length === 0) {
            savedPlaylists = [{ id: 'PL9O6SbAVrliMxCJ-40pYLNZHXFYYZ5SiC', title: 'default_ytm' }];
            localStorage.setItem('ytm_base_playlists', JSON.stringify(savedPlaylists));
        }

        async function addBasePlaylist() {
            if (!checkApiSetup()) return;

            const url = document.getElementById('base-playlist-url').value;
            const match = url.match(/[?&]list=([^#\&\?]+)/);
            if (match && match[1]) {
                const pid = match[1];
                if (!savedPlaylists.some(p => p.id === pid)) {
                    document.getElementById('base-playlist-url').value = "...";
                    try {
                        let res = await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${pid}&key=${API_KEY}`);
                        let data = await res.json();
                        
                        if(data.error) {
                             log(`⚠️ API Error: ${data.error.message}`, "error");
                             document.getElementById('base-playlist-url').value = "";
                             return;
                        }

                        let title = (data.items && data.items.length > 0) ? data.items[0].snippet.title : `Playlist: ${pid}`;
                        
                        savedPlaylists.push({ id: pid, title: title });
                        localStorage.setItem('ytm_base_playlists', JSON.stringify(savedPlaylists));
                        document.getElementById('base-playlist-url').value = "";
                        log(`📥 Added playlist: ${title}`);
                        
                        renderPlaylistManager(); 
                        fetchFullPlaylistFromAPI();
                    } catch (e) {
                        document.getElementById('base-playlist-url').value = "";
                    }
                }
            }
        }

        function removeBasePlaylist(index) {
            let removed = savedPlaylists.splice(index, 1)[0];
            localStorage.setItem('ytm_base_playlists', JSON.stringify(savedPlaylists));
            log(`🗑️ Removed playlist: ${removed.title}`, "warn");
            renderPlaylistManager();
            fetchFullPlaylistFromAPI(); 
        }

        function savePlaylistOrder() {
            localStorage.setItem('ytm_base_playlists', JSON.stringify(savedPlaylists));
        }

        function handlePlaylistDragStart(e) {
            playlistDragSourceIndex = parseInt(e.currentTarget.getAttribute('data-index'));
            e.currentTarget.style.opacity = '0.4';
        }

        function handlePlaylistDragOver(e) {
            e.preventDefault();
            e.currentTarget.style.borderTop = '3px solid var(--accent)';
        }

        function handlePlaylistDragLeave(e) {
            e.currentTarget.style.borderTop = '';
        }

        function handlePlaylistDrop(e) {
            e.preventDefault();
            e.currentTarget.style.borderTop = '';
            const targetIndexStr = e.currentTarget.getAttribute('data-index');
            const targetIndex = targetIndexStr ? parseInt(targetIndexStr) : 0;

            if (playlistDragSourceIndex !== null && playlistDragSourceIndex !== targetIndex) {
                const draggedPlaylist = savedPlaylists.splice(playlistDragSourceIndex, 1)[0];
                savedPlaylists.splice(targetIndex, 0, draggedPlaylist);
                savePlaylistOrder();
                log("Playlist order updated.", "normal");
                renderPlaylistManager();
                fetchFullPlaylistFromAPI();
                return;
            }

            renderPlaylistManager();
        }

        function handlePlaylistDragEnd(e) {
            playlistDragSourceIndex = null;
            renderPlaylistManager();
        }

        function openPlaylistManager() { renderPlaylistManager(); document.getElementById('playlist-modal').style.display = 'flex'; }
        function closePlaylistManager() { document.getElementById('playlist-modal').style.display = 'none'; }

        function renderPlaylistManager() {
            const container = document.getElementById('playlist-list-content');
            if(savedPlaylists.length === 0) {
                container.innerHTML = `<div class="ex-style-067">${t('ui_empty_playlists')}</div>`;
                return;
            }
            container.innerHTML = savedPlaylists.map((p, i) => {
                let displayTitle = (p.id === 'PL9O6SbAVrliMxCJ-40pYLNZHXFYYZ5SiC' && (p.title === 'default_ytm' || p.title.includes('Domyślna') || p.title.includes('Default'))) ? t('ui_default_playlist_name') : p.title;
                return `
                <div class="modal-item playlist-style" draggable="true" data-index="${i}" ondragstart="handlePlaylistDragStart(event)" ondragover="handlePlaylistDragOver(event)" ondragleave="handlePlaylistDragLeave(event)" ondrop="handlePlaylistDrop(event)" ondragend="handlePlaylistDragEnd(event)">
                    <div class="playlist-order-handle" aria-hidden="true">☰</div>
                    <div class="modal-item-title" title="${p.id}">🎵 ${displayTitle}</div>
                    <button class="btn-modal-action danger" draggable="false" onclick="removeBasePlaylist(${i})">${t('ui_remove')}</button>
                </div>
            `}).join('');
        }

        let bannedSongs = JSON.parse(localStorage.getItem('ytm_banned_songs')) || [];
        if (bannedSongs.length > 0 && typeof bannedSongs[0] === 'string') {
            bannedSongs = bannedSongs.map(id => ({ id: id, title: "Unknown (Banned earlier)" }));
            localStorage.setItem('ytm_banned_songs', JSON.stringify(bannedSongs));
        }

        function banCurrentSong() {
            if (!currentSongInfo) return;
            if (!bannedSongs.some(b => b.id === currentSongInfo.id)) {
                bannedSongs.push({ id: currentSongInfo.id, title: currentSongInfo.title }); 
                localStorage.setItem('ytm_banned_songs', JSON.stringify(bannedSongs)); 
                log(`🔨 Banned current: ${currentSongInfo.title}`, "warn");
                if (currentSongInfo.user !== "Streamer" && currentSongInfo.user !== "Auto") {
                    sendChatMessage(t('msg_ban_auto', {title: currentSongInfo.title}));
                }
            }
            skipSong(); 
        }

        function banSong(index) {
            let song = playQueue[index];
            if (!bannedSongs.some(b => b.id === song.id)) {
                bannedSongs.push({ id: song.id, title: song.title }); 
                localStorage.setItem('ytm_banned_songs', JSON.stringify(bannedSongs)); 
                log(`🔨 Banned: ${song.title}`, "warn");
                if (song.user !== "Streamer" && song.user !== "Auto") {
                    sendChatMessage(t('msg_ban_rm', {title: song.title}));
                }
            }
            removeSongFromUI(index);
        }

        function unbanSong(index) {
            let unbanned = bannedSongs.splice(index, 1)[0];
            localStorage.setItem('ytm_banned_songs', JSON.stringify(bannedSongs));
            log(`✅ Unbanned: ${unbanned.title}`, "normal");
            renderBanList(); 
        }

        function clearAllBans() {
            showConfirm(t('ui_clear_bans_confirm'), () => {
                bannedSongs = [];
                localStorage.removeItem('ytm_banned_songs');
                log("🧹 Blacklist cleared!", "warn");
                renderBanList();
            }, { okText: t('ui_clear_bans') });
        }

        function openBanList() { renderBanList(); document.getElementById('ban-modal').style.display = 'flex'; }
        function closeBanList() { document.getElementById('ban-modal').style.display = 'none'; }

        function renderBanList() {
            const container = document.getElementById('ban-list-content');
            if(bannedSongs.length === 0) {
                container.innerHTML = `<div class="ex-style-067">${t('ui_empty_bans')}</div>`;
                return;
            }
            container.innerHTML = bannedSongs.map((b, i) => `
                <div class="modal-item">
                    <div class="modal-item-title">${b.title}</div>
                    <button class="btn-modal-action" onclick="unbanSong(${i})">${t('ui_unban')}</button>
                </div>
            `).join('');
        }

        function cleanAuthorName(name) {
            if (!name) return "YouTube";
            return name.replace(/\s*-\s*Topic$/i, "").replace(/\s*-\s*temat$/i, "").trim();
        }

        function formatTime(totalSeconds) {
            if (!totalSeconds) return "0:00";
            let m = Math.floor(totalSeconds / 60);
            let s = totalSeconds % 60;
            return `${m}:${s < 10 ? '0' : ''}${s}`;
        }

        function parseISO8601Duration(duration) {
            let match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
            if (!match) return 210;
            let h = parseInt(match[1]) || 0;
            let m = parseInt(match[2]) || 0;
            let s = parseInt(match[3]) || 0;
            return (h * 3600) + (m * 60) + s;
        }

        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>\"']/g, char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[char]));
        }

        const coverThemeCache = new Map();

        function normalizeCoverThemeColor(color) {
            const luma = (color.r * 0.2126) + (color.g * 0.7152) + (color.b * 0.0722);
            let mixTarget = null;
            let mixAmount = 0;

            if (luma < 58) {
                mixTarget = { r: 125, g: 135, b: 145 };
                mixAmount = 0.38;
            } else if (luma > 178) {
                mixTarget = { r: 64, g: 68, b: 74 };
                mixAmount = 0.42;
            }

            if (!mixTarget) return color;
            return {
                r: Math.round(color.r * (1 - mixAmount) + mixTarget.r * mixAmount),
                g: Math.round(color.g * (1 - mixAmount) + mixTarget.g * mixAmount),
                b: Math.round(color.b * (1 - mixAmount) + mixTarget.b * mixAmount)
            };
        }

        function readAverageCoverColor(src) {
            if (!src) return Promise.reject(new Error('No cover source'));
            if (coverThemeCache.has(src)) return Promise.resolve(coverThemeCache.get(src));

            return new Promise((resolve, reject) => {
                const image = new Image();
                image.crossOrigin = 'anonymous';
                image.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        const size = 24;
                        canvas.width = size;
                        canvas.height = size;
                        const ctx = canvas.getContext('2d', { willReadFrequently: true });
                        ctx.drawImage(image, 0, 0, size, size);

                        const data = ctx.getImageData(0, 0, size, size).data;
                        let r = 0;
                        let g = 0;
                        let b = 0;
                        let count = 0;

                        for (let i = 0; i < data.length; i += 4) {
                            if (data[i + 3] < 32) continue;
                            r += data[i];
                            g += data[i + 1];
                            b += data[i + 2];
                            count += 1;
                        }

                        if (!count) throw new Error('No readable cover pixels');
                        const color = normalizeCoverThemeColor({
                            r: Math.round(r / count),
                            g: Math.round(g / count),
                            b: Math.round(b / count)
                        });
                        coverThemeCache.set(src, color);
                        resolve(color);
                    } catch (error) {
                        reject(error);
                    }
                };
                image.onerror = reject;
                image.src = src;
            });
        }

        function applyCoverThemeToNowPlayingCard(card, src) {
            if (!card || !src) return;
            card.dataset.coverThemeSrc = src;

            readAverageCoverColor(src).then(color => {
                if (card.dataset.coverThemeSrc !== src) return;
                card.style.setProperty('--np-cover-rgb', color.r + ', ' + color.g + ', ' + color.b);
            }).catch(() => {});
        }

        function getNowPlayingWaveBarHeight(index) {
            const height = 55 + Math.sin(index * 0.83) * 11 + Math.sin(index * 1.71 + 0.9) * 8 + Math.sin(index * 0.29 + 2.4) * 6;
            return Math.round(Math.min(78, Math.max(34, height)));
        }

        function getNowPlayingWaveBarCount(width) {
            if (!width) return 28;
            return Math.min(96, Math.max(18, Math.round(width / 9)));
        }

        function createNowPlayingWaveBars(count = 28) {
            return Array.from({ length: count }, (_, index) => {
                const height = getNowPlayingWaveBarHeight(index);
                const stagger = (index * 0.026).toFixed(3);
                const skipStagger = ((((index * 37) % 29) * 0.006) + (((index * 11) % 5) * 0.002)).toFixed(3);
                const skipX = ((index % 2 ? -1 : 1) * (4 + (index % 4))).toFixed(1) + 'px';
                const skipXAlt = ((index % 2 ? 1 : -1) * (3 + (index % 5))).toFixed(1) + 'px';
                const skipXSoft = ((index % 2 ? -1 : 1) * (1.5 + (index % 3))).toFixed(1) + 'px';
                const duration = (2.45 + ((index * 7) % 11) * 0.09).toFixed(2);
                return '<i style="--bar-height: ' + height + '%; --bar-stagger: ' + stagger + 's; --bar-skip-stagger: ' + skipStagger + 's; --bar-skip-x: ' + skipX + '; --bar-skip-x-alt: ' + skipXAlt + '; --bar-skip-x-soft: ' + skipXSoft + '; --bar-duration: ' + duration + 's"></i>';
            }).join('');
        }

        function seededNowPlayingRandom(seed, index, salt = 0) {
            const numericSeed = Number(seed) || 1;
            const value = Math.sin((numericSeed * 12.9898) + (index * 78.233) + (salt * 37.719)) * 43758.5453;
            return value - Math.floor(value);
        }

        function randomizeNowPlayingSkipBars(waveEl, seed) {
            if (!waveEl) return;
            const bars = Array.from(waveEl.querySelectorAll('i'));
            const ordered = bars
                .map((bar, index) => ({ bar, index, order: seededNowPlayingRandom(seed, index, 1) }))
                .sort((a, b) => a.order - b.order);

            ordered.forEach(({ bar, index }, rank) => {
                const jitter = seededNowPlayingRandom(seed, index, 2);
                const direction = seededNowPlayingRandom(seed, index, 3) > 0.5 ? 1 : -1;
                const strength = 4 + Math.round(seededNowPlayingRandom(seed, index, 4) * 5);
                const reverseStrength = 3 + Math.round(seededNowPlayingRandom(seed, index, 5) * 4);

                bar.style.setProperty('--bar-skip-stagger', (rank * 0.0019 + jitter * 0.014).toFixed(3) + 's');
                bar.style.setProperty('--bar-skip-x', (direction * strength).toFixed(1) + 'px');
                bar.style.setProperty('--bar-skip-x-alt', (-direction * reverseStrength).toFixed(1) + 'px');
                bar.style.setProperty('--bar-skip-x-soft', (direction * strength * 0.35).toFixed(1) + 'px');
            });
        }

        function syncNowPlayingWaveBars(waveEl) {
            if (!waveEl) return;
            const width = waveEl.clientWidth || waveEl.getBoundingClientRect().width;
            const count = getNowPlayingWaveBarCount(width);
            if (waveEl.dataset.barCount !== String(count)) {
                waveEl.innerHTML = createNowPlayingWaveBars(count);
                waveEl.dataset.barCount = String(count);
            }
        }

        function renderNowPlayingCard(song, options = {}) {
            const prefix = options.prefix || 'now-playing';
            const dropAttrs = options.dropTarget ? 'ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event)"' : '';
            const banButton = options.showBan ? '<button class="np-card-ban" onclick="banCurrentSong()" title="Ban">&#128296;</button>' : '';
            const favoriteButton = options.showFavorite ? renderFavoriteButton(song.id, 'toggleFavoriteFromCurrentSong()').replace('btn-favorite', 'btn-favorite np-card-favorite') : '';
            const title = escapeHtml(song.title || 'Unknown Title');
            const author = escapeHtml(cleanAuthorName(song.author || 'YouTube'));
            const user = song.user === 'Auto' ? 'Auto' : escapeHtml(song.user || 'Viewer');
            const thumbnail = 'https://i.ytimg.com/vi/' + escapeHtml(song.id) + '/mqdefault.jpg';

            return '<div id="' + prefix + '-card" class="now-playing-card ' + (options.className || '') + '" ' + dropAttrs + '>' +
                '<img class="np-card-cover" src="' + thumbnail + '" alt="">' +
                '<div class="np-card-main">' +
                    '<div class="np-card-info">' +
                        '<div class="np-card-title" title="' + title + '">' + title + '</div>' +
                        '<div class="np-card-author" title="' + author + '">' + author + '</div>' +
                    '</div>' +
                    '<div class="np-card-meter">' +
                        '<span id="' + prefix + '-current" class="np-card-time">0:00</span>' +
                        '<div id="' + prefix + '-wave" class="np-card-wave" aria-hidden="true">' + createNowPlayingWaveBars() + '</div>' +
                        '<span id="' + prefix + '-duration" class="np-card-time">' + formatTime(song.duration || 0) + '</span>' +
                    '</div>' +
                '</div>' +
                '<span class="np-card-user">' + user + '</span>' +
                favoriteButton +
                banButton +
                '<div class="np-card-progress"><div id="' + prefix + '-progress" class="np-card-progress-fill"></div></div>' +
            '</div>';
        }

        function getNowPlayingWidgetState(options = {}) {
            if (!options.ignoreWidgetTestState && widgetTestState) {
                if (Date.now() < widgetTestStateUntil) {
                    return { ...widgetTestState, updatedAt: Date.now() };
                }
                widgetTestState = null;
            }

            if (!currentSongInfo || currentSongStopped) {
                return { type: 'NOW_PLAYING_STATE', hasSong: false, currentTime: 0, duration: 0, progress: 0, isPlaying: false, isStopped: !!currentSongStopped, waveHold: false, updatedAt: Date.now() };
            }

            const playerDuration = player && player.getDuration ? Math.floor(player.getDuration()) : 0;
            const duration = playerDuration > 0 ? playerDuration : (currentSongInfo.duration || 0);
            const rawCurrentTime = player && player.getCurrentTime ? Math.max(0, player.getCurrentTime()) : 0;
            const currentTime = Math.floor(rawCurrentTime);
            const playerState = player && player.getPlayerState ? player.getPlayerState() : 0;
            const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
            const activeWaveEffect = nowPlayingWaveEffectUntil > Date.now() ? nowPlayingWaveEffect : '';
            const waveEnding = playerState === 1 && duration > 0 && (duration - rawCurrentTime) <= 1.8;

            return {
                type: 'NOW_PLAYING_STATE',
                hasSong: true,
                id: currentSongInfo.id,
                title: currentSongInfo.title || 'Unknown Title',
                author: cleanAuthorName(currentSongInfo.author || 'YouTube'),
                user: currentSongInfo.user || 'Auto',
                thumbnail: 'https://i.ytimg.com/vi/' + currentSongInfo.id + '/mqdefault.jpg',
                currentTime,
                duration,
                progress,
                isPlaying: playerState === 1,
                waveEnding,
                waveEffect: activeWaveEffect,
                waveEffectId: activeWaveEffect ? nowPlayingWaveEffectId : 0,
                waveHold: nowPlayingWaveHoldUntilStart && activeWaveEffect !== 'skip',
                isStopped: false,
                playerState,
                updatedAt: Date.now()
            };
        }

        function updateNowPlayingCardProgress(prefix, state) {
            const card = document.getElementById(prefix + '-card');
            const currentEl = document.getElementById(prefix + '-current');
            const durationEl = document.getElementById(prefix + '-duration');
            const progressEl = document.getElementById(prefix + '-progress');
            const waveEl = document.getElementById(prefix + '-wave');
            const isSkipEffect = state.waveEffect === 'skip';
            const isFadeEffect = state.waveEffect === 'fade';
            const isWaveHeld = !!state.waveHold && !isSkipEffect;

            if (currentEl) currentEl.innerText = formatTime(state.currentTime || 0);
            if (durationEl) durationEl.innerText = formatTime(state.duration || 0);
            if (progressEl) progressEl.style.width = (state.progress || 0) + '%';
            if (waveEl) {
                waveEl.style.setProperty('--np-progress', (state.progress || 0) + '%');
                syncNowPlayingWaveBars(waveEl);
            }
            if (card) {
                const skipEffectId = String(state.waveEffectId || (isSkipEffect ? state.updatedAt || Date.now() : ''));
                if (isSkipEffect && card.dataset.skipEffectId !== skipEffectId) {
                    card.dataset.skipEffectId = skipEffectId;
                    randomizeNowPlayingSkipBars(waveEl, skipEffectId);
                    card.classList.remove('is-skipping');
                    void card.offsetWidth;
                } else if (!isSkipEffect) {
                    card.dataset.skipEffectId = '';
                }

                card.classList.toggle('is-playing', !!state.isPlaying && !state.waveEnding && !isSkipEffect && !isFadeEffect && !isWaveHeld);
                card.classList.toggle('is-wave-ending', !!state.waveEnding);
                card.classList.toggle('is-skipping', isSkipEffect);
                card.classList.toggle('is-wave-fading', isFadeEffect);
                card.classList.toggle('is-wave-held', isWaveHeld);
            }
        }

        function publishNowPlayingWidgetStateToStreamerBot(state, force = false) {
            if (!canUseStreamerBotWebsocket()) return;
            const now = Date.now();
            if (!force && now - lastNowPlayingStreamerBotPush < NOW_PLAYING_STREAMERBOT_PUSH_INTERVAL) return;
            lastNowPlayingStreamerBotPush = now;

            try {
                ws.send(JSON.stringify({
                    request: 'DoAction',
                    action: { name: NOW_PLAYING_STREAMERBOT_ACTION },
                    args: { stateJson: JSON.stringify(state) },
                    id: 'NowPlayingWidgetState'
                }));
            } catch (error) {}
        }

        function publishNowPlayingWidgetState(state = getNowPlayingWidgetState(), forceStreamerBot = false) {
            try {
                localStorage.setItem(NOW_PLAYING_WIDGET_KEY, JSON.stringify(state));
            } catch (error) {}

            if (nowPlayingWidgetChannel) {
                try { nowPlayingWidgetChannel.postMessage(state); } catch (error) {}
            }

            publishNowPlayingWidgetStateToStreamerBot(state, forceStreamerBot);
        }

        function publishNowPlayingWidgetStartupBurst() {
            nowPlayingWidgetStartupBurstTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
            nowPlayingWidgetStartupBurstTimeouts = [0, 350, 1200, 3000].map(delay => setTimeout(() => {
                publishNowPlayingWidgetState(getActiveWidgetPublishState(), true);
            }, delay));
        }

        function updateNowPlayingProgress() {
            const state = getNowPlayingWidgetState({ ignoreWidgetTestState: true });
            updateNowPlayingCardProgress('panel-now-playing', state);
            publishNowPlayingWidgetState(getActiveWidgetPublishState());
        }

        function triggerNowPlayingWaveEffect(effect, durationMs = 520) {
            nowPlayingWaveEffect = effect;
            nowPlayingWaveEffectUntil = Date.now() + durationMs;
            nowPlayingWaveEffectId = (nowPlayingWaveEffectId + 1) % 1000000;
            const state = getNowPlayingWidgetState({ ignoreWidgetTestState: true });
            updateNowPlayingCardProgress('panel-now-playing', state);
            publishNowPlayingWidgetState(getActiveWidgetPublishState(), true);
        }

        function clearNowPlayingWaveEffect() {
            nowPlayingWaveEffect = '';
            nowPlayingWaveEffectUntil = 0;
        }

        function stopCurrentSongWithWave() {
            clearTimeout(stopTransitionTimeout);
            resetVoteSkipVotes();
            nowPlayingWaveHoldUntilStart = false;
            triggerNowPlayingWaveEffect('fade', 900);
            player.stopVideo();
            document.getElementById('now-playing-title').innerText = t('ui_stop_state');

            stopTransitionTimeout = setTimeout(() => {
                currentSongStopped = true;
                clearNowPlayingWaveEffect();
                stopTransitionTimeout = null;
                publishNowPlayingWidgetState(getNowPlayingWidgetState(), true);
            }, 760);
        }

        function log(msg, type='normal') {
            const c = document.getElementById('log-content');
            const levelClass = type === 'error' ? 'log-error' : (type === 'warn' ? 'log-warn' : 'log-normal');
            c.innerHTML += `<div class="log-entry ${levelClass}">[${new Date().toLocaleTimeString()}] ${msg}</div>`;
            document.getElementById('debug-console').scrollTop = document.getElementById('debug-console').scrollHeight;
        }

        function toggleDebug() {
            const consoleEl = document.getElementById('debug-console');
            const topSection = document.getElementById('app-top-section');
            
            if (consoleEl.style.display === 'block') {
                consoleEl.style.display = 'none';
                topSection.classList.remove('debug-open');
            } else {
                consoleEl.style.display = 'block';
                topSection.classList.add('debug-open');
                consoleEl.scrollTop = consoleEl.scrollHeight;
            }
        }

        function toggleSR(skipMsg = false) {
            isSrEnabled = document.getElementById('sr-toggle-cb').checked;
            const textEl = document.getElementById('sr-status-text');
            if (isSrEnabled) {
                textEl.innerText = " !SR ON";
                textEl.style.color = "#00ff88";
                textEl.style.textShadow = "0 0 10px rgba(0,255,136,0.5)";
                if(!skipMsg) sendChatMessage(t('msg_sr_on'));
            } else {
                textEl.innerText = " !SR OFF";
                textEl.style.color = "var(--red)";
                textEl.style.textShadow = "0 0 5px rgba(0,0,0,0.5)";
                if(!skipMsg) sendChatMessage(t('msg_sr_off'));
            }
            if(!skipMsg) log(`SR Toggle: ${isSrEnabled}`, "warn");
        }

        var tag = document.createElement('script');
        tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);

        function onYouTubeIframeAPIReady() {
            log("YT Player init...");
            player = new YT.Player('player', {
                height: '100%', width: '100%', 
                playerVars: { 'enablejsapi': 1, 'controls': 1, 'origin': window.location.origin },
                events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange, 'onError': onPlayerError }
            });
        }

        function onPlayerError(e) {
            log(`⚠️ YT Error (${e.data}). Skip in 3s...`, "error");
            document.getElementById('now-playing-title').innerText = t('ui_error_skip');
            
            setTimeout(() => {
                if (currentSongInfo && currentSongInfo.user !== "Auto") sendChatMessage(t('msg_bot_blocked', {user: currentSongInfo.user}));
                playNext();
            }, 3000);
        }

        async function onPlayerReady() {
            connectWebsocket();
            const restoredQueue = restorePersistedQueue();
            queuePersistenceReady = true;
            if (!restoredQueue) await loadInitialPlayerSong();
            
            if (!localStorage.getItem('ytm_tutorial_seen')) {
                openTutorial();
            } else {
                if (!checkApiSetup()) return; 
                let isValid = await verifyApiKey(API_KEY);
                if(isValid) fetchFullPlaylistFromAPI();
                else {
                    log("⚠️ API Key error.", "error");
                    setBaseActionButtonMode('error');
                    openSettings();
                }
            }
        }

        function cueStartupSong(song) {
            if (!song || !player || initialSongLoaded || currentSongInfo) return;
            initialSongLoaded = true;
            currentSongInfo = normalizeSongForStorage({ ...song, user: 'Auto', isStartup: true });
            currentSongStopped = false;
            resetVoteSkipVotes();
            currentSongInfo.isStartup = true;
            player.cueVideoById(currentSongInfo.id);
            document.getElementById('now-playing-title').innerText = currentSongInfo.title;
            document.getElementById('now-playing-meta').innerText = 'Auto';
            renderQueue();
        }

        function getStartupSongFromHoliday() {
            return activeHolidayVariant ? activeHolidayVariant.song : null;
        }

        async function fetchMostPopularStartupSong() {
            if (!API_KEY) return null;
            try {
                const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&chart=mostPopular&videoCategoryId=10&maxResults=25&key=${API_KEY}`;
                const response = await fetch(url);
                const data = await response.json();
                if (!data.items || data.items.length === 0) return null;
                const pick = data.items[Math.floor(Math.random() * data.items.length)];
                return {
                    id: pick.id,
                    title: pick.snippet.title,
                    author: cleanAuthorName(pick.snippet.channelTitle),
                    duration: parseISO8601Duration(pick.contentDetails.duration),
                    user: 'Auto'
                };
            } catch (error) {
                return null;
            }
        }

        async function loadInitialPlayerSong() {
            if (initialSongLoaded || currentSongInfo) return;
            const holidaySong = getStartupSongFromHoliday();
            if (holidaySong) {
                cueStartupSong(holidaySong);
                return;
            }
            const popularSong = await fetchMostPopularStartupSong();
            if (popularSong) {
                cueStartupSong(popularSong);
                return;
            }
            cueStartupSong(DEFAULT_STARTUP_SONGS[Math.floor(Math.random() * DEFAULT_STARTUP_SONGS.length)]);
        }

        async function fetchFullPlaylistFromAPI() {
            if(savedPlaylists.length === 0) {
                document.getElementById('base-list').innerHTML = `<div class="ex-style-068">${t('ui_empty_playlists')}</div>`;
                updateBaseCount();
                setBaseActionButtonMode(favoriteSongs.length > 0 ? 'ready' : 'empty');
                return;
            }

            setBaseActionButtonMode('downloading');
            masterList = []; titleCache = {};
            hydrateFavoriteTitleCache();

            try {
                for(let pObj of savedPlaylists) {
                    let pid = pObj.id;
                    let nextPageToken = '';
                    do {
                        let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${pid}&key=${API_KEY}`;
                        if (nextPageToken) url += `&pageToken=${nextPageToken}`;
                        let response = await fetch(url);
                        let data = await response.json();
                        
                        if(data.error) {
                            if (data.error.code === 400 || data.error.code === 403) {
                                setBaseActionButtonMode('error');
                                updateApiStatusUI('error');
                                openSettings();
                                return; 
                            }
                            break; 
                        }

                        if(data.items && data.items.length > 0) {
                            let ids = data.items.map(item => item.snippet.resourceId.videoId).join(',');
                            let vidUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${API_KEY}`;
                            let vidRes = await fetch(vidUrl);
                            let vidData = await vidRes.json();
                            
                            let durations = {};
                            if(vidData.items) {
                                vidData.items.forEach(v => { durations[v.id] = parseISO8601Duration(v.contentDetails.duration); });
                            }

                            data.items.forEach(item => {
                                let id = item.snippet.resourceId.videoId;
                                let title = item.snippet.title;
                                if(title === "Private video" || title === "Deleted video") return;
                                
                                if(!masterList.includes(id)) {
                                    masterList.push(id);
                                    titleCache[id] = { title: title, author: cleanAuthorName(item.snippet.videoOwnerChannelTitle), duration: durations[id] || 210 };
                                }
                            });
                        }
                        nextPageToken = data.nextPageToken;
                    } while (nextPageToken);
                }
                
                log(`Loaded ${masterList.length} tracks.`);
                updateBaseCount();
                setBaseActionButtonMode(getBasePoolItems().length > 0 ? 'ready' : 'empty');
                renderBaseList();
            } catch (e) {
                log("Error: " + e.message, "error");
                setBaseActionButtonMode('error');
            }
        }

        function buildBasePlaybackQueue(shuffle = false) {
            const items = getBasePoolItems();
            if (shuffle) {
                for (let i = items.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [items[i], items[j]] = [items[j], items[i]];
                }
            }

            return items.map(item => {
                let info = item.info;
                return info ? { id: item.id, title: info.title, author: info.author, user: "Auto", duration: info.duration } : null;
            }).filter(Boolean);
        }

        function startBasePlayback(mode = basePlaybackMode) {
            if (getBasePoolItems().length === 0) return;
            basePlaybackMode = mode === 'shuffle' ? 'shuffle' : 'ordered';
            log(basePlaybackMode === 'shuffle' ? "Shuffling base playlists..." : "Starting base playlists in loaded order...");
            playQueue = buildBasePlaybackQueue(basePlaybackMode === 'shuffle');
            if (playQueue.length === 0) {
                renderQueue();
                return;
            }
            renderQueue(); playNext();
        }

        function startSystem() {
            startBasePlayback('ordered');
        }

        function startSystemShuffle() {
            startBasePlayback('shuffle');
        }

        function playNext(refillMode = basePlaybackMode) {
            clearTimeout(skipTransitionTimeout);
            clearTimeout(stopTransitionTimeout);
            skipTransitionTimeout = null;
            stopTransitionTimeout = null;
            clearNowPlayingWaveEffect();
            if(currentSongInfo) playHistory.push(currentSongInfo);
            resetVoteSkipVotes();
            
            if (playQueue.length > 0) {
                currentSongInfo = playQueue.shift();
                currentSongStopped = false;
                player.loadVideoById(currentSongInfo.id);
                renderQueue();
            } else {
                currentSongInfo = null;
                currentSongStopped = false;
                document.getElementById('now-playing-title').innerText = t('ui_waiting_start');
                document.getElementById('now-playing-meta').innerText = "---";
                renderQueue();
                startBasePlayback(refillMode); 
            }
        }

        function onPlayerStateChange(e) {
            if (e.data === 0) playNext(playQueue.length === 0 ? 'shuffle' : basePlaybackMode); 
            if (e.data === 2 && currentSongInfo && !currentSongStopped) {
                triggerNowPlayingWaveEffect('fade', 900);
            }
            if (e.data === 1) {            
                currentSongStopped = false;
                nowPlayingWaveHoldUntilStart = false;
                clearTimeout(stopTransitionTimeout);
                stopTransitionTimeout = null;
                clearNowPlayingWaveEffect();
                document.getElementById('now-playing-title').innerText = currentSongInfo.title;
                document.getElementById('now-playing-meta').innerText = currentSongInfo.user === "Auto" ? `Auto` : `👤 ${currentSongInfo.user}`;
                publishNowPlayingWidgetStartupBurst();
            }
        }

        function skipSong() {
            log("⏭️ SKIP", "warn");
            if (!currentSongInfo) {
                playNext(playQueue.length === 0 ? 'shuffle' : basePlaybackMode);
                return;
            }

            clearTimeout(skipTransitionTimeout);
            resetVoteSkipVotes();
            triggerNowPlayingWaveEffect('skip', 820);
            const refillMode = playQueue.length === 0 ? 'shuffle' : basePlaybackMode;
            skipTransitionTimeout = setTimeout(() => {
                nowPlayingWaveHoldUntilStart = true;
                nowPlayingWaveEffect = '';
                nowPlayingWaveEffectUntil = 0;
                skipTransitionTimeout = null;
                lastNowPlayingStreamerBotPush = 0;
                publishNowPlayingWidgetState(getNowPlayingWidgetState(), true);
                playNext(refillMode);
            }, 680);
        }
        
        function togglePlay() { 
            if (!currentSongInfo) {
                if (playQueue.length === 0) {
                    if (getBasePoolItems().length > 0) startBasePlayback(basePlaybackMode);
                } else {
                    playNext();
                }
                return;
            }

            if(player.getPlayerState() === 1) {
                triggerNowPlayingWaveEffect('fade', 900);
                player.pauseVideo();
            } 
            else {
                currentSongStopped = false;
                nowPlayingWaveHoldUntilStart = false;
                clearTimeout(stopTransitionTimeout);
                stopTransitionTimeout = null;
                clearNowPlayingWaveEffect();
                player.playVideo();
            }
        }
        
        function stopSongUI() { 
            stopCurrentSongWithWave();
        }

        function playFromChat(user) {
            if (!currentSongInfo) {
                if (playQueue.length === 0) {
                    if (getBasePoolItems().length > 0) {
                        sendChatMessage(t('msg_base_play', {user: user}));
                        startBasePlayback(basePlaybackMode);
                    } else {
                        sendChatMessage(t('msg_base_empty', {user: user}));
                    }
                } else {
                    sendChatMessage(t('msg_queue_play', {user: user}));
                    playNext();
                }
                return;
            }

            if (player.getPlayerState() !== 1) {
                currentSongStopped = false;
                clearTimeout(stopTransitionTimeout);
                stopTransitionTimeout = null;
                clearNowPlayingWaveEffect();
                player.playVideo();
                sendChatMessage(t('msg_resumed', {user: user}));
            } else {
                sendChatMessage(t('msg_already_playing', {user: user}));
            }
        }

        function pauseFromChat(user) {
            if (currentSongInfo && player.getPlayerState() === 1) {
                triggerNowPlayingWaveEffect('fade', 900);
                player.pauseVideo();
                sendChatMessage(t('msg_paused', {user: user}));
            } else {
                sendChatMessage(t('msg_already_paused', {user: user}));
            }
        }

        function stopFromChat(user) {
            if (currentSongInfo && player.getPlayerState() !== 5) {
                stopCurrentSongWithWave();
                sendChatMessage(t('msg_stopped', {user: user}));
            } else {
                sendChatMessage(t('msg_nothing_playing', {user: user}));
            }
        }
        
        function prevSong() {
            if (playHistory.length > 0) {
                if(currentSongInfo) playQueue.unshift(currentSongInfo);
                currentSongInfo = playHistory.pop();
                currentSongStopped = false;
                resetVoteSkipVotes();
                player.loadVideoById(currentSongInfo.id);
                renderQueue();
            } else player.seekTo(0); 
        }

        async function fetchAndAddById(videoId, user) {
            if (!checkApiSetup()) return;
            try {
                let url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${API_KEY}`;
                let res = await fetch(url);
                let data = await res.json();
                
                if (data.error) {
                     if (user !== "Streamer") sendChatMessage(t('msg_api_err', {user: user}));
                     return;
                }

                if (data.items && data.items.length > 0) {
                    let item = data.items[0];
                    addSongFromChat({ id: videoId, user: user, title: item.snippet.title, author: cleanAuthorName(item.snippet.channelTitle), duration: parseISO8601Duration(item.contentDetails.duration) });
                } else {
                    if(user !== "Streamer") sendChatMessage(t('msg_not_found', {user: user}));
                }
            } catch(e) {
                if (user !== "Streamer") sendChatMessage(t('msg_load_err', {user: user}));
            }
        }

        function addManualUrl() {
            const inputEl = document.getElementById('manual-url');
            const url = inputEl.value.trim();
            if(!url) return;
            const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
            const videoId = match ? match[1] : (url.length === 11 ? url : null);
            if(!videoId) return;
            inputEl.value = ""; 
            fetchAndAddById(videoId, "Streamer");
        }

        function getRequestUserKey(user) {
            return String(user || '').trim().toLowerCase();
        }

        function isViewerRequestSong(song) {
            const userKey = getRequestUserKey(song && song.user);
            return !!userKey && userKey !== 'auto' && userKey !== 'streamer';
        }

        function getActiveViewerRequestSongs() {
            return [currentSongInfo, ...playQueue].filter(isViewerRequestSong);
        }

        function getSongRequestLimitCounts(user) {
            const userKey = getRequestUserKey(user);
            const activeRequests = getActiveViewerRequestSongs();
            return {
                user: activeRequests.filter(song => getRequestUserKey(song.user) === userKey).length,
                global: activeRequests.length
            };
        }

        function getSongRequestLimitStatePayload() {
            const userCounts = {};
            const activeRequests = getActiveViewerRequestSongs();
            activeRequests.forEach(song => {
                const userKey = getRequestUserKey(song.user);
                if (!userKey) return;
                userCounts[userKey] = (userCounts[userKey] || 0) + 1;
            });

            return {
                userLimitEnabled: SR_USER_QUEUE_LIMIT_ENABLED ? 'true' : 'false',
                globalLimitEnabled: SR_GLOBAL_QUEUE_LIMIT_ENABLED ? 'true' : 'false',
                globalRequestCount: activeRequests.length.toString(),
                userRequestCountsJson: JSON.stringify(userCounts)
            };
        }

        function canAcceptSongRequestWithinLimits(songObj) {
            if (!isViewerRequestSong(songObj)) return true;
            const counts = getSongRequestLimitCounts(songObj.user);
            const userLimit = Math.max(1, SR_USER_QUEUE_LIMIT || 25);
            const globalLimit = Math.max(1, SR_GLOBAL_QUEUE_LIMIT || 100);

            if (SR_USER_QUEUE_LIMIT_ENABLED && counts.user >= userLimit) {
                sendChatMessage(t('msg_sr_user_limit', {
                    user: songObj.user,
                    count: counts.user,
                    limit: userLimit
                }));
                return false;
            }

            if (SR_GLOBAL_QUEUE_LIMIT_ENABLED && counts.global >= globalLimit) {
                sendChatMessage(t('msg_sr_global_limit', {
                    user: songObj.user,
                    count: counts.global,
                    limit: globalLimit
                }));
                return false;
            }

            return true;
        }

        function addSongFromChat(songObj, force = false) {
            if(songObj.author) songObj.author = cleanAuthorName(songObj.author);
            if (!force && songObj.user !== "Streamer" && songObj.duration && songObj.duration > SR_MAX_DURATION_MINUTES * 60) {
                sendChatMessage(t('msg_err_long', {user: songObj.user, info: Math.ceil(songObj.duration / 60), limit: SR_MAX_DURATION_MINUTES}));
                return;
            }
            if (!force && !canAcceptSongRequestWithinLimits(songObj)) return;
            songObj.isNew = true;

            let insertIndex = playQueue.findIndex(song => song.user === 'Auto');
            if (insertIndex === -1) { playQueue.push(songObj); insertIndex = playQueue.length - 1; } 
            else playQueue.splice(insertIndex, 0, songObj);

            recordViewerSongHistory(songObj);
            
            renderQueue();
            log(`➕ Added: "${songObj.title}" by ${songObj.user}`, "normal");

            let etaSeconds = 0;
            if (player.getPlayerState() === 1 && player.getDuration() > 0) etaSeconds += (player.getDuration() - player.getCurrentTime());
            for(let i = 0; i < insertIndex; i++) etaSeconds += playQueue[i].duration || 210;

            let displayPosition = insertIndex + 2; 
            if (songObj.user !== "Streamer") {
                sendChatMessage(t('msg_song_added', {
                    user: songObj.user,
                    author: songObj.author,
                    title: songObj.title,
                    pos: displayPosition,
                    m: Math.floor(etaSeconds / 60),
                    s: Math.floor(etaSeconds % 60)
                }));
            }
        }

        function removeSongFromUI(index) {
            let removed = playQueue.splice(index, 1)[0];
            renderQueue();
        }

        function clearQueueWithConfirm() {
            if (playQueue.length === 0) return;
            showConfirm(t('ui_clear_queue_confirm', {count: playQueue.length}), () => {
                playQueue = [];
                renderQueue();
                log("Cleared queued tracks.", "warn");
            }, { okText: t('ui_clear_queue') });
        }

        function sendChatMessage(msg) {
            if (!msg || !String(msg).trim()) return;
            if(canUseStreamerBotWebsocket()) {
                ws.send(JSON.stringify({"request": "DoAction", "action": { "name": "ChatMessage" }, "args": { "message": msg }, "id": "MsgOut" }));
            }
        }

        function resetVoteSkipVotes() {
            voteSkipUsers.clear();
        }

        function getVoteSkipUserKey(user) {
            return String(user || 'Viewer').trim().toLowerCase() || 'viewer';
        }

        function handleGetSong(user) {
            if (currentSongInfo) {
                sendChatMessage(t('msg_current', {
                    user: user,
                    author: currentSongInfo.author,
                    title: currentSongInfo.title,
                    adder: currentSongInfo.user,
                    link: `https://youtu.be/${currentSongInfo.id}`
                }));
            }
            else sendChatMessage(t('msg_nothing_playing', {user: user}));
        }

        function handleSkipSong(user) { 
            if (currentSongInfo) {
                sendChatMessage(t('msg_skip', {user: user, author: currentSongInfo.author, title: currentSongInfo.title}));
            } else {
                sendChatMessage(t('msg_skip_empty', {user: user}));
            }
            skipSong(); 
        }

        function handleVoteSkip(user) {
            const voter = user || 'Viewer';
            const required = Math.max(1, SR_VOTESKIP_REQUIRED || 5);

            if (skipTransitionTimeout) {
                sendChatMessage(t('msg_voteskip_skipping', {user: voter}));
                return;
            }

            if (!currentSongInfo || currentSongStopped) {
                sendChatMessage(t('msg_voteskip_empty', {user: voter}));
                return;
            }

            const userKey = getVoteSkipUserKey(voter);
            if (voteSkipUsers.has(userKey)) {
                sendChatMessage(t('msg_voteskip_duplicate', {
                    user: voter,
                    votes: voteSkipUsers.size,
                    required: required,
                    left: Math.max(0, required - voteSkipUsers.size)
                }));
                return;
            }

            voteSkipUsers.add(userKey);
            const votes = voteSkipUsers.size;
            const left = Math.max(0, required - votes);

            if (votes >= required) {
                sendChatMessage(t('msg_voteskip_passed', {
                    user: voter,
                    votes: votes,
                    required: required,
                    author: currentSongInfo.author,
                    title: currentSongInfo.title
                }));
                skipSong();
                return;
            }

            sendChatMessage(t('msg_voteskip_count', {
                user: voter,
                votes: votes,
                required: required,
                left: left
            }));
        }

        function handleWrongSong(user) {
            let foundIndex = -1;
            for (let i = playQueue.length - 1; i >= 0; i--) {
                if (playQueue[i].user.toLowerCase() === user.toLowerCase()) { foundIndex = i; break; }
            }
            if (foundIndex !== -1) {
                let removed = playQueue.splice(foundIndex, 1)[0];
                renderQueue();
                sendChatMessage(t('msg_wrong_rm', {user: user, title: removed.title}));
            } else sendChatMessage(t('msg_wrong_none', {user: user}));
        }

        function handleVolume(data) {
            if (!player || !player.getVolume) return;
            let currentVol = player.getVolume();
            let newVol = currentVol;
            if (data.mode === "add") newVol = currentVol + data.value;
            else if (data.mode === "sub") newVol = currentVol - data.value;
            else if (data.mode === "set") newVol = data.value;
            if (newVol > 100) newVol = 100; if (newVol < 0) newVol = 0;
            if (data.mode !== "get") {
                player.setVolume(newVol);
                sendChatMessage(t('msg_vol', {user: data.user, vol: newVol}));
            } else sendChatMessage(t('msg_vol', {user: data.user, vol: currentVol}));
        }

        function handleDragStart(e) { dragSourceIndex = parseInt(e.currentTarget.getAttribute('data-index')); e.currentTarget.style.opacity = '0.4'; }
        function handleDragOver(e) { e.preventDefault(); e.currentTarget.style.borderTop = '3px solid var(--accent)'; }
        function handleDragLeave(e) { e.currentTarget.style.borderTop = ''; }
        function handleDrop(e) {
            e.preventDefault(); e.currentTarget.style.borderTop = '';
            let targetIndexStr = e.currentTarget.getAttribute('data-index');
            let targetIndex = targetIndexStr ? parseInt(targetIndexStr) : 0;
            if (dragSourceIndex !== null && dragSourceIndex !== targetIndex) {
                const draggedItem = playQueue.splice(dragSourceIndex, 1)[0];
                playQueue.splice(targetIndex, 0, draggedItem);
            }
            renderQueue(); 
        }
        function handleDragEnd(e) { renderQueue(); }

        function handleFavoriteDragStart(e) {
            favoriteDragSourceIndex = parseInt(e.currentTarget.getAttribute('data-favorite-index'), 10);
            e.currentTarget.style.opacity = '0.4';
        }

        function handleFavoriteDragOver(e) {
            e.preventDefault();
            e.currentTarget.style.borderTop = '3px solid var(--gold)';
        }

        function handleFavoriteDragLeave(e) {
            e.currentTarget.style.borderTop = '';
        }

        function handleFavoriteDrop(e) {
            e.preventDefault();
            e.currentTarget.style.borderTop = '';
            const targetIndex = parseInt(e.currentTarget.getAttribute('data-favorite-index'), 10);
            if (Number.isInteger(favoriteDragSourceIndex) && Number.isInteger(targetIndex) && favoriteDragSourceIndex !== targetIndex) {
                const draggedFavorite = favoriteSongs.splice(favoriteDragSourceIndex, 1)[0];
                favoriteSongs.splice(targetIndex, 0, draggedFavorite);
                saveFavoriteSongs();
            }
            favoriteDragSourceIndex = null;
            renderBaseList();
        }

        function handleFavoriteDragEnd(e) {
            favoriteDragSourceIndex = null;
            renderBaseList();
        }

        function renderQueue() {
            const queueContainer = document.getElementById('queue-list');
            const nowPlayingBox = document.getElementById('now-playing-content');
            const clearQueueBtn = document.getElementById('btn-clear-queue');
            
            document.getElementById('queue-count').innerText = '🎵 ' + (playQueue.length + (currentSongInfo ? 1 : 0));
            if (clearQueueBtn) clearQueueBtn.disabled = playQueue.length === 0;
            
            let totalSeconds = 0;
            if (currentSongInfo) totalSeconds += (currentSongInfo.duration || 210);
            playQueue.forEach(song => { totalSeconds += (song.duration || 210); });
            
            let h = Math.floor(totalSeconds / 3600); let m = Math.floor((totalSeconds % 3600) / 60); let s = totalSeconds % 60;
            document.getElementById('queue-time').innerText = `⏱️ ${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;

            if (currentSongInfo) {
                nowPlayingBox.innerHTML = renderNowPlayingCard(currentSongInfo, { prefix: 'panel-now-playing', dropTarget: true, showBan: true, showFavorite: true, className: 'panel-card' });
                applyCoverThemeToNowPlayingCard(document.getElementById('panel-now-playing-card'), 'https://i.ytimg.com/vi/' + currentSongInfo.id + '/mqdefault.jpg');
            } else nowPlayingBox.innerHTML = `<div class="ex-style-013">${t('ui_no_song')}</div>`;

            updateNowPlayingProgress();

            if (playQueue.length === 0) {
                queueContainer.innerHTML = `<div class="ex-style-071">---</div>`;
                savePersistedQueue();
                syncSongRequestSettingsToStreamerBot();
                return;
            }
            
            queueContainer.innerHTML = playQueue.slice(0, 40).map((song, i) => {
                let typeClass = ""; let badgeClass = "badge";
                if (song.user !== "Auto") {
                    if (song.user === "Streamer") { typeClass = "manual"; badgeClass = "badge badge-manual"; } 
                    else { typeClass = "request"; badgeClass = "badge badge-user"; }
                }
                let animClass = song.isNew ? "animate-in" : "";
                if (song.isNew) setTimeout(() => { song.isNew = false; }, 500); 

                return `
                <div class="q-item ${typeClass} ${animClass}" draggable="true" data-index="${i}" ondragstart="handleDragStart(event)" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event)" ondragend="handleDragEnd(event)">
                    <div class="queue-drag-handle" aria-hidden="true">☰</div>
                    <div class="track-num">${i + 2}.</div>
                    <img src="https://i.ytimg.com/vi/${song.id}/default.jpg">
                    <div class="track-info">
                        <div class="track-title">${escapeHtml(song.title)}</div>
                        <div class="track-meta">
                            <span class="badge badge-time">${formatTime(song.duration)}</span>
                            ${song.user !== 'Auto' ? `<span class="${badgeClass}">👤 ${escapeHtml(song.user)}</span>` : `<span class="badge badge-auto">🤖 Auto</span>`}
                            <span class="badge badge-author">🎤 ${escapeHtml(song.author)}</span>
                        </div>
                    </div>
                    ${renderFavoriteButton(song.id, `toggleFavoriteFromQueue(${i})`)}
                    <button class="btn-ban" onclick="banSong(${i})" title="Ban">🔨</button>
                    <button class="btn-remove" onclick="removeSongFromUI(${i})" title="Remove">❌</button>
                </div>`;
            }).join('');
            savePersistedQueue();
            syncSongRequestSettingsToStreamerBot();
            updateNowPlayingProgress();
        }

        function renderBaseList() {
            const container = document.getElementById('base-list');
            const searchInput = document.getElementById('base-search');
            const query = searchInput ? searchInput.value.toLowerCase().trim() : "";
            const basePoolItems = getBasePoolItems();
            updateBaseCount();

            let filteredList = basePoolItems;
            
            if (query !== "") {
                filteredList = basePoolItems.filter(item => {
                    let info = item.info;
                    if(!info) return false;
                    let searchStr = (info.title + " " + info.author).toLowerCase();
                    return searchStr.includes(query);
                });
            }

            if (filteredList.length === 0 && basePoolItems.length > 0) {
                container.innerHTML = `<div class="ex-style-068">0 results</div>`;
                return;
            }

            if (filteredList.length === 0) {
                container.innerHTML = `<div class="ex-style-068">${t('ui_empty_playlists')}</div>`;
                return;
            }

            container.innerHTML = filteredList.map((item) => {
                let id = item.id;
                let info = item.info;
                let trackNumber = item.isFavorite ? `${item.favoriteIndex + 1}.` : `${item.originalIndex}.`;
                let favoriteClass = item.isFavorite ? ' favorite-track' : '';
                let favoriteDragAttrs = item.isFavorite ? ` draggable="true" data-favorite-index="${item.favoriteIndex}" ondragstart="handleFavoriteDragStart(event)" ondragover="handleFavoriteDragOver(event)" ondragleave="handleFavoriteDragLeave(event)" ondrop="handleFavoriteDrop(event)" ondragend="handleFavoriteDragEnd(event)"` : '';
                let favoriteHandle = item.isFavorite ? '<div class="favorite-drag-handle" aria-hidden="true">☰</div>' : '';
                
                return `
                <div class="q-item compact${favoriteClass}"${favoriteDragAttrs}>
                    ${favoriteHandle}
                    <div class="track-num" title="Base ID">${trackNumber}</div>
                    <img src="https://i.ytimg.com/vi/${id}/default.jpg">
                    <div class="track-info">
                        <div class="track-title" title="${escapeHtml(info.title)}">${escapeHtml(info.title)}</div>
                        <div class="track-meta">
                            <span class="badge badge-time">${formatTime(info.duration)}</span>
                            <span class="badge badge-author">🎤 ${escapeHtml(info.author)}</span>
                            ${item.isFavorite ? `<span class="badge badge-favorite">${t('ui_favorites_label')}</span>` : ''}
                        </div>
                    </div>
                    ${renderFavoriteButton(id, `toggleFavoriteFromBase('${id}')`)}
                    <button class="btn-add" onclick="addBaseSongToQueue('${id}')" title="Add">+</button>
                </div>`;
            }).join('');
        }

        async function createStreamerBotAuthentication(password, salt, challenge) {
            const encoder = new TextEncoder();
            const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
            const secretBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password + salt));
            const secret = toBase64(secretBuffer);
            const authBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(secret + challenge));
            return toBase64(authBuffer);
        }

        function subscribeToStreamerBotEvents() {
            if(ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({"request": "Subscribe", "events": {"General": ["Custom"]}, "id": "Sub"}));
                syncSongRequestSettingsToStreamerBot();
            }
        }

        function isActiveWebsocket(socket, attempt) {
            return socket && socket === ws && attempt === wsConnectionAttempt;
        }

        function canUseStreamerBotWebsocket() {
            return !!(ws && ws.readyState === WebSocket.OPEN && wsStreamerBotReady);
        }

        function setWebsocketConnecting() {
            wsStreamerBotReady = false;
            wsStatusKey = 'ui_bot_connecting';
            wsStatusColor = '#ffaa00';
            renderWebsocketStatus();
        }

        function setWebsocketConnected(socket, attempt) {
            if (!isActiveWebsocket(socket, attempt)) return;
            wsStreamerBotReady = true;
            wsStatusKey = 'ui_bot_connected';
            wsStatusColor = '#00ff88';
            renderWebsocketStatus();
            scheduleImportStatusCheck();
        }

        function setWebsocketDisconnected() {
            wsStreamerBotReady = false;
            wsStatusKey = 'ui_bot_disconnected';
            wsStatusColor = 'var(--red)';
            renderWebsocketStatus();
            setImportStatus('unknown');
            resolveImportDiagnosticsWaiters(null);
            resolveStreamerBotRequestWaiters(null);
        }

        function setWebsocketAuthFailed(message = "WebSocket Authentication Failed!") {
            wsStreamerBotReady = false;
            wsStatusKey = 'ui_bot_auth_fail';
            wsStatusColor = 'var(--red)';
            renderWebsocketStatus();
            setImportStatus('unknown');
            resolveImportDiagnosticsWaiters(null);
            resolveStreamerBotRequestWaiters(null);
            log(`🔴 ${message}`, "error");
        }

        function renderWebsocketStatus() {
            const statusEl = document.getElementById('status');
            if (!statusEl) return;
            statusEl.innerText = t(wsStatusKey);
            statusEl.style.color = wsStatusColor;
        }

        async function handleStreamerBotHello(raw, socket, attempt) {
            if (!isActiveWebsocket(socket, attempt)) return;

            if (raw.authentication) {
                if (!WS_PASS) {
                    setWebsocketAuthFailed("WebSocket password is required by Streamer.bot.");
                    return;
                }

                try {
                    const authentication = await createStreamerBotAuthentication(
                        WS_PASS,
                        raw.authentication.salt,
                        raw.authentication.challenge
                    );
                    if (isActiveWebsocket(socket, attempt) && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ "request": "Authenticate", "authentication": authentication, "id": "auth" }));
                    }
                } catch (error) {
                    setWebsocketAuthFailed("Unable to generate WebSocket authentication.");
                    console.error(error);
                }
                return;
            }

            setWebsocketConnected(socket, attempt);
            subscribeToStreamerBotEvents();
        }

        function connectWebsocket() {
            clearTimeout(wsReconnectTimeout);
            const attempt = ++wsConnectionAttempt;
            const socket = new WebSocket(buildStreamerBotWebsocketUrl(WS_HOST, WS_PORT));
            ws = socket;
            setWebsocketConnecting();

            socket.onopen = () => {
                if (!isActiveWebsocket(socket, attempt)) return;
                log(`🔌 WebSocket opened on ${WS_HOST}:${WS_PORT}`, "normal");
            };
            socket.onmessage = async (e) => {
                if (!isActiveWebsocket(socket, attempt)) return;
                const rawData = e.data.toString();
                try {
                    const raw = JSON.parse(rawData);

                    if (raw.request === "Hello") {
                        await handleStreamerBotHello(raw, socket, attempt);
                        return;
                    }

                    if (resolveStreamerBotRequest(raw)) return;

                    if (raw.id === "Sub") return;
                    
                    if (raw.id === "auth") {
                        if (!isActiveWebsocket(socket, attempt)) return;
                        if (raw.status === "ok") {
                            setWebsocketConnected(socket, attempt);
                            subscribeToStreamerBotEvents();
                        } else {
                            setWebsocketAuthFailed();
                        }
                        return;
                    }

                    let inner = null;
                    if (raw.data && typeof raw.data === 'object' && raw.data.data) inner = JSON.parse(raw.data.data);
                    else if (raw.type) inner = raw;

                    if (inner) {
                        if (inner.type === "IMPORT_DIAGNOSTICS") {
                            handleImportDiagnosticsPayload(inner);
                        }
                        else if (inner.type === "SONG_REQUEST") {
                            if (!isSrEnabled) sendChatMessage(t('msg_sr_disabled', {user: inner.user}));
                            else if (bannedSongs.some(b => b.id === inner.id)) sendChatMessage(t('msg_sr_banned', {user: inner.user}));
                            else {
                                let isDuplicate = playQueue.some(song => song.id === inner.id && song.user !== "Auto" && song.user !== "Streamer");
                                let isCurrentDuplicate = currentSongInfo && currentSongInfo.id === inner.id && currentSongInfo.user !== "Auto" && currentSongInfo.user !== "Streamer";
                                if (isDuplicate || isCurrentDuplicate) sendChatMessage(t('msg_sr_dupe', {user: inner.user}));
                                else addSongFromChat(inner);
                            }
                        }
                        else if (inner.type === "SONG_REQUEST_FORCE") addSongFromChat(inner, true); 
                        else if (inner.type === "GET_SONG") handleGetSong(inner.user);
                        else if (inner.type === "SKIP_SONG") handleSkipSong(inner.user);
                        else if (inner.type === "VOTE_SKIP") handleVoteSkip(inner.user);
                        else if (inner.type === "WRONG_SONG") handleWrongSong(inner.user);
                        else if (inner.type === "VOLUME") handleVolume(inner);
                        
                        else if (inner.type === "PLAY_SONG") playFromChat(inner.user);
                        else if (inner.type === "PAUSE_SONG") pauseFromChat(inner.user);
                        else if (inner.type === "STOP_SONG") stopFromChat(inner.user);

                        else if (inner.type === "SR_ERROR") {
                            let msg = "";
                            switch(inner.errorCode) {
                                case "EMPTY_INPUT": msg += t('msg_err_empty', {user: inner.user}); break;
                                case "NOT_FOUND": msg += t('msg_err_not_found', {user: inner.user, info: inner.extraInfo}); break;
                                case "TOO_LONG": msg += t('msg_err_long', {user: inner.user, info: Math.floor(parseInt(inner.extraInfo)/60), limit: SR_MAX_DURATION_MINUTES}); break;
                                case "NOT_MUSIC": msg += t('msg_err_cat', {user: inner.user, info: inner.extraInfo}); break;
                                case "USER_LIMIT": {
                                    const [count, limit] = String(inner.extraInfo || '').split('|');
                                    msg += t('msg_sr_user_limit', {user: inner.user, count: count || '?', limit: limit || SR_USER_QUEUE_LIMIT});
                                    break;
                                }
                                case "GLOBAL_LIMIT": {
                                    const [count, limit] = String(inner.extraInfo || '').split('|');
                                    msg += t('msg_sr_global_limit', {user: inner.user, count: count || '?', limit: limit || SR_GLOBAL_QUEUE_LIMIT});
                                    break;
                                }
                                case "API_ERROR": msg += t('msg_err_api', {user: inner.user}); break;
                            }
                            if (msg) sendChatMessage(msg);
                        }
                        else if (inner.type === "SR_SEARCHING") {
                            sendChatMessage(t('msg_searching', {user: inner.user}));
                        }
                        else if (inner.type === "SR_FORCE_ERROR") {
                            if(inner.errorCode === "INVALID_ID") sendChatMessage(t('msg_err_id', {user: inner.user}));
                            else sendChatMessage(t('msg_err_yt_read', {user: inner.user}));
                        }
                    }
                } catch(err) {}
            };
            socket.onerror = () => {
                if (!isActiveWebsocket(socket, attempt)) return;
                wsStreamerBotReady = false;
            };
            socket.onclose = () => {
                if (!isActiveWebsocket(socket, attempt)) return;
                setWebsocketDisconnected();
                wsReconnectTimeout = setTimeout(connectWebsocket, 5000);
            };
        }


Object.assign(window, {
    onYouTubeIframeAPIReady,
    saveCustomMsg,
    resetCustomMsg,
    toggleCustomMsgEnabled,
    removeBasePlaylist,
    unbanSong,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
    handleFavoriteDragStart,
    handleFavoriteDragOver,
    handleFavoriteDragLeave,
    handleFavoriteDrop,
    handleFavoriteDragEnd,
    handlePlaylistDragStart,
    handlePlaylistDragOver,
    handlePlaylistDragLeave,
    handlePlaylistDrop,
    handlePlaylistDragEnd,
    banCurrentSong,
    banSong,
    removeSongFromUI,
    toggleFavoriteFromBase,
    toggleFavoriteFromQueue,
    toggleFavoriteFromCurrentSong,
    toggleFavoriteFromHistory,
    addHistorySongToQueue,
    addBaseSongToQueue,
    fetchAndAddById
});
}
