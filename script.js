const GAME_STATE = {
    MENU: 0,
    PLAYING: 1,
    RESULT: 2
};

let currentState = GAME_STATE.MENU;
let gameLoopId;

// ─── YouTube IFrame Player ───────────────────────────────────────
let ytPlayer = null;         // YT.Player instance
let ytPlayerReady = false;   // true after onReady fires

const songs = [
    {
        id: 'music1',
        title: 'かわいいだけじゃだめですか？',
        jacket: 'jacket_music1.jpg',
        youtubeId: 'jZqTz1G8G04',
        notesSrc: 'music1.json'
    },
    {
        id: 'music2',
        title: 'わたしのいちばんかわいいところ',
        jacket: 'jacket_music2.jpg',
        youtubeId: 'NQUo3vITjgY',
        notesSrc: 'music2.json'
    },
    {
        id: 'music3',
        title: 'music3',
        jacket: 'jacket_music3.jpg',
        youtubeId: 'uySbsSsWBiE',
        notesSrc: 'music3.json'
    }
];
let currentSongIndex = 0;

// Game Config
const FALL_TIME = 1.5; // seconds for a note to fall from top to hit zone
const NOTE_HEIGHT = 20;  // px, should match CSS --note-height
const KEYS = ['f', 'g', 'h', 'j'];

// Sound effect
const hitSound = new Audio('sound_notes.mp3');
hitSound.load();
function playHitSound() {
    const s = hitSound.cloneNode();
    s.volume = 0.6;
    s.play().catch(() => { });
}

// Game State Variables
let notes = []; // { lane, type, targetTime, endTime (for long notes), element, hit (bool), active (for long notes) }
let score = { perfect: 0, great: 0, miss: 0, combo: 0, maxCombo: 0 };
let totalNotes = 0;
let isHolding = [false, false, false, false];
let hitZoneY;         // Pixel Y position of the hit zone

// Synchronization variables
let currentVirtualTime = -1.5; // Starts at -FALL_TIME
let gameStartPerf = null;      // performance.now() at game start
let videoStarted = false;      // true once video starts PLAYING
let isBuffering = false;       // true if video is buffering

// Pause and Offset variables
let isPaused = false;
let audioOffset = parseInt(localStorage.getItem('kawarabonism_offset') || '0', 10);

// ─── YouTube API Callback (called automatically by youtube iframe api script) ─
function onYouTubeIframeAPIReady() {
    ytPlayer = new YT.Player('youtube-player', {
        height: '720',
        width: '1280',
        host: 'https://www.youtube.com',
        playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            iv_load_policy: 3,
            modestbranding: 1,
            rel: 0,
            showinfo: 0,
            fs: 0,
            playsinline: 1
        },
        events: {
            onReady: () => { ytPlayerReady = true; },
            onError: (e) => {
                console.error('YT Player error', e.data);
                if (e.data === 150 || e.data === 101) {
                    alert('YouTube Error: この動画は外部サイトでの埋め込み再生が許可されていません。\n公式MVなどは制限されている場合があります。別の動画IDでお試しください。');
                } else {
                    alert('YouTube 動画のロードに失敗しました。エラーコード: ' + e.data);
                }
            }
        }
    });
}

// getVirtualTime removed. We use currentVirtualTime updated in gameLoop.

// DOM Elements
const menuScreen = document.getElementById('menu-screen');
const gameScreen = document.getElementById('game-screen');
const resultScreen = document.getElementById('result-screen');
const songJacket = document.getElementById('song-jacket');
const songTitle = document.getElementById('song-title');
const lanesContainer = document.getElementById('lanes-container');
const scoreDisplay = document.getElementById('current-score');
const comboDisplay = document.getElementById('combo-display');
const currentComboSpan = document.getElementById('current-combo');
const judgementDisplay = document.getElementById('judgement-display');
const pauseOverlay = document.getElementById('pause-overlay');
const offsetDisplay = document.getElementById('offset-display');

// Initialize Menu
function initMenu() {
    currentState = GAME_STATE.MENU;
    menuScreen.classList.add('active');
    gameScreen.classList.remove('active');
    resultScreen.classList.remove('active');

    offsetDisplay.innerText = audioOffset + ' ms';
    updateMenuDisplay();
}

function updateMenuDisplay() {
    const song = songs[currentSongIndex];
    songJacket.src = song.jacket;
    // We fetch JSON just to get the title if needed, or use predefined. Let's use predefined for now to save a fetch, or fetch it.
    songTitle.innerText = song.title;
}

// Start Game
async function startGame() {
    const song = songs[currentSongIndex];

    // Load JSON
    try {
        const response = await fetch(song.notesSrc);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        parseNotes(data);
    } catch (e) {
        console.error("Failed to load notes", e);
        alert(`譜面データ (${song.notesSrc}) のロードに失敗しました。\n・Live Serverが正しいフォルダで起動しているか\n・ファイルが存在するか\nを確認してください。\n詳細: ${e.message}`);
        return;
    }

    // Setup YouTube player with new video
    if (ytPlayer && ytPlayerReady) {
        ytPlayer.loadVideoById({ videoId: song.youtubeId, startSeconds: 0 });
        ytPlayer.unMute();
        ytPlayer.setVolume(80);
        ytPlayer.playVideo();
    }

    // Reset State
    score = { perfect: 0, great: 0, miss: 0, combo: 0, maxCombo: 0 };
    isHolding = [false, false, false, false];
    
    currentVirtualTime = -FALL_TIME;
    gameStartPerf = null;
    videoStarted = false;
    isBuffering = false;
    isPaused = false;
    pauseOverlay.classList.remove('active');
    
    updateScoreDisplay();
    comboDisplay.classList.remove('pop');
    judgementDisplay.classList.remove('pop-anim');

    // Clear DOM Notes
    document.querySelectorAll('.note').forEach(n => n.remove());

    // Transition: show game screen FIRST so we can measure layout
    currentState = GAME_STATE.PLAYING;
    menuScreen.classList.remove('active');
    gameScreen.classList.add('active');

    // Calculate hit zone pixel position AFTER the screen is visible
    hitZoneY = lanesContainer.offsetHeight * 0.85; // matching CSS 85%

    // Start game loop — audio will begin after FALL_TIME seconds
    gameLoopId = requestAnimationFrame(gameLoop);
}

function parseNotes(data) {
    notes = [];
    totalNotes = 0;
    const bpm = parseFloat(data.property.bpm);
    const preCount = data.property.pre_count ? parseFloat(data.property.pre_count) : 0;
    const beatDuration = 60 / bpm;

    let longNoteStarts = [null, null, null, null];

    for (const [key, value] of Object.entries(data.notes)) {
        if (!key.startsWith('beat_')) continue;
        const beatNum = parseInt(key.replace('beat_', ''), 10);
        // Time calculation: (pre_count + beat_num - 1) * beatDuration
        const targetTime = (preCount + beatNum - 1) * beatDuration;

        for (let i = 0; i < 4; i++) {
            const noteType = value[i];
            if (noteType === '1') {
                notes.push({
                    lane: i,
                    type: 'normal',
                    targetTime: targetTime,
                    hit: false,
                    element: null
                });
                totalNotes++;
            } else if (noteType === '2') {
                if (longNoteStarts[i] === null) {
                    // Start of long note
                    longNoteStarts[i] = {
                        lane: i,
                        type: 'long',
                        targetTime: targetTime,
                        endTime: null, // will be set later
                        hit: false,
                        active: false,
                        element: null
                    };
                } else {
                    // End of long note
                    longNoteStarts[i].endTime = targetTime;
                    notes.push(longNoteStarts[i]);
                    longNoteStarts[i] = null;
                    totalNotes += 2; // Count head and tail as separate scoring events
                }
            }
        }
    }

    // Sort notes by targetTime
    notes.sort((a, b) => a.targetTime - b.targetTime);
    songTitle.innerText = data.property.name;
    songs[currentSongIndex].title = data.property.name;
}

function gameLoop() {
    if (currentState !== GAME_STATE.PLAYING) return;

    if (isPaused) {
        // In paused state, do not update notes, but keep requesting animation frame
        gameLoopId = requestAnimationFrame(gameLoop);
        return;
    }

    if (ytPlayer && ytPlayerReady) {
        const state = ytPlayer.getPlayerState();
        
        // Sync pause state from YouTube UI or other events
        if (state === YT.PlayerState.PAUSED && videoStarted && !isPaused) {
            isPaused = true;
            pauseOverlay.classList.add('active');
            gameLoopId = requestAnimationFrame(gameLoop);
            return;
        }

        if (!videoStarted) {
            // Wait for the video to start playing to begin the game
            if (state === YT.PlayerState.PLAYING) {
                videoStarted = true;
                currentVirtualTime = ytPlayer.getCurrentTime() - (audioOffset / 1000);
                gameStartPerf = performance.now() - (currentVirtualTime * 1000);
            } else {
                currentVirtualTime = -FALL_TIME;
            }
        } else {
            if (state === YT.PlayerState.PLAYING) {
                if (isBuffering) {
                    // Re-sync after buffering
                    gameStartPerf = performance.now() - (ytPlayer.getCurrentTime() - (audioOffset / 1000)) * 1000;
                    isBuffering = false;
                }
                
                const ytTime = ytPlayer.getCurrentTime() - (audioOffset / 1000);
                const elapsed = (performance.now() - gameStartPerf) / 1000;
                
                // Sync correction if drift is more than 50ms
                if (Math.abs(elapsed - ytTime) > 0.05) {
                    gameStartPerf = performance.now() - ytTime * 1000;
                    currentVirtualTime = ytTime;
                } else {
                    currentVirtualTime = elapsed;
                }
            } else if (state === YT.PlayerState.BUFFERING) {
                isBuffering = true;
                currentVirtualTime = ytPlayer.getCurrentTime() - (audioOffset / 1000);
            } else if (state === YT.PlayerState.ENDED) {
                endGame();
                return;
            } else if (state !== YT.PlayerState.PAUSED) {
                currentVirtualTime = ytPlayer.getCurrentTime() - (audioOffset / 1000);
            }
        }
    }

    // Check for end of song
    const lastNote = notes[notes.length - 1];
    if (lastNote && videoStarted) {
        const songDone = (currentVirtualTime > (lastNote.endTime || lastNote.targetTime) + 2 &&
            notes.every(n => n.hit || currentVirtualTime > (n.endTime || n.targetTime) + 0.3));
        if (songDone) { endGame(); return; }
    }

    updateNotes(currentVirtualTime);
    gameLoopId = requestAnimationFrame(gameLoop);
}

// Convert a note's targetTime to its Y position on screen.
// At (targetTime - FALL_TIME): y = -NOTE_HEIGHT (just above top)
// At targetTime:               y = hitZoneY (at the hit zone)
function noteTimeToY(time, currentTime) {
    const remaining = time - currentTime;          // positive = future
    const fraction = 1 - remaining / FALL_TIME;   // 0 at spawn, 1 at hitZone
    return -NOTE_HEIGHT + fraction * (hitZoneY + NOTE_HEIGHT);
}

function updateNotes(currentTime) {
    notes.forEach(note => {
        if (note.hit && note.type === 'normal') return;
        if (note.hit && note.type === 'long' && !note.active && currentTime > note.endTime + 0.5) return;

        // --- Spawn ---
        // Spawn when the HEAD of the note reaches the top of the lane
        const spawnTime = note.targetTime - FALL_TIME;
        if (!note.element && currentTime >= spawnTime) {
            createNoteElement(note);
        }

        if (!note.element) return;

        // --- Position ---
        if (note.type === 'normal') {
            const y = noteTimeToY(note.targetTime, currentTime);
            note.element.style.top = `${y}px`;
        } else if (note.type === 'long') {
            // headY = Y of the HEAD image (targetTime earlier  → lower on screen → LARGER Y)
            // tailY = Y of the TAIL image (endTime later       → higher on screen → SMALLER Y)
            // Therefore: tailY < headY  always.
            const headY = noteTimeToY(note.targetTime, currentTime);
            const tailY = noteTimeToY(note.endTime, currentTime);

            if (note.active) {
                // Head is being held at hitZone; tail still falls from above
                // element: top = tailY, bottom = hitZoneY + NOTE_HEIGHT (head image at hitzone)
                const effectiveTailY = Math.min(tailY, hitZoneY);
                note.element.style.top = `${effectiveTailY}px`;
                note.element.style.height = `${Math.max(hitZoneY - effectiveTailY + NOTE_HEIGHT, NOTE_HEIGHT * 2)}px`;
            } else {
                // Both falling: element spans from tail (higher/above) to head (lower/below)
                // top = tailY, height = headY - tailY + NOTE_HEIGHT (includes head image)
                const clampedTailY = Math.max(tailY, -NOTE_HEIGHT);
                const totalHeight = Math.max(headY - clampedTailY + NOTE_HEIGHT, NOTE_HEIGHT * 2);
                note.element.style.top = `${clampedTailY}px`;
                note.element.style.height = `${totalHeight}px`;
            }
        }

        // --- Miss detection ---
        if (!note.hit && !note.active) {
            if (currentTime > note.targetTime + 0.2) {
                registerHit('miss');
                note.hit = true;
                note.element.style.opacity = '0.3';
            }
        } else if (note.type === 'long' && note.active) {
            if (currentTime > note.endTime + 0.2) {
                registerHit('miss');
                note.active = false;
                note.hit = true;
                note.element.style.opacity = '0.3';
            }
        }
    });
}

function createNoteElement(note) {
    const el = document.createElement('div');
    el.className = `note note-${note.type}`;

    if (note.type === 'long') {
        // head: the image at the start (top) of the long note
        const head = document.createElement('div');
        head.className = 'note-long-head';
        // body: the colored fill between head and tail
        const body = document.createElement('div');
        body.className = 'note-long-body';
        // tail: the image at the end (bottom) of the long note
        const tail = document.createElement('div');
        tail.className = 'note-long-tail';
        el.appendChild(tail);  // tail is rendered at top of element (lowest Y on screen)
        el.appendChild(body);
        el.appendChild(head);  // head is rendered at bottom of element (highest Y on screen)
        note.headEl = head;
        note.bodyEl = body;
        note.tailEl = tail;
    }

    document.getElementById(`lane-${note.lane}`).appendChild(el);
    note.element = el;
}

// Input Handling
window.addEventListener('keydown', (e) => {
    if (e.repeat) return;

    if (currentState === GAME_STATE.MENU) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            currentSongIndex = (currentSongIndex + 1) % songs.length;
            updateMenuDisplay();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            currentSongIndex = (currentSongIndex - 1 + songs.length) % songs.length;
            updateMenuDisplay();
        } else if (e.key === 'Enter') {
            startGame();
        }
    } else if (currentState === GAME_STATE.PLAYING) {
        if (e.code === 'Space') {
            togglePause();
            return;
        }

        if (isPaused) return;

        const laneIndex = KEYS.indexOf(e.key.toLowerCase());
        if (laneIndex !== -1) {
            playHitSound();
            handleKeyPress(laneIndex);
            document.getElementById(`lane-${laneIndex}`).classList.add('active');
        }
    } else if (currentState === GAME_STATE.RESULT) {
        if (e.code === 'Space') {
            initMenu();
        }
    }
});

window.addEventListener('keyup', (e) => {
    if (currentState === GAME_STATE.PLAYING) {
        const laneIndex = KEYS.indexOf(e.key.toLowerCase());
        if (laneIndex !== -1) {
            handleKeyRelease(laneIndex);
            document.getElementById(`lane-${laneIndex}`).classList.remove('active');
        }
    }
});


function handleKeyPress(lane) {
    const currentTime = currentVirtualTime;

    // Find nearest unhit note in this lane
    const activeNotes = notes.filter(n => n.lane === lane && !n.hit);
    if (activeNotes.length === 0) return;

    const nearest = activeNotes.reduce((prev, curr) => {
        return Math.abs(curr.targetTime - currentTime) < Math.abs(prev.targetTime - currentTime) ? curr : prev;
    });

    const diff = Math.abs(nearest.targetTime - currentTime);

    if (diff < 0.2) {
        // Hit!
        if (nearest.type === 'normal') {
            nearest.hit = true;
            if (nearest.element) nearest.element.remove();
        } else if (nearest.type === 'long') {
            nearest.active = true;
            if (nearest.element) nearest.element.classList.add('note-long-active');
        }

        if (diff < 0.05) registerHit('perfect');
        else registerHit('great');
    }
}

function handleKeyRelease(lane) {
    const currentTime = currentVirtualTime;

    // Find active long note in this lane
    const activeLongNote = notes.find(n => n.lane === lane && n.type === 'long' && n.active && !n.hit);
    if (activeLongNote) {
        activeLongNote.active = false;
        activeLongNote.hit = true;
        if (activeLongNote.element) activeLongNote.element.remove();

        const diff = Math.abs(activeLongNote.endTime - currentTime);
        if (diff < 0.2) {
            if (diff < 0.05) registerHit('perfect');
            else registerHit('great');
        } else {
            registerHit('miss');
        }
    }
}

function registerHit(judgement) {
    if (judgement === 'perfect') {
        score.perfect++;
        score.combo++;
    } else if (judgement === 'great') {
        score.great++;
        score.combo++;
    } else if (judgement === 'miss') {
        score.miss++;
        score.combo = 0;
    }

    if (score.combo > score.maxCombo) {
        score.maxCombo = score.combo;
    }

    updateScoreDisplay();
    showJudgement(judgement);
}

function updateScoreDisplay() {
    const hitScore = score.perfect + (score.great * 0.5);
    const percentage = totalNotes === 0 ? 0 : (hitScore / totalNotes) * 100;
    scoreDisplay.innerText = percentage.toFixed(2);

    if (score.combo > 0) {
        currentComboSpan.innerText = score.combo;
        comboDisplay.classList.add('pop');
        setTimeout(() => comboDisplay.classList.remove('pop'), 100);
    } else {
        comboDisplay.classList.remove('pop');
    }
}

function showJudgement(judgement) {
    judgementDisplay.innerText = judgement;
    judgementDisplay.className = `judgement-${judgement}`;

    // Trigger animation
    judgementDisplay.classList.remove('pop-anim');
    void judgementDisplay.offsetWidth; // trigger reflow
    judgementDisplay.classList.add('pop-anim');
}

function endGame() {
    currentState = GAME_STATE.RESULT;
    cancelAnimationFrame(gameLoopId);
    if (ytPlayer && ytPlayerReady) ytPlayer.stopVideo();

    gameScreen.classList.remove('active');
    resultScreen.classList.add('active');
    pauseOverlay.classList.remove('active');

    document.getElementById('final-score').innerText = scoreDisplay.innerText;
    document.getElementById('result-perfect').innerText = score.perfect;
    document.getElementById('result-great').innerText = score.great;
    document.getElementById('result-miss').innerText = score.miss;
    document.getElementById('result-max-combo').innerText = score.maxCombo;
}

// Pause and Quit Functions
function togglePause() {
    if (currentState !== GAME_STATE.PLAYING || !videoStarted) return;
    
    isPaused = !isPaused;
    
    if (isPaused) {
        if (ytPlayer && ytPlayerReady) ytPlayer.pauseVideo();
        pauseOverlay.classList.add('active');
    } else {
        if (ytPlayer && ytPlayerReady) ytPlayer.playVideo();
        pauseOverlay.classList.remove('active');
        
        // Re-sync start time upon unpausing
        if (ytPlayer) {
            gameStartPerf = performance.now() - (ytPlayer.getCurrentTime() - (audioOffset / 1000)) * 1000;
        }
    }
}

function quitGame() {
    if (currentState !== GAME_STATE.PLAYING) return;
    
    cancelAnimationFrame(gameLoopId);
    if (ytPlayer && ytPlayerReady) ytPlayer.stopVideo();
    
    isPaused = false;
    pauseOverlay.classList.remove('active');
    initMenu();
}

// Init
initMenu();

// ─── Touch Input ───────────────────────────────────────────────────

// Helper: convert a clientX position to a lane index using the touch-overlay rects
function clientXToLane(clientX) {
    const touchLanes = document.querySelectorAll('.touch-lane');
    for (let i = 0; i < touchLanes.length; i++) {
        const rect = touchLanes[i].getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right) return i;
    }
    return -1;
}

// Track which touch identifiers are currently held, keyed by touchId → laneIndex
const activeTouches = new Map();

document.getElementById('touch-overlay').addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (currentState !== GAME_STATE.PLAYING) return;
    for (const touch of e.changedTouches) {
        const lane = clientXToLane(touch.clientX);
        if (lane === -1) continue;
        activeTouches.set(touch.identifier, lane);
        playHitSound();
        handleKeyPress(lane);
        document.getElementById(`lane-${lane}`).classList.add('active');
    }
}, { passive: false });

document.getElementById('touch-overlay').addEventListener('touchend', (e) => {
    e.preventDefault();
    if (currentState !== GAME_STATE.PLAYING) return;
    for (const touch of e.changedTouches) {
        const lane = activeTouches.get(touch.identifier);
        if (lane === undefined) continue;
        activeTouches.delete(touch.identifier);
        handleKeyRelease(lane);
        document.getElementById(`lane-${lane}`).classList.remove('active');
    }
}, { passive: false });

document.getElementById('touch-overlay').addEventListener('touchcancel', (e) => {
    for (const touch of e.changedTouches) {
        const lane = activeTouches.get(touch.identifier);
        if (lane === undefined) continue;
        activeTouches.delete(touch.identifier);
        handleKeyRelease(lane);
        document.getElementById(`lane-${lane}`).classList.remove('active');
    }
}, { passive: false });

// Menu touch buttons
document.getElementById('btn-prev').addEventListener('click', () => {
    currentSongIndex = (currentSongIndex - 1 + songs.length) % songs.length;
    updateMenuDisplay();
});
document.getElementById('btn-next').addEventListener('click', () => {
    currentSongIndex = (currentSongIndex + 1) % songs.length;
    updateMenuDisplay();
});
document.getElementById('btn-start').addEventListener('click', () => {
    startGame();
});

// Offset controls
function updateOffset(change) {
    audioOffset += change;
    localStorage.setItem('kawarabonism_offset', audioOffset);
    offsetDisplay.innerText = audioOffset + ' ms';
}

document.getElementById('btn-offset-minus').addEventListener('click', () => updateOffset(-10));
document.getElementById('btn-offset-plus').addEventListener('click', () => updateOffset(10));

// Game controls
document.getElementById('btn-pause').addEventListener('click', togglePause);
document.getElementById('btn-quit').addEventListener('click', quitGame);

// Result screen return button
document.getElementById('btn-return').addEventListener('click', () => {
    initMenu();
});
