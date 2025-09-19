/**
 * ForexAI Trading Platform - Servidor Simplificado
 * Versão funcional sem middlewares complexos
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createServer } = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

// Importar configurações básicas
const database = require('./config/database');
const logger = require('./utils/logger');

// Criar aplicação Express
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://seudominio.com'] 
      : ['http://localhost:3000', 'http://127.0.0.1:3000', '*'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});

// Configurações básicas
app.use(helmet({
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: '*',
  credentials: true
}));

// Parsing de JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware de logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl} - ${req.ip}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'ForexAI Trading API está funcionando',
    timestamp: new Date().toISOString(),
    version: process.env.API_VERSION || 'v1'
  });
});

// Rota de teste básica
app.get('/api/v1/test', (req, res) => {
  res.json({
    status: 'success',
    message: 'API funcionando corretamente',
    timestamp: new Date().toISOString()
  });
});

// Importar apenas rotas básicas que funcionam
try {
  const authRoutes = require('./routes/auth');
  app.use('/api/v1/auth', authRoutes);
  logger.info('✅ Rotas de auth carregadas');
} catch (error) {
  logger.error('❌ Erro ao carregar rotas de auth:', error.message);
}

try {
  const userRoutes = require('./routes/users');
  app.use('/api/v1/users', userRoutes);
  logger.info('✅ Rotas de usuários carregadas');
} catch (error) {
  logger.error('❌ Erro ao carregar rotas de usuários:', error.message);
}

// Rotas básicas de trading (sem middlewares problemáticos)
app.get('/api/v1/trading/symbols', (req, res) => {
  const symbols = [
    { symbol: 'EURUSD', name: 'Euro/US Dollar', price: 1.0850, change: '+0.15%' },
    { symbol: 'GBPUSD', name: 'British Pound/US Dollar', price: 1.2735, change: '-0.08%' },
    { symbol: 'USDJPY', name: 'US Dollar/Japanese Yen', price: 148.25, change: '+0.32%' },
    { symbol: 'AUDUSD', name: 'Australian Dollar/US Dollar', price: 0.6680, change: '+0.22%' },
    { symbol: 'USDCAD', name: 'US Dollar/Canadian Dollar', price: 1.3425, change: '-0.05%' },
    { symbol: 'EURGBP', name: 'Euro/British Pound', price: 0.8520, change: '+0.18%' }
  ];

  res.json({
    status: 'success',
    data: { symbols }
  });
});

// Rota básica da IA
app.get('/api/v1/ai/status', (req, res) => {
  res.json({
    status: 'success',
    data: {
      ai_status: {
        is_active: true,
        version: '1.0.0',
        indicators: ['RSI', 'MACD', 'Bollinger Bands', 'SMA', 'EMA'],
        last_analysis: new Date().toISOString()
      }
    }
  });
});

// Middleware de tratamento de erros
app.use((err, req, res, next) => {
  logger.error(`Erro: ${err.message}`, { stack: err.stack });
  
  res.status(500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' 
      ? 'Erro interno do servidor' 
      : err.message
  });
});

// Middleware para rotas não encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Rota ${req.originalUrl} não encontrada`
  });
});

// Socket.IO para comunicação em tempo real
io.on('connection', (socket) => {
  logger.info(`Cliente conectado: ${socket.id}`);
  
  // Enviar status inicial
  socket.emit('server_status', {
    status: 'connected',
    timestamp: new Date().toISOString()
  });
  
  // Evento de desconexão
  socket.on('disconnect', () => {
    logger.info(`Cliente desconectado: ${socket.id}`);
  });
});

// Função para inicializar o servidor
async function startServer() {
  try {
    // Conectar ao banco de dados
    await database.connect();
    logger.info('✅ Conectado ao banco MySQL');
    
    // Iniciar servidor
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`🚀 Servidor ForexAI Trading iniciado na porta ${PORT}`);
      logger.info(`📊 API disponível em: http://localhost:${PORT}/api/v1`);
      logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
      logger.info(`🧪 Teste: http://localhost:${PORT}/api/v1/test`);
      logger.info(`🌐 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    });
    
    // Exportar io para usar em outros módulos
    global.io = io;
    
  } catch (error) {
    logger.error('❌ Erro ao iniciar servidor:', error.message);
    console.log('🔧 Tentando iniciar sem banco de dados...');
    
    // Iniciar servidor mesmo sem banco
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`🚀 Servidor iniciado na porta ${PORT} (sem banco)`);
      logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
    });
  }
}

// Tratamento de sinais do sistema
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  logger.info('🔄 Iniciando desligamento gracioso...');
  
  try {
    // Fechar conexões do banco
    if (database.isConnected && await database.isConnected()) {
      await database.disconnect();
      logger.info('🔌 Conexão com banco encerrada');
    }
    
    // Fechar servidor
    server.close(() => {
      logger.info('📡 Servidor HTTP fechado');
      process.exit(0);
    });
    
    // Forçar saída após 10 segundos
    setTimeout(() => {
      logger.error('⏰ Forçando saída após timeout');
      process.exit(1);
    }, 10000);
    
  } catch (error) {
    logger.error('❌ Erro durante desligamento:', error.message);
    process.exit(1);
  }
}

// Iniciar servidor
if (require.main === module) {
  startServer();
}

module.exports = { app, server, io };