import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { mapConfig, TILE, ITEM_TYPES, getBlockContent, getEnemySpawns } from './map.js';
import { Sequelize, DataTypes } from 'sequelize';

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
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const lobbies = {}; // { [id]: { players, activeItems, activeEnemies, ... } }
const shootingCooldowns = {};

function createLobby(id, name = 'Room', mode = 'Co-op') {
    return {
        id,
        name,
        mode,
        players: {},
        activeItems: {},
        activeFireballs: {},
        activeEnemies: {},
        itemIdCounter: 0,
        fireballIdCounter: 0,
        enemyIdCounter: 0,
        levelIsRestarting: false,
        map: {
            ...mapConfig,
            data: JSON.parse(JSON.stringify(mapConfig.data))
        }
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
        const itemUpdates = [];

        Object.keys(lobby.activeItems).forEach(id => {
            const item = lobby.activeItems[id];

            if (item.type === ITEM_TYPES.MUSHROOM || item.type === ITEM_TYPES.STAR) {
                // Horizontal movement
                item.x += item.vx;

                // Horizontal Collision detection
                const tileX = Math.floor((item.x + (item.vx > 0 ? 16 : -16)) / TILE_SIZE);
                const tileY = Math.floor(item.y / TILE_SIZE);

                if (isSolid(lobby, tileX, tileY)) {
                    item.vx *= -1;
                }

                // Vertical movement (Gravity)
                item.vy += GRAVITY;
                item.y += item.vy;

                // Vertical Collision detection
                const footX = Math.floor(item.x / TILE_SIZE);
                const footY = Math.floor((item.y + 16) / TILE_SIZE);

                if (isSolid(lobby, footX, footY)) {
                    item.y = footY * TILE_SIZE - 16;
                    item.vy = 0;

                    if (item.type === ITEM_TYPES.STAR) {
                        item.vy = -12; // Star bounces
                    }
                }

                itemUpdates.push({ id, x: item.x, y: item.y });
            }
        });

        if (itemUpdates.length > 0) {
            io.to(lobby.id).emit('itemUpdates', itemUpdates);
        }

        // Fireball Updates
        const fireballUpdates = [];
        const deadFireballs = [];

        const mapHeightPixels = lobby.map.height * TILE_SIZE;

        Object.keys(lobby.activeFireballs).forEach(id => {
            const f = lobby.activeFireballs[id];

            f.life -= 33;

            // Store previous position (IMPORTANT for collision correction)
            const prevX = f.x;
            const prevY = f.y;

            // Apply gravity
            f.vy += GRAVITY;

            // Move
            f.x += f.vx;
            f.y += f.vy;

            // ---- WALL COLLISION (horizontal) ----
            const nextX = f.x + f.vx;

            const wallCheckPoints = [
                { x: nextX, y: f.y - 6 },
                { x: nextX, y: f.y },
                { x: nextX, y: f.y + 6 }
            ];

            let hitWall = wallCheckPoints.some(p =>
                isSolid(lobby, Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE))
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

            let hitGround = footXs.some(x => isSolid(lobby, x, footY));

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

                const dx = f.x - target.x;
                const dy = f.y - (target.y + (target.state === 0 ? 16 : 32));

                if (dx * dx + dy * dy < 16 * 16) {
                    io.to(pId).emit('playerKnockback', {
                        vx: f.vx > 0 ? 800 : -800,
                        vy: -600
                    });

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

            // ---- DESPAWN CONDITIONS ----
            if (
                f.life <= 0 ||
                f.bounces > 8 ||
                f.stuckFrames > 10 ||   // ← FIXED threshold
                f.y > mapHeightPixels
            ) {
                deadFireballs.push(id);
            } else {
                fireballUpdates.push({ id, x: f.x, y: f.y });
            }
        });

        deadFireballs.forEach(id => {
            delete lobby.activeFireballs[id];
            io.to(lobby.id).emit('fireballDestroyed', id);
        });

        if (fireballUpdates.length > 0) {
            io.to(lobby.id).emit('fireballUpdates', fireballUpdates);
        }

        // Enemy Updates
        const enemyUpdates = [];
        const deadEnemies = [];

        Object.keys(lobby.activeEnemies).forEach(id => {
            const enemy = lobby.activeEnemies[id];

            // Horizontal movement
            enemy.x += enemy.vx;

            // Horizontal Collision detection
            const tileX = Math.floor((enemy.x + (enemy.vx > 0 ? 32 : -32)) / TILE_SIZE);
            const tileY = Math.floor(enemy.y / TILE_SIZE);

            if (isSolid(lobby, tileX, tileY)) {
                enemy.vx *= -1;
            }

            // Vertical movement (Gravity)
            enemy.vy += GRAVITY;
            enemy.y += enemy.vy;

            // Vertical Collision detection
            const footX = Math.floor(enemy.x / TILE_SIZE);
            const footY = Math.floor((enemy.y + 32) / TILE_SIZE);

            if (isSolid(lobby, footX, footY)) {
                enemy.y = footY * TILE_SIZE - 32;
                enemy.vy = 0;
            }

            // Check Fireball Collisions
            Object.keys(lobby.activeFireballs).forEach(fId => {
                const f = lobby.activeFireballs[fId];
                const dx = enemy.x - f.x;
                const dy = enemy.y - f.y;
                if (dx * dx + dy * dy < 32 * 32) {
                    deadEnemies.push({ id, reason: 'fireball' });
                    delete lobby.activeFireballs[fId];
                    io.to(lobby.id).emit('fireballDestroyed', fId);
                }
            });

            // Check Player Collisions
            Object.keys(lobby.players).forEach(pId => {
                const player = lobby.players[pId];
                const dx = Math.abs(enemy.x - player.x);
                const dy = Math.abs(enemy.y - player.y);

                const playerHalfHeight = (player.state === 0 ? 32 : 68);
                const playerHalfWidth = 24; // Slightly narrower hitbox for better feel
                const enemyHalfSize = 32;

                // Basic AABB Collision
                if (dx < (playerHalfWidth + enemyHalfSize) && dy < (playerHalfHeight + enemyHalfSize)) {
                    if (player.invincible) {
                        deadEnemies.push({ id, reason: 'star' });
                    } else if (!player.dead) {
                        const footPos = player.y + playerHalfHeight;
                        // If player is falling OR foot is above the enemy's center line
                        if (player.vy >= 0 && footPos < (enemy.y + 10)) {
                            deadEnemies.push({ id, reason: 'stomped' });
                            io.to(pId).emit('playerBounce');
                        } else {
                            // Damage/Knockback player
                            handlePlayerInjury(lobby, pId, player.x < enemy.x ? -600 : 600);
                        }
                    }
                }
            });

            enemyUpdates.push({ id, x: enemy.x, y: enemy.y, vx: enemy.vx });
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
                return getTileAt(lobby, tx, ty) === TILE.FLAG_POLE;
            });

            if (hitFlag) {
                EndLevel(lobby);
            }
        });

        // Check Fall Death
        Object.keys(lobby.players).forEach(pId => {
            const p = lobby.players[pId];
            if (!p.dead && p.y > mapHeightPixels) {
                PlayerDie(lobby, pId);
            }
        });

        // Player-to-Player Contact (Star Power Push)
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

                // Basic distance check (roughly player size)
                if (distSq < 64 * 64) {
                    if (playerB.invincible) return; // Both have stars? No effect

                    handlePlayerInjury(lobby, idB, playerB.x < playerA.x ? -800 : 800);
                }
            });
        });

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
            io.to(lobby.id).emit('enemyDestroyed', death);
        });

        if (enemyUpdates.length > 0) {
            io.to(lobby.id).emit('enemyUpdates', enemyUpdates);
        }
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
        io.to(lobby.id).emit('playerMoved', player); // Broadcast state change
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
    io.to(lobby.id).emit('playerMoved', p);

    // After a delay, restart the whole level
    if (lobby.levelIsRestarting) return;
    lobby.levelIsRestarting = true;
    setTimeout(() => {
        RestartLevel(lobby);
        lobby.levelIsRestarting = false;
    }, 2000);
}

function isSolid(lobby, x, y) {
    const tile = getTileAt(lobby, x, y);
    return tile !== -1;
}

function getTileAt(lobby, x, y) {
    if (x < 0 || x >= lobby.map.width || y < 0 || y >= lobby.map.height) return -1;
    return lobby.map.data[y][x];
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
    // 1. Reset Map Data
    lobby.map.data = JSON.parse(JSON.stringify(mapConfig.data));
    io.to(lobby.id).emit('initMap', lobby.map);

    // 2. Clear Items & Fireballs
    Object.keys(lobby.activeItems).forEach(id => delete lobby.activeItems[id]);
    Object.keys(lobby.activeFireballs).forEach(id => delete lobby.activeFireballs[id]);
    io.to(lobby.id).emit('initItems', {});

    // 3. Reset Enemies
    Object.keys(lobby.activeEnemies).forEach(id => delete lobby.activeEnemies[id]);
    getEnemySpawns().forEach(spawn => spawnEnemy(lobby, spawn.x, spawn.y, spawn.type));

    // 4. Reset Players
    Object.keys(lobby.players).forEach(id => {
        const p = lobby.players[id];
        p.x = 150;
        p.y = 700;
        p.vy = 0;
        p.state = 0; // Back to small
        p.dead = false;
        p.anim = 'idle';
        p.invulnTimer = 0;
        p.invincible = false;
        p.starPowerTimer = 0;
        p.runStartTime = Date.now(); 
        io.to(lobby.id).emit('playerMoved', p);
    });
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Send available lobbies on connection
    socket.emit('lobbyList', Object.values(lobbies).map(l => ({
        id: l.id,
        name: l.name,
        mode: l.mode,
        playerCount: Object.keys(l.players).length
    })));

    socket.on('createLobby', (data) => {
        const { name, mode } = data;
        const id = `lobby_${Math.random().toString(36).substr(2, 9)}`;
        lobbies[id] = createLobby(id, name, mode);
        
        // Initial Enemy Spawn for new lobby
        getEnemySpawns().forEach(spawn => {
            spawnEnemy(lobbies[id], spawn.x, spawn.y, spawn.type);
        });

        socket.emit('lobbyCreated', id);
        io.emit('lobbyList', Object.values(lobbies).map(l => ({
            id: l.id,
            name: l.name,
            mode: l.mode,
            playerCount: Object.keys(l.players).length
        })));
    });

    socket.on('joinLobby', (lobbyId) => {
        const lobby = lobbies[lobbyId];
        if (!lobby) return;

        socket.join(lobbyId);
        socket.lobbyId = lobbyId;

        lobby.players[socket.id] = {
            x: 150, y: 700, id: socket.id, anim: 'idle', flipX: false,
            state: 0, vy: 0, invincible: false, starPowerTimer: 0,
            invulnTimer: 0, dead: false, runStartTime: Date.now()
        };

        socket.emit('initMap', lobby.map);
        socket.emit('currentPlayers', lobby.players);
        socket.emit('initItems', lobby.activeItems);
        socket.emit('initEnemies', lobby.activeEnemies);
        socket.emit('globalBest', globalBestTime);

        socket.to(lobbyId).emit('newPlayer', lobby.players[socket.id]);
        
        // Update lobby list counts for everyone
        io.emit('lobbyList', Object.values(lobbies).map(l => ({
            id: l.id,
            name: l.name,
            mode: l.mode,
            playerCount: Object.keys(l.players).length
        })));
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
            socket.to(socket.lobbyId).emit('playerMoved', p);
        }
    });

    socket.on('blockHit', (data) => {
        const lobby = lobbies[socket.lobbyId];
        if (!lobby) return;

        const { x, y } = data;
        if (y >= 0 && y < lobby.map.data.length && x >= 0 && x < lobby.map.data[0].length) {
            const tileIndex = lobby.map.data[y][x];

            if (tileIndex === TILE.BRICK || tileIndex === TILE.QUESTION) {
                let newTileIndex = tileIndex;

                if (tileIndex === TILE.QUESTION) {
                    newTileIndex = TILE.HIT_QUESTION;
                    lobby.map.data[y][x] = newTileIndex;

                    // Spawn Item
                    const itemType = getBlockContent(x, y, lobby.players[socket.id].state);
                    if (itemType !== ITEM_TYPES.NONE) {
                        spawnItem(lobby, x * TILE_SIZE + 32, y * TILE_SIZE - 32, itemType);
                    }
                }

                io.to(socket.lobbyId).emit('tileUpdate', { x, y, oldTile: tileIndex, newTile: newTileIndex });

                // Check if any items are on top of this block to make them bounce
                Object.values(lobby.activeItems).forEach(item => {
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
                    const p = lobby.players[id];
                    const footOffset = (p.state === 0) ? 32 : 64;
                    const pTileX = Math.floor(p.x / TILE_SIZE);
                    const pTileY = Math.floor((p.y + footOffset + 2) / TILE_SIZE);

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
            io.to(socket.lobbyId).emit('itemDestroyed', {
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
        const fireball = {
            id,
            x: p.x + (direction * 20),
            y: p.y,
            vx: direction * 20,
            vy: 0,
            ownerId: socket.id,
            bounces: 0,
            life: 3000,
            lastX: p.x + (direction * 20),
            stuckFrames: 0
        };

        lobby.activeFireballs[id] = fireball;
        io.to(socket.lobbyId).emit('fireballSpawned', fireball);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const lobbyId = socket.lobbyId;
        if (lobbyId && lobbies[lobbyId]) {
            delete lobbies[lobbyId].players[socket.id];
            io.to(lobbyId).emit('playerDisconnected', socket.id);

            // If lobby is empty, delete it
            if (Object.keys(lobbies[lobbyId].players).length === 0) {
                console.log(`Lobby ${lobbyId} empty. Deleting.`);
                delete lobbies[lobbyId];
                io.emit('lobbyList', Object.values(lobbies).map(l => ({
                    id: l.id,
                    name: l.name,
                    mode: l.mode,
                    playerCount: Object.keys(l.players).length
                })));
            }
        }
    });
});

function spawnItem(lobby, x, y, type) {
    const id = `item_${lobby.itemIdCounter++}`;
    const item = { id, type, x, y, vx: ITEM_SPEED, vy: -5 };

    if (type === ITEM_TYPES.COIN) {
        io.to(lobby.id).emit('itemSpawned', item);
        return;
    }

    lobby.activeItems[id] = item;
    io.to(lobby.id).emit('itemSpawned', item);
}

function spawnEnemy(lobby, x, y, type) {
    const id = `enemy_${lobby.enemyIdCounter++}`;
    lobby.activeEnemies[id] = { id, type, x, y, vx: -ENEMY_SPEED, vy: 0 };
    io.to(lobby.id).emit('enemySpawned', lobby.activeEnemies[id]);
}

server.listen(3000, () => console.log('Server on port 3000'));
