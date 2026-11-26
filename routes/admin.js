// Admin Routes - routes/admin.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { getDb } = require('../lib/db');
const {
  getFirebaseStatus,
  resetFirebaseCache,
  syncDoc,
  deleteDoc,
  syncTotalsToFirebase,
  testFirebaseConnection,
  syncAllToFirestore,
  getFirebaseTotals
} = require('../lib/firebase');
const { getEmailConfig, sendTestEmail } = require('../lib/mailer');

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'public', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('শুধুমাত্র ছবি আপলোড করা যাবে'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

function makeSlug(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[^\u0980-\u09FFa-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
  return (cleaned || 'item') + '-' + Date.now();
}

// Auth & Permissions middleware
function hasPermission(admin, requiredPerm) {
  if (!admin) return false;
  if (admin.role === 'super_admin') return true;
  const perms = Array.isArray(admin.permissions) ? admin.permissions : [];
  if (perms.includes('all')) return true;
  return perms.includes(requiredPerm);
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.session || !req.session.admin) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'অননুমোদিত অ্যাক্সেস' });
      return res.redirect('/admin/login');
    }
    if (hasPermission(req.session.admin, perm)) {
      return next();
    }
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({
        success: false,
        message: 'এই অ্যাকশনটির জন্য আপনার প্রয়োজনীয় পারমিশন নেই'
      });
    }
    return res.redirect('/admin/dashboard?error=unauthorized');
  };
}

const requireAuth = (req, res, next) => {
  if (req.path === '/login' || req.path === '/login-action') {
    return next();
  }
  if (req.session && req.session.admin) {
    try {
      const db = getDb();
      const current = db.prepare('SELECT id, username, name, role, permissions, status FROM admins WHERE id = ?').get(req.session.admin.id);
      if (!current || current.status === 'suspended') {
        delete req.session.admin;
        if (req.path.startsWith('/api/')) return res.status(403).json({ success: false, suspended: true, message: 'আপনার অ্যাকাউন্ট স্থগিত করা হয়েছে' });
        return res.redirect('/admin/login?error=suspended');
      }
      req.session.admin.name = current.name;
      req.session.admin.role = current.role;
      try {
        req.session.admin.permissions = JSON.parse(current.permissions || '[]');
      } catch (_) {}
    } catch (_) {}
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: 'অননুমোদিত অ্যাক্সেস' });
  }
  return res.redirect('/admin/login');
};

router.use(requireAuth);

router.get('/', (req, res) => {
  res.redirect('/admin/dashboard');
});

// Login page
router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'login.html'));
});

// Login action
router.post('/login-action', (req, res) => {
  const db = getDb();
  const { username, password } = req.body;

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!admin || !bcrypt.compareSync(String(password || ''), admin.password)) {
    return res.json({ success: false, message: 'ভুল ইউজারনেম বা পাসওয়ার্ড' });
  }

  if (admin.status === 'suspended') {
    return res.json({ success: false, message: 'আপনার অ্যাকাউন্ট স্থগিত করা হয়েছে। কর্তৃপক্ষের সাথে যোগাযোগ করুন।' });
  }

  let permissions = ['all'];
  try {
    permissions = JSON.parse(admin.permissions || '["all"]');
  } catch (_) {
    permissions = ['all'];
  }

  try {
    db.prepare('UPDATE admins SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(admin.id);
  } catch (_) {}

  req.session.admin = {
    id: admin.id,
    username: admin.username,
    name: admin.name,
    role: admin.role || (admin.id === 1 ? 'super_admin' : 'admin'),
    permissions: permissions
  };
  res.json({ success: true, message: 'লগইন সফল!' });
});

// Logout
router.get('/logout', (req, res) => {
  if (req.session) {
    delete req.session.admin;
  }
  res.redirect('/admin/login');
});

// Dashboard
router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'dashboard.html'));
});

// Comprehensive Admin Stats API
router.get('/api/stats', (req, res) => {
  const db = getDb();

  const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
  const pendingOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'pending'").get().count;
  const confirmedOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'confirmed'").get().count;
  const deliveredOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'delivered'").get().count;
  const cancelledOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'cancelled'").get().count;

  const totalRevenue =
    db
      .prepare(
        "SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE order_status != 'cancelled' AND (payment_status = 'paid' OR payment_method = 'cod')"
      )
      .get().sum || 0;

  const bkashOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE payment_method = 'bkash'").get().count;
  const codOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE payment_method = 'cod'").get().count;
  const paidBkashRevenue =
    db
      .prepare("SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE payment_method = 'bkash' AND payment_status = 'paid'")
      .get().sum || 0;
  const codRevenue =
    db
      .prepare("SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE payment_method = 'cod' AND order_status != 'cancelled'")
      .get().sum || 0;

  const totalProducts = db.prepare('SELECT COUNT(*) as count FROM products WHERE active = 1').get().count;
  const lowStockProducts = db.prepare('SELECT COUNT(*) as count FROM products WHERE active = 1 AND stock < 10').get().count;
  const totalCategories = db.prepare('SELECT COUNT(*) as count FROM categories').get().count;

  const totalRegisteredUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const verifiedUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE email_verified = 1').get().count;
  const activeUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'active'").get().count;
  const totalCustomers = db.prepare('SELECT COUNT(*) as count FROM customers').get().count;
  const totalSubscribers = db.prepare('SELECT COUNT(*) as count FROM subscribers').get().count;

  const recentOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 6').all();
  const recentUsers = db
    .prepare('SELECT id, name, phone, email, email_verified, district, status, created_at FROM users ORDER BY created_at DESC LIMIT 6')
    .all();

  const firebaseStatus = getFirebaseStatus(db);

  const topProducts = db
    .prepare(`
      SELECT name, name_en, total_sold, stock, COALESCE(sale_price, price) as price
      FROM products
      WHERE active = 1
      ORDER BY total_sold DESC
      LIMIT 5
    `)
    .all();

  res.json({
    success: true,
    stats: {
      totalOrders,
      pendingOrders,
      confirmedOrders,
      deliveredOrders,
      cancelledOrders,
      totalRevenue: Number(totalRevenue).toFixed(2),
      bkashOrders,
      codOrders,
      paidBkashRevenue: Number(paidBkashRevenue).toFixed(2),
      codRevenue: Number(codRevenue).toFixed(2),
      totalProducts,
      lowStockProducts,
      totalCategories,
      totalRegisteredUsers,
      verifiedUsers,
      activeUsers,
      totalCustomers,
      totalSubscribers,
      firebaseStatus,
      recentOrders,
      recentUsers,
      topProducts
    }
  });
});

// Products CRUD
router.get('/products', requirePermission('products'), (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'products.html')));

router.get('/api/products', requirePermission('products'), (req, res) => {
  const db = getDb();
  const products = db
    .prepare(`
      SELECT p.*, c.name as category_name, c.name_en as category_name_en
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.created_at DESC
    `)
    .all()
    .map((p) => ({
      ...p,
      images: JSON.parse(p.images || '[]'),
      sizes: JSON.parse(p.sizes || '[]'),
      colors: JSON.parse(p.colors || '[]')
    }));
  res.json({ success: true, products });
});

router.post('/api/products', requirePermission('products'), upload.array('images', 5), (req, res) => {
  const db = getDb();
  const { name, name_en, description, description_en, price, sale_price, category_id, stock, sizes, colors, featured } =
    req.body;

  if (!name || !price) return res.json({ success: false, message: 'নাম ও দাম আবশ্যিক' });

  const slug = makeSlug(name_en || name);
  const images = req.files ? req.files.map((f) => '/uploads/' + f.filename) : [];
  if (images.length === 0) images.push('/uploads/product-placeholder.svg');

  const sizesArr = sizes ? (Array.isArray(sizes) ? sizes : [sizes]) : ['ফ্রি সাইজ (৫.৫ হাত)'];
  const colorsArr = colors ? (Array.isArray(colors) ? colors : [colors]) : [];

  const prodRes = db.prepare(`
    INSERT INTO products (
      name, name_en, slug, description, description_en, price, sale_price,
      category_id, stock, images, sizes, colors, featured
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    name_en ? name_en.trim() : null,
    slug,
    description || null,
    description_en || null,
    parseFloat(price),
    sale_price ? parseFloat(sale_price) : null,
    category_id ? parseInt(category_id, 10) : null,
    Math.max(0, parseInt(stock || 0, 10)),
    JSON.stringify(images),
    JSON.stringify(sizesArr),
    JSON.stringify(colorsArr),
    featured ? 1 : 0
  );

  const created = db.prepare('SELECT * FROM products WHERE id = ?').get(prodRes.lastInsertRowid);
  if (created) {
    syncDoc(db, 'products', created.id, {
      ...created,
      images: JSON.parse(created.images || '[]'),
      sizes: JSON.parse(created.sizes || '[]'),
      colors: JSON.parse(created.colors || '[]'),
      featured: Boolean(created.featured),
      active: Boolean(created.active)
    }, true).catch(() => {});
  }

  res.json({ success: true, message: 'পণ্য সফলভাবে যোগ করা হয়েছে!' });
});

router.put('/api/products/:id', requirePermission('products'), upload.array('images', 5), (req, res) => {
  const db = getDb();
  const {
    name,
    name_en,
    description,
    description_en,
    price,
    sale_price,
    category_id,
    stock,
    sizes,
    colors,
    featured,
    active,
    existing_images
  } = req.body;

  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.json({ success: false, message: 'পণ্য পাওয়া যায়নি' });

  let images = existing_images ? JSON.parse(existing_images) : JSON.parse(existing.images || '[]');
  if (req.files && req.files.length > 0) {
    images = [...images, ...req.files.map((f) => '/uploads/' + f.filename)];
  }
  if (images.length === 0) images.push('/uploads/product-placeholder.svg');

  const sizesArr = sizes ? (Array.isArray(sizes) ? sizes : [sizes]) : ['ফ্রি সাইজ (৫.৫ হাত)'];
  const colorsArr = colors ? (Array.isArray(colors) ? colors : [colors]) : [];

  db.prepare(`
    UPDATE products
    SET name = ?, name_en = ?, description = ?, description_en = ?, price = ?, sale_price = ?,
        category_id = ?, stock = ?, images = ?, sizes = ?, colors = ?, featured = ?, active = ?
    WHERE id = ?
  `).run(
    name.trim(),
    name_en ? name_en.trim() : null,
    description || null,
    description_en || null,
    parseFloat(price),
    sale_price ? parseFloat(sale_price) : null,
    category_id ? parseInt(category_id, 10) : null,
    Math.max(0, parseInt(stock || 0, 10)),
    JSON.stringify(images),
    JSON.stringify(sizesArr),
    JSON.stringify(colorsArr),
    featured ? 1 : 0,
    active !== undefined ? parseInt(active, 10) : 1,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (updated) {
    syncDoc(db, 'products', updated.id, {
      ...updated,
      images: JSON.parse(updated.images || '[]'),
      sizes: JSON.parse(updated.sizes || '[]'),
      colors: JSON.parse(updated.colors || '[]'),
      featured: Boolean(updated.featured),
      active: Boolean(updated.active)
    }, true).catch(() => {});
  }

  res.json({ success: true, message: 'পণ্য আপডেট হয়েছে!' });
});

router.delete('/api/products/:id', requirePermission('products'), (req, res) => {
  const db = getDb();
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  syncDoc(db, 'products', req.params.id, { active: false }, true).catch(() => {});
  res.json({ success: true, message: 'পণ্য মুছে ফেলা হয়েছে!' });
});

// Orders
router.get('/orders', requirePermission('orders'), (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'orders.html')));

router.get('/api/orders', requirePermission('orders'), (req, res) => {
  const db = getDb();
  const { status, search, page = 1, limit = 20 } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  let where = 'WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    where += ' AND order_status = ?';
    params.push(status);
  }
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    where += ' AND (order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)';
    params.push(q, q, q);
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM orders ${where}`).get(...params).count;

  const orders = db
    .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limitNum, (pageNum - 1) * limitNum)
    .map((o) => ({
      ...o,
      items: JSON.parse(o.items || '[]')
    }));

  res.json({ success: true, orders, total });
});

router.get('/api/orders/:id', requirePermission('orders'), (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'অর্ডার পাওয়া যায়নি' });

  order.items = JSON.parse(order.items || '[]');
  const payments = db.prepare('SELECT * FROM bkash_payments WHERE order_id = ? ORDER BY created_at DESC').all(order.id);
  res.json({ success: true, order, payments });
});

router.put('/api/orders/:id/status', requirePermission('orders'), (req, res) => {
  const db = getDb();
  const { order_status, payment_status } = req.body;

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!existing) throw new Error('অর্ডার পাওয়া যায়নি');

    if (order_status === 'cancelled' && existing.order_status !== 'cancelled') {
      const items = JSON.parse(existing.items || '[]');
      for (const item of items) {
        db.prepare('UPDATE products SET stock = stock + ?, total_sold = MAX(0, total_sold - ?) WHERE id = ?')
          .run(item.quantity, item.quantity, item.product_id);
      }
    }

    db.prepare(`
      UPDATE orders
      SET order_status = COALESCE(?, order_status),
          payment_status = COALESCE(?, payment_status),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(order_status || null, payment_status || null, req.params.id);
  });

  try {
    tx();
    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (updatedOrder) {
      syncDoc(db, 'orders', updatedOrder.order_number, {
        order_status: updatedOrder.order_status,
        payment_status: updatedOrder.payment_status,
        updated_at: new Date().toISOString()
      }, true).catch(() => {});
    }
    res.json({ success: true, message: 'অর্ডার স্ট্যাটাস আপডেট হয়েছে!' });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

// Export orders CSV
router.get('/api/orders/export/csv', requirePermission('orders'), (req, res) => {
  const db = getDb();
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();

  let csv = 'Order Number,Date,Customer Name,Phone,Email,District,Address,Subtotal,Shipping,Discount,Total,Payment Method,Payment Status,Order Status\n';
  for (const o of orders) {
    const row = [
      `"${o.order_number}"`,
      `"${o.created_at}"`,
      `"${String(o.customer_name || '').replace(/"/g, '""')}"`,
      `"${o.customer_phone}"`,
      `"${o.customer_email || ''}"`,
      `"${String(o.district || '').replace(/"/g, '""')}"`,
      `"${String(o.shipping_address || '').replace(/"/g, '""')}"`,
      o.subtotal,
      o.shipping_cost,
      o.discount || 0,
      o.total,
      o.payment_method,
      o.payment_status,
      o.order_status
    ].join(',');
    csv += row + '\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lungi_ghar_orders_' + Date.now() + '.csv"');
  res.send('\uFEFF' + csv);
});

// ================= COUPONS MANAGEMENT =================
router.get('/coupons', requirePermission('coupons'), (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'coupons.html'));
});

router.get('/api/coupons', requirePermission('coupons'), (req, res) => {
  const db = getDb();
  const coupons = db.prepare('SELECT * FROM coupons ORDER BY id DESC').all();
  res.json({ success: true, coupons });
});

router.post('/api/coupons', requirePermission('coupons'), (req, res) => {
  const db = getDb();
  const { code, discount_type, discount_value, min_order_amount, max_discount_amount, is_active } = req.body;
  const cleanCode = String(code || '').trim().toUpperCase();
  const val = parseFloat(discount_value) || 0;

  if (!cleanCode || val <= 0) {
    return res.status(400).json({ success: false, message: 'সঠিক কোড ও ডিসকাউন্ট ভ্যালু দিন' });
  }

  const existing = db.prepare('SELECT id FROM coupons WHERE UPPER(code) = ?').get(cleanCode);
  if (existing) {
    return res.status(400).json({ success: false, message: 'এই কোডটি ইতিমধ্যেই আছে' });
  }

  db.prepare(`
    INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_discount_amount, is_active)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    cleanCode,
    discount_type === 'fixed' ? 'fixed' : 'percentage',
    val,
    parseFloat(min_order_amount) || 0,
    max_discount_amount ? parseFloat(max_discount_amount) : null,
    is_active ? 1 : 0
  );

  res.json({ success: true, message: 'কুপন সফলভাবে তৈরি করা হয়েছে!' });
});

router.put('/api/coupons/:id/toggle', requirePermission('coupons'), (req, res) => {
  const db = getDb();
  const coupon = db.prepare('SELECT id, is_active FROM coupons WHERE id = ?').get(req.params.id);
  if (!coupon) return res.status(404).json({ success: false, message: 'কুপন পাওয়া যায়নি' });

  const nextState = coupon.is_active ? 0 : 1;
  db.prepare('UPDATE coupons SET is_active = ? WHERE id = ?').run(nextState, coupon.id);
  res.json({ success: true, message: nextState ? 'কুপন সক্রিয় করা হয়েছে' : 'কুপন নিষ্ক্রিয় করা হয়েছে', is_active: nextState });
});

router.delete('/api/coupons/:id', requirePermission('coupons'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM coupons WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'কুপন মুছে ফেলা হয়েছে' });
});

// Categories
router.get('/categories', requirePermission('categories'), (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'categories.html'))
);

router.get('/api/categories', requirePermission('categories'), (req, res) => {
  const db = getDb();
  const categories = db
    .prepare(`
      SELECT c.*, COUNT(p.id) as product_count
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id AND p.active = 1
      GROUP BY c.id
      ORDER BY c.id ASC
    `)
    .all();
  res.json({ success: true, categories });
});

router.post('/api/categories', requirePermission('categories'), upload.single('image'), (req, res) => {
  const db = getDb();
  const { name, name_en, description, description_en } = req.body;
  if (!name) return res.json({ success: false, message: 'নাম আবশ্যিক' });

  const slug = makeSlug(name_en || name);
  const image = req.file ? '/uploads/' + req.file.filename : null;

  const catRes = db.prepare('INSERT INTO categories (name, name_en, slug, description, description_en, image) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name.trim(), name_en ? name_en.trim() : null, slug, description || null, description_en || null, image);
  const createdCat = db.prepare('SELECT * FROM categories WHERE id = ?').get(catRes.lastInsertRowid);
  if (createdCat) syncDoc(db, 'categories', createdCat.id, createdCat, true).catch(() => {});
  res.json({ success: true, message: 'ক্যাটাগরি যোগ হয়েছে!' });
});

router.delete('/api/categories/:id', requirePermission('categories'), (req, res) => {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(req.params.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  });
  tx();
  deleteDoc(db, 'categories', req.params.id, true).catch(() => {});
  res.json({ success: true, message: 'ক্যাটাগরি মুছে ফেলা হয়েছে!' });
});

// Settings
router.get('/settings', requirePermission('settings'), (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'settings.html')));

router.get('/api/settings', requirePermission('settings'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((r) => {
    settings[r.key] = r.value;
  });
  res.json({ success: true, settings });
});

router.post('/api/settings', requirePermission('settings'), (req, res) => {
  const db = getDb();
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const canPayment = hasPermission(req.session.admin, 'payment_gateway');

  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(req.body || {})) {
      if (value === '__KEEP__') continue;
      // Protect payment & firebase secrets if admin lacks payment_gateway permission
      if (!canPayment && (key.startsWith('bkash_') || key.startsWith('firebase_') || key.startsWith('smtp_'))) {
        continue;
      }
      upsert.run(key, value === undefined || value === null ? '' : String(value));
    }
  });
  tx();
  if (canPayment && req.body && req.body.firebase_service_account_json !== undefined) {
    resetFirebaseCache();
  }
  res.json({ success: true, message: 'সেটিংস সংরক্ষিত হয়েছে!' });
});

router.post('/api/upload', requirePermission('settings'), upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'কোনো ফাইল আপলোড করা হয়নি' });
  }
  const fileUrl = '/uploads/' + req.file.filename;
  res.json({ success: true, url: fileUrl, filename: req.file.filename });
});

// Firebase & Gmail Integration Endpoints
router.get('/api/integrations/status', requirePermission('payment_gateway'), async (req, res) => {
  const db = getDb();
  const firebase = getFirebaseStatus(db);
  const email = getEmailConfig(db);
  const firebaseTotals = firebase.configured ? await getFirebaseTotals(db) : null;
  res.json({
    success: true,
    firebase,
    firebaseTotals,
    email: {
      configured: email.configured,
      smtpEmail: email.smtpEmail,
      fromName: email.fromName
    }
  });
});

router.post('/api/firebase/test', requirePermission('payment_gateway'), async (req, res) => {
  const db = getDb();
  const result = await testFirebaseConnection(db);
  res.json(result);
});

router.post('/api/firebase/sync-all', requirePermission('payment_gateway'), async (req, res) => {
  const db = getDb();
  const result = await syncAllToFirestore(db);
  res.json(result);
});

router.post('/api/email/test', requirePermission('payment_gateway'), async (req, res) => {
  const db = getDb();
  const result = await sendTestEmail(db, req.body?.to_email);
  res.json(result);
});

// Users & Customers Management
router.get('/customers', requirePermission('customers'), (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'customers.html'))
);

router.get('/api/users', requirePermission('customers'), (req, res) => {
  const db = getDb();
  const { search = '', status = 'all' } = req.query;

  let where = 'WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    where += ' AND u.status = ?';
    params.push(status);
  }
  if (search.trim()) {
    const q = `%${search.trim()}%`;
    where += ' AND (u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ? OR u.district LIKE ?)';
    params.push(q, q, q, q);
  }

  const users = db
    .prepare(`
      SELECT u.id, u.name, u.phone, u.email, u.email_verified, u.district, u.address, u.status, u.created_at, u.last_login,
        COUNT(o.id) as total_orders,
        COALESCE(SUM(CASE WHEN o.order_status != 'cancelled' THEN o.total ELSE 0 END), 0) as total_spent
      FROM users u
      LEFT JOIN orders o ON (o.user_id = u.id OR o.customer_phone = u.phone)
      ${where}
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `)
    .all(...params);

  const summary = {
    totalUsers: db.prepare('SELECT COUNT(*) as count FROM users').get().count,
    verifiedUsers: db.prepare('SELECT COUNT(*) as count FROM users WHERE email_verified = 1').get().count,
    activeUsers: db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'active'").get().count,
    suspendedUsers: db.prepare("SELECT COUNT(*) as count FROM users WHERE status != 'active'").get().count,
    totalCustomers: db.prepare('SELECT COUNT(*) as count FROM customers').get().count,
    totalSubscribers: db.prepare('SELECT COUNT(*) as count FROM subscribers').get().count
  };

  res.json({ success: true, users, summary });
});

router.get('/api/users/:id', requirePermission('customers'), (req, res) => {
  const db = getDb();
  const user = db
    .prepare('SELECT id, name, phone, email, email_verified, district, address, status, created_at, last_login FROM users WHERE id = ?')
    .get(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'ইউজার পাওয়া যায়নি' });

  const orders = db
    .prepare('SELECT * FROM orders WHERE user_id = ? OR customer_phone = ? ORDER BY created_at DESC')
    .all(user.id, user.phone)
    .map((o) => ({ ...o, items: JSON.parse(o.items || '[]') }));

  res.json({ success: true, user, orders });
});

router.put('/api/users/:id/status', requirePermission('customers'), (req, res) => {
  const db = getDb();
  const nextStatus = req.body.status === 'suspended' ? 'suspended' : 'active';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(nextStatus, req.params.id);
  syncDoc(db, 'users', req.params.id, { status: nextStatus }, true).catch(() => {});
  res.json({ success: true, message: 'ইউজারের স্ট্যাটাস আপডেট হয়েছে' });
});

router.get('/api/customers', requirePermission('customers'), (req, res) => {
  const db = getDb();
  const customers = db
    .prepare(`
      SELECT c.*, COUNT(o.id) as total_orders, COALESCE(SUM(o.total), 0) as total_spent
      FROM customers c
      LEFT JOIN orders o ON c.id = o.customer_id AND o.order_status != 'cancelled'
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `)
    .all();
  res.json({ success: true, customers });
});

router.get('/api/subscribers', requirePermission('customers'), (req, res) => {
  const db = getDb();
  const subscribers = db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all();
  res.json({ success: true, subscribers });
});

// ================= ADMIN STAFF & PERMISSIONS (RBAC) =================
router.get('/admins', requirePermission('admins'), (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'admins.html'));
});

router.get('/api/admins', requirePermission('admins'), (req, res) => {
  const db = getDb();
  const admins = db
    .prepare('SELECT id, username, name, role, permissions, status, created_at, last_login FROM admins ORDER BY id ASC')
    .all()
    .map((a) => {
      let perms = [];
      try {
        perms = JSON.parse(a.permissions || '[]');
      } catch (_) {
        perms = [];
      }
      return {
        ...a,
        permissions: perms,
        is_primary: a.id === 1 || a.username === 'admin'
      };
    });

  res.json({ success: true, admins });
});

router.post('/api/admins', requirePermission('admins'), (req, res) => {
  const db = getDb();
  let { username, password, name, role, permissions } = req.body;
  username = String(username || '').trim().toLowerCase();
  name = String(name || '').trim();
  password = String(password || '').trim();
  role = String(role || 'custom').trim();

  if (!username || username.length < 3) {
    return res.status(400).json({ success: false, message: 'ইউজারনেম কমপক্ষে ৩ অক্ষরের হতে হবে' });
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    return res.status(400).json({ success: false, message: 'ইউজারনেমে শুধুমাত্র ইংরেজি ছোট অক্ষর, সংখ্যা এবং (_) ব্যবহার করা যাবে' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ success: false, message: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
  }
  if (!name) {
    return res.status(400).json({ success: false, message: 'অ্যাডমিনের নাম আবশ্যক' });
  }

  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  if (existing) {
    return res.status(400).json({ success: false, message: 'এই ইউজারনেম ইতিমধ্যে ব্যবহৃত হয়েছে' });
  }

  let permsArray = [];
  if (role === 'super_admin') {
    permsArray = ['all'];
  } else if (Array.isArray(permissions)) {
    permsArray = permissions.map((p) => String(p).trim()).filter(Boolean);
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO admins (username, password, name, role, permissions, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(username, hashedPassword, name, role, JSON.stringify(permsArray));

  res.json({
    success: true,
    message: 'নতুন অ্যাডমিন সফলভাবে যোগ করা হয়েছে!',
    adminId: result.lastInsertRowid
  });
});

router.put('/api/admins/:id', requirePermission('admins'), (req, res) => {
  const db = getDb();
  const targetId = parseInt(req.params.id, 10);
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ success: false, message: 'অ্যাডমিন পাওয়া যায়নি' });
  }

  const isPrimary = target.id === 1 || target.username === 'admin';
  let { name, role, permissions, password } = req.body;
  name = String(name || target.name).trim();

  if (isPrimary && role && role !== 'super_admin') {
    return res.status(400).json({ success: false, message: 'মূল সুপার অ্যাডমিনের রোল পরিবর্তন করা যাবে না' });
  }

  let permsArray = [];
  if (isPrimary || role === 'super_admin') {
    role = 'super_admin';
    permsArray = ['all'];
  } else if (Array.isArray(permissions)) {
    permsArray = permissions.map((p) => String(p).trim()).filter(Boolean);
  } else {
    try {
      permsArray = JSON.parse(target.permissions || '[]');
    } catch (_) {
      permsArray = [];
    }
  }

  if (password && String(password).trim().length >= 6) {
    const hashedPassword = bcrypt.hashSync(String(password).trim(), 10);
    db.prepare('UPDATE admins SET name = ?, role = ?, permissions = ?, password = ? WHERE id = ?')
      .run(name, role, JSON.stringify(permsArray), hashedPassword, targetId);
  } else {
    db.prepare('UPDATE admins SET name = ?, role = ?, permissions = ? WHERE id = ?')
      .run(name, role, JSON.stringify(permsArray), targetId);
  }

  if (req.session.admin && req.session.admin.id === targetId) {
    req.session.admin.name = name;
    req.session.admin.role = role;
    req.session.admin.permissions = permsArray;
  }

  res.json({ success: true, message: 'অ্যাডমিন তথ্য আপডেট হয়েছে!' });
});

router.put('/api/admins/:id/status', requirePermission('admins'), (req, res) => {
  const db = getDb();
  const targetId = parseInt(req.params.id, 10);
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ success: false, message: 'অ্যাডমিন পাওয়া যায়নি' });
  }

  if (target.id === 1 || target.username === 'admin') {
    return res.status(400).json({ success: false, message: 'মূল সুপার অ্যাডমিনকে স্থগিত করা যাবে না' });
  }
  if (req.session.admin && req.session.admin.id === targetId) {
    return res.status(400).json({ success: false, message: 'আপনি নিজের অ্যাকাউন্ট স্থগিত করতে পারবেন না' });
  }

  const nextStatus = req.body.status === 'suspended' ? 'suspended' : 'active';
  db.prepare('UPDATE admins SET status = ? WHERE id = ?').run(nextStatus, targetId);

  res.json({
    success: true,
    message: nextStatus === 'suspended' ? 'অ্যাডমিন অ্যাকাউন্ট স্থগিত করা হয়েছে' : 'অ্যাডমিন অ্যাকাউন্ট সক্রিয় করা হয়েছে'
  });
});

router.delete('/api/admins/:id', requirePermission('admins'), (req, res) => {
  const db = getDb();
  const targetId = parseInt(req.params.id, 10);
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ success: false, message: 'অ্যাডমিন পাওয়া যায়নি' });
  }

  if (target.id === 1 || target.username === 'admin') {
    return res.status(400).json({ success: false, message: 'মূল সুপার অ্যাডমিনকে মুছে ফেলা যাবে না' });
  }
  if (req.session.admin && req.session.admin.id === targetId) {
    return res.status(400).json({ success: false, message: 'আপনি নিজের অ্যাকাউন্ট ডিলিট করতে পারবেন না' });
  }

  db.prepare('DELETE FROM admins WHERE id = ?').run(targetId);
  res.json({ success: true, message: 'অ্যাডমিন সফলভাবে মুছে ফেলা হয়েছে' });
});

// Admin session check (with fresh DB role & permissions)
router.get('/api/session', (req, res) => {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ success: false, message: 'লগইন করা নেই' });
  }
  const db = getDb();
  const fresh = db.prepare('SELECT id, username, name, role, permissions, status FROM admins WHERE id = ?').get(req.session.admin.id);
  if (!fresh || fresh.status === 'suspended') {
    delete req.session.admin;
    return res.status(403).json({ success: false, suspended: true, message: 'আপনার অ্যাকাউন্ট স্থগিত বা মুছে ফেলা হয়েছে' });
  }
  let perms = [];
  try {
    perms = JSON.parse(fresh.permissions || '[]');
  } catch (_) {
    perms = [];
  }
  req.session.admin.name = fresh.name;
  req.session.admin.role = fresh.role;
  req.session.admin.permissions = perms;
  res.json({ success: true, admin: req.session.admin });
});

// Change password
router.post('/api/change-password', (req, res) => {
  const db = getDb();
  const { current_password, new_password } = req.body;

  if (!new_password || String(new_password).length < 6) {
    return res.json({ success: false, message: 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.admin.id);
  if (!admin || !bcrypt.compareSync(String(current_password || ''), admin.password)) {
    return res.json({ success: false, message: 'বর্তমান পাসওয়ার্ড ভুল' });
  }

  const hashed = bcrypt.hashSync(String(new_password), 10);
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hashed, req.session.admin.id);
  res.json({ success: true, message: 'পাসওয়ার্ড পরিবর্তন হয়েছে!' });
});

module.exports = router;
