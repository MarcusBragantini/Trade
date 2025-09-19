/**
 * ForexAI Trading Platform - Servidor com Integração Deriv
 * Sistema completo com dados reais da Deriv API
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createServer } = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

// Importar configurações
const database = require('./config/database');
const logger = require('./utils/logger');

// Importar integração Deriv
const derivIntegration = require('./services/derivIntegration');

// Importar middlewares
const rateLimiting = require('./middleware/rateLimiting');

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
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

// Rate Limiting
app.use('/api/', rateLimiting.general);

// Parsing de JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware de logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl} - ${req.ip}`);
  next();
});

// Health check com status da Deriv
app.get('/health', (req, res) => {
  const derivStats = derivIntegration.getStats();
  
  res.status(200).json({
    status: 'success',
    message: 'ForexAI Trading API está funcionando',
    timestamp: new Date().toISOString(),
    version: process.env.API_VERSION || 'v1',
    deriv: {
      connected: derivIntegration.isConnected(),
      uptime: derivStats.uptime,
      ticks_received: derivStats.ticksReceived,
      candles_received: derivStats.candlesReceived,
      ai_analysis_count: derivStats.aiAnalysisCount,
      trades_executed: derivStats.tradesExecuted
    }
  });
});

// Status detalhado da Deriv
app.get('/api/v1/deriv/status', (req, res) => {
  const stats = derivIntegration.getStats();
  const prices = derivIntegration.getAllPrices();
  
  res.json({
    status: 'success',
    data: {
      deriv_status: {
        connected: derivIntegration.isConnected(),
        initialized: derivIntegration.isInitialized,
        ...stats
      },
      live_prices: prices,
      demo_mode: process.env.DERIV_DEMO_MODE === 'true'
    }
  });
});

// Preços em tempo real
app.get('/api/v1/deriv/prices', (req, res) => {
  const prices = derivIntegration.getAllPrices();
  
  res.json({
    status: 'success',
    data: {
      prices,
      timestamp: new Date(),
      source: 'deriv_api'
    }
  });
});

// Preço específico
app.get('/api/v1/deriv/price/:symbol', (req, res) => {
  const { symbol } = req.params;
  const price = derivIntegration.getPrice(symbol.toUpperCase());
  
  if (!price) {
    return res.status(404).json({
      status: 'error',
      message: `Preço para ${symbol} não disponível`
    });
  }
  
  res.json({
    status: 'success',
    data: {
      symbol: symbol.toUpperCase(),
      ...price,
      source: 'deriv_api'
    }
  });
});

// Forçar análise de IA
app.post('/api/v1/deriv/analyze/:symbol', async (req, res) => {
  const { symbol } = req.params;
  
  try {
    await derivIntegration.forceAnalysis(symbol.toUpperCase());
    
    res.json({
      status: 'success',
      message: `Análise de ${symbol} iniciada`,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Subscribir a novos dados
app.post('/api/v1/deriv/subscribe', async (req, res) => {
  const { symbol, timeframes = ['1m', '5m'] } = req.body;
  
  if (!symbol) {
    return res.status(400).json({
      status: 'error',
      message: 'Símbolo é obrigatório'
    });
  }
  
  try {
    const success = await derivIntegration.subscribeToSymbol(symbol.toUpperCase(), timeframes);
    
    if (success) {
      res.json({
        status: 'success',
        message: `Subscrito a ${symbol} com sucesso`,
        timeframes
      });
    } else {
      res.status(400).json({
        status: 'error',
        message: `Erro ao subscribir a ${symbol}`
      });
    }
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Versão da API
const apiVersion = process.env.API_VERSION || 'v1';

// Carregar rotas existentes
try {
  const authRoutes = require('./routes/auth');
  app.use(`/api/${apiVersion}/auth`, authRoutes);
  logger.info('✅ Rotas de autenticação carregadas');
} catch (error) {
  logger.error('❌ Erro ao carregar rotas de auth:', error.message);
}

try {
  const userRoutes = require('./routes/users');
  app.use(`/api/${apiVersion}/users`, userRoutes);
  logger.info('✅ Rotas de usuários carregadas');
} catch (error) {
  logger.error('❌ Erro ao carregar rotas de users:', error.message);
}

// Rotas de trading com dados reais
app.get(`/api/${apiVersion}/trading/symbols`, (req, res) => {
  const prices = derivIntegration.getAllPrices();
  
  const symbols = Object.keys(prices).map(symbol => {
    const priceData = prices[symbol];
    return {
      symbol,
      name: getSymbolName(symbol),
      price: priceData.price,
      bid: priceData.bid,
      ask: priceData.ask,
      spread: priceData.spread,
      change: priceData.change || 0,
      timestamp: priceData.timestamp,
      source: 'deriv_api'
    };
  });
  
  res.json({
    status: 'success',
    data: { 
      symbols: symbols.length > 0 ? symbols : getDefaultSymbols(),
      live_data: symbols.length > 0,
      source: symbols.length > 0 ? 'deriv_api' : 'simulated'
    }
  });
});

// Função auxiliar para nomes de símbolos
function getSymbolName(symbol) {
  const names = {
    'EURUSD': 'Euro/US Dollar',
    'GBPUSD': 'British Pound/US Dollar',
    'USDJPY': 'US Dollar/Japanese Yen',
    'AUDUSD': 'Australian Dollar/US Dollar',
    'USDCAD': 'US Dollar/Canadian Dollar',
    'EURGBP': 'Euro/British Pound',
    'EURJPY': 'Euro/Japanese Yen',
    'GBPJPY': 'British Pound/Japanese Yen',
    'XAUUSD': 'Gold/US Dollar',
    'XAGUSD': 'Silver/US Dollar'
  };
  
  return names[symbol] || symbol;
}

// Símbolos padrão quando não há dados da Deriv
function getDefaultSymbols() {
  return [
    { symbol: 'EURUSD', name: 'Euro/US Dollar', price: 1.0850, change: '+0.15%', source: 'simulated' },
    { symbol: 'GBPUSD', name: 'British Pound/US Dollar', price: 1.2735, change: '-0.08%', source: 'simulated' },
    { symbol: 'USDJPY', name: 'US Dollar/Japanese Yen', price: 148.25, change: '+0.32%', source: 'simulated' },
    { symbol: 'AUDUSD', name: 'Australian Dollar/US Dollar', price: 0.6680, change: '+0.22%', source: 'simulated' }
  ];
}

// Outras rotas com fallbacks
try {
  const aiRoutes = require('./routes/ai');
  app.use(`/api/${apiVersion}/ai`, aiRoutes);
  logger.info('✅ Rotas de IA carregadas');
} catch (error) {
  logger.error('❌ Erro ao carregar rotas de IA:', error.message);
  
  app.get(`/api/${apiVersion}/ai/status`, (req, res) => {
    const derivStats = derivIntegration.getStats();
    
    res.json({
      status: 'success',
      data: {
        ai_status: {
          is_active: derivIntegration.isConnected(),
          version: '2.0.0',
          indicators: ['RSI', 'MACD', 'Bollinger Bands', 'SMA', 'EMA'],
          last_analysis: new Date().toISOString(),
          deriv_integration: true,
          analysis_count: derivStats.aiAnalysisCount,
          auto_trades: derivStats.tradesExecuted
        }
      }
    });
  });
}

// Socket.IO com eventos da Deriv
io.on('connection', (socket) => {
  logger.info(`🔗 Cliente conectado: ${socket.id}`);
  
  // Enviar status inicial
  socket.emit('server_status', {
    status: 'connected',
    timestamp: new Date().toISOString(),
    deriv_connected: derivIntegration.isConnected()
  });
  
  // Enviar preços atuais
  socket.emit('initial_prices', derivIntegration.getAllPrices());
  
  // Autenticação
  socket.on('authenticate', async (token) => {
    try {
      // TODO: Verificar JWT
      logger.info(`👤 Cliente autenticado: ${socket.id}`);
      socket.join('authenticated');
    } catch (error) {
      socket.emit('auth_error', { message: 'Token inválido' });
    }
  });
  
  // Subscribir a símbolo específico
  socket.on('subscribe_symbol', async (symbol) => {
    try {
      await derivIntegration.subscribeToSymbol(symbol);
      socket.join(`symbol_${symbol}`);
      socket.emit('subscribed', { symbol, status: 'success' });
    } catch (error) {
      socket.emit('subscribe_error', { symbol, error: error.message });
    }
  });
  
  socket.on('disconnect', () => {
    logger.info(`🔌 Cliente desconectado: ${socket.id}`);
  });
});

// Configurar eventos da Deriv para Socket.IO
derivIntegration.on('deriv_connected', () => {
  io.emit('deriv_status', { connected: true, timestamp: new Date() });
});

derivIntegration.on('deriv_disconnected', () => {
  io.emit('deriv_status', { connected: false, timestamp: new Date() });
});

// Middleware de erro
app.use((err, req, res, next) => {
  logger.error(`Erro: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' ? 'Erro interno do servidor' : err.message
  });
});

// 404
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Rota ${req.originalUrl} não encontrada`
  });
});

// Função para inicializar o servidor
async function startServer() {
  try {
    // Conectar ao banco
    logger.info('🔄 Conectando ao banco de dados...');
    await database.connect();
    logger.info('✅ Conectado ao banco MySQL');
    
    // Inicializar integração Deriv
    logger.info('🔄 Inicializando integração Deriv...');
    try {
      await derivIntegration.initialize();
      logger.info('✅ Integração Deriv inicializada');
    } catch (error) {
      logger.warn('⚠️ Erro na integração Deriv (continuando sem ela):', error.message);
    }
    
  } catch (dbError) {
    logger.warn('⚠️ Erro no banco (continuando sem ele):', dbError.message);
  }
  
  // Iniciar servidor
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    logger.info(`🚀 Servidor ForexAI com Deriv iniciado na porta ${PORT}`);
    logger.info(`📊 API: http://localhost:${PORT}/api/${apiVersion}`);
    logger.info(`🏥 Health: http://localhost:${PORT}/health`);
    logger.info(`📈 Deriv Status: http://localhost:${PORT}/api/${apiVersion}/deriv/status`);
    logger.info(`💹 Preços: http://localhost:${PORT}/api/${apiVersion}/deriv/prices`);
    logger.info(`🌐 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    
    if (derivIntegration.isConnected()) {
      logger.info('🔗 Dados em tempo real da Deriv ativos!');
    } else {
      logger.info('⚠️ Rodando com dados simulados');
    }
  });
  
  global.io = io;
}

// Graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  logger.info('🔄 Iniciando shutdown...');
  
  try {
    await derivIntegration.shutdown();
    
    if (database.isConnected && await database.isConnected()) {
      await database.disconnect();
    }
    
    server.close(() => {
      logger.info('✅ Servidor encerrado');
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('❌ Erro no shutdown:', error.message);
    process.exit(1);
  }
}

// Iniciar
if (require.main === module) {
  startServer();
}

module.exports = { app, server, io };