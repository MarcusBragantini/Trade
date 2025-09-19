/**
 * Integração da Deriv API com o Sistema ForexAI
 * Conecta os dados reais com nossa IA e trading
 */

const EventEmitter = require('events');
const derivAPI = require('./derivAPI');
const database = require('../config/database');
const logger = require('../utils/logger');
const { ForexAI } = require('../ai/marketAnalysis');

class DerivIntegration extends EventEmitter {
  constructor() {
    super();
    this.isInitialized = false;
    this.activeSubscriptions = new Map();
    this.forexAI = new ForexAI();
    this.realTimeData = new Map();
    
    // Configuração de símbolos padrão para monitorar
    this.defaultSymbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
    
    // Cache de preços
    this.priceCache = new Map();
    
    // Estatísticas
    this.stats = {
      ticksReceived: 0,
      candlesReceived: 0,
      aiAnalysisCount: 0,
      tradesExecuted: 0,
      startTime: new Date()
    };
  }

  /**
   * Inicializar integração
   */
  async initialize() {
    try {
      logger.info('🚀 Inicializando integração Deriv API...');

      // Conectar à Deriv API
      await derivAPI.connect();
      
      // Configurar event listeners
      this.setupEventListeners();
      
      // Subscribir aos dados padrão
      await this.subscribeToDefaultData();
      
      // Obter símbolos ativos
      await this.loadActiveSymbols();
      
      this.isInitialized = true;
      logger.info('✅ Integração Deriv API inicializada com sucesso');
      
      return true;
    } catch (error) {
      logger.error('❌ Erro ao inicializar Deriv API:', error.message);
      throw error;
    }
  }

  /**
   * Configurar listeners de eventos
   */
  setupEventListeners() {
    // Dados de tick em tempo real
    derivAPI.on('tick', (tickData) => {
      this.handleTickData(tickData);
    });

    // Dados de velas
    derivAPI.on('candle', (candleData) => {
      this.handleCandleData(candleData);
    });

    // Eventos de conexão
    derivAPI.on('connected', () => {
      logger.info('🔗 Deriv API conectada');
      this.emit('deriv_connected');
    });

    derivAPI.on('disconnected', () => {
      logger.warn('🔌 Deriv API desconectada');
      this.emit('deriv_disconnected');
    });

    derivAPI.on('error', (error) => {
      logger.error('❌ Erro na Deriv API:', error.message);
      this.emit('deriv_error', error);
    });

    // Eventos de trading
    derivAPI.on('buy_response', (response) => {
      this.handleTradeResponse('buy', response);
    });

    derivAPI.on('sell_response', (response) => {
      this.handleTradeResponse('sell', response);
    });
  }

  /**
   * Subscribir aos dados padrão
   */
  async subscribeToDefaultData() {
    for (const symbol of this.defaultSymbols) {
      try {
        // Subscribir a ticks
        await derivAPI.subscribeTicks(symbol);
        
        // Subscribir a velas de 1 minuto
        await derivAPI.subscribeCandles(symbol, 60);
        
        // Subscribir a velas de 5 minutos
        await derivAPI.subscribeCandles(symbol, 300);
        
        this.activeSubscriptions.set(symbol, {
          ticks: true,
          candles_1m: true,
          candles_5m: true
        });
        
        logger.info(`✅ Dados de ${symbol} subscritos`);
        
      } catch (error) {
        logger.error(`❌ Erro ao subscribir ${symbol}:`, error.message);
      }
    }
  }

  /**
   * Processar dados de tick
   */
  handleTickData(tickData) {
    this.stats.ticksReceived++;
    
    // Atualizar cache de preços
    this.priceCache.set(tickData.symbol, {
      price: tickData.price,
      bid: tickData.bid,
      ask: tickData.ask,
      timestamp: tickData.timestamp,
      spread: tickData.ask - tickData.bid
    });

    // Emitir via Socket.IO para frontend
    if (global.io) {
      global.io.emit('tick_update', {
        symbol: tickData.symbol,
        price: tickData.price,
        timestamp: tickData.timestamp,
        change: this.calculatePriceChange(tickData.symbol, tickData.price)
      });
    }

    // Log debug a cada 100 ticks
    if (this.stats.ticksReceived % 100 === 0) {
      logger.debug(`📊 Ticks processados: ${this.stats.ticksReceived}`);
    }
  }

  /**
   * Processar dados de velas
   */
  async handleCandleData(candleData) {
    this.stats.candlesReceived++;
    
    try {
      // Salvar vela no banco de dados
      await this.saveCandleToDB(candleData);
      
      // Enviar para análise da IA (apenas velas de 5 minutos)
      if (this.shouldAnalyzeCandle(candleData)) {
        await this.analyzeWithAI(candleData.symbol);
      }
      
      // Emitir para frontend
      if (global.io) {
        global.io.emit('candle_update', {
          symbol: candleData.symbol,
          candle: candleData,
          timestamp: candleData.timestamp
        });
      }
      
    } catch (error) {
      logger.error('❌ Erro ao processar vela:', error.message);
    }
  }

  /**
   * Salvar vela no banco de dados
   */
  async saveCandleToDB(candleData) {
    try {
      // Determinar timeframe baseado no intervalo
      const timeframe = this.determineTimeframe(candleData);
      
      await database.query(`
        INSERT INTO market_data (symbol, timeframe, timestamp, open_price, high_price, low_price, close_price, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        open_price = VALUES(open_price),
        high_price = VALUES(high_price),
        low_price = VALUES(low_price),
        close_price = VALUES(close_price)
      `, [
        candleData.symbol,
        timeframe,
        candleData.timestamp,
        candleData.open,
        candleData.high,
        candleData.low,
        candleData.close,
        0 // Volume não disponível na Deriv para FOREX
      ]);
    } catch (error) {
      logger.error('❌ Erro ao salvar vela no banco:', error.message);
    }
  }

  /**
   * Determinar timeframe da vela
   */
  determineTimeframe(candleData) {
    // Por enquanto retornar 5m como padrão
    // Pode ser melhorado para detectar baseado no intervalo
    return '5m';
  }

  /**
   * Verificar se deve analisar a vela com IA
   */
  shouldAnalyzeCandle(candleData) {
    // Analisar apenas a cada 5 velas para não sobrecarregar
    return this.stats.candlesReceived % 5 === 0;
  }

  /**
   * Analisar com IA
   */
  async analyzeWithAI(symbol) {
    try {
      this.stats.aiAnalysisCount++;
      
      logger.ai(`🧠 Analisando ${symbol} com IA...`);
      
      // Executar análise da IA
      const analysis = await this.forexAI.analyzeMarket(symbol, '5m');
      
      // Salvar análise no banco
      await database.query(`
        INSERT INTO ai_logs (type, symbol, message, data, confidence)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'analysis',
        symbol,
        `Real-time analysis: ${analysis.action}`,
        JSON.stringify(analysis),
        analysis.confidence
      ]);

      // Se confiança alta e trading automático ativo, executar trade
      if (analysis.confidence > 0.8 && analysis.action !== 'hold') {
        await this.executeAutoTrade(symbol, analysis);
      }

      // Emitir análise para frontend
      if (global.io) {
        global.io.emit('ai_analysis', {
          symbol,
          analysis,
          timestamp: new Date()
        });
      }

      logger.ai(`✅ Análise de ${symbol} concluída: ${analysis.action} (${(analysis.confidence * 100).toFixed(1)}%)`);
      
    } catch (error) {
      logger.error('❌ Erro na análise da IA:', error.message);
    }
  }

  /**
   * Executar trade automático baseado na análise da IA
   */
  async executeAutoTrade(symbol, analysis) {
    try {
      // Verificar se trading automático está habilitado
      const users = await this.getActiveUsers();
      
      for (const user of users) {
        if (!user.trading_active || !user.ai_active) continue;
        
        logger.trading(`🤖 Executando trade automático para usuário ${user.id}: ${symbol} ${analysis.action}`);
        
        // Verificar limites diários
        const dailyTrades = await this.getUserDailyTrades(user.id);
        if (dailyTrades >= user.max_daily_trades && user.max_daily_trades !== -1) {
          logger.warn(`⚠️ Limite diário de trades atingido para usuário ${user.id}`);
          continue;
        }

        // Executar trade
        const tradeResult = await this.executeTrade(user, symbol, analysis);
        
        if (tradeResult.success) {
          this.stats.tradesExecuted++;
          
          // Notificar usuário via Socket.IO
          if (global.io) {
            global.io.to(`user_${user.id}`).emit('auto_trade_executed', {
              symbol,
              action: analysis.action,
              confidence: analysis.confidence,
              trade_id: tradeResult.trade_id
            });
          }
        }
      }
      
    } catch (error) {
      logger.error('❌ Erro ao executar trade automático:', error.message);
    }
  }

  /**
   * Obter usuários com trading automático ativo
   */
  async getActiveUsers() {
    try {
      return await database.query(`
        SELECT u.id, u.subscription_type, ts.trading_active, ts.ai_active, 
               ts.entry_amount, ts.max_daily_trades, ts.broker
        FROM users u
        JOIN trading_settings ts ON u.id = ts.user_id
        WHERE u.status = 'active' 
          AND ts.trading_active = true 
          AND ts.ai_active = true
          AND u.subscription_type IN ('basic', 'premium')
      `);
    } catch (error) {
      logger.error('❌ Erro ao buscar usuários ativos:', error.message);
      return [];
    }
  }

  /**
   * Obter número de trades diários do usuário
   */
  async getUserDailyTrades(userId) {
    try {
      const result = await database.query(`
        SELECT COUNT(*) as count 
        FROM trades 
        WHERE user_id = ? AND DATE(created_at) = CURDATE()
      `, [userId]);
      
      return result[0].count;
    } catch (error) {
      logger.error('❌ Erro ao buscar trades diários:', error.message);
      return 0;
    }
  }

  /**
   * Executar trade individual
   */
  async executeTrade(user, symbol, analysis) {
    try {
      const tradeId = `AUTO_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      
      // Obter preço atual
      const currentPrice = this.getCurrentPrice(symbol);
      if (!currentPrice) {
        throw new Error('Preço atual não disponível');
      }

      // Calcular stop loss e take profit baseado na análise da IA
      const stopLoss = analysis.suggested_stop_loss || this.calculateStopLoss(currentPrice.price, analysis.action);
      const takeProfit = analysis.suggested_take_profit || this.calculateTakeProfit(currentPrice.price, analysis.action);

      // Para demo, apenas simular
      if (user.broker === 'deriv' && process.env.DERIV_DEMO_MODE === 'true') {
        // Salvar trade no banco como demo
        await database.query(`
          INSERT INTO trades (
            user_id, trade_id, symbol, type, entry_price, amount,
            stop_loss, take_profit, broker, is_demo, status,
            ai_confidence, ai_decision_data, opened_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          user.id, tradeId, symbol, analysis.action, currentPrice.price,
          user.entry_amount, stopLoss, takeProfit, 'deriv', true, 'active',
          analysis.confidence, JSON.stringify(analysis)
        ]);

        logger.trading(`✅ Trade demo criado: ${tradeId}`);
        
        return {
          success: true,
          trade_id: tradeId,
          type: 'demo'
        };
      }

      // Para trading real, usar Deriv API
      if (user.broker === 'deriv' && process.env.DERIV_API_TOKEN) {
        const derivResult = await this.executeRealDerivTrade(user, symbol, analysis, currentPrice);
        
        if (derivResult.success) {
          // Salvar no banco
          await database.query(`
            INSERT INTO trades (
              user_id, trade_id, symbol, type, entry_price, amount,
              stop_loss, take_profit, broker, is_demo, status,
              ai_confidence, ai_decision_data, opened_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          `, [
            user.id, derivResult.contract_id, symbol, analysis.action, currentPrice.price,
            user.entry_amount, stopLoss, takeProfit, 'deriv', false, 'active',
            analysis.confidence, JSON.stringify(analysis)
          ]);
        }

        return derivResult;
      }

      throw new Error('Configuração de trading não disponível');
      
    } catch (error) {
      logger.error('❌ Erro ao executar trade:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Executar trade real na Deriv
   */
  async executeRealDerivTrade(user, symbol, analysis, currentPrice) {
    try {
      // Configurar parâmetros do trade
      const tradeParams = {
        symbol,
        amount: user.entry_amount,
        duration: 300, // 5 minutos
        basis: 'stake'
      };

      let result;
      
      if (analysis.action === 'buy') {
        result = await derivAPI.buy(tradeParams);
      } else {
        // Para FOREX, "sell" seria um PUT
        tradeParams.contract_type = 'PUT';
        result = await derivAPI.buy(tradeParams); // Deriv usa buy() para ambos
      }

      if (result.buy) {
        logger.trading(`✅ Trade real executado na Deriv: ${result.buy.contract_id}`);
        
        return {
          success: true,
          contract_id: result.buy.contract_id,
          type: 'real',
          deriv_response: result
        };
      }

      throw new Error('Resposta inválida da Deriv API');
      
    } catch (error) {
      logger.error('❌ Erro no trade real Deriv:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calcular stop loss
   */
  calculateStopLoss(price, action) {
    const percentage = 0.02; // 2%
    
    if (action === 'buy') {
      return price * (1 - percentage);
    } else {
      return price * (1 + percentage);
    }
  }

  /**
   * Calcular take profit
   */
  calculateTakeProfit(price, action) {
    const percentage = 0.03; // 3%
    
    if (action === 'buy') {
      return price * (1 + percentage);
    } else {
      return price * (1 - percentage);
    }
  }

  /**
   * Obter preço atual de um símbolo
   */
  getCurrentPrice(symbol) {
    return this.priceCache.get(symbol);
  }

  /**
   * Calcular mudança de preço
   */
  calculatePriceChange(symbol, currentPrice) {
    const cached = this.priceCache.get(symbol);
    if (!cached) return 0;
    
    const change = currentPrice - cached.price;
    const changePercent = (change / cached.price) * 100;
    
    return {
      absolute: change,
      percentage: changePercent
    };
  }

  /**
   * Processar resposta de trade
   */
  handleTradeResponse(type, response) {
    logger.trading(`📊 Resposta de ${type}:`, response);
    
    // Emitir para frontend
    if (global.io) {
      global.io.emit('trade_response', {
        type,
        response,
        timestamp: new Date()
      });
    }
  }

  /**
   * Carregar símbolos ativos
   */
  async loadActiveSymbols() {
    try {
      const symbols = await derivAPI.getActiveSymbols();
      logger.info(`✅ ${symbols.length} símbolos ativos carregados`);
      
      // Emitir lista atualizada para frontend
      if (global.io) {
        global.io.emit('symbols_updated', {
          symbols,
          timestamp: new Date()
        });
      }
      
      return symbols;
    } catch (error) {
      logger.error('❌ Erro ao carregar símbolos:', error.message);
      return [];
    }
  }

  /**
   * Obter estatísticas da integração
   */
  getStats() {
    const uptime = Date.now() - this.stats.startTime.getTime();
    
    return {
      ...this.stats,
      uptime: Math.floor(uptime / 1000), // em segundos
      isConnected: derivAPI.isConnected,
      activeSubscriptions: this.activeSubscriptions.size,
      cachedPrices: this.priceCache.size
    };
  }

  /**
   * Subscribir a novos dados
   */
  async subscribeToSymbol(symbol, timeframes = ['1m', '5m']) {
    try {
      // Subscribir a ticks
      await derivAPI.subscribeTicks(symbol);
      
      // Subscribir a velas para cada timeframe
      for (const tf of timeframes) {
        const interval = this.timeframeToSeconds(tf);
        await derivAPI.subscribeCandles(symbol, interval);
      }
      
      this.activeSubscriptions.set(symbol, {
        ticks: true,
        candles: timeframes
      });
      
      logger.info(`✅ Subscrito a ${symbol} (${timeframes.join(', ')})`);
      return true;
      
    } catch (error) {
      logger.error(`❌ Erro ao subscribir ${symbol}:`, error.message);
      return false;
    }
  }

  /**
   * Converter timeframe para segundos
   */
  timeframeToSeconds(timeframe) {
    const map = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '4h': 14400,
      '1d': 86400
    };
    
    return map[timeframe] || 300;
  }

  /**
   * Parar integração
   */
  async shutdown() {
    logger.info('🔄 Parando integração Deriv API...');
    
    // Limpar subscriptions
    this.activeSubscriptions.clear();
    
    // Desconectar da API
    derivAPI.disconnect();
    
    this.isInitialized = false;
    logger.info('✅ Integração Deriv API parada');
  }

  /**
   * Verificar se está conectado
   */
  isConnected() {
    return derivAPI.isConnected;
  }
  
  /**
   * Obter todos os preços em cache
   */
  getAllPrices() {
    return Object.fromEntries(this.priceCache);
  }
  
  /**
   * Obter preço específico
   */
  getPrice(symbol) {
    return this.priceCache.get(symbol);
  }
  
  /**
   * Forçar nova análise de IA
   */
  async forceAnalysis(symbol) {
    if (this.isInitialized) {
      await this.analyzeWithAI(symbol);
    }
  }
}

// Criar instância singleton
const derivIntegration = new DerivIntegration();

module.exports = derivIntegration;
  constructor() {
    this.isInitialized = false;
    this.activeSubscriptions = new Map();
    this.forexAI = new ForexAI();
    this.realTimeData = new Map();
    
    // Configuração de símbolos padrão para monitorar
    this.defaultSymbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
    
    // Cache de preços
    this.priceCache = new Map();
    
    // Estatísticas
    this.stats = {
      ticksReceived: 0,
      candlesReceived: 0,
      aiAnalysisCount: 0,
      tradesExecuted: 0,
      startTime: new Date()
    };
  }

  /**
   * Executar trade automático baseado na análise da IA
   */
  async executeAutoTrade(symbol, analysis) {
    try {
      // Verificar se trading automático está habilitado
      const users = await this.getActiveUsers();
      
      for (const user of users) {
        if (!user.trading_active || !user.ai_active) continue;
        
        logger.trading(`🤖 Executando trade automático para usuário ${user.id}: ${symbol} ${analysis.action}`);
        
        // Verificar limites diários
        const dailyTrades = await this.getUserDailyTrades(user.id);
        if (dailyTrades >= user.max_daily_trades && user.max_daily_trades !== -1) {
          logger.warn(`⚠️ Limite diário de trades atingido para usuário ${user.id}`);
          continue;
        }

        // Executar trade
        const tradeResult = await this.executeTrade(user, symbol, analysis);
        
        if (tradeResult.success) {
          this.stats.tradesExecuted++;
          
          // Notificar usuário via Socket.IO
          if (global.io) {
            global.io.to(`user_${user.id}`).emit('auto_trade_executed', {
              symbol,
              action: analysis.action,
              confidence: analysis.confidence,
              trade_id: tradeResult.trade_id
            });
          }
        }
      }
      
    } catch (error) {
      logger.error('❌ Erro ao executar trade automático:', error.message);
    }
  }

  /**
   * Obter usuários com trading automático ativo
   */
  async getActiveUsers() {
    return await database.query(`
      SELECT u.id, u.subscription_type, ts.trading_active, ts.ai_active, 
             ts.entry_amount, ts.max_daily_trades, ts.broker
      FROM users u
      JOIN trading_settings ts ON u.id = ts.user_id
      WHERE u.status = 'active' 
        AND ts.trading_active = true 
        AND ts.ai_active = true
        AND u.subscription_type IN ('basic', 'premium')
    `);
  }

  /**
   * Obter número de trades diários do usuário
   */
  async getUserDailyTrades(userId) {
    const result = await database.query(`
      SELECT COUNT(*) as count 
      FROM trades 
      WHERE user_id = ? AND DATE(created_at) = CURDATE()
    `, [userId]);
    
    return result[0].count;
  }

  /**
   * Executar trade individual
   */
  async executeTrade(user, symbol, analysis) {
    try {
      const tradeId = `AUTO_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      
      // Obter preço atual
      const currentPrice = this.getCurrentPrice(symbol);
      if (!currentPrice) {
        throw new Error('Preço atual não disponível');
      }

      // Calcular stop loss e take profit baseado na análise da IA
      const stopLoss = analysis.suggested_stop_loss || this.calculateStopLoss(currentPrice.price, analysis.action);
      const takeProfit = analysis.suggested_take_profit || this.calculateTakeProfit(currentPrice.price, analysis.action);

      // Para demo, apenas simular
      if (user.broker === 'deriv' && process.env.DERIV_DEMO_MODE === 'true') {
        // Salvar trade no banco como demo
        await database.query(`
          INSERT INTO trades (
            user_id, trade_id, symbol, type, entry_price, amount,
            stop_loss, take_profit, broker, is_demo, status,
            ai_confidence, ai_decision_data, opened_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          user.id, tradeId, symbol, analysis.action, currentPrice.price,
          user.entry_amount, stopLoss, takeProfit, 'deriv', true, 'active',
          analysis.confidence, JSON.stringify(analysis)
        ]);

        logger.trading(`✅ Trade demo criado: ${tradeId}`);
        
        return {
          success: true,
          trade_id: tradeId,
          type: 'demo'
        };
      }

      // Para trading real, usar Deriv API
      if (user.broker === 'deriv' && process.env.DERIV_API_TOKEN) {
        const derivResult = await this.executeRealDerivTrade(user, symbol, analysis, currentPrice);
        
        if (derivResult.success) {
          // Salvar no banco
          await database.query(`
            INSERT INTO trades (
              user_id, trade_id, symbol, type, entry_price, amount,
              stop_loss, take_profit, broker, is_demo, status,
              ai_confidence, ai_decision_data, opened_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          `, [
            user.id, derivResult.contract_id, symbol, analysis.action, currentPrice.price,
            user.entry_amount, stopLoss, takeProfit, 'deriv', false, 'active',
            analysis.confidence, JSON.stringify(analysis)
          ]);
        }

        return derivResult;
      }

      throw new Error('Configuração de trading não disponível');
      
    } catch (error) {
      logger.error('❌ Erro ao executar trade:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Executar trade real na Deriv
   */
  async executeRealDerivTrade(user, symbol, analysis, currentPrice) {
    try {
      // Configurar parâmetros do trade
      const tradeParams = {
        symbol,
        amount: user.entry_amount,
        duration: 300, // 5 minutos
        basis: 'stake'
      };

      let result;
      
      if (analysis.action === 'buy') {
        result = await derivAPI.buy(tradeParams);
      } else {
        // Para FOREX, "sell" seria um PUT
        tradeParams.contract_type = 'PUT';
        result = await derivAPI.buy(tradeParams); // Deriv usa buy() para ambos
      }

      if (result.buy) {
        logger.trading(`✅ Trade real executado na Deriv: ${result.buy.contract_id}`);
        
        return {
          success: true,
          contract_id: result.buy.contract_id,
          type: 'real',
          deriv_response: result
        };
      }

      throw new Error('Resposta inválida da Deriv API');
      
    } catch (error) {
      logger.error('❌ Erro no trade real Deriv:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calcular stop loss
   */
  calculateStopLoss(price, action) {
    const percentage = 0.02; // 2%
    
    if (action === 'buy') {
      return price * (1 - percentage);
    } else {
      return price * (1 + percentage);
    }
  }

  /**
   * Calcular take profit
   */
  calculateTakeProfit(price, action) {
    const percentage = 0.03; // 3%
    
    if (action === 'buy') {
      return price * (1 + percentage);
    } else {
      return price * (1 - percentage);
    }
  }

  /**
   * Obter preço atual de um símbolo
   */
  getCurrentPrice(symbol) {
    return this.priceCache.get(symbol);
  }

  /**
   * Calcular mudança de preço
   */
  calculatePriceChange(symbol, currentPrice) {
    const cached = this.priceCache.get(symbol);
    if (!cached) return 0;
    
    const change = currentPrice - cached.price;
    const changePercent = (change / cached.price) * 100;
    
    return {
      absolute: change,
      percentage: changePercent
    };
  }

  /**
   * Processar resposta de trade
   */
  handleTradeResponse(type, response) {
    logger.trading(`📊 Resposta de ${type}:`, response);
    
    // Emitir para frontend
    if (global.io) {
      global.io.emit('trade_response', {
        type,
        response,
        timestamp: new Date()
      });
    }
  }

  /**
   * Carregar símbolos ativos
   */
  async loadActiveSymbols() {
    try {
      const symbols = await derivAPI.getActiveSymbols();
      logger.info(`✅ ${symbols.length} símbolos ativos carregados`);
      
      // Emitir lista atualizada para frontend
      if (global.io) {
        global.io.emit('symbols_updated', {
          symbols,
          timestamp: new Date()
        });
      }
      
      return symbols;
    } catch (error) {
      logger.error('❌ Erro ao carregar símbolos:', error.message);
      return [];
    }
  }

  /**
   * Obter estatísticas da integração
   */
  getStats() {
    const uptime = Date.now() - this.stats.startTime.getTime();
    
    return {
      ...this.stats,
      uptime: Math.floor(uptime / 1000), // em segundos
      isConnected: derivAPI.isConnected,
      activeSubscriptions: this.activeSubscriptions.size,
      cachedPrices: this.priceCache.size
    };
  }

  /**
   * Subscribir a novos dados
   */
  async subscribeToSymbol(symbol, timeframes = ['1m', '5m']) {
    try {
      // Subscribir a ticks
      await derivAPI.subscribeTicks(symbol);
      
      // Subscribir a velas para cada timeframe
      for (const tf of timeframes) {
        const interval = this.timeframeToSeconds(tf);
        await derivAPI.subscribeCandles(symbol, interval);
      }
      
      this.activeSubscriptions.set(symbol, {
        ticks: true,
        candles: timeframes
      });
      
      logger.info(`✅ Subscrito a ${symbol} (${timeframes.join(', ')})`);
      return true;
      
    } catch (error) {
      logger.error(`❌ Erro ao subscribir ${symbol}:`, error.message);
      return false;
    }
  }

  /**
   * Converter timeframe para segundos
   */
  timeframeToSeconds(timeframe) {
    const map = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '4h': 14400,
      '1d': 86400
    };
    
    return map[timeframe] || 300;
  }

  /**
   * Parar integração
   */
  async shutdown() {
    logger.info('🔄 Parando integração Deriv API...');
    
    // Limpar subscriptions
    this.activeSubscriptions.clear();
    
    // Desconectar da API
    derivAPI.disconnect();
    
    this.isInitialized = false;
    logger.info('✅ Integração Deriv API parada');
  }

  /**
   * Métodos para serem utilizados por outros módulos
   */
  
  // Verificar se está conectado
  isConnected() {
    return derivAPI.isConnected;
  }
  
  // Obter todos os preços em cache
  getAllPrices() {
    return Object.fromEntries(this.priceCache);
  }
  
  // Obter preço específico
  getPrice(symbol) {
    return this.priceCache.get(symbol);
  }
  
  // Forçar nova análise de IA
  async forceAnalysis(symbol) {
    if (this.isInitialized) {
      await this.analyzeWithAI(symbol);
    }
  }
}

// Criar instância singleton
const derivIntegration = new DerivIntegration();

module.exports = derivIntegration;
   * Inicializar integração
   */
  async initialize() {
    try {
      logger.info('🚀 Inicializando integração Deriv API...');

      // Conectar à Deriv API
      await derivAPI.connect();
      
      // Configurar event listeners
      this.setupEventListeners();
      
      // Subscribir aos dados padrão
      await this.subscribeToDefaultData();
      
      // Obter símbolos ativos
      await this.loadActiveSymbols();
      
      this.isInitialized = true;
      logger.info('✅ Integração Deriv API inicializada com sucesso');
      
      return true;
    } catch (error) {
      logger.error('❌ Erro ao inicializar Deriv API:', error.message);
      throw error;
    }
  }

  /**
   * Configurar listeners de eventos
   */
  setupEventListeners() {
    // Dados de tick em tempo real
    derivAPI.on('tick', (tickData) => {
      this.handleTickData(tickData);
    });

    // Dados de velas
    derivAPI.on('candle', (candleData) => {
      this.handleCandleData(candleData);
    });

    // Eventos de conexão
    derivAPI.on('connected', () => {
      logger.info('🔗 Deriv API conectada');
      this.emit('deriv_connected');
    });

    derivAPI.on('disconnected', () => {
      logger.warn('🔌 Deriv API desconectada');
      this.emit('deriv_disconnected');
    });

    derivAPI.on('error', (error) => {
      logger.error('❌ Erro na Deriv API:', error.message);
      this.emit('deriv_error', error);
    });

    // Eventos de trading
    derivAPI.on('buy_response', (response) => {
      this.handleTradeResponse('buy', response);
    });

    derivAPI.on('sell_response', (response) => {
      this.handleTradeResponse('sell', response);
    });
  }

  /**
   * Subscribir aos dados padrão
   */
  async subscribeToDefaultData() {
    for (const symbol of this.defaultSymbols) {
      try {
        // Subscribir a ticks
        await derivAPI.subscribeTicks(symbol);
        
        // Subscribir a velas de 1 minuto
        await derivAPI.subscribeCandles(symbol, 60);
        
        // Subscribir a velas de 5 minutos
        await derivAPI.subscribeCandles(symbol, 300);
        
        this.activeSubscriptions.set(symbol, {
          ticks: true,
          candles_1m: true,
          candles_5m: true
        });
        
        logger.info(`✅ Dados de ${symbol} subscritos`);
        
      } catch (error) {
        logger.error(`❌ Erro ao subscribir ${symbol}:`, error.message);
      }
    }
  }

  /**
   * Processar dados de tick
   */
  async handleTickData(tickData) {
    this.stats.ticksReceived++;
    
    // Atualizar cache de preços
    this.priceCache.set(tickData.symbol, {
      price: tickData.price,
      bid: tickData.bid,
      ask: tickData.ask,
      timestamp: tickData.timestamp,
      spread: tickData.ask - tickData.bid
    });

    // Emitir via Socket.IO para frontend
    if (global.io) {
      global.io.emit('tick_update', {
        symbol: tickData.symbol,
        price: tickData.price,
        timestamp: tickData.timestamp,
        change: this.calculatePriceChange(tickData.symbol, tickData.price)
      });
    }

    // Log debug a cada 100 ticks
    if (this.stats.ticksReceived % 100 === 0) {
      logger.debug(`📊 Ticks processados: ${this.stats.ticksReceived}`);
    }
  }

  /**
   * Processar dados de velas
   */
  async handleCandleData(candleData) {
    this.stats.candlesReceived++;
    
    try {
      // Salvar vela no banco de dados
      await this.saveCandleToDB(candleData);
      
      // Enviar para análise da IA (apenas velas de 5 minutos)
      if (this.shouldAnalyzeCandle(candleData)) {
        await this.analyzeWithAI(candleData.symbol);
      }
      
      // Emitir para frontend
      if (global.io) {
        global.io.emit('candle_update', {
          symbol: candleData.symbol,
          candle: candleData,
          timestamp: candleData.timestamp
        });
      }
      
    } catch (error) {
      logger.error('❌ Erro ao processar vela:', error.message);
    }
  }

  /**
   * Salvar vela no banco de dados
   */
  async saveCandleToDB(candleData) {
    // Determinar timeframe baseado no intervalo
    const timeframe = this.determineTimeframe(candleData);
    
    await database.query(`
      INSERT INTO market_data (symbol, timeframe, timestamp, open_price, high_price, low_price, close_price, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
      open_price = VALUES(open_price),
      high_price = VALUES(high_price),
      low_price = VALUES(low_price),
      close_price = VALUES(close_price)
    `, [
      candleData.symbol,
      timeframe,
      candleData.timestamp,
      candleData.open,
      candleData.high,
      candleData.low,
      candleData.close,
      0 // Volume não disponível na Deriv para FOREX
    ]);
  }

  /**
   * Determinar timeframe da vela
   */
  determineTimeframe(candleData) {
    // Por enquanto retornar 5m como padrão
    // Pode ser melhorado para detectar baseado no intervalo
    return '5m';
  }

  /**
   * Verificar se deve analisar a vela com IA
   */
  shouldAnalyzeCandle(candleData) {
    // Analisar apenas a cada 5 velas para não sobrecarregar
    return this.stats.candlesReceived % 5 === 0;
  }

  /**
   * Analisar com IA
   */
  async analyzeWithAI(symbol) {
    try {
      this.stats.aiAnalysisCount++;
      
      logger.ai(`🧠 Analisando ${symbol} com IA...`);
      
      // Executar análise da IA
      const analysis = await this.forexAI.analyzeMarket(symbol, '5m');
      
      // Salvar análise no banco
      await database.query(`
        INSERT INTO ai_logs (type, symbol, message, data, confidence)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'analysis',
        symbol,
        `Real-time analysis: ${analysis.action}`,
        JSON.stringify(analysis),
        analysis.confidence
      ]);

      // Se confiança alta e trading automático ativo, executar trade
      if (analysis.confidence > 0.8 && analysis.action !== 'hold') {
        await this.executeAutoTrade(symbol, analysis);
      }

      // Emitir análise para frontend
      if (global.io) {
        global.io.emit('ai_analysis', {
          symbol,
          analysis,
          timestamp: new Date()
        });
      }

      logger.ai(`✅ Análise de ${symbol} concluída: ${analysis.action} (${(analysis.confidence * 100).toFixed(1)}%)`);
      
    } catch (error) {
      logger.error('❌ Erro na análise da IA:', error.message);
    }
  }

  /**