const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Memory Storage
const rooms = {};

const generateRoomCode = () => {
    let result = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Crear una Sala
    socket.on('create_room', (data) => {
        let roomCode = generateRoomCode();
        while (rooms[roomCode]) { roomCode = generateRoomCode(); } // ensure uniqueness

        const { nombre, avatar, configuracion } = data; // configuracion: { numPreguntas, dificultad, areas }
        
        rooms[roomCode] = {
            id: roomCode,
            hostId: socket.id,
            config: configuracion,
            state: 'lobby', // lobby, playing, finished
            players: [
                { id: socket.id, name: nombre, avatar: avatar, score: 0, isHost: true }
            ],
            game: {
                currentQuestionIndex: -1,
                maxQuestions: configuracion.numPreguntas || 10,
                timer: null,
                timeLeft: 0,
                answersThisRound: {}, // { playerId: { time: ms, correct: bool } }
            }
        };

        socket.join(roomCode);
        socket.emit('room_created', { roomCode, room: rooms[roomCode] });
        console.log(`Room ${roomCode} created by ${nombre}`);
    });

    // Unirse a una Sala
    socket.on('join_room', (data) => {
        const { roomCode, nombre, avatar } = data;
        const room = rooms[roomCode];

        if (!room) {
            return socket.emit('error_msg', 'La sala no existe.');
        }

        if (room.state !== 'lobby') {
            return socket.emit('error_msg', 'La partida ya ha comenzado.');
        }

        const existingPlayer = room.players.find(p => p.name === nombre);
        if (existingPlayer) {
            return socket.emit('error_msg', 'Ya hay un jugador con ese nombre.');
        }

        room.players.push({
            id: socket.id,
            name: nombre,
            avatar: avatar,
            score: 0,
            isHost: false
        });

        socket.join(roomCode);
        socket.emit('room_joined', { roomCode, room });
        
        // Notify others
        io.to(roomCode).emit('player_joined', { players: room.players });
        console.log(`${nombre} joined ${roomCode}`);
    });

    // Iniciar el Juego (Solo Host)
    socket.on('start_game', (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        
        if (!room || room.hostId !== socket.id) return;
        
        room.state = 'playing';
        io.to(roomCode).emit('game_starting', { message: '¡El host inició la partida!' });
        
        // Comienza la primera pregunta en 3 segundos
        setTimeout(() => {
            nextQuestion(roomCode);
        }, 3000);
    });

    // Recibir respuesta de un jugador
    socket.on('submit_answer', (data) => {
        const { roomCode, isCorrect, timeUsedMs } = data;
        const room = rooms[roomCode];
        
        if (!room || room.state !== 'playing' || !room.game.answersThisRound) return;

        // Save answer
        if (!room.game.answersThisRound[socket.id]) {
            room.game.answersThisRound[socket.id] = { isCorrect, timeUsedMs };
            io.to(roomCode).emit('player_answered', { playerId: socket.id });

            // Check if all players answered
            if (Object.keys(room.game.answersThisRound).length === room.players.length) {
                // Todos respondieron. Terminar tiempo temprano.
                clearInterval(room.game.timer);
                endQuestion(roomCode);
            }
        }
    });

    // Manejar desconexión
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Remove from rooms
        for (const [code, room] of Object.entries(rooms)) {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const isHost = room.players[playerIndex].isHost;
                room.players.splice(playerIndex, 1);
                
                if (room.players.length === 0) {
                    delete rooms[code]; // Delete empty room
                    console.log(`Room ${code} deleted (empty)`);
                } else {
                    if (isHost) {
                        // Transfer host rights
                        room.players[0].isHost = true;
                        room.hostId = room.players[0].id;
                        io.to(code).emit('host_changed', { newHostId: room.hostId });
                    }
                    io.to(code).emit('player_left', { players: room.players });
                }
            }
        }
    });

    // -------- Funciones Privadas de Control de Juego --------
    function nextQuestion(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        room.game.currentQuestionIndex++;
        room.game.answersThisRound = {};

        if (room.game.currentQuestionIndex >= room.game.maxQuestions) {
            // Juego Terminado
            room.state = 'finished';
            // Ordenar por puntaje
            room.players.sort((a, b) => b.score - a.score);
            io.to(roomCode).emit('match_ended', { ranking: room.players });
            return;
        }

        room.game.timeLeft = 15; // 15 segundos por pregunta
        io.to(roomCode).emit('new_question', { questionIndex: room.game.currentQuestionIndex, timeTotal: 15 });

        // Ticking timer
        room.game.timer = setInterval(() => {
            room.game.timeLeft--;
            io.to(roomCode).emit('timer_tick', { timeLeft: room.game.timeLeft });

            if (room.game.timeLeft <= 0) {
                clearInterval(room.game.timer);
                endQuestion(roomCode);
            }
        }, 1000);
    }

    function endQuestion(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        // Evaluar puntajes
        const resultsInfo = [];
        room.players.forEach(p => {
             const answer = room.game.answersThisRound[p.id];
             let pointsGained = 0;
             if (answer && answer.isCorrect) {
                 // Formula de Puntos: 100 base + (velocidad * 50)
                 // Si timeUsedMs = 2000ms (2s) de 15000ms. Ratio = (15000-2000)/15000 = 0.86
                 // 100 + (0.86 * 100) = 186 pts.
                 const totalTimeMs = 15000;
                 const timeSavedRatio = Math.max(0, (totalTimeMs - answer.timeUsedMs) / totalTimeMs);
                 pointsGained = 100 + Math.floor(timeSavedRatio * 100);
                 p.score += pointsGained;
             }
             resultsInfo.push({
                 id: p.id,
                 name: p.name,
                 isCorrect: answer ? answer.isCorrect : false,
                 pointsGained: pointsGained,
                 totalScore: p.score
             });
        });

        // Ordenar current results para el liderato
        room.players.sort((a, b) => b.score - a.score);

        io.to(roomCode).emit('question_results', {
            results: resultsInfo,
            leaderboard: room.players
        });

        // Esperar 4 segundos mostrando ranking, luego dar proxima pregunta
        setTimeout(() => {
            nextQuestion(roomCode);
        }, 4000);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
