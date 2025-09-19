/**
 * Sistema de IA para Análise de Mercado FOREX
 * Análise técnica, indicadores e tomada de decisões
 */

const database = require('../config/database');
const logger = require('../utils/logger');

class ForexAI {
  constructor() {
    this.confidence_threshold = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || 0.75);
    this.indicators = new TechnicalIndicators();
  }

  /**
   * Análise completa de mercado para um símbolo
   */
  async analyzeMarket(symbol, timeframe = '5m') {
    try {
      logger.ai(`Iniciando análise de mercado para ${symbol}`, { symbol, timeframe });

      // 1. Obter dados históricos
      const marketData = await this.getMarketData(symbol, timeframe, 200);
      if (marketData.length < 50) {
        throw new Error('Dados insuficientes para análise');
      }

      // 2. Calcular indicadores técnicos
      const indicators = await this.calculateIndicators(marketData);

      // 3. Análise de padrões
      const patterns = await this.detectPatterns(marketData);

      // 4. Análise de suporte e resistência
      const supportResistance = await this.findSupportResistance(marketData);

      // 5. Análise de tendência
      const trend = await this.analyzeTrend(marketData, indicators);

      // 6. Análise de volume (se disponível)
      const volumeAnalysis = await this.analyzeVolume(marketData);

      // 7. Combinar todas as análises
      const decision = await this.makeDecision({
        symbol,
        indicators,
        patterns,
        supportResistance,
        trend,
        volumeAnalysis,
        currentPrice: marketData[marketData.length - 1].close
      });

      // 8. Salvar log da análise
      await this.logAnalysis(symbol, decision, {
        indicators,
        patterns,
        trend
      });

      logger.ai(`Análise concluída para ${symbol}`, {
        symbol,
        decision: decision.action,
        confidence: decision.confidence
      });

      return decision;

    } catch (error) {
      logger.error('Erro na análise de mercado', {
        error: error.message,
        symbol,
        timeframe
      });
      
      return {
        action: 'hold',
        confidence: 0,
        reason: 'Erro na análise',
        error: error.message
      };
    }
  }

  /**
   * Obter dados de mercado
   */
  async getMarketData(symbol, timeframe, limit) {
    try {
      const data = await database.query(`
        SELECT timestamp, open_price as open, high_price as high, 
               low_price as low, close_price as close, volume
        FROM market_data 
        WHERE symbol = ? AND timeframe = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `, [symbol, timeframe, limit]);

      // Se não tiver dados, gerar dados simulados
      if (data.length === 0) {
        return this.generateSimulatedData(symbol, limit);
      }

      return data.map(item => ({
        timestamp: item.timestamp,
        open: parseFloat(item.open),
        high: parseFloat(item.high),
        low: parseFloat(item.low),
        close: parseFloat(item.close),
        volume: parseInt(item.volume || 0)
      })).reverse(); // Ordem cronológica

    } catch (error) {
      logger.error('Erro ao obter dados de mercado', { error: error.message, symbol });
      return this.generateSimulatedData(symbol, limit);
    }
  }

  /**
   * Calcular indicadores técnicos
   */
  async calculateIndicators(data) {
    const prices = data.map(d => d.close);
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);

    return {
      // Médias móveis
      sma20: this.indicators.SMA(prices, 20),
      sma50: this.indicators.SMA(prices, 50),
      ema12: this.indicators.EMA(prices, 12),
      ema26: this.indicators.EMA(prices, 26),
      
      // MACD
      macd: this.indicators.MACD(prices, 12, 26, 9),
      
      // RSI
      rsi: this.indicators.RSI(prices, 14),
      
      // Bollinger Bands
      bollinger: this.indicators.BollingerBands(prices, 20, 2),
      
      // Stochastic
      stochastic: this.indicators.Stochastic(highs, lows, prices, 14, 3),
      
      // ATR (Average True Range)
      atr: this.indicators.ATR(highs, lows, prices, 14),
      
      // Williams %R
      williamsR: this.indicators.WilliamsR(highs, lows, prices, 14)
    };
  }

  /**
   * Detectar padrões de candlesticks
   */
  async detectPatterns(data) {
    const patterns = {
      doji: false,
      hammer: false,
      shootingStar: false,
      engulfing: false,
      morning_star: false,
      evening_star: false
    };

    if (data.length < 3) return patterns;

    const recent = data.slice(-3);
    const current = recent[recent.length - 1];
    const previous = recent[recent.length - 2];

    // Detectar Doji
    const bodySize = Math.abs(current.close - current.open);
    const candleRange = current.high - current.low;
    patterns.doji = bodySize / candleRange < 0.1;

    // Detectar Hammer
    const lowerShadow = current.open > current.close ? 
      current.close - current.low : current.open - current.low;
    const upperShadow = current.high - Math.max(current.open, current.close);
    patterns.hammer = lowerShadow > bodySize * 2 && upperShadow < bodySize * 0.5;

    // Detectar Shooting Star
    patterns.shootingStar = upperShadow > bodySize * 2 && lowerShadow < bodySize * 0.5;

    // Detectar Engulfing
    if (previous) {
      const prevBody = Math.abs(previous.close - previous.open);
      const currBody = Math.abs(current.close - current.open);
      
      patterns.engulfing = currBody > prevBody * 1.5 &&
        ((previous.close < previous.open && current.close > current.open) ||
         (previous.close > previous.open && current.close < current.open));
    }

    return patterns;
  }

  /**
   * Encontrar níveis de suporte e resistência
   */
  async findSupportResistance(data) {
    const prices = data.map(d => d.close);
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);

    // Encontrar máximos e mínimos locais
    const resistance = this.findLocalMaxima(highs, 5);
    const support = this.findLocalMinima(lows, 5);

    return {
      resistance: resistance.slice(-3), // 3 últimos níveis de resistência
      support: support.slice(-3), // 3 últimos níveis de suporte
      current_price: prices[prices.length - 1]
    };
  }

  /**
   * Analisar tendência
   */
  async analyzeTrend(data, indicators) {
    const prices = data.map(d => d.close);
    const currentPrice = prices[prices.length - 1];

    // Análise baseada em médias móveis
    const sma20 = indicators.sma20[indicators.sma20.length - 1];
    const sma50 = indicators.sma50[indicators.sma50.length - 1];

    let trend = 'sideways';
    let strength = 0;

    if (currentPrice > sma20 && sma20 > sma50) {
      trend = 'uptrend';
      strength = (currentPrice - sma50) / sma50 * 100;
    } else if (currentPrice < sma20 && sma20 < sma50) {
      trend = 'downtrend';
      strength = (sma50 - currentPrice) / sma50 * 100;
    }

    return {
      direction: trend,
      strength: Math.abs(strength),
      sma20_position: currentPrice > sma20 ? 'above' : 'below',
      sma50_position: currentPrice > sma50 ? 'above' : 'below'
    };
  }

  /**
   * Analisar volume
   */
  async analyzeVolume(data) {
    const volumes = data.map(d => d.volume || 0);
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const currentVolume = volumes[volumes.length - 1];

    return {
      average_volume: avgVolume,
      current_volume: currentVolume,
      volume_ratio: currentVolume / avgVolume,
      is_high_volume: currentVolume > avgVolume * 1.5
    };
  }

  /**
   * Tomar decisão baseada em todas as análises
   */
  async makeDecision(analysis) {
    const {
      indicators,
      patterns,
      supportResistance,
      trend,
      volumeAnalysis,
      currentPrice
    } = analysis;

    let bullishSignals = 0;
    let bearishSignals = 0;
    let signalStrength = 0;
    const reasons = [];

    // Análise RSI
    const rsi = indicators.rsi[indicators.rsi.length - 1];
    if (rsi < 30) {
      bullishSignals += 2;
      reasons.push('RSI oversold (<30)');
    } else if (rsi > 70) {
      bearishSignals += 2;
      reasons.push('RSI overbought (>70)');
    }

    // Análise MACD
    const macd = indicators.macd;
    const macdLine = macd.macd[macd.macd.length - 1];
    const signalLine = macd.signal[macd.signal.length - 1];
    const histogram = macd.histogram[macd.histogram.length - 1];

    if (macdLine > signalLine && histogram > 0) {
      bullishSignals += 1.5;
      reasons.push('MACD bullish crossover');
    } else if (macdLine < signalLine && histogram < 0) {
      bearishSignals += 1.5;
      reasons.push('MACD bearish crossover');
    }

    // Análise de Bollinger Bands
    const bollinger = indicators.bollinger;
    const upperBand = bollinger.upper[bollinger.upper.length - 1];
    const lowerBand = bollinger.lower[bollinger.lower.length - 1];
    const middleBand = bollinger.middle[bollinger.middle.length - 1];

    if (currentPrice <= lowerBand) {
      bullishSignals += 1;
      reasons.push('Price at lower Bollinger Band');
    } else if (currentPrice >= upperBand) {
      bearishSignals += 1;
      reasons.push('Price at upper Bollinger Band');
    }

    // Análise de tendência
    if (trend.direction === 'uptrend' && trend.strength > 1) {
      bullishSignals += 1;
      reasons.push(`Strong uptrend (${trend.strength.toFixed(2)}%)`);
    } else if (trend.direction === 'downtrend' && trend.strength > 1) {
      bearishSignals += 1;
      reasons.push(`Strong downtrend (${trend.strength.toFixed(2)}%)`);
    }

    // Análise de padrões
    if (patterns.hammer || patterns.morning_star) {
      bullishSignals += 1;
      reasons.push('Bullish candlestick pattern detected');
    }
    if (patterns.shootingStar || patterns.evening_star) {
      bearishSignals += 1;
      reasons.push('Bearish candlestick pattern detected');
    }

    // Análise de suporte/resistência
    const nearSupport = supportResistance.support.some(level => 
      Math.abs(currentPrice - level) / currentPrice < 0.001
    );
    const nearResistance = supportResistance.resistance.some(level => 
      Math.abs(currentPrice - level) / currentPrice < 0.001
    );

    if (nearSupport) {
      bullishSignals += 0.5;
      reasons.push('Price near support level');
    }
    if (nearResistance) {
      bearishSignals += 0.5;
      reasons.push('Price near resistance level');
    }

    // Análise de volume
    if (volumeAnalysis.is_high_volume) {
      signalStrength += 0.2;
      reasons.push('High volume confirmation');
    }

    // Calcular confiança e decisão
    const totalSignals = bullishSignals + bearishSignals;
    let action = 'hold';
    let confidence = 0;

    if (totalSignals > 0) {
      if (bullishSignals > bearishSignals) {
        action = 'buy';
        confidence = (bullishSignals / (bullishSignals + bearishSignals)) * 0.8 + signalStrength;
      } else if (bearishSignals > bullishSignals) {
        action = 'sell';
        confidence = (bearishSignals / (bullishSignals + bearishSignals)) * 0.8 + signalStrength;
      }
    }

    confidence = Math.min(confidence, 0.95); // Máximo 95% de confiança

    // Aplicar threshold de confiança
    if (confidence < this.confidence_threshold) {
      action = 'hold';
    }

    return {
      action,
      confidence: parseFloat(confidence.toFixed(3)),
      bullish_signals: bullishSignals,
      bearish_signals: bearishSignals,
      reasons,
      indicators_summary: {
        rsi: rsi.toFixed(2),
        macd_signal: macdLine > signalLine ? 'bullish' : 'bearish',
        trend: trend.direction,
        bb_position: currentPrice > middleBand ? 'upper_half' : 'lower_half'
      },
      risk_level: this.calculateRiskLevel(confidence, indicators),
      suggested_stop_loss: this.calculateStopLoss(currentPrice, indicators, action),
      suggested_take_profit: this.calculateTakeProfit(currentPrice, indicators, action)
    };
  }

  /**
   * Calcular nível de risco
   */
  calculateRiskLevel(confidence, indicators) {
    const atr = indicators.atr[indicators.atr.length - 1];
    const rsi = indicators.rsi[indicators.rsi.length - 1];

    let riskScore = 0;

    // Baixa confiança = alto risco
    if (confidence < 0.6) riskScore += 3;
    else if (confidence < 0.75) riskScore += 2;
    else riskScore += 1;

    // Alta volatilidade = alto risco
    if (atr > 0.002) riskScore += 2;
    else if (atr > 0.001) riskScore += 1;

    // RSI extremos = risco moderado
    if (rsi < 20 || rsi > 80) riskScore += 1;

    if (riskScore <= 2) return 'low';
    if (riskScore <= 4) return 'medium';
    return 'high';
  }

  /**
   * Calcular stop loss sugerido
   */
  calculateStopLoss(currentPrice, indicators, action) {
    const atr = indicators.atr[indicators.atr.length - 1];
    const atrMultiplier = 2; // 2x ATR para stop loss

    if (action === 'buy') {
      return currentPrice - (atr * atrMultiplier);
    } else if (action === 'sell') {
      return currentPrice + (atr * atrMultiplier);
    }
    return null;
  }

  /**
   * Calcular take profit sugerido
   */
  calculateTakeProfit(currentPrice, indicators, action) {
    const atr = indicators.atr[indicators.atr.length - 1];
    const atrMultiplier = 3; // 3x ATR para take profit (risk:reward 1:1.5)

    if (action === 'buy') {
      return currentPrice + (atr * atrMultiplier);
    } else if (action === 'sell') {
      return currentPrice - (atr * atrMultiplier);
    }
    return null;
  }

  /**
   * Salvar log da análise
   */
  async logAnalysis(symbol, decision, analysisData) {
    try {
      await database.query(`
        INSERT INTO ai_logs (type, symbol, message, data, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, NOW())
      `, [
        'analysis',
        symbol,
        `AI Analysis: ${decision.action} with ${(decision.confidence * 100).toFixed(1)}% confidence`,
        JSON.stringify({
          decision,
          analysis: analysisData
        }),
        decision.confidence
      ]);
    } catch (error) {
      logger.error('Erro ao salvar log da análise', { error: error.message });
    }
  }

  /**
   * Gerar dados simulados para teste
   */
  generateSimulatedData(symbol, limit) {
    const data = [];
    const basePrice = 1.0850; // EUR/USD base
    let currentPrice = basePrice;

    for (let i = 0; i < limit; i++) {
      const timestamp = new Date(Date.now() - (limit - i) * 5 * 60 * 1000);
      
      const variation = (Math.random() - 0.5) * 0.002;
      const open = currentPrice;
      const close = open + variation;
      const high = Math.max(open, close) + Math.random() * 0.001;
      const low = Math.min(open, close) - Math.random() * 0.001;

      data.push({
        timestamp,
        open: parseFloat(open.toFixed(5)),
        high: parseFloat(high.toFixed(5)),
        low: parseFloat(low.toFixed(5)),
        close: parseFloat(close.toFixed(5)),
        volume: Math.floor(Math.random() * 1000000)
      });

      currentPrice = close;
    }

    return data;
  }

  /**
   * Encontrar máximos locais
   */
  findLocalMaxima(data, window = 5) {
    const maxima = [];
    for (let i = window; i < data.length - window; i++) {
      const isMaxima = data.slice(i - window, i + window + 1)
        .every(value => value <= data[i]);
      
      if (isMaxima) {
        maxima.push(data[i]);
      }
    }
    return maxima;
  }

  /**
   * Encontrar mínimos locais
   */
  findLocalMinima(data, window = 5) {
    const minima = [];
    for (let i = window; i < data.length - window; i++) {
      const isMinima = data.slice(i - window, i + window + 1)
        .every(value => value >= data[i]);
      
      if (isMinima) {
        minima.push(data[i]);
      }
    }
    return minima;
  }
}

/**
 * Classe para cálculo de indicadores técnicos
 */
class TechnicalIndicators {
  
  /**
   * Simple Moving Average
   */
  SMA(data, period) {
    const sma = [];
    for (let i = period - 1; i < data.length; i++) {
      const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      sma.push(sum / period);
    }
    return sma;
  }

  /**
   * Exponential Moving Average
   */
  EMA(data, period) {
    const ema = [];
    const multiplier = 2 / (period + 1);
    
    // Primeira EMA é a SMA
    ema[0] = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    for (let i = 1; i < data.length - period + 1; i++) {
      ema[i] = (data[i + period - 1] - ema[i - 1]) * multiplier + ema[i - 1];
    }
    
    return ema;
  }

  /**
   * MACD (Moving Average Convergence Divergence)
   */
  MACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const fastEMA = this.EMA(data, fastPeriod);
    const slowEMA = this.EMA(data, slowPeriod);
    
    // Ajustar arrays para mesmo tamanho
    const sizeDiff = slowEMA.length - fastEMA.length;
    const alignedFastEMA = fastEMA.slice(sizeDiff);
    
    const macdLine = alignedFastEMA.map((fast, i) => fast - slowEMA[i]);
    const signalLine = this.EMA(macdLine, signalPeriod);
    
    // Ajustar MACD line para mesmo tamanho da signal line
    const macdAligned = macdLine.slice(macdLine.length - signalLine.length);
    const histogram = macdAligned.map((macd, i) => macd - signalLine[i]);
    
    return {
      macd: macdAligned,
      signal: signalLine,
      histogram
    };
  }

  /**
   * RSI (Relative Strength Index)
   */
  RSI(data, period = 14) {
    const gains = [];
    const losses = [];
    
    for (let i = 1; i < data.length; i++) {
      const difference = data[i] - data[i - 1];
      gains.push(difference > 0 ? difference : 0);
      losses.push(difference < 0 ? Math.abs(difference) : 0);
    }
    
    const rsi = [];
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    for (let i = period; i < gains.length; i++) {
      const rs = avgGain / avgLoss;
      rsi.push(100 - (100 / (1 + rs)));
      
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    
    return rsi;
  }

  /**
   * Bollinger Bands
   */
  BollingerBands(data, period = 20, stdDev = 2) {
    const sma = this.SMA(data, period);
    const bands = {
      upper: [],
      middle: sma,
      lower: []
    };
    
    for (let i = 0; i < sma.length; i++) {
      const dataSlice = data.slice(i, i + period);
      const mean = sma[i];
      const variance = dataSlice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
      const standardDeviation = Math.sqrt(variance);
      
      bands.upper.push(mean + (standardDeviation * stdDev));
      bands.lower.push(mean - (standardDeviation * stdDev));
    }
    
    return bands;
  }

  /**
   * Stochastic Oscillator
   */
  Stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
    const k = [];
    
    for (let i = kPeriod - 1; i < closes.length; i++) {
      const highestHigh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
      const lowestLow = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
      const currentClose = closes[i];
      
      k.push(((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100);
    }
    
    const d = this.SMA(k, dPeriod);
    
    return { k, d };
  }

  /**
   * ATR (Average True Range)
   */
  ATR(highs, lows, closes, period = 14) {
    const trueRanges = [];
    
    for (let i = 1; i < closes.length; i++) {
      const tr1 = highs[i] - lows[i];
      const tr2 = Math.abs(highs[i] - closes[i - 1]);
      const tr3 = Math.abs(lows[i] - closes[i - 1]);
      trueRanges.push(Math.max(tr1, tr2, tr3));
    }
    
    return this.SMA(trueRanges, period);
  }

  /**
   * Williams %R
   */
  WilliamsR(highs, lows, closes, period = 14) {
    const williamsR = [];
    
    for (let i = period - 1; i < closes.length; i++) {
      const highestHigh = Math.max(...highs.slice(i - period + 1, i + 1));
      const lowestLow = Math.min(...lows.slice(i - period + 1, i + 1));
      const currentClose = closes[i];
      
      williamsR.push(((highestHigh - currentClose) / (highestHigh - lowestLow)) * -100);
    }
    
    return williamsR;
  }
}

module.exports = { ForexAI, TechnicalIndicators };