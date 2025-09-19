/**
 * Middleware de Autenticação e Autorização
 */

const jwt = require('jsonwebtoken');
const database = require('../config/database');
const logger = require('../utils/logger');

/**
 * Middleware para verificar token JWT
 */
async function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        status: 'error',
        message: 'Token de acesso requerido'
      });
    }

    // Verificar token JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Buscar usuário no banco
    const users = await database.query(`
      SELECT id, name, email, subscription_type, subscription_expires_at, 
             status, balance, demo_balance 
      FROM users 
      WHERE id = ?
    `, [decoded.userId]);

    if (users.length === 0) {
      return res.status(401).json({
        status: 'error',
        message: 'Usuário não encontrado'
      });
    }

    const user = users[0];

    // Verificar se conta está ativa
    if (user.status !== 'active') {
      return res.status(401).json({
        status: 'error',
        message: 'Conta suspensa ou inativa'
      });
    }

    // Verificar se assinatura ainda é válida
    const now = new Date();
    const hasValidSubscription = user.subscription_type === 'free' || 
      (user.subscription_expires_at && new Date(user.subscription_expires_at) > now);

    // Adicionar dados do usuário na requisição
    req.user = {
      ...user,
      hasValidSubscription
    };

    next();

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        status: 'error',
        message: 'Token inválido'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'error',
        message: 'Token expirado'
      });
    }

    logger.error('Erro na autenticação', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
}

/**
 * Middleware para verificar se usuário tem assinatura ativa
 */
function requireSubscription(requiredType = 'basic') {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        status: 'error',
        message: 'Usuário não autenticado'
      });
    }

    const { subscription_type, hasValidSubscription } = req.user;

    // Se é free e requer premium/basic
    if (subscription_type === 'free' && requiredType !== 'free') {
      return res.status(403).json({
        status: 'error',
        message: 'Assinatura premium ou básica necessária',
        required_subscription: requiredType,
        current_subscription: subscription_type,
        upgrade_required: true
      });
    }

    // Se tem basic mas requer premium
    if (subscription_type === 'basic' && requiredType === 'premium') {
      return res.status(403).json({
        status: 'error',
        message: 'Assinatura premium necessária',
        required_subscription: requiredType,
        current_subscription: subscription_type,
        upgrade_required: true
      });
    }

    // Verificar se assinatura não expirou
    if (!hasValidSubscription && subscription_type !== 'free') {
      return res.status(403).json({
        status: 'error',
        message: 'Assinatura expirada',
        current_subscription: subscription_type,
        expired: true
      });
    }

    next();
  };
}

/**
 * Middleware para verificar se usuário é administrador
 */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({
      status: 'error',
      message: 'Acesso negado - privilégios de administrador necessários'
    });
  }
  next();
}

/**
 * Middleware opcional de autenticação (não falha se não houver token)
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      const users = await database.query(`
        SELECT id, name, email, subscription_type, subscription_expires_at, 
               status, balance, demo_balance 
        FROM users 
        WHERE id = ?
      `, [decoded.userId]);

      if (users.length > 0 && users[0].status === 'active') {
        const user = users[0];
        const now = new Date();
        const hasValidSubscription = user.subscription_type === 'free' || 
          (user.subscription_expires_at && new Date(user.subscription_expires_at) > now);

        req.user = {
          ...user,
          hasValidSubscription
        };
      }
    }

    next();
  } catch (error) {
    // Em caso de erro, apenas continue sem autenticação
    next();
  }
}

/**
 * Middleware para limitar features baseado no tipo de assinatura
 */
function checkFeatureAccess(feature) {
  const featureMap = {
    'ai_trading': ['basic', 'premium'],
    'advanced_ai': ['premium'],
    'unlimited_trades': ['premium'],
    'real_trading': ['basic', 'premium'],
    'multiple_brokers': ['premium'],
    'custom_indicators': ['premium'],
    'api_access': ['premium']
  };

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        status: 'error',
        message: 'Usuário não autenticado'
      });
    }

    const allowedSubscriptions = featureMap[feature];
    if (!allowedSubscriptions) {
      return res.status(400).json({
        status: 'error',
        message: 'Feature não reconhecida'
      });
    }

    const userSubscription = req.user.subscription_type;

    if (!allowedSubscriptions.includes(userSubscription)) {
      return res.status(403).json({
        status: 'error',
        message: `Feature '${feature}' não disponível na sua assinatura`,
        required_subscriptions: allowedSubscriptions,
        current_subscription: userSubscription,
        upgrade_required: true
      });
    }

    // Verificar se assinatura não expirou
    if (!req.user.hasValidSubscription && userSubscription !== 'free') {
      return res.status(403).json({
        status: 'error',
        message: 'Assinatura expirada',
        feature,
        expired: true
      });
    }

    next();
  };
}

/**
 * Middleware para verificar limites baseados na assinatura
 */
function checkLimits(limitType) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        status: 'error',
        message: 'Usuário não autenticado'
      });
    }

    try {
      const userId = req.user.id;
      const subscription = req.user.subscription_type;
      
      // Definir limites por tipo de assinatura
      const limits = {
        free: {
          daily_trades: 5,
          monthly_trades: 50,
          max_trade_amount: 10
        },
        basic: {
          daily_trades: 50,
          monthly_trades: 1000,
          max_trade_amount: 100
        },
        premium: {
          daily_trades: -1, // ilimitado
          monthly_trades: -1,
          max_trade_amount: -1
        }
      };

      const userLimits = limits[subscription];

      if (limitType === 'daily_trades') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const dailyTrades = await database.query(`
          SELECT COUNT(*) as count 
          FROM trades 
          WHERE user_id = ? AND DATE(created_at) = DATE(?)
        `, [userId, today]);

        const tradesCount = dailyTrades[0].count;

        if (userLimits.daily_trades !== -1 && tradesCount >= userLimits.daily_trades) {
          return res.status(403).json({
            status: 'error',
            message: 'Limite diário de trades excedido',
            limit: userLimits.daily_trades,
            current: tradesCount,
            subscription: subscription
          });
        }
      }

      next();
    } catch (error) {
      logger.error('Erro ao verificar limites', {
        error: error.message,
        userId: req.user?.id,
        limitType
      });

      res.status(500).json({
        status: 'error',
        message: 'Erro ao verificar limites'
      });
    }
  };
}

module.exports = {
  authenticateToken,
  requireSubscription,
  requireAdmin,
  optionalAuth,
  checkFeatureAccess,
  checkLimits
};