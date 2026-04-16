import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { mapConfig, TILE, ITEM_TYPES, getBlockContent, getEnemySpawns } from './map.js';

const app = express();
app.use(cors());
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const players = {};
const activeItems = {}; // { [id]: { type, x, y, vx, vy, ... } }
const activeFireballs = {}; // { [id]: { x, y, vx, vy, ownerId, bounces, life } }
const activeEnemies = {}; // { [id]: { type, x, y, vx, vy, ... } }
let itemIdCounter = 0;
let fireballIdCounter = 0;
let enemyIdCounter = 0;
const shootingCooldowns = {}; // { [playerId]: lastShootTime }

const currentMap = {
    ...mapConfig,
    data: JSON.parse(JSON.stringify(mapConfig.data)) // Deep copy
};

// Physics Constants
const GRAVITY = 0.8;
const ITEM_SPEED = 3;
const ENEMY_SPEED = 2;
const TILE_SIZE = 64;

let levelIsRestarting = false;

// Server Heartbeat (Physics Update)
setInterval(() => {
    const itemUpdates = [];

    Object.keys(activeItems).forEach(id => {
        const item = activeItems[id];

        if (item.type === ITEM_TYPES.MUSHROOM || item.type === ITEM_TYPES.STAR) {
            // Horizontal movement
            item.x += item.vx;

            // Horizontal Collision detection
            const tileX = Math.floor((item.x + (item.vx > 0 ? 16 : -16)) / TILE_SIZE);
            const tileY = Math.floor(item.y / TILE_SIZE);

            if (isSolid(tileX, tileY)) {
                item.vx *= -1;
            }

            // Vertical movement (Gravity)
            item.vy += GRAVITY;
            item.y += item.vy;

            // Vertical Collision detection
            const footX = Math.floor(item.x / TILE_SIZE);
            const footY = Math.floor((item.y + 16) / TILE_SIZE);

            if (isSolid(footX, footY)) {
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
        io.emit('itemUpdates', itemUpdates);
    }

    // Fireball Updates
    const fireballUpdates = [];
    const deadFireballs = [];

    const mapHeightPixels = currentMap.height * TILE_SIZE;

    Object.keys(activeFireballs).forEach(id => {
        const f = activeFireballs[id];

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
            isSolid(Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE))
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

        let hitGround = footXs.some(x => isSolid(x, footY));

        // ONLY bounce if falling
        if (hitGround && f.vy > 0) {
            // Snap to ground (prevents sinking)
            f.y = footY * TILE_SIZE - 10;

            // Stronger, consistent bounce
            f.vy = -10;

            f.bounces++;
        }

        // ---- PLAYER COLLISION ----
        Object.keys(players).forEach(pId => {
            if (pId === f.ownerId) return;

            const target = players[pId];

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
        delete activeFireballs[id];
        io.emit('fireballDestroyed', id);
    });

    if (fireballUpdates.length > 0) {
        io.emit('fireballUpdates', fireballUpdates);
    }

    // Enemy Updates
    const enemyUpdates = [];
    const deadEnemies = [];

    Object.keys(activeEnemies).forEach(id => {
        const enemy = activeEnemies[id];

        // Horizontal movement
        enemy.x += enemy.vx;

        // Horizontal Collision detection
        const tileX = Math.floor((enemy.x + (enemy.vx > 0 ? 32 : -32)) / TILE_SIZE);
        const tileY = Math.floor(enemy.y / TILE_SIZE);

        if (isSolid(tileX, tileY)) {
            enemy.vx *= -1;
        }

        // Vertical movement (Gravity)
        enemy.vy += GRAVITY;
        enemy.y += enemy.vy;

        // Vertical Collision detection
        const footX = Math.floor(enemy.x / TILE_SIZE);
        const footY = Math.floor((enemy.y + 32) / TILE_SIZE);

        if (isSolid(footX, footY)) {
            enemy.y = footY * TILE_SIZE - 32;
            enemy.vy = 0;
        }

        // Check Fireball Collisions
        Object.keys(activeFireballs).forEach(fId => {
            const f = activeFireballs[fId];
            const dx = enemy.x - f.x;
            const dy = enemy.y - f.y;
            if (dx * dx + dy * dy < 32 * 32) {
                deadEnemies.push({ id, reason: 'fireball' });
                delete activeFireballs[fId];
                io.emit('fireballDestroyed', fId);
            }
        });

        // Check Player Collisions
        Object.keys(players).forEach(pId => {
            const player = players[pId];
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
                        handlePlayerInjury(pId, player.x < enemy.x ? -600 : 600);
                    }
                }
            }
        });

        enemyUpdates.push({ id, x: enemy.x, y: enemy.y, vx: enemy.vx });
    });

    // Check Flag Collisions
    Object.keys(players).forEach(pId => {
        const p = players[pId];
        if (p.dead) return;

        const checkPoints = [
            { x: p.x, y: p.y },
            { x: p.x, y: p.y + (p.state === 0 ? 32 : 64) }
        ];
        const hitFlag = checkPoints.some(pt => {
            const tx = Math.floor(pt.x / TILE_SIZE);
            const ty = Math.floor(pt.y / TILE_SIZE);
            return getTileAt(tx, ty) === TILE.FLAG_POLE;
        });

        if (hitFlag) {
            EndLevel();
        }
    });

    // Check Fall Death
    Object.keys(players).forEach(pId => {
        const p = players[pId];
        if (!p.dead && p.y > mapHeightPixels) {
            PlayerDie(pId);
        }
    });

    // Player-to-Player Contact (Star Power Push)
    Object.keys(players).forEach(idA => {
        const playerA = players[idA];
        if (!playerA.invincible || playerA.dead) return;

        Object.keys(players).forEach(idB => {
            if (idA === idB) return;
            const playerB = players[idB];
            if (playerB.dead) return;

            const dx = playerA.x - playerB.x;
            const dy = playerA.y - playerB.y;
            const distSq = dx * dx + dy * dy;

            // Basic distance check (roughly player size)
            if (distSq < 64 * 64) {
                if (playerB.invincible) return; // Both have stars? No effect

                handlePlayerInjury(idB, playerB.x < playerA.x ? -800 : 800);
            }
        });
    });

    // Update Timers (Star Power and Invulnerability)
    Object.keys(players).forEach(id => {
        const p = players[id];
        if (p.starPowerTimer > 0) {
            p.starPowerTimer -= 33;
            if (p.starPowerTimer <= 0) {
                p.invincible = false;
                p.starPowerTimer = 0;
                io.emit('playerMoved', p);
            }
        }
        if (p.invulnTimer > 0) {
            p.invulnTimer -= 33;
            if (p.invulnTimer <= 0) {
                p.invulnTimer = 0;
                io.emit('playerMoved', p);
            }
        }
    });

    deadEnemies.forEach(death => {
        delete activeEnemies[death.id];
        io.emit('enemyDestroyed', death);
    });

    if (enemyUpdates.length > 0) {
        io.emit('enemyUpdates', enemyUpdates);
    }
}, 33); // ~30 FPS

function handlePlayerInjury(pId, knockbackVX) {
    const player = players[pId];
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
        io.emit('playerMoved', player); // Broadcast state change
    } else {
        // Die
        PlayerDie(pId);
    }
}

function PlayerDie(pId) {
    const p = players[pId];
    if (!p || p.dead) return;

    p.dead = true;
    p.anim = 'die';
    p.vy = -1000; // Small hop up
    io.emit('playerMoved', p);

    // After a delay, restart the whole level
    setTimeout(() => {
        RestartLevel();
    }, 2000);
}

function isSolid(x, y) {
    const tile = getTileAt(x, y);
    return tile !== -1;
}

let lastRestartTime = 0;

function getTileAt(x, y) {
    if (x < 0 || x >= currentMap.width || y < 0 || y >= currentMap.height) return -1;
    return currentMap.data[y][x];
}

function EndLevel() {
    if (levelIsRestarting) return;
    levelIsRestarting = true;

    console.log('Level Finished! Restarting in 2s...');
    io.emit('levelFinished');

    setTimeout(() => {
        RestartLevel();
        levelIsRestarting = false;
    }, 2000);
}

function RestartLevel() {
    // 1. Reset Map Data
    currentMap.data = JSON.parse(JSON.stringify(mapConfig.data));
    io.emit('initMap', currentMap);

    // 2. Clear Items & Fireballs
    Object.keys(activeItems).forEach(id => delete activeItems[id]);
    Object.keys(activeFireballs).forEach(id => delete activeFireballs[id]);
    io.emit('initItems', {});

    // 3. Reset Enemies
    Object.keys(activeEnemies).forEach(id => delete activeEnemies[id]);
    getEnemySpawns().forEach(spawn => spawnEnemy(spawn.x, spawn.y, spawn.type));

    // 4. Reset Players
    Object.keys(players).forEach(id => {
        const p = players[id];
        p.x = 150;
        p.y = 700;
        p.vy = 0;
        p.state = 0; // Back to small
        p.dead = false;
        p.anim = 'idle';
        p.invulnTimer = 0;
        p.invincible = false;
        p.starPowerTimer = 0;
        io.emit('playerMoved', p);
    });
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    // temp
    players[socket.id] = {
        x: 150, y: 700, id: socket.id, anim: 'idle', flipX: false,
        state: 0, vy: 0, invincible: false, starPowerTimer: 0,
        invulnTimer: 0, dead: false
    };

    // Send current state to new client
    socket.emit('initMap', currentMap);
    socket.emit('currentPlayers', players);
    socket.emit('initItems', activeItems);
    socket.emit('initEnemies', activeEnemies);

    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('playerMovement', (movementData) => {
        const p = players[socket.id];
        if (p && !p.dead && !levelIsRestarting) { // Don't allow movement if dead or level finished
            p.vy = movementData.y - p.y;
            p.x = movementData.x;
            p.y = movementData.y;
            p.anim = movementData.anim;
            p.flipX = movementData.flipX;
            // Removed state override - server is authoritative
            socket.broadcast.emit('playerMoved', p);
        }
    });

    socket.on('blockHit', (data) => {
        const { x, y } = data;
        if (y >= 0 && y < currentMap.data.length && x >= 0 && x < currentMap.data[0].length) {
            const tileIndex = currentMap.data[y][x];

            if (tileIndex === TILE.BRICK || tileIndex === TILE.QUESTION) {
                let newTileIndex = tileIndex;

                if (tileIndex === TILE.QUESTION) {
                    newTileIndex = TILE.HIT_QUESTION;
                    currentMap.data[y][x] = newTileIndex;

                    // Spawn Item
                    const itemType = getBlockContent(x, y, players[socket.id].state);
                    if (itemType !== ITEM_TYPES.NONE) {
                        spawnItem(x * TILE_SIZE + 32, y * TILE_SIZE - 32, itemType);
                    }
                }

                io.emit('tileUpdate', { x, y, oldTile: tileIndex, newTile: newTileIndex });

                // Check if any items are on top of this block to make them bounce
                Object.values(activeItems).forEach(item => {
                    if (item.type === ITEM_TYPES.MUSHROOM || item.type === ITEM_TYPES.STAR) {
                        const itemTileX = Math.floor(item.x / TILE_SIZE);
                        const itemTileY = Math.floor((item.y + 16) / TILE_SIZE);
                        if (itemTileX === x && itemTileY === y) {
                            item.vy = -10; // Bounce up
                        }
                    }
                });

                // Check if any players are on top of this block to make them bounce
                Object.keys(players).forEach(id => {
                    const p = players[id];
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
        if (activeItems[itemId]) {
            const item = activeItems[itemId];
            const itemType = item.type;

            // Power-up logic
            if (itemType === ITEM_TYPES.MUSHROOM) {
                if (players[socket.id].state === 0) {
                    players[socket.id].state = 1;
                    players[socket.id].y -= 32; // Move center up when growing to keep feet grounded
                }
            } else if (itemType === ITEM_TYPES.FIRE_FLOWER) {
                if (players[socket.id].state === 0) {
                    players[socket.id].y -= 32;
                }
                players[socket.id].state = 2;
            } else if (itemType === ITEM_TYPES.STAR) {
                players[socket.id].invincible = true;
                players[socket.id].starPowerTimer = 7000; // 7 seconds
            }

            delete activeItems[itemId];
            io.emit('itemDestroyed', {
                itemId,
                collectorId: socket.id,
                itemType,
                newState: players[socket.id].state,
                invincible: players[socket.id].invincible
            });
        }
    });

    socket.on('shootFireball', () => {
        const p = players[socket.id];
        if (!p || p.state !== 2) return;

        const now = Date.now();
        const lastShoot = shootingCooldowns[socket.id] || 0;
        if (now - lastShoot < 400) return; // Cooldown

        shootingCooldowns[socket.id] = now;

        const id = `fireball_${fireballIdCounter++}`;
        const direction = p.flipX ? -1 : 1;
        const fireball = {
            id,
            x: p.x + (direction * 20),
            y: p.y,
            vx: direction * 20,
            vy: 0,
            ownerId: socket.id,
            bounces: 0,
            life: 3000, // 3 seconds
            lastX: p.x + (direction * 20),
            stuckFrames: 0
        };

        activeFireballs[id] = fireball;
        io.emit('fireballSpawned', fireball);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

function spawnItem(x, y, type) {
    const id = `item_${itemIdCounter++}`;
    const item = { id, type, x, y, vx: ITEM_SPEED, vy: -5 };

    if (type === ITEM_TYPES.COIN) {
        // Coins pop and disappear
        io.emit('itemSpawned', item);
        return;
    }

    activeItems[id] = item;
    io.emit('itemSpawned', item);
}

function spawnEnemy(x, y, type) {
    const id = `enemy_${enemyIdCounter++}`;
    activeEnemies[id] = { id, type, x, y, vx: -ENEMY_SPEED, vy: 0 };
    io.emit('enemySpawned', activeEnemies[id]);
}

// Initial Spawn
getEnemySpawns().forEach(spawn => {
    spawnEnemy(spawn.x, spawn.y, spawn.type);
});

server.listen(3000, () => console.log('Server on port 3000'));
