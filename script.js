/* =============================================================
   かわらぼにずむ — script.js
   ============================================================= */

'use strict';

/* ── Song list ─────────────────────────────────────────────────
   楽曲を追加するにはここにファイル名を追加するだけでOK
──────────────────────────────────────────────────────────────── */
const SONG_FILES = ['music1.json', 'music2.json', 'music3.json'];

/* ── Constants ─────────────────────────────────────────────────*/
const KEYS        = ['d', 'f', 'j', 'k'];
const HIT_PCT     = 0.85;          // hit zone position (matches CSS --hit-pct)
const JUDGE_WIN   = { perfect: 0.05, great: 0.10 }; // seconds
const NOTE_H      = 22;            // px (matches CSS --note-h)

/* ── Game State ────────────────────────────────────────────────*/
const GS = { MENU: 0, PLAYING: 1, RESULT: 2 };
let state       = GS.MENU;
let loopId      = null;

/* ── Songs metadata (loaded from JSON) ─────────────────────────*/
let songs = [];          // { name, youtubeId, jsonFile, jacket }
let songIdx = 0;

/* ── Settings (persisted to localStorage) ─────────────────────*/
const LS_KEY = 'kawarabonism2_';
let cfg = {
    volMusic : clampInt(loadLS('volMusic', 80), 0, 100),
    volSE    : clampInt(loadLS('volSE', 80), 0, 100),
    offset : parseInt(loadLS('offset', 0), 10),  // ms  (positive = notes hit later)
    speed  : parseFloat(loadLS('speed', 1.5)),   // fall time in seconds
    autoMode : loadLS('autoMode', 'false') === 'true',
    mvMode : loadLS('mvMode', 'full') // 'full' or 'thumb'
};

/* ── YouTube ───────────────────────────────────────────────────*/
let ytPlayer      = null;
let ytReady       = false;

/* ── Game variables ────────────────────────────────────────────*/
let notes         = [];
let totalNotes    = 0;
let score         = resetScore();
let isHolding     = [false, false, false, false];
let vt            = 0;      // virtual time (seconds, synced to YouTube)
let startPerf     = null;   // performance.now() at vt=0
let videoStarted  = false;
let isBuffering   = false;
let isPaused      = false;
let hitZoneY      = 0;      // pixel Y of hit zone (measured after layout)
let lastYtT       = -1;     // last raw YouTube time to prevent jitter

/* ── DOM refs ──────────────────────────────────────────────────*/
const $ = id => document.getElementById(id);
const menuScreen   = $('menu-screen');
const gameScreen   = $('game-screen');
const resultScreen = $('result-screen');
const jacketImg    = $('jacket-img');
const songNameEl   = $('song-name');
const songNameHud  = $('song-name-hud');
const scorePct     = $('score-pct');
const comboDisp    = $('combo-display');
const comboNum     = $('combo-num');
const judgeDisp    = $('judge-display');
const pauseOverlay = $('pause-overlay');
const loadingOv    = $('loading-overlay');
const loadingTxt   = $('loading-text');
const volMusicSlider  = $('vol-music-slider');
const volMusicDisplay = $('vol-music-display');
const volSESlider     = $('vol-se-slider');
const volSEDisplay    = $('vol-se-display');
const offsetDisp   = $('offset-display');
const speedDisp    = $('speed-display');
const autoDisplay  = $('auto-display');
const btnAutoToggle= $('btn-auto-toggle');
const mvDisplay    = $('mv-display');
const btnMvToggle  = $('btn-mv-toggle');

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
async function init() {
    // Load all song JSONs to get names/youtubeIds
    songs = [];
    for (const file of SONG_FILES) {
        try {
            const r = await fetch(file);
            if (!r.ok) throw new Error(r.status);
            const d = await r.json();
            songs.push({
                jsonFile  : file,
                name      : d.property.name,
                youtubeId : d.property.youtubeId,
                jacket    : `ui_jacket_${file.replace('.json', '')}.png`,
                data      : d
            });
        } catch (e) {
            console.warn(`Failed to load ${file}:`, e);
        }
    }
    if (songs.length === 0) {
        alert('譜面ファイルが見つかりません。');
        return;
    }
    applySettings();
    updateMenuDisplay();
    showScreen(menuScreen);
}

/* ── YouTube IFrame API (called by YT script) ──────────────────*/
window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('yt-player', {
        height: '720', width: '1280',
        playerVars: {
            autoplay: 0, controls: 0, disablekb: 1,
            iv_load_policy: 3, modestbranding: 1,
            rel: 0, fs: 0, playsinline: 1
        },
        events: {
            onReady : () => { ytReady = true; },
            onStateChange : onYtStateChange,
            onError : e => {
                console.error('YT error', e.data);
                hideLoading();
            }
        }
    });
};

function onYtStateChange(e) {
    if (state !== GS.PLAYING) return;
    const S = YT.PlayerState;
    if (e.data === S.PLAYING && !videoStarted) {
        videoStarted = true;
        const ytT = ytPlayer.getCurrentTime() + cfg.offset / 1000;
        startPerf = performance.now() - ytT * 1000;
        vt = ytT;
        hideLoading();
    }
    if (e.data === S.ENDED && videoStarted) endGame();
}

/* ══════════════════════════════════════════════════════════════
   MENU
══════════════════════════════════════════════════════════════ */
function showMenu() {
    state = GS.MENU;
    stopYt();
    showScreen(menuScreen);
    updateMenuDisplay();
}

function updateMenuDisplay() {
    if (!songs.length) return;
    const s = songs[songIdx];
    jacketImg.src = s.jacket;
    songNameEl.textContent = s.name;
}

/* ══════════════════════════════════════════════════════════════
   GAME START
══════════════════════════════════════════════════════════════ */
async function startGame() {
    if (!songs.length) return;
    const song = songs[songIdx];

    // Parse notes
    parseNotes(song.data);
    if (totalNotes === 0) { alert('譜面にノーツがありません。'); return; }

    // Reset
    score        = resetScore();
    isHolding    = [false, false, false, false];
    vt           = 0;
    startPerf    = null;
    videoStarted = false;
    isBuffering  = false;
    isPaused     = false;
    lastYtT      = -1;

    // Clear old note elements
    document.querySelectorAll('.note').forEach(n => n.remove());
    pauseOverlay.classList.remove('active');
    updateScoreDisplay();
    comboDisp.classList.remove('show', 'pop');
    judgeDisp.className = '';
    songNameHud.textContent = song.name;

    // Switch to game screen & measure layout
    showScreen(gameScreen);
    hitZoneY = $('lanes').offsetHeight * HIT_PCT;

    // Load & buffer YouTube video
    if (ytReady) {
        showLoading('動画をバッファリング中...');
        ytPlayer.loadVideoById({ videoId: song.youtubeId, startSeconds: 0 });
        ytPlayer.unMute();
        ytPlayer.setVolume(cfg.volMusic);
        // Wait until enough is buffered, then play
        await waitForBuffer();
        ytPlayer.seekTo(0, true);
        ytPlayer.playVideo();
    }

    state = GS.PLAYING;
    loopId = requestAnimationFrame(gameLoop);
}

function waitForBuffer() {
    return new Promise(resolve => {
        // Poll every 300ms until video is "ready" enough (cued or buffering is done)
        const check = () => {
            if (!ytReady) { setTimeout(check, 300); return; }
            const s = ytPlayer.getPlayerState();
            // -1 = unstarted, 3 = buffering — keep waiting
            // 5 = cued, 1 = playing (shouldn't happen), 2 = paused → good
            if (s === YT.PlayerState.BUFFERING || s === -1) {
                setTimeout(check, 300);
            } else {
                resolve();
            }
        };
        setTimeout(check, 400);
    });
}

/* ══════════════════════════════════════════════════════════════
   NOTES PARSING
══════════════════════════════════════════════════════════════ */
function parseNotes(data) {
    notes      = [];
    totalNotes = 0;
    const bpm        = parseFloat(data.property.bpm);
    const preCount   = parseFloat(data.property.pre_count || 0);
    const beatDur    = 60 / bpm;
    const longStarts = [null, null, null, null];

    // Sort keys naturally (beat_1 before beat_10)
    const sortedKeys = Object.keys(data.notes).sort((a, b) => {
        const na = parseInt(a.replace('beat_', ''), 10);
        const nb = parseInt(b.replace('beat_', ''), 10);
        return na - nb;
    });

    for (const key of sortedKeys) {
        if (!key.startsWith('beat_')) continue;
        const beatNum    = parseInt(key.replace('beat_', ''), 10);
        const targetTime = (preCount + beatNum - 1) * beatDur;
        const val        = (data.notes[key] || '0000').padEnd(4, '0');

        for (let i = 0; i < 4; i++) {
            const t = val[i];
            if (t === '1') {
                notes.push({ lane: i, type: 'normal', targetTime, hit: false, element: null });
                totalNotes++;
            } else if (t === '2') {
                if (longStarts[i] === null) {
                    longStarts[i] = { lane: i, type: 'long', targetTime, endTime: null, hit: false, active: false, element: null };
                } else {
                    longStarts[i].endTime = targetTime;
                    notes.push(longStarts[i]);
                    longStarts[i] = null;
                    totalNotes += 2;
                }
            }
        }
    }
    notes.sort((a, b) => a.targetTime - b.targetTime);
}

/* ══════════════════════════════════════════════════════════════
   GAME LOOP
══════════════════════════════════════════════════════════════ */
function gameLoop() {
    if (state !== GS.PLAYING) return;
    if (isPaused) { loopId = requestAnimationFrame(gameLoop); return; }

    // Sync with YouTube
    if (ytReady && videoStarted) {
        const ytState = ytPlayer.getPlayerState();
        if (ytState === YT.PlayerState.PLAYING) {
            if (isBuffering) {
                // Re-sync after buffer
                const rawYtT = ytPlayer.getCurrentTime();
                const ytT = rawYtT + cfg.offset / 1000;
                startPerf = performance.now() - ytT * 1000;
                isBuffering = false;
                lastYtT = rawYtT;
            }
            const rawYtT = ytPlayer.getCurrentTime();
            const ytT    = rawYtT + cfg.offset / 1000;
            const perfT  = (performance.now() - startPerf) / 1000;
            
            if (rawYtT !== lastYtT) {
                lastYtT = rawYtT;
                // Only resync when YouTube provides a new timestamp
                if (Math.abs(perfT - ytT) > 0.1) {
                    startPerf = performance.now() - ytT * 1000;
                    vt = ytT;
                } else {
                    vt = perfT;
                }
            } else {
                vt = perfT;
            }
        } else if (ytState === YT.PlayerState.BUFFERING) {
            isBuffering = true;
            vt = ytPlayer.getCurrentTime() + cfg.offset / 1000;
        } else if (ytState === YT.PlayerState.PAUSED && !isPaused) {
            // YouTube paused from outside — treat as our pause
            togglePause();
            loopId = requestAnimationFrame(gameLoop);
            return;
        } else if (ytState === YT.PlayerState.ENDED) {
            endGame(); return;
        }
    } else if (videoStarted && startPerf !== null) {
        vt = (performance.now() - startPerf) / 1000;
    }

    // Check song end
    if (videoStarted && notes.length > 0) {
        const last = notes[notes.length - 1];
        const lastT = last.endTime !== undefined ? last.endTime : last.targetTime;
        const allDone = notes.every(n => n.hit || vt > (n.endTime || n.targetTime) + 0.3);
        if (allDone && vt > lastT + 1.5) { endGame(); return; }
    }

    updateNotes();
    loopId = requestAnimationFrame(gameLoop);
}

/* ── Note positioning ──────────────────────────────────────────*/
function noteTimeToY(t) {
    const rem = t - vt;
    return -NOTE_H + (1 - rem / cfg.speed) * (hitZoneY + NOTE_H);
}

function updateNotes() {
    for (const note of notes) {
        if (note.hit && !note.element) continue;

        const spawnT = note.targetTime - cfg.speed;
        if (!note.element && vt >= spawnT && !note.hit) createNoteEl(note);
        if (!note.element) continue;

        // Auto Mode
        if (cfg.autoMode) {
            if (note.type === 'normal' && !note.hit && vt >= note.targetTime) {
                playHit();
                activateLane(note.lane, true);
                setTimeout(() => activateLane(note.lane, false), 80);
                note.hit = true;
                note.element?.remove();
                note.element = null;
                registerHit('perfect');
                continue;
            } else if (note.type === 'long') {
                if (!note.active && !note.hit && vt >= note.targetTime) {
                    playHit();
                    activateLane(note.lane, true);
                    note.active = true;
                    note.element?.classList.add('note-long-active');
                    registerHit('perfect');
                }
                if (note.active && !note.hit && vt >= note.endTime) {
                    activateLane(note.lane, false);
                    note.active = false;
                    note.hit = true;
                    note.element?.remove();
                    note.element = null;
                    registerHit('perfect');
                    continue;
                }
            }
        }

        if (note.type === 'normal') {
            note.element.style.transform = `translateY(${noteTimeToY(note.targetTime)}px)`;
        } else {
            const headY = noteTimeToY(note.targetTime);
            const tailY = noteTimeToY(note.endTime);
            if (note.active) {
                const effTail = Math.min(tailY, hitZoneY);
                note.element.style.transform = `translateY(${effTail}px)`;
                note.element.style.height = Math.max(hitZoneY - effTail + NOTE_H, NOTE_H * 2) + 'px';
            } else {
                const clampTail = Math.max(tailY, -NOTE_H);
                note.element.style.transform = `translateY(${clampTail}px)`;
                note.element.style.height = Math.max(headY - clampTail + NOTE_H, NOTE_H * 2) + 'px';
            }
        }

        // Miss detection
        if (!note.hit && !note.active && vt > note.targetTime + JUDGE_WIN.great) {
            registerHit('miss');
            note.hit = true;
            note.element.style.opacity = '0.2';
        } else if (note.type === 'long' && note.active && vt > note.endTime + JUDGE_WIN.great) {
            registerHit('miss');
            note.active = false;
            note.hit    = true;
            note.element.style.opacity = '0.2';
        }

        // Remove element if it falls past the bottom
        if (note.hit && note.element) {
            const tailY = noteTimeToY(note.type === 'long' ? note.endTime : note.targetTime);
            if (tailY > hitZoneY + (hitZoneY * 0.25)) {
                note.element.remove();
                note.element = null;
            }
        }
    }
}

function createNoteEl(note) {
    const el = document.createElement('div');
    el.className = 'note note-' + note.type;
    if (note.type === 'long') {
        const tail = document.createElement('div'); tail.className = 'note-long-tail';
        const body = document.createElement('div'); body.className = 'note-long-body';
        const head = document.createElement('div'); head.className = 'note-long-head';
        el.append(tail, body, head);
        note.headEl = head; note.bodyEl = body; note.tailEl = tail;
    }
    $(`lane-${note.lane}`).appendChild(el);
    note.element = el;
}

/* ══════════════════════════════════════════════════════════════
   INPUT HANDLING
══════════════════════════════════════════════════════════════ */
// Hit sound
let audioCtx = null;
let hitSoundBuffer = null;

const AudioContext = window.AudioContext || window.webkitAudioContext;
if (AudioContext) {
    audioCtx = new AudioContext();
    fetch('sound_notes_push.mp3')
        .then(r => r.arrayBuffer())
        .then(b => audioCtx.decodeAudioData(b))
        .then(buf => { hitSoundBuffer = buf; })
        .catch(e => console.warn('Audio err', e));
}

function playHit() {
    if (!audioCtx || !hitSoundBuffer) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const src = audioCtx.createBufferSource();
    src.buffer = hitSoundBuffer;
    const gain = audioCtx.createGain();
    gain.gain.value = Math.min(1, cfg.volSE / 100);
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start(0);
}

// Keyboard
window.addEventListener('keydown', e => {
    if (e.repeat) return;

    if (state === GS.MENU) {
        if (e.key === 'ArrowLeft')  { songIdx = (songIdx - 1 + songs.length) % songs.length; updateMenuDisplay(); }
        if (e.key === 'ArrowRight') { songIdx = (songIdx + 1) % songs.length; updateMenuDisplay(); }
        if (e.key === 'Enter')      { startGame(); }
        if (e.key === 'ArrowUp')    { $('setting-volume').scrollIntoView({ behavior: 'smooth' }); }
        return;
    }

    if (state === GS.PLAYING) {
        if (e.code === 'Space') { togglePause(); return; }
        if (e.key  === 'Enter') { quitGame(); return; }
        if (isPaused || cfg.autoMode) return;
        const li = KEYS.indexOf(e.key.toLowerCase());
        if (li !== -1) { playHit(); pressLane(li); activateLane(li, true); }
    }

    if (state === GS.RESULT) {
        if (e.code === 'Space' || e.key === 'Enter') showMenu();
    }
});

window.addEventListener('keyup', e => {
    if (state !== GS.PLAYING || cfg.autoMode) return;
    const li = KEYS.indexOf(e.key.toLowerCase());
    if (li !== -1) { releaseLane(li); activateLane(li, false); }
});

// Touch — note lanes
const activeTouches = new Map();
$('touch-overlay').addEventListener('touchstart', e => {
    e.preventDefault();
    if (state !== GS.PLAYING || isPaused || cfg.autoMode) return;
    for (const t of e.changedTouches) {
        const li = touchToLane(t.clientX);
        if (li === -1) continue;
        activeTouches.set(t.identifier, li);
        playHit(); pressLane(li); activateLane(li, true);
    }
}, { passive: false });

$('touch-overlay').addEventListener('touchend', e => {
    e.preventDefault();
    if (cfg.autoMode) return;
    for (const t of e.changedTouches) {
        const li = activeTouches.get(t.identifier);
        if (li === undefined) continue;
        activeTouches.delete(t.identifier);
        releaseLane(li); activateLane(li, false);
    }
}, { passive: false });

$('touch-overlay').addEventListener('touchcancel', e => {
    if (cfg.autoMode) return;
    for (const t of e.changedTouches) {
        const li = activeTouches.get(t.identifier);
        if (li === undefined) continue;
        activeTouches.delete(t.identifier);
        releaseLane(li); activateLane(li, false);
    }
}, { passive: false });

function touchToLane(clientX) {
    const items = document.querySelectorAll('.t-lane');
    for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right) return i;
    }
    return -1;
}

function activateLane(li, on) {
    $(`lane-${li}`).classList.toggle('active', on);
}

/* ── Press / Release ───────────────────────────────────────────*/
function pressLane(li) {
    const unhit = notes.filter(n => n.lane === li && !n.hit);
    if (!unhit.length) return;
    const nearest = unhit.reduce((p, c) =>
        Math.abs(c.targetTime - vt) < Math.abs(p.targetTime - vt) ? c : p);
    const diff = Math.abs(nearest.targetTime - vt);
    if (diff > JUDGE_WIN.great) return;

    if (nearest.type === 'normal') {
        nearest.hit = true;
        nearest.element?.remove();
        nearest.element = null;
    } else {
        nearest.active = true;
        nearest.element?.classList.add('note-long-active');
    }
    registerHit(diff < JUDGE_WIN.perfect ? 'perfect' : 'great');
}

function releaseLane(li) {
    const held = notes.find(n => n.lane === li && n.type === 'long' && n.active && !n.hit);
    if (!held) return;
    held.active = false;
    held.hit    = true;
    held.element?.remove();
    held.element = null;
    const diff = Math.abs(held.endTime - vt);
    registerHit(diff < JUDGE_WIN.great
        ? (diff < JUDGE_WIN.perfect ? 'perfect' : 'great')
        : 'miss');
}

/* ── Scoring ───────────────────────────────────────────────────*/
function registerHit(j) {
    if (j === 'perfect') { score.perfect++; score.combo++; }
    else if (j === 'great') { score.great++; score.combo++; }
    else { score.miss++; score.combo = 0; }
    if (score.combo > score.maxCombo) score.maxCombo = score.combo;
    updateScoreDisplay();
    showJudge(j);
}

function updateScoreDisplay() {
    if (cfg.autoMode) {
        scorePct.textContent = 'AUTO';
    } else {
        const s = (score.perfect + score.great * 0.5) / (totalNotes || 1) * 100;
        scorePct.textContent = s.toFixed(2) + '%';
    }
    if (score.combo > 0) {
        comboNum.textContent = score.combo;
        comboDisp.classList.add('show');
        comboDisp.classList.remove('pop');
        void comboDisp.offsetWidth;
        comboDisp.classList.add('pop');
    } else {
        comboDisp.classList.remove('show');
    }
}

function showJudge(j) {
    judgeDisp.className = '';
    void judgeDisp.offsetWidth;
    judgeDisp.textContent = j.toUpperCase();
    judgeDisp.classList.add('j-' + j, 'pop-anim');
}

/* ── Pause / Quit ──────────────────────────────────────────────*/
function togglePause() {
    if (state !== GS.PLAYING || !videoStarted) return;
    isPaused = !isPaused;
    if (isPaused) {
        ytPlayer?.pauseVideo();
        pauseOverlay.classList.add('active');
    } else {
        ytPlayer?.playVideo();
        pauseOverlay.classList.remove('active');
        // Re-sync on resume
        if (ytReady) {
            const ytT = ytPlayer.getCurrentTime() + cfg.offset / 1000;
            startPerf = performance.now() - ytT * 1000;
        }
    }
}

function quitGame() {
    cancelAnimationFrame(loopId);
    stopYt();
    isPaused = false;
    pauseOverlay.classList.remove('active');
    showMenu();
}

/* ── End Game ──────────────────────────────────────────────────*/
function endGame() {
    state = GS.RESULT;
    cancelAnimationFrame(loopId);
    stopYt();

    const song = songs[songIdx];
    const s    = (score.perfect + score.great * 0.5) / (totalNotes || 1) * 100;

    $('result-jacket').src          = song.jacket;
    $('result-song-name').textContent = song.name;

    if (cfg.autoMode) {
        $('result-score').textContent   = 'AUTO';
        document.querySelector('.pct-label').style.display = 'none';
    } else {
        $('result-score').textContent   = s.toFixed(2);
        document.querySelector('.pct-label').style.display = 'inline';
    }

    $('r-perfect').textContent      = score.perfect;
    $('r-great').textContent        = score.great;
    $('r-miss').textContent         = score.miss;
    $('r-maxcombo').textContent     = score.maxCombo;

    showScreen(resultScreen);
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS
══════════════════════════════════════════════════════════════ */
function applySettings() {
    volMusicSlider.value     = cfg.volMusic;
    volMusicDisplay.textContent = cfg.volMusic;
    volSESlider.value        = cfg.volSE;
    volSEDisplay.textContent   = cfg.volSE;
    offsetDisp.textContent   = cfg.offset + ' ms';
    speedDisp.textContent    = cfg.speed.toFixed(1) + ' s';
    autoDisplay.textContent  = cfg.autoMode ? 'ON' : 'OFF';
    mvDisplay.textContent    = cfg.mvMode === 'full' ? '全画面' : '縮小';
}

function saveLS(key, val) { localStorage.setItem(LS_KEY + key, val); }
function loadLS(key, def) { return localStorage.getItem(LS_KEY + key) ?? def; }
function clampInt(v, mn, mx) { return Math.max(mn, Math.min(mx, parseInt(v, 10))); }

// Music Volume
volMusicSlider.addEventListener('input', () => {
    cfg.volMusic = parseInt(volMusicSlider.value, 10);
    volMusicDisplay.textContent = cfg.volMusic;
    saveLS('volMusic', cfg.volMusic);
    if (ytReady && ytPlayer) ytPlayer.setVolume(cfg.volMusic);
});
$('btn-vol-music-minus').addEventListener('click', () => { volMusicSlider.value = Math.max(0,  cfg.volMusic - 5); volMusicSlider.dispatchEvent(new Event('input')); });
$('btn-vol-music-plus' ).addEventListener('click', () => { volMusicSlider.value = Math.min(100, cfg.volMusic + 5); volMusicSlider.dispatchEvent(new Event('input')); });

// SE Volume
volSESlider.addEventListener('input', () => {
    cfg.volSE = parseInt(volSESlider.value, 10);
    volSEDisplay.textContent = cfg.volSE;
    saveLS('volSE', cfg.volSE);
});
$('btn-vol-se-minus').addEventListener('click', () => { volSESlider.value = Math.max(0,  cfg.volSE - 5); volSESlider.dispatchEvent(new Event('input')); });
$('btn-vol-se-plus' ).addEventListener('click', () => { volSESlider.value = Math.min(100, cfg.volSE + 5); volSESlider.dispatchEvent(new Event('input')); });

// Offset
$('btn-offset-minus').addEventListener('click', () => {
    cfg.offset -= 10; offsetDisp.textContent = cfg.offset + ' ms'; saveLS('offset', cfg.offset);
});
$('btn-offset-plus').addEventListener('click', () => {
    cfg.offset += 10; offsetDisp.textContent = cfg.offset + ' ms'; saveLS('offset', cfg.offset);
});

// Speed
$('btn-speed-minus').addEventListener('click', () => {
    cfg.speed = parseFloat(Math.max(0.5, cfg.speed - 0.25).toFixed(2));
    speedDisp.textContent = cfg.speed.toFixed(2) + ' s'; saveLS('speed', cfg.speed);
});
$('btn-speed-plus').addEventListener('click', () => {
    cfg.speed = parseFloat(Math.min(4.0, cfg.speed + 0.25).toFixed(2));
    speedDisp.textContent = cfg.speed.toFixed(2) + ' s'; saveLS('speed', cfg.speed);
});

// Auto Mode
btnAutoToggle.addEventListener('click', () => {
    cfg.autoMode = !cfg.autoMode;
    autoDisplay.textContent = cfg.autoMode ? 'ON' : 'OFF';
    saveLS('autoMode', cfg.autoMode);
    updateScoreDisplay();
});

// MV Mode
btnMvToggle.addEventListener('click', () => {
    cfg.mvMode = cfg.mvMode === 'full' ? 'thumb' : 'full';
    mvDisplay.textContent = cfg.mvMode === 'full' ? '全画面' : '縮小';
    saveLS('mvMode', cfg.mvMode);
});

/* ══════════════════════════════════════════════════════════════
   MENU BUTTONS
══════════════════════════════════════════════════════════════ */
$('btn-prev').addEventListener('click', () => { songIdx = (songIdx - 1 + songs.length) % songs.length; updateMenuDisplay(); });
$('btn-next').addEventListener('click', () => { songIdx = (songIdx + 1) % songs.length; updateMenuDisplay(); });
$('btn-start').addEventListener('click', startGame);
$('btn-back-menu').addEventListener('click', showMenu);
$('btn-pause').addEventListener('click', togglePause);
$('btn-quit').addEventListener('click', quitGame);
$('btn-resume').addEventListener('click', togglePause);
$('btn-quit-pause').addEventListener('click', quitGame);

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */
function showScreen(el) {
    [menuScreen, gameScreen, resultScreen].forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    // ゲーム中のみ背景画像を消してYouTube MVを全画面表示または縮小表示
    document.body.classList.toggle('is-playing', el === gameScreen);
    document.body.classList.toggle('mv-thumb', cfg.mvMode === 'thumb');
}
function stopYt() {
    if (ytReady && ytPlayer) ytPlayer.stopVideo();
}
function showLoading(msg) {
    loadingTxt.textContent = msg;
    loadingOv.classList.remove('loading-hidden');
}
function hideLoading() {
    loadingOv.classList.add('loading-hidden');
}
function resetScore() {
    return { perfect: 0, great: 0, miss: 0, combo: 0, maxCombo: 0 };
}

/* Window resize for layout */
window.addEventListener('resize', () => {
    if (state === GS.PLAYING) {
        hitZoneY = $('lanes').offsetHeight * HIT_PCT;
    }
});

/* Stop YouTube on page unload */
window.addEventListener('beforeunload', stopYt);

/* Start */
init();
