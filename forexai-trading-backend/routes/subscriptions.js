/**
 * Sistema SaaS - Assinaturas e Pagamentos
 * Integração com Stripe, controle de mensalidades
 */

const express = require('express');
const Joi = require('joi');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const database = require('../config/database');
const logger = require('../utils/logger');
const { authenticateToken } = require('../middleware/auth');
const { payment } = require('../middleware/rateLimiting');

const router = express.Router();

// Planos disponíveis
const PLANS = {
  basic: {
    name: 'Basic Plan',
    price: 29.99,
    currency: 'USD',
    interval: 'month',
    features: [
      'AI Trading Bot',
      'Real Trading',
      'Basic Indicators',
      '50 trades/day',
      'Email Support'
    ]
  },
  premium: {
    name: 'Premium Plan',
    price: 79.99,
    currency: 'USD',
    interval: 'month',
    features: [
      'Advanced AI Trading',
      'Unlimited Trades',
      'All Indicators',
      'Multiple Brokers',
      'Custom Settings',
      'Priority Support',
      'API Access'
    ]
  }
};

// Schemas de validação
const createSubscriptionSchema = Joi.object({
  plan_type: Joi.string().valid('basic', 'premium').required(),
  payment_method_id: Joi.string().required()
});

/**
 * GET /api/v1/subscriptions/plans
 * Listar planos disponíveis
 */
router.get('/plans', async (req, res) => {
  try {
    const plans = Object.keys(PLANS).map(key => ({
      id: key,
      ...PLANS[key]
    }));

    res.json({
      status: 'success',
      data: { plans }
    });

  } catch (error) {
    logger.error('Erro ao listar planos', { error: error.message });
    
    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * POST /api/v1/subscriptions/create
 * Criar nova assinatura
 */
router.post('/create', [
  authenticateToken,
  payment
], async (req, res) => {
  try {
    const { error, value } = createSubscriptionSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        status: 'error',
        message: 'Dados inválidos',
        details: error.details[0].message
      });
    }

    const { plan_type, payment_method_id } = value;
    const userId = req.user.id;
    const userEmail = req.user.email;

    // Verificar se o plano existe
    if (!PLANS[plan_type]) {
      return res.status(400).json({
        status: 'error',
        message: 'Plano não encontrado'
      });
    }

    const plan = PLANS[plan_type];

    logger.payment('Iniciando criação de assinatura', {
      userId,
      userEmail,
      plan_type,
      price: plan.price
    });

    // Verificar se usuário já tem assinatura ativa
    const existingSubscription = await database.query(`
      SELECT id, status FROM subscriptions 
      WHERE user_id = ? AND status IN ('active', 'past_due')
    `, [userId]);

    if (existingSubscription.length > 0) {
      return res.status(409).json({
        status: 'error',
        message: 'Usuário já possui uma assinatura ativa'
      });
    }

    // Buscar ou criar customer no Stripe
    let customer;
    try {
      const existingCustomers = await stripe.customers.list({
        email: userEmail,
        limit: 1
      });

      if (existingCustomers.data.length > 0) {
        customer = existingCustomers.data[0];
      } else {
        customer = await stripe.customers.create({
          email: userEmail,
          name: req.user.name,
          metadata: {
            user_id: userId.toString()
          }
        });
      }
    } catch (stripeError) {
      logger.error('Erro ao criar/buscar customer no Stripe', {
        error: stripeError.message,
        userId
      });

      return res.status(500).json({
        status: 'error',
        message: 'Erro ao processar pagamento'
      });
    }

    // Anexar método de pagamento ao customer
    try {
      await stripe.paymentMethods.attach(payment_method_id, {
        customer: customer.id
      });

      // Definir como método padrão
      await stripe.customers.update(customer.id, {
        invoice_settings: {
          default_payment_method: payment_method_id
        }
      });
    } catch (stripeError) {
      logger.error('Erro ao anexar método de pagamento', {
        error: stripeError.message,
        userId,
        payment_method_id
      });

      return res.status(400).json({
        status: 'error',
        message: 'Método de pagamento inválido'
      });
    }

    // Criar produto no Stripe (se não existir)
    let product;
    try {
      const products = await stripe.products.list({
        active: true,
        limit: 100
      });
      
      product = products.data.find(p => p.metadata.plan_type === plan_type);
      
      if (!product) {
        product = await stripe.products.create({
          name: plan.name,
          metadata: {
            plan_type: plan_type
          }
        });
      }
    } catch (stripeError) {
      logger.error('Erro ao criar produto no Stripe', {
        error: stripeError.message
      });

      return res.status(500).json({
        status: 'error',
        message: 'Erro ao processar pagamento'
      });
    }

    // Criar preço no Stripe
    let price;
    try {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(plan.price * 100), // Stripe usa centavos
        currency: plan.currency.toLowerCase(),
        recurring: {
          interval: plan.interval
        }
      });
    } catch (stripeError) {
      logger.error('Erro ao criar preço no Stripe', {
        error: stripeError.message
      });

      return res.status(500).json({
        status: 'error',
        message: 'Erro ao processar pagamento'
      });
    }

    // Criar assinatura no Stripe
    let stripeSubscription;
    try {
      stripeSubscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{
          price: price.id
        }],
        payment_behavior: 'default_incomplete',
        payment_settings: {
          save_default_payment_method: 'on_subscription'
        },
        expand: ['latest_invoice.payment_intent']
      });
    } catch (stripeError) {
      logger.error('Erro ao criar assinatura no Stripe', {
        error: stripeError.message,
        userId
      });

      return res.status(500).json({
        status: 'error',
        message: 'Erro ao processar pagamento'
      });
    }

    // Salvar assinatura no banco
    const currentPeriodStart = new Date(stripeSubscription.current_period_start * 1000);
    const currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000);

    await database.query(`
      INSERT INTO subscriptions (
        user_id, stripe_subscription_id, plan_type, status,
        current_period_start, current_period_end, amount, currency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      stripeSubscription.id,
      plan_type,
      stripeSubscription.status,
      currentPeriodStart,
      currentPeriodEnd,
      plan.price,
      plan.currency
    ]);

    // Atualizar usuário
    await database.query(`
      UPDATE users 
      SET subscription_type = ?, subscription_expires_at = ?
      WHERE id = ?
    `, [plan_type, currentPeriodEnd, userId]);

    logger.payment('Assinatura criada com sucesso', {
      userId,
      plan_type,
      stripe_subscription_id: stripeSubscription.id,
      amount: plan.price
    });

    // Se a assinatura precisa de confirmação de pagamento
    if (stripeSubscription.status === 'incomplete') {
      const paymentIntent = stripeSubscription.latest_invoice.payment_intent;
      
      return res.json({
        status: 'requires_payment_confirmation',
        message: 'Confirmação de pagamento necessária',
        data: {
          subscription_id: stripeSubscription.id,
          client_secret: paymentIntent.client_secret,
          payment_intent_id: paymentIntent.id
        }
      });
    }

    // Emitir evento via Socket.IO
    if (global.io) {
      global.io.to(`user_${userId}`).emit('subscription_created', {
        plan_type,
        status: stripeSubscription.status,
        expires_at: currentPeriodEnd
      });
    }

    res.status(201).json({
      status: 'success',
      message: 'Assinatura criada com sucesso',
      data: {
        subscription_id: stripeSubscription.id,
        plan_type,
        status: stripeSubscription.status,
        current_period_start: currentPeriodStart,
        current_period_end: currentPeriodEnd,
        amount: plan.price,
        currency: plan.currency
      }
    });

  } catch (error) {
    logger.error('Erro ao criar assinatura', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * GET /api/v1/subscriptions/current
 * Obter assinatura atual do usuário
 */
router.get('/current', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const subscriptions = await database.query(`
      SELECT id, stripe_subscription_id, plan_type, status,
             current_period_start, current_period_end, 
             cancel_at_period_end, amount, currency, created_at
      FROM subscriptions 
      WHERE user_id = ? 
      ORDER BY created_at DESC 
      LIMIT 1
    `, [userId]);

    if (subscriptions.length === 0) {
      return res.json({
        status: 'success',
        data: {
          has_subscription: false,
          current_plan: 'free'
        }
      });
    }

    const subscription = subscriptions[0];
    const now = new Date();
    const isActive = new Date(subscription.current_period_end) > now;

    // Buscar informações atualizadas do Stripe
    let stripeSubscription = null;
    if (subscription.stripe_subscription_id) {
      try {
        stripeSubscription = await stripe.subscriptions.retrieve(
          subscription.stripe_subscription_id
        );
        
        // Atualizar status se necessário
        if (stripeSubscription.status !== subscription.status) {
          await database.query(
            'UPDATE subscriptions SET status = ? WHERE id = ?',
            [stripeSubscription.status, subscription.id]
          );
        }
      } catch (stripeError) {
        logger.warn('Erro ao buscar assinatura no Stripe', {
          error: stripeError.message,
          subscription_id: subscription.stripe_subscription_id
        });
      }
    }

    res.json({
      status: 'success',
      data: {
        has_subscription: true,
        subscription: {
          id: subscription.id,
          plan_type: subscription.plan_type,
          status: stripeSubscription?.status || subscription.status,
          current_period_start: subscription.current_period_start,
          current_period_end: subscription.current_period_end,
          cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
          amount: parseFloat(subscription.amount),
          currency: subscription.currency,
          is_active: isActive,
          next_billing_date: isActive ? subscription.current_period_end : null
        },
        plan_features: PLANS[subscription.plan_type]?.features || []
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar assinatura atual', {
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
 * POST /api/v1/subscriptions/cancel
 * Cancelar assinatura
 */
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { cancel_at_period_end = true } = req.body;

    // Buscar assinatura ativa
    const subscriptions = await database.query(`
      SELECT id, stripe_subscription_id, plan_type
      FROM subscriptions 
      WHERE user_id = ? AND status IN ('active', 'past_due')
      ORDER BY created_at DESC 
      LIMIT 1
    `, [userId]);

    if (subscriptions.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Nenhuma assinatura ativa encontrada'
      });
    }

    const subscription = subscriptions[0];

    // Cancelar no Stripe
    if (subscription.stripe_subscription_id) {
      try {
        await stripe.subscriptions.update(subscription.stripe_subscription_id, {
          cancel_at_period_end: cancel_at_period_end
        });
      } catch (stripeError) {
        logger.error('Erro ao cancelar assinatura no Stripe', {
          error: stripeError.message,
          subscription_id: subscription.stripe_subscription_id
        });

        return res.status(500).json({
          status: 'error',
          message: 'Erro ao cancelar assinatura'
        });
      }
    }

    // Atualizar no banco
    await database.query(`
      UPDATE subscriptions 
      SET cancel_at_period_end = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [cancel_at_period_end, subscription.id]);

    logger.payment('Assinatura cancelada', {
      userId,
      subscription_id: subscription.id,
      plan_type: subscription.plan_type,
      cancel_at_period_end
    });

    // Emitir evento via Socket.IO
    if (global.io) {
      global.io.to(`user_${userId}`).emit('subscription_cancelled', {
        cancel_at_period_end
      });
    }

    res.json({
      status: 'success',
      message: cancel_at_period_end 
        ? 'Assinatura será cancelada no final do período atual'
        : 'Assinatura cancelada imediatamente',
      data: {
        cancel_at_period_end
      }
    });

  } catch (error) {
    logger.error('Erro ao cancelar assinatura', {
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
 * POST /api/v1/subscriptions/webhook
 * Webhook do Stripe para eventos de assinatura
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.error('Erro na verificação do webhook', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.payment('Webhook recebido', {
    type: event.type,
    id: event.id
  });

  try {
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
        
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
        
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
        
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
        
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
        
      default:
        logger.info('Evento de webhook não tratado', { type: event.type });
    }

    res.json({ received: true });
    
  } catch (error) {
    logger.error('Erro ao processar webhook', {
      error: error.message,
      event_type: event.type,
      event_id: event.id
    });
    
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

/**
 * GET /api/v1/subscriptions/history
 * Histórico de assinaturas e pagamentos
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Buscar histórico de assinaturas
    const subscriptions = await database.query(`
      SELECT id, plan_type, status, current_period_start, 
             current_period_end, amount, currency, created_at,
             cancel_at_period_end
      FROM subscriptions 
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, parseInt(limit), offset]);

    // Contar total
    const countResult = await database.query(
      'SELECT COUNT(*) as total FROM subscriptions WHERE user_id = ?',
      [userId]
    );

    res.json({
      status: 'success',
      data: {
        subscriptions: subscriptions.map(sub => ({
          ...sub,
          amount: parseFloat(sub.amount),
          cancel_at_period_end: Boolean(sub.cancel_at_period_end)
        })),
        pagination: {
          current_page: parseInt(page),
          per_page: parseInt(limit),
          total: parseInt(countResult[0].total),
          total_pages: Math.ceil(countResult[0].total / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Erro ao buscar histórico de assinaturas', {
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
 * POST /api/v1/subscriptions/reactivate
 * Reativar assinatura cancelada
 */
router.post('/reactivate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar assinatura cancelada
    const subscriptions = await database.query(`
      SELECT id, stripe_subscription_id, plan_type
      FROM subscriptions 
      WHERE user_id = ? AND cancel_at_period_end = true
      ORDER BY created_at DESC 
      LIMIT 1
    `, [userId]);

    if (subscriptions.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Nenhuma assinatura cancelada encontrada'
      });
    }

    const subscription = subscriptions[0];

    // Reativar no Stripe
    if (subscription.stripe_subscription_id) {
      try {
        await stripe.subscriptions.update(subscription.stripe_subscription_id, {
          cancel_at_period_end: false
        });
      } catch (stripeError) {
        logger.error('Erro ao reativar assinatura no Stripe', {
          error: stripeError.message,
          subscription_id: subscription.stripe_subscription_id
        });

        return res.status(500).json({
          status: 'error',
          message: 'Erro ao reativar assinatura'
        });
      }
    }

    // Atualizar no banco
    await database.query(`
      UPDATE subscriptions 
      SET cancel_at_period_end = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [subscription.id]);

    logger.payment('Assinatura reativada', {
      userId,
      subscription_id: subscription.id,
      plan_type: subscription.plan_type
    });

    // Emitir evento via Socket.IO
    if (global.io) {
      global.io.to(`user_${userId}`).emit('subscription_reactivated', {
        plan_type: subscription.plan_type
      });
    }

    res.json({
      status: 'success',
      message: 'Assinatura reativada com sucesso'
    });

  } catch (error) {
    logger.error('Erro ao reativar assinatura', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

// Funções auxiliares para webhook

async function handleSubscriptionCreated(subscription) {
  logger.payment('Assinatura criada via webhook', {
    subscription_id: subscription.id,
    customer: subscription.customer,
    status: subscription.status
  });

  // Lógica adicional se necessário
}

async function handleSubscriptionUpdated(subscription) {
  logger.payment('Assinatura atualizada via webhook', {
    subscription_id: subscription.id,
    status: subscription.status
  });

  try {
    // Atualizar status no banco
    await database.query(`
      UPDATE subscriptions 
      SET status = ?, current_period_start = ?, current_period_end = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE stripe_subscription_id = ?
    `, [
      subscription.status,
      new Date(subscription.current_period_start * 1000),
      new Date(subscription.current_period_end * 1000),
      subscription.id
    ]);

    // Se assinatura foi cancelada, atualizar usuário
    if (subscription.status === 'canceled') {
      const subscriptionData = await database.query(
        'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?',
        [subscription.id]
      );

      if (subscriptionData.length > 0) {
        await database.query(`
          UPDATE users 
          SET subscription_type = 'free', subscription_expires_at = NULL
          WHERE id = ?
        `, [subscriptionData[0].user_id]);
      }
    }

  } catch (error) {
    logger.error('Erro ao processar atualização de assinatura', {
      error: error.message,
      subscription_id: subscription.id
    });
  }
}

async function handleSubscriptionDeleted(subscription) {
  logger.payment('Assinatura deletada via webhook', {
    subscription_id: subscription.id
  });

  try {
    // Marcar como cancelada
    await database.query(`
      UPDATE subscriptions 
      SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
      WHERE stripe_subscription_id = ?
    `, [subscription.id]);

    // Downgrade usuário para free
    const subscriptionData = await database.query(
      'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?',
      [subscription.id]
    );

    if (subscriptionData.length > 0) {
      const userId = subscriptionData[0].user_id;
      
      await database.query(`
        UPDATE users 
        SET subscription_type = 'free', subscription_expires_at = NULL
        WHERE id = ?
      `, [userId]);

      // Emitir evento via Socket.IO
      if (global.io) {
        global.io.to(`user_${userId}`).emit('subscription_cancelled', {
          immediate: true
        });
      }
    }

  } catch (error) {
    logger.error('Erro ao processar exclusão de assinatura', {
      error: error.message,
      subscription_id: subscription.id
    });
  }
}

async function handlePaymentSucceeded(invoice) {
  logger.payment('Pagamento bem-sucedido via webhook', {
    invoice_id: invoice.id,
    amount: invoice.amount_paid,
    customer: invoice.customer
  });

  try {
    // Buscar assinatura
    const subscription = await database.query(`
      SELECT id, user_id FROM subscriptions 
      WHERE stripe_subscription_id = ?
    `, [invoice.subscription]);

    if (subscription.length > 0) {
      const userId = subscription[0].user_id;

      // Garantir que usuário está com assinatura ativa
      await database.query(`
        UPDATE subscriptions 
        SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [subscription[0].id]);

      // Emitir evento via Socket.IO
      if (global.io) {
        global.io.to(`user_${userId}`).emit('payment_succeeded', {
          amount: invoice.amount_paid / 100,
          currency: invoice.currency
        });
      }
    }

  } catch (error) {
    logger.error('Erro ao processar pagamento bem-sucedido', {
      error: error.message,
      invoice_id: invoice.id
    });
  }
}

async function handlePaymentFailed(invoice) {
  logger.payment('Pagamento falhou via webhook', {
    invoice_id: invoice.id,
    customer: invoice.customer,
    attempt_count: invoice.attempt_count
  });

  try {
    // Buscar assinatura
    const subscription = await database.query(`
      SELECT id, user_id FROM subscriptions 
      WHERE stripe_subscription_id = ?
    `, [invoice.subscription]);

    if (subscription.length > 0) {
      const userId = subscription[0].user_id;

      // Atualizar status para past_due
      await database.query(`
        UPDATE subscriptions 
        SET status = 'past_due', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [subscription[0].id]);

      // Emitir evento via Socket.IO
      if (global.io) {
        global.io.to(`user_${userId}`).emit('payment_failed', {
          attempt_count: invoice.attempt_count,
          next_payment_attempt: invoice.next_payment_attempt
        });
      }

      // Se terceira tentativa falhada, cancelar assinatura
      if (invoice.attempt_count >= 3) {
        await database.query(`
          UPDATE users 
          SET subscription_type = 'free', subscription_expires_at = NULL
          WHERE id = ?
        `, [userId]);

        global.io?.to(`user_${userId}`).emit('subscription_cancelled', {
          reason: 'payment_failed'
        });
      }
    }

  } catch (error) {
    logger.error('Erro ao processar falha de pagamento', {
      error: error.message,
      invoice_id: invoice.id
    });
  }
}

module.exports = router;