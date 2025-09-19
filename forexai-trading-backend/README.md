# 🤖 ForexAI Trading Platform - Backend

Sistema completo de trading FOREX com Inteligência Artificial, análise técnica automatizada e modelo SaaS.

## 📋 Índice

- [Características](#características)
- [Tecnologias](#tecnologias)
- [Estrutura do Projeto](#estrutura-do-projeto)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Uso](#uso)
- [API Endpoints](#api-endpoints)
- [Sistema de IA](#sistema-de-ia)
- [SaaS e Pagamentos](#saas-e-pagamentos)
- [Testes](#testes)
- [Deploy](#deploy)

## ✨ Características

### 🧠 Inteligência Artificial
- **Análise técnica automatizada** com 10+ indicadores
- **Detecção de padrões** de candlesticks
- **Suporte/Resistência** automático
- **Análise de tendências** e momentum
- **Gestão de risco** inteligente
- **Backtesting** de estratégias

### 💹 Trading Automático
- **Integração com corretoras** (Deriv, IQ Option, Quotex)
- **Execução automática** de trades
- **Stop Loss e Take Profit** dinâmicos
- **Martingale inteligente** (controlado pela IA)
- **Múltiplos timeframes** (1m, 5m, 15m, 1h, 4h, 1d)
- **Demo e real trading**

### 💳 Sistema SaaS
- **Assinaturas mensais** (Basic $29.99, Premium $79.99)
- **Integração com Stripe** para pagamentos
- **Webhooks** para eventos de pagamento
- **Controle de features** por plano
- **Rate limiting** inteligente

### 🛡️ Segurança
- **JWT Authentication** com refresh tokens
- **Rate limiting** por tipo de operação
- **Validação rigorosa** com Joi
- **Headers de segurança** com Helmet
- **Logs detalhados** de todas as operações

## 🚀 Tecnologias

- **Node.js 18+** - Runtime JavaScript
- **Express.js** - Framework web
- **MySQL** - Banco de dados
- **Socket.IO** - Comunicação real-time
- **Stripe** - Processamento de pagamentos
- **JWT** - Autenticação
- **Bcrypt** - Hash de senhas
- **Joi** - Validação de dados

## 📁 Estrutura do Projeto

```
forexai-trading-backend/
├── server.js                  # Servidor principal
├── package.json              # Dependências
├── .env.example              # Exemplo de configuração
│
├── config/                   # Configurações
│   ├── database.js          # MySQL connection
│   └── cors.js              # CORS settings
│
├── controllers/              # Lógica de negócio
├── middleware/               # Middlewares
│   ├── auth.js              # Autenticação JWT
│   ├── rateLimiting.js      # Rate limiting
│   └── validation.js        # Validação
│
├── models/                   # Modelos de dados
├── routes/                   # Rotas da API
│   ├── auth.js              # Autenticação
│   ├── users.js             # Usuários
│   ├── trading.js           # Trading
│   ├── ai.js                # IA
│   └── subscriptions.js     # SaaS
│
├── ai/                       # Sistema de IA
│   ├── marketAnalysis.js    # Análise de mercado
│   ├── indicators.js        # Indicadores técnicos
│   └── decisionEngine.js    # Tomada de decisões
│
├── services/                 # Serviços externos
├── utils/                    # Utilitários
│   └── logger.js            # Sistema de logs
│
└── scripts/                  # Scripts utilitários
    └── setup.js             # Setup inicial
```

## 📦 Instalação

### Pré-requisitos
- Node.js 18+
- MySQL 8.0+
- npm ou yarn

### Passo a passo

1. **Clone o repositório**
```bash
git clone https://github.com/seu-usuario/forexai-trading-backend.git
cd forexai-trading-backend
```

2. **Instale as dependências**
```bash
npm install
```

3. **Configure o banco de dados**
```bash
# No MySQL, crie o banco
CREATE DATABASE forexai_trading;
```

4. **Configure as variáveis de ambiente**
```bash
cp .env.example .env
# Edite o arquivo .env com suas configurações
```

5. **Execute o setup inicial**
```bash
npm run setup
# ou com dados demo
npm run setup -- --with-demo
```

6. **Inicie o servidor**
```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

## ⚙️ Configuração

### Variáveis de Ambiente (.env)

```bash
# Servidor
NODE_ENV=development
PORT=5000

# Banco de dados
DB_HOST=localhost
DB_PORT=3306
DB_NAME=forexai_trading
DB_USER=root
DB_PASSWORD=sua_senha

# JWT
JWT_SECRET=