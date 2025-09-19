/**
 * Sistema de Logs para ForexAI Trading
 */

const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logDir = path.join(__dirname, '../logs');
    this.ensureLogDirectory();
  }

  // Garantir que o diretório de logs existe
  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  // Formatar timestamp
  getTimestamp() {
    return new Date().toISOString();
  }

  // Obter nome do arquivo de log
  getLogFileName(type = 'app') {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `${type}-${date}.log`);
  }

  // Escrever no arquivo de log
  writeToFile(level, message, data = {}, type = 'app') {
    const timestamp = this.getTimestamp();
    const logEntry = {
      timestamp,
      level,
      message,
      ...data
    };

    const logLine = JSON.stringify(logEntry) + '\n';
    const fileName = this.getLogFileName(type);

    try {
      fs.appendFileSync(fileName, logLine);
    } catch (error) {
      console.error('Erro ao escrever no arquivo de log:', error);
    }
  }

  // Log de informação
  info(message, data = {}) {
    const timestamp = this.getTimestamp();
    console.log(`\x1b[32m[${timestamp}] INFO:\x1b[0m ${message}`);
    
    if (Object.keys(data).length > 0) {
      console.log('\x1b[36m', JSON.stringify(data, null, 2), '\x1b[0m');
    }

    this.writeToFile('INFO', message, data);
  }

  // Log de erro
  error(message, data = {}) {
    const timestamp = this.getTimestamp();
    console.error(`\x1b[31m[${timestamp}] ERROR:\x1b[0m ${message}`);
    
    if (Object.keys(data).length > 0) {
      console.error('\x1b[35m', JSON.stringify(data, null, 2), '\x1b[0m');
    }

    this.writeToFile('ERROR', message, data, 'error');
  }

  // Log de warning
  warn(message, data = {}) {
    const timestamp = this.getTimestamp();
    console.warn(`\x1b[33m[${timestamp}] WARN:\x1b[0m ${message}`);
    
    if (Object.keys(data).length > 0) {
      console.warn('\x1b[36m', JSON.stringify(data, null, 2), '\x1b[0m');
    }

    this.writeToFile('WARN', message, data);
  }

  // Log de debug (apenas em desenvolvimento)
  debug(message, data = {}) {
    if (process.env.NODE_ENV !== 'production') {
      const timestamp = this.getTimestamp();
      console.log(`\x1b[34m[${timestamp}] DEBUG:\x1b[0m ${message}`);
      
      if (Object.keys(data).length > 0) {
        console.log('\x1b[36m', JSON.stringify(data, null, 2), '\x1b[0m');
      }

      this.writeToFile('DEBUG', message, data, 'debug');
    }
  }

  // Log específico para trading
  trading(message, data = {}) {
    const timestamp = this.getTimestamp();
    console.log(`\x1b[95m[${timestamp}] TRADING:\x1b[0m ${message}`);
    
    if (Object.keys(data).length > 0) {
      console.log('\x1b[36m', JSON.stringify(data, null, 2), '\x1b[0m');
    }

    this.writeToFile('TRADING', message, data, 'trading');
  }

  // Log específico para IA
  ai(message, data = {}) {
    const timestamp = this.getTimestamp();
    console.log(`\x1b[96m[${timestamp}] AI:\x1b[0m ${message}`);
    
    if (Object.keys(data).length > 0) {
      console.log('\x1b[36m', JSON.stringify(data, null, 2), '\x1b[0m');
    }

    this.writeToFile('AI', message, data, 'ai');
  }

  // Log específico para payments
  payment(message, data = {}) {
    const timestamp = this.getTimestamp();
    console.log(`\x1b[93m[${timestamp}] PAYMENT:\x1b[0m ${message}`);
    
    // Remover dados sensíveis antes de logar
    const safeData = { ...data };
    delete safeData.card_number;
    delete safeData.cvv;
    delete safeData.password;
    
    if (Object.keys(safeData).length > 0) {
      console.log('\x1b[36m', JSON.stringify(safeData, null, 2), '\x1b[0m');
    }

    this.writeToFile('PAYMENT', message, safeData, 'payment');
  }

  // Limpar logs antigos (manter apenas os últimos 30 dias)
  cleanOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      files.forEach(file => {
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime < thirtyDaysAgo) {
          fs.unlinkSync(filePath);
          this.info(`Log antigo removido: ${file}`);
        }
      });
    } catch (error) {
      this.error('Erro ao limpar logs antigos:', { error: error.message });
    }
  }
}

// Criar instância única
const logger = new Logger();

// Limpar logs antigos na inicialização
logger.cleanOldLogs();

module.exports = logger;