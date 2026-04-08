import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { mapConfig } from './mapData.js';

const app = express();
app.use(cors());
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const players = {}; 
const currentMap = {
    ...mapConfig,
    data: JSON.parse(JSON.stringify(mapConfig.data)) // Deep copy
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    players[socket.id] = { x: 400, y: 300, id: socket.id, anim: 'idle', flipX: false };

    // Send current map and players to new client
    socket.emit('initMap', currentMap);
    socket.emit('currentPlayers', players);
    
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('playerMovement', (movementData) => {
        players[socket.id].x = movementData.x;
        players[socket.id].y = movementData.y;
        players[socket.id].anim = movementData.anim;
        players[socket.id].flipX = movementData.flipX;
        socket.broadcast.emit('playerMoved', players[socket.id]);
    });

    socket.on('blockHit', (data) => {
        const { x, y } = data;
        // Check bounds
        if (y >= 0 && y < currentMap.data.length && x >= 0 && x < currentMap.data[0].length) {
            const tileIndex = currentMap.data[y][x];

            // 0: Brick, 1: Question Block, 3: Special Block
            if (tileIndex === 0 || tileIndex === 1 || tileIndex === 3) {
                let newTileIndex = tileIndex;
                
                // If it's a question block, it becomes an empty block (index 2)
                if (tileIndex === 1) {
                    newTileIndex = 2;
                    currentMap.data[y][x] = newTileIndex;
                }

                // Broadcast the hit to all clients (including the sender for animation)
                io.emit('tileUpdate', { x, y, oldTile: tileIndex, newTile: newTileIndex });
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

server.listen(3000, () => console.log('Server on port 3000'));
