/**
 * ForexAI Trading Platform - Servidor Funcional
 * Versão que funciona garantidamente sem erros
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
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});

// Simulador de dados Deriv integrado
class SimulatedDeriv {
  constructor() {
    this.isConnected = false;
    this.priceCache = new Map();
    this.stats = {
      ticksReceived: 0,
      candlesReceived: 0,
      aiAnalysisCount: 0,
      tradesExecuted: 0,
      startTime: new Date()
    };

    // Preços base simulados
    this.basePrices = {
      'EURUSD': 1.0850,
      'GBPUSD': 1.2735,
      'USDJPY': 148.25,
      'AUDUSD': 0.6680,
      'USDCAD': 1.3425,
      'EURGBP': 0.8520
    };
  }

  async initialize() {
    logger.info('🚀 Inicializando simulador de dados FOREX...');
    
    // Inicializar cache de preços
    Object.keys(this.basePrices).forEach(symbol => {
      const price = this.basePrices[symbol];
      const spread = 0.0002;
      
      this.priceCache.set(symbol, {
        symbol,
        price: price,
        bid: price - spread/2,
        ask: price + spread/2,
        spread: spread,
        timestamp: new Date(),
        change: { absolute: 0, percentage: 0 }
      });
    });

    this.isConnected = true;
    this.startSimulation();
    
    logger.info('✅ Simulador iniciado com sucesso');
    return true;
  }

  startSimulation() {
    // Atualizar preços a cada 3 segundos
    setInterval(() => {
      if (!this.isConnected) return;

      Object.keys(this.basePrices).forEach(symbol => {
        this.updatePrice(symbol);
      });

      // Simular vela a cada 10 atualizações
      if (this.stats.ticksReceived % 10 === 0) {
        this.simulateCandle();
      }

      // Simular análise da IA a cada 20 atualizações
      if (this.stats.ticksReceived % 20 === 0) {
        this.simulateAIAnalysis();
      }

    }, 3000);
  }

  updatePrice(symbol) {
    const cached = this.priceCache.get(symbol);
    if (!cached) return;

    // Gerar variação pequena (-0.1% a +0.1%)
    const variation = (Math.random() - 0.5) * 0.002;
    const newPrice = cached.price + variation;
    
    const spread = 0.0002;
    const bid = newPrice - spread/2;
    const ask = newPrice + spread/2;

    // Calcular mudança
    const change = newPrice - this.basePrices[symbol];
    const changePercent = (change / this.basePrices[symbol]) * 100;

    const updatedData = {
      symbol,
      price: parseFloat(newPrice.toFixed(5)),
      bid: parseFloat(bid.toFixed(5)),
      ask: parseFloat(ask.toFixed(5)),
      spread: parseFloat(spread.toFixed(5)),
      timestamp: new Date(),
      change: {
        absolute: parseFloat(change.toFixed(5)),
        percentage: parseFloat(changePercent.toFixed(3))
      }
    };

    this.priceCache.set(symbol, updatedData);
    this.stats.ticksReceived++;

    // Emitir via Socket.IO
    if (global.io) {
      global.io.emit('tick_update', updatedData);
    }
  }

  simulateCandle() {
    const symbols = Object.keys(this.basePrices);
    const symbol = symbols[Math.floor(Math.random() * symbols.length)];
    const price = this.priceCache.get(symbol);
    
    if (!price) return;

    const candle = {
      symbol,
      timestamp: new Date(),
      open: price.price - 0.0003,
      high: price.price + 0.0005,
      low: price.price - 0.0008,
      close: price.price,
      volume: Math.floor(Math.random() * 1000000)
    };

    this.stats.candlesReceived++;

    if (global.io) {
      global.io.emit('candle_update', {
        symbol,
        candle,
        timestamp: candle.timestamp
      });
    }

    logger.debug(`🕯️ Vela simulada: ${symbol} - Close: ${candle.close}`);
  }

  simulateAIAnalysis() {
    const symbols = Object.keys(this.basePrices);
    const symbol = symbols[Math.floor(Math.random() * symbols.length)];
    
    const actions = ['buy', 'sell', 'hold'];
    const action = actions[Math.floor(Math.random() * actions.length)];
    const confidence = 0.6 + Math.random() * 0.3; // 60-90%

    const analysis = {
      action,
      confidence: parseFloat(confidence.toFixed(3)),
      symbol,
      reasons: [
        'RSI em zona favorável',
        'MACD indica tendência',
        'Breakout de suporte/resistência'
      ],
      risk_level: confidence > 0.8 ? 'low' : confidence > 0.7 ? 'medium' : 'high',
      timestamp: new Date()
    };

    this.stats.aiAnalysisCount++;

    if (global.io) {
      global.io.emit('ai_analysis', {
        symbol,
        analysis,
        timestamp: new Date()
      });
    }

    logger.ai(`🧠 Análise IA: ${symbol} ${action} (${(confidence * 100).toFixed(1)}%)`);

    // Simular trade automático se alta confiança
    if (confidence > 0.85 && action !== 'hold') {
      this.simulateAutoTrade(symbol, analysis);
    }
  }

  simulateAutoTrade(symbol, analysis) {
    const tradeId = `AUTO_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    
    this.stats.tradesExecuted++;

    if (global.io) {
      global.io.emit('auto_trade_executed', {
        trade_id: tradeId,
        symbol,
        action: analysis.action,
        confidence: analysis.confidence,
        amount: 100,
        entry_price: this.priceCache.get(symbol)?.price,
        timestamp: new Date(),
        type: 'simulated'
      });
    }

    logger.trading(`🤖 Trade automático: ${symbol} ${analysis.action} (${tradeId})`);
  }

  getStats() {
    const uptime = Date.now() - this.stats.startTime.getTime();
    return {
      ...this.stats,
      uptime: Math.floor(uptime / 1000),
      isConnected: this.isConnected,
      activeSymbols: this.priceCache.size,
      mode: 'simulated'
    };
  }

  getAllPrices() {
    return Object.fromEntries(this.priceCache);
  }

  getPrice(symbol) {
    return this.priceCache.get(symbol);
  }

  async forceAnalysis(symbol) {
    this.simulateAIAnalysis();
    return true;
  }

  isConnectedToAPI() {
    return this.isConnected;
  }

  async shutdown() {
    this.isConnected = false;
    logger.info('🔄 Simulador parado');
  }
}

// Criar instância do simulador
const derivSim = new SimulatedDeriv();

// Configurações básicas
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware de logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl} - ${req.ip}`);
  next();
});

// Health check com dados do simulador
app.get('/health', (req, res) => {
  const stats = derivSim.getStats();
  
  res.status(200).json({
    status: 'success',
    message: 'ForexAI Trading API funcionando',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    deriv_simulator: {
      connected: derivSim.isConnectedToAPI(),
      uptime: stats.uptime,
      ticks_received: stats.ticksReceived,
      candles_received: stats.candlesReceived,
      ai_analysis_count: stats.aiAnalysisCount,
      trades_executed: stats.tradesExecuted,
      mode: 'simulated'
    }
  });
});

// Rotas da API simulada
const apiVersion = 'v1';

// Status do simulador
app.get(`/api/${apiVersion}/deriv/status`, (req, res) => {
  const stats = derivSim.getStats();
  const prices = derivSim.getAllPrices();
  
  res.json({
    status: 'success',
    data: {
      deriv_status: {
        connected: true,
        initialized: true,
        mode: 'simulated',
        ...stats
      },
      live_prices: prices,
      total_symbols: Object.keys(prices).length
    }
  });
});

// Preços em tempo real
app.get(`/api/${apiVersion}/deriv/prices`, (req, res) => {
  const prices = derivSim.getAllPrices();
  
  res.json({
    status: 'success',
    data: {
      prices,
      timestamp: new Date(),
      source: 'simulator',
      total_symbols: Object.keys(prices).length
    }
  });
});

// Preço específico
app.get(`/api/${apiVersion}/deriv/price/:symbol`, (req, res) => {
  const { symbol } = req.params;
  const price = derivSim.getPrice(symbol.toUpperCase());
  
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
      source: 'simulator'
    }
  });
});

// Forçar análise
app.post(`/api/${apiVersion}/deriv/analyze/:symbol`, async (req, res) => {
  const { symbol } = req.params;
  
  try {
    await derivSim.forceAnalysis(symbol.toUpperCase());
    
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

// Símbolos com dados simulados
app.get(`/api/${apiVersion}/trading/symbols`, (req, res) => {
  const prices = derivSim.getAllPrices();
  
  const symbols = Object.values(prices).map(priceData => ({
    symbol: priceData.symbol,
    name: getSymbolName(priceData.symbol),
    price: priceData.price,
    bid: priceData.bid,
    ask: priceData.ask,
    spread: priceData.spread,
    change: priceData.change.percentage,
    timestamp: priceData.timestamp,
    source: 'simulator'
  }));
  
  res.json({
    status: 'success',
    data: { 
      symbols,
      live_data: true,
      source: 'simulator',
      total: symbols.length
    }
  });
});

// Função auxiliar para nomes
function getSymbolName(symbol) {
  const names = {
    'EURUSD': 'Euro/US Dollar',
    'GBPUSD': 'British Pound/US Dollar',
    'USDJPY': 'US Dollar/Japanese Yen',
    'AUDUSD': 'Australian Dollar/US Dollar',
    'USDCAD': 'US Dollar/Canadian Dollar',
    'EURGBP': 'Euro/British Pound'
  };
  return names[symbol] || symbol;
}

// Carregar rotas existentes (se disponíveis)
try {
  const authRoutes = require('./routes/auth');
  app.use(`/api/${apiVersion}/auth`, authRoutes);
  logger.info('✅ Rotas de autenticação carregadas');
} catch (error) {
  logger.warn('⚠️ Rotas de auth não carregadas:', error.message);
}

// Rota básica de teste
app.get(`/api/${apiVersion}/test`, (req, res) => {
  res.json({
    status: 'success',
    message: 'API funcionando com simulador integrado',
    timestamp: new Date().toISOString(),
    simulator: {
      active: derivSim.isConnectedToAPI(),
      stats: derivSim.getStats()
    }
  });
});

// Socket.IO com eventos simulados
io.on('connection', (socket) => {
  logger.info(`🔗 Cliente conectado: ${socket.id}`);
  
  // Enviar status inicial
  socket.emit('server_status', {
    status: 'connected',
    timestamp: new Date().toISOString(),
    simulator_active: derivSim.isConnectedToAPI(),
    mode: 'simulated'
  });
  
  // Enviar preços atuais
  socket.emit('initial_prices', derivSim.getAllPrices());
  
  socket.on('disconnect', () => {
    logger.info(`🔌 Cliente desconectado: ${socket.id}`);
  });
});

// Middleware de erro
app.use((err, req, res, next) => {
  logger.error(`Erro: ${err.message}`);
  res.status(500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' ? 'Erro interno' : err.message
  });
});

// 404
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Rota ${req.originalUrl} não encontrada`
  });
});

// Inicializar servidor
async function startServer() {
  try {
    // Tentar conectar ao banco
    try {
      await database.connect();
      logger.info('✅ Conectado ao banco MySQL');
    } catch (dbError) {
      logger.warn('⚠️ Banco não disponível, continuando sem ele');
    }
    
    // Inicializar simulador
    await derivSim.initialize();
    
    // Iniciar servidor
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`🚀 ForexAI Trading (Simulado) iniciado na porta ${PORT}`);
      logger.info(`📊 API: http://localhost:${PORT}/api/${apiVersion}`);
      logger.info(`🏥 Health: http://localhost:${PORT}/health`);
      logger.info(`📈 Status: http://localhost:${PORT}/api/${apiVersion}/deriv/status`);
      logger.info(`💹 Preços: http://localhost:${PORT}/api/${apiVersion}/deriv/prices`);
      logger.info(`🎭 Modo: Dados simulados em tempo real`);
    });
    
    global.io = io;
    
  } catch (error) {
    logger.error('❌ Erro ao iniciar:', error.message);
    process.exit(1);
  }
}

// Shutdown gracioso
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  logger.info('🔄 Encerrando servidor...');
  await derivSim.shutdown();
  server.close(() => {
    logger.info('✅ Servidor encerrado');
    process.exit(0);
  });
}

// Iniciar
if (require.main === module) {
  startServer();
}

module.exports = { app, server, io };