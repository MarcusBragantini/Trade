/**
 * Rotas de Trading
 * Operações de compra/venda, histórico, posições
 */

const express = require('express');
const Joi = require('joi');
const database = require('../config/database');
const logger = require('../utils/logger');
const { authenticateToken, checkFeatureAccess, checkLimits } = require('../middleware/auth');
const { trading } = require('../middleware/rateLimiting');

const router = express.Router();

// Schemas de validação
const createTradeSchema = Joi.object({
  symbol: Joi.string().required(),
  type: Joi.string().valid('buy', 'sell').required(),
  amount: Joi.number().min(0.01).max(10000).required(),
  stop_loss: Joi.number().min(0).optional(),
  take_profit: Joi.number().min(0).optional(),
  is_demo: Joi.boolean().default(false)
});

const closeTradeSchema = Joi.object({
  trade_id: Joi.string().required(),
  exit_price: Joi.number().min(0).required()
});

/**
 * POST /api/v1/trading/create-trade
 * Criar nova operação de trading
 */
router.post('/create-trade', [
  authenticateToken,
  trading,
  checkLimits('daily_trades'),
  checkFeatureAccess('real_trading')
], async (req, res) => {
  try {
    const { error, value } = createTradeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Dados inválidos',
        details: error.details[0].message
      });
    }

    const userId = req.user.id;
    const { symbol, type, amount, stop_loss, take_profit, is_demo } = value;

    // Verificar se usuário tem saldo suficiente
    const balance = is_demo ? req.user.demo_balance : req.user.balance;
    if (balance < amount) {
      return res.status(400).json({
        status: 'error',
        message: `Saldo insuficiente. Saldo atual: ${balance}`
      });
    }

    // Buscar configurações do usuário
    const settings = await database.query(
      'SELECT broker, trading_active FROM trading_settings WHERE user_id = ?',
      [userId]
    );

    if (settings.length === 0 || !settings[0].trading_active) {
      return res.status(400).json({
        status: 'error',
        message: 'Trading não está ativo para este usuário'
      });
    }

    // Simular preço atual (em produção, viria da API da corretora)
    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) {
      return res.status(400).json({
        status: 'error',
        message: 'Não foi possível obter o preço atual do símbolo'
      });
    }

    // Gerar ID único para o trade
    const tradeId = generateTradeId();

    // Inserir trade no banco
    const result = await database.query(`
      INSERT INTO trades (
        user_id, trade_id, symbol, type, entry_price, amount, 
        stop_loss, take_profit, broker, is_demo, status, opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW())
    `, [
      userId, tradeId, symbol, type, currentPrice, amount,
      stop_loss, take_profit, settings[0].broker, is_demo
    ]);

    // Atualizar saldo do usuário
    if (!is_demo) {
      await database.query(
        'UPDATE users SET balance = balance - ? WHERE id = ?',
        [amount, userId]
      );
    } else {
      await database.query(
        'UPDATE users SET demo_balance = demo_balance - ? WHERE id = ?',
        [amount, userId]
      );
    }

    // Emitir evento via Socket.IO
    if (global.io) {
      global.io.to(`user_${userId}`).emit('trade_opened', {
        trade_id: tradeId,
        symbol,
        type,
        amount,
        entry_price: currentPrice,
        is_demo
      });
    }

    logger.trading('Novo trade criado', {
      userId,
      tradeId,
      symbol,
      type,
      amount,
      entry_price: currentPrice,
      is_demo
    });

    res.status(201).json({
      status: 'success',
      message: 'Trade criado com sucesso',
      data: {
        trade_id: tradeId,
        symbol,
        type,
        entry_price: currentPrice,
        amount,
        stop_loss,
        take_profit,
        status: 'active',
        is_demo
      }
    });

  } catch (error) {
    logger.error('Erro ao criar trade', {
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
 * POST /api/v1/trading/close-trade
 * Fechar operação de trading
 */
router.post('/close-trade',
  authenticateToken,
  trading,
  async (req, res) => {
    try {
      const { error, value } = closeTradeSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          status: 'error',
          message: 'Dados inválidos',
          details: error.details[0].message
        });
      }

      const userId = req.user.id;
      const { trade_id, exit_price } = value;

      // Buscar trade
      const trades = await database.query(`
        SELECT id, symbol, type, entry_price, amount, is_demo, status
        FROM trades 
        WHERE trade_id = ? AND user_id = ? AND status = 'active'
      `, [trade_id, userId]);

      if (trades.length === 0) {
        return res.status(404).json({
          status: 'error',
          message: 'Trade não encontrado ou já fechado'
        });
      }

      const trade = trades[0];

      // Calcular profit/loss
      let profitLoss;
      if (trade.type === 'buy') {
        profitLoss = (exit_price - trade.entry_price) * (trade.amount / trade.entry_price);
      } else {
        profitLoss = (trade.entry_price - exit_price) * (trade.amount / trade.entry_price);
      }

      // Atualizar trade
      await database.query(`
        UPDATE trades 
        SET exit_price = ?, profit_loss = ?, status = 'closed', closed_at = NOW()
        WHERE id = ?
      `, [exit_price, profitLoss, trade.id]);

      // Atualizar saldo do usuário
      const finalAmount = trade.amount + profitLoss;
      if (!trade.is_demo) {
        await database.query(
          'UPDATE users SET balance = balance + ? WHERE id = ?',
          [finalAmount, userId]
        );
      } else {
        await database.query(
          'UPDATE users SET demo_balance = demo_balance + ? WHERE id = ?',
          [finalAmount, userId]
        );
      }

      // Emitir evento via Socket.IO
      if (global.io) {
        global.io.to(`user_${userId}`).emit('trade_closed', {
          trade_id,
          symbol: trade.symbol,
          profit_loss: profitLoss,
          exit_price,
          is_demo: trade.is_demo
        });
      }

      logger.trading('Trade fechado', {
        userId,
        trade_id,
        symbol: trade.symbol,
        profit_loss: profitLoss,
        exit_price
      });

      res.json({
        status: 'success',
        message: 'Trade fechado com sucesso',
        data: {
          trade_id,
          symbol: trade.symbol,
          entry_price: trade.entry_price,
          exit_price,
          profit_loss: profitLoss,
          final_amount: finalAmount
        }
      });

    } catch (error) {
      logger.error('Erro ao fechar trade', {
        error: error.message,
        userId: req.user?.id,
        body: req.body
      });

      res.status(500).json({
        status: 'error',
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * GET /api/v1/trading/active-positions
 * Obter posições ativas
 */
router.get('/active-positions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const positions = await database.query(`
      SELECT trade_id, symbol, type, entry_price, amount, stop_loss, 
             take_profit, is_demo, opened_at, broker
      FROM trades 
      WHERE user_id = ? AND status = 'active'
      ORDER BY opened_at DESC
    `, [userId]);

    // Para cada posição, calcular P&L atual
    const positionsWithPnL = await Promise.all(
      positions.map(async (position) => {
        const currentPrice = await getCurrentPrice(position.symbol);
        let currentPnL = 0;

        if (currentPrice) {
          if (position.type === 'buy') {
            currentPnL = (currentPrice - position.entry_price) * (position.amount / position.entry_price);
          } else {
            currentPnL = (position.entry_price - currentPrice) * (position.amount / position.entry_price);
          }
        }

        return {
          ...position,
          current_price: currentPrice,
          current_pnl: currentPnL,
          amount: parseFloat(position.amount),
          entry_price: parseFloat(position.entry_price),
          stop_loss: parseFloat(position.stop_loss || 0),
          take_profit: parseFloat(position.take_profit || 0)
        };
      })
    );

    res.json({
      status: 'success',
      data: {
        positions: positionsWithPnL,
        total_positions: positionsWithPnL.length,
        total_pnl: positionsWithPnL.reduce((sum, pos) => sum + pos.current_pnl, 0)
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar posições ativas', {
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
 * GET /api/v1/trading/history
 * Histórico de trades
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { 
      page = 1, 
      limit = 20, 
      symbol, 
      status = 'closed',
      is_demo 
    } = req.query;

    const offset = (page - 1) * limit;

    // Construir filtros
    let filters = ['user_id = ?'];
    let filterValues = [userId];

    if (symbol) {
      filters.push('symbol = ?');
      filterValues.push(symbol);
    }

    if (status) {
      filters.push('status = ?');
      filterValues.push(status);
    }

    if (is_demo !== undefined) {
      filters.push('is_demo = ?');
      filterValues.push(is_demo === 'true');
    }

    const whereClause = filters.join(' AND ');

    // Buscar trades
    const trades = await database.query(`
      SELECT trade_id, symbol, type, entry_price, exit_price, amount,
             profit_loss, status, stop_loss, take_profit, is_demo,
             broker, opened_at, closed_at
      FROM trades 
      WHERE ${whereClause}
      ORDER BY opened_at DESC
      LIMIT ? OFFSET ?
    `, [...filterValues, parseInt(limit), offset]);

    // Contar total
    const countResult = await database.query(`
      SELECT COUNT(*) as total FROM trades WHERE ${whereClause}
    `, filterValues);

    const total = countResult[0].total;

    res.json({
      status: 'success',
      data: {
        trades: trades.map(trade => ({
          ...trade,
          amount: parseFloat(trade.amount),
          entry_price: parseFloat(trade.entry_price),
          exit_price: parseFloat(trade.exit_price || 0),
          profit_loss: parseFloat(trade.profit_loss || 0),
          stop_loss: parseFloat(trade.stop_loss || 0),
          take_profit: parseFloat(trade.take_profit || 0)
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
    logger.error('Erro ao buscar histórico de trades', {
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
 * GET /api/v1/trading/market-data/:symbol
 * Obter dados de mercado para um símbolo
 */
router.get('/market-data/:symbol', authenticateToken, async (req, res) => {
  try {
    const { symbol } = req.params;
    const { timeframe = '5m', limit = 100 } = req.query;

    // Buscar dados de mercado
    const marketData = await database.query(`
      SELECT timestamp, open_price, high_price, low_price, close_price, volume
      FROM market_data 
      WHERE symbol = ? AND timeframe = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `, [symbol.toUpperCase(), timeframe, parseInt(limit)]);

    // Se não tiver dados, gerar dados simulados
    let candleData = marketData;
    if (candleData.length === 0) {
      candleData = generateSimulatedData(symbol, timeframe, limit);
    }

    // Obter preço atual
    const currentPrice = await getCurrentPrice(symbol);

    res.json({
      status: 'success',
      data: {
        symbol: symbol.toUpperCase(),
        timeframe,
        current_price: currentPrice,
        candles: candleData.map(candle => ({
          timestamp: candle.timestamp,
          open: parseFloat(candle.open_price),
          high: parseFloat(candle.high_price),
          low: parseFloat(candle.low_price),
          close: parseFloat(candle.close_price),
          volume: parseInt(candle.volume || 0)
        }))
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar dados de mercado', {
      error: error.message,
      symbol: req.params.symbol
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * GET /api/v1/trading/symbols
 * Listar símbolos disponíveis
 */
router.get('/symbols', authenticateToken, async (req, res) => {
  try {
    const symbols = [
      { symbol: 'EURUSD', name: 'Euro/US Dollar', type: 'forex', active: true },
      { symbol: 'GBPUSD', name: 'British Pound/US Dollar', type: 'forex', active: true },
      { symbol: 'USDJPY', name: 'US Dollar/Japanese Yen', type: 'forex', active: true },
      { symbol: 'AUDUSD', name: 'Australian Dollar/US Dollar', type: 'forex', active: true },
      { symbol: 'USDCAD', name: 'US Dollar/Canadian Dollar', type: 'forex', active: true },
      { symbol: 'EURGBP', name: 'Euro/British Pound', type: 'forex', active: true },
      { symbol: 'EURJPY', name: 'Euro/Japanese Yen', type: 'forex', active: true },
      { symbol: 'GBPJPY', name: 'British Pound/Japanese Yen', type: 'forex', active: true }
    ];

    // Para cada símbolo, obter preço atual
    const symbolsWithPrices = await Promise.all(
      symbols.map(async (symbol) => {
        const currentPrice = await getCurrentPrice(symbol.symbol);
        return {
          ...symbol,
          current_price: currentPrice,
          change_24h: (Math.random() - 0.5) * 2 // Simulado
        };
      })
    );

    res.json({
      status: 'success',
      data: {
        symbols: symbolsWithPrices
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar símbolos', {
      error: error.message
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

// Funções auxiliares

function generateTradeId() {
  return `TRD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function getCurrentPrice(symbol) {
  // Simulação de preços (em produção, isso viria da API da corretora)
  const basePrices = {
    'EURUSD': 1.0850,
    'GBPUSD': 1.2735,
    'USDJPY': 148.25,
    'AUDUSD': 0.6680,
    'USDCAD': 1.3425,
    'EURGBP': 0.8520,
    'EURJPY': 160.85,
    'GBPJPY': 188.90
  };

  const basePrice = basePrices[symbol.toUpperCase()];
  if (!basePrice) return null;

  // Adicionar variação aleatória
  const variation = (Math.random() - 0.5) * 0.002;
  return parseFloat((basePrice + variation).toFixed(5));
}

function generateSimulatedData(symbol, timeframe, limit) {
  const data = [];
  const basePrice = 1.0850; // EUR/USD base
  let currentPrice = basePrice;

  for (let i = limit - 1; i >= 0; i--) {
    const timestamp = new Date(Date.now() - i * 5 * 60 * 1000); // 5 min intervals
    
    const open = currentPrice;
    const variation = (Math.random() - 0.5) * 0.002;
    const close = open + variation;
    const high = Math.max(open, close) + Math.random() * 0.001;
    const low = Math.min(open, close) - Math.random() * 0.001;

    data.push({
      timestamp,
      open_price: open,
      high_price: high,
      low_price: low,
      close_price: close,
      volume: Math.floor(Math.random() * 1000000)
    });

    currentPrice = close;
  }

  return data;
}

module.exports = router;