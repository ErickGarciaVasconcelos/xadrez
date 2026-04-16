const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const cors = require('cors');
const mercadopago = require('mercadopago');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rootDir = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : rootDir;
const htmlPath = path.resolve(rootDir, 'xadrez.html');
const usersFilePath = path.resolve(dataDir, 'users.json');
const tournamentsFilePath = path.resolve(dataDir, 'tournaments.json');
const paymentsFilePath = path.resolve(dataDir, 'payments.json');
const betsFilePath = path.resolve(dataDir, 'bets.json');
const JWT_SECRET = 'your-secret-key-change-in-production';
const HOUSE_FEE_PERCENTAGE = 0.05; // 5% para a banca
const ALLOWED_BET_AMOUNTS = [5, 10, 15, 20];

// Armazenamento em memória para apostas ativas (usará loadBets/saveBets)

// Configuração do Mercado Pago - ADICIONE SUAS CREDENCIAIS AQUI
const MERCADO_PAGO_TOKEN = process.env.MERCADO_PAGO_TOKEN || 'SEU_ACCESS_TOKEN_AQUI';

// Configurar o cliente do Mercado Pago
mercadopago.MercadoPago = mercadopago;

app.use(cors());
app.use(express.json());

function ensureDataFile(filePath, rootKey) {
    if (fs.existsSync(filePath)) {
        return;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ [rootKey]: [] }, null, 2));
}

ensureDataFile(usersFilePath, 'users');
ensureDataFile(tournamentsFilePath, 'tournaments');
ensureDataFile(paymentsFilePath, 'payments');
ensureDataFile(betsFilePath, 'bets');

// ===== FUNÇÕES AUXILIARES (ANTES DAS ROTAS) =====

// Função para ler usuários do arquivo
function loadUsers() {
    try {
        const data = fs.readFileSync(usersFilePath, 'utf-8');
        return JSON.parse(data).users;
    } catch (err) {
        return [];
    }
}

// Função para salvar usuários no arquivo
function saveUsers(users) {
    fs.writeFileSync(usersFilePath, JSON.stringify({ users }, null, 2));
}

// Função para ler pagamentos do arquivo
function loadPayments() {
    try {
        const data = fs.readFileSync(paymentsFilePath, 'utf-8');
        return JSON.parse(data).payments || [];
    } catch (err) {
        return [];
    }
}

// Função para salvar pagamentos no arquivo
function savePayments(payments) {
    fs.writeFileSync(paymentsFilePath, JSON.stringify({ payments }, null, 2));
}

// Função para registrar um pagamento
function recordPayment(paymentData) {
    const payments = loadPayments();
    const newPayment = {
        id: paymentData.preferenceId,
        userId: paymentData.userId,
        username: paymentData.username,
        tournamentId: paymentData.tournamentId,
        amount: paymentData.amount,
        houseFee: paymentData.houseFee,
        playerAmount: paymentData.playerAmount,
        status: paymentData.status || 'pending',
        paymentMethod: paymentData.paymentMethod || 'unknown',
        createdAt: new Date().toISOString(),
        confirmedAt: null,
        mercadoPagoId: null
    };
    
    payments.push(newPayment);
    savePayments(payments);
    
    console.log(`[REGISTRO] Novo pagamento registrado: ID: ${newPayment.id} | Usuário: ${newPayment.username} | Método: ${newPayment.paymentMethod.toUpperCase()} | Valor: R$ ${newPayment.amount} | Banca: R$ ${newPayment.houseFee} | Jogadores: R$ ${newPayment.playerAmount}`);
}

function getMercadoPagoInitPoint(preferenceData) {
    if (!preferenceData || !preferenceData.id) {
        return null;
    }

    return (
        preferenceData.init_point ||
        preferenceData.initPoint ||
        preferenceData.sandbox_init_point ||
        `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${preferenceData.id}`
    );
}

// ===== GERENCIAMENTO DE TORNEIOS =====

function loadTournaments() {
    try {
        const data = fs.readFileSync(tournamentsFilePath, 'utf-8');
        return JSON.parse(data).tournaments || [];
    } catch (err) {
        return [];
    }
}

function saveTournaments(tournaments) {
    fs.writeFileSync(tournamentsFilePath, JSON.stringify({ tournaments }, null, 2));
}

function loadTournamentParticipants(tournamentId) {
    try {
        const data = fs.readFileSync(tournamentsFilePath, 'utf-8');
        const tournaments = JSON.parse(data).tournaments || [];
        const tournament = tournaments.find(t => t.id === tournamentId);
        return tournament ? tournament.participants : [];
    } catch (err) {
        return [];
    }
}

function addParticipantToTournament(tournamentId, userId, username) {
    const tournaments = loadTournaments();
    const tournament = tournaments.find(t => t.id === tournamentId);
    
    if (tournament) {
        if (!tournament.participants) {
            tournament.participants = [];
        }
        if (!tournament.participants.find(p => p.userId === userId)) {
            tournament.participants.push({
                userId,
                username,
                joinedAt: new Date().toISOString(),
                status: 'paid'
            });
            saveTournaments(tournaments);
            
            // Verifica se o torneo está cheio para iniciar
            if (tournament.participants.length >= tournament.maxParticipants) {
                startTournament(tournamentId);
            }
            
            return true;
        }
    }
    return false;
}

// ===== SISTEMA DE TORNEIOS ELIMINATÓRIOS =====

function startTournament(tournamentId) {
    const tournaments = loadTournaments();
    const tournament = tournaments.find(t => t.id === tournamentId);
    
    if (!tournament) return;
    
    tournament.status = 'in_progress';
    tournament.currentRound = 1;
    tournament.totalRounds = Math.ceil(Math.log2(tournament.maxParticipants));
    tournament.matches = [];
    
    // Embaralhar participantes
    const participants = [...tournament.participants].sort(() => Math.random() - 0.5);
    
    // Criar primeira rodada (oitavas, quartas, semi, final)
    const roundMatches = [];
    for (let i = 0; i < participants.length; i += 2) {
        const matchId = `MATCH_${tournamentId}_R1_${(i/2)+1}`;
        roundMatches.push({
            id: matchId,
            round: 1,
            matchNumber: (i/2) + 1,
            player1: participants[i] ? { userId: participants[i].userId, username: participants[i].username } : null,
            player2: participants[i+1] ? { userId: participants[i+1].userId, username: participants[i+1].username } : null,
            winner: null,
            roomId: `TOURNAMENT_${matchId}`,
            status: 'pending', // pending, in_progress, completed
            startTime: null,
            endTime: null
        });
    }
    
    tournament.matches = roundMatches;
    saveTournaments(tournaments);
    
    console.log(`[TORNEIO] Torneio ${tournamentId} iniciado com ${participants.length} jogadores | ${roundMatches.length} partidas na Rodada 1`);
}

function getNextRoundMatches(tournamentId) {
    const tournaments = loadTournaments();
    const tournament = tournaments.find(t => t.id === tournamentId);
    if (!tournament) return [];
    
    const currentRound = tournament.currentRound;
    const currentMatches = tournament.matches.filter(m => m.round === currentRound);
    const completedMatches = currentMatches.filter(m => m.status === 'completed' && m.winner);
    
    if (completedMatches.length !== currentMatches.length) {
        return []; // Nem todas as partidas foram completadas
    }
    
    // Criar próxima rodada
    const nextRound = currentRound + 1;
    const nextMatches = [];
    
    for (let i = 0; i < completedMatches.length; i += 2) {
        if (i + 1 >= completedMatches.length) break;
        
        const matchId = `MATCH_${tournamentId}_R${nextRound}_${(i/2)+1}`;
        nextMatches.push({
            id: matchId,
            round: nextRound,
            matchNumber: (i/2) + 1,
            player1: { userId: completedMatches[i].winner.userId, username: completedMatches[i].winner.username },
            player2: { userId: completedMatches[i+1].winner.userId, username: completedMatches[i+1].winner.username },
            winner: null,
            roomId: `TOURNAMENT_${matchId}`,
            status: 'pending',
            startTime: null,
            endTime: null
        });
    }
    
    return nextMatches;
}

function advanceTournamentRound(tournamentId) {
    const tournaments = loadTournaments();
    const tournament = tournaments.find(t => t.id === tournamentId);
    
    if (!tournament) return null;
    
    const nextMatches = getNextRoundMatches(tournamentId);
    
    if (nextMatches.length === 0) {
        // Verificar se é a última rodada (final)
        if (tournament.currentRound === tournament.totalRounds) {
            tournament.status = 'completed';
            const finalMatch = tournament.matches.find(m => m.round === tournament.currentRound);
            if (finalMatch && finalMatch.winner) {
                tournament.winner = finalMatch.winner;
                console.log(`[TORNEIO] Torneio ${tournamentId} finalizado! Vencedor: ${finalMatch.winner.username}`);
            }
        }
        saveTournaments(tournaments);
        return null;
    }
    
    tournament.currentRound++;
    tournament.matches.push(...nextMatches);
    saveTournaments(tournaments);
    
    console.log(`[TORNEIO] Rodada ${tournament.currentRound} iniciada no torneio ${tournamentId} | ${nextMatches.length} partidas`);
    
    return nextMatches;
}

function finishMatch(tournamentId, matchId, winner) {
    const tournaments = loadTournaments();
    const tournament = tournaments.find(t => t.id === tournamentId);
    
    if (!tournament) return null;
    
    const match = tournament.matches.find(m => m.id === matchId);
    if (!match) return null;
    
    match.winner = winner;
    match.status = 'completed';
    match.endTime = new Date().toISOString();
    
    saveTournaments(tournaments);
    
    console.log(`[TORNEIO] Partida ${matchId} finalizada | Vencedor: ${winner.username}`);
    
    // Verificar se a rodada foi completada
    const roundMatches = tournament.matches.filter(m => m.round === tournament.currentRound);
    const completedInRound = roundMatches.filter(m => m.status === 'completed');
    
    if (roundMatches.length === completedInRound.length) {
        // Avançar para próxima rodada
        setTimeout(() => advanceTournamentRound(tournamentId), 1000);
    }
    
    return match;
}

// Funções para sistema de apostas
let activeBetsData = [];

function loadBets() {
    try {
        const data = fs.readFileSync(betsFilePath, 'utf-8');
        activeBetsData = JSON.parse(data).bets || [];
        return activeBetsData;
    } catch (err) {
        activeBetsData = [];
        return [];
    }
}

function saveBets(bets) {
    activeBetsData = bets;
    fs.writeFileSync(betsFilePath, JSON.stringify({ bets }, null, 2));
}

function createBet(challengerId, challengerName, opponentId, opponentName, amount) {
    loadBets(); // Garante que os dados foram carregados
    const parsedAmount = parseFloat(amount);

    if (!ALLOWED_BET_AMOUNTS.includes(parsedAmount)) {
        return null;
    }

    const betId = 'BET_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const bet = {
        id: betId,
        challenger: { id: challengerId, name: challengerName },
        opponent: { id: opponentId, name: opponentName },
        amount: parsedAmount,
        houseFee: parseFloat((parsedAmount * HOUSE_FEE_PERCENTAGE).toFixed(2)),
        prizeAmount: parseFloat((parsedAmount * 2 - parsedAmount * HOUSE_FEE_PERCENTAGE * 2).toFixed(2)),
        status: 'pending', // pending, accepted, in_progress, completed, cancelled
        winner: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        gameRoomId: null
    };
    activeBetsData.push(bet);
    saveBets(activeBetsData);
    return bet;
}

function acceptBet(betId, userId) {
    loadBets();
    const betIndex = activeBetsData.findIndex(b => b.id === betId);
    if (betIndex === -1) return null;
    if (activeBetsData[betIndex].opponent.id !== userId) return null;
    
    activeBetsData[betIndex].status = 'accepted';
    activeBetsData[betIndex].updatedAt = new Date().toISOString();
    saveBets(activeBetsData);
    return activeBetsData[betIndex];
}

function cancelBet(betId, userId) {
    loadBets();
    const betIndex = activeBetsData.findIndex(b => b.id === betId);
    if (betIndex === -1) return null;
    if (activeBetsData[betIndex].challenger.id !== userId) return null;
    if (activeBetsData[betIndex].status !== 'pending') return null;
    
    activeBetsData[betIndex].status = 'cancelled';
    activeBetsData[betIndex].updatedAt = new Date().toISOString();
    saveBets(activeBetsData);
    return activeBetsData[betIndex];
}

// Middleware para verificar token JWT
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

// ===== ROTAS DE API =====
 // Essas rotas precisam vir ANTES de app.use(express.static)
 // para que /api/* seja processado como rota, não como arquivo estático

 // Rota para buscar usuário por username (para sistema de apostas)
 app.get('/api/users/search', (req, res) => {
     try {
         const { username } = req.query;
         if (!username) {
             return res.status(400).json({ error: 'Nome de usuário não fornecido' });
         }
         
         const users = loadUsers();
         const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
         
         if (!user) {
             return res.status(404).json({ error: 'Usuário não encontrado' });
         }
         
         res.json({
             success: true,
             user: {
                 id: user.id,
                 username: user.username
             }
         });
     } catch (err) {
         console.error('Erro ao buscar usuário:', err);
         res.status(500).json({ error: 'Erro ao buscar usuário' });
     }
 });

 // Rota para verificar se o token é válido
app.get('/api/verify-token', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1] || req.query.token;
        
        if (!token) {
            return res.status(401).json({ valid: false, error: 'Token não fornecido' });
        }

        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(401).json({ valid: false, error: 'Token inválido ou expirado' });
        }

        // Verifica se o usuário ainda existe no banco de dados
        const users = loadUsers();
        const user = users.find(u => u.id === decoded.id);

        if (!user) {
            return res.status(401).json({ valid: false, error: 'Usuário não encontrado' });
        }

        res.json({ 
            valid: true, 
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                wins: user.wins,
                losses: user.losses
            }
        });
    } catch (err) {
        console.error('Erro ao verificar token:', err);
        res.status(500).json({ valid: false, error: 'Erro ao verificar token' });
    }
});

// Criar aposta
app.post('/api/bet/create', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(401).json({ error: 'Não autorizado' });
        }

        const { opponentName, amount } = req.body;
        const parsedAmount = parseFloat(amount);

        if (!opponentName || !Number.isFinite(parsedAmount)) {
            return res.status(400).json({ error: 'Dados incompletos: nome do oponente e valor são obrigatórios' });
        }

        if (!ALLOWED_BET_AMOUNTS.includes(parsedAmount)) {
            return res.status(400).json({ error: 'Valor inválido. Permitidos: 5, 10, 15 ou 20.' });
        }

        const users = loadUsers();
        const opponent = users.find(u => u.username.toLowerCase() === opponentName.toLowerCase());

        if (!opponent) {
            return res.status(404).json({ error: 'Usuário oponente não encontrado' });
        }

        if (decoded.id === opponent.id) {
            return res.status(400).json({ error: 'Você não pode apostar contra si mesmo' });
        }

        const bet = createBet(decoded.id, decoded.username, opponent.id, opponent.username, parsedAmount);
        if (!bet) {
            return res.status(400).json({ error: 'Não foi possível criar a aposta' });
        }

        console.log(`[APOSTA] Nova aposta criada: ${bet.id} | ${decoded.username} vs ${opponent.username} | R$ ${parsedAmount}`);

        res.json({
            success: true,
            bet
        });
    } catch (err) {
        console.error('Erro ao criar aposta:', err);
        res.status(500).json({ error: 'Erro ao criar aposta' });
    }
});

// Listar apostas do usuário
app.get('/api/bets/my-bets', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(401).json({ error: 'Não autorizado' });
        }

        loadBets();
        const userBets = activeBetsData
            .filter(bet => bet.challenger.id === decoded.id || bet.opponent.id === decoded.id)
            .map(bet => ({
                id: bet.id,
                challenger: bet.challenger,
                opponent: bet.opponent,
                amount: bet.amount,
                houseFee: bet.houseFee,
                status: bet.status,
                createdAt: bet.createdAt
            }));

        res.json({
            success: true,
            bets: userBets
        });
    } catch (err) {
        console.error('Erro ao listar apostas:', err);
        res.status(500).json({ error: 'Erro ao listar apostas' });
    }
});

// Aceitar aposta
app.post('/api/bet/accept', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(401).json({ error: 'Não autorizado' });
        }

        const { betId } = req.body;
        const bet = acceptBet(betId, decoded.id);

        if (!bet) {
            return res.status(404).json({ error: 'Aposta não encontrada ou já aceita' });
        }

        console.log(`[APOSTA] Aposta aceita: ${betId} | ${decoded.username}`);
        io.emit('betAccepted', bet);

        res.json({
            success: true,
            bet
        });
    } catch (err) {
        console.error('Erro ao aceitar aposta:', err);
        res.status(500).json({ error: 'Erro ao aceitar aposta' });
    }
});

// Cancelar aposta
app.post('/api/bet/cancel', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(401).json({ error: 'Não autorizado' });
        }

        const { betId } = req.body;
        const bet = cancelBet(betId, decoded.id);

        if (!bet) {
            return res.status(404).json({ error: 'Aposta não encontrada ou já aceita' });
        }

        console.log(`[APOSTA] Aposta cancelada: ${betId}`);

        res.json({
            success: true,
            bet
        });
    } catch (err) {
        console.error('Erro ao cancelar aposta:', err);
        res.status(500).json({ error: 'Erro ao cancelar aposta' });
    }
});

// ===== ROTAS DE PAGAMENTO =====

// Rota para criar preferência de pagamento (PIX ou Cartão)
app.post('/api/create-payment', async (req, res) => {
    try {
        const { tournamentId, userId, username, amount, description, paymentMethod } = req.body;

        if (!tournamentId || !userId || !amount) {
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        if (!MERCADO_PAGO_TOKEN || MERCADO_PAGO_TOKEN === 'SEU_ACCESS_TOKEN_AQUI') {
            return res.status(500).json({ 
                error: 'Mercado Pago não configurado. Configure MERCADO_PAGO_TOKEN em .env' 
            });
        }

        // Valida o método de pagamento
        const validPaymentMethods = ['pix', 'card'];
        const selectedMethod = validPaymentMethods.includes(paymentMethod) ? paymentMethod : 'unknown';

        console.log(`[PAGAMENTO] Novo pagamento solicitado: ${username} (ID: ${userId}) - Método: ${selectedMethod.toUpperCase()}`);

        // Calcula a taxa da banca (5%)
        const parsedAmount = parseFloat(amount);
        const houseFee = parseFloat((parsedAmount * HOUSE_FEE_PERCENTAGE).toFixed(2));
        const playerAmount = parseFloat((parsedAmount - houseFee).toFixed(2));

        // Cria a preferência de pagamento usando a API REST
        const preference = {
            items: [
                {
                    id: tournamentId,
                    title: description || 'Entrada no Torneio de Xadrez',
                    description: `Torneio ID: ${tournamentId} | Método: ${selectedMethod === 'pix' ? 'PIX' : 'Cartão'}`,
                    quantity: 1,
                    unit_price: parsedAmount
                }
            ],
            payer: {
                email: 'tournament@xadrez-online.com'
            },
            back_urls: {
                success: `${process.env.BASE_URL || 'http://localhost:3000'}/payment-success?tournament=${tournamentId}&user=${userId}&preference=`,
                failure: `${process.env.BASE_URL || 'http://localhost:3000'}/payment-failure`,
                pending: `${process.env.BASE_URL || 'http://localhost:3000'}/payment-pending`
            },
            notification_url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/webhook-payment`,
            metadata: {
                userId,
                username,
                tournamentId,
                paymentType: 'tournament',
                paymentMethod: selectedMethod,
                houseFee: houseFee,
                playerAmount: playerAmount
            }
        };

        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MERCADO_PAGO_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(preference)
        });

        const data = await response.json();

        if (response.ok && data.id) {
            const initPoint = getMercadoPagoInitPoint(data);

            // Registra o pagamento pendente
            recordPayment({
                preferenceId: data.id,
                userId,
                username,
                tournamentId,
                amount: parsedAmount,
                houseFee,
                playerAmount,
                status: 'pending',
                paymentMethod: selectedMethod
            });

            console.log(`[PAGAMENTO] ✓ Preferência criada: ${data.id} | Valor: R$ ${parsedAmount.toFixed(2)} | Banca: R$ ${houseFee.toFixed(2)}`);

            res.json({
                success: true,
                preferenceId: data.id,
                initPoint,
                amount: parsedAmount,
                houseFee: houseFee,
                playerAmount: playerAmount,
                paymentMethod: selectedMethod
            });
        } else {
            console.error('Erro do Mercado Pago:', data);
            res.status(500).json({ error: 'Erro ao gerar link de pagamento' });
        }

    } catch (err) {
        console.error('Erro ao criar pagamento:', err);
        res.status(500).json({ error: 'Erro ao processar pagamento' });
    }
});

// Rota para criar pagamento de aposta (mesmo fluxo do torneio)
app.post('/api/bet/create-payment', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(401).json({ error: 'Não autorizado' });
        }

        const { betId, paymentMethod } = req.body;
        if (!betId) {
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        loadBets();
        const bet = activeBetsData.find(b => b.id === betId && b.challenger && b.opponent);

        if (!bet) {
            return res.status(404).json({ error: 'Aposta não encontrada' });
        }

        if (bet.challenger.id !== decoded.id && bet.opponent.id !== decoded.id) {
            return res.status(403).json({ error: 'Você não participa desta aposta' });
        }

        if (bet.status !== 'accepted') {
            return res.status(400).json({ error: 'Aposta precisa estar aceita primeiro' });
        }

        if (!MERCADO_PAGO_TOKEN || MERCADO_PAGO_TOKEN === 'SEU_ACCESS_TOKEN_AQUI') {
            return res.status(500).json({
                error: 'Mercado Pago não configurado. Configure MERCADO_PAGO_TOKEN em .env'
            });
        }

        const validPaymentMethods = ['pix', 'card'];
        const selectedMethod = validPaymentMethods.includes(paymentMethod) ? paymentMethod : 'unknown';
        const parsedAmount = parseFloat(bet.amount);

        if (!ALLOWED_BET_AMOUNTS.includes(parsedAmount)) {
            return res.status(400).json({ error: 'Valor de aposta inválido. Permitidos: 5, 10, 15 ou 20.' });
        }

        console.log(`[APOSTA-PAGAMENTO] Novo pagamento solicitado: ${decoded.username} | Aposta: ${betId} | Método: ${selectedMethod.toUpperCase()}`);

        const preference = {
            items: [
                {
                    id: betId,
                    title: `Aposta de Xadrez: ${bet.challenger.name} vs ${bet.opponent.name}`,
                    description: `Aposta ID: ${betId} | Método: ${selectedMethod === 'pix' ? 'PIX' : 'Cartão'}`,
                    quantity: 1,
                    unit_price: parsedAmount
                }
            ],
            payer: {
                email: 'bet@xadrez-online.com'
            },
            back_urls: {
                success: `${process.env.BASE_URL || 'http://localhost:3000'}/bet-success?bet=${betId}&user=${decoded.id}&preference=`,
                failure: `${process.env.BASE_URL || 'http://localhost:3000'}/bet-failure`,
                pending: `${process.env.BASE_URL || 'http://localhost:3000'}/bet-pending`
            },
            notification_url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/webhook-bet-payment`,
            metadata: {
                paymentType: 'bet',
                betId: betId,
                userId: decoded.id,
                username: decoded.username,
                paymentMethod: selectedMethod,
                amount: parsedAmount,
                houseFee: bet.houseFee,
                prizeAmount: bet.prizeAmount
            }
        };

        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MERCADO_PAGO_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(preference)
        });

        const data = await response.json();

        if (response.ok && data.id) {
            const initPoint = getMercadoPagoInitPoint(data);

            const payments = loadPayments();
            payments.push({
                id: data.id,
                paymentType: 'bet',
                betId: betId,
                userId: decoded.id,
                username: decoded.username,
                amount: parsedAmount,
                houseFee: bet.houseFee,
                prizeAmount: bet.prizeAmount,
                status: 'pending',
                paymentMethod: selectedMethod,
                createdAt: new Date().toISOString(),
                confirmedAt: null,
                mercadoPagoId: null
            });
            savePayments(payments);

            console.log(`[APOSTA-PAGAMENTO] ✓ Preferência criada: ${data.id} | Valor: R$ ${parsedAmount.toFixed(2)}`);

            res.json({
                success: true,
                preferenceId: data.id,
                initPoint,
                amount: parsedAmount,
                houseFee: bet.houseFee,
                prizeAmount: bet.prizeAmount,
                paymentMethod: selectedMethod
            });
        } else {
            console.error('Erro do Mercado Pago (aposta):', data);
            res.status(500).json({ error: 'Erro ao gerar link de pagamento' });
        }
    } catch (err) {
        console.error('Erro ao criar pagamento de aposta:', err);
        res.status(500).json({ error: 'Erro ao processar pagamento' });
    }
});

// Webhook para pagamento de aposta
app.post('/api/webhook-bet-payment', async (req, res) => {
    try {
        const { action, data } = req.query;

        if (action === 'payment.created' || action === 'payment.updated') {
            const paymentId = data?.id;
            if (!paymentId) {
                return res.json({ success: true });
            }

            console.log(`[APOSTA-WEBHOOK] Notificação Mercado Pago: ID: ${paymentId}`);

            // Busca o pagamento de aposta pelo ID da preferência
            const payments = loadPayments();
            const paymentRecord = payments.find(p => p.paymentType === 'bet' && p.id === paymentId);
            
            if (paymentRecord) {
                paymentRecord.status = 'approved';
                paymentRecord.mercadoPagoId = paymentId;
                paymentRecord.confirmedAt = new Date().toISOString();
                savePayments(payments);

                // Atualiza o status da aposta
                loadBets();
                const betIndex = activeBetsData.findIndex(b => b.id === paymentRecord.betId);
                if (betIndex !== -1) {
                    activeBetsData[betIndex].status = 'in_progress';
                    activeBetsData[betIndex].updatedAt = new Date().toISOString();
                    saveBets(activeBetsData);
                    
                    console.log(`[APOSTA] ✓ Aposta em andamento: ${paymentRecord.betId} | Valor: R$ ${activeBetsData[betIndex].amount}`);
                    
                    // Notifica via Socket.IO
                    io.emit('betInProgress', activeBetsData[betIndex]);
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[APOSTA-WEBHOOK] Erro:', err);
        res.json({ success: true });
    }
});

// Iniciar partida de uma aposta
app.post('/api/bet/start-game', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(401).json({ error: 'Não autorizado' });
        }

        const { betId } = req.body;
        loadBets();
        const betIndex = activeBetsData.findIndex(b => b.id === betId);
        
        if (betIndex === -1) {
            return res.status(404).json({ error: 'Aposta não encontrada' });
        }

        const bet = activeBetsData[betIndex];
        
        if (bet.status !== 'in_progress') {
            return res.status(400).json({ error: 'Aposta precisa estar em andamento' });
        }

        if (bet.challenger.id !== decoded.id && bet.opponent.id !== decoded.id) {
            return res.status(403).json({ error: 'Você não participa desta aposta' });
        }

        // Gera uma sala única para a aposta
        const roomId = 'BET_' + betId;
        activeBetsData[betIndex].gameRoomId = roomId;
        saveBets(activeBetsData);

        console.log(`[APOSTA] Partida iniciada: ${betId} | Sala: ${roomId}`);

        res.json({
            success: true,
            roomId: roomId,
            bet: activeBetsData[betIndex]
        });
    } catch (err) {
        console.error('Erro ao iniciar partida:', err);
        res.status(500).json({ error: 'Erro ao iniciar partida' });
    }
});

// Finalizar aposta com vencedor
app.post('/api/bet/complete', (req, res) => {
    try {
        const { betId, winnerId } = req.body;
        
        loadBets();
        const betIndex = activeBetsData.findIndex(b => b.id === betId);
        
        if (betIndex === -1) {
            return res.status(404).json({ error: 'Aposta não encontrada' });
        }

        const bet = activeBetsData[betIndex];
        
        bet.status = 'completed';
        bet.winner = winnerId;
        bet.completedAt = new Date().toISOString();
        bet.updatedAt = new Date().toISOString();
        
        // Salva no histórico
        const allBets = loadBets();
        const historyIndex = allBets.findIndex(b => b.betId === betId);
        if (historyIndex !== -1) {
            allBets[historyIndex] = { ...allBets[historyIndex], ...bet };
        } else {
            allBets.push(bet);
        }
        saveBets(allBets);

        console.log(`[APOSTA] ✓ Aposta finalizada: ${betId} | Vencedor: ${winnerId} | Prêmio: R$ ${bet.prizeAmount}`);

        io.emit('betCompleted', bet);

        res.json({
            success: true,
            bet: bet
        });
    } catch (err) {
        console.error('Erro ao finalizar aposta:', err);
        res.status(500).json({ error: 'Erro ao finalizar aposta' });
    }
});

// Rota de Signup
app.post('/api/signup', async (req, res) => {
    try {
        const { username, password, email } = req.body;

        if (!username || !password || !email) {
            return res.status(400).json({ error: 'Username, password e email são obrigatórios' });
        }

        const users = loadUsers();
        
        // Verifica se o usuário já existe
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ error: 'Usuário já existe' });
        }

        if (users.find(u => u.email === email)) {
            return res.status(400).json({ error: 'Email já cadastrado' });
        }

        // Hash da senha
        const hashedPassword = await bcryptjs.hash(password, 10);

        const newUser = {
            id: Date.now().toString(),
            username,
            email,
            password: hashedPassword,
            wins: 0,
            losses: 0,
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        saveUsers(users);

        // Gera JWT token
        const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            success: true,
            token,
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                wins: newUser.wins,
                losses: newUser.losses
            }
        });
    } catch (err) {
        console.error('Erro no signup:', err);
        res.status(500).json({ error: 'Erro ao criar conta' });
    }
});

// Rota de Login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username e password são obrigatórios' });
        }

        const users = loadUsers();
        const user = users.find(u => u.username === username);

        if (!user) {
            return res.status(401).json({ error: 'Usuário não encontrado' });
        }

        // Verifica a senha
        const passwordMatch = await bcryptjs.compare(password, user.password);

        if (!passwordMatch) {
            return res.status(401).json({ error: 'Senha incorreta' });
        }

        // Gera JWT token
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                wins: user.wins,
                losses: user.losses
            }
        });
    } catch (err) {
        console.error('Erro no login:', err);
        res.status(500).json({ error: 'Erro ao fazer login' });
    }
});

// Arquivo estático deve vir DEPOIS das rotas de API
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
    let currentUser = null;
    
    socket.on('joinRoom', (roomId, token) => {
        // Verifica o token
        const decoded = verifyToken(token);
        if (!decoded) {
            socket.emit('authError', 'Token inválido');
            return;
        }

        // Busca o usuário
        const users = loadUsers();
        currentUser = users.find(u => u.id === decoded.id);
        if (!currentUser) {
            socket.emit('authError', 'Usuário não encontrado');
            return;
        }

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
            console.log(`Jogador ${currentUser.username} (${socket.id}) entrou na sala ${roomIdStr} como Brancas`);
        } else {
            playerColor = 'black';
            console.log(`Jogador ${currentUser.username} (${socket.id}) entrou na sala ${roomIdStr} como Pretas`);
        }
        
        socket.emit('playerColor', { color: playerColor, username: currentUser.username });
        socket.emit('gameState', rooms.get(roomIdStr));
        
        socket.to(roomIdStr).emit('opponentJoined', { 
            color: playerColor, 
            username: currentUser.username 
        });
        
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
        if (!currentRoom || !currentUser) return;
        
        const gameState = rooms.get(currentRoom);
        if (!gameState) return;
        
        gameState.whiteWins = scoreData.whiteWins;
        gameState.blackWins = scoreData.blackWins;

        // Atualiza estatísticas do jogador se ele ganhou
        if (scoreData.winner) {
            const users = loadUsers();
            const userIndex = users.findIndex(u => u.id === currentUser.id);
            if (userIndex !== -1) {
                if (scoreData.winner === currentUser.username) {
                    users[userIndex].wins++;
                } else {
                    users[userIndex].losses++;
                }
                saveUsers(users);
            }
        }
        
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

    // Evento para entrar em uma sala de aposta
    socket.on('joinBetRoom', (betId, token) => {
        const decoded = verifyToken(token);
        if (!decoded) {
            socket.emit('authError', 'Token inválido');
            return;
        }
loadBets();
        const bet = activeBetsData.find(b => b.id === betId);
        
        if (!bet) {
            socket.emit('betError', 'Aposta não encontrada');
            return;
        }

        if (bet.challenger.id !== decoded.id && bet.opponent.id !== decoded.id) {
            socket.emit('betError', 'Você não participa desta aposta');
            return;
        }

        if (bet.status !== 'in_progress' && bet.status !== 'accepted') {
            socket.emit('betError', 'Aposta não está ativa');
            return;
        }

        const roomId = bet.gameRoomId || 'BET_' + betId;
        
        // Sai de qualquer sala anterior
        if (currentRoom) {
            socket.leave(currentRoom);
        }

        currentRoom = roomId;
        
        // Une o jogador à sala
        socket.join(roomId);

        // Atualiza a sala na aposta
        const betUpdateIndex = activeBetsData.findIndex(b => b.id === betId);
        if (betUpdateIndex !== -1) {
            activeBetsData[betUpdateIndex].gameRoomId = roomId;
            saveBets(activeBetsData);
        }

        console.log(`[BET-SOCKET] Jogador ${decoded.username} entrou na sala ${roomId}`);

        // Verifica se há 2 jogadores na sala para iniciar o jogo
        const roomSockets = io.sockets.adapter.rooms.get(roomId);
        if (roomSockets && roomSockets.size >= 2) {
            // Ambos os jogadores estão conectados, inicia o jogo
            io.to(roomId).emit('betGameStart', {
                betId: betId,
                roomId: roomId,
                challenger: bet.challenger,
                opponent: bet.opponent,
                amount: bet.amount
            });
        }

        socket.emit('betJoined', {
            betId: betId,
            roomId: roomId,
            bet: bet,
            player: bet.challenger.id === decoded.id ? 'challenger' : 'opponent'
        });
    });

    // Evento para notificar fim de jogo de aposta
    socket.on('betGameEnd', (data) => {
        if (!currentRoom || !currentUser) return;
        
        const { betId, winner } = data;
        
        loadBets();
        const betIndex = activeBetsData.findIndex(b => b.id === betId);
        
        if (betIndex !== -1 && activeBetsData[betIndex].status === 'in_progress') {
            activeBetsData[betIndex].status = 'completed';
            activeBetsData[betIndex].winner = winner;
            activeBetsData[betIndex].completedAt = new Date().toISOString();
            saveBets(activeBetsData);

            // Salva no histórico
            const allBets = loadBets();
            allBets.push({ ...activeBetsData[betIndex], status: 'completed' });
            saveBets(allBets);

            io.to(currentRoom).emit('betGameFinished', {
                winner: winner,
                bet: bet
            });

            console.log(`[BET-SOCKET] Jogo de aposta finalizado: ${betId} | Vencedor: ${winner}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
