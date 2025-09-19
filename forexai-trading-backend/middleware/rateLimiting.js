/**
 * Middleware de Rate Limiting
 * Protege a API contra ataques de força bruta e spam
 */

const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

// Rate limiting geral para todas as rotas
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000, // 15 minutos
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || 100), // máximo 100 requests por IP
  message: {
    status: 'error',
    message: 'Muitas requisições deste IP, tente novamente em alguns minutos'
  },
  standardHeaders: true, // Retorna rate limit info nos headers
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit excedido', {
      ip: req.ip,
      url: req.originalUrl,
      userAgent: req.get('User-Agent')
    });
    
    res.status(429).json({
      status: 'error',
      message: 'Muitas requisições deste IP, tente novamente em alguns minutos',
      retryAfter: Math.round(generalLimiter.windowMs / 1000)
    });
  }
});

// Rate limiting específico para autenticação (mais restritivo)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // máximo 5 tentativas de login por IP
  message: {
    status: 'error',
    message: 'Muitas tentativas de login, tente novamente em 15 minutos'
  },
  skipSuccessfulRequests: true, // não conta requisições bem-sucedidas
  handler: (req, res) => {
    logger.warn('Rate limit de autenticação excedido', {
      ip: req.ip,
      email: req.body?.email,
      userAgent: req.get('User-Agent')
    });
    
    res.status(429).json({
      status: 'error',
      message: 'Muitas tentativas de login, tente novamente em 15 minutos',
      retryAfter: 900 // 15 minutos em segundos
    });
  }
});

// Rate limiting para trading (muito restritivo)
const tradingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // máximo 10 operações de trading por minuto
  message: {
    status: 'error',
    message: 'Limite de operações por minuto excedido'
  },
  keyGenerator: (req) => {
    // Usar user ID se disponível, senão IP
    return req.user?.id || req.ip;
  },
  handler: (req, res) => {
    logger.warn('Rate limit de trading excedido', {
      userId: req.user?.id,
      ip: req.ip,
      url: req.originalUrl
    });
    
    res.status(429).json({
      status: 'error',
      message: 'Limite de operações por minuto excedido',
      retryAfter: 60
    });
  }
});

// Rate limiting para API da IA
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 20, // máximo 20 requisições para IA por minuto
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
  handler: (req, res) => {
    logger.warn('Rate limit da IA excedido', {
      userId: req.user?.id,
      ip: req.ip,
      url: req.originalUrl
    });
    
    res.status(429).json({
      status: 'error',
      message: 'Limite de requisições para IA excedido',
      retryAfter: 60
    });
  }
});

// Rate limiting para pagamentos
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5, // máximo 5 tentativas de pagamento por hora
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
  handler: (req, res) => {
    logger.warn('Rate limit de pagamentos excedido', {
      userId: req.user?.id,
      ip: req.ip
    });
    
    res.status(429).json({
      status: 'error',
      message: 'Limite de tentativas de pagamento excedido',
      retryAfter: 3600
    });
  }
});

// Rate limiting para reset de senha
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3, // máximo 3 tentativas por hora
  keyGenerator: (req) => {
    return req.body?.email || req.ip;
  },
  handler: (req, res) => {
    logger.warn('Rate limit de reset de senha excedido', {
      email: req.body?.email,
      ip: req.ip
    });
    
    res.status(429).json({
      status: 'error',
      message: 'Muitas tentativas de reset de senha, tente novamente em 1 hora',
      retryAfter: 3600
    });
  }
});

// Middleware personalizado para diferentes tipos de rate limiting
function createCustomLimiter(options = {}) {
  const defaultOptions = {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Rate limit excedido',
    ...options
  };

  return rateLimit({
    ...defaultOptions,
    handler: (req, res) => {
      logger.warn(`Rate limit customizado excedido: ${options.name || 'unnamed'}`, {
        userId: req.user?.id,
        ip: req.ip,
        url: req.originalUrl
      });
      
      res.status(429).json({
        status: 'error',
        message: defaultOptions.message,
        retryAfter: Math.round(defaultOptions.windowMs / 1000)
      });
    }
  });
}

module.exports = {
  general: generalLimiter,
  auth: authLimiter,
  trading: tradingLimiter,
  ai: aiLimiter,
  payment: paymentLimiter,
  passwordReset: passwordResetLimiter,
  createCustom: createCustomLimiter
};