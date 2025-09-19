/**
 * Deriv API Integration Service
 * WebSocket connection para trading real
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const database = require('../config/database');

class DerivAPI extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.isConnected = false;
    this.requestId = 1;
    this.pendingRequests = new Map();
    this.subscriptions = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    
    // Configurações da API
    this.config = {
      endpoint: 'wss://ws.binaryws.com/websockets/v3',
      appId: process.env.DERIV_APP_ID || '1089', // App ID público para desenvolvimento
      apiToken: process.env.DERIV_API_TOKEN, // Token de usuário (opcional para dados públicos)
      language: 'en'
    };

    // Símbolos FOREX disponíveis na Deriv
    this.forexSymbols = {
      'EURUSD': 'frxEURUSD',
      'GBPUSD': 'frxGBPUSD', 
      'USDJPY': 'frxUSDJPY',
      'AUDUSD': 'frxAUDUSD',
      'USDCAD': 'frxUSDCAD',
      'EURGBP': 'frxEURGBP',
      'EURJPY': 'frxEURJPY',
      'GBPJPY': 'frxGBPJPY',
      'XAUUSD': 'frxXAUUSD', // Gold
      'XAGUSD': 'frxXAGUSD'  // Silver
    };

    this.reverseSymbols = Object.fromEntries(
      Object.entries(this.forexSymbols).map(([k, v]) => [v, k])
    );
  }

  /**
   * Conectar à Deriv API
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        logger.info('🔄 Conectando à Deriv API...');
        
        this.ws = new WebSocket(this.config.endpoint);
        
        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          logger.info('✅ Conectado à Deriv API');
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(JSON.parse(data.toString()));
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          logger.warn('🔌 Conexão com Deriv API fechada');
          this.emit('disconnected');
          this.handleReconnect();
        });

        this.ws.on('error', (error) => {
          logger.error('❌ Erro na Deriv API:', error.message);
          this.emit('error', error);
          reject(error);
        });

        // Timeout de conexão
        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('Timeout na conexão com Deriv API'));
          }
        }, 10000);

      } catch (error) {
        logger.error('❌ Erro ao conectar Deriv API:', error.message);
        reject(error);
      }
    });
  }

  /**
   * Processar mensagens recebidas
   */
  handleMessage(message) {
    const { req_id, msg_type, error } = message;

    // Log da mensagem recebida
    logger.debug('📥 Deriv API Response:', { msg_type, req_id, hasError: !!error });

    // Tratar erros
    if (error) {
      logger.error('❌ Erro na resposta Deriv API:', error);
      this.emit('error', error);
      
      if (req_id && this.pendingRequests.has(req_id)) {
        const { reject } = this.pendingRequests.get(req_id);
        reject(new Error(error.message || 'Erro desconhecido da Deriv API'));
        this.pendingRequests.delete(req_id);
      }
      return;
    }

    // Resolver requests pendentes
    if (req_id && this.pendingRequests.has(req_id)) {
      const { resolve } = this.pendingRequests.get(req_id);
      resolve(message);
      this.pendingRequests.delete(req_id);
      return;
    }

    // Processar diferentes tipos de mensagem
    switch (msg_type) {
      case 'tick':
        this.handleTickData(message);
        break;
      
      case 'candles':
        this.handleCandleData(message);
        break;
      
      case 'ohlc':
        this.handleOHLCData(message);
        break;
        
      case 'buy':
        this.handleBuyResponse(message);
        break;
        
      case 'sell':
        this.handleSellResponse(message);
        break;
        
      case 'balance':
        this.handleBalanceUpdate(message);
        break;
        
      case 'portfolio':
        this.handlePortfolioUpdate(message);
        break;
        
      default:
        logger.debug('📨 Mensagem não tratada:', { msg_type, message });
    }
  }

  /**
   * Enviar request para a API
   */
  async sendRequest(request) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Não conectado à Deriv API'));
        return;
      }

      const reqId = this.requestId++;
      const requestWithId = { 
        ...request, 
        req_id: reqId,
        passthrough: { ...request.passthrough }
      };

      // Armazenar callback para resolver quando resposta chegar
      this.pendingRequests.set(reqId, { resolve, reject });

      // Enviar request
      this.ws.send(JSON.stringify(requestWithId));
      
      logger.debug('📤 Deriv API Request:', { req_id: reqId, ...request });

      // Timeout para requests
      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          reject(new Error('Timeout na requisição para Deriv API'));
        }
      }, 30000);
    });
  }

  /**
   * Obter dados de tick em tempo real
   */
  async subscribeTicks(symbol) {
    const derivSymbol = this.forexSymbols[symbol];
    if (!derivSymbol) {
      throw new Error(`Símbolo ${symbol} não suportado`);
    }

    const request = {
      ticks: derivSymbol,
      subscribe: 1
    };

    const response = await this.sendRequest(request);
    
    // Armazenar subscription
    this.subscriptions.set(`tick_${symbol}`, response.subscription?.id);
    
    logger.info(`✅ Subscrito aos ticks de ${symbol}`);
    return response;
  }

  /**
   * Obter dados de velas (candles)
   */
  async subscribeCandles(symbol, interval = 60) {
    const derivSymbol = this.forexSymbols[symbol];
    if (!derivSymbol) {
      throw new Error(`Símbolo ${symbol} não suportado`);
    }

    const request = {
      ticks_history: derivSymbol,
      adjust_start_time: 1,
      count: 1000,
      end: 'latest',
      granularity: interval, // em segundos: 60=1m, 300=5m, 900=15m, 3600=1h
      style: 'candles',
      subscribe: 1
    };

    const response = await this.sendRequest(request);
    
    // Armazenar subscription
    this.subscriptions.set(`candles_${symbol}_${interval}`, response.subscription?.id);
    
    logger.info(`✅ Subscrito às velas de ${symbol} (${interval}s)`);
    return response;
  }

  /**
   * Processar dados de tick
   */
  handleTickData(message) {
    const { tick } = message;
    if (!tick) return;

    const symbol = this.reverseSymbols[tick.symbol];
    if (!symbol) return;

    const tickData = {
      symbol,
      price: parseFloat(tick.quote),
      timestamp: new Date(tick.epoch * 1000),
      bid: parseFloat(tick.bid || tick.quote),
      ask: parseFloat(tick.ask || tick.quote)
    };

    logger.debug(`📈 Tick ${symbol}:`, tickData);
    
    // Emitir evento para outros módulos
    this.emit('tick', tickData);
    
    // Salvar no banco (opcional)
    this.saveTick(tickData);
  }

  /**
   * Processar dados de velas
   */
  handleCandleData(message) {
    const { candles, ohlc } = message;
    
    if (candles) {
      // Dados históricos de velas
      candles.forEach(candle => {
        this.processSingleCandle(candle, message.echo_req?.ticks_history);
      });
    }
    
    if (ohlc) {
      // Nova vela em tempo real
      this.processSingleCandle(ohlc, message.echo_req?.ticks_history);
    }
  }

  /**
   * Processar uma vela individual
   */
  processSingleCandle(candle, derivSymbol) {
    const symbol = this.reverseSymbols[derivSymbol];
    if (!symbol) return;

    const candleData = {
      symbol,
      timestamp: new Date(candle.epoch * 1000),
      open: parseFloat(candle.open),
      high: parseFloat(candle.high),
      low: parseFloat(candle.low),
      close: parseFloat(candle.close)
    };

    logger.debug(`🕯️ Candle ${symbol}:`, candleData);
    
    // Emitir evento
    this.emit('candle', candleData);
    
    // Salvar no banco
    this.saveCandle(candleData);
  }

  /**
   * Fazer uma compra (Buy)
   */
  async buy(options) {
    if (!this.config.apiToken) {
      throw new Error('API Token necessário para trading real');
    }

    const { symbol, amount, duration = 60, basis = 'stake' } = options;
    const derivSymbol = this.forexSymbols[symbol];
    
    if (!derivSymbol) {
      throw new Error(`Símbolo ${symbol} não suportado`);
    }

    const request = {
      buy: 1,
      price: amount,
      parameters: {
        amount,
        basis, // 'stake' ou 'payout'
        contract_type: 'CALL', // ou 'PUT' para venda
        currency: 'USD',
        duration,
        duration_unit: 's', // segundos
        symbol: derivSymbol
      }
    };

    const response = await this.sendRequest(request);
    logger.trading(`✅ Compra executada em ${symbol}:`, response);
    
    return response;
  }

  /**
   * Fazer uma venda (Sell)
   */
  async sell(contractId, price) {
    if (!this.config.apiToken) {
      throw new Error('API Token necessário para trading real');
    }

    const request = {
      sell: contractId,
      price: price
    };

    const response = await this.sendRequest(request);
    logger.trading(`✅ Venda executada:`, response);
    
    return response;
  }

  /**
   * Obter saldo da conta
   */
  async getBalance() {
    if (!this.config.apiToken) {
      throw new Error('API Token necessário para obter saldo');
    }

    const request = {
      balance: 1,
      subscribe: 1
    };

    const response = await this.sendRequest(request);
    return response.balance;
  }

  /**
   * Obter portfólio (posições abertas)
   */
  async getPortfolio() {
    if (!this.config.apiToken) {
      throw new Error('API Token necessário para obter portfólio');
    }

    const request = {
      portfolio: 1
    };

    const response = await this.sendRequest(request);
    return response.portfolio;
  }

  /**
   * Salvar tick no banco
   */
  async saveTick(tickData) {
    try {
      // Implementar salvamento de ticks se necessário
      // Por performance, pode salvar apenas alguns ticks ou usar Redis
    } catch (error) {
      logger.error('Erro ao salvar tick:', error.message);
    }
  }

  /**
   * Salvar vela no banco
   */
  async saveCandle(candleData) {
    try {
      const timeframe = '1m'; // Determinar timeframe baseado no intervalo
      
      await database.query(`
        INSERT INTO market_data (symbol, timeframe, timestamp, open_price, high_price, low_price, close_price)
        VALUES (?, ?, ?, ?, ?, ?, ?)
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
        candleData.close
      ]);
      
    } catch (error) {
      logger.error('Erro ao salvar candle:', error.message);
    }
  }

  /**
   * Reconectar automaticamente
   */
  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('❌ Máximo de tentativas de reconexão atingido');
      return;
    }

    this.reconnectAttempts++;
    
    logger.info(`🔄 Tentativa de reconexão ${this.reconnectAttempts}/${this.maxReconnectAttempts} em ${this.reconnectDelay/1000}s`);
    
    setTimeout(() => {
      this.connect().catch(error => {
        logger.error('❌ Falha na reconexão:', error.message);
      });
    }, this.reconnectDelay);
  }

  /**
   * Desconectar
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.isConnected = false;
      logger.info('🔌 Desconectado da Deriv API');
    }
  }

  /**
   * Obter lista de símbolos ativos
   */
  async getActiveSymbols() {
    const request = {
      active_symbols: 'brief',
      product_type: 'basic'
    };

    const response = await this.sendRequest(request);
    
    // Filtrar apenas símbolos FOREX que temos mapeados
    const forexSymbols = response.active_symbols?.filter(symbol => 
      Object.values(this.forexSymbols).includes(symbol.symbol)
    );

    return forexSymbols;
  }

  /**
   * Processar resposta de compra
   */
  handleBuyResponse(message) {
    logger.trading('📈 Resposta de compra:', message);
    this.emit('buy_response', message);
  }

  /**
   * Processar resposta de venda
   */
  handleSellResponse(message) {
    logger.trading('📉 Resposta de venda:', message);
    this.emit('sell_response', message);
  }

  /**
   * Processar atualização de saldo
   */
  handleBalanceUpdate(message) {
    logger.info('💰 Saldo atualizado:', message.balance);
    this.emit('balance_update', message.balance);
  }

  /**
   * Processar atualização de portfólio
   */
  handlePortfolioUpdate(message) {
    logger.info('📊 Portfólio atualizado:', message.portfolio);
    this.emit('portfolio_update', message.portfolio);
  }
}

// Criar instância singleton
const derivAPI = new DerivAPI();

module.exports = derivAPI;