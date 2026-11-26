// Customer Authentication & Gmail OTP Verification Routes - routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { getDb } = require('../lib/db');
const { sendVerificationCodeEmail, sendPasswordResetEmail } = require('../lib/mailer');
const { syncDoc, syncTotalsToFirebase } = require('../lib/firebase');

function normalizeBdPhone(phone) {
  let cleaned = String(phone || '').replace(/[\s-]/g, '');
  if (cleaned.startsWith('+880')) cleaned = '0' + cleaned.slice(4);
  else if (cleaned.startsWith('880')) cleaned = '0' + cleaned.slice(3);
  return cleaned;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email || '',
    email_verified: Boolean(user.email_verified),
    district: user.district || '',
    address: user.address || '',
    status: user.status,
    created_at: user.created_at
  };
}

function syncUserToFirebase(db, user) {
  if (!user) return;
  syncDoc(
    db,
    'users',
    user.id,
    {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email || '',
      email_verified: Boolean(user.email_verified),
      district: user.district || '',
      address: user.address || '',
      status: user.status,
      created_at: user.created_at,
      last_login: user.last_login || null
    },
    true
  ).catch(() => {});
}

async function issueEmailOtp(db, user) {
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = bcrypt.hashSync(code, 8);
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes

  db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);
  db.prepare(`
    INSERT INTO email_verifications (user_id, email, code_hash, attempts, expires_at, last_sent_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(user.id, user.email, codeHash, expiresAt, now);

  const mailRes = await sendVerificationCodeEmail(db, {
    toEmail: user.email,
    name: user.name,
    code
  });

  return {
    demoMode: Boolean(mailRes.demoMode),
    demoCode: mailRes.demoMode ? code : undefined
  };
}

const requireUser = (req, res, next) => {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'অনুগ্রহ করে আগে লগইন করুন' });
};

// Step 1: Register and send 6-digit verification code to Gmail/Email
router.post('/register', async (req, res) => {
  const db = getDb();
  const { name, phone, email, password, district, address } = req.body;

  const cleanName = String(name || '').trim();
  const cleanPhone = normalizeBdPhone(phone);
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '');
  const cleanDistrict = String(district || '').trim() || null;
  const cleanAddress = String(address || '').trim() || null;

  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({ success: false, message: 'আপনার পূর্ণ নাম দিন' });
  }
  if (!/^01[3-9]\d{8}$/.test(cleanPhone)) {
    return res.status(400).json({ success: false, message: 'সঠিক ১১ সংখ্যার মোবাইল নম্বর দিন (01XXXXXXXXX)' });
  }
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return res.status(400).json({ success: false, message: 'সঠিক জিমেইল / ইমেইল ঠিকানা দিন (যেমন: name@gmail.com)' });
  }
  if (cleanPass.length < 6) {
    return res.status(400).json({ success: false, message: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
  }

  const byPhone = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);
  if (byPhone && byPhone.email_verified) {
    return res.status(400).json({ success: false, message: 'এই মোবাইল নম্বরে ইতিমধ্যেই ভেরিফাইড অ্যাকাউন্ট রয়েছে। অনুগ্রহ করে লগইন করুন।' });
  }

  const byEmail = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  if (byEmail && byEmail.email_verified) {
    return res.status(400).json({ success: false, message: 'এই জিমেইলে ইতিমধ্যেই ভেরিফাইড অ্যাকাউন্ট রয়েছে। অনুগ্রহ করে লগইন করুন।' });
  }

  const hashed = bcrypt.hashSync(cleanPass, 10);

  let user;
  const tx = db.transaction(() => {
    const existingPending = byEmail || byPhone;
    if (existingPending && !existingPending.email_verified) {
      db.prepare(`
        UPDATE users SET name = ?, phone = ?, email = ?, password = ?, district = ?, address = ?
        WHERE id = ?
      `).run(cleanName, cleanPhone, cleanEmail, hashed, cleanDistrict, cleanAddress, existingPending.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(existingPending.id);
    }

    const resUser = db
      .prepare(`
        INSERT INTO users (name, phone, email, email_verified, password, district, address)
        VALUES (?, ?, ?, 0, ?, ?, ?)
      `)
      .run(cleanName, cleanPhone, cleanEmail, hashed, cleanDistrict, cleanAddress);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(resUser.lastInsertRowid);
  });

  try {
    user = tx();
    const otpMeta = await issueEmailOtp(db, user);
    syncUserToFirebase(db, user);

    return res.json({
      success: true,
      requiresVerification: true,
      email: user.email,
      message: otpMeta.demoMode
        ? 'ভেরিফিকেশন কোড তৈরি হয়েছে (SMTP স্যান্ডবক্স মোড)। নিচে কোড দিয়ে কনফার্ম করুন।'
        : `আপনার ${user.email} ঠিকানায় ৬-সংখ্যার একটি কোড পাঠানো হয়েছে। কোডটি বসিয়ে কনফার্ম করুন।`,
      ...otpMeta
    });
  } catch (err) {
    console.error('Register / OTP error:', err.message);
    return res.status(500).json({
      success: false,
      message: `ইমেইল পাঠাতে সমস্যা হয়েছে: ${err.message}`
    });
  }
});

// Step 2: Verify 6-digit Gmail OTP code & activate session
router.post('/verify-email', (req, res) => {
  const db = getDb();
  const cleanEmail = String(req.body.email || '').trim().toLowerCase();
  const cleanCode = String(req.body.code || '').trim();

  if (!cleanEmail || !/^\d{6}$/.test(cleanCode)) {
    return res.status(400).json({ success: false, message: 'ইমেইল এবং ৬-সংখ্যার কোড দিন' });
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  if (!user) {
    return res.status(404).json({ success: false, message: 'অ্যাকাউন্ট পাওয়া যায়নি' });
  }

  if (user.email_verified) {
    req.session.user = sanitizeUser(user);
    return res.json({ success: true, message: 'ইমেইল ইতিমধ্যেই ভেরিফাইড!', user: req.session.user });
  }

  const ver = db.prepare('SELECT * FROM email_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
  if (!ver) {
    return res.status(400).json({ success: false, message: 'কোনো ভেরিফিকেশন কোড পাওয়া যায়নি। নতুন কোড পাঠান।' });
  }

  if (Date.now() > ver.expires_at) {
    return res.status(400).json({ success: false, message: 'কোডের মেয়াদ শেষ হয়েছে। অনুগ্রহ করে নতুন কোড পাঠান।' });
  }

  if (ver.attempts >= 5) {
    return res.status(429).json({ success: false, message: 'অনেকবার ভুল কোড দেওয়া হয়েছে। অনুগ্রহ করে নতুন কোড পাঠান।' });
  }

  if (!bcrypt.compareSync(cleanCode, ver.code_hash)) {
    db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?').run(ver.id);
    return res.status(400).json({ success: false, message: 'ভুল কোড! অনুগ্রহ করে ইমেইলের ৬-সংখ্যার কোডটি যাচাই করুন।' });
  }

  const verifiedUser = db.transaction(() => {
    db.prepare('UPDATE users SET email_verified = 1, last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);

    const existingCust = db.prepare('SELECT id FROM customers WHERE phone = ?').get(user.phone);
    if (!existingCust) {
      db.prepare('INSERT INTO customers (name, email, phone, address, district) VALUES (?, ?, ?, ?, ?)')
        .run(user.name, user.email, user.phone, user.address, user.district);
    }

    db.prepare('UPDATE orders SET user_id = ? WHERE customer_phone = ? AND user_id IS NULL')
      .run(user.id, user.phone);

    return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  })();

  req.session.user = sanitizeUser(verifiedUser);
  syncUserToFirebase(db, verifiedUser);

  res.json({
    success: true,
    message: 'ইমেইল কনফার্ম হয়েছে! আপনার অ্যাকাউন্ট তৈরি সম্পন্ন।',
    user: req.session.user
  });
});

// Resend 6-digit Gmail OTP code
router.post('/resend-code', async (req, res) => {
  const db = getDb();
  const cleanEmail = String(req.body.email || '').trim().toLowerCase();
  if (!cleanEmail) {
    return res.status(400).json({ success: false, message: 'ইমেইল ঠিকানা দিন' });
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  if (!user) {
    return res.status(404).json({ success: false, message: 'অ্যাকাউন্ট পাওয়া যায়নি' });
  }
  if (user.email_verified) {
    return res.json({ success: true, alreadyVerified: true, message: 'ইমেইল ইতিমধ্যেই ভেরিফাইড! লগইন করুন।' });
  }

  const last = db.prepare('SELECT last_sent_at FROM email_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
  if (last && Date.now() - last.last_sent_at < 30 * 1000) {
    const wait = Math.ceil((30 * 1000 - (Date.now() - last.last_sent_at)) / 1000);
    return res.status(429).json({ success: false, message: `দয়া করে ${wait} সেকেন্ড পর আবার চেষ্টা করুন।` });
  }

  try {
    const otpMeta = await issueEmailOtp(db, user);
    res.json({
      success: true,
      message: otpMeta.demoMode
        ? 'নতুন কোড তৈরি হয়েছে (স্যান্ডবক্স মোড)।'
        : `আপনার ${user.email} ঠিকানায় নতুন কোড পাঠানো হয়েছে।`,
      ...otpMeta
    });
  } catch (err) {
    res.status(500).json({ success: false, message: `ইমেইল পাঠানো যায়নি: ${err.message}` });
  }
});

// Step 3: Request Forgot Password OTP
router.post('/forgot-password', async (req, res) => {
  const db = getDb();
  const { identifier } = req.body;
  const rawIdent = String(identifier || '').trim();

  if (!rawIdent) {
    return res.status(400).json({ success: false, message: 'আপনার নিবন্ধিত ইমেইল বা মোবাইল নম্বর দিন' });
  }

  const normalizedPhone = normalizeBdPhone(rawIdent);
  const user = db
    .prepare('SELECT * FROM users WHERE phone = ? OR LOWER(email) = LOWER(?)')
    .get(normalizedPhone, rawIdent);

  if (!user) {
    return res.status(404).json({ success: false, message: 'এই ইমেইল বা মোবাইল নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি' });
  }

  if (!user.email) {
    return res.status(400).json({ success: false, message: 'এই অ্যাকাউন্টে কোনো ইমেইল যুক্ত নেই। অনুগ্রহ করে কাস্টমার সাপোর্টে যোগাযোগ করুন।' });
  }

  const last = db.prepare('SELECT last_sent_at FROM email_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
  if (last && Date.now() - last.last_sent_at < 30 * 1000) {
    const wait = Math.ceil((30 * 1000 - (Date.now() - last.last_sent_at)) / 1000);
    return res.status(429).json({ success: false, message: `দয়া করে ${wait} সেকেন্ড পর আবার চেষ্টা করুন।` });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = bcrypt.hashSync(code, 8);
  const now = Date.now();
  const expiresAt = now + 15 * 60 * 1000; // 15 mins

  db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);
  db.prepare(`
    INSERT INTO email_verifications (user_id, email, code_hash, attempts, expires_at, last_sent_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(user.id, user.email, codeHash, expiresAt, now);

  const mailRes = await sendPasswordResetEmail(db, {
    toEmail: user.email,
    name: user.name,
    code
  });

  return res.json({
    success: true,
    email: user.email,
    message: mailRes.demoMode
      ? `পাসওয়ার্ড রিসেট কোড তৈরি হয়েছে (স্যান্ডবক্স মোড: ${code})`
      : `আপনার ${user.email} ঠিকানায় ৬-সংখ্যার পাসওয়ার্ড রিসেট কোড পাঠানো হয়েছে।`,
    demoMode: Boolean(mailRes.demoMode),
    demoCode: mailRes.demoMode ? code : undefined
  });
});

// Step 4: Reset Password with OTP Code
router.post('/reset-password', async (req, res) => {
  const db = getDb();
  const { email, code, new_password } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanCode = String(code || '').trim();
  const cleanPass = String(new_password || '').trim();

  if (!cleanEmail || !cleanCode || !cleanPass) {
    return res.status(400).json({ success: false, message: 'ইমেইল, কোড এবং নতুন পাসওয়ার্ড দিন' });
  }

  if (cleanPass.length < 6) {
    return res.status(400).json({ success: false, message: 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  if (!user) {
    return res.status(404).json({ success: false, message: 'ইউজার পাওয়া যায়নি' });
  }

  const record = db
    .prepare('SELECT * FROM email_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(user.id);

  if (!record) {
    return res.status(400).json({ success: false, message: 'কোনো সক্রিয় রিসেট কোড পাওয়া যায়নি। আবার কোড পাঠান।' });
  }

  if (Date.now() > record.expires_at) {
    db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);
    return res.status(400).json({ success: false, message: 'কোডের মেয়াদ শেষ হয়ে গেছে। নতুন কোড পাঠান।' });
  }

  if (record.attempts >= 5) {
    db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);
    return res.status(429).json({ success: false, message: 'অনেকবার ভুল কোড দেওয়া হয়েছে। নতুন কোড চেয়ে নিন।' });
  }

  const matches = bcrypt.compareSync(cleanCode, record.code_hash);
  if (!matches) {
    db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?').run(record.id);
    return res.status(400).json({ success: false, message: 'ভুল সিকিউরিটি কোড' });
  }

  const hashedPassword = bcrypt.hashSync(cleanPass, 10);
  db.prepare('UPDATE users SET password = ?, email_verified = 1 WHERE id = ?').run(hashedPassword, user.id);
  db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);

  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  syncUserToFirebase(db, updatedUser);

  res.json({
    success: true,
    message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে! এখন লগইন করুন।'
  });
});

// Login customer
router.post('/login', async (req, res) => {
  const db = getDb();
  const { identifier, password } = req.body;
  const rawIdent = String(identifier || '').trim();
  const cleanPass = String(password || '');

  if (!rawIdent || !cleanPass) {
    return res.status(400).json({ success: false, message: 'মোবাইল নম্বর/জিমেইল এবং পাসওয়ার্ড দিন' });
  }

  const normalizedPhone = normalizeBdPhone(rawIdent);
  const user = db
    .prepare('SELECT * FROM users WHERE phone = ? OR LOWER(email) = LOWER(?)')
    .get(normalizedPhone, rawIdent);

  if (!user || !bcrypt.compareSync(cleanPass, user.password)) {
    return res.status(401).json({ success: false, message: 'মোবাইল নম্বর/ইমেইল বা পাসওয়ার্ড ভুল' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ success: false, message: 'আপনার অ্যাকাউন্ট সাময়িকভাবে স্থগিত করা হয়েছে' });
  }

  if (!user.email_verified) {
    const activeOtp = db
      .prepare('SELECT id FROM email_verifications WHERE user_id = ? AND expires_at > ? AND attempts < 5 ORDER BY id DESC LIMIT 1')
      .get(user.id, Date.now());

    if (activeOtp) {
      return res.status(403).json({
        success: false,
        needsVerification: true,
        email: user.email,
        message: 'আপনার জিমেইল এখনও কনফার্ম করা হয়নি। ইমেইলে পাঠানো ৬-সংখ্যার কোডটি দিন অথবা নতুন কোড পাঠান।'
      });
    }

    try {
      const otpMeta = await issueEmailOtp(db, user);
      return res.status(403).json({
        success: false,
        needsVerification: true,
        email: user.email,
        message: 'আপনার জিমেইল এখনও কনফার্ম করা হয়নি। ইমেইলে পাঠানো ৬-সংখ্যার কোডটি দিন।',
        ...otpMeta
      });
    } catch (err) {
      return res.status(403).json({
        success: false,
        needsVerification: true,
        email: user.email,
        message: 'ইমেইল ভেরিফিকেশন বাকি আছে।'
      });
    }
  }

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  req.session.user = sanitizeUser(updated);
  syncUserToFirebase(db, updated);

  res.json({
    success: true,
    message: 'লগইন সফল হয়েছে!',
    user: req.session.user
  });
});

// Logout customer
router.post('/logout', (req, res) => {
  if (req.session) {
    delete req.session.user;
  }
  res.json({ success: true, message: 'লগআউট হয়েছে' });
});

// Get current logged-in user
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.json({ success: true, user: null });
  }
  const db = getDb();
  const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!freshUser || freshUser.status !== 'active' || !freshUser.email_verified) {
    delete req.session.user;
    return res.json({ success: true, user: null });
  }
  req.session.user = sanitizeUser(freshUser);
  res.json({ success: true, user: req.session.user });
});

// Update profile
router.put('/profile', requireUser, (req, res) => {
  const db = getDb();
  const cleanName = String(req.body.name || '').trim();
  const cleanDistrict = String(req.body.district || '').trim() || null;
  const cleanAddress = String(req.body.address || '').trim() || null;

  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({ success: false, message: 'সঠিক নাম দিন' });
  }

  db.prepare('UPDATE users SET name = ?, district = ?, address = ? WHERE id = ?')
    .run(cleanName, cleanDistrict, cleanAddress, req.session.user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  req.session.user = sanitizeUser(updated);
  syncUserToFirebase(db, updated);

  res.json({ success: true, message: 'প্রোফাইল আপডেট হয়েছে', user: req.session.user });
});

// Change password
router.post('/change-password', requireUser, (req, res) => {
  const db = getDb();
  const { current_password, new_password } = req.body;
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ success: false, message: 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !bcrypt.compareSync(String(current_password || ''), user.password)) {
    return res.status(400).json({ success: false, message: 'বর্তমান পাসওয়ার্ড ভুল' });
  }

  const hashed = bcrypt.hashSync(String(new_password), 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, user.id);
  res.json({ success: true, message: 'পাসওয়ার্ড পরিবর্তন হয়েছে!' });
});

// Get logged-in user's orders with KPI summary
router.get('/orders', requireUser, (req, res) => {
  const db = getDb();
  const orders = db
    .prepare(`
      SELECT * FROM orders
      WHERE user_id = ? OR customer_phone = ?
      ORDER BY created_at DESC
    `)
    .all(req.session.user.id, req.session.user.phone)
    .map((o) => ({
      ...o,
      items: JSON.parse(o.items || '[]')
    }));

  const totalOrders = orders.length;
  const pendingOrders = orders.filter((o) => o.order_status === 'pending').length;
  const confirmedOrders = orders.filter((o) => o.order_status === 'confirmed').length;
  const processingOrders = orders.filter((o) => o.order_status === 'processing').length;
  const shippedOrders = orders.filter((o) => o.order_status === 'shipped').length;
  const deliveredOrders = orders.filter((o) => o.order_status === 'delivered').length;
  const cancelledOrders = orders.filter((o) => o.order_status === 'cancelled').length;
  const totalSpent = orders
    .filter((o) => o.order_status !== 'cancelled')
    .reduce((sum, o) => sum + (Number(o.total) || 0), 0);

  const summary = {
    totalOrders,
    pendingOrders,
    confirmedOrders,
    processingOrders,
    shippedOrders,
    deliveredOrders,
    cancelledOrders,
    totalSpent
  };

  res.json({ success: true, orders, summary });
});

// ================= ADDRESS BOOK API =================
// List user addresses
router.get('/addresses', requireUser, (req, res) => {
  const db = getDb();
  const addresses = db
    .prepare('SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC')
    .all(req.session.user.id);
  res.json({ success: true, addresses });
});

// Add address to Address Book
router.post('/addresses', requireUser, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const title = String(req.body.title || 'Home').trim();
  const recipient_name = String(req.body.recipient_name || req.session.user.name || '').trim();
  const recipient_phone = String(req.body.recipient_phone || req.session.user.phone || '').trim();
  const district = String(req.body.district || '').trim();
  const thana = String(req.body.thana || '').trim();
  const address = String(req.body.address || '').trim();
  let is_default = req.body.is_default ? 1 : 0;

  if (!recipient_name || !recipient_phone || !district || !address) {
    return res.status(400).json({ success: false, message: 'প্রাপকের নাম, ফোন, জেলা ও ঠিকানা আবশ্যক' });
  }

  const existingCount = db.prepare('SELECT COUNT(*) as count FROM user_addresses WHERE user_id = ?').get(userId).count;
  if (existingCount === 0) {
    is_default = 1;
  }

  if (is_default === 1) {
    db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE users SET district = ?, address = ? WHERE id = ?').run(district, address, userId);
  }

  const result = db.prepare(`
    INSERT INTO user_addresses (user_id, title, recipient_name, recipient_phone, district, thana, address, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, title, recipient_name, recipient_phone, district, thana, address, is_default);

  const inserted = db.prepare('SELECT * FROM user_addresses WHERE id = ?').get(result.lastInsertRowid);
  res.json({ success: true, message: 'ঠিকানা সফলভাবে সংরক্ষণ করা হয়েছে', address: inserted });
});

// Update address in Address Book
router.put('/addresses/:id', requireUser, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const addrId = req.params.id;

  const existing = db.prepare('SELECT * FROM user_addresses WHERE id = ? AND user_id = ?').get(addrId, userId);
  if (!existing) {
    return res.status(404).json({ success: false, message: 'ঠিকানা পাওয়া যায়নি' });
  }

  const title = String(req.body.title || existing.title || 'Home').trim();
  const recipient_name = String(req.body.recipient_name || existing.recipient_name).trim();
  const recipient_phone = String(req.body.recipient_phone || existing.recipient_phone).trim();
  const district = String(req.body.district || existing.district).trim();
  const thana = String(req.body.thana || '').trim();
  const address = String(req.body.address || existing.address).trim();
  let is_default = req.body.is_default !== undefined ? (req.body.is_default ? 1 : 0) : existing.is_default;

  if (!recipient_name || !recipient_phone || !district || !address) {
    return res.status(400).json({ success: false, message: 'প্রাপকের নাম, ফোন, জেলা ও ঠিকানা আবশ্যক' });
  }

  if (is_default === 1) {
    db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE users SET district = ?, address = ? WHERE id = ?').run(district, address, userId);
  }

  db.prepare(`
    UPDATE user_addresses
    SET title = ?, recipient_name = ?, recipient_phone = ?, district = ?, thana = ?, address = ?, is_default = ?
    WHERE id = ? AND user_id = ?
  `).run(title, recipient_name, recipient_phone, district, thana, address, is_default, addrId, userId);

  const updated = db.prepare('SELECT * FROM user_addresses WHERE id = ?').get(addrId);
  res.json({ success: true, message: 'ঠিকানা আপডেট সম্পন্ন হয়েছে', address: updated });
});

// Set address as default
router.post('/addresses/:id/default', requireUser, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const addrId = req.params.id;

  const addr = db.prepare('SELECT * FROM user_addresses WHERE id = ? AND user_id = ?').get(addrId, userId);
  if (!addr) {
    return res.status(404).json({ success: false, message: 'ঠিকানা পাওয়া যায়নি' });
  }

  db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?').run(userId);
  db.prepare('UPDATE user_addresses SET is_default = 1 WHERE id = ? AND user_id = ?').run(addrId, userId);
  db.prepare('UPDATE users SET district = ?, address = ? WHERE id = ?').run(addr.district, addr.address, userId);

  res.json({ success: true, message: 'ডিফল্ট ডেলিভারি ঠিকানা হিসেবে সেট করা হয়েছে' });
});

// Delete address
router.delete('/addresses/:id', requireUser, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const addrId = req.params.id;

  const addr = db.prepare('SELECT * FROM user_addresses WHERE id = ? AND user_id = ?').get(addrId, userId);
  if (!addr) {
    return res.status(404).json({ success: false, message: 'ঠিকানা পাওয়া যায়নি' });
  }

  db.prepare('DELETE FROM user_addresses WHERE id = ? AND user_id = ?').run(addrId, userId);

  // If deleted was default, make another one default
  if (addr.is_default) {
    const nextAddr = db.prepare('SELECT id, district, address FROM user_addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
    if (nextAddr) {
      db.prepare('UPDATE user_addresses SET is_default = 1 WHERE id = ?').run(nextAddr.id);
      db.prepare('UPDATE users SET district = ?, address = ? WHERE id = ?').run(nextAddr.district, nextAddr.address, userId);
    }
  }

  res.json({ success: true, message: 'ঠিকানা মুছে ফেলা হয়েছে' });
});

module.exports = router;
