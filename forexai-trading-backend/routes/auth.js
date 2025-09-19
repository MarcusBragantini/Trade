/**
 * Rotas de Autenticação
 * Login, Registro, Reset de Senha
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const database = require('../config/database');
const logger = require('../utils/logger');
const { auth, passwordReset } = require('../middleware/rateLimiting');

const router = express.Router();

// Schemas de validação
const registerSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required()
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required()
});

// Função para gerar JWT token
function generateToken(userId, email) {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );
}

// Função para hash da senha
async function hashPassword(password) {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}

/**
 * POST /api/v1/auth/register
 * Registrar novo usuário
 */
router.post('/register', auth, async (req, res) => {
  try {
    // Validar dados
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Dados inválidos',
        details: error.details[0].message
      });
    }

    const { name, email, password } = value;

    // Verificar se email já existe
    const existingUser = await database.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existingUser.length > 0) {
      return res.status(409).json({
        status: 'error',
        message: 'Email já está cadastrado'
      });
    }

    // Hash da senha
    const passwordHash = await hashPassword(password);

    // Inserir usuário no banco
    const result = await database.query(`
      INSERT INTO users (name, email, password_hash, subscription_type, status) 
      VALUES (?, ?, ?, 'free', 'active')
    `, [name, email, passwordHash]);

    const userId = result.insertId;

    // Criar configurações de trading padrão
    await database.query(`
      INSERT INTO trading_settings (user_id) VALUES (?)
    `, [userId]);

    // Gerar token JWT
    const token = generateToken(userId, email);

    logger.info('Novo usuário registrado', {
      userId,
      email,
      ip: req.ip
    });

    res.status(201).json({
      status: 'success',
      message: 'Usuário cadastrado com sucesso',
      data: {
        user: {
          id: userId,
          name,
          email,
          subscription_type: 'free',
          status: 'active'
        },
        token
      }
    });

  } catch (error) {
    logger.error('Erro ao registrar usuário', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * POST /api/v1/auth/login
 * Login de usuário
 */
router.post('/login', auth, async (req, res) => {
  try {
    // Validar dados
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Dados inválidos',
        details: error.details[0].message
      });
    }

    const { email, password } = value;

    // Buscar usuário
    const users = await database.query(`
      SELECT id, name, email, password_hash, subscription_type, 
             subscription_expires_at, status, balance, demo_balance 
      FROM users 
      WHERE email = ?
    `, [email]);

    if (users.length === 0) {
      return res.status(401).json({
        status: 'error',
        message: 'Email ou senha inválidos'
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

    // Verificar senha
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      logger.warn('Tentativa de login com senha inválida', {
        email,
        ip: req.ip
      });

      return res.status(401).json({
        status: 'error',
        message: 'Email ou senha inválidos'
      });
    }

    // Verificar se assinatura ainda está válida
    const now = new Date();
    const hasValidSubscription = user.subscription_type === 'free' || 
      (user.subscription_expires_at && new Date(user.subscription_expires_at) > now);

    if (!hasValidSubscription) {
      // Downgrade para free se assinatura expirou
      await database.query(
        'UPDATE users SET subscription_type = ? WHERE id = ?',
        ['free', user.id]
      );
      user.subscription_type = 'free';
    }

    // Gerar token JWT
    const token = generateToken(user.id, user.email);

    // Atualizar último login
    await database.query(
      'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [user.id]
    );

    logger.info('Login realizado com sucesso', {
      userId: user.id,
      email: user.email,
      ip: req.ip
    });

    // Remover senha do retorno
    delete user.password_hash;

    res.json({
      status: 'success',
      message: 'Login realizado com sucesso',
      data: {
        user,
        token,
        subscription: {
          type: user.subscription_type,
          expires_at: user.subscription_expires_at,
          is_valid: hasValidSubscription
        }
      }
    });

  } catch (error) {
    logger.error('Erro ao realizar login', {
      error: error.message,
      stack: error.stack,
      email: req.body?.email
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * POST /api/v1/auth/verify-token
 * Verificar se token JWT é válido
 */
router.post('/verify-token', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        status: 'error',
        message: 'Token não fornecido'
      });
    }

    // Verificar token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Buscar usuário atual
    const users = await database.query(`
      SELECT id, name, email, subscription_type, 
             subscription_expires_at, status, balance, demo_balance 
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

    if (user.status !== 'active') {
      return res.status(401).json({
        status: 'error',
        message: 'Conta suspensa ou inativa'
      });
    }

    res.json({
      status: 'success',
      message: 'Token válido',
      data: {
        user,
        isValid: true
      }
    });

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

    logger.error('Erro ao verificar token', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * POST /api/v1/auth/forgot-password
 * Solicitar reset de senha
 */
router.post('/forgot-password', passwordReset, async (req, res) => {
  try {
    const { error, value } = resetPasswordSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Email inválido'
      });
    }

    const { email } = value;

    // Verificar se usuário existe
    const users = await database.query(
      'SELECT id, name FROM users WHERE email = ? AND status = ?',
      [email, 'active']
    );

    // Sempre retornar sucesso por segurança (não revelar se email existe)
    res.json({
      status: 'success',
      message: 'Se o email estiver cadastrado, você receberá as instruções para reset'
    });

    if (users.length > 0) {
      // TODO: Implementar envio de email
      // Por enquanto apenas logar
      logger.info('Reset de senha solicitado', {
        userId: users[0].id,
        email,
        ip: req.ip
      });
    }

  } catch (error) {
    logger.error('Erro ao processar forgot password', {
      error: error.message,
      email: req.body?.email
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * POST /api/v1/auth/logout
 * Logout (invalidar token no cliente)
 */
router.post('/logout', (req, res) => {
  // JWT é stateless, então logout é feito no cliente
  // Aqui podemos apenas logar a ação
  logger.info('Logout realizado', {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.json({
    status: 'success',
    message: 'Logout realizado com sucesso'
  });
});

module.exports = router;