import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { MAPS, buildLevel, mapConfig, TILE, ITEM_TYPES, getBlockContent, getEnemySpawns } from './map.js';
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
    timeMs: { type: DataTypes.INTEGER, allowNull: false }
});

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
    }
});

let globalBestTime = null;

async function initDb() {
    try {
        await sequelize.sync();
        const best = await HighScore.findOne({
            order: [['timeMs', 'ASC']]
        });
        if (best) {
            globalBestTime = best.timeMs;
            console.log(`Loaded Global Best: ${globalBestTime}ms`);
        }
    } catch (err) {
        console.error('Database init error:', err);
    }
}
initDb();

const app = express();
app.use(cors());
app.use(express.json());
setupAuthRoutes(app, User);
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const lobbies = {}; // { [id]: { players, activeItems, activeEnemies, ... } }
const shootingCooldowns = {};

function createLobby(id, name = 'Room', mode = 'Co-op', hostId = null) {
    const initialLevel = 'world-1-1';
    return {
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
        spawnedLevels: new Set([initialLevel]) // Track which levels have had initial enemies spawned
    };
}

// Physics Constants
const GRAVITY = 0.8;
const ITEM_SPEED = 3;
const ENEMY_SPEED = 2;
const TILE_SIZE = 64;

let levelIsRestarting = false;

// Server Heartbeat (Physics Update)
setInterval(() => {
    Object.values(lobbies).forEach(lobby => {
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
            const levelId = enemy.levelId || 'world-1-1';
            if (!levelUpdates[levelId]) levelUpdates[levelId] = { itemUpdates: [], enemyUpdates: [], fireballUpdates: [] };

            // Horizontal movement
            enemy.x += enemy.vx;

            // Horizontal Collision detection
            const tileX = Math.floor((enemy.x + (enemy.vx > 0 ? 32 : -32)) / TILE_SIZE);
            const tileY = Math.floor(enemy.y / TILE_SIZE);

            if (isSolid(lobby, tileX, tileY, levelId)) {
                enemy.vx *= -1;
            }

            // Vertical movement (Gravity)
            enemy.vy += GRAVITY;
            enemy.y += enemy.vy;

            // Vertical Collision detection
            const footX = Math.floor(enemy.x / TILE_SIZE);
            const footY = Math.floor((enemy.y + 32) / TILE_SIZE);

            if (isSolid(lobby, footX, footY, levelId)) {
                enemy.y = footY * TILE_SIZE - 32;
                enemy.vy = 0;
            }

            // Check Fireball Collisions
            Object.keys(lobby.activeFireballs).forEach(fId => {
                const f = lobby.activeFireballs[fId];
                if (f.levelId !== levelId) return;
                const dx = enemy.x - f.x;
                const dy = enemy.y - f.y;
                if (dx * dx + dy * dy < 32 * 32) {
                    deadEnemies.push({ id, reason: 'fireball', levelId });
                    delete lobby.activeFireballs[fId];
                    io.to(`${lobby.id}_${levelId}`).emit('fireballDestroyed', fId);
                }
            });

            // Check Player Collisions
            Object.keys(lobby.players).forEach(pId => {
                const player = lobby.players[pId];
                if (player.levelId !== levelId) return;
                const dx = Math.abs(enemy.x - player.x);
                const dy = Math.abs(enemy.y - player.y);

                const playerHalfHeight = (player.state === 0 ? 32 : 68);
                const playerHalfWidth = 24; // Slightly narrower hitbox for better feel
                const enemyHalfSize = 32;

                // Basic AABB Collision
                if (dx < (playerHalfWidth + enemyHalfSize) && dy < (playerHalfHeight + enemyHalfSize)) {
                    if (player.invincible) {
                        deadEnemies.push({ id, reason: 'star', levelId });
                    } else if (!player.dead) {
                        const footPos = player.y + playerHalfHeight;
                        // If player is falling OR foot is above the enemy's center line
                        if (player.vy >= 0 && footPos < (enemy.y + 10)) {
                            deadEnemies.push({ id, reason: 'stomped', levelId });
                            io.to(pId).emit('playerBounce');
                        } else {
                            // Damage/Knockback player
                            handlePlayerInjury(lobby, pId, player.x < enemy.x ? -600 : 600);
                        }
                    }
                }
            });

            levelUpdates[levelId].enemyUpdates.push({ id, x: enemy.x, y: enemy.y, vx: enemy.vx });
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

            if (hitFlag) {
                EndLevel(lobby);
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
                    const halfHeightA = (pA.state === 0 ? 32 : 64);
                    const halfHeightB = (pB.state === 0 ? 32 : 64);

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

    // After a delay, restart the whole level
    if (lobby.levelIsRestarting) return;
    lobby.levelIsRestarting = true;
    setTimeout(() => {
        RestartLevel(lobby);
        lobby.levelIsRestarting = false;
    }, 2000);
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
    }
    return lobby.builtMaps[levelId];
}


function WarpPlayer(lobby, pId, warpInfo) {
    if (lobby.levelIsRestarting) return;
    
    const targetLevel = warpInfo.target;
    const socket = io.sockets.sockets.get(pId);
    const oldLevelId = lobby.players[pId].levelId;

    if (lobby.mode === 'Co-op') {
        console.log(`Warping lobby ${lobby.id} to ${targetLevel} (Co-op)`);
        lobby.currentLevel = targetLevel;
        
        // Broadcast new map to all in lobby
        io.to(lobby.id).emit('initMap', {
            ...getLobbyMap(lobby, targetLevel),
            warps: MAPS[targetLevel].warps,
            spawnType: warpInfo.spawnType,
            spawnX: warpInfo.x,
            spawnY: warpInfo.y,
            isWarp: true
        });

        // Clear all level items and enemies
        Object.keys(lobby.activeItems).forEach(id => delete lobby.activeItems[id]);
        Object.keys(lobby.activeEnemies).forEach(id => delete lobby.activeEnemies[id]);
        io.to(lobby.id).emit('initItems', {});
        io.to(lobby.id).emit('initEnemies', {});

        // Move all players and update their room
        Object.keys(lobby.players).forEach(id => {
            const p = lobby.players[id];
            const pSocket = io.sockets.sockets.get(id);
            if (pSocket) {
                pSocket.leave(`${lobby.id}_${p.levelId}`);
                pSocket.join(`${lobby.id}_${targetLevel}`);
            }
            p.levelId = targetLevel;
            p.x = warpInfo.x;
            p.y = warpInfo.y;
            p.vy = 0;
            io.to(`${lobby.id}_${targetLevel}`).emit('playerMoved', p);
        });

        // Spawn new enemies for everyone
        getEnemySpawns(targetLevel).forEach(spawn => spawnEnemy(lobby, spawn.x, spawn.y, spawn.type, targetLevel));
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

        // Spawn enemies if this level hasn't been visited in this lobby yet
        if (!lobby.spawnedLevels.has(targetLevel)) {
            getEnemySpawns(targetLevel).forEach(spawn => spawnEnemy(lobby, spawn.x, spawn.y, spawn.type, targetLevel));
            lobby.spawnedLevels.add(targetLevel);
        }

        io.to(`${lobby.id}_${targetLevel}`).emit('playerMoved', p);
        io.to(`${lobby.id}_${oldLevelId}`).emit('playerDisconnected', pId); // Make them "disappear" from old level
    }
}

function EndLevel(lobby) {
    if (lobby.levelIsRestarting) return;
    lobby.levelIsRestarting = true;

    console.log(`Level Finished in lobby ${lobby.id}! Restarting in 2s...`);
    io.to(lobby.id).emit('levelFinished');

    // Calculate times and check for new best
    const now = Date.now();
    Object.keys(lobby.players).forEach(async (pId) => {
        const p = lobby.players[pId];
        if (p.runStartTime && !p.dead) {
            const elapsed = now - p.runStartTime;
            if (globalBestTime === null || elapsed < globalBestTime) {
                globalBestTime = elapsed;
                try {
                    await HighScore.create({ timeMs: elapsed });
                    io.emit('newGlobalBest', globalBestTime);
                    console.log(`New Global Best: ${elapsed}ms`);
                } catch (err) {
                    console.error('Error saving high score:', err);
                }
            }
        }
    });

    setTimeout(() => {
        RestartLevel(lobby);
        lobby.levelIsRestarting = false;
    }, 2000);
}

function RestartLevel(lobby) {
    const levelId = lobby.currentLevel || 'world-1-1';
    const map = getLobbyMap(lobby, levelId);
    const spawnPos = MAPS[levelId].spawn || { x: 150, y: 700 };
    const spawnType = spawnPos.spawnType || 'none';
    
    io.to(lobby.id).emit('initMap', { 
        ...map, 
        warps: MAPS[levelId].warps,
        spawnType,
        spawnX: spawnPos.x,
        spawnY: spawnPos.y
    });

    // 2. Clear Items & Fireballs
    Object.keys(lobby.activeItems).forEach(id => delete lobby.activeItems[id]);
    Object.keys(lobby.activeFireballs).forEach(id => delete lobby.activeFireballs[id]);
    io.to(lobby.id).emit('initItems', {});

    // 3. Reset Enemies
    Object.keys(lobby.activeEnemies).forEach(id => delete lobby.activeEnemies[id]);
    getEnemySpawns(levelId).forEach(spawn => spawnEnemy(lobby, spawn.x, spawn.y, spawn.type, levelId));
    lobby.spawnedLevels = new Set([levelId]);

    // 4. Reset Players
    Object.keys(lobby.players).forEach(id => {
        const p = lobby.players[id];
        const socket = io.sockets.sockets.get(id);
        if (socket) {
            socket.leave(`${lobby.id}_${p.levelId}`);
            socket.join(`${lobby.id}_${levelId}`);
        }
        p.levelId = levelId;
        p.x = spawnPos.x;
        p.y = spawnPos.y;
        p.vy = 0;
        p.state = 0; // Back to small
        p.dead = false;
        p.anim = 'idle';
        p.invulnTimer = 0;
        p.invincible = false;
        p.starPowerTimer = 0;
        p.runStartTime = Date.now(); 
        io.to(`${lobby.id}_${levelId}`).emit('playerMoved', p);
    });
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

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
        const { name, mode } = data;
        const id = `lobby_${Math.random().toString(36).substr(2, 9)}`;
        lobbies[id] = createLobby(id, name, mode, socket.id);
        
        socket.emit('lobbyCreated', id);
        broadcastLobbyList();
    });

    socket.on('joinLobby', (lobbyId) => {
        const lobby = lobbies[lobbyId];
        if (!lobby) return;

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
            x: 150, y: 700, id: socket.id, anim: 'idle', flipX: false,
            state: 0, vy: 0, invincible: false, starPowerTimer: 0,
            invulnTimer: 0, dead: false, runStartTime: Date.now(),
            levelId: lobby.currentLevel
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
            getEnemySpawns(lobby.currentLevel).forEach(spawn => {
                spawnEnemy(lobby, spawn.x, spawn.y, spawn.type, lobby.currentLevel);
            });
            lobby.spawnedLevels.add(lobby.currentLevel);
        }

        io.to(lobby.id).emit('matchStarted');

        // Send init data to all players
        Object.keys(lobby.players).forEach(pId => {
            const pSocket = io.sockets.sockets.get(pId);
            if (!pSocket) return;

            pSocket.join(`${lobby.id}_${lobby.currentLevel}`);
            
            const spawnPos = MAPS[lobby.currentLevel].spawn || { x: 150, y: 700 };
            pSocket.emit('initMap', { 
                ...getLobbyMap(lobby, lobby.currentLevel), 
                warps: MAPS[lobby.currentLevel].warps,
                spawnType: spawnPos.spawnType || 'none',
                spawnX: spawnPos.x,
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
            pSocket.emit('globalBest', globalBestTime);
        });

        broadcastLobbyList();
    });

    socket.on('killLobby', () => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby || lobby.host !== socket.id) return;

        io.to(lobby.id).emit('lobbyKilled');
        
        // Make all players leave
        const playerIds = Object.keys(lobby.players);
        playerIds.forEach(pId => {
            const pSocket = io.sockets.sockets.get(pId);
            if (pSocket) {
                pSocket.leave(lobby.id);
                if (lobby.players[pId].levelId) {
                    pSocket.leave(`${lobby.id}_${lobby.players[pId].levelId}`);
                }
            }
        });

        delete lobbies[lobby.id];
        broadcastLobbyList();
    });

    socket.on('leaveLobby', () => {
        handleDisconnect(socket);
    });

    socket.on('getLeaderboard', async () => {
        try {
            const scores = await HighScore.findAll({
                limit: 10,
                order: [['timeMs', 'ASC']]
            });
            socket.emit('leaderboardData', scores);
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

                if (tileIndex === TILE.QUESTION) {
                    newTileIndex = TILE.HIT_QUESTION;
                    map.data[y][x] = newTileIndex;

                // Spawn Item
                const itemType = getBlockContent(x, y, p.levelId, p.state);
                if (itemType !== ITEM_TYPES.NONE) {
                    spawnItem(lobby, x * TILE_SIZE + 32, y * TILE_SIZE - 32, itemType, p.levelId);
                }
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

    socket.on('requestWarp', () => {
        const pId = socket.id;
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        const p = lobby.players[pId];
        if (!p || p.dead) return;

        const tx = Math.floor(p.x / TILE_SIZE);
        const feetY = p.y + (p.state === 0 ? 32 : 64);
        const ty = Math.floor((feetY + 10) / TILE_SIZE);
        
        const warpCoords = `${tx},${ty}`;
        const warpInfo = MAPS[lobby.currentLevel].warps[warpCoords];

        if (warpInfo) {
            WarpPlayer(lobby, socket.id, warpInfo);
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

    lobby.activeItems[id] = item;
    io.to(`${lobby.id}_${levelId}`).emit('itemSpawned', item);
}

function spawnEnemy(lobby, x, y, type, levelId) {
    const id = `enemy_${lobby.enemyIdCounter++}`;
    lobby.activeEnemies[id] = { id, type, x, y, vx: -ENEMY_SPEED, vy: 0, levelId };
    io.to(`${lobby.id}_${levelId}`).emit('enemySpawned', lobby.activeEnemies[id]);
}

server.listen(3000, () => console.log('Server on port 3000'));
