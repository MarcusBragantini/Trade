/**
 * Configuração do Banco de Dados MySQL
 */

const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

class Database {
  constructor() {
    this.connection = null;
    this.pool = null;
  }

  // Configuração da conexão
  getConfig() {
    return {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'forexai_trading',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
      // Remover opções inválidas para mysql2
      timezone: '+00:00',
      supportBigNumbers: true,
      bigNumberStrings: true
    };
  }

  // Conectar ao banco
  async connect() {
    try {
      // Criar pool de conexões
      this.pool = mysql.createPool(this.getConfig());
      
      // Testar conexão
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();
      
      logger.info('✅ Pool de conexões MySQL criado com sucesso');
      return true;
    } catch (error) {
      logger.error('❌ Erro ao conectar ao MySQL:', error.message);
      throw error;
    }
  }

  // Obter conexão do pool
  async getConnection() {
    if (!this.pool) {
      throw new Error('Pool de conexões não inicializado');
    }
    return await this.pool.getConnection();
  }

  // Executar query
  async query(sql, params = []) {
    const connection = await this.getConnection();
    try {
      const [results] = await connection.execute(sql, params);
      return results;
    } catch (error) {
      logger.error('Erro na query:', { sql, params, error: error.message });
      throw error;
    } finally {
      connection.release();
    }
  }

  // Executar transação
  async transaction(callback) {
    const connection = await this.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      logger.error('Erro na transação:', error.message);
      throw error;
    } finally {
      connection.release();
    }
  }

  // Executar migrações
  async migrate() {
    try {
      logger.info('🔄 Executando migrações...');

      // Criar tabela de usuários
      await this.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT PRIMARY KEY AUTO_INCREMENT,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
          subscription_type ENUM('free', 'basic', 'premium') DEFAULT 'free',
          subscription_expires_at DATETIME NULL,
          balance DECIMAL(15, 2) DEFAULT 0.00,
          demo_balance DECIMAL(15, 2) DEFAULT 10000.00,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_email (email),
          INDEX idx_status (status),
          INDEX idx_subscription (subscription_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Criar tabela de configurações de trading
      await this.query(`
        CREATE TABLE IF NOT EXISTS trading_settings (
          id INT PRIMARY KEY AUTO_INCREMENT,
          user_id INT NOT NULL,
          broker ENUM('deriv', 'iqoption', 'quotex') DEFAULT 'deriv',
          entry_amount DECIMAL(10, 2) DEFAULT 25.00,
          stop_loss_percent DECIMAL(5, 2) DEFAULT 2.50,
          take_profit_percent DECIMAL(5, 2) DEFAULT 3.00,
          ai_aggressiveness ENUM('conservative', 'moderate', 'aggressive') DEFAULT 'moderate',
          martingale_enabled BOOLEAN DEFAULT TRUE,
          max_daily_trades INT DEFAULT 50,
          trading_active BOOLEAN DEFAULT FALSE,
          ai_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_user_id (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Criar tabela de trades
      await this.query(`
        CREATE TABLE IF NOT EXISTS trades (
          id INT PRIMARY KEY AUTO_INCREMENT,
          user_id INT NOT NULL,
          trade_id VARCHAR(100) UNIQUE NOT NULL,
          symbol VARCHAR(20) NOT NULL,
          type ENUM('buy', 'sell') NOT NULL,
          entry_price DECIMAL(10, 5) NOT NULL,
          exit_price DECIMAL(10, 5) NULL,
          amount DECIMAL(10, 2) NOT NULL,
          profit_loss DECIMAL(10, 2) NULL,
          status ENUM('pending', 'active', 'closed', 'cancelled') DEFAULT 'pending',
          stop_loss DECIMAL(10, 5) NULL,
          take_profit DECIMAL(10, 5) NULL,
          broker ENUM('deriv', 'iqoption', 'quotex') NOT NULL,
          is_demo BOOLEAN DEFAULT FALSE,
          ai_confidence DECIMAL(5, 2) NULL,
          ai_decision_data JSON NULL,
          opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          closed_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_user_id (user_id),
          INDEX idx_symbol (symbol),
          INDEX idx_status (status),
          INDEX idx_opened_at (opened_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Criar tabela de assinaturas
      await this.query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id INT PRIMARY KEY AUTO_INCREMENT,
          user_id INT NOT NULL,
          stripe_subscription_id VARCHAR(255) UNIQUE NULL,
          plan_type ENUM('basic', 'premium') NOT NULL,
          status ENUM('active', 'canceled', 'past_due', 'unpaid') DEFAULT 'active',
          current_period_start DATETIME NOT NULL,
          current_period_end DATETIME NOT NULL,
          cancel_at_period_end BOOLEAN DEFAULT FALSE,
          amount DECIMAL(10, 2) NOT NULL,
          currency VARCHAR(3) DEFAULT 'USD',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_user_id (user_id),
          INDEX idx_status (status),
          INDEX idx_stripe_id (stripe_subscription_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Criar tabela de logs da IA
      await this.query(`
        CREATE TABLE IF NOT EXISTS ai_logs (
          id INT PRIMARY KEY AUTO_INCREMENT,
          user_id INT NULL,
          type ENUM('analysis', 'decision', 'trade', 'error') NOT NULL,
          symbol VARCHAR(20) NULL,
          message TEXT NOT NULL,
          data JSON NULL,
          confidence DECIMAL(5, 2) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          INDEX idx_user_id (user_id),
          INDEX idx_type (type),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Criar tabela de dados de mercado
      await this.query(`
        CREATE TABLE IF NOT EXISTS market_data (
          id INT PRIMARY KEY AUTO_INCREMENT,
          symbol VARCHAR(20) NOT NULL,
          timeframe ENUM('1m', '5m', '15m', '1h', '4h', '1d') NOT NULL,
          timestamp TIMESTAMP NOT NULL,
          open_price DECIMAL(10, 5) NOT NULL,
          high_price DECIMAL(10, 5) NOT NULL,
          low_price DECIMAL(10, 5) NOT NULL,
          close_price DECIMAL(10, 5) NOT NULL,
          volume BIGINT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_candle (symbol, timeframe, timestamp),
          INDEX idx_symbol_timeframe (symbol, timeframe),
          INDEX idx_timestamp (timestamp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      logger.info('✅ Migrações executadas com sucesso');
      return true;
    } catch (error) {
      logger.error('❌ Erro ao executar migrações:', error.message);
      throw error;
    }
  }

  // Desconectar
  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      logger.info('🔌 Pool de conexões MySQL encerrado');
    }
  }

  // Verificar status da conexão
  async isConnected() {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Criar instância única (singleton)
const database = new Database();

module.exports = database;