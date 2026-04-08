import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { mapConfig, TILE, ITEM_TYPES, getBlockContent } from './map.js';

const app = express();
app.use(cors());
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const players = {};
const activeItems = {}; // { [id]: { type, x, y, vx, vy, ... } }
let itemIdCounter = 0;

const currentMap = {
    ...mapConfig,
    data: JSON.parse(JSON.stringify(mapConfig.data)) // Deep copy
};

// Physics Constants
const GRAVITY = 0.8;
const ITEM_SPEED = 3;
const TILE_SIZE = 64;

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
}, 33); // ~30 FPS

function isSolid(x, y) {
    if (x < 0 || x >= currentMap.width || y < 0 || y >= currentMap.height) return false;
    const tile = currentMap.data[y][x];
    return tile !== -1;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    players[socket.id] = { x: 150, y: 700, id: socket.id, anim: 'idle', flipX: false, state: 0 };

    // Send current state to new client
    socket.emit('initMap', currentMap);
    socket.emit('currentPlayers', players);
    socket.emit('initItems', activeItems);

    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('playerMovement', (movementData) => {
        players[socket.id].x = movementData.x;
        players[socket.id].y = movementData.y;
        players[socket.id].anim = movementData.anim;
        players[socket.id].flipX = movementData.flipX;
        players[socket.id].state = movementData.state !== undefined ? movementData.state : players[socket.id].state;
        socket.broadcast.emit('playerMoved', players[socket.id]);
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
                    const itemType = getBlockContent(x, y);
                    if (itemType !== ITEM_TYPES.NONE) {
                        spawnItem(x * TILE_SIZE + 32, y * TILE_SIZE - 32, itemType);
                    }
                }

                io.emit('tileUpdate', { x, y, oldTile: tileIndex, newTile: newTileIndex });
            }
        }
    });

    socket.on('collectItem', (itemId) => {
        if (activeItems[itemId]) {
            const item = activeItems[itemId];
            const itemType = item.type;

            // Power-up logic
            if (itemType === ITEM_TYPES.MUSHROOM) {
                if (players[socket.id].state === 0) players[socket.id].state = 1;
            } else if (itemType === ITEM_TYPES.FIRE_FLOWER) {
                players[socket.id].state = 2;
            }

            delete activeItems[itemId];
            io.emit('itemDestroyed', { itemId, collectorId: socket.id, itemType, newState: players[socket.id].state });
        }
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

server.listen(3000, () => console.log('Server on port 3000'));
