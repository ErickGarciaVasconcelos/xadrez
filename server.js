const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rootDir = __dirname;
const htmlPath = path.resolve(rootDir, 'xadrez.html');

app.use(express.static(rootDir));

app.get('/', (req, res) => {
    res.sendFile(htmlPath);
});

const rooms = new Map();

function createGameState() {
    return {
        board: createInitialBoard(),
        currentPlayer: 'white',
        whiteWins: 0,
        blackWins: 0
    };
}

function createInitialBoard() {
    const BOARD_SIZE = 8;
    const board = Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill(null));
    const backRow = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
    
    for (let col = 0; col < BOARD_SIZE; col++) {
        board[0][col] = { type: backRow[col], color: 'black' };
        board[1][col] = { type: 'pawn', color: 'black' };
        board[6][col] = { type: 'pawn', color: 'white' };
        board[7][col] = { type: backRow[col], color: 'white' };
    }
    
    return board;
}

io.on('connection', (socket) => {
    console.log('Novo jogador conectado:', socket.id);
    
    let currentRoom = null;
    let playerColor = null;
    
    socket.on('joinRoom', (roomId) => {
        const roomIdStr = String(roomId).toUpperCase();
        
        const existingRoom = io.sockets.adapter.rooms.get(roomIdStr);
        const playerCount = existingRoom ? existingRoom.size : 0;
        
        if (playerCount >= 2) {
            socket.emit('roomFull');
            return;
        }
        
        socket.join(roomIdStr);
        currentRoom = roomIdStr;
        
        if (playerCount === 0) {
            playerColor = 'white';
            rooms.set(roomIdStr, createGameState());
            console.log(`Jogador ${socket.id} entrou na sala ${roomIdStr} como Brancas`);
        } else {
            playerColor = 'black';
            console.log(`Jogador ${socket.id} entrou na sala ${roomIdStr} como Pretas`);
        }
        
        socket.emit('playerColor', playerColor);
        socket.emit('gameState', rooms.get(roomIdStr));
        
        socket.to(roomIdStr).emit('opponentJoined', playerColor);
        
        const updatedRoom = io.sockets.adapter.rooms.get(roomIdStr);
        if (updatedRoom && updatedRoom.size === 2) {
            io.to(roomIdStr).emit('gameStart');
        }
    });
    
    socket.on('makeMove', (moveData) => {
        if (!currentRoom) return;
        
        const gameState = rooms.get(currentRoom);
        if (!gameState) return;
        
        gameState.board = moveData.board;
        // Usa o currentPlayer enviado pelo cliente (já contém o próximo jogador)
        gameState.currentPlayer = moveData.currentPlayer;
        
        socket.to(currentRoom).emit('opponentMove', {
            board: moveData.board,
            currentPlayer: moveData.currentPlayer
        });
    });
    
    socket.on('updateScore', (scoreData) => {
        if (!currentRoom) return;
        
        const gameState = rooms.get(currentRoom);
        if (!gameState) return;
        
        gameState.whiteWins = scoreData.whiteWins;
        gameState.blackWins = scoreData.blackWins;
        
        socket.to(currentRoom).emit('scoreUpdate', scoreData);
    });
    
    socket.on('resetGame', () => {
        if (!currentRoom) return;
        
        const gameState = rooms.get(currentRoom);
        if (gameState) {
            rooms.set(currentRoom, createGameState());
            io.to(currentRoom).emit('gameReset');
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Jogador desconectado:', socket.id);
        
        if (currentRoom) {
            socket.to(currentRoom).emit('opponentDisconnected');
            
            const room = io.sockets.adapter.rooms.get(currentRoom);
            if (!room || room.size === 0) {
                rooms.delete(currentRoom);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});