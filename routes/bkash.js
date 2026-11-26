// Bkash Payment Routes - routes/bkash.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const { getDb } = require('../lib/db');
const { syncDoc } = require('../lib/firebase');

let cachedToken = { key: null, token: null, expiry: 0 };

function getBkashConfig(db) {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'bkash_%' OR key = 'shop_name'")
    .all();
  const s = {};
  rows.forEach((r) => {
    s[r.key] = r.value;
  });

  const envMode =
    s.bkash_env ||
    (process.env.BKASH_BASE_URL && !process.env.BKASH_BASE_URL.includes('sandbox')
      ? 'production'
      : 'sandbox');

  const baseUrl =
    envMode === 'production'
      ? 'https://tokenized.pay.bka.sh/v1.2.0-beta'
      : s.bkash_env === 'sandbox'
      ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'
      : process.env.BKASH_BASE_URL || 'https://tokenized.sandbox.bka.sh/v1.2.0-beta';

  const appKey = (s.bkash_app_key || process.env.BKASH_APP_KEY || '').trim();
  const appSecret = (s.bkash_app_secret || process.env.BKASH_APP_SECRET || '').trim();
  const username = (s.bkash_username || process.env.BKASH_USERNAME || '').trim();
  const password = (s.bkash_password || process.env.BKASH_PASSWORD || '').trim();
  const mode = s.bkash_mode || 'auto'; // 'auto' | 'live' | 'demo'

  const hasRealKeys = Boolean(
    appKey &&
      appKey !== 'your_bkash_app_key_here' &&
      appSecret &&
      appSecret !== 'your_bkash_app_secret_here' &&
      username &&
      username !== 'your_bkash_username_here' &&
      password &&
      password !== 'your_bkash_password_here'
  );

  return {
    baseUrl,
    envMode,
    appKey,
    appSecret,
    username,
    password,
    mode,
    hasRealKeys,
    shopName: s.shop_name || 'লুঙ্গি ঘর'
  };
}

async function getBkashToken(cfg, forceRefresh = false) {
  const cacheKey = `${cfg.baseUrl}|${cfg.appKey}|${cfg.username}`;
  if (!forceRefresh && cachedToken.token && cachedToken.key === cacheKey && Date.now() < cachedToken.expiry) {
    return cachedToken.token;
  }

  try {
    const response = await axios.post(
      `${cfg.baseUrl}/tokenized/checkout/token/grant`,
      { app_key: cfg.appKey, app_secret: cfg.appSecret },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          username: cfg.username,
          password: cfg.password
        },
        timeout: 20000
      }
    );

    if (!response.data || !response.data.id_token) {
      throw new Error(response.data?.statusMessage || 'বিকাশ টোকেন পাওয়া যায়নি');
    }

    cachedToken = {
      key: cacheKey,
      token: response.data.id_token,
      expiry: Date.now() + 50 * 60 * 1000 // refresh before 1hr expiry
    };
    return cachedToken.token;
  } catch (error) {
    cachedToken = { key: null, token: null, expiry: 0 };
    console.error('Bkash token error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.statusMessage || 'বিকাশ সংযোগ ব্যর্থ হয়েছে');
  }
}

function finalizeSuccessfulPayment(db, paymentID, trxID, rawPayload) {
  const tx = db.transaction(() => {
    const paymentRecord = db.prepare('SELECT * FROM bkash_payments WHERE payment_id = ?').get(paymentID);
    if (!paymentRecord) return null;

    if (paymentRecord.status !== 'completed') {
      db.prepare(`
        UPDATE bkash_payments
        SET transaction_id = ?, status = 'completed', raw_response = ?
        WHERE payment_id = ?
      `).run(trxID, JSON.stringify(rawPayload), paymentID);

      db.prepare(`
        UPDATE orders
        SET payment_status = 'paid',
            order_status = CASE WHEN order_status = 'pending' THEN 'confirmed' ELSE order_status END,
            bkash_transaction_id = ?,
            bkash_payment_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(trxID, paymentID, paymentRecord.order_id);
    }

    return db.prepare('SELECT * FROM orders WHERE id = ?').get(paymentRecord.order_id);
  });

  const updatedOrder = tx();
  if (updatedOrder) {
    syncDoc(
      db,
      'orders',
      updatedOrder.order_number,
      {
        payment_status: updatedOrder.payment_status,
        order_status: updatedOrder.order_status,
        bkash_transaction_id: updatedOrder.bkash_transaction_id || '',
        bkash_payment_id: updatedOrder.bkash_payment_id || '',
        updated_at: new Date().toISOString()
      },
      true
    ).catch(() => {});
  }
  return updatedOrder;
}

// Create Bkash Payment
router.post('/create-payment', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, requireAuth: true, message: 'অনুগ্রহ করে আগে লগইন করুন' });
  }

  const db = getDb();
  const { order_id, order_number } = req.body;

  if (!order_id && !order_number) {
    return res.status(400).json({ success: false, message: 'অর্ডার তথ্য অসম্পূর্ণ' });
  }

  const order = order_id
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id)
    : db.prepare('SELECT * FROM orders WHERE order_number = ?').get(order_number);

  if (!order) {
    return res.status(404).json({ success: false, message: 'অর্ডার পাওয়া যায়নি' });
  }

  if (order.user_id && order.user_id !== req.session.user.id) {
    return res.status(403).json({ success: false, message: 'অননুমোদিত অর্ডার অ্যাক্সেস' });
  }

  if (order.payment_status === 'paid') {
    return res.json({
      success: true,
      alreadyPaid: true,
      bkashURL: `/order-success?order=${encodeURIComponent(order.order_number)}&payment=bkash`
    });
  }

  const cfg = getBkashConfig(db);
  const useDemo = cfg.mode === 'demo' || (cfg.mode === 'auto' && !cfg.hasRealKeys);

  if (cfg.mode === 'live' && !cfg.hasRealKeys) {
    return res.json({
      success: false,
      message: 'বিকাশ লাইভ পেমেন্টের জন্য অ্যাডমিন সেটিংসে App Key, App Secret, Username ও Password দিন।'
    });
  }

  if (useDemo) {
    const demoPaymentId = 'DEMO_PAY_' + Date.now() + '_' + Math.floor(100 + Math.random() * 900);
    db.prepare(`
      INSERT INTO bkash_payments (order_id, payment_id, amount, status)
      VALUES (?, ?, ?, 'created')
    `).run(order.id, demoPaymentId, order.total);

    return res.json({
      success: true,
      demo: true,
      paymentID: demoPaymentId,
      bkashURL: `/bkash/demo-checkout?paymentID=${encodeURIComponent(demoPaymentId)}`
    });
  }

  try {
    const token = await getBkashToken(cfg);
    const amountStr = Number(order.total).toFixed(2).replace(/\.00$/, '');
    const callbackURL = `${req.protocol}://${req.get('host')}/bkash/callback`;

    const response = await axios.post(
      `${cfg.baseUrl}/tokenized/checkout/create`,
      {
        mode: '0011',
        payerReference: order.customer_phone || `customer_${order.id}`,
        callbackURL,
        amount: amountStr,
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: order.order_number
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: token,
          'X-APP-Key': cfg.appKey
        },
        timeout: 30000
      }
    );

    if (response.data && response.data.statusCode === '0000' && response.data.bkashURL) {
      db.prepare(`
        INSERT INTO bkash_payments (order_id, payment_id, amount, status, raw_response)
        VALUES (?, ?, ?, 'created', ?)
      `).run(order.id, response.data.paymentID, order.total, JSON.stringify(response.data));

      return res.json({
        success: true,
        bkashURL: response.data.bkashURL,
        paymentID: response.data.paymentID
      });
    }

    return res.json({
      success: false,
      message: response.data?.statusMessage || 'বিকাশ পেমেন্ট তৈরি ব্যর্থ হয়েছে'
    });
  } catch (error) {
    console.error('Bkash create payment error:', error.response?.data || error.message);
    return res.json({
      success: false,
      message: error.response?.data?.statusMessage || 'বিকাশ সংযোগ সমস্যা হয়েছে'
    });
  }
});

// Real Bkash Callback
router.get('/callback', async (req, res) => {
  const db = getDb();
  const { paymentID, status } = req.query;

  let orderNumber = '';
  if (paymentID) {
    const rec = db.prepare(`
      SELECT o.order_number, bp.status as pay_status
      FROM bkash_payments bp
      JOIN orders o ON o.id = bp.order_id
      WHERE bp.payment_id = ?
    `).get(paymentID);
    if (rec) {
      orderNumber = rec.order_number;
      if (rec.pay_status === 'completed') {
        return res.redirect(`/order-success?order=${encodeURIComponent(orderNumber)}&payment=bkash`);
      }
    }
  }

  if (status === 'cancel' || status === 'failure') {
    if (paymentID) {
      db.prepare('UPDATE bkash_payments SET status = ? WHERE payment_id = ?').run(status, paymentID);
    }
    return res.redirect(`/checkout?payment=${encodeURIComponent(status)}&order=${encodeURIComponent(orderNumber)}`);
  }

  if (status === 'success' && paymentID) {
    const cfg = getBkashConfig(db);
    try {
      const token = await getBkashToken(cfg);
      let execData = null;

      try {
        const response = await axios.post(
          `${cfg.baseUrl}/tokenized/checkout/execute`,
          { paymentID },
          {
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: token,
              'X-APP-Key': cfg.appKey
            },
            timeout: 30000
          }
        );
        execData = response.data;
      } catch (execErr) {
        console.warn('Execute failed, querying payment status:', execErr.message);
        const queryResp = await axios.post(
          `${cfg.baseUrl}/tokenized/checkout/payment/status`,
          { paymentID },
          {
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: token,
              'X-APP-Key': cfg.appKey
            },
            timeout: 20000
          }
        );
        execData = queryResp.data;
      }

      if (
        execData &&
        execData.statusCode === '0000' &&
        (!execData.transactionStatus || execData.transactionStatus === 'Completed')
      ) {
        const order = finalizeSuccessfulPayment(db, paymentID, execData.trxID || paymentID, execData);
        if (order) {
          return res.redirect(`/order-success?order=${encodeURIComponent(order.order_number)}&payment=bkash`);
        }
      }

      db.prepare('UPDATE bkash_payments SET status = ?, raw_response = ? WHERE payment_id = ?').run(
        'failed',
        JSON.stringify(execData || {}),
        paymentID
      );
    } catch (error) {
      console.error('Bkash execute error:', error.response?.data || error.message);
    }
  }

  return res.redirect(`/checkout?payment=failed&order=${encodeURIComponent(orderNumber)}`);
});

// Demo Checkout UI & Handlers
router.get('/demo-checkout', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'bkash-demo.html'));
});

router.get('/demo-info', (req, res) => {
  const db = getDb();
  const { paymentID } = req.query;
  if (!paymentID) return res.json({ success: false, message: 'Payment ID নেই' });

  const row = db.prepare(`
    SELECT bp.amount, bp.status, o.order_number
    FROM bkash_payments bp
    JOIN orders o ON o.id = bp.order_id
    WHERE bp.payment_id = ?
  `).get(paymentID);

  if (!row) return res.json({ success: false, message: 'পেমেন্ট সেশন পাওয়া যায়নি' });

  const cfg = getBkashConfig(db);
  return res.json({
    success: true,
    shop_name: cfg.shopName,
    order_number: row.order_number,
    amount: row.amount,
    status: row.status
  });
});

router.get('/demo-callback', (req, res) => {
  const db = getDb();
  const { paymentID, status } = req.query;

  const row = paymentID
    ? db.prepare(`
        SELECT bp.*, o.order_number
        FROM bkash_payments bp
        JOIN orders o ON o.id = bp.order_id
        WHERE bp.payment_id = ?
      `).get(paymentID)
    : null;

  if (!row) {
    return res.redirect('/checkout?payment=failed');
  }

  if (status === 'success') {
    const demoTrx = 'DEMO' + Date.now().toString().slice(-8);
    const order = finalizeSuccessfulPayment(db, paymentID, demoTrx, {
      mode: 'demo',
      paymentID,
      trxID: demoTrx,
      transactionStatus: 'Completed',
      amount: row.amount
    });
    if (order) {
      return res.redirect(`/order-success?order=${encodeURIComponent(order.order_number)}&payment=bkash`);
    }
  }

  db.prepare('UPDATE bkash_payments SET status = ? WHERE payment_id = ?').run('cancelled', paymentID);
  return res.redirect(`/checkout?payment=cancelled&order=${encodeURIComponent(row.order_number)}`);
});

// Query payment status (admin only)
router.post('/query-payment', async (req, res) => {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ success: false, message: 'অননুমোদিত অ্যাক্সেস' });
  }
  const db = getDb();
  const { paymentID } = req.body;
  const cfg = getBkashConfig(db);

  if (!cfg.hasRealKeys) {
    return res.json({ success: false, message: 'বিকাশ রিয়েল API কনফিগার করা নেই' });
  }

  try {
    const token = await getBkashToken(cfg);
    const response = await axios.post(
      `${cfg.baseUrl}/tokenized/checkout/payment/status`,
      { paymentID },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: token,
          'X-APP-Key': cfg.appKey
        },
        timeout: 20000
      }
    );

    res.json({ success: true, data: response.data });
  } catch (error) {
    res.json({ success: false, message: 'পেমেন্ট স্ট্যাটাস পাওয়া যায়নি' });
  }
});

// Test bKash API connection (admin only)
router.post('/test-connection', async (req, res) => {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ success: false, message: 'অননুমোদিত অ্যাক্সেস' });
  }
  const db = getDb();
  const cfg = getBkashConfig(db);

  if (!cfg.hasRealKeys) {
    return res.json({
      success: false,
      message: 'App Key, App Secret, Username এবং Password পূরণ করে সংরক্ষণ করুন।'
    });
  }

  try {
    await getBkashToken(cfg, true);
    res.json({
      success: true,
      message: `✅ বিকাশ (${cfg.envMode === 'production' ? 'Production' : 'Sandbox'}) কানেকশন সফল হয়েছে!`
    });
  } catch (err) {
    res.json({ success: false, message: `❌ ${err.message}` });
  }
});

module.exports = router;
