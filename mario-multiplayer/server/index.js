import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { MAPS, buildLevel, mapConfig, TILE, ITEM_TYPES, getBlockContent, getEnemySpawns, getItemSpawns } from './map.js';
import { Sequelize, DataTypes } from 'sequelize';
import { setupAuthRoutes } from './auth.js';

// Database Setup
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite',
    logging: false
});

const HighScore = sequelize.define('HighScore', {
    levelId: { type: DataTypes.STRING, defaultValue: 'world-1-1' },
    playerName: { type: DataTypes.STRING, defaultValue: 'Mario' },
    timeMs: { type: DataTypes.INTEGER, allowNull: false },
    score: { type: DataTypes.INTEGER, defaultValue: 0 }
});

const PvPWin = sequelize.define('PvPWin', {
    playerName: { type: DataTypes.STRING, unique: true },
    wins: { type: DataTypes.INTEGER, defaultValue: 0 }
});

// Cache for leaderboard (Cache-Aside pattern)
// Key format: `${levelId}_${type}` where type is 'time' or 'score'
let leaderboardCaches = {};
const CACHE_TTL = 60000; // 60 seconds
let lastGlobalRefresh = Date.now();

// Global background refresh (Scheduled Refresh pattern)
async function refreshAllLeaderboards() {
    console.log('[Background] Refreshing all leaderboards...');
    const levels = Object.keys(MAPS);
    const types = ['time', 'score', 'pvp'];

    for (const levelId of levels) {
        for (const type of types) {
            const cacheKey = `${levelId}_${type}`;
            try {
                let scores;
                if (type === 'score') {
                    scores = await HighScore.findAll({
                        where: { levelId },
                        attributes: ['playerName', [sequelize.fn('MAX', sequelize.col('score')), 'score']],
                        group: ['playerName'],
                        order: [[sequelize.literal('score'), 'DESC']],
                        limit: 50
                    });
                } else if (type === 'pvp') {
                    // PvP wins are global, not per level, but we use levelId to keep cache structure
                    scores = await PvPWin.findAll({
                        order: [['wins', 'DESC']],
                        limit: 50
                    });
                } else {
                    scores = await HighScore.findAll({
                        where: { levelId },
                        attributes: ['playerName', [sequelize.fn('MIN', sequelize.col('timeMs')), 'timeMs']],
                        group: ['playerName'],
                        order: [[sequelize.literal('timeMs'), 'ASC']],
                        limit: 50
                    });
                }
                leaderboardCaches[cacheKey] = scores;
            } catch (err) {
                console.error(`Failed to refresh cache ${cacheKey}:`, err);
            }
        }
    }
    lastGlobalRefresh = Date.now();
}

// Run refresh every 60s
setInterval(refreshAllLeaderboards, CACHE_TTL);
// Initial fetch
initDb().then(() => refreshAllLeaderboards());


// User Model for Authentication
const User = sequelize.define('User', {
    username: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    passwordHash: {
        type: DataTypes.STRING,
        allowNull: false
    },
    isAdmin: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    sessionToken: {
        type: DataTypes.STRING,
        allowNull: true
    }
});

const app = express();
app.use(cors());
app.use(express.json());

// Setup auth routes BEFORE static file serving
setupAuthRoutes(app, User);

// Admin Middleware
const adminMiddleware = async (req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const user = await User.findByPk(userId);
        if (user && user.isAdmin) {
            next();
        } else {
            res.status(403).json({ error: 'Forbidden: Admin access required' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Admin Routes
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        const users = await User.findAll({
            attributes: ['id', 'username', 'email', 'isAdmin', 'createdAt']
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.get('/api/admin/scores', adminMiddleware, async (req, res) => {
    try {
        const scores = await HighScore.findAll({
            order: [['createdAt', 'DESC']],
            limit: 100
        });
        res.json(scores);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch scores' });
    }
});

app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        await HighScore.destroy({ where: { playerName: user.username } });
        await user.destroy();

        res.json({ message: 'User and their scores deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

app.delete('/api/admin/scores/:id', adminMiddleware, async (req, res) => {
    try {
        const score = await HighScore.findByPk(req.params.id);
        if (!score) return res.status(404).json({ error: 'Score not found' });
        await score.destroy();
        res.json({ message: 'Score deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete score' });
    }
});

async function initDb() {
    try {
        await sequelize.sync({ alter: true });
    } catch (err) {
        console.error('Database init error:', err);
    }
}

// Serve static client files
app.use(express.static(path.join(__dirname, '../client/dist')));

// Fallback to index.html for client-side routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const lobbies = {}; // { [id]: { players, activeItems, activeEnemies, ... } }
const shootingCooldowns = {};

function createLobby(id, name = 'Room', mode = 'Co-op', hostId = null) {
    const initialLevel = 'world-1-1';
    const lobby = {
        id,
        name,
        mode,
        host: hostId,
        maxPlayers: 4,
        status: 'waiting', // 'waiting' or 'playing'
        players: {},
        activeItems: {},
        activeFireballs: {},
        activeEnemies: {},
        itemIdCounter: 0,
        fireballIdCounter: 0,
        enemyIdCounter: 0,
        levelIsRestarting: false,
        currentLevel: initialLevel,
        builtMaps: { [initialLevel]: buildLevel(initialLevel) },
        chaosBlockContents: {}, // { [levelId]: { "x,y": itemType } }
        chaosEnemySpawns: {},   // { [levelId]: [ {x, y, type} ] }
        spawnedLevels: new Set(), // Track which levels have had initial enemies spawned
        totalScore: 0,
        readyPlayers: {},
        flagHit: false,
        isPaused: false,
        restartTimeout: null
    };

    if (mode === 'Chaos') {
        applyChaosRandomization(lobby, initialLevel);
    }

    return lobby;
}

function closeLobby(lobbyId, notify = true) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    if (notify) {
        io.to(lobby.id).emit('lobbyKilled');
    }

    const playerIds = Object.keys(lobby.players);
    playerIds.forEach(pId => {
        const pSocket = io.sockets.sockets.get(pId);
        if (pSocket) {
            pSocket.leave(lobby.id);
            if (lobby.players[pId].levelId) {
                pSocket.leave(`${lobby.id}_${lobby.players[pId].levelId}`);
            }
            delete pSocket.lobbyId;
        }
    });

    delete lobbies[lobbyId];
    broadcastLobbyList();
}

// Physics Constants
const GRAVITY = 0.8;
const ITEM_SPEED = 3;
const ENEMY_SPEED = 2;
const TILE_SIZE = 64;
const CHAOS_BLOCK_FRAMES = [1, 33, 129, 145, 160]; // Brick, Hard, Question, Ground-Top, Ground-Fill

function getRandomChaosFrame() {
    return CHAOS_BLOCK_FRAMES[Math.floor(Math.random() * CHAOS_BLOCK_FRAMES.length)];
}

let levelIsRestarting = false;

// Server Heartbeat (Physics Update)
setInterval(() => {
    Object.values(lobbies).forEach(lobby => {
        if (lobby.isPaused) return;

        // Group entities by level for efficient broadcasting
        const levelUpdates = {}; // { [levelId]: { itemUpdates, enemyUpdates, fireballUpdates } }

        Object.keys(lobby.activeItems).forEach(id => {
            const item = lobby.activeItems[id];
            const levelId = item.levelId || 'world-1-1';
            if (!levelUpdates[levelId]) levelUpdates[levelId] = { itemUpdates: [], enemyUpdates: [], fireballUpdates: [] };

            if (item.type === ITEM_TYPES.MUSHROOM || item.type === ITEM_TYPES.STAR) {
                // Horizontal movement
                item.x += item.vx;

                // Horizontal Collision detection
                const tileX = Math.floor((item.x + (item.vx > 0 ? 16 : -16)) / TILE_SIZE);
                const tileY = Math.floor(item.y / TILE_SIZE);

                if (isSolid(lobby, tileX, tileY, levelId)) {
                    item.vx *= -1;
                }

                // Vertical movement (Gravity)
                item.vy += GRAVITY;
                item.y += item.vy;

                // Vertical Collision detection
                const footX = Math.floor(item.x / TILE_SIZE);
                const footY = Math.floor((item.y + 16) / TILE_SIZE);

                if (isSolid(lobby, footX, footY, levelId)) {
                    item.y = footY * TILE_SIZE - 16;
                    item.vy = 0;

                    if (item.type === ITEM_TYPES.STAR) {
                        item.vy = -12; // Star bounces
                    }
                }

                levelUpdates[levelId].itemUpdates.push({ id, x: item.x, y: item.y });
            }
        });


        const deadFireballs = [];



        Object.keys(lobby.activeFireballs).forEach(id => {
            const f = lobby.activeFireballs[id];
            const levelId = f.levelId || 'world-1-1';
            if (!levelUpdates[levelId]) levelUpdates[levelId] = { itemUpdates: [], enemyUpdates: [], fireballUpdates: [] };

            f.life -= 33;
            const prevX = f.x;
            const prevY = f.y;
            f.vy += GRAVITY;
            f.x += f.vx;
            f.y += f.vy;

            // ---- WALL COLLISION (horizontal) ----
            const nextX = f.x + f.vx;

            const wallCheckPoints = [
                { x: nextX, y: f.y - 6 },
                { x: nextX, y: f.y },
                { x: nextX, y: f.y + 6 }
            ];

            const hitWall = wallCheckPoints.some(p =>
                isSolid(lobby, Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE), levelId)
            );

            if (hitWall) {
                deadFireballs.push(id);
                return;
            }

            // ---- GROUND COLLISION (robust) ----
            const footY = Math.floor((f.y + 10) / TILE_SIZE);

            const footXs = [
                Math.floor(f.x / TILE_SIZE),
                Math.floor((f.x - 6) / TILE_SIZE),
                Math.floor((f.x + 6) / TILE_SIZE)
            ];

            let hitGround = footXs.some(x => isSolid(lobby, x, footY, levelId));

            // ONLY bounce if falling
            if (hitGround && f.vy > 0) {
                // Snap to ground (prevents sinking)
                f.y = footY * TILE_SIZE - 10;

                // Stronger, consistent bounce
                f.vy = -10;

                f.bounces++;
            }

            // ---- PLAYER COLLISION ----
            Object.keys(lobby.players).forEach(pId => {
                if (pId === f.ownerId) return;

                const target = lobby.players[pId];
                if (target.levelId !== levelId) return; // Only same level

                const dx = f.x - target.x;
                const dy = f.y - (target.y + (target.state === 0 ? 16 : 32));

                if (dx * dx + dy * dy < 24 * 24) { // Slightly larger hitbox for fireballs
                    if (lobby.mode === 'PvP' || lobby.mode === 'Chaos') {
                        handlePlayerInjury(lobby, pId, f.vx > 0 ? 800 : -800);
                    } else {
                        io.to(pId).emit('playerKnockback', {
                            vx: f.vx > 0 ? 800 : -800,
                            vy: -600
                        });
                    }

                    deadFireballs.push(id);
                }
            });

            // ---- IMPROVED STUCK DETECTION ----
            const dx = Math.abs(f.x - prevX);
            const dy = Math.abs(f.y - prevY);

            if (dx < 0.5 && dy < 0.5) {
                f.stuckFrames = (f.stuckFrames || 0) + 1;
            } else {
                f.stuckFrames = 0;
            }

            if (
                f.life <= 0 ||
                f.bounces > 8 ||
                f.stuckFrames > 10 ||
                f.y > (getLobbyMap(lobby, levelId).height * TILE_SIZE)
            ) {
                deadFireballs.push(id);
            } else {
                levelUpdates[levelId].fireballUpdates.push({ id, x: f.x, y: f.y });
            }
        });

        deadFireballs.forEach(id => {
            const levelId = lobby.activeFireballs[id].levelId || 'world-1-1';
            delete lobby.activeFireballs[id];
            io.to(`${lobby.id}_${levelId}`).emit('fireballDestroyed', id);
        });


        const deadEnemies = [];

        Object.keys(lobby.activeEnemies).forEach(id => {
            const enemy = lobby.activeEnemies[id];
            if (enemy.damageCooldown > 0) enemy.damageCooldown -= 33;
            const levelId = enemy.levelId || 'world-1-1';
            if (!levelUpdates[levelId]) levelUpdates[levelId] = { itemUpdates: [], enemyUpdates: [], fireballUpdates: [] };

            // Piranha Plant Logic (Vertical oscillation)
            if (enemy.type === 'piranha') {
                if (!enemy.timer) enemy.timer = 0;
                enemy.timer += 33;

                // Simple oscillation: 2s down (hidden), 2s up (visible)
                const cycle = enemy.timer % 4000;
                const baseY = enemy.startY || enemy.y;
                if (!enemy.startY) enemy.startY = baseY;

                if (cycle < 2000) {
                    // Coming up (0 to 1000ms) then staying up (1000 to 2000ms)
                    const sub = Math.min(1000, cycle);
                    enemy.y = (baseY + 64) - (sub / 1000) * 64;
                } else {
                    // Going down (2000 to 3000ms) then staying down (3000 to 4000ms)
                    const sub = Math.min(1000, cycle - 2000);
                    enemy.y = baseY + (sub / 1000) * 64;
                }
                // No early return! Need to check player collisions.
            } else {
                // Regular Enemy Logic (Horizontal movement + Gravity)

                // Horizontal movement
                if (enemy.state !== 'shell-still') {
                    enemy.x += enemy.vx;
                }

                // Horizontal Collision detection
                const sideOffset = (enemy.type === 'koopa' && enemy.state !== 'walking') ? 24 : 32;
                const tileX = Math.floor((enemy.x + (enemy.vx > 0 ? sideOffset : -sideOffset)) / TILE_SIZE);
                const tileY = Math.floor(enemy.y / TILE_SIZE);

                if (isSolid(lobby, tileX, tileY, levelId)) {
                    enemy.vx *= -1;
                }

                // Vertical movement (Gravity) - Shells and Walking enemies
                enemy.vy += GRAVITY;
                enemy.y += enemy.vy;

                // Vertical Collision detection
                const footX = Math.floor(enemy.x / TILE_SIZE);
                const footY = Math.floor((enemy.y + 32) / TILE_SIZE);

                if (isSolid(lobby, footX, footY, levelId)) {
                    enemy.y = footY * TILE_SIZE - 32;
                    enemy.vy = 0;
                }
            }

            // Check Fireball Collisions
            Object.keys(lobby.activeFireballs).forEach(fId => {
                const f = lobby.activeFireballs[fId];
                if (f.levelId !== levelId) return;
                const dx = enemy.x - f.x;
                const dy = enemy.y - f.y;
                if (dx * dx + dy * dy < 32 * 32) {
                    deadEnemies.push({ id, reason: 'fireball', levelId });
                    if (lobby.players[f.ownerId]) {
                        addPlayerScore(lobby, f.ownerId, 100, enemy.x, enemy.y, levelId);
                    }
                    delete lobby.activeFireballs[fId];
                    io.to(`${lobby.id}_${levelId}`).emit('fireballDestroyed', fId);
                }
            });

            // Check Shell-Rolling Collisions with other enemies
            if (enemy.type === 'koopa' && enemy.state === 'shell-rolling') {
                Object.keys(lobby.activeEnemies).forEach(otherId => {
                    if (id === otherId) return;
                    const other = lobby.activeEnemies[otherId];
                    if (other.levelId !== levelId) return;
                    const dx = Math.abs(enemy.x - other.x);
                    const dy = Math.abs(enemy.y - other.y);
                    if (dx < 64 && dy < 64) {
                        deadEnemies.push({ id: otherId, reason: 'shell', levelId });
                        // Add score to whoever kicked the shell? (We don't track that easily, but let's assume current player or just team)
                        io.to(`${lobby.id}_${levelId}`).emit('enemyDestroyed', { id: otherId, reason: 'shell', levelId });
                    }
                });
            }

            // Check Player Collisions
            Object.keys(lobby.players).forEach(pId => {
                const player = lobby.players[pId];
                if (player.levelId !== levelId) return;
                const dx = Math.abs(enemy.x - player.x);
                const dy = Math.abs(enemy.y - player.y);

                const playerHalfHeight = (player.state === 0 ? 28 : 56);
                const playerHalfWidth = 24; // Matches client-side 12 * 4 = 48 (24 half-width)
                const enemyHalfSize = 32;

                // Basic AABB Collision
                if (dx < (playerHalfWidth + enemyHalfSize) && dy < (playerHalfHeight + enemyHalfSize)) {
                    if (player.invincible) {
                        deadEnemies.push({ id, reason: 'star', levelId });
                        addPlayerScore(lobby, pId, 100, enemy.x, enemy.y, levelId);
                    } else if (!player.dead) {
                        const footPos = player.y + playerHalfHeight;
                        // If player is falling OR foot is above the enemy's center line
                        if (player.vy >= 0 && footPos < (enemy.y + 10)) {
                            // Stomp Logic
                            if (enemy.type === 'piranha') {
                                // Piranha plants cannot be stomped! Hurt player instead.
                                handlePlayerInjury(lobby, pId, player.x < enemy.x ? -600 : 600);
                            } else if (enemy.type === 'goomba' || enemy.type === 'blockenemy') {
                                deadEnemies.push({ id, reason: 'stomped', levelId });
                                const stompPoints = 100 * (player.stompMultiplier || 1);
                                addPlayerScore(lobby, pId, stompPoints, enemy.x, enemy.y, levelId);
                                player.stompMultiplier = (player.stompMultiplier || 1) * 2;
                                io.to(pId).emit('playerBounce');
                            } else if (enemy.type === 'koopa') {
                                if (enemy.state === 'walking') {
                                    enemy.state = 'shell-still';
                                    enemy.vx = 0;
                                } else if (enemy.state === 'shell-rolling') {
                                    enemy.state = 'shell-still';
                                    enemy.vx = 0;
                                } else if (enemy.state === 'shell-still') {
                                    // Kick it
                                    enemy.state = 'shell-rolling';
                                    enemy.vx = (player.x < enemy.x ? 12 : -12);
                                    enemy.damageCooldown = 200; // 0.2s delay before it can hit mario
                                }
                                io.to(`${lobby.id}_${levelId}`).emit('enemyMoved', enemy);

                                const stompPoints = 100 * (player.stompMultiplier || 1);
                                addPlayerScore(lobby, pId, stompPoints, enemy.x, enemy.y, levelId);
                                player.stompMultiplier = (player.stompMultiplier || 1) * 2;
                                io.to(pId).emit('playerBounce');
                            }
                        } else {
                            // Side Collision Logic
                            if (enemy.type === 'koopa' && enemy.state === 'shell-still') {
                                // Kick it
                                enemy.state = 'shell-rolling';
                                enemy.vx = (player.x < enemy.x ? 12 : -12);
                                enemy.damageCooldown = 200;
                                io.to(`${lobby.id}_${levelId}`).emit('enemyMoved', enemy);
                            } else {
                                // Damage/Knockback player
                                if (!enemy.damageCooldown || enemy.damageCooldown <= 0) {
                                    handlePlayerInjury(lobby, pId, player.x < enemy.x ? -600 : 600);
                                }
                            }
                        }
                    }
                }
            });

            levelUpdates[levelId].enemyUpdates.push({ id, x: enemy.x, y: enemy.y, vx: enemy.vx, state: enemy.state });
        });

        // Check Flag Collisions
        Object.keys(lobby.players).forEach(pId => {
            const p = lobby.players[pId];
            if (p.dead) return;

            const checkPoints = [
                { x: p.x, y: p.y },
                { x: p.x, y: p.y + (p.state === 0 ? 32 : 64) }
            ];
            const hitFlag = checkPoints.some(pt => {
                const tx = Math.floor(pt.x / TILE_SIZE);
                const ty = Math.floor(pt.y / TILE_SIZE);
                return getTileAt(lobby, tx, ty, p.levelId) === TILE.FLAG_POLE;
            });

            if (hitFlag && !lobby.flagHit) {
                lobby.flagHit = true;
                p.finishTimeMs = Date.now() - p.runStartTime;

                // Calculate Flag Score based on height
                const map = getLobbyMap(lobby, p.levelId);
                const groundY = map.height * TILE_SIZE - TILE_SIZE;
                const playerFeetY = p.y + (p.state === 0 ? 32 : 64);
                const heightInTiles = (groundY - playerFeetY) / TILE_SIZE;

                let points = 100;
                if (heightInTiles > 8) points = 5000;
                else if (heightInTiles > 7) points = 2000;
                else if (heightInTiles > 5) points = 800;
                else if (heightInTiles > 3) points = 400;
                else if (heightInTiles > 1) points = 200;

                addPlayerScore(lobby, pId, points, p.x, p.y, p.levelId);

                // Calculate Time Bonus (50 points per second under 2 minutes) - SINGLEPLAYER ONLY
                if (lobby.mode === 'Singleplayer') {
                    const timeBudgetMs = 120000;
                    const timeBonus = Math.max(0, Math.floor((timeBudgetMs - p.finishTimeMs) / 1000) * 50);
                    if (timeBonus > 0) {
                        // Small delay for time bonus popup so it doesn't overlap perfectly with flag points
                        setTimeout(() => {
                            addPlayerScore(lobby, pId, timeBonus, p.x, p.y - 64, p.levelId);
                        }, 500);
                    }
                }

                io.to(pId).emit('playFlagAnimation', { x: p.x, y: p.y });
            }
        });

        // Check Fall Death
        Object.keys(lobby.players).forEach(pId => {
            const p = lobby.players[pId];
            if (!p.dead && p.y > (getLobbyMap(lobby, p.levelId).height * TILE_SIZE)) {
                PlayerDie(lobby, pId);
            }
        });

        // Player-to-Player Interaction (PvP / Chaos)
        if (lobby.mode === 'PvP' || lobby.mode === 'Chaos') {
            const playerIds = Object.keys(lobby.players);
            for (let i = 0; i < playerIds.length; i++) {
                for (let j = i + 1; j < playerIds.length; j++) {
                    const idA = playerIds[i];
                    const idB = playerIds[j];
                    const pA = lobby.players[idA];
                    const pB = lobby.players[idB];

                    if (pA.dead || pB.dead || pA.levelId !== pB.levelId) continue;

                    const dx = Math.abs(pA.x - pB.x);
                    const dy = Math.abs(pA.y - pB.y);

                    // AABB Collision check between players
                    const halfWidth = 24;
                    const halfHeightA = (pA.state === 0 ? 28 : 56);
                    const halfHeightB = (pB.state === 0 ? 28 : 56);

                    if (dx < halfWidth * 2 && dy < (halfHeightA + halfHeightB)) {
                        // 1. Star Power Check
                        if (pA.invincible && !pB.invincible) {
                            handlePlayerInjury(lobby, idB, pB.x < pA.x ? -800 : 800);
                        } else if (pB.invincible && !pA.invincible) {
                            handlePlayerInjury(lobby, idA, pA.x < pB.x ? -800 : 800);
                        }
                        // 2. Stomping Check
                        else {
                            const footA = pA.y + halfHeightA;
                            const footB = pB.y + halfHeightB;

                            // If A is falling and hits B's head
                            if (pA.vy > 0 && footA < (pB.y + 10)) {
                                handlePlayerInjury(lobby, idB, pB.x < pA.x ? -400 : 400);
                                io.to(idA).emit('playerBounce');
                            }
                            // If B is falling and hits A's head
                            else if (pB.vy > 0 && footB < (pA.y + 10)) {
                                handlePlayerInjury(lobby, idA, pA.x < pB.x ? -400 : 400);
                                io.to(idB).emit('playerBounce');
                            }
                        }
                    }
                }
            }
        } else {
            // Original Star Power logic for Co-op (just push/hurt with star)
            Object.keys(lobby.players).forEach(idA => {
                const playerA = lobby.players[idA];
                if (!playerA.invincible || playerA.dead) return;

                Object.keys(lobby.players).forEach(idB => {
                    if (idA === idB) return;
                    const playerB = lobby.players[idB];
                    if (playerB.dead) return;

                    const dx = playerA.x - playerB.x;
                    const dy = playerA.y - playerB.y;
                    const distSq = dx * dx + dy * dy;

                    if (distSq < 64 * 64) {
                        if (playerB.invincible) return;
                        handlePlayerInjury(lobby, idB, playerB.x < playerA.x ? -800 : 800);
                    }
                });
            });
        }

        // Update Timers (Star Power and Invulnerability)
        Object.keys(lobby.players).forEach(id => {
            const p = lobby.players[id];
            if (p.starPowerTimer > 0) {
                p.starPowerTimer -= 33;
                if (p.starPowerTimer <= 0) {
                    p.invincible = false;
                    p.starPowerTimer = 0;
                    io.to(lobby.id).emit('playerMoved', p);
                }
            }
            if (p.invulnTimer > 0) {
                p.invulnTimer -= 33;
                if (p.invulnTimer <= 0) {
                    p.invulnTimer = 0;
                    io.to(lobby.id).emit('playerMoved', p);
                }
            }
        });

        deadEnemies.forEach(death => {
            delete lobby.activeEnemies[death.id];
            io.to(`${lobby.id}_${death.levelId}`).emit('enemyDestroyed', death);
        });

        // Broadcast level-specific updates
        Object.keys(levelUpdates).forEach(levelId => {
            const updates = levelUpdates[levelId];
            const room = `${lobby.id}_${levelId}`;
            if (updates.itemUpdates.length > 0) io.to(room).emit('itemUpdates', updates.itemUpdates);
            if (updates.enemyUpdates.length > 0) io.to(room).emit('enemyUpdates', updates.enemyUpdates);
            if (updates.fireballUpdates.length > 0) io.to(room).emit('fireballUpdates', updates.fireballUpdates);
        });
    });
}, 33); // ~30 FPS

function addPlayerScore(lobby, pId, points, x, y, levelId) {
    if (lobby.players[pId]) {
        // Always track individual score
        lobby.players[pId].score = (lobby.players[pId].score || 0) + points;

        if (lobby.mode === 'Co-op' || lobby.mode === 'Singleplayer') {
            lobby.totalScore = (lobby.totalScore || 0) + points;
            io.to(lobby.id).emit('totalScoreUpdate', lobby.totalScore);
        } else {
            // In PvP/Chaos, we broadcast individual score updates via playerMoved
            io.to(lobby.id).emit('playerMoved', lobby.players[pId]);
        }

        if (x !== undefined && y !== undefined) {
            io.to(`${lobby.id}_${levelId || lobby.players[pId].levelId}`).emit('scoreGained', { x, y, points });
        }
    }
}

function handlePlayerInjury(lobby, pId, knockbackVX) {
    const player = lobby.players[pId];
    if (!player || player.dead || player.invincible || player.invulnTimer > 0) return;

    if (player.state > 0) {
        // Shrink
        player.state -= 1;
        player.y += 32; // Move center down when shrinking to keep feet grounded
        player.invulnTimer = 2000; // 2 seconds of flicker/invuln
        io.to(pId).emit('playerKnockback', {
            vx: knockbackVX,
            vy: -800
        });
        io.to(`${lobby.id}_${player.levelId}`).emit('playerMoved', player); // Broadcast state change
    } else {
        // Die
        PlayerDie(lobby, pId);
    }
}

function PlayerDie(lobby, pId) {
    const p = lobby.players[pId];
    if (!p || p.dead) return;

    p.dead = true;
    p.anim = 'die';
    p.vy = -1000; // Small hop up
    io.to(`${lobby.id}_${p.levelId}`).emit('playerMoved', p);

    if (lobby.mode === 'Singleplayer') {
        if (lobby.levelIsRestarting) return;
        lobby.levelIsRestarting = true;
        
        if (lobby.restartTimeout) clearTimeout(lobby.restartTimeout);
        lobby.restartTimeout = setTimeout(() => {
            lobby.restartTimeout = null;
            RestartLevel(lobby);
        }, 3000); // Set to 3s to match animation/sound
    } else {
        // Check if all active players are dead
        const activePlayers = Object.values(lobby.players).filter(p => p.levelId);
        const allDead = activePlayers.length > 0 && activePlayers.every(player => player.dead);

        console.log(`[Death Check] Lobby: ${lobby.id}, Active: ${activePlayers.length}, AllDead: ${allDead}`);
        activePlayers.forEach(ap => console.log(`  - Player ${ap.username || ap.id}: dead=${ap.dead}`));

        if (allDead) {
            if (lobby.levelIsRestarting) return;
            lobby.levelIsRestarting = true;
            
            if (lobby.restartTimeout) clearTimeout(lobby.restartTimeout);
            lobby.restartTimeout = setTimeout(() => {
                lobby.restartTimeout = null;
            console.log(`[Game Over] Triggering EndLevel for lobby ${lobby.id}`);
            EndLevel(lobby);
        }, 3000); // Set to 3s to match animation/sound
    }
}
}

function isSolid(lobby, x, y, levelId) {
    const tile = getTileAt(lobby, x, y, levelId);
    return tile !== -1;
}

function getTileAt(lobby, x, y, levelId) {
    const map = getLobbyMap(lobby, levelId);
    if (x < 0 || x >= map.width || y < 0 || y >= map.height) return -1;
    return map.data[y][x];
}

function getLobbyMap(lobby, levelId) {
    if (!lobby.builtMaps[levelId]) {
        lobby.builtMaps[levelId] = buildLevel(levelId);
        applyChaosRandomization(lobby, levelId);
    }
    return lobby.builtMaps[levelId];
}


async function WarpPlayer(lobby, pId, warpInfo) {
    if (lobby.levelIsRestarting) return;

    const targetLevel = warpInfo.target;
    const socket = io.sockets.sockets.get(pId);
    const oldLevelId = lobby.players[pId].levelId;

    if (lobby.mode === 'Co-op' || lobby.mode === 'Singleplayer') {
        console.log(`Warping lobby ${lobby.id} to ${targetLevel} (Co-op)`);
        if (targetLevel !== 'underground') {
            lobby.currentLevel = targetLevel;
        }

        // Clear all level items and enemies
        Object.keys(lobby.activeItems).forEach(id => delete lobby.activeItems[id]);
        Object.keys(lobby.activeEnemies).forEach(id => delete lobby.activeEnemies[id]);
        io.to(lobby.id).emit('initItems', {});
        io.to(lobby.id).emit('initEnemies', {});

        const playerIds = Object.keys(lobby.players);
        const numPlayers = playerIds.length;
        const spacing = 64;
        const totalWidth = (numPlayers - 1) * spacing;
        const startX = warpInfo.x - (totalWidth / 2);

        // Move all players and update their room
        playerIds.forEach(async (id, index) => {
            const p = lobby.players[id];
            const pSocket = io.sockets.sockets.get(id);
            const oldLevelId = p.levelId;

            // --- RESET STATE IMMEDIATELY (Synchronously) ---
            p.levelId = targetLevel;
            p.x = startX + (index * spacing);
            p.y = warpInfo.y;
            p.vy = 0;

            if (pSocket) {
                pSocket.leave(`${lobby.id}_${oldLevelId}`);
                pSocket.join(`${lobby.id}_${targetLevel}`);

                // Send individual initMap with unique X position
                pSocket.emit('initMap', {
                    ...getLobbyMap(lobby, targetLevel),
                    warps: MAPS[targetLevel].warps,
                    spawnType: warpInfo.spawnType,
                    spawnX: p.x,
                    spawnY: p.y,
                    isWarp: true
                });

                // Send personal best for the new level (only if it's a main level)
                if (targetLevel !== 'underground') {
                    const pb = await HighScore.findOne({
                        where: { playerName: p.username || 'Guest', levelId: targetLevel },
                        order: [['timeMs', 'ASC']]
                    });
                    pSocket.emit('personalBest', pb ? pb.timeMs : null);
                }
            }

            io.to(`${lobby.id}_${targetLevel}`).emit('playerMoved', p);
        });

        // Spawn new enemies and items for everyone
        spawnLevelEnemies(lobby, targetLevel);
        getItemSpawns(targetLevel).forEach(spawn => spawnItem(lobby, spawn.x, spawn.y, spawn.type, targetLevel));
        lobby.spawnedLevels.add(targetLevel);
    } else {
        // PvP / Chaos: Individual Warp
        console.log(`Warping player ${pId} to ${targetLevel} (Individual)`);
        const p = lobby.players[pId];

        if (socket) {
            socket.leave(`${lobby.id}_${oldLevelId}`);
            socket.join(`${lobby.id}_${targetLevel}`);
        }
        p.levelId = targetLevel;
        p.x = warpInfo.x;
        p.y = warpInfo.y;
        p.vy = 0;

        // Send init sequence ONLY to the warping player
        socket.emit('initMap', {
            ...getLobbyMap(lobby, targetLevel),
            warps: MAPS[targetLevel].warps,
            spawnType: warpInfo.spawnType,
            spawnX: warpInfo.x,
            spawnY: warpInfo.y,
            isWarp: true
        });

        // Send personal best for the new level
        if (targetLevel !== 'underground') {
            const pb = await HighScore.findOne({
                where: { playerName: p.username || 'Guest', levelId: targetLevel },
                order: [['timeMs', 'ASC']]
            });
            socket.emit('personalBest', pb ? pb.timeMs : null);
        }

        // Filter items/enemies for the new level
        const levelItems = {};
        Object.keys(lobby.activeItems).forEach(id => {
            if (lobby.activeItems[id].levelId === targetLevel) levelItems[id] = lobby.activeItems[id];
        });
        const levelEnemies = {};
        Object.keys(lobby.activeEnemies).forEach(id => {
            if (lobby.activeEnemies[id].levelId === targetLevel) levelEnemies[id] = lobby.activeEnemies[id];
        });

        socket.emit('initItems', levelItems);
        socket.emit('initEnemies', levelEnemies);

        // Spawn enemies and items if this level hasn't been visited in this lobby yet
        if (!lobby.spawnedLevels.has(targetLevel)) {
            spawnLevelEnemies(lobby, targetLevel);
            getItemSpawns(targetLevel).forEach(spawn => spawnItem(lobby, spawn.x, spawn.y, spawn.type, targetLevel));
            lobby.spawnedLevels.add(targetLevel);
        }

        io.to(`${lobby.id}_${targetLevel}`).emit('playerMoved', p);
        io.to(`${lobby.id}_${oldLevelId}`).emit('playerDisconnected', pId); // Make them "disappear" from old level
    }
}

function EndLevel(lobby) {
    console.log(`[EndLevel] Started for lobby ${lobby.id}`);
    lobby.levelIsRestarting = true;

    // Immediately teleport all players back to spawn (alive and idling) for the results screen
    const levelId = lobby.currentLevel || 'world-1-1';
    const spawnPos = MAPS[levelId].spawn || { x: 150, y: 700 };
    const playerIds = Object.keys(lobby.players);
    const spacing = 64;
    const totalWidth = (playerIds.length - 1) * spacing;
    const startX = spawnPos.x - (totalWidth / 2);

    playerIds.forEach((id, index) => {
        const p = lobby.players[id];
        if (p) {
            p.x = startX + (index * spacing);
            p.y = spawnPos.y;
            p.dead = false;
            p.anim = 'idle';
            p.state = 0; // Reset to small for results screen and next level
            p.vx = 0;
            p.vy = 0;
            io.to(`${lobby.id}_${p.levelId}`).emit('playerMoved', p);
        }
    });

    console.log(`Level Finished in lobby ${lobby.id}! Restarting in 6s...`);
    io.to(lobby.id).emit('levelFinished');

    // Calculate times and check for new best
    const now = Date.now();
    const savePromises = Object.keys(lobby.players).map(async (pId) => {
        const p = lobby.players[pId];
        if (p && p.runStartTime && !p.dead) {
            const elapsed = p.finishTimeMs || (now - p.runStartTime);
            try {
                // Get personal bests to check if this run is a new best
                const existingBest = await HighScore.findOne({
                    where: {
                        playerName: p.username || 'Guest',
                        levelId: lobby.currentLevel || 'world-1-1'
                    },
                    attributes: [
                        [sequelize.fn('MIN', sequelize.col('timeMs')), 'bestTime'],
                        [sequelize.fn('MAX', sequelize.col('score')), 'bestScore']
                    ],
                    raw: true
                });

                const isNewTimeBest = !existingBest || !existingBest.bestTime || elapsed < existingBest.bestTime;
                const isNewScoreBest = !existingBest || !existingBest.bestScore || (p.score || 0) > existingBest.bestScore;

                if (isNewTimeBest || isNewScoreBest) {
                    await HighScore.create({
                        timeMs: elapsed,
                        score: p.score || 0,
                        playerName: p.username || 'Guest',
                        levelId: lobby.currentLevel || 'world-1-1'
                    });
                    console.log(`[Score] Saved new best for ${p.username || 'Guest'}: Time=${elapsed}ms, Score=${p.score || 0}`);
                } else {
                    console.log(`[Score] Run for ${p.username || 'Guest'} not a personal best. Not saved.`);
                }

                // Send back the absolute personal best time for the UI
                const finalBest = await HighScore.findOne({
                    where: {
                        playerName: p.username || 'Guest',
                        levelId: lobby.currentLevel || 'world-1-1'
                    },
                    order: [['timeMs', 'ASC']]
                });

                if (finalBest) {
                    io.to(pId).emit('personalBest', finalBest.timeMs);
                }
            } catch (err) {
                console.error('Error saving high score:', err);
            }
        }
    });

    // Wait for all saves to finish (Write-Back synchronization)
    Promise.all(savePromises).then(() => {
        console.log(`[EndLevel] All scores persisted for lobby ${lobby.id}`);
        refreshAllLeaderboards(); // Update cache once after all saves
    });


    const shouldShowResults = (lobby.mode !== 'Singleplayer' && lobby.mode !== 'Speedrun');

    if (shouldShowResults) {
        // Prepare results
        const results = Object.values(lobby.players).map(p => ({
            id: p.id,
            username: p.username || 'Guest',
            score: p.score || 0,
            timeMs: p.runStartTime ? (now - p.runStartTime) : 0,
            dead: !!p.dead
        }));

        let winner = null;
        if (lobby.mode === 'PvP' && results.length > 0) {
            winner = results.reduce((prev, curr) => (curr.score > prev.score && !curr.dead) ? curr : prev, results[0]);
            
            // Record PvP Win
            if (winner && winner.username !== 'Guest') {
                PvPWin.findOne({ where: { playerName: winner.username } }).then(record => {
                    if (record) {
                        record.increment('wins');
                    } else {
                        PvPWin.create({ playerName: winner.username, wins: 1 });
                    }
                });
            }
        }

        console.log(`[EndLevel] Emitting matchResults to ${results.length} players`);
        Object.keys(lobby.players).forEach(pId => {
            io.to(pId).emit('matchResults', {
                results,
                mode: lobby.mode,
                winner: winner ? winner.username : null,
                totalScore: lobby.totalScore || 0
            });
        });
        lobby.readyPlayers = {}; // Reset ready status
    } else {
        setTimeout(() => {
            if (lobby.mode === 'Singleplayer') {
                if (lobby.currentLevel === 'world-1-1') {
                    lobby.currentLevel = 'world-1-2';
                } else if (lobby.currentLevel === 'world-1-2') {
                    lobby.currentLevel = 'world-1-3';
                } else if (lobby.currentLevel === 'world-1-3') {
                    lobby.currentLevel = 'world-2-1';
                } else if (lobby.currentLevel === 'world-2-1') {
                    // Emit win event instead of immediate restart
                    io.to(lobby.id).emit('gameWon');
                    lobby.levelIsRestarting = false;

                    // Close the lobby automatically after win screen shows
                    setTimeout(() => {
                        closeLobby(lobby.id, false); // Don't notify with alert, just cleanup
                    }, 1000);
                    return; // Stop the timeout
                }
            } else if (lobby.mode === 'Speedrun') {
                // Keep the same level for speedrun attempts
                console.log(`[Speedrun] Restarting level ${lobby.currentLevel}`);
            }
            RestartLevel(lobby);
        }, 6000); // Set to 6s to match victory music duration
    }
}

function RestartLevel(lobby) {
    const levelId = lobby.currentLevel || 'world-1-1';

    // 1. Rebuild map to reset broken blocks/collected coins
    lobby.builtMaps[levelId] = buildLevel(levelId);
    applyChaosRandomization(lobby, levelId);
    const map = lobby.builtMaps[levelId];

    const spawnPos = MAPS[levelId].spawn || { x: 150, y: 700 };
    const spawnType = spawnPos.spawnType || 'none';

    // 2. RESET PLAYERS & MOVE TO ROOM FIRST
    const playerIds = Object.keys(lobby.players);
    const numPlayers = playerIds.length;
    const spacing = 128; // Increased from 64
    const totalWidth = (numPlayers - 1) * spacing;
    const startX = spawnPos.x - (totalWidth / 2);

    playerIds.forEach(async (id, index) => {
        const p = lobby.players[id];
        const socket = io.sockets.sockets.get(id);
        const oldLevelId = p.levelId;
        
        // Singleplayer mode should never pad the spawn point, even if multiple IDs somehow exist
        const isActuallyMulti = lobby.mode !== 'Singleplayer' && numPlayers > 1;
        const spawnX = isActuallyMulti ? (startX + (index * spacing)) : spawnPos.x;

        // --- RESET STATE IMMEDIATELY (Synchronously) ---
        p.levelId = levelId;
        p.x = spawnX;
        p.y = spawnPos.y;
        p.vx = 0;
        p.vy = 0;
        p.state = 0; // Back to small
        p.dead = false;
        p.anim = 'idle';
        p.invulnTimer = 0;
        p.invincible = false;
        p.starPowerTimer = 0;
        p.runStartTime = Date.now();
        p.stompMultiplier = 1;
        p.score = 0;
        p.finishTimeMs = null;

        // Regenerate skin if using random/chaos
        if (p.skin === 'random' || p.skin === 'chaos') {
            p.skinData = generateRandomSkinData(p.skin === 'chaos');
        }

        if (socket) {
            socket.leave(`${lobby.id}_${oldLevelId}`);
            socket.join(`${lobby.id}_${levelId}`);

            // Send individual map init with offset X
            socket.emit('initMap', {
                ...map,
                warps: MAPS[levelId].warps,
                spawnType,
                spawnX: spawnX,
                spawnY: spawnPos.y,
                skinData: p.skinData
            });

            // Send personal best for the new level
            const pb = await HighScore.findOne({
                where: {
                    playerName: p.username || 'Guest',
                    levelId: levelId
                },
                order: [['timeMs', 'ASC']]
            });
            socket.emit('personalBest', pb ? pb.timeMs : null);
        }
    });

    lobby.totalScore = 0;
    io.to(lobby.id).emit('totalScoreUpdate', 0);

    if (lobby.restartTimeout) {
        clearTimeout(lobby.restartTimeout);
        lobby.restartTimeout = null;
    }

    setTimeout(() => {
        lobby.levelIsRestarting = false;
    }, 100); // Reduced to 100ms grace period
    lobby.flagHit = false; // Reset flag hit state

    // 4. RESET ENTITIES (initMap is now sent individually above)

    // 4. RESET ENTITIES
    Object.keys(lobby.activeItems).forEach(id => delete lobby.activeItems[id]);
    Object.keys(lobby.activeFireballs).forEach(id => delete lobby.activeFireballs[id]);
    io.to(lobby.id).emit('initItems', {});

    Object.keys(lobby.activeEnemies).forEach(id => delete lobby.activeEnemies[id]);
    spawnLevelEnemies(lobby, levelId);

    getItemSpawns(levelId).forEach(spawn => spawnItem(lobby, spawn.x, spawn.y, spawn.type, levelId));

    lobby.spawnedLevels = new Set([levelId]);

    // 5. BROADCAST PLAYER POSITIONS (Now that everyone is in the room)
    Object.keys(lobby.players).forEach(id => {
        io.to(`${lobby.id}_${levelId}`).emit('playerMoved', lobby.players[id]);
    });
}

function generateRandomSkinData(fullRandom = false) {
    const baseSkins = ['mario', 'luigi', 'jacob', 'sean'];
    return {
        baseSkin: fullRandom ? baseSkins[Math.floor(Math.random() * baseSkins.length)] : 'mario',
        color1: { r: Math.floor(Math.random() * 256), g: Math.floor(Math.random() * 256), b: Math.floor(Math.random() * 256) },
        color2: { r: Math.floor(Math.random() * 256), g: Math.floor(Math.random() * 256), b: Math.floor(Math.random() * 256) }
    };
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('registerUsername', (data) => {
        const username = typeof data === 'string' ? data : data.username;
        const skin = typeof data === 'object' ? data.skin : null;
        const skinData = typeof data === 'object' ? data.skinData : null;

        socket.username = username;
        if (skin) {
            socket.skin = skin;
            if (skinData) {
                socket.skinData = skinData;
            } else if (skin === 'random' || skin === 'chaos') {
                socket.skinData = generateRandomSkinData(skin === 'chaos');
            }
        }

        console.log(`Socket ${socket.id} registered as ${username}${skin ? ` with skin ${skin}` : ''}`);
    });



    // Send available lobbies on connection
    socket.emit('lobbyList', Object.values(lobbies).map(l => ({
        id: l.id,
        name: l.name,
        mode: l.mode,
        status: l.status,
        playerCount: Object.keys(l.players).length,
        maxPlayers: l.maxPlayers
    })));

    socket.on('createLobby', (data) => {
        const { name, mode, username, map } = data;
        if (username) socket.username = username;
        const id = `lobby_${Math.random().toString(36).substr(2, 9)}`;
        const lobby = createLobby(id, name, mode, socket.id);

        if (map) {
            lobby.currentLevel = map;
            lobby.builtMaps[map] = buildLevel(map);
            applyChaosRandomization(lobby, map);
        }

        lobbies[id] = lobby;
        socket.emit('lobbyCreated', id);
        broadcastLobbyList();
    });

    socket.on('joinLobby', (data) => {
        const lobbyId = typeof data === 'string' ? data : data.lobbyId;
        const username = typeof data === 'string' ? null : data.username;
        if (username) socket.username = username;

        const lobby = lobbies[lobbyId];
        if (!lobby) return;

        // Auto-resume if someone joins a paused lobby
        lobby.isPaused = false;

        if (Object.keys(lobby.players).length >= lobby.maxPlayers) {
            socket.emit('joinError', 'Lobby is full');
            return;
        }

        if (lobby.status === 'playing') {
            socket.emit('joinError', 'Match already in progress');
            return;
        }

        socket.join(lobbyId);
        socket.lobbyId = lobbyId;

        lobby.players[socket.id] = {
            x: 150, y: 700, id: socket.id,
            username: socket.username || 'Guest',
            anim: 'idle', flipX: false,
            state: 0, vy: 0, invincible: false, starPowerTimer: 0,
            invulnTimer: 0, dead: false, runStartTime: Date.now(),
            levelId: lobby.currentLevel,
            score: 0,
            stompMultiplier: 1,
            score: 0,
            stompMultiplier: 1,
            skin: data.skin || 'mario',
            skinData: data.skinData || socket.skinData || ((data.skin === 'random' || data.skin === 'chaos') ? generateRandomSkinData(data.skin === 'chaos') : null)
        };

        // Notify lobby members
        io.to(lobbyId).emit('lobbyUpdate', {
            id: lobby.id,
            name: lobby.name,
            mode: lobby.mode,
            host: lobby.host,
            maxPlayers: lobby.maxPlayers,
            status: lobby.status,
            players: lobby.players,
            currentLevel: lobby.currentLevel
        });

        broadcastLobbyList();
    });

    socket.on('updateLobbySettings', (data) => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby || lobby.host !== socket.id) return;

        const { name, mode, maxPlayers, map } = data;
        if (name) lobby.name = name;
        if (mode) lobby.mode = mode;
        if (maxPlayers) lobby.maxPlayers = parseInt(maxPlayers);
        if (map) lobby.currentLevel = map;

        io.to(lobby.id).emit('lobbyUpdate', {
            id: lobby.id,
            name: lobby.name,
            mode: lobby.mode,
            host: lobby.host,
            maxPlayers: lobby.maxPlayers,
            status: lobby.status,
            players: lobby.players,
            currentLevel: lobby.currentLevel
        });
        broadcastLobbyList();
    });

    socket.on('kickPlayer', (targetId) => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby || lobby.host !== socket.id) return;

        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.emit('kicked');
            targetSocket.leave(lobby.id);
            delete lobby.players[targetId];

            io.to(lobby.id).emit('lobbyUpdate', {
                id: lobby.id,
                name: lobby.name,
                mode: lobby.mode,
                host: lobby.host,
                maxPlayers: lobby.maxPlayers,
                status: lobby.status,
                players: lobby.players,
                currentLevel: lobby.currentLevel
            });
            broadcastLobbyList();
        }
    });

    socket.on('startMatch', () => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby || lobby.host !== socket.id) return;

        lobby.status = 'playing';

        // Initial Enemy Spawn for lobby
        if (lobby.spawnedLevels.size === 0 || !lobby.spawnedLevels.has(lobby.currentLevel)) {
            spawnLevelEnemies(lobby, lobby.currentLevel);
            lobby.spawnedLevels.add(lobby.currentLevel);
        }

        io.to(lobby.id).emit('matchStarted');

        // Send init data to all players
        const playerIds = Object.keys(lobby.players);
        const numPlayers = playerIds.length;
        const spacing = 128; // Increased from 64
        const spawnPos = MAPS[lobby.currentLevel].spawn || { x: 150, y: 700 };
        const totalWidth = (numPlayers - 1) * spacing;
        const startX = spawnPos.x - (totalWidth / 2);

        playerIds.forEach(async (pId, index) => {
            const pSocket = io.sockets.sockets.get(pId);
            const spawnX = startX + (index * spacing);
            if (!pSocket) return;

            pSocket.join(`${lobby.id}_${lobby.currentLevel}`);

            // Sync server-side player state for the new map
            const p = lobby.players[pId];
            if (p) {
                p.levelId = lobby.currentLevel;
                p.x = spawnX;
                p.y = spawnPos.y;
                p.vy = 0;
                p.state = 0; // Start small
                p.dead = false;
                p.score = 0;
                p.runStartTime = Date.now();
                p.finishTimeMs = null;
            }

            pSocket.emit('initMap', {
                ...getLobbyMap(lobby, lobby.currentLevel),
                warps: MAPS[lobby.currentLevel].warps,
                spawnType: spawnPos.spawnType || 'none',
                spawnX: spawnX,
                spawnY: spawnPos.y
            });
            pSocket.emit('currentPlayers', lobby.players);

            // Send level-specific entities
            const levelItems = {};
            Object.keys(lobby.activeItems).forEach(id => {
                if (lobby.activeItems[id].levelId === lobby.currentLevel) levelItems[id] = lobby.activeItems[id];
            });
            const levelEnemies = {};
            Object.keys(lobby.activeEnemies).forEach(id => {
                if (lobby.activeEnemies[id].levelId === lobby.currentLevel) levelEnemies[id] = lobby.activeEnemies[id];
            });

            pSocket.emit('initItems', levelItems);
            pSocket.emit('initEnemies', levelEnemies);

            // Send personal best on join
            if (p) {
                const pb = await HighScore.findOne({
                    where: {
                        playerName: p.username || 'Guest',
                        levelId: lobby.currentLevel || 'world-1-1'
                    },
                    order: [['timeMs', 'ASC']]
                });
                pSocket.emit('personalBest', pb ? pb.timeMs : null);
            }
        });

        broadcastLobbyList();
    });

    socket.on('killLobby', () => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby || lobby.host !== socket.id) return;

        closeLobby(lobby.id, true);
    });

    socket.on('leaveLobby', () => {
        handleDisconnect(socket);
    });

    socket.on('getLeaderboard', async (query = {}) => {
        const { levelId = 'world-1-1', type = 'time' } = query;
        const cacheKey = `${levelId}_${type}`;

        try {
            const now = Date.now();
            const scores = leaderboardCaches[cacheKey] || [];
            const nextUpdateInMs = CACHE_TTL - (now - lastGlobalRefresh);

            socket.emit('leaderboardData', {
                scores,
                nextUpdateInMs: Math.max(0, nextUpdateInMs),
                levelId,
                type
            });
        } catch (err) {
            console.error('Error fetching leaderboard:', err);
        }
    });

    socket.on('playerMovement', (movementData) => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        const p = lobby.players[socket.id];
        if (p && !p.dead && !lobby.levelIsRestarting) {
            p.vy = movementData.y - p.y;
            p.x = movementData.x;
            p.y = movementData.y;
            p.anim = movementData.anim;
            p.flipX = movementData.flipX;
            if (movementData.skin) p.skin = movementData.skin;
            if (movementData.skinData) {
                p.skinData = movementData.skinData;
                socket.skinData = movementData.skinData;
            }

            // Reset stomp multiplier if on ground
            const footX = Math.floor(p.x / TILE_SIZE);
            const footOffset = (p.state === 0) ? 32 : 64;
            const footY = Math.floor((p.y + footOffset + 2) / TILE_SIZE);
            if (isSolid(lobby, footX, footY, p.levelId)) {
                p.stompMultiplier = 1;
            }

            socket.to(`${socket.lobbyId}_${p.levelId}`).emit('playerMoved', p);
        }
    });

    socket.on('blockHit', (data) => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        const { x, y } = data;
        const p = lobby.players[socket.id];
        if (!p) return;
        const map = getLobbyMap(lobby, p.levelId);

        if (y >= 0 && y < map.data.length && x >= 0 && x < map.data[0].length) {
            const tileIndex = map.data[y][x];

            if (tileIndex === TILE.BRICK || tileIndex === TILE.QUESTION) {
                let newTileIndex = tileIndex;

                if (tileIndex === TILE.BRICK) {
                    // Break brick if Big (1), Fire (2), or Star Mode (invincible)
                    if (p.state >= 1 || p.invincible) {
                        newTileIndex = TILE.EMPTY;
                        map.data[y][x] = newTileIndex;
                        // Add 50 points for breaking a brick
                        addPlayerScore(lobby, socket.id, 50, x * TILE_SIZE + 32, y * TILE_SIZE - 32, p.levelId);
                    }
                } else if (tileIndex === TILE.QUESTION) {
                    newTileIndex = TILE.HIT_QUESTION;
                    map.data[y][x] = newTileIndex;

                    // Spawn Item
                    let itemType = ITEM_TYPES.NONE;
                    if (lobby.mode === 'Chaos') {
                        itemType = (lobby.chaosBlockContents[p.levelId] && lobby.chaosBlockContents[p.levelId][`${x},${y}`]) || ITEM_TYPES.COIN;
                    } else {
                        itemType = getBlockContent(x, y, p.levelId, p.state);
                    }

                    if (itemType !== ITEM_TYPES.NONE) {
                        spawnItem(lobby, x * TILE_SIZE + 32, y * TILE_SIZE - 32, itemType, p.levelId);
                        if (itemType === ITEM_TYPES.COIN) {
                            addPlayerScore(lobby, socket.id, 100, x * TILE_SIZE + 32, y * TILE_SIZE - 32, p.levelId);
                        }
                    }

                    // Chaos Mode: Spawn a blockenemy too!
                    if (lobby.mode === 'Chaos') {
                        spawnEnemy(lobby, x * TILE_SIZE + 32, y * TILE_SIZE - 32, 'blockenemy', p.levelId, getRandomChaosFrame());
                    }
                }

                // Chaos Mode: Even bricks spawn enemies in Chaos mode!
                if (lobby.mode === 'Chaos' && tileIndex === TILE.BRICK) {
                    spawnEnemy(lobby, x * TILE_SIZE + 32, y * TILE_SIZE - 32, 'blockenemy', p.levelId, getRandomChaosFrame());
                }

                io.to(`${socket.lobbyId}_${p.levelId}`).emit('tileUpdate', { x, y, oldTile: tileIndex, newTile: newTileIndex });

                // Check if any items are on top of this block to make them bounce
                Object.values(lobby.activeItems).forEach(item => {
                    if (item.levelId !== p.levelId) return;
                    if (item.type === ITEM_TYPES.MUSHROOM || item.type === ITEM_TYPES.STAR) {
                        const itemTileX = Math.floor(item.x / TILE_SIZE);
                        const itemTileY = Math.floor((item.y + 16) / TILE_SIZE);
                        if (itemTileX === x && itemTileY === y) {
                            item.vy = -10; // Bounce up
                        }
                    }
                });

                // Check if any enemies are on top of this block to kill them
                Object.keys(lobby.activeEnemies).forEach(enemyId => {
                    const enemy = lobby.activeEnemies[enemyId];
                    if (enemy.levelId !== p.levelId) return;

                    const enemyTileX = Math.floor(enemy.x / TILE_SIZE);
                    const enemyTileY = Math.floor((enemy.y + 32 + 2) / TILE_SIZE); // Bottom of enemy

                    if (enemyTileX === x && enemyTileY === y) {
                        // Kill enemy
                        io.to(`${lobby.id}_${p.levelId}`).emit('enemyDestroyed', { id: enemyId, reason: 'blockHit', levelId: p.levelId });
                        addPlayerScore(lobby, socket.id, 100, enemy.x, enemy.y, p.levelId);
                        delete lobby.activeEnemies[enemyId];
                    }
                });

                // Check if any players are on top of this block to make them bounce
                Object.keys(lobby.players).forEach(id => {
                    const otherP = lobby.players[id];
                    if (otherP.levelId !== p.levelId) return;
                    const footOffset = (otherP.state === 0) ? 32 : 64;
                    const pTileX = Math.floor(otherP.x / TILE_SIZE);
                    const pTileY = Math.floor((otherP.y + footOffset + 2) / TILE_SIZE);

                    if (pTileX === x && pTileY === y) {
                        io.to(id).emit('playerBounce');
                    }
                });
            }
        }
    });

    socket.on('collectItem', (itemId) => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        if (lobby.activeItems[itemId]) {
            const item = lobby.activeItems[itemId];
            const itemType = item.type;

            // Power-up logic
            if (itemType === ITEM_TYPES.MUSHROOM) {
                if (lobby.players[socket.id].state === 0) {
                    lobby.players[socket.id].state = 1;
                    lobby.players[socket.id].y -= 32;
                }
            } else if (itemType === ITEM_TYPES.FIRE_FLOWER) {
                if (lobby.players[socket.id].state === 0) {
                    lobby.players[socket.id].y -= 32;
                }
                lobby.players[socket.id].state = 2;
            } else if (itemType === ITEM_TYPES.STAR) {
                lobby.players[socket.id].invincible = true;
                lobby.players[socket.id].starPowerTimer = 7000;
            }

            addPlayerScore(lobby, socket.id, 100, item.x, item.y, item.levelId);

            delete lobby.activeItems[itemId];
            io.to(`${socket.lobbyId}_${item.levelId}`).emit('itemDestroyed', {
                itemId,
                collectorId: socket.id,
                itemType,
                newState: lobby.players[socket.id].state,
                invincible: lobby.players[socket.id].invincible
            });
        }
    });

    socket.on('shootFireball', () => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        const p = lobby.players[socket.id];
        if (!p || p.state !== 2) return;

        const now = Date.now();
        const lastShoot = shootingCooldowns[socket.id] || 0;
        if (now - lastShoot < 400) return;

        shootingCooldowns[socket.id] = now;

        const id = `fireball_${lobby.fireballIdCounter++}`;
        const direction = p.flipX ? -1 : 1;
        const speed = (lobby.mode === 'Chaos') ? 30 : 20;
        const fireball = {
            id,
            x: p.x + (direction * 20),
            y: p.y,
            vx: direction * speed,
            vy: 0,
            ownerId: socket.id,
            bounces: 0,
            life: 3000,
            lastX: p.x + (direction * 20),
            stuckFrames: 0,
            levelId: p.levelId
        };

        lobby.activeFireballs[id] = fireball;
        io.to(`${socket.lobbyId}_${p.levelId}`).emit('fireballSpawned', fireball);
    });

    socket.on('playerReadyForNext', () => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        lobby.readyPlayers[socket.id] = true;

        const players = Object.keys(lobby.players);
        const readyCount = Object.keys(lobby.readyPlayers).length;

        io.to(lobby.id).emit('playerReadyUpdate', {
            readyPlayers: lobby.readyPlayers,
            totalPlayers: players.length
        });

        if (readyCount >= players.length) {
            RestartLevel(lobby);
        }
    });

    socket.on('requestWarp', async () => {
        const pId = socket.id;
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        const p = lobby.players[pId];
        if (!p || p.dead) return;

        const tx = Math.floor(p.x / TILE_SIZE);
        const feetY = p.y + (p.state === 0 ? 32 : 64);
        const ty = Math.floor((feetY + 10) / TILE_SIZE);

        const warpCoords = `${tx},${ty}`;
        const warpInfo = MAPS[p.levelId].warps[warpCoords];

        if (warpInfo) {
            await WarpPlayer(lobby, socket.id, warpInfo);
        }
    });

    socket.on('finishLevel', () => {
        const lobby = lobbies[socket.lobbyId];
        if (lobby) {
            EndLevel(lobby);
        }
    });

    socket.on('requestRestart', () => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        // Restart allowed if:
        // 1. Mode is Singleplayer or Speedrun or Co-op
        // 2. OR the requester is the lobby host
        const isHost = lobby.host === socket.id;
        const canRestart = (lobby.mode === 'Singleplayer' || lobby.mode === 'Speedrun' || lobby.mode === 'Co-op' || isHost);
        
        if (!canRestart) {
            // Explicitly notify the client that restart was denied so they don't stay frozen
            socket.emit('restartDenied');
            return;
        }

        // Clear any pending automatic restarts (e.g. from death timer)
        if (lobby.restartTimeout) {
            clearTimeout(lobby.restartTimeout);
            lobby.restartTimeout = null;
        }
        
        lobby.levelIsRestarting = true;
        RestartLevel(lobby);
    });

    socket.on('pauseGame', () => {
        const lobby = lobbies[socket.lobbyId];
        if (lobby && Object.keys(lobby.players).length === 1) {
            lobby.isPaused = true;
            console.log(`Lobby ${lobby.id} paused by ${socket.id}`);
        }
    });

    socket.on('resumeGame', () => {
        const lobby = lobbies[socket.lobbyId];
        if (lobby) {
            lobby.isPaused = false;
            console.log(`Lobby ${lobby.id} resumed by ${socket.id}`);
        }
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket);
    });
});

function handleDisconnect(socket) {
    console.log('User disconnected:', socket.id);
    const lobbyId = socket.lobbyId;
    if (lobbyId && lobbies[lobbyId]) {
        const lobby = lobbies[lobbyId];
        delete lobby.players[socket.id];

        // If the host leaves, either kill the lobby or assign a new host
        if (lobby.host === socket.id) {
            console.log(`Host left lobby ${lobbyId}. Killing lobby.`);
            io.to(lobbyId).emit('lobbyKilled');

            // Make everyone leave
            Object.keys(lobby.players).forEach(pId => {
                const pSocket = io.sockets.sockets.get(pId);
                if (pSocket) {
                    pSocket.leave(lobbyId);
                    if (lobby.players[pId].levelId) {
                        pSocket.leave(`${lobbyId}_${lobby.players[pId].levelId}`);
                    }
                }
            });
            delete lobbies[lobbyId];
        } else {
            io.to(lobbyId).emit('playerDisconnected', socket.id);

            // If match is active, check if all remaining players are dead
            if (lobby.status === 'playing' && lobby.mode !== 'Singleplayer' && !lobby.levelIsRestarting) {
                const activePlayers = Object.values(lobby.players).filter(p => p.levelId);
                if (activePlayers.length > 0 && activePlayers.every(p => p.dead)) {
                    lobby.levelIsRestarting = true;
                    setTimeout(() => {
                        EndLevel(lobby);
                    }, 2000);
                }
            }

            // Also notify the level room
            Object.keys(MAPS).forEach(levelId => {
                io.to(`${lobbyId}_${levelId}`).emit('playerDisconnected', socket.id);
            });

            // Update remaining players in the lobby waiting room
            io.to(lobbyId).emit('lobbyUpdate', {
                id: lobby.id,
                name: lobby.name,
                mode: lobby.mode,
                host: lobby.host,
                maxPlayers: lobby.maxPlayers,
                status: lobby.status,
                players: lobby.players,
                currentLevel: lobby.currentLevel
            });

            // If lobby is empty (shouldn't happen here due to host check but for safety), delete it
            if (Object.keys(lobby.players).length === 0) {
                console.log(`Lobby ${lobbyId} empty. Deleting.`);
                delete lobbies[lobbyId];
            }
        }

        broadcastLobbyList();
    }
}

function broadcastLobbyList() {
    io.emit('lobbyList', Object.values(lobbies).map(l => ({
        id: l.id,
        name: l.name,
        mode: l.mode,
        status: l.status,
        playerCount: Object.keys(l.players).length,
        maxPlayers: l.maxPlayers
    })));
}

function spawnItem(lobby, x, y, type, levelId) {
    const id = `item_${lobby.itemIdCounter++}`;
    const item = { id, type, x, y, vx: ITEM_SPEED, vy: -5, levelId };

    if (type === ITEM_TYPES.COIN) {
        io.to(`${lobby.id}_${levelId}`).emit('itemSpawned', item);
        return;
    }

    if (type === ITEM_TYPES.PHYS_COIN) {
        item.vx = 0;
        item.vy = 0;
        // Physical coins don't move
    }

    lobby.activeItems[id] = item;
    io.to(`${lobby.id}_${levelId}`).emit('itemSpawned', item);
}

function spawnEnemy(lobby, x, y, type, levelId, frame) {
    const id = `enemy_${lobby.enemyIdCounter++}`;
    const speed = (type === 'piranha') ? 0 : -ENEMY_SPEED;
    lobby.activeEnemies[id] = { id, type, x, y, vx: speed, vy: 0, levelId, frame, state: 'walking', startY: y };
    io.to(`${lobby.id}_${levelId}`).emit('enemySpawned', lobby.activeEnemies[id]);
}

const CHAOS_POSSIBILITIES = [
    'brick', 'question_coin', 'question_mushroom', 'question_star',
    'hard_block', 'ground_top', 'enemy_goomba', 'empty', 'coin'
];

function applyChaosRandomization(lobby, levelId) {
    if (lobby.mode !== 'Chaos') return;
    const originalMapData = MAPS[levelId].data;
    const map = lobby.builtMaps[levelId];
    if (!map || !map.data) return;

    lobby.chaosBlockContents[levelId] = {};
    lobby.chaosEnemySpawns[levelId] = [];

    for (let y = 0; y < originalMapData.length; y++) {
        const row = originalMapData[y];
        for (let x = 0; x < row.length; x++) {
            const char = row[x];

            // Randomizable: S, Q, ?, *, X, E, C
            const randomizable = ['S', 'Q', '?', '*', 'X', 'E', 'C'].includes(char);
            if (!randomizable) continue;

            const outcome = CHAOS_POSSIBILITIES[Math.floor(Math.random() * CHAOS_POSSIBILITIES.length)];

            // Clear current spot in tile map
            map.data[y][x] = TILE.EMPTY;

            switch (outcome) {
                case 'brick':
                    map.data[y][x] = TILE.BRICK;
                    break;
                case 'question_coin':
                    map.data[y][x] = TILE.QUESTION;
                    lobby.chaosBlockContents[levelId][`${x},${y}`] = ITEM_TYPES.COIN;
                    break;
                case 'question_mushroom':
                    map.data[y][x] = TILE.QUESTION;
                    lobby.chaosBlockContents[levelId][`${x},${y}`] = ITEM_TYPES.MUSHROOM;
                    break;
                case 'question_star':
                    map.data[y][x] = TILE.QUESTION;
                    lobby.chaosBlockContents[levelId][`${x},${y}`] = ITEM_TYPES.STAR;
                    break;
                case 'hard_block':
                    map.data[y][x] = TILE.HARD_BLOCK;
                    break;
                case 'ground_top':
                    map.data[y][x] = TILE.GROUND_TOP;
                    break;
                case 'enemy_goomba':
                    lobby.chaosEnemySpawns[levelId].push({ x: x * 64 + 32, y: y * 64 + 32, type: 'goomba' });
                    break;
                case 'coin':
                    map.data[y][x] = TILE.QUESTION;
                    lobby.chaosBlockContents[levelId][`${x},${y}`] = ITEM_TYPES.COIN;
                    break;
                case 'empty':
                    map.data[y][x] = TILE.EMPTY;
                    break;
            }
        }
    }
}

function spawnLevelEnemies(lobby, levelId) {
    if (lobby.mode === 'Chaos') {
        const spawns = lobby.chaosEnemySpawns[levelId] || [];
        spawns.forEach(spawn => {
            // Randomly decide if it's a standard goomba or a blockenemy
            if (Math.random() > 0.5) {
                spawnEnemy(lobby, spawn.x, spawn.y, 'blockenemy', levelId, getRandomChaosFrame());
            } else {
                spawnEnemy(lobby, spawn.x, spawn.y, 'goomba', levelId);
            }
        });
    } else {
        getEnemySpawns(levelId).forEach(spawn => {
            spawnEnemy(lobby, spawn.x, spawn.y, spawn.type, levelId);
        });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
