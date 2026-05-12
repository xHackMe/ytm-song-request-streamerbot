if (document.body.classList.contains('now-playing-widget-page')) {
const STORAGE_KEY = 'ytm_now_playing_widget_state';
const CHANNEL_NAME = 'ytm_now_playing_widget';
const root = document.getElementById('widget-root');
const widgetParams = new URLSearchParams(window.location.search || '');
const WIDGET_WS_PORT = widgetParams.get('port') || widgetParams.get('wsPort') || '8080';
const WIDGET_WS_PASS = widgetParams.get('pass') || widgetParams.get('password') || widgetParams.get('wsPass') || '';
const WIDGET_LANG = widgetParams.get('lang') || widgetParams.get('language') || '';
const WIDGET_STALE_MS = 3500;
const WIDGET_AUTO_HIDE_MS = 30000;
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

function consumePayload(payload) {
    if (!payload || payload === lastPayload) return;
    lastPayload = payload;
    try {
        const state = JSON.parse(payload);
        if (!state || state.type !== 'NOW_PLAYING_STATE') return;
        if (state.updatedAt && Date.now() - state.updatedAt > WIDGET_STALE_MS) {
            renderWidgetStatus('ui_widget_waiting_player', 'connection');
            return;
        }

        lastWidgetStateAt = Date.now();
        renderState(state);
    } catch (error) {
        renderWidgetStatus('ui_widget_waiting_player', 'connection');
    }
}

function handleWidgetState(state) {
    if (!state || state.type !== 'NOW_PLAYING_STATE') return;
    consumePayload(JSON.stringify(state));
}

function readStorageState() {
    try {
        consumePayload(localStorage.getItem(STORAGE_KEY));
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

function subscribeWidgetToStreamerBotEvents() {
    if (widgetWs && widgetWs.readyState === WebSocket.OPEN) {
        widgetWs.send(JSON.stringify({ request: 'Subscribe', events: { General: ['Custom'] }, id: 'WidgetSub' }));
    }
}

async function handleWidgetStreamerBotHello(raw) {
    if (raw.authentication) {
        if (!WIDGET_WS_PASS) return;
        try {
            const authentication = await createStreamerBotAuthentication(WIDGET_WS_PASS, raw.authentication.salt, raw.authentication.challenge);
            widgetWs.send(JSON.stringify({ request: 'Authenticate', authentication, id: 'WidgetAuth' }));
        } catch (error) {}
        return;
    }

    subscribeWidgetToStreamerBotEvents();
}

function connectWidgetWebsocket() {
    if (typeof WebSocket === 'undefined') return;
    clearTimeout(widgetWsReconnectTimeout);
    widgetWs = new WebSocket('ws://localhost:' + WIDGET_WS_PORT + '/');

    widgetWs.onmessage = async event => {
        try {
            const raw = JSON.parse(event.data.toString());
            if (raw.request === 'Hello') {
                await handleWidgetStreamerBotHello(raw);
                return;
            }
            if (raw.id === 'WidgetSub') return;
            if (raw.id === 'WidgetAuth') {
                if (raw.status === 'ok') subscribeWidgetToStreamerBotEvents();
                return;
            }

            handleWidgetState(unwrapStreamerBotPayload(raw));
        } catch (error) {}
    };

    widgetWs.onclose = () => {
        widgetWsReconnectTimeout = setTimeout(connectWidgetWebsocket, 5000);
    };
}

try {
    if ('BroadcastChannel' in window) {
        const channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = event => handleWidgetState(event.data);
    }
} catch (error) {}

window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) consumePayload(event.newValue);
});

function monitorWidgetConnection() {
    if (!lastWidgetStateAt || Date.now() - lastWidgetStateAt > WIDGET_STALE_MS) {
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
        const CURRENT_VERSION = "v1.2.1";
        const GITHUB_REPO = "xHackMe/ytm-song-request-streamerbot";
        
        document.title = `YTM Song Request ${CURRENT_VERSION}`;
        document.getElementById('app-version-display').innerText = CURRENT_VERSION;
        
        async function checkGithubUpdates() {
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
                    if (cleanLocalVer !== cleanGithubVer) {
                        const updateBtn = document.getElementById('update-btn');
                        updateBtn.style.display = 'block';
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

        let currentLang = localStorage.getItem('ytm_lang') || 'en';
        let customMsgs = JSON.parse(localStorage.getItem('ytm_custom_msgs_' + currentLang)) || {};

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

        function applyTranslations() {
            if(document.getElementById('lang-select')) document.getElementById('lang-select').value = currentLang;
            if(document.getElementById('tut-lang-select')) document.getElementById('tut-lang-select').value = currentLang;
            
            applyHolidayVariant();
            document.querySelectorAll('[data-i18n]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n')); });
            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
            document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });

            // UPDATE BUTTON DYNAMIC TRANSLATION:
            const updateBtn = document.getElementById('update-btn');
            if (updateBtn && updateBtn.getAttribute('data-version')) {
                updateBtn.innerText = t('ui_update_btn', {version: updateBtn.getAttribute('data-version')});
            }

            renderBaseList();
            renderQueue();
            if(document.getElementById('ban-modal').style.display === 'flex') renderBanList();
            if(document.getElementById('playlist-modal').style.display === 'flex') renderPlaylistManager();
            
            updateApiStatusUI(document.getElementById('api-status-icon').getAttribute('data-last-status') || 'init');
            
            if (!document.getElementById('btn-run').disabled) {
                document.getElementById('btn-run').innerText = masterList.length > 0 ? t('ui_btn_start_active') : t('ui_btn_start_error');
            } else {
                if(API_KEY) document.getElementById('btn-run').innerText = t('ui_btn_downloading');
                else document.getElementById('btn-run').innerText = t('ui_btn_start_req');
            }
            
            updateTutLink(); 
        }

        // =========================================================================
        let API_KEY = localStorage.getItem('ytm_api_key') || ''; 
        let WS_PORT = localStorage.getItem('ytm_ws_port') || '8080';
        let WS_PASS = localStorage.getItem('ytm_ws_pass') || '';
        const QUEUE_STORAGE_KEY = 'ytm_persisted_queue';
        let SHOULD_PERSIST_QUEUE = localStorage.getItem('ytm_persist_queue') === 'true';
        let queuePersistenceReady = false;
        let SR_MAX_DURATION_MINUTES = normalizePositiveInteger(localStorage.getItem('ytm_sr_max_duration_minutes'), 15);
        let SR_REQUIRE_MUSIC_CATEGORY = localStorage.getItem('ytm_sr_require_music_category') !== 'false';
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
        let nowPlayingWidgetChannel = null;
        let lastNowPlayingStreamerBotPush = 0;
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
        let dragSourceIndex = null;
        let isSrEnabled = false; 

        function bindStaticUiEvents() {
            const actionHandlers = {
                openPlaylistManager, startSystem, openSettings, prevSong, togglePlay,
                stopSongUI, skipSong, addManualUrl, openBanList, toggleDebug,
                openChangelog, openTutorial, closeSettings, switchSettingsTab,
                saveWsConfig, toggleApiVisibility, saveApiKey, closeChangelog,
                clearAllBans, closeBanList, closePlaylistManager, addBasePlaylist,
                closeTutorial, copySbCode, copyWidgetUrl
            };

            const changeHandlers = { toggleSR, handleQueuePersistenceToggle, saveSongRequestSettings };
            const inputHandlers = { renderBaseList, updateTutLink, saveSongRequestSettings, updateWidgetUrlDisplay };

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
        const wsPortInput = document.getElementById('ws-port-input');
        const wsPassInput = document.getElementById('ws-pass-input');
        const tutWsPortInput = document.getElementById('tut-ws-port');
        const queuePersistInput = document.getElementById('queue-persist-cb');
        const srMaxDurationInput = document.getElementById('sr-max-duration-input');
        const srMusicCategoryInput = document.getElementById('sr-music-category-cb');

        if (wsPortInput) wsPortInput.value = WS_PORT;
        if (wsPassInput) wsPassInput.value = WS_PASS;
        if (tutWsPortInput) tutWsPortInput.value = WS_PORT;
        if (queuePersistInput) queuePersistInput.checked = SHOULD_PERSIST_QUEUE;
        if (srMaxDurationInput) srMaxDurationInput.value = SR_MAX_DURATION_MINUTES;
        if (srMusicCategoryInput) srMusicCategoryInput.checked = SR_REQUIRE_MUSIC_CATEGORY;

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

        function saveSongRequestSettings() {
            const durationInput = document.getElementById('sr-max-duration-input');
            const digitsOnly = durationInput.value.replace(/\D/g, '');
            SR_MAX_DURATION_MINUTES = normalizePositiveInteger(digitsOnly, SR_MAX_DURATION_MINUTES || 15);
            durationInput.value = SR_MAX_DURATION_MINUTES;
            SR_REQUIRE_MUSIC_CATEGORY = document.getElementById('sr-music-category-cb').checked;
            localStorage.setItem('ytm_sr_max_duration_minutes', SR_MAX_DURATION_MINUTES.toString());
            localStorage.setItem('ytm_sr_require_music_category', SR_REQUIRE_MUSIC_CATEGORY ? 'true' : 'false');
            syncSongRequestSettingsToStreamerBot();
        }

        function syncSongRequestSettingsToStreamerBot() {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({
                request: 'DoAction',
                action: { name: 'SongRequestSettings' },
                args: {
                    maxDurationMinutes: SR_MAX_DURATION_MINUTES.toString(),
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
                
                html += `
                <div class="msg-setting-item">
                    <div class="msg-setting-header">
                        <span class="msg-key">${k}</span>
                        <span class="msg-vars">${vars}</span>
                    </div>
                    <div class="msg-setting-body">
                        <input type="text" id="msg_input_${k}" value="${currentTxt.replace(/"/g, '&quot;')}" maxlength="500">
                        <button class="btn-msg-action" onclick="saveCustomMsg('${k}')" title="Save">💾</button>
                        <button class="btn-msg-action btn-msg-reset" onclick="resetCustomMsg('${k}')" title="Restore Default">🔄</button>
                    </div>
                </div>`;
            });
            document.getElementById('msg-settings-list').innerHTML = html;
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
            const newPort = document.getElementById('ws-port-input').value.trim();
            const newPass = document.getElementById('ws-pass-input').value.trim();
            
            if(newPort && !isNaN(newPort)) {
                WS_PORT = newPort;
                WS_PASS = newPass;
                localStorage.setItem('ytm_ws_port', WS_PORT);
                localStorage.setItem('ytm_ws_pass', WS_PASS);
                document.getElementById('tut-ws-port').value = WS_PORT; 
                log(`🔌 WS Port: ${WS_PORT} | Pass: ${WS_PASS ? 'YES' : 'NO'}`, "warn");
                
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
            return new URL('http://localhost:7474/ytm/now-playing-widget.html');
        }

        function getWidgetUrl() {
            const url = getWidgetUrlBase();
            const portInput = document.getElementById('ws-port-input');
            const passInput = document.getElementById('ws-pass-input');
            const port = (portInput && portInput.value.trim()) ? portInput.value.trim() : WS_PORT;
            const pass = passInput ? passInput.value.trim() : WS_PASS;

            if (port && port !== '8080') url.searchParams.set('port', port);
            if (pass) url.searchParams.set('pass', pass);
            if (currentLang) url.searchParams.set('lang', currentLang);
            return url.toString();
        }

        function updateWidgetUrlDisplay() {
            const output = document.getElementById('widget-url-output');
            if (output) output.value = getWidgetUrl();
        }

        function copyWidgetUrl() {
            updateWidgetUrlDisplay();
            const output = document.getElementById('widget-url-output');
            if (!output) return;
            output.focus();
            output.select();
            output.setSelectionRange(0, 99999);

            const done = () => {
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
                document.getElementById('btn-run').innerText = t('ui_btn_start_req');
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
                else document.getElementById('btn-run').innerText = t('ui_btn_downloading');
            } else {
                alert("Invalid API Key!");
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
            let folder = document.getElementById('tut-folder').value.trim() || 'ytm';
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
            navigator.clipboard.writeText(copyText.value).then(() => {
                alert("Copied to clipboard!");
            });
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
                <div class="modal-item playlist-style">
                    <div class="modal-item-title" title="${p.id}">🎵 ${displayTitle}</div>
                    <button class="btn-modal-action danger" onclick="removeBasePlaylist(${i})">${t('ui_remove')}</button>
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
            if(confirm("Are you sure?")) {
                bannedSongs = [];
                localStorage.removeItem('ytm_banned_songs');
                log("🧹 Blacklist cleared!", "warn");
                renderBanList();
            }
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
                banButton +
                '<div class="np-card-progress"><div id="' + prefix + '-progress" class="np-card-progress-fill"></div></div>' +
            '</div>';
        }

        function getNowPlayingWidgetState() {
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
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
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

        function updateNowPlayingProgress() {
            const state = getNowPlayingWidgetState();
            updateNowPlayingCardProgress('panel-now-playing', state);
            publishNowPlayingWidgetState(state);
        }

        function triggerNowPlayingWaveEffect(effect, durationMs = 520) {
            nowPlayingWaveEffect = effect;
            nowPlayingWaveEffectUntil = Date.now() + durationMs;
            nowPlayingWaveEffectId = (nowPlayingWaveEffectId + 1) % 1000000;
            const state = getNowPlayingWidgetState();
            updateNowPlayingCardProgress('panel-now-playing', state);
            publishNowPlayingWidgetState(state, true);
        }

        function clearNowPlayingWaveEffect() {
            nowPlayingWaveEffect = '';
            nowPlayingWaveEffectUntil = 0;
        }

        function stopCurrentSongWithWave() {
            clearTimeout(stopTransitionTimeout);
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
            const btns = document.getElementById('floating-btns');
            
            if (consoleEl.style.display === 'block') {
                consoleEl.style.display = 'none';
                topSection.classList.remove('debug-open');
                btns.style.bottom = '50px';
            } else {
                consoleEl.style.display = 'block';
                topSection.classList.add('debug-open');
                consoleEl.scrollTop = consoleEl.scrollHeight;
                btns.style.bottom = '200px'; 
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
                    document.getElementById('btn-run').innerText = t('ui_btn_start_error');
                    openSettings();
                }
            }
        }

        function cueStartupSong(song) {
            if (!song || !player || initialSongLoaded || currentSongInfo) return;
            initialSongLoaded = true;
            currentSongInfo = normalizeSongForStorage({ ...song, user: 'Auto', isStartup: true });
            currentSongStopped = false;
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
                document.getElementById('base-count').innerText = `🎵 0`;
                document.getElementById('btn-run').disabled = true;
                return;
            }

            document.getElementById('btn-run').innerText = t('ui_btn_downloading');
            document.getElementById('btn-run').disabled = true;
            masterList = []; titleCache = {};

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
                                document.getElementById('btn-run').innerText = t('ui_btn_start_error');
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
                document.getElementById('base-count').innerText = `🎵 ${masterList.length}`;
                const btn = document.getElementById('btn-run');
                btn.innerText = t('ui_btn_start_active');
                btn.disabled = false;
                renderBaseList();
            } catch (e) {
                log("Error: " + e.message, "error");
            }
        }

        function startSystem() {
            if (masterList.length === 0) return;
            log("Shuffling...");
            let shuffled = [...masterList];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            playQueue = shuffled.map(id => {
                let info = titleCache[id];
                return { id: id, title: info.title, author: info.author, user: "Auto", duration: info.duration };
            });
            renderQueue(); playNext();
        }

        function playNext() {
            clearTimeout(skipTransitionTimeout);
            clearTimeout(stopTransitionTimeout);
            skipTransitionTimeout = null;
            stopTransitionTimeout = null;
            clearNowPlayingWaveEffect();
            if(currentSongInfo) playHistory.push(currentSongInfo);
            
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
                startSystem(); 
            }
        }

        function onPlayerStateChange(e) {
            if (e.data === 0) playNext(); 
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
            }
        }

        function skipSong() {
            log("⏭️ SKIP", "warn");
            if (!currentSongInfo) {
                playNext();
                return;
            }

            clearTimeout(skipTransitionTimeout);
            triggerNowPlayingWaveEffect('skip', 820);
            skipTransitionTimeout = setTimeout(() => {
                nowPlayingWaveHoldUntilStart = true;
                nowPlayingWaveEffect = '';
                nowPlayingWaveEffectUntil = 0;
                skipTransitionTimeout = null;
                lastNowPlayingStreamerBotPush = 0;
                publishNowPlayingWidgetState(getNowPlayingWidgetState(), true);
                playNext();
            }, 680);
        }
        
        function togglePlay() { 
            if (!currentSongInfo) {
                if (playQueue.length === 0) {
                    if (masterList.length > 0) startSystem();
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
                    if (masterList.length > 0) {
                        sendChatMessage(t('msg_base_play', {user: user}));
                        startSystem();
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

        function addSongFromChat(songObj, force = false) {
            if(songObj.author) songObj.author = cleanAuthorName(songObj.author);
            if (!force && songObj.user !== "Streamer" && songObj.duration && songObj.duration > SR_MAX_DURATION_MINUTES * 60) {
                sendChatMessage(t('msg_err_long', {user: songObj.user, info: Math.ceil(songObj.duration / 60), limit: SR_MAX_DURATION_MINUTES}));
                return;
            }
            songObj.isNew = true;

            let insertIndex = playQueue.findIndex(song => song.user === 'Auto');
            if (insertIndex === -1) { playQueue.push(songObj); insertIndex = playQueue.length - 1; } 
            else playQueue.splice(insertIndex, 0, songObj);
            
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

        function sendChatMessage(msg) {
            if(ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({"request": "DoAction", "action": { "name": "ChatMessage" }, "args": { "message": msg }, "id": "MsgOut" }));
            }
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

        function renderQueue() {
            const queueContainer = document.getElementById('queue-list');
            const nowPlayingBox = document.getElementById('now-playing-content');
            
            document.getElementById('queue-count').innerText = '🎵 ' + (playQueue.length + (currentSongInfo ? 1 : 0));
            
            let totalSeconds = 0;
            if (currentSongInfo) totalSeconds += (currentSongInfo.duration || 210);
            playQueue.forEach(song => { totalSeconds += (song.duration || 210); });
            
            let h = Math.floor(totalSeconds / 3600); let m = Math.floor((totalSeconds % 3600) / 60); let s = totalSeconds % 60;
            document.getElementById('queue-time').innerText = `⏱️ ${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;

            if (currentSongInfo) {
                nowPlayingBox.innerHTML = renderNowPlayingCard(currentSongInfo, { prefix: 'panel-now-playing', dropTarget: true, showBan: true, className: 'panel-card' });
                applyCoverThemeToNowPlayingCard(document.getElementById('panel-now-playing-card'), 'https://i.ytimg.com/vi/' + currentSongInfo.id + '/mqdefault.jpg');
            } else nowPlayingBox.innerHTML = `<div class="ex-style-013">${t('ui_no_song')}</div>`;

            updateNowPlayingProgress();

            if (playQueue.length === 0) { queueContainer.innerHTML = `<div class="ex-style-071">---</div>`; savePersistedQueue(); return; }
            
            queueContainer.innerHTML = playQueue.slice(0, 40).map((song, i) => {
                let typeClass = ""; let badgeClass = "badge";
                if (song.user !== "Auto") {
                    if (song.user === "Streamer") { typeClass = "manual"; badgeClass = "badge badge-manual"; } 
                    else { typeClass = "request"; badgeClass = "badge badge-user"; }
                }
                if (i === 0) typeClass += " next";
                let animClass = song.isNew ? "animate-in" : "";
                if (song.isNew) setTimeout(() => { song.isNew = false; }, 500); 

                return `
                <div class="q-item ${typeClass} ${animClass}" draggable="true" data-index="${i}" ondragstart="handleDragStart(event)" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event)" ondragend="handleDragEnd(event)">
                    <div class="track-num">${i + 2}.</div>
                    <img src="https://i.ytimg.com/vi/${song.id}/default.jpg">
                    <div class="track-info">
                        <div class="track-title">${song.title}</div>
                        <div class="track-meta">
                            ${song.user !== 'Auto' ? `<span class="${badgeClass}">👤 ${song.user}</span>` : `<span class="badge badge-auto">🤖 Auto</span>`}
                            <span class="badge badge-time">⏱️ ${formatTime(song.duration)}</span>
                            <span class="badge badge-author">🎤 ${song.author}</span>
                        </div>
                    </div>
                    <button class="btn-ban" onclick="banSong(${i})" title="Ban">🔨</button>
                    <button class="btn-remove" onclick="removeSongFromUI(${i})" title="Remove">❌</button>
                </div>`;
            }).join('');
            savePersistedQueue();
            updateNowPlayingProgress();
        }

        function renderBaseList() {
            const container = document.getElementById('base-list');
            const searchInput = document.getElementById('base-search');
            const query = searchInput ? searchInput.value.toLowerCase().trim() : "";

            let filteredList = masterList;
            
            if (query !== "") {
                filteredList = masterList.filter(id => {
                    let info = titleCache[id];
                    if(!info) return false;
                    let searchStr = (info.title + " " + info.author).toLowerCase();
                    return searchStr.includes(query);
                });
            }

            if (filteredList.length === 0 && masterList.length > 0) {
                container.innerHTML = `<div class="ex-style-068">0 results</div>`;
                return;
            }

            container.innerHTML = filteredList.map((id) => {
                let info = titleCache[id];
                let originalIndex = masterList.indexOf(id) + 1; 
                
                return `
                <div class="q-item compact">
                    <div class="track-num" title="Base ID">${originalIndex}.</div>
                    <img src="https://i.ytimg.com/vi/${id}/default.jpg">
                    <div class="track-info">
                        <div class="track-title" title="${info.title}">${info.title}</div>
                        <div class="track-meta">
                            <span class="badge badge-time">⏱️ ${formatTime(info.duration)}</span>
                            <span class="badge badge-author">🎤 ${info.author}</span>
                        </div>
                    </div>
                    <button class="btn-add" onclick="fetchAndAddById('${id}', 'Streamer')" title="Add">+</button>
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

        function setWebsocketConnected() {
            document.getElementById('status').innerText = t('ui_bot_connected');
            document.getElementById('status').style.color = "#00ff88";
        }

        function setWebsocketAuthFailed(message = "WebSocket Authentication Failed!") {
            document.getElementById('status').innerText = t('ui_bot_auth_fail');
            document.getElementById('status').style.color = "var(--red)";
            log(`🔴 ${message}`, "error");
        }

        async function handleStreamerBotHello(raw) {
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
                    ws.send(JSON.stringify({ "request": "Authenticate", "authentication": authentication, "id": "auth" }));
                } catch (error) {
                    setWebsocketAuthFailed("Unable to generate WebSocket authentication.");
                    console.error(error);
                }
                return;
            }

            setWebsocketConnected();
            subscribeToStreamerBotEvents();
        }

        function connectWebsocket() {
            ws = new WebSocket(`ws://localhost:${WS_PORT}/`);
            ws.onopen = () => { 
                log(`🔌 WebSocket opened on port ${WS_PORT}`, "normal");
            };
            ws.onmessage = async (e) => {
                const rawData = e.data.toString();
                try {
                    const raw = JSON.parse(rawData);

                    if (raw.request === "Hello") {
                        await handleStreamerBotHello(raw);
                        return;
                    }

                    if (raw.id === "Sub") return;
                    
                    if (raw.id === "auth") {
                        if (raw.status === "ok") {
                            setWebsocketConnected();
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
                        if (inner.type === "SONG_REQUEST") {
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
                                case "API_ERROR": msg += t('msg_err_api', {user: inner.user}); break;
                            }
                            sendChatMessage(msg);
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
            ws.onclose = () => { 
                document.getElementById('status').innerText = t('ui_bot_disconnected');
                document.getElementById('status').style.color = "var(--red)";
                wsReconnectTimeout = setTimeout(connectWebsocket, 5000); 
            };
        }


Object.assign(window, {
    onYouTubeIframeAPIReady,
    saveCustomMsg,
    resetCustomMsg,
    removeBasePlaylist,
    unbanSong,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
    banCurrentSong,
    banSong,
    removeSongFromUI,
    fetchAndAddById
});
}
