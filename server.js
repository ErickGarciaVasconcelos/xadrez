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
const htmlPath = path.resolve(rootDir, 'xadrez.html');
const usersFilePath = path.resolve(rootDir, 'users.json');
const tournamentsFilePath = path.resolve(rootDir, 'tournaments.json');
const paymentsFilePath = path.resolve(rootDir, 'payments.json');
const JWT_SECRET = 'your-secret-key-change-in-production';
const HOUSE_FEE_PERCENTAGE = 0.05; // 5% para a banca

// Configuração do Mercado Pago - ADICIONE SUAS CREDENCIAIS AQUI
const MERCADO_PAGO_TOKEN = process.env.MERCADO_PAGO_TOKEN || 'SEU_ACCESS_TOKEN_AQUI';

// Configurar o cliente do Mercado Pago
mercadopago.MercadoPago = mercadopago;

app.use(cors());
app.use(express.json());

// ===== ROTAS DE API =====
// Essas rotas precisam vir ANTES de app.use(express.static)
// para que /api/* seja processado como rota, não como arquivo estático

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
                initPoint: data.init_point,
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

// Webhook para confirmar pagamento
app.post('/api/webhook-payment', async (req, res) => {
    try {
        const { action, data } = req.query;

        // Mercado Pago envia notificações com query params
        if (action === 'payment.created' || action === 'payment.updated') {
            const paymentId = data?.id;

            if (!paymentId) {
                console.log('[WEBHOOK] Notificação recebida sem ID de pagamento');
                return res.json({ success: true }); // Responde 200 mesmo se dados incompletos
            }

            console.log(`[WEBHOOK] Notificação Mercado Pago: ID: ${paymentId}, Ação: ${action}`);

            // Aqui você pode fazer verificações adicionais com a API do Mercado Pago
            // Por enquanto, apenas registra o recebimento
            const payments = loadPayments();
            const paymentIndex = payments.findIndex(p => p.mercadoPagoId === paymentId);
            
            if (paymentIndex !== -1) {
                const previousStatus = payments[paymentIndex].status;
                payments[paymentIndex].status = 'confirmed';
                payments[paymentIndex].confirmedAt = new Date().toISOString();
                payments[paymentIndex].mercadoPagoId = paymentId;
                savePayments(payments);
                
                const paymentData = payments[paymentIndex];
                console.log(`[WEBHOOK] ✓ Pagamento confirmado: ${paymentId} | Usuário: ${paymentData.username} | Método: ${paymentData.paymentMethod.toUpperCase()} | Valor: R$ ${paymentData.amount}`);
            } else {
                console.log(`[WEBHOOK] ! Pagamento não encontrado no registro: ${paymentId}`);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[WEBHOOK] Erro no webhook:', err);
        res.json({ success: true }); // Sempre responde 200
    }
});

// Rota de sucesso de pagamento
app.get('/payment-success', (req, res) => {
    const { tournament, user, preference } = req.query;
    
    if (tournament && user) {
        // Adiciona o participante ao torneio
        addParticipantToTournament(tournament, user, 'Novo Participante');
        
        // Atualiza o status do pagamento
        if (preference) {
            const payments = loadPayments();
            const paymentIndex = payments.findIndex(p => p.id === preference);
            if (paymentIndex !== -1) {
                payments[paymentIndex].status = 'approved';
                payments[paymentIndex].confirmedAt = new Date().toISOString();
                
                const paymentData = payments[paymentIndex];
                console.log(`[SUCESSO] Pagamento aprovado: ${preference} | Usuário: ${paymentData.username} | Método: ${paymentData.paymentMethod.toUpperCase()} | Valor: R$ ${paymentData.amount} | Banca: R$ ${paymentData.houseFee}`);
                
                savePayments(payments);
            }
        }
        
        res.send(`
            <html>
                <head>
                    <title>Pagamento Confirmado</title>
                    <style>
                        body { 
                            font-family: Arial; 
                            background: linear-gradient(135deg, #1a0a2e 0%, #2d0a4e 100%);
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            min-height: 100vh;
                            color: white;
                        }
                        .container {
                            text-align: center;
                            background: rgba(255,255,255,0.1);
                            padding: 40px;
                            border-radius: 20px;
                        }
                        h1 { color: #00ffff; }
                        .icon { font-size: 60px; margin: 20px 0; }
                        a { 
                            display: inline-block;
                            margin-top: 20px;
                            padding: 10px 30px;
                            background: linear-gradient(135deg, #00ffff 0%, #8800ff 100%);
                            color: black;
                            text-decoration: none;
                            border-radius: 8px;
                            font-weight: bold;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="icon">✅</div>
                        <h1>Pagamento Confirmado!</h1>
                        <p>Sua entrada no torneio foi autorizada com sucesso.</p>
                        <p>Você já está registrado para participar!</p>
                        <a href="/">Voltar ao Jogo</a>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.redirect('/');
    }
});

app.get('/payment-failure', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Pagamento Recusado</title>
                <style>
                    body { 
                        font-family: Arial; 
                        background: linear-gradient(135deg, #1a0a2e 0%, #2d0a4e 100%);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        color: white;
                    }
                    .container {
                        text-align: center;
                        background: rgba(255,255,255,0.1);
                        padding: 40px;
                        border-radius: 20px;
                    }
                    h1 { color: #ff6666; }
                    .icon { font-size: 60px; margin: 20px 0; }
                    a { 
                        display: inline-block;
                        margin-top: 20px;
                        padding: 10px 30px;
                        background: linear-gradient(135deg, #00ffff 0%, #8800ff 100%);
                        color: black;
                        text-decoration: none;
                        border-radius: 8px;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">❌</div>
                    <h1>Pagamento Recusado</h1>
                    <p>Ocorreu um problema ao processar seu pagamento.</p>
                    <p>Verifique seus dados e tente novamente.</p>
                    <a href="/">Tentar Novamente</a>
                </div>
            </body>
        </html>
    `);
});

app.get('/payment-pending', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Pagamento Pendente</title>
                <style>
                    body { 
                        font-family: Arial; 
                        background: linear-gradient(135deg, #1a0a2e 0%, #2d0a4e 100%);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        color: white;
                    }
                    .container {
                        text-align: center;
                        background: rgba(255,255,255,0.1);
                        padding: 40px;
                        border-radius: 20px;
                    }
                    h1 { color: #ffaa00; }
                    .icon { font-size: 60px; margin: 20px 0; }
                    a { 
                        display: inline-block;
                        margin-top: 20px;
                        padding: 10px 30px;
                        background: linear-gradient(135deg, #00ffff 0%, #8800ff 100%);
                        color: black;
                        text-decoration: none;
                        border-radius: 8px;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">⏳</div>
                    <h1>Pagamento Pendente</h1>
                    <p>Seu pagamento está sendo processado.</p>
                    <p>Você receberá uma confirmação em breve.</p>
                    <a href="/">Voltar</a>
                </div>
            </body>
        </html>
    `);
});

// ===== ROTAS DE TORNEIOS =====

// Rota para obter relatório de pagamentos e taxa da banca
app.get('/api/payments-report', (req, res) => {
    try {
        const payments = loadPayments();
        
        const stats = {
            totalPayments: payments.length,
            approvedPayments: payments.filter(p => p.status === 'approved').length,
            pendingPayments: payments.filter(p => p.status === 'pending').length,
            totalAmount: 0,
            totalHouseFee: 0,
            totalPlayerAmount: 0,
            paymentsByStatus: {},
            paymentsByMethod: {
                pix: 0,
                card: 0,
                unknown: 0
            },
            amountByMethod: {
                pix: 0,
                card: 0,
                unknown: 0
            },
            houseFeeByMethod: {
                pix: 0,
                card: 0,
                unknown: 0
            }
        };

        payments.forEach(payment => {
            // Calcula totais gerais
            if (payment.status === 'approved') {
                stats.totalAmount += payment.amount;
                stats.totalHouseFee += payment.houseFee;
                stats.totalPlayerAmount += payment.playerAmount;
            }

            // Conta por método de pagamento
            const method = payment.paymentMethod || 'unknown';
            if (method === 'pix' || method === 'card') {
                stats.paymentsByMethod[method]++;
                if (payment.status === 'approved') {
                    stats.amountByMethod[method] += payment.amount;
                    stats.houseFeeByMethod[method] += payment.houseFee;
                }
            } else {
                stats.paymentsByMethod['unknown']++;
                if (payment.status === 'approved') {
                    stats.amountByMethod['unknown'] += payment.amount;
                    stats.houseFeeByMethod['unknown'] += payment.houseFee;
                }
            }
        });

        // Agrupa por status
        payments.forEach(payment => {
            const status = payment.status;
            if (!stats.paymentsByStatus[status]) {
                stats.paymentsByStatus[status] = 0;
            }
            stats.paymentsByStatus[status]++;
        });

        // Formata os valores monetários
        const formattedStats = {
            ...stats,
            totalAmount: parseFloat(stats.totalAmount.toFixed(2)),
            totalHouseFee: parseFloat(stats.totalHouseFee.toFixed(2)),
            totalPlayerAmount: parseFloat(stats.totalPlayerAmount.toFixed(2)),
            amountByMethod: {
                pix: parseFloat(stats.amountByMethod.pix.toFixed(2)),
                card: parseFloat(stats.amountByMethod.card.toFixed(2)),
                unknown: parseFloat(stats.amountByMethod.unknown.toFixed(2))
            },
            houseFeeByMethod: {
                pix: parseFloat(stats.houseFeeByMethod.pix.toFixed(2)),
                card: parseFloat(stats.houseFeeByMethod.card.toFixed(2)),
                unknown: parseFloat(stats.houseFeeByMethod.unknown.toFixed(2))
            }
        };

        console.log(`[RELATÓRIO] Total de pagamentos: ${formattedStats.totalPayments} | Aprovados: ${formattedStats.approvedPayments} | PIX: ${formattedStats.paymentsByMethod.pix} | Cartão: ${formattedStats.paymentsByMethod.card} | Banca: R$ ${formattedStats.totalHouseFee}`);

        res.json({
            success: true,
            stats: formattedStats,
            recentPayments: payments.slice(-10).reverse()
        });
    } catch (err) {
        console.error('[RELATÓRIO] Erro ao obter relatório:', err);
        res.status(500).json({ error: 'Erro ao obter relatório' });
    }
});

app.get('/api/tournament/:id', (req, res) => {
    try {
        const tournaments = loadTournaments();
        const tournament = tournaments.find(t => t.id === req.params.id);

        if (!tournament) {
            return res.status(404).json({ error: 'Torneio não encontrado' });
        }

        res.json({
            success: true,
            tournament: {
                id: tournament.id,
                name: tournament.name,
                description: tournament.description,
                entryFee: tournament.entryFee,
                maxParticipants: tournament.maxParticipants,
                participants: (tournament.participants || []).length,
                status: tournament.status,
                createdAt: tournament.createdAt
            }
        });
    } catch (err) {
        console.error('Erro ao obter torneio:', err);
        res.status(500).json({ error: 'Erro ao obter torneio' });
    }
});

// Rota para listar torneios disponíveis
app.get('/api/tournaments', (req, res) => {
    try {
        const tournaments = loadTournaments();

        const availableTournaments = tournaments
            .filter(t => t.status === 'open')
            .map(t => ({
                id: t.id,
                name: t.name,
                description: t.description,
                entryFee: t.entryFee,
                maxParticipants: t.maxParticipants,
                participants: (t.participants || []).length,
                spotsAvailable: t.maxParticipants - (t.participants || []).length
            }));

        res.json({
            success: true,
            tournaments: availableTournaments
        });
    } catch (err) {
        console.error('Erro ao listar torneios:', err);
        res.status(500).json({ error: 'Erro ao listar torneios' });
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

// ===== FUNÇÕES AUXILIARES =====

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
            return true;
        }
    }
    return false;
}

// Middleware para verificar token JWT
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});