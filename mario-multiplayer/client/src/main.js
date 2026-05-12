import Phaser from 'phaser';
import { io } from 'socket.io-client';
import './style.css';

const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 450,
  parent: 'app',
  scale: {
    mode: Phaser.Scale.ENVELOP,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  pixelArt: true,
  roundPixels: true,
  antialias: false,
  backgroundColor: '#5c94fc',
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 2200 },
      debug: false,
      fixedStep: true,
      tileBias: 64
    }
  },
  scene: { preload, create, update },
  fps: {
    target: 60,
    forceSetTimeOut: true
  },
  pauseOnBlur: false
};

const WALK_MAX_VELOCITY = 350;
const RUN_MAX_VELOCITY = 700;
const ACCEL = 600;
const DRAG = 600;
const SKID_DRAG = 1200;
const JUMP_FORCE = -1100;
const VARIABLE_JUMP_MODIFIER = 0.5;
const MOVE_SEND_RATE = 33; // Send updates every 33ms (~30 FPS)
let lastMoveSentTime = 0;

let bgm;
let currentMusicKey = null;
let musicVolume = localStorage.getItem('mario_music_volume') !== null ? parseFloat(localStorage.getItem('mario_music_volume')) : 0.5;
let sfxVolume = localStorage.getItem('mario_sfx_volume') !== null ? parseFloat(localStorage.getItem('mario_sfx_volume')) : 0.5;

function playSound(scene, key) {
  if (!scene || !scene.sound) return;
  scene.sound.play(key, { volume: sfxVolume });
}

function playMusic(scene, key, loop = true) {
  if (currentMusicKey === key) return;
  if (bgm) bgm.stop();
  bgm = scene.sound.add(key, { loop: loop, volume: musicVolume });
  bgm.play();
  currentMusicKey = key;
}
let keyBindings = JSON.parse(localStorage.getItem('mario_key_bindings')) || {
  left: ['A', 'LEFT'],
  right: ['D', 'RIGHT'],
  up: ['W', 'UP', 'SPACE'],
  down: ['S', 'DOWN'],
  fire: ['X', 'SHIFT'],
  restart: ['R']
};

const DEFAULT_KEY_BINDINGS = {
  left: ['A', 'LEFT'],
  right: ['D', 'RIGHT'],
  up: ['W', 'UP', 'SPACE'],
  down: ['S', 'DOWN'],
  fire: ['X', 'SHIFT'],
  restart: ['R']
};

let activeActionKeys = {}; // Will hold Phaser Key objects

function setupActionKeys(scene) {
  if (!scene || !scene.input || !scene.input.keyboard) return;
  activeActionKeys = {};
  for (const action in keyBindings) {
    activeActionKeys[action] = keyBindings[action].map(key => {
      try {
        const keyCode = Phaser.Input.Keyboard.KeyCodes[key.toUpperCase()];
        return keyCode !== undefined ? scene.input.keyboard.addKey(keyCode) : null;
      } catch (e) {
        return null;
      }
    }).filter(k => k !== null);
  }
}

function isTyping() {
  const active = document.activeElement;
  return active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
}

// Global listeners to stop propagation for keyboard events on inputs
// This prevents Phaser from capturing keys (like WASD) while the user is typing
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    e.stopPropagation();
  }
}, true);

window.addEventListener('keyup', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    e.stopPropagation();
  }
}, true);

function isActionDown(action) {
  if (isTyping()) return false;
  if (!activeActionKeys[action]) return false;
  return activeActionKeys[action].some(key => key.isDown);
}

function isActionJustDown(action) {
  if (isTyping()) return false;
  if (!activeActionKeys[action]) return false;
  return activeActionKeys[action].some(key => Phaser.Input.Keyboard.JustDown(key));
}

let game;
let socket;
let player;
let otherPlayers;
let layer;
let playerCollider;
let moveHoldTimer = 0;
let fireballs;
let enemies;
let fireTrails = {}; // { [fireballId]: emitter }
let shootTimer = 0;
let lastEnemyUpdates = {}; // { [enemyId]: { x, y } }
let lastItemUpdates = {};  // { [itemId]: { x, y } }
let keyEsc;
let keySpace;
let spectatingPlayerId = null;
let spectatorText;
let spectatorBg;
let isSinglePlayer = false;
let runTime = 0;
let isTimerRunning = false;
let personalBestTime = null;
let currentWarps = {};
let selectedSkin = getCookie('mario_selected_skin') || localStorage.getItem('mario_selected_skin') || 'mario';
let customSkinColors = JSON.parse(localStorage.getItem('mario_custom_skin_colors')) || {};

// Color helper functions
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function componentToHex(c) {
  var hex = c.toString(16);
  return hex.length == 1 ? "0" + hex : hex;
}

function rgbToHex(r, g, b) {
  return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
}

const DEFAULT_COLORS = {
  mario: { color1: { r: 255, g: 0, b: 0 }, color2: { r: 139, g: 69, b: 19 } },
  luigi: { color1: { r: 0, g: 255, b: 0 }, color2: { r: 139, g: 69, b: 19 } },
  jacob: { color1: { r: 255, g: 0, b: 0 }, color2: { r: 0, g: 0, b: 0 } },
  sean:  { color1: { r: 255, g: 0, b: 0 }, color2: { r: 0, g: 0, b: 255 } },
  random: { color1: { r: 255, g: 255, b: 255 }, color2: { r: 255, g: 255, b: 255 } },
  chaos: { color1: { r: 255, g: 255, b: 255 }, color2: { r: 255, g: 255, b: 255 } }
};

function formatTime(ms) {
  if (ms === null) return '--:--.--';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centi = Math.floor((ms % 1000) / 10);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${centi.toString().padStart(2, '0')}`;
}

// Update UI
const titleScreen = document.getElementById('title-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const leaderboardScreen = document.getElementById('leaderboard-screen');
const createModal = document.getElementById('create-modal');
const uiLayer = document.getElementById('ui-layer');
const lobbyList = document.getElementById('lobby-list');
const leaderboardList = document.getElementById('leaderboard-list');
const gameMenuModal = document.getElementById('game-menu-modal');
const chromaModal = document.getElementById('chroma-modal');
const currentTimeDisplay = document.getElementById('current-time');
const bestTimeDisplay = document.getElementById('best-time');
const currentScoreDisplay = document.getElementById('current-score');
const timerDisplay = document.getElementById('timer-display');
const singleplayerModal = document.getElementById('singleplayer-modal');
const speedrunLevelModal = document.getElementById('speedrun-level-modal');
const speedrunLevelSelect = document.getElementById('speedrun-level-select');

function setTimerRunning(running, hideIfStopped = true) {
  isTimerRunning = running;
  if (timerDisplay) {
    if (running) {
      timerDisplay.classList.remove('hidden');
    } else if (hideIfStopped) {
      timerDisplay.classList.add('hidden');
    }
  }
}

// Initial sync
setTimerRunning(isTimerRunning);

// Auth DOM
const authScreen = document.getElementById('auth-screen');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const loginError = document.getElementById('login-error');
const signupError = document.getElementById('signup-error');
const resultsScreen = document.getElementById('results-screen');
const resultsList = document.getElementById('results-list');
const winnerAnnouncement = document.getElementById('winner-announcement');
const btnReadyNext = document.getElementById('btn-ready-next');

let currentLobbyMode = 'Co-op';
let lastMatchResults = null;
let isAdmin = false;

const adminScreen = document.getElementById('admin-screen');
const adminUsersView = document.getElementById('admin-users-view');
const adminScoresView = document.getElementById('admin-scores-view');
const adminUsersList = document.getElementById('admin-users-list');
const adminScoresList = document.getElementById('admin-scores-list');
const btnAdminPanel = document.getElementById('btn-admin-panel');
const btnAdminUsersTab = document.getElementById('btn-admin-users-tab');
const btnAdminScoresTab = document.getElementById('btn-admin-scores-tab');
const victoryScreen = document.getElementById('victory-screen');

function showScreen(screenId) {
  [titleScreen, lobbyScreen, leaderboardScreen, document.getElementById('lobby-waiting-screen'), authScreen, resultsScreen, adminScreen, victoryScreen].forEach(s => {
    if (s) s.classList.remove('active');
  });

  if (screenId === 'none') {
    uiLayer.style.display = 'none';
    return;
  }

  uiLayer.style.display = 'flex';
  if (screenId !== 'leaderboard' && window.leaderboardInterval) {
    clearInterval(window.leaderboardInterval);
    window.leaderboardInterval = null;
  }

  if (screenId === 'title') titleScreen.classList.add('active');
  if (screenId === 'lobby') lobbyScreen.classList.add('active');
  if (screenId === 'lobby-waiting') document.getElementById('lobby-waiting-screen').classList.add('active');
  if (screenId === 'leaderboard') leaderboardScreen.classList.add('active');
  if (screenId === 'auth') authScreen.classList.add('active');
  if (screenId === 'results') resultsScreen.classList.add('active');
  if (screenId === 'admin') adminScreen.classList.add('active');
  if (screenId === 'victory') victoryScreen.classList.add('active');
}

/**
 * Cleanly exits any active game session and returns to the main menu.
 * Destroys the Phaser instance and resets relevant global state.
 */
function exitGameToMainMenu() {
  console.log('[UI] Exiting to main menu and cleaning up game state.');
  
  // Hide in-game UI elements
  if (gameMenuModal) gameMenuModal.classList.remove('active');
  document.body.classList.remove('in-game');
  uiLayer.style.display = 'flex';
  
  // Show title screen
  showScreen('title');
  
  // Destroy Phaser game instance and clear references
  if (game) {
    console.log('[Game] Destroying Phaser instance');
    game.destroy(true);
    game = null;
    player = null;
    otherPlayers = null;
    fireballs = null;
    enemies = null;
    layer = null;
    playerCollider = null;
    spectatorText = null;
    spectatorBg = null;
    spectatingPlayerId = null;
  }
  
  // Reset game-specific state
  isSinglePlayer = false;
  runTime = 0;
  isTimerRunning = false;
  currentWarps = {};

  // Re-initialize game instance for future sessions
  initSocket();
}


const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : window.location.origin;

function initSocket() {
  // Initialize Phaser game early to load textures for previews
  // We do this before the socket check to ensure the game is recreated if it was destroyed
  if (!game) {
    game = new Phaser.Game(config);
  }

  if (socket) return;
  socket = io(SERVER_URL);

  socket.on('lobbyList', (lobbies) => {
    lobbyList.innerHTML = '';
    lobbies.forEach(lobby => {
      const tr = document.createElement('tr');
      const isFull = lobby.playerCount >= lobby.maxPlayers;
      const isPlaying = lobby.status === 'playing';
      const canJoin = !isFull && !isPlaying;

      tr.innerHTML = `
                <td>${lobby.name}</td>
                <td>${lobby.mode}</td>
                <td>${lobby.playerCount}/${lobby.maxPlayers}</td>
                <td><span class="status-tag ${lobby.status}">${lobby.status.toUpperCase()}</span></td>
                <td><button class="mario-btn secondary join-btn" data-id="${lobby.id}" ${!canJoin ? 'disabled' : ''}>JOIN</button></td>
            `;
      lobbyList.appendChild(tr);
    });

    document.querySelectorAll('.join-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        isSinglePlayer = false;
        socket.emit('joinLobby', { 
          lobbyId: btn.dataset.id, 
          username: currentUser, 
          skin: selectedSkin,
          skinData: customSkinColors[selectedSkin]
        });
      });
    });
  });

  socket.on('joinError', (msg) => {
    alert(msg);
  });

  socket.on('lobbyUpdate', (lobby) => {
    currentLobbyMode = lobby.mode;
    showScreen('lobby-waiting');
    const isHost = lobby.host === socket.id;

    document.getElementById('lobby-room-name').innerText = lobby.name;
    document.getElementById('lobby-name-setting').value = lobby.name;
    document.getElementById('lobby-map-select').value = lobby.currentLevel;
    document.getElementById('lobby-mode-setting').value = lobby.mode;
    document.getElementById('lobby-max-players').value = lobby.maxPlayers;

    // Enable/disable based on host status
    const settings = ['lobby-name-setting', 'lobby-map-select', 'lobby-mode-setting', 'lobby-max-players'];
    settings.forEach(id => {
      let disabled = !isHost;
      if (id === 'lobby-max-players' && lobby.mode === 'Singleplayer') disabled = true;
      document.getElementById(id).disabled = disabled;
    });

    document.getElementById('btn-start-match').style.display = isHost ? 'block' : 'none';
    document.getElementById('btn-kill-lobby').style.display = isHost ? 'block' : 'none';

    // Update player list
    const playerUl = document.getElementById('lobby-players-ul');
    playerUl.innerHTML = '';
    Object.values(lobby.players).forEach(p => {
      const li = document.createElement('li');
      li.className = 'player-item';
      const isPPHost = lobby.host === p.id;
      let displayName = p.username || p.id.substr(0, 6);
      if (p.id === socket.id) {
        displayName = p.username ? `${p.username} (YOU)` : 'YOU';
      }
      li.innerHTML = `
                <div class="player-name-box">
                    <span>${displayName}</span>
                    ${isPPHost ? '<span class="host-badge">HOST</span>' : ''}
                </div>
                ${isHost && p.id !== socket.id ? `<button class="kick-btn" data-id="${p.id}">KICK</button>` : ''}
            `;
      playerUl.appendChild(li);
    });

    document.querySelectorAll('.kick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        socket.emit('kickPlayer', btn.dataset.id);
      });
    });
  });

  socket.on('matchStarted', () => {
    console.log('Match starting!');
    showScreen('none'); // Hide UI layer
    document.body.classList.add('in-game');
    uiLayer.style.display = 'none';
  });

  socket.on('kicked', () => {
    alert('You have been kicked from the lobby.');
    exitGameToMainMenu();
  });

  socket.on('lobbyKilled', () => {
    alert('Lobby has been closed by the host.');
    exitGameToMainMenu();
  });

  socket.on('lobbyCreated', (id) => {
    socket.emit('joinLobby', { 
      lobbyId: id, 
      username: currentUser, 
      skin: selectedSkin,
      skinData: customSkinColors[selectedSkin]
    });
  });

  socket.on('initMap', (mapData) => {
    window.pendingInit = { map: mapData }; // Initialize buffer
    // Game is now initialized in initSocket
  });

  socket.on('currentPlayers', (players) => {
    if (game && game.scene.scenes[0] && game.scene.scenes[0].sys.isActive()) {
      handleCurrentPlayers.call(game.scene.scenes[0], players);
    } else {
      if (!window.pendingInit) window.pendingInit = {};
      window.pendingInit.players = players;
    }
  });

  socket.on('initItems', (items) => {
    if (game && game.scene.scenes[0] && game.scene.scenes[0].sys.isActive()) {
      handleInitItems.call(game.scene.scenes[0], items);
    } else {
      if (!window.pendingInit) window.pendingInit = {};
      window.pendingInit.items = items;
    }
  });

  socket.on('initEnemies', (enemiesData) => {
    if (game && game.scene.scenes[0] && game.scene.scenes[0].sys.isActive()) {
      handleInitEnemies.call(game.scene.scenes[0], enemiesData);
    } else {
      if (!window.pendingInit) window.pendingInit = {};
      window.pendingInit.enemies = enemiesData;
    }
  });

  socket.on('personalBest', (best) => {
    personalBestTime = best;
    if (bestTimeDisplay) bestTimeDisplay.innerText = formatTime(personalBestTime);
  });

  socket.on('leaderboardData', (data) => {
    const { scores, nextUpdateInMs, type } = data;
    const cacheTimer = document.getElementById('cache-timer');
    const statHeader = document.getElementById('lb-stat-header');

    // Update Header
    if (statHeader) {
      if (type === 'score') statHeader.innerText = 'SCORE';
      else if (type === 'pvp') statHeader.innerText = 'WINS';
      else statHeader.innerText = 'TIME';
    }

    // Update Timer Display
    if (cacheTimer) {
      let remainingS = Math.ceil(nextUpdateInMs / 1000);
      cacheTimer.innerText = `CACHE REFRESH: ${remainingS}s`;

      if (window.leaderboardInterval) clearInterval(window.leaderboardInterval);
      window.leaderboardInterval = setInterval(() => {
        remainingS--;
        if (remainingS <= 0) {
          cacheTimer.innerText = `UPDATING...`;
          clearInterval(window.leaderboardInterval);
          refreshLB(); // Auto-refresh when timer hits zero
        } else {
          cacheTimer.innerText = `CACHE REFRESH: ${remainingS}s`;
        }
      }, 1000);
    }

    leaderboardList.innerHTML = '';
    scores.forEach((score, index) => {
      const tr = document.createElement('tr');
      if (index === 0) tr.classList.add('rank-gold');
      else if (index === 1) tr.classList.add('rank-silver');
      else if (index === 2) tr.classList.add('rank-bronze');

      let val = formatTime(score.timeMs);
      if (type === 'score') val = score.score;
      if (type === 'pvp') val = score.wins;

      tr.innerHTML = `
                <td>${index + 1}</td>
                <td>${score.playerName}</td>
                <td>${val}</td>
            `;
      leaderboardList.appendChild(tr);
    });
  });

  socket.on('totalScoreUpdate', (totalScore) => {
    if ((currentLobbyMode === 'Co-op' || currentLobbyMode === 'Singleplayer') && currentScoreDisplay) {
      currentScoreDisplay.innerText = totalScore.toString().padStart(6, '0');
    }
  });

  socket.on('matchResults', (data) => {
    console.log('[Socket] matchResults received:', data);
    lastMatchResults = data;

    try {
      // Restore solid UI background for results
      document.body.classList.remove('in-game');
      showScreen('results');

      if (winnerAnnouncement) {
        winnerAnnouncement.innerText = data.winner ? `WINNER: ${data.winner}` : '';
      }

      renderResults(data);
      btnReadyNext.disabled = false;
      btnReadyNext.innerText = 'READY!';

      if (game && game.scene && game.scene.scenes[0]) {
        game.scene.scenes[0].physics.world.pause();
      }
    } catch (err) {
      console.error('[Results Error]', err);
    }
  });

  socket.on('playerReadyUpdate', (data) => {
    if (lastMatchResults) {
      renderResults({ ...lastMatchResults, readyPlayers: data.readyPlayers });
    }
  });

  socket.on('gameWon', () => {
    console.log('[Victory] Game Won event received!');
    document.body.classList.remove('in-game');
    showScreen('victory');
    if (game && game.scene && game.scene.scenes[0]) {
      game.scene.scenes[0].physics.world.pause();
    }
  });
}

function renderResults(data) {
  const { results, readyPlayers = {} } = data;
  resultsList.innerHTML = '';

  results.forEach(p => {
    const isReady = readyPlayers[p.id];
    const div = document.createElement('div');
    div.className = 'results-item';
    div.innerHTML = `
      <div class="player-info">
        <span class="player-name">${p.username}</span>
        <span class="player-stats">SCORE: ${p.score} ${p.dead ? '| (DEAD)' : ''}</span>
      </div>
      <div class="ready-status ${isReady ? 'ready' : 'waiting'}">
        ${isReady ? 'READY' : 'WAITING'}
      </div>
    `;
    resultsList.appendChild(div);
  });

  if ((data.mode === 'Co-op' || data.mode === 'Singleplayer') && data.totalScore !== undefined) {
    const totalDiv = document.createElement('div');
    totalDiv.className = 'results-total';
    totalDiv.style.marginTop = '20px';
    totalDiv.style.padding = '15px';
    totalDiv.style.textAlign = 'center';
    totalDiv.style.borderTop = '2px solid #fff';
    totalDiv.innerHTML = `<h3 style="margin:0; color:var(--mario-yellow); font-size: 16px;">TOTAL TEAM SCORE: ${data.totalScore}</h3>`;
    resultsList.appendChild(totalDiv);
  }
}

initSocket();

// ===== COOKIE UTILITIES =====
const COOKIE_EXPIRES_DAYS = 30;

function setCookie(name, value, days = COOKIE_EXPIRES_DAYS) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    const expires = "expires=" + date.toUTCString();
    document.cookie = name + "=" + encodeURIComponent(value) + ";" + expires + ";path=/;SameSite=Strict";
}

function getCookie(name) {
    const nameEQ = name + "=";
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        cookie = cookie.trim();
        if (cookie.indexOf(nameEQ) === 0) {
            return decodeURIComponent(cookie.substring(nameEQ.length));
        }
    }
    return null;
}

function deleteCookie(name) {
    setCookie(name, "", -1);
}

// Load saved credentials from cookies
async function loadSavedCredentials() {
    const rememberMe = getCookie('mario_remember_me');
    const savedUsername = getCookie('mario_username');
    const sessionToken = getCookie('mario_session_token');

    if (rememberMe === 'true' && savedUsername) {
        document.getElementById('login-username').value = savedUsername;
        document.getElementById('remember-me-checkbox').checked = true;

        if (sessionToken) {
            console.log('[Auth] Attempting auto-login...');
            try {
                const response = await fetch(`${SERVER_URL}/api/auth/auto-login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: savedUsername, sessionToken })
                });

                const data = await response.json();
                if (response.ok) {
                    console.log('[Auth] Auto-login successful!');
                    currentUser = data.username;
                    currentUserId = data.userId;
                    isAdmin = data.isAdmin || false;
                    
                    socket.emit('registerUsername', { 
                      username: currentUser, 
                      skin: selectedSkin,
                      skinData: customSkinColors[selectedSkin] 
                    });
                    
                    if (btnAdminPanel) {
                        btnAdminPanel.style.display = isAdmin ? 'block' : 'none';
                    }
                    
                    showScreen('title');
                } else {
                    console.warn('[Auth] Auto-login failed:', data.error);
                    deleteCookie('mario_session_token'); // Clear invalid token
                }
            } catch (err) {
                console.error('[Auth] Auto-login error:', err);
            }
        }
    }
}

// Authentication Logic
let currentUser = null;
let currentUserId = null;

async function handleLogin() {
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const rememberMe = document.getElementById('remember-me-checkbox').checked;
  loginError.innerText = '';

  try {
    const response = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, rememberMe })
    });

    const data = await response.json();

    if (response.ok) {
      currentUser = data.username;
      currentUserId = data.userId;
      isAdmin = data.isAdmin || false;
      
      // Save credentials if "Remember Me" is checked
      if (rememberMe) {
        setCookie('mario_remember_me', 'true', COOKIE_EXPIRES_DAYS);
        setCookie('mario_username', username, COOKIE_EXPIRES_DAYS);
        if (data.sessionToken) {
          setCookie('mario_session_token', data.sessionToken, COOKIE_EXPIRES_DAYS);
        }
      } else {
        deleteCookie('mario_remember_me');
        deleteCookie('mario_username');
        deleteCookie('mario_session_token');
      }
      
      socket.emit('registerUsername', { 
        username: currentUser, 
        skin: selectedSkin,
        skinData: customSkinColors[selectedSkin]
      });
      
      if (btnAdminPanel) {
        btnAdminPanel.style.display = isAdmin ? 'block' : 'none';
      }
      
      showScreen('title');
    } else {
      loginError.innerText = data.error || 'LOGIN FAILED';
    }
  } catch (err) {
    loginError.innerText = 'SERVER ERROR';
  }
}

async function handleSignup() {
  const username = document.getElementById('signup-username').value;
  const email = document.getElementById('signup-email').value;
  const password = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-confirm').value;
  signupError.innerText = '';

  if (password !== confirm) {
    signupError.innerText = 'PASSWORDS DO NOT MATCH';
    return;
  }

  try {
    const response = await fetch(`${SERVER_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });

    const data = await response.json();

    if (response.ok) {
      // Switch to login
      loginForm.classList.add('active');
      signupForm.classList.remove('active');
      document.getElementById('login-username').value = username;
      loginError.style.color = '#20C020';
      loginError.innerText = 'ACCOUNT CREATED! PLEASE LOGIN';
    } else {
      signupError.innerText = data.error || 'SIGNUP FAILED';
    }
  } catch (err) {
    signupError.innerText = 'SERVER ERROR';
  }
}

// Auth Event Listeners
document.getElementById('btn-login').addEventListener('click', handleLogin);
document.getElementById('btn-signup').addEventListener('click', handleSignup);

document.getElementById('btn-switch-signup').addEventListener('click', () => {
  loginForm.classList.remove('active');
  signupForm.classList.add('active');
  const firstInput = signupForm.querySelector('input');
  if (firstInput) firstInput.focus();
});

document.getElementById('btn-switch-login').addEventListener('click', () => {
  signupForm.classList.remove('active');
  loginForm.classList.add('active');
  const firstInput = loginForm.querySelector('input');
  if (firstInput) firstInput.focus();
});

document.getElementById('btn-logout').addEventListener('click', () => {
  currentUser = null;
  deleteCookie('mario_session_token'); // Prevent auto-login after manual logout
  showScreen('auth');
});


// UI Event Listeners
document.getElementById('btn-singleplayer').addEventListener('click', () => {
  singleplayerModal.classList.add('active');
});

document.getElementById('btn-sp-normal').addEventListener('click', () => {
  isSinglePlayer = true;
  socket.emit('createLobby', { 
    name: 'Singleplayer', 
    mode: 'Singleplayer', 
    username: currentUser,
    skin: selectedSkin,
    skinData: customSkinColors[selectedSkin]
  });
  socket.once('lobbyUpdate', () => {
    socket.emit('startMatch');
  });
  singleplayerModal.classList.remove('active');
});

document.getElementById('btn-sp-speedrun').addEventListener('click', () => {
  singleplayerModal.classList.remove('active');
  speedrunLevelModal.classList.add('active');
});

document.getElementById('btn-sp-speedrun-confirm').addEventListener('click', () => {
  const selectedLevel = speedrunLevelSelect.value;
  isSinglePlayer = true;
  socket.emit('createLobby', {
    name: 'Speedrun',
    mode: 'Speedrun',
    username: currentUser,
    map: selectedLevel,
    skin: selectedSkin,
    skinData: customSkinColors[selectedSkin]
  });
  socket.once('lobbyUpdate', () => {
    socket.emit('startMatch');
  });
  speedrunLevelModal.classList.remove('active');
});

document.getElementById('btn-close-sp-level-modal').addEventListener('click', () => {
  speedrunLevelModal.classList.remove('active');
  singleplayerModal.classList.add('active');
});

document.getElementById('btn-close-sp-modal').addEventListener('click', () => {
  singleplayerModal.classList.remove('active');
});

document.getElementById('btn-multiplayer').addEventListener('click', () => {
  isSinglePlayer = false;
  showScreen('lobby');
});

document.getElementById('btn-back-to-title').addEventListener('click', () => {
  showScreen('title');
});

document.getElementById('btn-leaderboard').addEventListener('click', () => {
  const levelId = document.getElementById('lb-level-select').value;
  const type = document.getElementById('lb-type-select').value;
  socket.emit('getLeaderboard', { levelId, type });
  showScreen('leaderboard');
});

const refreshLB = () => {
  const levelId = document.getElementById('lb-level-select').value;
  const type = document.getElementById('lb-type-select').value;
  socket.emit('getLeaderboard', { levelId, type });
};

document.getElementById('lb-level-select').addEventListener('change', refreshLB);
document.getElementById('lb-type-select').addEventListener('change', refreshLB);


document.getElementById('btn-back-to-title-lb').addEventListener('click', () => {
  showScreen('title');
});

document.getElementById('btn-create-lobby-open').addEventListener('click', () => {
  document.getElementById('lobby-name-input').value = '';
  createModal.classList.add('active');
});

document.getElementById('btn-close-modal').addEventListener('click', () => {
  createModal.classList.remove('active');
});

const settingsModal = document.getElementById('settings-modal');

// Character Selection Logic
document.querySelectorAll('.char-option').forEach(option => {
  option.addEventListener('click', () => {
    const skin = option.dataset.skin;
    
    if (skin === 'random' || skin === 'chaos') {
      // Direct select for random/chaos - they use server-side random colors
      selectedSkin = skin;
      localStorage.setItem('mario_selected_skin', selectedSkin);
      setCookie('mario_selected_skin', selectedSkin, 30);
      
      // Update UI
      document.querySelectorAll('.char-option').forEach(opt => {
        if (opt.dataset.skin === selectedSkin) opt.classList.add('active');
        else opt.classList.remove('active');
      });

      // Update player if exists
      if (player && player.scene) {
        const scene = player.scene;
        // We use the existing randomizeSkinTexture logic which handles random/chaos
        // based on playerInfo.skinData (if present) or server values
        socket.emit('playerMovement', { 
          x: player.x, 
          y: player.y, 
          anim: player.anims.currentAnim ? player.anims.currentAnim.key : 'idle', 
          flipX: player.flipX, 
          state: player.state, 
          skin: selectedSkin
        });
        
        // Trigger a texture refresh (socket will send back initMap or similar, 
        // or we can force it here but movement emit is usually enough for others)
        // Locally, we should probably set the texture back to base or wait for server
        player.setTexture(selectedSkin);
      }
      
      console.log(`[Settings] Skin changed to: ${selectedSkin} (Chroma skipped)`);
    } else {
      // Open Chroma Modal for personalized skins
      openChromaModal(skin);
    }
  });
});

let pendingSkin = 'mario';

function openChromaModal(skin) {
  pendingSkin = skin;
  chromaModal.classList.add('active');
  
  const previewCanvas = document.getElementById('chroma-char-preview');
  document.getElementById('chroma-skin-name').innerText = skin.toUpperCase();
  
  // Load current colors
  const colors = customSkinColors[skin] || DEFAULT_COLORS[skin] || DEFAULT_COLORS.mario;
  
  const cp1 = document.getElementById('color-primary');
  const cp2 = document.getElementById('color-secondary');
  const hex1 = document.getElementById('hex-primary');
  const hex2 = document.getElementById('hex-secondary');
  
  const c1hex = rgbToHex(colors.color1.r, colors.color1.g, colors.color1.b);
  const c2hex = rgbToHex(colors.color2.r, colors.color2.g, colors.color2.b);
  
  cp1.value = c1hex;
  cp2.value = c2hex;
  hex1.innerText = c1hex.toUpperCase();
  hex2.innerText = c2hex.toUpperCase();

  updateChromaPreview();
}

function updateChromaPreview() {
  const canvas = document.getElementById('chroma-char-preview');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const skin = pendingSkin;
  const baseSkin = (['random', 'chaos'].includes(skin)) ? 'mario' : skin;
  
  // Get colors from inputs
  const color1 = hexToRgb(document.getElementById('color-primary').value);
  const color2 = hexToRgb(document.getElementById('color-secondary').value);

  // Use Phaser textures directly from the game instance
  if (!game || !game.textures) return;
  const baseTexture = game.textures.get(baseSkin);
  if (!baseTexture || baseTexture.key === '__MISSING') return;

  const idleFrame = baseTexture.frames['idle'];
  if (!idleFrame) return;

  const sourceImage = baseTexture.getSourceImage();
  
  // Draw the frame to a temporary canvas for manipulation
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = idleFrame.width;
  tempCanvas.height = idleFrame.height;
  const tempCtx = tempCanvas.getContext('2d');
  
  tempCtx.drawImage(
    sourceImage, 
    idleFrame.cutX, idleFrame.cutY, idleFrame.cutWidth, idleFrame.cutHeight,
    0, 0, idleFrame.width, idleFrame.height
  );

  const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a === 0) continue;

    const isPrimary = (baseSkin === 'luigi') ? (g > 150 && r < 150 && b < 150) : (r > 150 && g < 150 && b < 150);
    
    let isSecondary = false;
    if (baseSkin === 'mario' || baseSkin === 'luigi') {
      // For Mario/Luigi, secondary affects EVERYTHING that isn't primary (Skin, Overalls, Shoes)
      isSecondary = !isPrimary;
    } else {
      // For others, we keep it to Overalls/Dark pieces to avoid changing their unique skin tones
      const isSkin = (r > 200 && g > 150 && b > 100);
      isSecondary = !isPrimary && !isSkin && ( (b > r - 20) || (r < 150 && g < 150 && b < 150) );
    }

    if (isPrimary) {
      const brightness = Math.max(r, g, b) / 255;
      data[i] = Math.floor(color1.r * brightness);
      data[i + 1] = Math.floor(color1.g * brightness);
      data[i + 2] = Math.floor(color1.b * brightness);
    }
    else if (isSecondary) {
      const maxVal = Math.max(r, g, b);
      const brightness = maxVal > 0 ? maxVal / 180 : 0; 
      data[i] = Math.min(255, Math.floor(color2.r * brightness));
      data[i + 1] = Math.min(255, Math.floor(color2.g * brightness));
      data[i + 2] = Math.min(255, Math.floor(color2.b * brightness));
    }
  }

  tempCtx.putImageData(imageData, 0, 0);

  // Check if current selection matches defaults
  const def = DEFAULT_COLORS[skin] || DEFAULT_COLORS.mario;
  const isDefault = (color1.r === def.color1.r && color1.g === def.color1.g && color1.b === def.color1.b &&
                      color2.r === def.color2.r && color2.g === def.color2.g && color2.b === def.color2.b);

  // Draw scaled to preview canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false; // Keep it pixelated
  
  if (isDefault) {
    // Draw original without chroma effect
    ctx.drawImage(
      sourceImage, 
      idleFrame.cutX, idleFrame.cutY, idleFrame.cutWidth, idleFrame.cutHeight,
      0, 0, canvas.width, canvas.height
    );
  } else {
    // Draw manipulated canvas
    ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
  }
}

document.getElementById('color-primary').addEventListener('input', (e) => {
  document.getElementById('hex-primary').innerText = e.target.value.toUpperCase();
  updateChromaPreview();
});

document.getElementById('color-secondary').addEventListener('input', (e) => {
  document.getElementById('hex-secondary').innerText = e.target.value.toUpperCase();
  updateChromaPreview();
});

document.getElementById('btn-cancel-chroma').addEventListener('click', () => {
  chromaModal.classList.remove('active');
});

document.getElementById('btn-default-chroma').addEventListener('click', () => {
  if (customSkinColors[pendingSkin]) {
    delete customSkinColors[pendingSkin];
    localStorage.setItem('mario_custom_skin_colors', JSON.stringify(customSkinColors));
  }
  
  const colors = DEFAULT_COLORS[pendingSkin] || DEFAULT_COLORS.mario;
  const c1hex = rgbToHex(colors.color1.r, colors.color1.g, colors.color1.b);
  const c2hex = rgbToHex(colors.color2.r, colors.color2.g, colors.color2.b);
  
  document.getElementById('color-primary').value = c1hex;
  document.getElementById('color-secondary').value = c2hex;
  document.getElementById('hex-primary').innerText = c1hex.toUpperCase();
  document.getElementById('hex-secondary').innerText = c2hex.toUpperCase();
  
  // Also apply immediately
  applySelectedChroma();
  updateChromaPreview();
});

document.getElementById('btn-apply-chroma').addEventListener('click', () => {
  applySelectedChroma();
  chromaModal.classList.remove('active');
});

function applySelectedChroma() {
  selectedSkin = pendingSkin;
  const c1 = hexToRgb(document.getElementById('color-primary').value);
  const c2 = hexToRgb(document.getElementById('color-secondary').value);
  
  // Check if colors match defaults to determine if we should skip chroma
  const def = DEFAULT_COLORS[selectedSkin] || DEFAULT_COLORS.mario;
  const isDefault = (c1.r === def.color1.r && c1.g === def.color1.g && c1.b === def.color1.b &&
                      c2.r === def.color2.r && c2.g === def.color2.g && c2.b === def.color2.b);

  if (isDefault) {
    delete customSkinColors[selectedSkin];
  } else {
    customSkinColors[selectedSkin] = {
      color1: c1,
      color2: c2,
      baseSkin: (['random', 'chaos'].includes(selectedSkin)) ? 'mario' : selectedSkin
    };
  }
  
  localStorage.setItem('mario_selected_skin', selectedSkin);
  setCookie('mario_selected_skin', selectedSkin, 30);
  localStorage.setItem('mario_custom_skin_colors', JSON.stringify(customSkinColors));
  
  // Update active class in settings UI
  document.querySelectorAll('.char-option').forEach(opt => {
    if (opt.dataset.skin === selectedSkin) opt.classList.add('active');
    else opt.classList.remove('active');
  });
  
  console.log(`[Settings] Skin changed to: ${selectedSkin}. Default: ${isDefault}`);
  
  // If player exists, update texture immediately
  if (player && player.scene) {
    const scene = player.scene;
    const skinData = customSkinColors[selectedSkin];
    
    const vx = player.body.velocity.x;
    const vy = player.body.velocity.y;

    if (skinData) {
      // Use a custom texture key for personalized skins
      const textureKey = `custom_${socket.id}`;
      randomizeSkinTexture(scene, skinData, textureKey);
      player.setTexture(textureKey);
      player.skinData = skinData;
    } else {
      // Return to base sprite sheet
      player.setTexture(selectedSkin);
      player.skinData = null;
    }

    applyPlayerState(player, player.state);
    player.setVelocity(vx, vy);
    
    // Force a movement emit to sync with others
    socket.emit('playerMovement', { 
      x: player.x, 
      y: player.y, 
      anim: player.anims.currentAnim ? player.anims.currentAnim.key : 'idle', 
      flipX: player.flipX, 
      state: player.state, 
      skin: selectedSkin,
      skinData: player.skinData
    });
  }
}

// Initialize active skin in UI
function syncSkinUI() {
  document.querySelectorAll('.char-option').forEach(option => {
    if (option.dataset.skin === selectedSkin) {
      option.classList.add('active');
    } else {
      option.classList.remove('active');
    }
  });
  syncVolumeUI();
  syncControlsUI();
}

function syncVolumeUI() {
  const musicSlider = document.getElementById('music-volume-slider');
  const sfxSlider = document.getElementById('sfx-volume-slider');
  const musicValue = document.getElementById('music-volume-value');
  const sfxValue = document.getElementById('sfx-volume-value');

  if (musicSlider) {
    musicSlider.value = musicVolume;
    musicValue.innerText = Math.round(musicVolume * 100) + '%';
  }
  if (sfxSlider) {
    sfxSlider.value = sfxVolume;
    sfxValue.innerText = Math.round(sfxVolume * 100) + '%';
  }
}

// Volume Listeners
document.getElementById('music-volume-slider').addEventListener('input', (e) => {
  musicVolume = parseFloat(e.target.value);
  document.getElementById('music-volume-value').innerText = Math.round(musicVolume * 100) + '%';
  localStorage.setItem('mario_music_volume', musicVolume);
  if (bgm) bgm.setVolume(musicVolume);
});

document.getElementById('sfx-volume-slider').addEventListener('input', (e) => {
  sfxVolume = parseFloat(e.target.value);
  document.getElementById('sfx-volume-value').innerText = Math.round(sfxVolume * 100) + '%';
  localStorage.setItem('mario_sfx_volume', sfxVolume);
});

let rebindingAction = null;

function syncControlsUI() {
  document.querySelectorAll('.control-rebind-btn').forEach(btn => {
    const action = btn.dataset.action;
    if (keyBindings[action]) {
      btn.innerText = keyBindings[action].join(' / ');
    }
    btn.classList.remove('waiting');
  });
}

document.querySelectorAll('.control-rebind-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (rebindingAction) return;
    rebindingAction = btn.dataset.action;
    btn.innerText = 'PRESS KEY...';
    btn.classList.add('waiting');

    const onKeyDown = (e) => {
      // Don't prevent default for ESC so it can still close menus if needed, 
      // but here we want to capture it.
      e.preventDefault();
      
      if (e.key === 'Escape') {
        rebindingAction = null;
        window.removeEventListener('keydown', onKeyDown);
        syncControlsUI();
        return;
      }

      let keyName = e.key.toUpperCase();
      if (keyName === ' ') keyName = 'SPACE';
      if (keyName === 'ARROWUP') keyName = 'UP';
      if (keyName === 'ARROWDOWN') keyName = 'DOWN';
      if (keyName === 'ARROWLEFT') keyName = 'LEFT';
      if (keyName === 'ARROWRIGHT') keyName = 'RIGHT';
      if (keyName === 'CONTROL') keyName = 'CTRL';

      if (Phaser.Input.Keyboard.KeyCodes[keyName] !== undefined) {
        keyBindings[rebindingAction] = [keyName];
        localStorage.setItem('mario_key_bindings', JSON.stringify(keyBindings));
        
        if (game && game.scene.scenes[0]) {
          setupActionKeys(game.scene.scenes[0]);
        }

        rebindingAction = null;
        window.removeEventListener('keydown', onKeyDown);
        syncControlsUI();
      }
    };

    window.addEventListener('keydown', onKeyDown, { once: false });
  });
});

document.getElementById('btn-reset-controls').addEventListener('click', () => {
  if (confirm('Reset all controls to default?')) {
    keyBindings = JSON.parse(JSON.stringify(DEFAULT_KEY_BINDINGS));
    localStorage.setItem('mario_key_bindings', JSON.stringify(keyBindings));
    if (game && game.scene.scenes[0]) {
      setupActionKeys(game.scene.scenes[0]);
    }
    syncControlsUI();
  }
});

// Settings Tab Switching Logic
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    
    // Update tab buttons
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${target}`).classList.add('active');
  });
});

document.getElementById('btn-settings').addEventListener('click', () => {
  syncSkinUI();
  settingsModal.classList.add('active');
});

document.getElementById('btn-close-settings').addEventListener('click', () => {
  settingsModal.classList.remove('active');
  // If we were in the middle of a game, return to the pause menu
  if (document.body.classList.contains('in-game')) {
    gameMenuModal.classList.add('active');
  }
});

document.getElementById('btn-settings-in-game').addEventListener('click', () => {
  gameMenuModal.classList.remove('active');
  syncSkinUI();
  settingsModal.classList.add('active');
});

// Character Preview State Cycling
const charGrid = document.querySelector('.character-grid');
const states = ['state-small', 'state-big', 'state-fire'];
let currentStateIndex = 0;

setInterval(() => {
  if (!settingsModal.classList.contains('active')) return;
  
  charGrid.classList.remove(...states);
  currentStateIndex = (currentStateIndex + 1) % states.length;
  charGrid.classList.add(states[currentStateIndex]);
}, 3000);

document.getElementById('btn-create-lobby-confirm').addEventListener('click', () => {
  const name = document.getElementById('lobby-name-input').value || 'New Room';
  const mode = document.getElementById('lobby-mode-select').value;
  socket.emit('createLobby', { 
    name, 
    mode, 
    username: currentUser,
    skin: selectedSkin,
    skinData: customSkinColors[selectedSkin]
  });
  createModal.classList.remove('active');
});

// Lobby Waiting Room Listeners
const updateSettings = () => {
  const name = document.getElementById('lobby-name-setting').value;
  const map = document.getElementById('lobby-map-select').value;
  const mode = document.getElementById('lobby-mode-setting').value;
  const maxPlayers = document.getElementById('lobby-max-players').value;
  socket.emit('updateLobbySettings', { name, map, mode, maxPlayers });
};

document.getElementById('lobby-name-setting').addEventListener('change', updateSettings);
document.getElementById('lobby-map-select').addEventListener('change', updateSettings);
document.getElementById('lobby-mode-setting').addEventListener('change', updateSettings);
document.getElementById('lobby-max-players').addEventListener('change', updateSettings);

document.getElementById('btn-start-match').addEventListener('click', () => {
  socket.emit('startMatch');
});

document.getElementById('btn-kill-lobby').addEventListener('click', () => {
  if (confirm('Are you sure you want to kill the lobby?')) {
    socket.emit('killLobby');
  }
});

document.getElementById('btn-leave-lobby').addEventListener('click', () => {
  isSinglePlayer = false;
  socket.emit('leaveLobby');
  showScreen('lobby');
});

// Admin Panel Listeners
btnAdminPanel.addEventListener('click', () => {
  showScreen('admin');
  switchAdminTab('users');
});

btnAdminUsersTab.addEventListener('click', () => switchAdminTab('users'));
btnAdminScoresTab.addEventListener('click', () => switchAdminTab('scores'));

document.getElementById('btn-back-to-title-admin').addEventListener('click', () => {
  exitGameToMainMenu();
});

document.getElementById('btn-victory-back').addEventListener('click', () => {
  exitGameToMainMenu();
});

async function switchAdminTab(tab) {
  if (tab === 'users') {
    btnAdminUsersTab.classList.add('active');
    btnAdminScoresTab.classList.remove('active');
    adminUsersView.classList.add('active');
    adminScoresView.classList.remove('active');
    await fetchAdminUsers();
  } else {
    btnAdminUsersTab.classList.remove('active');
    btnAdminScoresTab.classList.add('active');
    adminUsersView.classList.remove('active');
    adminScoresView.classList.add('active');
    await fetchAdminScores();
  }
}

async function fetchAdminUsers() {
  try {
    const response = await fetch(`${SERVER_URL}/api/admin/users`, {
      headers: { 'x-user-id': currentUserId }
    });
    if (!response.ok) throw new Error('Failed to fetch');
    const users = await response.json();
    adminUsersList.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${u.username}</td>
        <td>${u.email}</td>
        <td>${u.isAdmin ? 'ADMIN' : 'USER'}</td>
        <td>
          <button class="mario-btn small delete-user-btn" data-id="${u.id}" ${u.username === currentUser ? 'disabled' : ''}>DELETE</button>
        </td>
      `;
      adminUsersList.appendChild(tr);
    });

    document.querySelectorAll('.delete-user-btn').forEach(btn => {
      btn.onclick = () => deleteUser(btn.dataset.id);
    });
  } catch (err) {
    console.error(err);
  }
}

async function fetchAdminScores() {
  try {
    const response = await fetch(`${SERVER_URL}/api/admin/scores`, {
      headers: { 'x-user-id': currentUserId }
    });
    if (!response.ok) throw new Error('Failed to fetch');
    const scores = await response.json();
    adminScoresList.innerHTML = '';
    scores.forEach(s => {
      const tr = document.createElement('tr');
      const val = `S: ${s.score || 0} | T: ${formatTime(s.timeMs)}`;
      tr.innerHTML = `
        <td>${s.playerName}</td>
        <td>${s.levelId}</td>
        <td>${val}</td>
        <td>
          <button class="mario-btn small delete-score-btn" data-id="${s.id}">DELETE</button>
        </td>
      `;
      adminScoresList.appendChild(tr);
    });

    document.querySelectorAll('.delete-score-btn').forEach(btn => {
      btn.onclick = () => deleteScore(btn.dataset.id);
    });
  } catch (err) {
    console.error(err);
  }
}

async function deleteUser(id) {
  if (!confirm('Are you sure? This will delete the user and all their scores!')) return;
  try {
    const response = await fetch(`${SERVER_URL}/api/admin/users/${id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': currentUserId }
    });
    if (response.ok) fetchAdminUsers();
  } catch (err) {
    console.error(err);
  }
}

async function deleteScore(id) {
  if (!confirm('Are you sure you want to delete this score?')) return;
  try {
    const response = await fetch(`${SERVER_URL}/api/admin/scores/${id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': currentUserId }
    });
    if (response.ok) fetchAdminScores();
  } catch (err) {
    console.error(err);
  }
}


document.getElementById('btn-settings').addEventListener('click', () => {
  settingsModal.classList.add('active');
});

document.getElementById('btn-close-settings').addEventListener('click', () => {
  settingsModal.classList.remove('active');
  // If we're in-game and the game menu isn't open, hide the UI layer
  if (game && !gameMenuModal.classList.contains('active') && document.body.classList.contains('in-game')) {
    uiLayer.style.display = 'none';
  }
});

btnReadyNext.addEventListener('click', () => {
  socket.emit('playerReadyForNext');
  btnReadyNext.disabled = true;
  btnReadyNext.innerText = 'WAITING...';
});

function toggleGameMenu() {
  if (!game) return;
  const scene = game.scene.scenes[0];

  // If settings modal is open, close it first and return to menu
  if (settingsModal.classList.contains('active')) {
    settingsModal.classList.remove('active');
    if (document.body.classList.contains('in-game')) {
      gameMenuModal.classList.add('active');
    }
    return;
  }

  const isActive = gameMenuModal.classList.contains('active');

  // Determine if we should pause the game state (singleplayer or alone in lobby)
  const shouldPauseState = isSinglePlayer || otherPlayers.getLength() === 0;

  if (isActive) {
    gameMenuModal.classList.remove('active');
    if (shouldPauseState) {
      scene.physics.world.resume();
      scene.anims.resumeAll();
      if (bgm) bgm.resume();
      if (socket) socket.emit('resumeGame');
    }
    if (player && !player.levelFinished && !player.dead) {
      setTimerRunning(true);
    }
    if (!createModal.classList.contains('active') && !settingsModal.classList.contains('active')) {
      uiLayer.style.display = 'none';
    }
  } else {
    uiLayer.style.display = 'flex';
    gameMenuModal.classList.add('active');
    setTimerRunning(false);
    if (shouldPauseState) {
      scene.physics.world.pause();
      scene.anims.pauseAll();
      if (bgm) bgm.pause();
      if (socket) socket.emit('pauseGame');
    }
    playSound(this, 'pause');
  }
}

document.getElementById('btn-resume-game').addEventListener('click', () => {
  toggleGameMenu();
});

document.getElementById('btn-settings-in-game').addEventListener('click', () => {
  gameMenuModal.classList.remove('active');
  settingsModal.classList.add('active');
});

document.getElementById('btn-quit-to-menu').addEventListener('click', () => {
  exitGameToMainMenu();
  
  // We also reset the socket connection to ensure a completely clean state for the next session
  if (socket) {
    socket.disconnect();
    socket = null;
    initSocket();
  }
});

function preload() {
  this.load.spritesheet('tiles', '/tileset.png', { frameWidth: 64, frameHeight: 64 });
  this.load.atlas('mario', '/mario_sprite.png', '/mario.json');
  this.load.atlas('luigi', '/luigi_sprite.png', '/mario.json');
  this.load.atlas('jacob', '/jacob_sprite.png', '/mario.json');
  this.load.atlas('sean', '/sean_sprite.png', '/mario.json');

  // Sound Effects
  this.load.audio('1up', '/sounds/1up.wav');
  this.load.audio('beep', '/sounds/beep.wav');
  this.load.audio('billfirework', '/sounds/billfirework.wav');
  this.load.audio('bowserfall', '/sounds/bowserfall.wav');
  this.load.audio('brick', '/sounds/brick.wav');
  this.load.audio('bump', '/sounds/bump.wav');
  this.load.audio('coin', '/sounds/coin.wav');
  this.load.audio('death', '/sounds/death.wav');
  this.load.audio('fire', '/sounds/fire.wav');
  this.load.audio('fireball', '/sounds/fireball.wav');
  this.load.audio('flagpole', '/sounds/flagpole.wav');
  this.load.audio('gameover', '/sounds/gameover.wav');
  this.load.audio('item', '/sounds/item.wav');
  this.load.audio('jump', '/sounds/jump.wav');
  this.load.audio('jumpsmall', '/sounds/jumpsmall.wav');
  this.load.audio('kickkill', '/sounds/kickkill.wav');
  this.load.audio('pause', '/sounds/pause.wav');
  this.load.audio('pipepowerdown', '/sounds/pipepowerdown.wav');
  this.load.audio('powerup', '/sounds/powerup.wav');
  this.load.audio('stompswim', '/sounds/stompswim.wav');
  this.load.audio('vine', '/sounds/vine.wav');

  // Music
  this.load.audio('music_overworld', '/sounds/01. Ground Theme.mp3');
  this.load.audio('music_underground', '/sounds/02. Underground Theme.mp3');
  this.load.audio('music_invincible', '/sounds/05. Invincibility Theme.mp3');
  this.load.audio('music_victory', '/sounds/06. Level Complete Theme.mp3');
}

function handleInitMap(mapData) {
  // Hide results screen if it was open
  resultsScreen.classList.remove('active');

  // Stop all sounds and reset music theme to ensure a clean state
  if (this.sound) {
    this.sound.stopAll();
    currentMusicKey = null;
  }

  // Start appropriate Theme
  const musicKey = mapData.levelId === 'underground' ? 'music_underground' : 'music_overworld';
  playMusic(this, musicKey);

  if (this.physics && this.physics.world) {
    this.physics.world.resume();
  }

  console.log('Received map data for level:', mapData.levelId);
  currentWarps = mapData.warps || {};
  console.log('Current warps:', JSON.stringify(currentWarps));

  // Clear game state on map reset
  if (layer) {
    layer.destroy();
    layer = null;
  }
  if (playerCollider) {
    this.physics.world.removeCollider(playerCollider);
    playerCollider = null;
  }

  if (uiLayer) document.body.classList.add('in-game');

  if (isSinglePlayer) {
    if (!mapData.isWarp) {
      runTime = 0;
    }
    setTimerRunning(true);
  } else {
    setTimerRunning(false);
  }

  // Clear all sprite groups to prevent "traces" of old objects
  if (enemies) enemies.clear(true, true);
  if (this.items) this.items.clear(true, true);
  if (otherPlayers) otherPlayers.clear(true, true);

  if (fireballs) {
    fireballs.clear(true, true);
    // Clean up fire trails
    Object.keys(fireTrails).forEach(id => {
      if (fireTrails[id]) fireTrails[id].destroy();
    });
    fireTrails = {};
  }

  const map = this.make.tilemap({
    data: mapData.data,
    tileWidth: 64,
    tileHeight: 64
  });
  const tileset = map.addTilesetImage('tiles', 'tiles');
  layer = map.createLayer(0, tileset, 0, 0);
  layer.setDepth(2); // Set layer above players for pipe entry/exit

  if (layer) {
    // Explicitly set collision for all solid tiles:
    layer.setCollision([1, 33, 94, 95, 110, 111, 129, 136, 145, 160]);

    const mapWidth = map.widthInPixels;
    const mapHeight = map.heightInPixels;
    this.physics.world.setBounds(0, 0, mapWidth, mapHeight + 500);
    this.physics.world.setBoundsCollision(true, true, false, true);
    this.cameras.main.setBounds(0, 0, mapWidth, mapHeight);
    this.cameras.main.setZoom(0.5);

    // Reset player state if it exists
    if (player) {
      player.x = mapData.spawnX;
      player.y = mapData.spawnY;
      player.warping = false;
      player.isAnimating = false;
      player.setDepth(5);
      player.body.setAllowGravity(true);
      player.lastRestartTime = Date.now();
      
      // Force immediate camera snap
      this.cameras.main.scrollX = player.x - 400;
      this.cameras.main.scrollY = player.y - 225;
      this.cameras.main.startFollow(player, true, 1, 1);
    }
    if (mapData.spawnX !== undefined && mapData.spawnY !== undefined) {
      this.cameras.main.centerOn(mapData.spawnX, mapData.spawnY);
    }

    if (player) {
      player.levelFinished = false;
      player.isAnimating = false;
      player.dead = false; // Reset death state on level reset
      player.alpha = 1;
      player.clearTint();
      player.invincible = false;
      player.starPowerTimer = 0;
      player.invulnTimer = 0;
      player.stompMultiplier = 1;
      player.score = 0;
      moveHoldTimer = 0;
      player.jumpBufferTimer = 0;
      player.lastGroundedTime = 0;
      
      applyPlayerState(player, 0); // Always start small on new map
      if (player.body) {
        player.body.setMaxVelocity(WALK_MAX_VELOCITY, 1100);
      }
      
      // Update skin data from mapData or local custom colors
      const sData = (mapData.players && mapData.players[socket.id] && mapData.players[socket.id].skinData) 
                  ? mapData.players[socket.id].skinData 
                  : (mapData.skinData || customSkinColors[selectedSkin]);
      
      if (sData) {
        player.skinData = sData;
        const textureKey = `custom_${socket.id}`;
        randomizeSkinTexture(this, player.skinData, textureKey);
        player.setTexture(textureKey);
      } else {
        player.setTexture(selectedSkin);
      }

      if (player && player.anims) {
        player.anims.play(getAnimKey('idle', 0, selectedSkin), true);
      }

      if (playerCollider) this.physics.world.removeCollider(playerCollider);
      playerCollider = this.physics.add.collider(player, layer, handleTileCollision, null, this);

      // Set position immediately for warp/spawn to avoid race conditions in animations
      if (mapData.spawnX !== undefined && mapData.spawnY !== undefined) {
        // Use body.reset if available to clear all intermediate physics states
        if (player.body && player.body.reset) {
          player.body.reset(mapData.spawnX, mapData.spawnY);
        } else {
          player.setPosition(mapData.spawnX, mapData.spawnY);
        }
        
        // Update oldPosition to prevent immediate "significant movement" emit
        const rx = Math.round(mapData.spawnX * 10) / 10;
        const ry = Math.round(mapData.spawnY * 10) / 10;
        player.oldPosition = { x: rx, y: ry, anim: player.anims.currentAnim ? player.anims.currentAnim.key : 'idle', flipX: player.flipX, state: player.state, invincible: player.invincible, skin: selectedSkin };
        
        player.isRestarting = false;
        player.lastRestartTime = Date.now(); // Grace period for forced syncs
      }

      if (mapData.spawnType && mapData.spawnType !== 'none') {
        playPipeExitAnimation(this, player, mapData.spawnType);
      }
    }
  }

  // Hide UI menus on level init
  if (uiLayer) {
    uiLayer.style.display = 'none';
    document.body.classList.add('in-game');
  }
}

function playPipeExitAnimation(scene, sprite, type) {
  if (!sprite || !sprite.body) return;
  playSound(scene, 'pipepowerdown');
  sprite.body.setAllowGravity(false);
  sprite.body.setVelocity(0, 0);
  sprite.isAnimating = true;
  sprite.setDepth(1); // Behind pipe

  const originalY = sprite.y;
  const dist = 128; // Use 128 to ensure big Mario is also fully hidden
  if (type === 'pipe-down') {
    sprite.y = originalY - dist;
  } else if (type === 'pipe-up') {
    sprite.y = originalY + dist;
  }

  scene.tweens.add({
    targets: sprite,
    y: originalY,
    duration: 800,
    ease: 'Power1',
    onComplete: () => {
      sprite.body.setAllowGravity(true);
      sprite.isAnimating = false;
      sprite.setDepth(5); // Back in front
    }
  });
}

function handleCurrentPlayers(playersData) {
  Object.keys(playersData).forEach((id) => {
    if (id === socket.id) {
      addPlayer(this, playersData[id]);
    } else {
      addOtherPlayers(this, playersData[id]);
    }
  });
}

function handleInitItems(items) {
  if (this.items) this.items.clear(true, true);
  Object.keys(items).forEach(id => {
    createItemSprite(this, items[id]);
  });
}

function handleInitEnemies(data) {
  if (enemies) enemies.clear(true, true);
  Object.keys(data).forEach(id => {
    createEnemySprite(this, data[id]);
  });
}

function create() {
  // Clean up existing socket listeners from previous sessions to prevent accumulation
  const gameEvents = [
    'levelFinished', 'restartDenied', 'playFlagAnimation', 'currentPlayers',
    'newPlayer', 'playerMoved', 'tileUpdate', 'playerDisconnected',
    'fireballSpawned', 'fireballUpdates', 'fireballDestroyed',
    'playerKnockback', 'initItems', 'itemSpawned', 'itemUpdates',
    'itemDestroyed', 'playerBounce', 'initEnemies', 'enemySpawned',
    'enemyUpdates', 'enemyMoved', 'enemyDestroyed', 'scoreGained'
  ];
  if (socket) {
    socket.off('initMap');
    gameEvents.forEach(evt => socket.off(evt));
  }

  socket.on('initMap', (mapData) => handleInitMap.call(this, mapData));

  fireballs = this.add.group();
  enemies = this.add.group();
  this.items = this.physics.add.group();

  otherPlayers = this.physics.add.group();

  // Initialize custom skin texture if selected
  if (player && player.skinData) {
    const animPrefix = `custom_${socket.id}`;
    randomizeSkinTexture(this, player.skinData, animPrefix);
    player.setTexture(animPrefix);
  }

  setupAnimations(this);
  setupActionKeys(this);

  socket.on('levelFinished', () => {
    if (player && player.body) {
      player.levelFinished = true;
      player.setVelocity(0, 0);
      player.setAcceleration(0, 0);
    }
    setTimerRunning(false, false);
  });

  socket.on('restartDenied', () => {
    if (player) player.isRestarting = false;
  });

  socket.on('playFlagAnimation', (data) => {
    if (player) {
      playMusic(this, 'music_victory', false);
      playFlagAnimation(this, player, data.x, data.y);
    }
  });

  socket.on('currentPlayers', (players) => handleCurrentPlayers.call(this, players));

  socket.on('newPlayer', (playerInfo) => {
    addOtherPlayers(this, playerInfo);
  });

  socket.on('playerMoved', (playerInfo) => {
    let otherPlayer = otherPlayers.getChildren().find(p => p.id === playerInfo.id);

    // If other player sprite doesn't exist yet, create it
    if (!otherPlayer && playerInfo.id !== socket.id) {
      addOtherPlayers(this, playerInfo);
      otherPlayer = otherPlayers.getChildren().find(p => p.id === playerInfo.id);
    }

    if (otherPlayer) {
      if (otherPlayer.state !== playerInfo.state) {
        applyPlayerState(otherPlayer, playerInfo.state);
      }
      otherPlayer.targetX = playerInfo.x;
      otherPlayer.targetY = playerInfo.y;
      otherPlayer.flipX = playerInfo.flipX;
      otherPlayer.dead = playerInfo.dead;
      otherPlayer.invulnTimer = playerInfo.invulnTimer;
      
      const skin = playerInfo.skin || 'mario';
      let textureKey = skin;

      if (playerInfo.skinData) {
        textureKey = `custom_${playerInfo.id}`;
        
        // Update skinData comparison to trigger re-randomization on restart/skin change
        const currentSkinDataStr = otherPlayer.skinData ? JSON.stringify(otherPlayer.skinData) : "";
        const newSkinDataStr = JSON.stringify(playerInfo.skinData);

        if (!this.textures.exists(textureKey) || currentSkinDataStr !== newSkinDataStr) {
          randomizeSkinTexture(this, playerInfo.skinData, textureKey);
          otherPlayer.skinData = playerInfo.skinData;
        }
      } else {
        // If they switched from custom back to default, clear skinData
        otherPlayer.skinData = null;
      }

      if (otherPlayer.texture.key !== textureKey) {
        otherPlayer.setTexture(textureKey);
      }

      if (playerInfo.dead) {
        otherPlayer.anims.play(getAnimKey('die', playerInfo.state, skin, playerInfo.id), true);
      } else if (playerInfo.anim) {
        const action = playerInfo.anim.split('_').pop();
        otherPlayer.anims.play(getAnimKey(action, playerInfo.state, skin, playerInfo.id), true);
      }
      otherPlayer.invincible = playerInfo.invincible;
    }

    // Handle local player state sync from server
    if (player && playerInfo.id === socket.id) {
      if (player.state !== playerInfo.state) {
        if (player.state > playerInfo.state && !playerInfo.dead) {
          playSound(this, 'pipepowerdown');
        }
        player.state = playerInfo.state;
        applyPlayerState(player, playerInfo.state);
      }
      player.invincible = playerInfo.invincible;
      player.dead = playerInfo.dead;
      player.invulnTimer = playerInfo.invulnTimer;
      player.invulnTimer = playerInfo.invulnTimer;

      if (currentLobbyMode !== 'Co-op') {
        player.score = playerInfo.score || 0;
        if (currentScoreDisplay) {
          currentScoreDisplay.innerText = player.score.toString().padStart(6, '0');
        }
      }

      // Force position sync if we're far away (like during a level restart)
      const distSq = Phaser.Math.Distance.Squared(player.x, player.y, playerInfo.x, playerInfo.y);
      const now = Date.now();
      const isJustRestarted = (now - (player.lastRestartTime || 0)) < 1000;

      if (((distSq > 100 * 100 && !player.isAnimating && !player.isRestarting && !isJustRestarted) || (player.dead && !player.oldDead))) {
        player.setPosition(playerInfo.x, playerInfo.y);
        // Only kill velocity if NOT dead (to allow death hop)
        if (!player.dead) {
          player.setVelocity(0, 0);
          player.setAcceleration(0, 0);
        }
      }

      // Handle Death Sound
      if (player.dead && !player.oldDead) {
        if (bgm) bgm.stop();
        playSound(this, 'death');
        currentMusicKey = null;
      }



      player.oldDead = player.dead;
    }
  });

  socket.on('tileUpdate', (data) => {
    const { x, y, newTile } = data;
    if (!layer) return;
    const tile = layer.getTileAt(x, y);
    if (tile) {
      bounceTile(this, tile, newTile);
    }
  });

  socket.on('playerDisconnected', (id) => {
    otherPlayers.getChildren().forEach((otherPlayer) => {
      if (id === otherPlayer.id) otherPlayer.destroy();
    });
  });

  keyEsc = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
  keySpace = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

  // Spectator UI
  spectatorBg = this.add.rectangle(400, 40, 400, 40, 0x000000, 0.7);
  spectatorBg.setScrollFactor(0);
  spectatorBg.setDepth(100);
  spectatorBg.setOrigin(0.5);
  spectatorBg.setVisible(false);

  spectatorText = this.add.text(400, 40, '', {
    fontFamily: '"Press Start 2P"',
    fontSize: '16px',
    fill: '#ffffff',
    align: 'center',
    stroke: '#000000',
    strokeThickness: 4
  }).setOrigin(0.5);
  spectatorText.setScrollFactor(0);
  spectatorText.setDepth(101);
  spectatorText.setVisible(false);

  if (window.pendingInit) {
    if (window.pendingInit.map) handleInitMap.call(this, window.pendingInit.map);
    if (window.pendingInit.players) handleCurrentPlayers.call(this, window.pendingInit.players);
    if (window.pendingInit.items) handleInitItems.call(this, window.pendingInit.items);
    if (window.pendingInit.enemies) handleInitEnemies.call(this, window.pendingInit.enemies);
    window.pendingInit = null;
  }

  socket.on('fireballSpawned', (data) => {
    playSound(this, 'fireball');
    const fireballSprite = this.add.sprite(data.x, data.y, 'tiles', 241).setScale(1);
    fireballSprite.id = data.id;
    fireballSprite.lastUpdate = Date.now();
    fireballs.add(fireballSprite);

    // Create particle trail (Phaser 3.60+ syntax)
    const emitter = this.add.particles(0, 0, 'tiles', {
      frame: 241,
      speed: { min: 20, max: 50 },
      scale: { start: 0.15, end: 0 },
      blendMode: 'ADD',
      lifespan: 300,
      frequency: 20,
      follow: fireballSprite,
      tint: [0xff0000, 0xffff00, 0xffa500] // Red, Yellow, Orange
    });
    fireTrails[data.id] = emitter;
  });

  socket.on('fireballUpdates', (updates) => {
    updates.forEach(u => {
      const fb = fireballs.getChildren().find(f => f.id === u.id);
      if (fb) {
        fb.x = u.x;
        fb.y = u.y;
        fb.angle += 15; // Spinning effect
        fb.lastUpdate = Date.now();
      }
    });
  });

  socket.on('fireballDestroyed', (id) => {
    playSound(this, 'fire');
    const fb = fireballs.getChildren().find(f => f.id === id);
    if (fb) {
      // Explosion effect (Phaser 3.60+ syntax)
      const explosion = this.add.particles(fb.x, fb.y, 'tiles', {
        frame: 241,
        speed: { min: 50, max: 150 },
        scale: { start: 0.25, end: 0 },
        alpha: { start: 1, end: 0 },
        lifespan: 400,
        gravityY: 200,
        blendMode: 'ADD',
        tint: [0xff4500, 0xffd700],
        maxParticles: 10,
        emitting: false
      });
      explosion.explode(10);

      // Cleanup explosion emitter after particles are gone
      this.time.delayedCall(500, () => explosion.destroy());

      fb.destroy();
    }
    if (fireTrails[id]) {
      const emitter = fireTrails[id];
      emitter.stop();
      // Cleanup emitter object after lifespan
      this.time.delayedCall(300, () => emitter.destroy());
      delete fireTrails[id];
    }
  });

  socket.on('playerKnockback', (force) => {
    if (player && player.body) {
      player.setVelocity(force.vx, force.vy);
      player.setTint(0xff0000); // Visual indicator of hit
      this.time.delayedCall(200, () => player.clearTint());
    }
  });

  socket.on('initItems', (items) => handleInitItems.call(this, items));

  socket.on('itemSpawned', (item) => {
    createItemSprite(this, item);
  });

  socket.on('itemUpdates', (updates) => {
    updates.forEach(update => {
      const itemSprite = this.items.getChildren().find(i => i.id === update.id);
      if (itemSprite) {
        itemSprite.targetX = update.x;
        itemSprite.targetY = update.y;
      }
    });
  });

  socket.on('itemDestroyed', (data) => {
    const itemSprite = this.items.getChildren().find(i => i.id === data.itemId);
    if (itemSprite) {
      itemSprite.destroy();
    }

    // If local player collected it, update state
    if (data.collectorId === socket.id && player) {
      if (data.itemType === 'coin' || data.itemType === 'phys_coin') {
        playSound(this, 'coin');
      } else if (data.itemType === 'star') {
        playSound(this, 'powerup');
      } else if (player.state < data.newState) {
        playSound(this, 'powerup');
      }
      
      player.state = data.newState;
      applyPlayerState(player, data.newState);
      if (data.invincible !== undefined) player.invincible = data.invincible;
    }
  });

  socket.on('playerBounce', () => {
    if (player && player.body) {
      playSound(this, 'stompswim');
      player.setVelocityY(-1100); // Bounce the player up
    }
  });

  socket.on('initEnemies', (data) => handleInitEnemies.call(this, data));

  socket.on('enemySpawned', (enemy) => {
    createEnemySprite(this, enemy);
  });

  socket.on('enemyUpdates', (updates) => {
    updates.forEach(u => {
      const e = enemies.getChildren().find(sprite => sprite.id === u.id);
      if (e) {
        e.targetX = u.x;
        e.targetY = u.y;
        if (u.state) e.enemyState = u.state;

        if (e.type === 'goomba') {
          e.anims.play('goomba_walk', true);
        } else if (e.type === 'koopa') {
          if (e.enemyState === 'shell-still' || e.enemyState === 'shell-rolling') {
            e.anims.play('koopa_shell', true);
          } else {
            e.anims.play('koopa_walk', true);
          }
          if (u.vx !== undefined) e.flipX = u.vx > 0;
        } else if (e.type === 'piranha') {
          e.anims.play('piranha_walk', true);
        }
      }
    });
  });

  socket.on('enemyMoved', (u) => {
    const e = enemies.getChildren().find(sprite => sprite.id === u.id);
    if (e) {
      e.setPosition(u.x, u.y);
      if (u.state) e.enemyState = u.state;
      if (e.type === 'koopa') {
        if (e.enemyState === 'shell-still' || e.enemyState === 'shell-rolling') {
          e.anims.play('koopa_shell', true);
        } else {
          e.anims.play('koopa_walk', true);
        }
      }
    }
  });

  socket.on('enemyDestroyed', (data) => {
    const e = enemies.getChildren().find(sprite => sprite.id === data.id);
    if (e) {
      if (data.reason === 'stomped') {
        playSound(this, 'stompswim');
        if (e.type === 'goomba') {
          e.anims.play('goomba_flat');
          this.time.delayedCall(200, () => e.destroy());
        } else {
          e.destroy();
        }
      } else {
        if (data.reason === 'shell' || data.reason === 'fireball' || data.reason === 'star') {
          playSound(this, 'kickkill');
        }
        // Fireball or other: Flip away
        e.setTint(0xff0000);
        this.tweens.add({
          targets: e,
          y: e.y - 100,
          angle: 180,
          alpha: 0,
          duration: 400,
          onComplete: () => e.destroy()
        });
      }
    }
  });

  socket.on('scoreGained', (data) => {
    const { x, y, points } = data;
    const scoreText = this.add.text(x, y, points.toString(), {
      fontFamily: '"Press Start 2P"',
      fontSize: '20px',
      fill: '#ffffff',
      stroke: '#000000',
      strokeThickness: 4
    }).setOrigin(0.5).setDepth(100);

    this.tweens.add({
      targets: scoreText,
      y: y - 100,
      alpha: 0,
      duration: 1000,
      ease: 'Power1',
      onComplete: () => {
        scoreText.destroy();
      }
    });
  });

  //this.add.text(10, 10, 'Use Arrows to move.', { fill: '#ffffff' }).setScrollFactor(0);
}

function createItemSprite(scene, item) {
  let frame = 238; // Default Mushroom
  if (item.type === 'fire_flower') frame = 244;
  if (item.type === 'star') frame = 243;
  if (item.type === 'coin' || item.type === 'phys_coin') frame = 226;

  const sprite = scene.items.create(item.x, item.y, 'tiles', frame);
  sprite.id = item.id;
  sprite.setDepth(4);
  sprite.body.setAllowGravity(false); // Server handles gravity

  if (item.type === 'coin') {
    playSound(scene, 'coin');
    // Pop up animation for coin
    scene.tweens.add({
      targets: sprite,
      y: item.y - 128,
      alpha: 0,
      duration: 300,
      onComplete: () => sprite.destroy()
    });
  } else if (item.type === 'phys_coin' || player) {
    if (item.type !== 'phys_coin') playSound(scene, 'item');
    // For phys_coin (collected by anyone) or other items (collected by local player)
    // Actually, only local player should emit 'collectItem' to avoid race conditions
    if (player) {
      scene.physics.add.overlap(player, sprite, () => {
        socket.emit('collectItem', item.id);
      });
    }
  }
}

function createEnemySprite(scene, enemy) {
  let frame = 200; // Goomba
  if (enemy.type === 'koopa') frame = 203;
  if (enemy.type === 'piranha') frame = 210;
  if (enemy.type === 'blockenemy' && enemy.frame !== undefined) {
    frame = enemy.frame;
  }
  const sprite = scene.add.sprite(enemy.x, enemy.y, 'tiles', frame).setScale(1);
  sprite.id = enemy.id;
  sprite.type = enemy.type;
  if (enemies) enemies.add(sprite);
  if (enemy.type === 'piranha') {
    if (sprite.body) sprite.body.setAllowGravity(false);
    sprite.setDepth(1);
  }
}

function handleTileCollision(obj1, tile) {
  if (player && player.body && player.body.blocked.up) {
    socket.emit('blockHit', { x: tile.x, y: tile.y });
  }
}

function bounceTile(scene, tile, newTileIndex) {
  const x = tile.x;
  const y = tile.y;
  const tileWorldX = tile.pixelX + tile.width / 2;
  const tileWorldY = tile.pixelY + tile.height / 2;

  // If newTileIndex is -1 and it's a brick (frame 1), show shatter effect
  if (newTileIndex === -1 && tile.index === 1) {
    playSound(scene, 'brick');
    layer.removeTileAt(x, y);

    // Shatter particles (4 pieces)
    const pieces = [
      { vx: -200, vy: -600 },
      { vx: 200, vy: -600 },
      { vx: -150, vy: -400 },
      { vx: 150, vy: -400 }
    ];

    pieces.forEach(p => {
      const piece = scene.add.sprite(tileWorldX, tileWorldY, 'tiles', 1).setScale(0.5);
      scene.physics.add.existing(piece);
      piece.body.setVelocity(p.vx, p.vy);
      piece.body.setAngularVelocity(300);

      scene.tweens.add({
        targets: piece,
        alpha: 0,
        duration: 800,
        onComplete: () => piece.destroy()
      });
    });
    return;
  }

  // Normal bounce for question blocks or small Mario hitting bricks
  playSound(scene, 'bump');
  const bounceSprite = scene.add.sprite(tileWorldX, tileWorldY, 'tiles', tile.index);
  bounceSprite.setOrigin(0.5);

  layer.removeTileAt(x, y);

  scene.tweens.add({
    targets: bounceSprite,
    y: tileWorldY - 20,
    duration: 100,
    yoyo: true,
    ease: 'Power1',
    onComplete: () => {
      bounceSprite.destroy();
      const newTile = layer.putTileAt(newTileIndex, x, y);
      if (newTile && newTileIndex !== -1) {
        newTile.setCollision(true);
      }
    }
  });
}

function setupAnimations(scene) {
  const skins = ['mario', 'luigi', 'jacob', 'sean'];
  
  skins.forEach(skin => {
    // Small
    scene.anims.create({ key: skin + '_idle', frames: [{ key: skin, frame: 'idle' }], frameRate: 10 });
    scene.anims.create({
      key: skin + '_walk',
      frames: [{ key: skin, frame: 'run_1' }, { key: skin, frame: 'run_2' }, { key: skin, frame: 'run_3' }],
      frameRate: 12, repeat: -1
    });
    scene.anims.create({ key: skin + '_jump', frames: [{ key: skin, frame: 'jump' }], frameRate: 10 });
    scene.anims.create({ key: skin + '_skid', frames: [{ key: skin, frame: 'skid' }], frameRate: 10 });

    // Big
    scene.anims.create({ key: skin + '_big_idle', frames: [{ key: skin, frame: 'big_idle' }], frameRate: 10 });
    scene.anims.create({
      key: skin + '_big_walk',
      frames: [{ key: skin, frame: 'big_run_1' }, { key: skin, frame: 'big_run_2' }, { key: skin, frame: 'big_run_3' }],
      frameRate: 12, repeat: -1
    });
    scene.anims.create({ key: skin + '_big_jump', frames: [{ key: skin, frame: 'big_jump' }], frameRate: 10 });
    scene.anims.create({ key: skin + '_big_skid', frames: [{ key: skin, frame: 'big_skid' }], frameRate: 10 });

    // Fire
    scene.anims.create({ key: skin + '_fire_idle', frames: [{ key: skin, frame: 'fire_idle' }], frameRate: 10 });
    scene.anims.create({
      key: skin + '_fire_walk',
      frames: [{ key: skin, frame: 'fire_run_1' }, { key: skin, frame: 'fire_run_2' }, { key: skin, frame: 'fire_run_3' }],
      frameRate: 12, repeat: -1
    });
    scene.anims.create({ key: skin + '_fire_jump', frames: [{ key: skin, frame: 'fire_jump' }], frameRate: 10 });
    scene.anims.create({ key: skin + '_fire_skid', frames: [{ key: skin, frame: 'fire_skid' }], frameRate: 10 });
    scene.anims.create({ key: skin + '_fire_shoot', frames: [{ key: skin, frame: 'fire_shoot' }], frameRate: 10 });

    scene.anims.create({ key: skin + '_die', frames: [{ key: skin, frame: 'die' }], frameRate: 10 });
  });

  // Goomba
  scene.anims.create({
    key: 'goomba_walk',
    frames: scene.anims.generateFrameNumbers('tiles', { start: 200, end: 201 }),
    frameRate: 6,
    repeat: -1
  });
  scene.anims.create({ key: 'goomba_flat', frames: [{ key: 'tiles', frame: 202 }], frameRate: 10 });

  // Koopa
  scene.anims.create({
    key: 'koopa_walk',
    frames: scene.anims.generateFrameNumbers('tiles', { start: 203, end: 204 }),
    frameRate: 6,
    repeat: -1
  });
  scene.anims.create({ key: 'koopa_shell', frames: [{ key: 'tiles', frame: 205 }], frameRate: 10 });

  // Piranha Plant
  scene.anims.create({
    key: 'piranha_walk',
    frames: scene.anims.generateFrameNumbers('tiles', { start: 210, end: 211 }),
    frameRate: 4,
    repeat: -1
  });
}

function applyPlayerState(p, state) {
  const oldState = p.state;
  p.state = state;
  if (state === 0) {
    p.setSize(12, 16);
    p.setOffset(2, 0);
    // If shrinking from big to small, adjust Y to stay grounded
    if (oldState !== undefined && oldState !== 0) {
      p.y += 32; // 8px * 4 scale
    }
  } else {
    p.setSize(12, 32);
    p.setOffset(2, 0);
    // If growing from small to big, adjust Y to stay grounded
    if (oldState === 0) {
      p.y -= 32; // 8px * 4 scale
    }
  }
}

function randomizeSkinTexture(scene, skinData, textureKey) {
  const baseSkin = (skinData && skinData.baseSkin) ? skinData.baseSkin : 'mario';
  const baseTexture = scene.textures.get(baseSkin);
  if (!baseTexture) return;
  const sourceImage = baseTexture.getSourceImage();
  if (!sourceImage || sourceImage.width === 0) return;

  // Colors from server
  const color1 = (skinData && skinData.color1) ? skinData.color1 : { r: 255, g: 0, b: 0 };
  const color2 = (skinData && skinData.color2) ? skinData.color2 : { r: 139, g: 69, b: 19 };

  if (!scene.textures.exists(textureKey)) {
    // First time: Create as a canvas texture
    const canvas = document.createElement('canvas');
    canvas.width = sourceImage.width;
    canvas.height = sourceImage.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceImage, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a === 0) continue;

      // Detection for base skin's primary color 
      // Red for Mario, Jacob, Sean (typically)
      // Green for Luigi
      const isPrimary = (baseSkin === 'luigi') ? (g > 150 && r < 150 && b < 150) : (r > 150 && g < 150 && b < 150);
      
      let isSecondary = false;
      if (baseSkin === 'mario' || baseSkin === 'luigi') {
        isSecondary = !isPrimary;
      } else {
        const isSkin = (r > 200 && g > 150 && b > 100);
        isSecondary = !isPrimary && !isSkin && ( (b > r - 20) || (r < 150 && g < 150 && b < 150) );
      }
      
      if (isPrimary) {
        const brightness = Math.max(r, g, b) / 255;
        data[i] = Math.floor(color1.r * brightness);
        data[i + 1] = Math.floor(color1.g * brightness);
        data[i + 2] = Math.floor(color1.b * brightness);
      }
      else if (isSecondary) {
        const maxVal = Math.max(r, g, b);
        const brightness = maxVal > 0 ? maxVal / 180 : 0;
        data[i] = Math.min(255, Math.floor(color2.r * brightness));
        data[i + 1] = Math.min(255, Math.floor(color2.g * brightness));
        data[i + 2] = Math.min(255, Math.floor(color2.b * brightness));
      }
    }
    ctx.putImageData(imageData, 0, 0);
    
    const randomTexture = scene.textures.addCanvas(textureKey, canvas);
    // Copy frames from base texture
    Object.keys(baseTexture.frames).forEach(frameName => {
      if (frameName === '__BASE') return;
      const f = baseTexture.frames[frameName];
      randomTexture.add(frameName, 0, f.cutX, f.cutY, f.cutWidth, f.cutHeight);
    });

    // Create dynamic animations for this unique texture
    const anims = ['idle', 'walk', 'jump', 'skid', 'big_idle', 'big_walk', 'big_jump', 'big_skid', 'fire_idle', 'fire_walk', 'fire_jump', 'fire_skid', 'fire_shoot', 'die'];
    anims.forEach(anim => {
      let frames;
      if (anim === 'walk') frames = [{ key: textureKey, frame: 'run_1' }, { key: textureKey, frame: 'run_2' }, { key: textureKey, frame: 'run_3' }];
      else if (anim === 'big_walk') frames = [{ key: textureKey, frame: 'big_run_1' }, { key: textureKey, frame: 'big_run_2' }, { key: textureKey, frame: 'big_run_3' }];
      else if (anim === 'fire_walk') frames = [{ key: textureKey, frame: 'fire_run_1' }, { key: textureKey, frame: 'fire_run_2' }, { key: textureKey, frame: 'fire_run_3' }];
      else {
        // Use the anim name directly as the frame name (e.g. 'big_idle', 'fire_jump', etc.)
        // These frames were copied from the base texture in the previous step.
        frames = [{ key: textureKey, frame: anim }];
      }

      scene.anims.create({
        key: textureKey + '_' + anim,
        frames: frames,
        frameRate: (anim.includes('walk')) ? 12 : 10,
        repeat: (anim.includes('walk')) ? -1 : 0
      });
    });
  } else {
    // Refresh existing if needed (though usually we create unique keys per player)
    const randomTexture = scene.textures.get(textureKey);
    const canvas = randomTexture.getSourceImage();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Update dimensions if base skin changed size
    if (canvas.width !== sourceImage.width || canvas.height !== sourceImage.height) {
      canvas.width = sourceImage.width;
      canvas.height = sourceImage.height;
    }

    // CRITICAL: Clear the canvas before drawing the new skin to prevent ghosting
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sourceImage, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a === 0) continue;

      // Detection for base skin's primary color 
      const isPrimary = (baseSkin === 'luigi') ? (g > 150 && r < 150 && b < 150) : (r > 150 && g < 150 && b < 150);
      
      let isSecondary = false;
      if (baseSkin === 'mario' || baseSkin === 'luigi') {
        isSecondary = !isPrimary;
      } else {
        const isSkin = (r > 200 && g > 150 && b > 100);
        isSecondary = !isPrimary && !isSkin && ( (b > r - 20) || (r < 150 && g < 150 && b < 150) );
      }
      
      if (isPrimary) {
        const brightness = Math.max(r, g, b) / 255;
        data[i] = Math.floor(color1.r * brightness);
        data[i + 1] = Math.floor(color1.g * brightness);
        data[i + 2] = Math.floor(color1.b * brightness);
      }
      else if (isSecondary) {
        const maxVal = Math.max(r, g, b);
        const brightness = maxVal > 0 ? maxVal / 180 : 0;
        data[i] = Math.min(255, Math.floor(color2.r * brightness));
        data[i + 1] = Math.min(255, Math.floor(color2.g * brightness));
        data[i + 2] = Math.min(255, Math.floor(color2.b * brightness));
      }
    }
    ctx.putImageData(imageData, 0, 0);
    randomTexture.refresh();
  }
}

function getAnimKey(baseKey, state, skin = 'mario', playerID = null) {
  let key = baseKey;
  // If baseKey already has a state prefix, don't add another one
  if (!baseKey.startsWith('big_') && !baseKey.startsWith('fire_')) {
    if (state === 1) key = 'big_' + baseKey;
    if (state === 2) key = 'fire_' + baseKey;
  }
  
  const id = playerID || socket.id;
  
  // Find the player object to check for skinData
  let pData = null;
  if (!playerID || playerID === socket.id) {
    pData = player;
  } else {
    pData = otherPlayers.getChildren().find(p => p.id === playerID);
  }

  const prefix = (pData && pData.skinData) ? `custom_${id}` : skin;
  return prefix + '_' + key;
}

function addPlayer(scene, playerInfo) {
  if (player) return;
  const x = playerInfo.x || 150;
  const y = playerInfo.y || 700;

  let textureKey = selectedSkin;
  let sData = playerInfo.skinData || customSkinColors[selectedSkin];
  
  if (sData) {
    textureKey = `custom_${socket.id}`;
    if (!scene.textures.exists(textureKey)) {
      randomizeSkinTexture(scene, sData, textureKey);
    }
  }

  player = scene.physics.add.sprite(x, y, textureKey);
  player.setScale(4);
  player.setCollideWorldBounds(true);
  player.skinData = sData;
  applyPlayerState(player, playerInfo.state || 0);

  if (layer) {
    if (playerCollider) scene.physics.world.removeCollider(playerCollider);
    playerCollider = scene.physics.add.collider(player, layer, handleTileCollision, null, scene);
  }

  player.body.setDragX(DRAG);
  player.body.setMaxVelocity(RUN_MAX_VELOCITY, 1100);
  player.setDepth(5);
  scene.cameras.main.startFollow(player, true);

  // Overhauled ground check variables
  player.lastGroundedTime = 0;
  player.jumpBufferTimer = 0;

}

function addOtherPlayers(scene, playerInfo) {
  // Prevent duplicate sprites for the same player ID
  if (otherPlayers.getChildren().find(p => p.id === playerInfo.id)) return;

  const skin = playerInfo.skin || 'mario';
  let textureKey = skin;

  if (playerInfo.skinData) {
    textureKey = `custom_${playerInfo.id}`;
    if (!scene.textures.exists(textureKey)) {
      randomizeSkinTexture(scene, playerInfo.skinData, textureKey);
    }
  }

  const otherPlayer = scene.physics.add.sprite(playerInfo.x, playerInfo.y, textureKey).setScale(4);
  otherPlayer.id = playerInfo.id;
  otherPlayer.skinData = playerInfo.skinData;
  otherPlayer.username = playerInfo.username || 'Guest';
  otherPlayer.targetX = playerInfo.x;
  otherPlayer.targetY = playerInfo.y;
  otherPlayer.body.moves = false; // Prevent local physics (gravity/velocity) from interfering with server-synced position
  applyPlayerState(otherPlayer, playerInfo.state || 0);
  if (playerInfo.anim) {
    const action = playerInfo.anim.split('_').pop();
    otherPlayer.anims.play(getAnimKey(action, playerInfo.state || 0, skin, playerInfo.id), true);
  }
  otherPlayer.invincible = playerInfo.invincible || false;
  otherPlayer.setDepth(5);

  // Username Label
  const labelText = scene.add.text(0, 0, otherPlayer.username, {
    fontFamily: '"Press Start 2P"',
    fontSize: '14px',
    fill: '#ffffff',
    align: 'center'
  }).setOrigin(0.5);
  labelText.setDepth(10);

  const padding = 8;
  const bg = scene.add.rectangle(0, 0, labelText.width + padding, labelText.height + padding, 0x000000, 0.5);
  bg.setDepth(9);

  otherPlayer.usernameLabel = labelText;
  otherPlayer.usernameBg = bg;

  // Cleanup labels when player is destroyed
  otherPlayer.on('destroy', () => {
    if (labelText) labelText.destroy();
    if (bg) bg.destroy();
  });

  otherPlayers.add(otherPlayer);
}

let lastEmitTime = 0;
const EMIT_THRESHOLD_MS = 33; // Increased to 33ms (~30 FPS) to reduce server load
const MOVE_THRESHOLD = 0.1;   // Slightly more sensitive movement detection

function update(time, delta) {
  // Disable keyboard manager if user is typing in an input field
  // This allows WASD etc. to reach the DOM and prevents game actions
  if (this.input && this.input.keyboard) {
    this.input.keyboard.enabled = !isTyping();
    this.input.keyboard.preventDefault = !isTyping();
  }
  if (isTyping()) return;

  if (isTimerRunning) {
    runTime += delta;
    if (currentTimeDisplay) currentTimeDisplay.innerText = formatTime(runTime);
  }

  if (shootTimer > 0) shootTimer -= delta;

  otherPlayers.getChildren().forEach((otherPlayer) => {
    if (otherPlayer.targetX !== undefined && otherPlayer.targetY !== undefined) {
      const lerpFactor = 0.4; // Increased from 0.15 to make movement feel more direct and less "floaty"
      const newX = Phaser.Math.Linear(otherPlayer.x, otherPlayer.targetX, lerpFactor);
      const newY = Phaser.Math.Linear(otherPlayer.y, otherPlayer.targetY, lerpFactor);
      otherPlayer.setPosition(newX, newY);

      // Apply jump frame offsets
      const isJumping = otherPlayer.anims.currentAnim && otherPlayer.anims.currentAnim.key.includes('jump');

      if (isJumping) {
        const jumpHeight = (otherPlayer.state === 0) ? 14 : 28;
        const jumpOffset = (otherPlayer.state === 0) ? 2 : 4;
        otherPlayer.setSize(12, jumpHeight);
        otherPlayer.setOffset(otherPlayer.flipX ? 2 : 6, jumpOffset);
      } else {
        if (otherPlayer.state === 0) {
          if (otherPlayer.body.height !== 16) otherPlayer.setSize(12, 16);
        } else {
          if (otherPlayer.body.height !== 32) otherPlayer.setSize(12, 32);
        }
        otherPlayer.setOffset(2, 0);
      }

      // Rainbow Effect for Other Players
      if (otherPlayer.invincible) {
        const colors = [0xff0000, 0xffa500, 0xffff00, 0x00ff00, 0x0000ff, 0x4b0082, 0xee82ee];
        const colorIndex = Math.floor(time / 50) % colors.length;
        otherPlayer.setTint(colors[colorIndex]);
      } else {
        // Clear tint unless they were just hit (handled by knockback event or similar)
        // For simplicity, we'll just clear it if not invincible, 
        // but we should be careful not to override knockback red tint too quickly.
        // Actually, the server broadcasts 'invincible: false' when it ends.
        if (otherPlayer.oldInvincible && !otherPlayer.invincible) {
          otherPlayer.clearTint();
        }
      }
      otherPlayer.oldInvincible = otherPlayer.invincible;

      // Invulnerability Flicker for Other Players
      if (!otherPlayer.invincible && otherPlayer.invulnTimer > 0) {
        otherPlayer.alpha = (Math.floor(time / 50) % 2 === 0) ? 0.5 : 1;
      } else {
        otherPlayer.alpha = 1;
      }

      // Update Username Label Position
      if (otherPlayer.usernameLabel && otherPlayer.usernameBg) {
        const labelY = otherPlayer.y - (otherPlayer.state === 0 ? 60 : 100);
        otherPlayer.usernameLabel.setPosition(otherPlayer.x, labelY);
        otherPlayer.usernameBg.setPosition(otherPlayer.x, labelY);
      }
    }
  });

  // Interpolate Enemies
  enemies.getChildren().forEach((enemy) => {
    if (enemy.targetX !== undefined && enemy.targetY !== undefined) {
      const lerpFactor = 0.3; // Slightly slower lerp for enemies
      enemy.x = Phaser.Math.Linear(enemy.x, enemy.targetX, lerpFactor);
      enemy.y = Phaser.Math.Linear(enemy.y, enemy.targetY, lerpFactor);
    }
  });

  // Interpolate Items
  this.items.getChildren().forEach((item) => {
    if (item.targetX !== undefined && item.targetY !== undefined) {
      const lerpFactor = 0.3;
      item.x = Phaser.Math.Linear(item.x, item.targetX, lerpFactor);
      item.y = Phaser.Math.Linear(item.y, item.targetY, lerpFactor);
    }
  });

  // Safety cleanup for fireballs
  const now = Date.now();
  fireballs.getChildren().forEach((fb) => {
    if (now - fb.lastUpdate > 5000) {
      if (fireTrails[fb.id]) {
        fireTrails[fb.id].stop();
        delete fireTrails[fb.id];
      }
      fb.destroy();
    }
  });

  if (Phaser.Input.Keyboard.JustDown(keyEsc)) {
    toggleGameMenu();
  }

  // Handle player logic if player exists
  if (player && player.body) {
    // If the physics world is paused (true pause), skip player updates entirely
    if (this.physics.world.isPaused) {
      return;
    }

    // Check if we should block input (menu is open)
    const isMenuOpen = gameMenuModal.classList.contains('active') || 
                       settingsModal.classList.contains('active') ||
                       chromaModal.classList.contains('active');

    // Quick Restart (R key) - Allowed even when dead or animating (ONLY in Singleplayer)
    if (isActionJustDown('restart') && isSinglePlayer) {
      if (player) {
        player.setVelocity(0, 0);
        player.setAcceleration(0, 0);
        player.isRestarting = true;
        applyPlayerState(player, 0); // Visual reset to small immediately
        player.invincible = false;
        player.clearTint();
      }
      socket.emit('requestRestart');
    }

    const state = player.state || 0;

    if (player.dead || player.levelFinished || player.isAnimating || player.isRestarting) {
      if (player.dead) {
        player.anims.play(getAnimKey('die', state, selectedSkin), true);
        player.setCollideWorldBounds(false); // Allow falling off screen
        player.setVelocityX(0);
        player.setAccelerationX(0);

        // Spectator Mode Logic
        if (!isSinglePlayer) {
          const aliveOthers = otherPlayers.getChildren().filter(p => !p.dead);
          if (aliveOthers.length > 0) {
            // If we don't have a target or target died/disconnected, pick first one
            let target = otherPlayers.getChildren().find(p => p.id === spectatingPlayerId);
            if (!target || target.dead) {
              target = aliveOthers[0];
              spectatingPlayerId = target.id;
              this.cameras.main.startFollow(target, true);
            }

            // Cycle through players with SPACE
            if (Phaser.Input.Keyboard.JustDown(keySpace)) {
              let currentIndex = aliveOthers.findIndex(p => p.id === spectatingPlayerId);
              let nextIndex = (currentIndex + 1) % aliveOthers.length;
              target = aliveOthers[nextIndex];
              spectatingPlayerId = target.id;
              this.cameras.main.startFollow(target, true);
            }

            if (target) {
              spectatorText.setText(`SPECTATING: ${target.username || target.id}`);
              spectatorBg.width = spectatorText.width + 40;
              spectatorText.setVisible(true);
              spectatorBg.setVisible(true);
            }
          } else {
            spectatorText.setText('WAITING FOR OTHERS...');
            spectatorBg.width = spectatorText.width + 40;
            spectatorText.setVisible(true);
            spectatorBg.setVisible(true);
            // Fallback to following self if no one else is alive
            this.cameras.main.startFollow(player, true);
          }
        }
      } else {
        player.anims.play(getAnimKey('idle', state, selectedSkin), true);
        player.setVelocity(0, 0);
        player.setAcceleration(0, 0);
        player.setCollideWorldBounds(true);
      }

      if (player.dead || player.levelFinished) {
        setTimerRunning(false, false);
      }

      // Cleanup spectator UI if not dead anymore (e.g. state changed but update still running)
      if (!player.dead && spectatorText.visible) {
        spectatorText.setVisible(false);
        spectatorBg.setVisible(false);
        spectatingPlayerId = null;
        this.cameras.main.startFollow(player, true);
      }

      return;
    }

    // Reset spectator state if alive
    if (spectatorText.visible) {
      spectatorText.setVisible(false);
      spectatorBg.setVisible(false);
      spectatingPlayerId = null;
      this.cameras.main.startFollow(player, true);
    }
    player.setCollideWorldBounds(true);
    player.body.setAllowGravity(true);

    // --- Ground Check Overhaul ---
    // Use 'blocked.down' to only count tiles and world bounds as ground.
    // This ignores overlaps with items/coins.
    const isActuallyGrounded = player.body.blocked.down;
    if (isActuallyGrounded) {

      player.lastGroundedTime = time;
    }

    // Coyote Time: allow jumping if we were grounded recently
    const canJump = (time - player.lastGroundedTime) < 100;

    if (isActionJustDown('up')) {
      player.jumpBufferTimer = time;
    }
    const isJumpBuffered = (time - player.jumpBufferTimer) < 150;

    const isGrounded = isActuallyGrounded; // For animations, use the real state

    const currentVelocityX = player.body.velocity.x;
    const absVelocityX = Math.abs(currentVelocityX);

    if (!isMenuOpen) {
      if (isActionDown('left')) {
        if (currentVelocityX > 150) {
          player.setAccelerationX(-ACCEL * 2);
          player.body.setDragX(SKID_DRAG);
          player.anims.play(getAnimKey('skid', state, selectedSkin), true);
        } else {
          player.setAccelerationX(-ACCEL);
          player.body.setDragX(DRAG);
          player.flipX = true;
          moveHoldTimer += delta;
          const maxSpeed = moveHoldTimer > 100 ? RUN_MAX_VELOCITY : WALK_MAX_VELOCITY;
          player.body.setMaxVelocity(maxSpeed, 1100);
          if (isGrounded) player.anims.play(getAnimKey('walk', state, selectedSkin), true);
        }
      } else if (isActionDown('right')) {
        if (currentVelocityX < -150) {
          player.setAccelerationX(ACCEL * 2);
          player.body.setDragX(SKID_DRAG);
          player.anims.play(getAnimKey('skid', state, selectedSkin), true);
        } else {
          player.setAccelerationX(ACCEL);
          player.body.setDragX(DRAG);
          player.flipX = false;
          moveHoldTimer += delta;
          const maxSpeed = moveHoldTimer > 100 ? RUN_MAX_VELOCITY : WALK_MAX_VELOCITY;
          player.body.setMaxVelocity(maxSpeed, 1100);
          if (isGrounded) player.anims.play(getAnimKey('walk', state, selectedSkin), true);
        }
      } else {
        player.setAccelerationX(0);
        player.body.setDragX(DRAG);
        moveHoldTimer = 0;
        if (isGrounded) {
          if (absVelocityX < 10) {
            if (shootTimer <= 0) player.anims.play(getAnimKey('idle', state, selectedSkin), true);
          } else {
            if (shootTimer <= 0) player.anims.play(getAnimKey('walk', state, selectedSkin), true);
          }
        }
      }

      if (isJumpBuffered && canJump) {
        if (state === 0) {
          playSound(this, 'jumpsmall');
        } else {
          playSound(this, 'jump');
        }
        player.setVelocityY(JUMP_FORCE);
        player.jumpBufferTimer = 0; // Clear buffer
        player.lastGroundedTime = 0; // Clear coyote time
      }
      if (!isActionDown('up') && player.body.velocity.y < 0) player.setVelocityY(player.body.velocity.y * VARIABLE_JUMP_MODIFIER);



      if (!isGrounded && Math.abs(player.body.velocity.y) > 20) {
        if (shootTimer <= 0) {
          player.anims.play(getAnimKey('jump', state, selectedSkin), true);
        }

        const jumpHeight = (state === 0) ? 14 : 28;
        const jumpOffset = (state === 0) ? 2 : 4;
        player.setSize(12, jumpHeight);
        player.setOffset(player.flipX ? 2 : 6, jumpOffset);
      } else if (isGrounded) {
        if (state === 0) {
          if (player.body.height !== 16) player.setSize(12, 16);
        } else {
          if (player.body.height !== 32) player.setSize(12, 32);
        }
        player.setOffset(2, 0);
      }

      if (shootTimer > 0 && state === 2) {
        player.setOffset(2, 0); // Keep consistent offset
      }

      if (isActionJustDown('fire') && player.state === 2) {
        shootTimer = 150;
        player.anims.play(getAnimKey('fire_shoot', state, selectedSkin), true);
        socket.emit('shootFireball');
        
        // Return to idle/walk after animation
        this.time.delayedCall(200, () => {
          if (player && !player.dead && shootTimer <= 0) {
            const currentAction = (Math.abs(player.body.velocity.x) < 10) ? 'idle' : 'walk';
            player.anims.play(getAnimKey(currentAction, player.state, selectedSkin), true);
          }
        });
      }

      if (isActionDown('down')) {
        if (isGrounded && !player.warping && !player.isAnimating) {
          // Check if we are on a pipe
          const tx = Math.floor(player.x / 64);
          // Check a few pixels below feet to hit the pipe top
          const feetY = player.y + (player.state === 0 ? 32 : 64);
          const ty = Math.floor((feetY + 10) / 64);
          const tile = layer.getTileAt(tx, ty);

          if (tile && (tile.index === 94 || tile.index === 95)) {
            const warpCoords = `${tx},${ty}`;
            const warpInfo = currentWarps[warpCoords];
            if (warpInfo) {
              const pipeCenterX = (tile.index === 94) ? (tile.x * 64 + 64) : (tile.x * 64);
              playPipeEnterAnimation(this, player, pipeCenterX, warpInfo.warpType || 'pipe-down');
            }
          }
        }
      }
    } else {
      // Menu is open, but not paused (multiplayer). 
      // Stop movement but keep gravity/friction active.
      player.setAccelerationX(0);
      moveHoldTimer = 0;
      if (isGrounded) {
        if (absVelocityX < 10) {
          player.anims.play(getAnimKey('idle', state, selectedSkin), true);
        } else {
          player.anims.play(getAnimKey('walk', state, selectedSkin), true);
        }
      }
    }

    const now = Date.now();
    const x = Math.round(player.x * 10) / 10;
    const y = Math.round(player.y * 10) / 10;
    const anim = player.anims.currentAnim ? player.anims.currentAnim.key : 'idle';
    const flipX = player.flipX;

    const hasMovedSignificantly = !player.oldPosition ||
      Math.abs(x - player.oldPosition.x) > MOVE_THRESHOLD ||
      Math.abs(y - player.oldPosition.y) > MOVE_THRESHOLD ||
      anim !== player.oldPosition.anim ||
      flipX !== player.oldPosition.flipX ||
      state !== player.oldPosition.state ||
      player.invincible !== player.oldPosition.invincible;

    if (hasMovedSignificantly && now - lastEmitTime > EMIT_THRESHOLD_MS) {
      socket.emit('playerMovement', { x, y, anim, flipX, state, skin: selectedSkin });
      lastEmitTime = now;
      player.oldPosition = { x, y, anim, flipX, state, invincible: player.invincible, skin: selectedSkin };
    }

    // Rainbow Effect for Local Player
    if (player.invincible) {
      const colors = [0xff0000, 0xffa500, 0xffff00, 0x00ff00, 0x0000ff, 0x4b0082, 0xee82ee];
      const colorIndex = Math.floor(time / 50) % colors.length;
      player.setTint(colors[colorIndex]);
    } else {
      if (player.oldInvincible && !player.invincible) {
        player.clearTint();
      }
    }
    player.oldInvincible = player.invincible;

    // Invulnerability Flicker for Local Player
    if (!player.invincible && player.invulnTimer > 0) {
      player.alpha = (Math.floor(time / 50) % 2 === 0) ? 0.5 : 1;
    } else {
      player.alpha = 1;
    }

    // Handle Star Power Music for Local Player
    if (player.invincible && currentMusicKey !== 'music_invincible' && currentMusicKey !== 'music_victory') {
      playMusic(this, 'music_invincible');
    } else if (!player.invincible && currentMusicKey === 'music_invincible') {
      const normalMusic = player.levelId === 'underground' ? 'music_underground' : 'music_overworld';
      playMusic(this, normalMusic);
    }
  }
}

function playPipeEnterAnimation(scene, sprite, pipeCenterX, type) {
  if (!sprite || !sprite.body || sprite.isAnimating) return;
  playSound(scene, 'pipepowerdown');
  sprite.isAnimating = true;
  sprite.warping = true;
  socket.emit('startWarp'); // Notify server to freeze our state
  sprite.body.setAllowGravity(false);
  sprite.body.setVelocity(0, 0);
  sprite.setDepth(1); // Go behind pipe

  const dist = 128;
  const targetY = (type === 'pipe-up') ? (sprite.y - dist) : (sprite.y + dist);

  scene.tweens.add({
    targets: sprite,
    x: pipeCenterX,
    y: targetY,
    duration: 800,
    ease: 'Power1',
    onComplete: () => {
      socket.emit('requestWarp');
      sprite.isAnimating = false;
      sprite.warping = false;
      sprite.setDepth(5);
    }
  });
}

function playFlagAnimation(scene, sprite, startX, startY) {
  if (sprite.isAnimating) return;
  sprite.isAnimating = true;
  sprite.body.setAllowGravity(false);
  sprite.setVelocity(0, 0);
  setTimerRunning(false, false);

  // Find ground Y
  let groundY = startY;
  const tx = Math.floor(sprite.x / 64);
  const startTy = Math.floor(startY / 64);

  if (layer && layer.tilemap) {
    for (let ty = startTy; ty < layer.tilemap.height; ty++) {
      const tile = layer.getTileAt(tx, ty);
      if (tile && tile.index !== -1 && tile.index !== 247) {
        groundY = ty * 64 - (sprite.state === 0 ? 32 : 64);
        break;
      }
    }
  }

  // Slide duration: 800ms
  scene.tweens.add({
    targets: sprite,
    y: groundY,
    duration: 800,
    ease: 'Linear',
    onUpdate: () => {
      const x = Math.round(sprite.x * 10) / 10;
      const y = Math.round(sprite.y * 10) / 10;
      const anim = sprite.anims.currentAnim ? sprite.anims.currentAnim.key : 'idle';
      const flipX = sprite.flipX;
      const state = sprite.state || 0;
      socket.emit('playerMovement', { x, y, anim, flipX, state });
    },
    onComplete: () => {
      scene.time.delayedCall(1000, () => {
        socket.emit('finishLevel');
      });
    }
  });
}
// Load saved credentials on page load
window.addEventListener('load', () => {
  loadSavedCredentials();
});
