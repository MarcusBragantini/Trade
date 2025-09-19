/**
 * Rotas de Usuário
 * Profile, Configurações, Estatísticas
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const Joi = require('joi');
const database = require('../config/database');
const logger = require('../utils/logger');
const { authenticateToken, requireSubscription } = require('../middleware/auth');

const router = express.Router();

// Schemas de validação
const updateProfileSchema = Joi.object({
  name: Joi.string().min(2).max(100),
  email: Joi.string().email(),
  current_password: Joi.string().when('new_password', {
    is: Joi.exist(),
    then: Joi.required()
  }),
  new_password: Joi.string().min(6).max(100)
});

const updateTradingSettingsSchema = Joi.object({
  broker: Joi.string().valid('deriv', 'iqoption', 'quotex'),
  entry_amount: Joi.number().min(1).max(10000),
  stop_loss_percent: Joi.number().min(0.1).max(50),
  take_profit_percent: Joi.number().min(0.1).max(100),
  ai_aggressiveness: Joi.string().valid('conservative', 'moderate', 'aggressive'),
  martingale_enabled: Joi.boolean(),
  max_daily_trades: Joi.number().min(1).max(1000),
  trading_active: Joi.boolean(),
  ai_active: Joi.boolean()
});

/**
 * GET /api/v1/users/profile
 * Obter perfil do usuário
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar dados completos do usuário
    const users = await database.query(`
      SELECT u.id, u.name, u.email, u.subscription_type, u.subscription_expires_at,
             u.status, u.balance, u.demo_balance, u.created_at,
             ts.broker, ts.entry_amount, ts.stop_loss_percent, ts.take_profit_percent,
             ts.ai_aggressiveness, ts.martingale_enabled, ts.max_daily_trades,
             ts.trading_active, ts.ai_active
      FROM users u
      LEFT JOIN trading_settings ts ON u.id = ts.user_id
      WHERE u.id = ?
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Usuário não encontrado'
      });
    }

    const user = users[0];

    // Buscar estatísticas de trading
    const stats = await database.query(`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as profitable_trades,
        SUM(CASE WHEN profit_loss < 0 THEN 1 ELSE 0 END) as losing_trades,
        SUM(profit_loss) as total_profit_loss,
        AVG(profit_loss) as avg_profit_loss,
        MAX(profit_loss) as best_trade,
        MIN(profit_loss) as worst_trade
      FROM trades 
      WHERE user_id = ? AND status = 'closed'
    `, [userId]);

    const tradingStats = stats[0];

    // Buscar trades recentes
    const recentTrades = await database.query(`
      SELECT id, trade_id, symbol, type, entry_price, exit_price, 
             amount, profit_loss, status, opened_at, closed_at
      FROM trades 
      WHERE user_id = ? 
      ORDER BY opened_at DESC 
      LIMIT 10
    `, [userId]);

    // Verificar status da assinatura
    const now = new Date();
    const hasValidSubscription = user.subscription_type === 'free' || 
      (user.subscription_expires_at && new Date(user.subscription_expires_at) > now);

    res.json({
      status: 'success',
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          subscription_type: user.subscription_type,
          subscription_expires_at: user.subscription_expires_at,
          status: user.status,
          balance: parseFloat(user.balance),
          demo_balance: parseFloat(user.demo_balance),
          created_at: user.created_at,
          has_valid_subscription: hasValidSubscription
        },
        trading_settings: {
          broker: user.broker,
          entry_amount: parseFloat(user.entry_amount || 25),
          stop_loss_percent: parseFloat(user.stop_loss_percent || 2.5),
          take_profit_percent: parseFloat(user.take_profit_percent || 3.0),
          ai_aggressiveness: user.ai_aggressiveness || 'moderate',
          martingale_enabled: Boolean(user.martingale_enabled),
          max_daily_trades: user.max_daily_trades || 50,
          trading_active: Boolean(user.trading_active),
          ai_active: Boolean(user.ai_active)
        },
        trading_stats: {
          total_trades: parseInt(tradingStats.total_trades || 0),
          profitable_trades: parseInt(tradingStats.profitable_trades || 0),
          losing_trades: parseInt(tradingStats.losing_trades || 0),
          win_rate: tradingStats.total_trades > 0 
            ? ((tradingStats.profitable_trades / tradingStats.total_trades) * 100).toFixed(2)
            : 0,
          total_profit_loss: parseFloat(tradingStats.total_profit_loss || 0),
          avg_profit_loss: parseFloat(tradingStats.avg_profit_loss || 0),
          best_trade: parseFloat(tradingStats.best_trade || 0),
          worst_trade: parseFloat(tradingStats.worst_trade || 0)
        },
        recent_trades: recentTrades.map(trade => ({
          ...trade,
          amount: parseFloat(trade.amount),
          profit_loss: parseFloat(trade.profit_loss || 0),
          entry_price: parseFloat(trade.entry_price),
          exit_price: parseFloat(trade.exit_price || 0)
        }))
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar perfil do usuário', {
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
 * PUT /api/v1/users/profile
 * Atualizar perfil do usuário
 */
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { error, value } = updateProfileSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Dados inválidos',
        details: error.details[0].message
      });
    }

    const userId = req.user.id;
    const { name, email, current_password, new_password } = value;

    // Se está alterando email, verificar se já não existe
    if (email && email !== req.user.email) {
      const existingUser = await database.query(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, userId]
      );

      if (existingUser.length > 0) {
        return res.status(409).json({
          status: 'error',
          message: 'Email já está em uso'
        });
      }
    }

    const updateData = {};
    const updateFields = [];
    const updateValues = [];

    // Atualizar nome
    if (name) {
      updateFields.push('name = ?');
      updateValues.push(name);
    }

    // Atualizar email
    if (email) {
      updateFields.push('email = ?');
      updateValues.push(email);
    }

    // Atualizar senha
    if (new_password && current_password) {
      // Verificar senha atual
      const users = await database.query(
        'SELECT password_hash FROM users WHERE id = ?',
        [userId]
      );

      if (users.length === 0) {
        return res.status(404).json({
          status: 'error',
          message: 'Usuário não encontrado'
        });
      }

      const isCurrentPasswordValid = await bcrypt.compare(
        current_password, 
        users[0].password_hash
      );

      if (!isCurrentPasswordValid) {
        return res.status(400).json({
          status: 'error',
          message: 'Senha atual incorreta'
        });
      }

      // Hash da nova senha
      const newPasswordHash = await bcrypt.hash(new_password, 12);
      updateFields.push('password_hash = ?');
      updateValues.push(newPasswordHash);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Nenhum dado para atualizar'
      });
    }

    // Executar update
    updateValues.push(userId);
    await database.query(
      `UPDATE users SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      updateValues
    );

    logger.info('Perfil atualizado', {
      userId,
      fields: updateFields
    });

    res.json({
      status: 'success',
      message: 'Perfil atualizado com sucesso'
    });

  } catch (error) {
    logger.error('Erro ao atualizar perfil', {
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
 * PUT /api/v1/users/trading-settings
 * Atualizar configurações de trading
 */
router.put('/trading-settings', authenticateToken, async (req, res) => {
  try {
    const { error, value } = updateTradingSettingsSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Dados inválidos',
        details: error.details[0].message
      });
    }

    const userId = req.user.id;
    
    const updateFields = [];
    const updateValues = [];

    // Construir query de update dinamicamente
    Object.keys(value).forEach(key => {
      updateFields.push(`${key} = ?`);
      updateValues.push(value[key]);
    });

    if (updateFields.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Nenhuma configuração para atualizar'
      });
    }

    updateValues.push(userId);

    await database.query(`
      UPDATE trading_settings 
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP 
      WHERE user_id = ?
    `, updateValues);

    // Emitir evento via Socket.IO se configurações mudaram
    if (global.io) {
      global.io.to(`user_${userId}`).emit('trading_settings_updated', value);
    }

    logger.info('Configurações de trading atualizadas', {
      userId,
      settings: value
    });

    res.json({
      status: 'success',
      message: 'Configurações atualizadas com sucesso',
      data: value
    });

  } catch (error) {
    logger.error('Erro ao atualizar configurações de trading', {
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
 * GET /api/v1/users/trading-stats
 * Obter estatísticas detalhadas de trading
 */
router.get('/trading-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = '30d' } = req.query;

    let dateFilter = '';
    switch (period) {
      case '7d':
        dateFilter = 'AND opened_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
        break;
      case '30d':
        dateFilter = 'AND opened_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
        break;
      case '90d':
        dateFilter = 'AND opened_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)';
        break;
      case '1y':
        dateFilter = 'AND opened_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)';
        break;
      default:
        dateFilter = '';
    }

    // Estatísticas gerais
    const generalStats = await database.query(`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as profitable_trades,
        SUM(CASE WHEN profit_loss < 0 THEN 1 ELSE 0 END) as losing_trades,
        SUM(profit_loss) as total_profit_loss,
        AVG(profit_loss) as avg_profit_loss,
        MAX(profit_loss) as best_trade,
        MIN(profit_loss) as worst_trade,
        AVG(CASE WHEN profit_loss > 0 THEN profit_loss ELSE NULL END) as avg_win,
        AVG(CASE WHEN profit_loss < 0 THEN ABS(profit_loss) ELSE NULL END) as avg_loss
      FROM trades 
      WHERE user_id = ? AND status = 'closed' ${dateFilter}
    `, [userId]);

    // Estatísticas por símbolo
    const symbolStats = await database.query(`
      SELECT 
        symbol,
        COUNT(*) as trades_count,
        SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as wins,
        SUM(profit_loss) as total_pnl
      FROM trades 
      WHERE user_id = ? AND status = 'closed' ${dateFilter}
      GROUP BY symbol
      ORDER BY trades_count DESC
      LIMIT 10
    `, [userId]);

    // Estatísticas por dia (últimos 30 dias)
    const dailyStats = await database.query(`
      SELECT 
        DATE(opened_at) as date,
        COUNT(*) as trades_count,
        SUM(profit_loss) as daily_pnl
      FROM trades 
      WHERE user_id = ? AND status = 'closed' 
        AND opened_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(opened_at)
      ORDER BY date DESC
    `, [userId]);

    const stats = generalStats[0];

    res.json({
      status: 'success',
      data: {
        period,
        general: {
          total_trades: parseInt(stats.total_trades || 0),
          profitable_trades: parseInt(stats.profitable_trades || 0),
          losing_trades: parseInt(stats.losing_trades || 0),
          win_rate: stats.total_trades > 0 
            ? ((stats.profitable_trades / stats.total_trades) * 100).toFixed(2)
            : 0,
          total_profit_loss: parseFloat(stats.total_profit_loss || 0),
          avg_profit_loss: parseFloat(stats.avg_profit_loss || 0),
          best_trade: parseFloat(stats.best_trade || 0),
          worst_trade: parseFloat(stats.worst_trade || 0),
          avg_win: parseFloat(stats.avg_win || 0),
          avg_loss: parseFloat(stats.avg_loss || 0),
          profit_factor: stats.avg_loss > 0 
            ? (stats.avg_win / stats.avg_loss).toFixed(2)
            : 0
        },
        by_symbol: symbolStats.map(item => ({
          symbol: item.symbol,
          trades_count: parseInt(item.trades_count),
          wins: parseInt(item.wins),
          win_rate: ((item.wins / item.trades_count) * 100).toFixed(2),
          total_pnl: parseFloat(item.total_pnl)
        })),
        daily_performance: dailyStats.map(item => ({
          date: item.date,
          trades_count: parseInt(item.trades_count),
          daily_pnl: parseFloat(item.daily_pnl)
        }))
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar estatísticas de trading', {
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
 * DELETE /api/v1/users/account
 * Deletar conta do usuário
 */
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        status: 'error',
        message: 'Senha é obrigatória para deletar a conta'
      });
    }

    // Verificar senha
    const users = await database.query(
      'SELECT password_hash FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Usuário não encontrado'
      });
    }

    const isPasswordValid = await bcrypt.compare(password, users[0].password_hash);
    if (!isPasswordValid) {
      return res.status(400).json({
        status: 'error',
        message: 'Senha incorreta'
      });
    }

    // Deletar usuário (cascata deletará todos os dados relacionados)
    await database.query('DELETE FROM users WHERE id = ?', [userId]);

    logger.info('Conta deletada', { userId });

    res.json({
      status: 'success',
      message: 'Conta deletada com sucesso'
    });

  } catch (error) {
    logger.error('Erro ao deletar conta', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

module.exports = router;