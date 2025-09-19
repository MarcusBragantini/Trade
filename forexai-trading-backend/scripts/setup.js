/**
 * Setup Simplificado - ForexAI Trading
 * Versão robusta sem placeholders complexos
 */

require('dotenv').config();

async function simpleSetup() {
  console.log('🚀 ForexAI Trading - Setup Simplificado\n');

  try {
    // Testar conexão básica
    console.log('📊 Conectando ao MySQL...');
    const mysql = require('mysql2/promise');
    
    // Conectar direto com o banco especificado
    const dbName = process.env.DB_NAME || 'forexai_trading';
    
    // Primeiro, conectar sem database para criar o banco
    let connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || undefined
    });

    console.log('✅ Conectado ao MySQL!');

    // Criar banco se não existir
    console.log(`📝 Criando banco: ${dbName}`);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    console.log('✅ Banco criado/verificado!');

    // Fechar conexão inicial
    await connection.end();

    // Reconectar especificando o database
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || undefined,
      database: dbName
    });

    console.log('✅ Conectado ao banco específico!');

    // Criar tabelas essenciais
    console.log('🏗️  Criando tabelas...');

    // Tabela users
    await connection.query(`
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
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela users criada!');

    // Tabela trading_settings
    await connection.query(`
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
        ai_settings JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela trading_settings criada!');

    // Tabela trades
    await connection.query(`
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
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela trades criada!');

    // Tabela subscriptions
    await connection.query(`
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
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela subscriptions criada!');

    // Tabela ai_logs
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ai_logs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NULL,
        type ENUM('analysis', 'decision', 'trade', 'error', 'settings', 'backtest') NOT NULL,
        symbol VARCHAR(20) NULL,
        message TEXT NOT NULL,
        data JSON NULL,
        confidence DECIMAL(5, 2) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela ai_logs criada!');

    // Tabela market_data
    await connection.query(`
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
        UNIQUE KEY unique_candle (symbol, timeframe, timestamp)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela market_data criada!');

    // Criar usuário admin
    console.log('👑 Criando usuário admin...');
    const bcrypt = require('bcryptjs');
    const adminPassword = await bcrypt.hash('admin123', 12);
    
    try {
      const [existingAdmin] = await connection.query(
        'SELECT id FROM users WHERE email = ?',
        ['admin@forexai.com']
      );

      if (existingAdmin.length === 0) {
        const [adminResult] = await connection.query(`
          INSERT INTO users (name, email, password_hash, subscription_type, status)
          VALUES (?, ?, ?, ?, ?)
        `, ['Administrator', 'admin@forexai.com', adminPassword, 'premium', 'active']);

        const adminId = adminResult.insertId;
        
        // Criar configurações para admin
        await connection.query(`
          INSERT INTO trading_settings (user_id, trading_active, ai_active) 
          VALUES (?, ?, ?)
        `, [adminId, true, true]);
        
        console.log('✅ Usuário admin criado!');
        console.log('   📧 Email: admin@forexai.com');
        console.log('   🔑 Senha: admin123');
      } else {
        console.log('ℹ️  Usuário admin já existe, pulando...');
      }
    } catch (error) {
      console.log('⚠️  Erro ao criar admin:', error.message);
    }

    // Criar usuário demo se solicitado
    const args = process.argv.slice(2);
    if (args.includes('--with-demo')) {
      console.log('🌱 Criando usuário demo...');
      const demoPassword = await bcrypt.hash('demo123', 12);
      
      try {
        const [existingDemo] = await connection.query(
          'SELECT id FROM users WHERE email = ?',
          ['demo@forexai.com']
        );

        if (existingDemo.length === 0) {
          const [demoResult] = await connection.query(`
            INSERT INTO users (name, email, password_hash, subscription_type, status, demo_balance)
            VALUES (?, ?, ?, ?, ?, ?)
          `, ['Demo User', 'demo@forexai.com', demoPassword, 'basic', 'active', 10000.00]);

          const demoId = demoResult.insertId;
          
          await connection.query(`
            INSERT INTO trading_settings (user_id, trading_active, ai_active)
            VALUES (?, ?, ?)
          `, [demoId, true, true]);

          // Inserir alguns trades demo
          const demoTrades = [
            ['DEMO_001', 'EURUSD', 'buy', 1.0840, 1.0855, 100, 15, 'closed', 'deriv', true],
            ['DEMO_002', 'GBPUSD', 'sell', 1.2740, 1.2720, 150, 20, 'closed', 'deriv', true],
            ['DEMO_003', 'USDJPY', 'buy', 148.20, null, 75, null, 'active', 'deriv', true]
          ];

          for (const trade of demoTrades) {
            await connection.query(`
              INSERT INTO trades (
                user_id, trade_id, symbol, type, entry_price, exit_price,
                amount, profit_loss, status, broker, is_demo, opened_at, closed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
            `, [demoId, ...trade, trade[8] === 'closed' ? new Date() : null]);
          }

          console.log('✅ Usuário demo criado com trades exemplo!');
          console.log('   📧 Email: demo@forexai.com');
          console.log('   🔑 Senha: demo123');
        } else {
          console.log('ℹ️  Usuário demo já existe, pulando...');
        }
      } catch (error) {
        console.log('⚠️  Erro ao criar demo:', error.message);
      }
    }

    await connection.end();
    console.log('\n🎉 Setup concluído com sucesso!');
    console.log('🌐 Execute: npm run dev');
    console.log('🔗 API: http://localhost:5000');
    console.log('❤️  Health: http://localhost:5000/health');
    console.log('\n👥 Usuários criados:');
    console.log('   🔑 Admin: admin@forexai.com / admin123');
    if (args.includes('--with-demo')) {
      console.log('   🎭 Demo: demo@forexai.com / demo123');
    }

  } catch (error) {
    console.error('❌ Erro durante setup:', error.message);
    console.log('\n🔧 Verifique:');
    console.log('   1. MySQL está rodando');
    console.log('   2. Credenciais no .env estão corretas');
    console.log('   3. Usuário tem permissões para criar databases');
    console.log('\n🐛 Erro técnico:', error.code || 'N/A');
    process.exit(1);
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  simpleSetup();
}

module.exports = { simpleSetup };