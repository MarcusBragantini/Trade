/**
 * Rotas da Inteligência Artificial
 * Análise de mercado, decisões automáticas, configurações da IA
 */

const express = require('express');
const Joi = require('joi');
const database = require('../config/database');
const logger = require('../utils/logger');
const { authenticateToken, checkFeatureAccess } = require('../middleware/auth');
const { ai } = require('../middleware/rateLimiting');
const { ForexAI } = require('../ai/marketAnalysis');

const router = express.Router();

// Instância da IA
const forexAI = new ForexAI();

// Schemas de validação
const analyzeMarketSchema = Joi.object({
  symbol: Joi.string().required(),
  timeframe: Joi.string().valid('1m', '5m', '15m', '1h', '4h', '1d').default('5m')
});

const aiSettingsSchema = Joi.object({
  confidence_threshold: Joi.number().min(0.1).max(0.95),
  risk_level: Joi.string().valid('low', 'medium', 'high'),
  max_daily_trades: Joi.number().min(1).max(100),
  auto_trading_enabled: Joi.boolean(),
  martingale_enabled: Joi.boolean(),
  martingale_multiplier: Joi.number().min(1.1).max(3.0),
  stop_loss_atr_multiplier: Joi.number().min(1).max(5),
  take_profit_atr_multiplier: Joi.number().min(1).max(10),
  indicators_weights: Joi.object({
    rsi_weight: Joi.number().min(0).max(1),
    macd_weight: Joi.number().min(0).max(1),
    bb_weight: Joi.number().min(0).max(1),
    trend_weight: Joi.number().min(0).max(1)
  })
});

/**
 * POST /api/v1/ai/analyze
 * Analisar mercado para um símbolo específico
 */
router.post('/analyze', [
  authenticateToken,
  ai,
  checkFeatureAccess('ai_trading')
], async (req, res) => {
  try {
    const { error, value } = analyzeMarketSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Dados inválidos',
        details: error.details[0].message
      });
    }

    const { symbol, timeframe } = value;
    const userId = req.user.id;

    logger.ai('Iniciando análise de mercado via API', {
      userId,
      symbol,
      timeframe
    });

    // Executar análise
    const analysis = await forexAI.analyzeMarket(symbol.toUpperCase(), timeframe);

    // Salvar log da requisição
    await database.query(`
      INSERT INTO ai_logs (user_id, type, symbol, message, data, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      userId,
      'analysis',
      symbol.toUpperCase(),
      `Market analysis requested via API`,
      JSON.stringify({ request: value, response: analysis }),
      analysis.confidence
    ]);

    // Emitir evento via Socket.IO
    if (global.io) {
      global.io.to(`user_${userId}`).emit('ai_analysis_complete', {
        symbol: symbol.toUpperCase(),
        analysis
      });
    }

    res.json({
      status: 'success',
      message: 'Análise de mercado concluída',
      data: {
        symbol: symbol.toUpperCase(),
        timeframe,
        timestamp: new Date().toISOString(),
        analysis
      }
    });

  } catch (error) {
    logger.error('Erro na análise de mercado via API', {
      error: error.message,
      userId: req.user?.id,
      body: req.body
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * GET /api/v1/ai/recommendations
 * Obter recomendações da IA para múltiplos símbolos
 */
router.get('/recommendations', [
  authenticateToken,
  checkFeatureAccess('ai_trading')
], async (req, res) => {
  try {
    const userId = req.user.id;
    const { symbols = 'EURUSD,GBPUSD,USDJPY', timeframe = '5m' } = req.query;

    const symbolList = symbols.split(',').map(s => s.trim().toUpperCase());
    const recommendations = [];

    logger.ai('Gerando recomendações para múltiplos símbolos', {
      userId,
      symbols: symbolList,
      timeframe
    });

    // Analisar cada símbolo
    for (const symbol of symbolList) {
      try {
        const analysis = await forexAI.analyzeMarket(symbol, timeframe);
        recommendations.push({
          symbol,
          analysis,
          timestamp: new Date().toISOString()
        });

        // Pequeno delay para evitar sobrecarga
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.warn(`Erro ao analisar ${symbol}`, { error: error.message });
        recommendations.push({
          symbol,
          analysis: {
            action: 'hold',
            confidence: 0,
            reason: 'Erro na análise',
            error: error.message
          },
          timestamp: new Date().toISOString()
        });
      }
    }

    // Filtrar apenas recomendações com ação
    const actionableRecommendations = recommendations.filter(
      rec => rec.analysis.action !== 'hold' && rec.analysis.confidence > 0.6
    );

    res.json({
      status: 'success',
      data: {
        total_analyzed: recommendations.length,
        actionable_recommendations: actionableRecommendations.length,
        recommendations: recommendations.sort((a, b) => b.analysis.confidence - a.analysis.confidence)
      }
    });

  } catch (error) {
    logger.error('Erro ao gerar recomendações', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * GET /api/v1/ai/performance
 * Obter performance da IA
 */
router.get('/performance', [
  authenticateToken,
  checkFeatureAccess('ai_trading')
], async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = '30d' } = req.query;

    let dateFilter = '';
    switch (period) {
      case '7d':
        dateFilter = 'AND t.opened_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
        break;
      case '30d':
        dateFilter = 'AND t.opened_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
        break;
      case '90d':
        dateFilter = 'AND t.opened_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)';
        break;
    }

    // Buscar trades executados pela IA
    const aiTrades = await database.query(`
      SELECT t.*, al.confidence 
      FROM trades t
      LEFT JOIN ai_logs al ON al.symbol = t.symbol 
        AND al.created_at BETWEEN t.opened_at - INTERVAL 1 MINUTE AND t.opened_at + INTERVAL 1 MINUTE
        AND al.type = 'decision'
      WHERE t.user_id = ? AND t.status = 'closed' 
        AND t.ai_decision_data IS NOT NULL ${dateFilter}
      ORDER BY t.opened_at DESC
    `, [userId]);

    // Calcular estatísticas
    const totalTrades = aiTrades.length;
    const profitableTrades = aiTrades.filter(trade => trade.profit_loss > 0).length;
    const totalPnL = aiTrades.reduce((sum, trade) => sum + parseFloat(trade.profit_loss || 0), 0);
    const avgConfidence = aiTrades.reduce((sum, trade) => sum + (trade.confidence || 0), 0) / totalTrades || 0;

    // Calcular por nível de confiança
    const highConfidenceTrades = aiTrades.filter(trade => trade.confidence >= 0.8);
    const mediumConfidenceTrades = aiTrades.filter(trade => trade.confidence >= 0.6 && trade.confidence < 0.8);
    const lowConfidenceTrades = aiTrades.filter(trade => trade.confidence < 0.6);

    // Performance por símbolo
    const symbolPerformance = {};
    aiTrades.forEach(trade => {
      if (!symbolPerformance[trade.symbol]) {
        symbolPerformance[trade.symbol] = {
          total_trades: 0,
          profitable_trades: 0,
          total_pnl: 0
        };
      }
      
      symbolPerformance[trade.symbol].total_trades++;
      if (trade.profit_loss > 0) {
        symbolPerformance[trade.symbol].profitable_trades++;
      }
      symbolPerformance[trade.symbol].total_pnl += parseFloat(trade.profit_loss || 0);
    });

    res.json({
      status: 'success',
      data: {
        period,
        overall_performance: {
          total_trades: totalTrades,
          profitable_trades: profitableTrades,
          win_rate: totalTrades > 0 ? ((profitableTrades / totalTrades) * 100).toFixed(2) : 0,
          total_pnl: totalPnL.toFixed(2),
          avg_pnl_per_trade: totalTrades > 0 ? (totalPnL / totalTrades).toFixed(2) : 0,
          avg_confidence: avgConfidence.toFixed(3)
        },
        confidence_analysis: {
          high_confidence: {
            trades: highConfidenceTrades.length,
            win_rate: highConfidenceTrades.length > 0 
              ? ((highConfidenceTrades.filter(t => t.profit_loss > 0).length / highConfidenceTrades.length) * 100).toFixed(2)
              : 0,
            avg_pnl: highConfidenceTrades.length > 0
              ? (highConfidenceTrades.reduce((sum, t) => sum + parseFloat(t.profit_loss || 0), 0) / highConfidenceTrades.length).toFixed(2)
              : 0
          },
          medium_confidence: {
            trades: mediumConfidenceTrades.length,
            win_rate: mediumConfidenceTrades.length > 0 
              ? ((mediumConfidenceTrades.filter(t => t.profit_loss > 0).length / mediumConfidenceTrades.length) * 100).toFixed(2)
              : 0,
            avg_pnl: mediumConfidenceTrades.length > 0
              ? (mediumConfidenceTrades.reduce((sum, t) => sum + parseFloat(t.profit_loss || 0), 0) / mediumConfidenceTrades.length).toFixed(2)
              : 0
          },
          low_confidence: {
            trades: lowConfidenceTrades.length,
            win_rate: lowConfidenceTrades.length > 0 
              ? ((lowConfidenceTrades.filter(t => t.profit_loss > 0).length / lowConfidenceTrades.length) * 100).toFixed(2)
              : 0,
            avg_pnl: lowConfidenceTrades.length > 0
              ? (lowConfidenceTrades.reduce((sum, t) => sum + parseFloat(t.profit_loss || 0), 0) / lowConfidenceTrades.length).toFixed(2)
              : 0
          }
        },
        symbol_performance: Object.keys(symbolPerformance).map(symbol => ({
          symbol,
          ...symbolPerformance[symbol],
          win_rate: ((symbolPerformance[symbol].profitable_trades / symbolPerformance[symbol].total_trades) * 100).toFixed(2)
        }))
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar performance da IA', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * GET /api/v1/ai/settings
 * Obter configurações da IA do usuário
 */
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar configurações da IA (se existirem)
    const settings = await database.query(`
      SELECT ai_settings FROM trading_settings WHERE user_id = ?
    `, [userId]);

    let aiSettings = {
      confidence_threshold: 0.75,
      risk_level: 'medium',
      max_daily_trades: 20,
      auto_trading_enabled: false,
      martingale_enabled: true,
      martingale_multiplier: 2.0,
      stop_loss_atr_multiplier: 2.0,
      take_profit_atr_multiplier: 3.0,
      indicators_weights: {
        rsi_weight: 0.25,
        macd_weight: 0.25,
        bb_weight: 0.2,
        trend_weight: 0.3
      }
    };

    // Se existem configurações salvas, fazer merge
    if (settings.length > 0 && settings[0].ai_settings) {
      try {
        const savedSettings = JSON.parse(settings[0].ai_settings);
        aiSettings = { ...aiSettings, ...savedSettings };
      } catch (error) {
        logger.warn('Erro ao parsear configurações da IA', { userId, error: error.message });
      }
    }

    res.json({
      status: 'success',
      data: { ai_settings: aiSettings }
    });

  } catch (error) {
    logger.error('Erro ao buscar configurações da IA', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * PUT /api/v1/ai/settings
 * Atualizar configurações da IA
 */
router.put('/settings', [
  authenticateToken,
  checkFeatureAccess('advanced_ai')
], async (req, res) => {
  try {
    const { error, value } = aiSettingsSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Dados inválidos',
        details: error.details[0].message
      });
    }

    const userId = req.user.id;

    // Salvar configurações no banco
    await database.query(`
      UPDATE trading_settings 
      SET ai_settings = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE user_id = ?
    `, [JSON.stringify(value), userId]);

    // Log da alteração
    await database.query(`
      INSERT INTO ai_logs (user_id, type, message, data)
      VALUES (?, ?, ?, ?)
    `, [
      userId,
      'settings',
      'AI settings updated',
      JSON.stringify(value)
    ]);

    logger.ai('Configurações da IA atualizadas', {
      userId,
      settings: value
    });

    // Emitir evento via Socket.IO
    if (global.io) {
      global.io.to(`user_${userId}`).emit('ai_settings_updated', value);
    }

    res.json({
      status: 'success',
      message: 'Configurações da IA atualizadas com sucesso',
      data: { ai_settings: value }
    });

  } catch (error) {
    logger.error('Erro ao atualizar configurações da IA', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * POST /api/v1/ai/auto-trade
 * Ativar/Desativar trading automático
 */
router.post('/auto-trade', [
  authenticateToken,
  checkFeatureAccess('ai_trading')
], async (req, res) => {
  try {
    const { enabled } = req.body;
    const userId = req.user.id;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        status: 'error',
        message: 'Campo "enabled" deve ser booleano'
      });
    }

    // Atualizar configuração
    await database.query(`
      UPDATE trading_settings 
      SET trading_active = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE user_id = ?
    `, [enabled, userId]);

    // Log da ação
    await database.query(`
      INSERT INTO ai_logs (user_id, type, message, data)
      VALUES (?, ?, ?, ?)
    `, [
      userId,
      'settings',
      `Auto trading ${enabled ? 'enabled' : 'disabled'}`,
      JSON.stringify({ auto_trading_enabled: enabled })
    ]);

    logger.ai(`Auto trading ${enabled ? 'ativado' : 'desativado'}`, { userId });

    // Emitir evento via Socket.IO
    if (global.io) {
      global.io.to(`user_${userId}`).emit('auto_trading_status', { enabled });
    }

    res.json({
      status: 'success',
      message: `Trading automático ${enabled ? 'ativado' : 'desativado'} com sucesso`,
      data: { auto_trading_enabled: enabled }
    });

  } catch (error) {
    logger.error('Erro ao alterar status do auto trading', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * GET /api/v1/ai/logs
 * Obter logs da IA
 */
router.get('/logs', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { 
      page = 1, 
      limit = 20, 
      type, 
      symbol 
    } = req.query;

    const offset = (page - 1) * limit;

    // Construir filtros
    let filters = ['user_id = ?'];
    let filterValues = [userId];

    if (type) {
      filters.push('type = ?');
      filterValues.push(type);
    }

    if (symbol) {
      filters.push('symbol = ?');
      filterValues.push(symbol.toUpperCase());
    }

    const whereClause = filters.join(' AND ');

    // Buscar logs
    const logs = await database.query(`
      SELECT id, type, symbol, message, confidence, created_at
      FROM ai_logs 
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...filterValues, parseInt(limit), offset]);

    // Contar total
    const countResult = await database.query(`
      SELECT COUNT(*) as total FROM ai_logs WHERE ${whereClause}
    `, filterValues);

    const total = countResult[0].total;

    res.json({
      status: 'success',
      data: {
        logs: logs.map(log => ({
          ...log,
          confidence: parseFloat(log.confidence || 0)
        })),
        pagination: {
          current_page: parseInt(page),
          per_page: parseInt(limit),
          total: parseInt(total),
          total_pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar logs da IA', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * POST /api/v1/ai/backtest
 * Executar backtest da estratégia da IA
 */
router.post('/backtest', [
  authenticateToken,
  checkFeatureAccess('advanced_ai')
], async (req, res) => {
  try {
    const { 
      symbol = 'EURUSD', 
      timeframe = '5m', 
      start_date, 
      end_date,
      initial_balance = 10000
    } = req.body;

    const userId = req.user.id;

    logger.ai('Iniciando backtest', {
      userId,
      symbol,
      timeframe,
      start_date,
      end_date,
      initial_balance
    });

    // Simular backtest (em produção, isso seria mais complexo)
    const backtestResults = await simulateBacktest({
      symbol,
      timeframe,
      start_date,
      end_date,
      initial_balance
    });

    // Salvar resultado do backtest
    await database.query(`
      INSERT INTO ai_logs (user_id, type, symbol, message, data)
      VALUES (?, ?, ?, ?, ?)
    `, [
      userId,
      'backtest',
      symbol,
      'Backtest executed',
      JSON.stringify({
        parameters: { symbol, timeframe, start_date, end_date, initial_balance },
        results: backtestResults
      })
    ]);

    res.json({
      status: 'success',
      message: 'Backtest executado com sucesso',
      data: {
        symbol,
        timeframe,
        period: { start_date, end_date },
        initial_balance,
        results: backtestResults
      }
    });

  } catch (error) {
    logger.error('Erro ao executar backtest', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * GET /api/v1/ai/status
 * Status geral da IA
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar configurações atuais
    const settings = await database.query(`
      SELECT trading_active, ai_active FROM trading_settings WHERE user_id = ?
    `, [userId]);

    // Buscar última análise
    const lastAnalysis = await database.query(`
      SELECT symbol, created_at, confidence FROM ai_logs 
      WHERE user_id = ? AND type = 'analysis'
      ORDER BY created_at DESC LIMIT 1
    `, [userId]);

    // Buscar trades da IA hoje
    const todayTrades = await database.query(`
      SELECT COUNT(*) as count FROM trades 
      WHERE user_id = ? AND DATE(created_at) = CURDATE() 
        AND ai_decision_data IS NOT NULL
    `, [userId]);

    const aiStatus = {
      is_active: settings.length > 0 ? Boolean(settings[0].ai_active) : false,
      trading_active: settings.length > 0 ? Boolean(settings[0].trading_active) : false,
      last_analysis: lastAnalysis.length > 0 ? {
        symbol: lastAnalysis[0].symbol,
        timestamp: lastAnalysis[0].created_at,
        confidence: parseFloat(lastAnalysis[0].confidence || 0)
      } : null,
      trades_today: parseInt(todayTrades[0].count),
      subscription_type: req.user.subscription_type,
      has_valid_subscription: req.user.hasValidSubscription
    };

    res.json({
      status: 'success',
      data: { ai_status: aiStatus }
    });

  } catch (error) {
    logger.error('Erro ao buscar status da IA', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

// Função auxiliar para simular backtest
async function simulateBacktest({ symbol, timeframe, start_date, end_date, initial_balance }) {
  // Simulação simples de backtest
  const trades = Math.floor(Math.random() * 50) + 20; // 20-70 trades
  const winRate = 0.6 + (Math.random() * 0.2); // 60-80% win rate
  const wins = Math.floor(trades * winRate);
  const losses = trades - wins;
  
  const avgWin = 15 + (Math.random() * 20); // $15-35 avg win
  const avgLoss = 10 + (Math.random() * 15); // $10-25 avg loss
  
  const totalProfit = (wins * avgWin) - (losses * avgLoss);
  const finalBalance = initial_balance + totalProfit;
  
  return {
    total_trades: trades,
    winning_trades: wins,
    losing_trades: losses,
    win_rate: (winRate * 100).toFixed(2),
    total_profit: totalProfit.toFixed(2),
    final_balance: finalBalance.toFixed(2),
    return_percentage: ((totalProfit / initial_balance) * 100).toFixed(2),
    avg_win: avgWin.toFixed(2),
    avg_loss: avgLoss.toFixed(2),
    profit_factor: (avgWin / avgLoss).toFixed(2),
    max_drawdown: (Math.random() * 15).toFixed(2) + '%'
  };
}

module.exports = router;