import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // In production, replace with your client URL
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Store players state
const players = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create a new player and add it to our players object
    players[socket.id] = {
        x: 100,
        y: 100,
        playerId: socket.id,
        anim: 'stay'
    };

    // Send the players object to the new player
    socket.emit('currentPlayers', players);

    // Update all other players of the new player
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // When a player moves, update the player data
    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            players[socket.id].anim = movementData.anim;
            // Emit a message to all players about the player that moved
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });

    // When a player disconnects, remove them from our players object
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
        // Emit a message to all players to remove this player
        io.emit('playerDisconnected', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
