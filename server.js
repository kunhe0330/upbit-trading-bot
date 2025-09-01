  const express = require('express');
  const jwt = require('jsonwebtoken');
  const crypto = require('crypto');
  const axios = require('axios');

  const app = express();
  const PORT = process.env.PORT || 8080;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 환경 설정
  const CONFIG = {
    UPBIT_API_URL: 'https://api.upbit.com',
    TRADING_SYMBOL: 'KRW-ETH',
    BUY_PERCENTAGE: 0.1, // 10%
    MIN_ORDER_AMOUNT: 5000,
    DUPLICATE_PREVENTION_HOURS: 1,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000
  };

  // 업비트 API 클래스
  class UpbitAPI {
    constructor() {
      this.accessKey = process.env.UPBIT_ACCESS_KEY;
      this.secretKey = process.env.UPBIT_SECRET_KEY;
      this.baseUrl = CONFIG.UPBIT_API_URL;
    }

    generateJWT(queryHash = null) {
      const payload = {
        access_key: this.accessKey,
        nonce: crypto.randomUUID()
      };

      if (queryHash) {
        payload.query_hash = queryHash;
        payload.query_hash_alg = 'SHA512';
      }

      const token = jwt.sign(payload, this.secretKey, {
        algorithm: 'HS512',
        header: { alg: 'HS512', typ: 'JWT' }
      });

      return `Bearer ${token}`;
    }

    async makeRequest(method, endpoint, params = {}, requiresAuth = false) {
      let url = `${this.baseUrl}${endpoint}`;
      let headers = { 'Content-Type': 'application/json' };
      let data = null;

      if (requiresAuth) {
        let queryString = '';
        let queryHash = null;

        if (Object.keys(params).length > 0) {
          queryString = Object.keys(params)
            .map(key => `${key}=${encodeURIComponent(params[key])}`)
            .join('&');

          if (method === 'GET') {
            url += `?${queryString}`;
          } else {
            data = params;
          }

          if (queryString) {
            queryHash = crypto.createHash('sha512').update(queryString).digest('hex');
          }
        }

        headers['Authorization'] = this.generateJWT(queryHash);
      } else if (method === 'GET' && Object.keys(params).length > 0) {
        const queryString = Object.keys(params)
          .map(key => `${key}=${encodeURIComponent(params[key])}`)
          .join('&');
        url += `?${queryString}`;
      }

      try {
        const response = await axios({
          method,
          url,
          headers,
          data
        });

        console.log(`API 요청 성공: ${endpoint}`);
        return response.data;
      } catch (error) {
        console.error(`API 요청 실패: ${endpoint}`, error.response?.data || error.message);
        throw error;
      }
    }

    async getCurrentPrice(market) {
      const data = await this.makeRequest('GET', '/v1/ticker', { markets: market });
      return parseFloat(data[0].trade_price);
    }

    async getAccounts() {
      return await this.makeRequest('GET', '/v1/accounts', {}, true);
    }

    async getKrwBalance() {
      const accounts = await this.getAccounts();
      const krwAccount = accounts.find(account => account.currency === 'KRW');
      return krwAccount ? parseFloat(krwAccount.balance) : 0;
    }

    async placeBuyOrder(market, price) {
      if (price < CONFIG.MIN_ORDER_AMOUNT) {
        throw new Error(`최소 주문 금액 ${CONFIG.MIN_ORDER_AMOUNT}원 이상이어야 합니다.`);
      }

      const orderParams = {
        market: market,
        side: 'bid',
        ord_type: 'price',
        price: price.toString()
      };

      console.log('매수 주문 시작:', { market, price });
      const result = await this.makeRequest('POST', '/v1/orders', orderParams, true);
      console.log('매수 주문 완료:', result);

      return result;
    }

    async getRecentOrders(market, hours = 24) {
      const states = 'done,cancel';
      const orders = await this.makeRequest('GET', '/v1/orders', {
        market,
        states,
        limit: 100
      }, true);

      const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
      return orders.filter(order => {
        const orderTime = new Date(order.created_at);
        return orderTime >= cutoffTime;
      });
    }
  }

  // 매매 엔진 클래스
  class TradingEngine {
    constructor() {
      this.api = new UpbitAPI();
    }

    async executeBuy(webhookData) {
      const executionId = this.generateId();
      console.log('매수 실행 시작:', { executionId, symbol: webhookData.symbol });

      try {
        const krwBalance = await this.api.getKrwBalance();
        console.log('KRW 잔고:', krwBalance);

        const buyAmount = Math.floor(krwBalance * CONFIG.BUY_PERCENTAGE);

        if (buyAmount < CONFIG.MIN_ORDER_AMOUNT) {
          throw new Error(`잔고 부족: ${buyAmount}원 (최소 ${CONFIG.MIN_ORDER_AMOUNT}원)`);
        }

        const isDuplicate = await this.checkDuplicateBuy();
        if (isDuplicate) {
          console.log('중복 매수 방지로 주문 취소');
          return { success: false, reason: '중복 매수 방지' };
        }

        const result = await this.api.placeBuyOrder(CONFIG.TRADING_SYMBOL, buyAmount);

        console.log('매수 완료:', result);
        return { success: true, orderId: result.uuid, amount: buyAmount };

      } catch (error) {
        console.error('매수 실행 실패:', error.message);
        return { success: false, error: error.message };
      }
    }

    async checkDuplicateBuy() {
      try {
        const recentOrders = await this.api.getRecentOrders(
          CONFIG.TRADING_SYMBOL,
          CONFIG.DUPLICATE_PREVENTION_HOURS
        );

        const buyOrders = recentOrders.filter(order =>
          order.side === 'bid' && order.state === 'done'
        );

        return buyOrders.length > 0;
      } catch (error) {
        console.warn('중복 검사 실패:', error.message);
        return false;
      }
    }

    generateId() {
      return crypto.randomBytes(8).toString('hex');
    }
  }

  // 라우트 설정
  app.get('/', (req, res) => {
    res.json({
      status: 'healthy',
      message: 'Upbit ETH Trading Bot is ready',
      timestamp: new Date().toISOString()
    });
  });

  app.post('/', async (req, res) => {
    try {
      const webhookData = req.body;
      console.log('웹훅 수신:', webhookData);

      if (!webhookData || webhookData.action !== 'BUY') {
        return res.status(400).json({ error: '유효하지 않은 매수 신호' });
      }

      const normalizedSymbol = webhookData.symbol?.replace('ETH', '').replace('KRW', '') === 'ETH' ||
                               webhookData.symbol === 'ETHKRW' ? 'KRW-ETH' : null;

      if (!normalizedSymbol) {
        return res.status(400).json({ error: '지원하지 않는 심볼' });
      }

      const engine = new TradingEngine();
      const result = await engine.executeBuy({
        ...webhookData,
        symbol: normalizedSymbol
      });

      res.json({
        success: true,
        result: result,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('웹훅 처리 실패:', error);
      res.status(500).json({
        error: '서버 오류',
        message: error.message
      });
    }
  });

  app.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
  });
