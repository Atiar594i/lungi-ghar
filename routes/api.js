// API Routes - routes/api.js
const express = require('express');
const router = express.Router();
const { getDb } = require('../lib/db');
const { syncDoc, syncTotalsToFirebase } = require('../lib/firebase');

const PUBLIC_SETTING_KEYS = new Set([
  'shop_name',
  'shop_name_en',
  'shop_phone',
  'shop_email',
  'shop_address',
  'shop_address_en',
  'shop_district',
  'shop_google_map_url',
  'shipping_inside_dhaka',
  'shipping_outside_dhaka',
  'free_shipping_above',
  'delivery_time_inside_dhaka',
  'delivery_time_outside_dhaka',
  'announcement_enabled',
  'announcement_text',
  'announcement_text_en',
  'facebook_url',
  'instagram_url',
  'whatsapp',
  'youtube_url',
  'tiktok_url',
  'twitter_url',
  'telegram_url',
  'linkedin_url',
  'site_favicon',
  'site_logo',
  'bkash_enabled',
  'cod_enabled',
  'min_order_amount',
  'support_hours',
  'support_hours_en',
  'return_policy_days',
  'return_policy_text',
  'return_policy_text_en',
  'footer_copyright',
  'footer_copyright_en',
  'shop_district_en',
  'google_analytics_id',
  'facebook_pixel_id'
]);

function normalizeBdPhone(phone) {
  let cleaned = String(phone || '').replace(/[\s-]/g, '');
  if (cleaned.startsWith('+880')) cleaned = '0' + cleaned.slice(4);
  else if (cleaned.startsWith('880')) cleaned = '0' + cleaned.slice(3);
  return cleaned;
}

// Get all products
router.get('/products', (req, res) => {
  const db = getDb();
  const { category, featured, search, sort, page = 1, limit = 12 } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));

  let where = 'WHERE p.active = 1';
  const params = [];

  if (category) {
    where += ' AND c.slug = ?';
    params.push(category);
  }
  if (featured) {
    where += ' AND p.featured = 1';
  }
  if (search) {
    where += ' AND (p.name LIKE ? OR p.name_en LIKE ? OR p.description LIKE ? OR p.description_en LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  let orderBy = 'ORDER BY p.featured DESC, p.created_at DESC';
  if (sort === 'price_asc') orderBy = 'ORDER BY COALESCE(p.sale_price, p.price) ASC';
  else if (sort === 'price_desc') orderBy = 'ORDER BY COALESCE(p.sale_price, p.price) DESC';
  else if (sort === 'newest') orderBy = 'ORDER BY p.created_at DESC';
  else if (sort === 'bestseller') orderBy = 'ORDER BY p.total_sold DESC, p.featured DESC';

  const countSql = `
    SELECT COUNT(*) as total
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    ${where}
  `;
  const total = db.prepare(countSql).get(...params).total;

  const offset = (pageNum - 1) * limitNum;
  const dataSql = `
    SELECT p.*, c.name as category_name, c.name_en as category_name_en, c.slug as category_slug,
      (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) as review_count,
      (SELECT COALESCE(AVG(r.rating), 5) FROM reviews r WHERE r.product_id = p.id) as avg_rating
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const products = db
    .prepare(dataSql)
    .all(...params, limitNum, offset)
    .map((p) => ({
      ...p,
      images: JSON.parse(p.images || '[]'),
      sizes: JSON.parse(p.sizes || '[]'),
      colors: JSON.parse(p.colors || '[]')
    }));

  res.json({
    success: true,
    products,
    total,
    page: pageNum,
    pages: Math.max(1, Math.ceil(total / limitNum))
  });
});

// Get single product
router.get('/products/:slug', (req, res) => {
  const db = getDb();
  const product = db
    .prepare(`
      SELECT p.*, c.name as category_name, c.name_en as category_name_en, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.slug = ? AND p.active = 1
    `)
    .get(req.params.slug);

  if (!product) {
    return res.status(404).json({ success: false, message: 'পণ্য পাওয়া যায়নি' });
  }

  product.images = JSON.parse(product.images || '[]');
  product.sizes = JSON.parse(product.sizes || '[]');
  product.colors = JSON.parse(product.colors || '[]');

  const reviews = db
    .prepare('SELECT id, customer_name, rating, comment, created_at FROM reviews WHERE product_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(product.id);

  const related = db
    .prepare(`
      SELECT p.*, c.name as category_name, c.name_en as category_name_en
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.category_id = ? AND p.id != ? AND p.active = 1
      LIMIT 4
    `)
    .all(product.category_id, product.id)
    .map((p) => ({
      ...p,
      images: JSON.parse(p.images || '[]'),
      sizes: JSON.parse(p.sizes || '[]'),
      colors: JSON.parse(p.colors || '[]')
    }));

  res.json({ success: true, product, related, reviews });
});

// Add product review
router.post('/products/:slug/reviews', (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT id FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!product) return res.status(404).json({ success: false, message: 'পণ্য পাওয়া যায়নি' });

  const customerName = String(req.body.customer_name || '').trim();
  const rating = parseInt(req.body.rating, 10);
  const comment = String(req.body.comment || '').trim();

  if (!customerName || !(rating >= 1 && rating <= 5) || !comment) {
    return res.status(400).json({ success: false, message: 'নাম, রেটিং এবং মন্তব্য লিখুন' });
  }

  db.prepare('INSERT INTO reviews (product_id, customer_name, rating, comment) VALUES (?, ?, ?, ?)')
    .run(product.id, customerName.slice(0, 80), rating, comment.slice(0, 500));

  res.json({ success: true, message: 'আপনার রিভিউয়ের জন্য ধন্যবাদ!' });
});

// Get categories
router.get('/categories', (req, res) => {
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

// Get public settings (never expose secrets)
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {
    bkash_enabled: '1',
    cod_enabled: '1',
    min_order_amount: '0'
  };
  rows.forEach((r) => {
    if (PUBLIC_SETTING_KEYS.has(r.key)) {
      settings[r.key] = r.value;
    }
  });
  res.json({ success: true, settings });
});

// Get banners
router.get('/banners', (req, res) => {
  const db = getDb();
  const banners = db.prepare('SELECT * FROM banners WHERE active = 1 ORDER BY sort_order').all();
  res.json({ success: true, banners });
});

// Newsletter subscription
router.post('/subscribe', (req, res) => {
  const db = getDb();
  const phone = normalizeBdPhone(req.body.phone);
  if (!/^01[3-9]\d{8}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)' });
  }
  db.prepare('INSERT OR IGNORE INTO subscribers (phone) VALUES (?)').run(phone);
  syncDoc(db, 'subscribers', phone, { phone, created_at: new Date().toISOString() }, true).catch(() => {});
  res.json({ success: true, message: 'অফার আপডেটের জন্য সাবস্ক্রিপশন সফল হয়েছে!' });
});

// Validate and apply promo coupon
router.post('/coupons/apply', (req, res) => {
  const db = getDb();
  const code = String(req.body.code || '').trim().toUpperCase();
  const subtotal = parseFloat(req.body.subtotal) || 0;

  if (!code) {
    return res.status(400).json({ success: false, message: 'কুপন কোড লিখুন' });
  }

  const coupon = db.prepare('SELECT * FROM coupons WHERE UPPER(code) = ? AND is_active = 1').get(code);
  if (!coupon) {
    return res.status(404).json({ success: false, message: 'অবৈধ বা মেয়াদোত্তীর্ণ কুপন কোড' });
  }

  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return res.status(400).json({ success: false, message: 'এই কুপনের মেয়াদ শেষ হয়ে গেছে' });
  }

  if (coupon.usage_limit && coupon.times_used >= coupon.usage_limit) {
    return res.status(400).json({ success: false, message: 'এই কুপনের সর্বোচ্চ ব্যবহারের সীমা শেষ' });
  }

  if (coupon.min_order_amount && subtotal < coupon.min_order_amount) {
    return res.status(400).json({
      success: false,
      message: `এই কুপন ব্যবহার করতে ন্যূনতম ৳${coupon.min_order_amount} টাকার অর্ডার করতে হবে`
    });
  }

  let discount = 0;
  if (coupon.discount_type === 'percentage') {
    discount = Math.round((subtotal * coupon.discount_value) / 100);
    if (coupon.max_discount_amount && discount > coupon.max_discount_amount) {
      discount = coupon.max_discount_amount;
    }
  } else {
    discount = coupon.discount_value;
  }

  if (discount > subtotal) discount = subtotal;

  res.json({
    success: true,
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    discount,
    message: 'কুপন কোড সফলভাবে যুক্ত হয়েছে!'
  });
});

// Place order (requires logged-in & email-verified user + authoritative server-side pricing & stock validation)
router.post('/orders', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({
      success: false,
      requireAuth: true,
      message: 'অর্ডার ও চেকআউট করতে অনুগ্রহ করে আগে লগইন অথবা সাইন আপ করুন।'
    });
  }

  const db = getDb();
  const activeUser = db.prepare('SELECT id, status, email_verified FROM users WHERE id = ?').get(req.session.user.id);
  if (!activeUser || activeUser.status !== 'active' || !activeUser.email_verified) {
    delete req.session.user;
    return res.status(401).json({
      success: false,
      requireAuth: true,
      message: 'অর্ডার করতে অনুগ্রহ করে জিমেইল ভেরিফাই করে লগইন করুন।'
    });
  }

  const {
    customer_name,
    customer_phone,
    customer_email,
    shipping_address,
    district,
    thana,
    items,
    payment_method,
    notes,
    coupon_code
  } = req.body;

  const cleanName = String(customer_name || '').trim();
  const cleanPhone = normalizeBdPhone(customer_phone);
  const cleanAddress = String(shipping_address || '').trim();
  const cleanDistrict = String(district || '').trim();
  const payMethod = payment_method === 'bkash' ? 'bkash' : payment_method === 'cod' ? 'cod' : null;
  const loggedInUserId = activeUser.id;

  if (!cleanName || !cleanPhone || !cleanAddress || !cleanDistrict || !items || !payMethod) {
    return res.status(400).json({ success: false, message: 'সব প্রয়োজনীয় তথ্য সঠিকভাবে পূরণ করুন' });
  }

  if (!/^01[3-9]\d{8}$/.test(cleanPhone)) {
    return res.status(400).json({ success: false, message: 'সঠিক ১১ সংখ্যার মোবাইল নম্বর দিন (01XXXXXXXXX)' });
  }

  let parsedItems;
  try {
    parsedItems = typeof items === 'string' ? JSON.parse(items) : items;
  } catch (_) {
    return res.status(400).json({ success: false, message: 'অবৈধ অর্ডার আইটেম' });
  }

  if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
    return res.status(400).json({ success: false, message: 'কার্ট খালি আছে' });
  }

  const bkashRow = db.prepare("SELECT value FROM settings WHERE key = 'bkash_enabled'").get();
  const bkashEnabled = bkashRow ? bkashRow.value !== '0' : true;
  if (payMethod === 'bkash' && !bkashEnabled) {
    return res.status(400).json({ success: false, message: 'বিকাশ পেমেন্ট বর্তমানে বন্ধ রয়েছে। অনুগ্রহ করে ক্যাশ অন ডেলিভারি বেছে নিন।' });
  }

  const codRow = db.prepare("SELECT value FROM settings WHERE key = 'cod_enabled'").get();
  const codEnabled = codRow ? codRow.value !== '0' : true;
  if (payMethod === 'cod' && !codEnabled) {
    return res.status(400).json({ success: false, message: 'ক্যাশ অন ডেলিভারি বর্তমানে বন্ধ রয়েছে।' });
  }

  const placeOrderTx = db.transaction(() => {
    let subtotal = 0;
    const verifiedItems = [];

    for (const rawItem of parsedItems) {
      const productId = parseInt(rawItem.product_id, 10);
      const qty = parseInt(rawItem.quantity, 10);
      if (!productId || !(qty >= 1)) {
        throw new Error('পণ্যের পরিমাণ সঠিক নয়');
      }

      const product = db
        .prepare('SELECT id, name, name_en, price, sale_price, stock, images FROM products WHERE id = ? AND active = 1')
        .get(productId);

      if (!product) {
        throw new Error('একটি পণ্য বর্তমানে পাওয়া যাচ্ছে না');
      }
      if (product.stock < qty) {
        throw new Error(`"${product.name}" পণ্যটির পর্যাপ্ত স্টক নেই (মজুদ: ${product.stock} টি)`);
      }

      const unitPrice = product.sale_price && product.sale_price > 0 ? product.sale_price : product.price;
      const productImages = JSON.parse(product.images || '[]');
      subtotal += unitPrice * qty;

      verifiedItems.push({
        product_id: product.id,
        name: product.name,
        name_en: product.name_en || product.name,
        price: unitPrice,
        quantity: qty,
        color: String(rawItem.color || ''),
        size: String(rawItem.size || 'ফ্রি সাইজ (৫.৫ হাত)'),
        image: productImages[0] || '/uploads/product-placeholder.svg'
      });
    }

    const settings = {};
    db.prepare('SELECT key, value FROM settings').all().forEach((r) => {
      settings[r.key] = r.value;
    });

    const minOrder = parseFloat(settings.min_order_amount || 0);
    if (minOrder > 0 && subtotal < minOrder) {
      throw new Error(`ন্যূনতম অর্ডারের পরিমাণ ৳${minOrder} হতে হবে।`);
    }

    const isInsideDhaka = ['ঢাকা', 'dhaka'].some((d) => cleanDistrict.toLowerCase().includes(d.toLowerCase()));
    let shippingCost = isInsideDhaka
      ? parseFloat(settings.shipping_inside_dhaka || 60)
      : parseFloat(settings.shipping_outside_dhaka || 120);

    const freeAbove = parseFloat(settings.free_shipping_above || 1500);
    if (freeAbove > 0 && subtotal >= freeAbove) {
      shippingCost = 0;
    }

    let discount = 0;
    let appliedCoupon = null;
    if (coupon_code) {
      const cleanCoupon = String(coupon_code).trim().toUpperCase();
      const c = db.prepare('SELECT * FROM coupons WHERE UPPER(code) = ? AND is_active = 1').get(cleanCoupon);
      if (c && (!c.min_order_amount || subtotal >= c.min_order_amount)) {
        if (c.discount_type === 'percentage') {
          discount = Math.round((subtotal * c.discount_value) / 100);
          if (c.max_discount_amount && discount > c.max_discount_amount) discount = c.max_discount_amount;
        } else {
          discount = c.discount_value;
        }
        if (discount > subtotal) discount = subtotal;
        appliedCoupon = c.code;
        db.prepare('UPDATE coupons SET times_used = times_used + 1 WHERE id = ?').run(c.id);
      }
    }

    const total = Math.max(0, subtotal - discount) + shippingCost;
    const orderNumber = 'LG' + Date.now().toString().slice(-8) + Math.floor(10 + Math.random() * 90);

    let customer = db.prepare('SELECT id FROM customers WHERE phone = ?').get(cleanPhone);
    if (!customer) {
      const custRes = db
        .prepare('INSERT INTO customers (name, email, phone, address, district) VALUES (?, ?, ?, ?, ?)')
        .run(cleanName, customer_email || null, cleanPhone, cleanAddress, cleanDistrict);
      customer = { id: custRes.lastInsertRowid };
    } else {
      db.prepare('UPDATE customers SET name = ?, address = ?, district = ? WHERE id = ?')
        .run(cleanName, cleanAddress, cleanDistrict, customer.id);
    }

    const orderRes = db
      .prepare(`
        INSERT INTO orders (
          order_number, user_id, customer_id, customer_name, customer_phone, customer_email,
          shipping_address, district, thana, items, subtotal, shipping_cost, discount, coupon_code, total, payment_method, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        orderNumber,
        loggedInUserId,
        customer.id,
        cleanName,
        cleanPhone,
        customer_email || null,
        cleanAddress,
        cleanDistrict,
        thana || null,
        JSON.stringify(verifiedItems),
        subtotal,
        shippingCost,
        discount,
        appliedCoupon,
        total,
        payMethod,
        notes || null
      );

    for (const item of verifiedItems) {
      db.prepare('UPDATE products SET stock = stock - ?, total_sold = total_sold + ? WHERE id = ?')
        .run(item.quantity, item.quantity, item.product_id);
    }

    return {
      order_id: orderRes.lastInsertRowid,
      order_number: orderNumber,
      subtotal,
      shipping_cost: shippingCost,
      discount,
      total
    };
  });

  try {
    const orderResult = placeOrderTx();
    const createdOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderResult.order_id);
    if (createdOrder) {
      syncDoc(
        db,
        'orders',
        createdOrder.order_number,
        {
          id: createdOrder.id,
          order_number: createdOrder.order_number,
          user_id: createdOrder.user_id,
          customer_name: createdOrder.customer_name,
          customer_phone: createdOrder.customer_phone,
          customer_email: createdOrder.customer_email || '',
          shipping_address: createdOrder.shipping_address,
          district: createdOrder.district,
          thana: createdOrder.thana || '',
          items: JSON.parse(createdOrder.items || '[]'),
          subtotal: createdOrder.subtotal,
          shipping_cost: createdOrder.shipping_cost,
          total: createdOrder.total,
          payment_method: createdOrder.payment_method,
          payment_status: createdOrder.payment_status,
          order_status: createdOrder.order_status,
          created_at: createdOrder.created_at
        },
        true
      ).catch(() => {});
    }
    res.json({
      success: true,
      message: 'অর্ডার সফলভাবে দেওয়া হয়েছে!',
      ...orderResult
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'অর্ডার দেওয়া যায়নি' });
  }
});

// Track order
router.get('/orders/track/:order_number', (req, res) => {
  const db = getDb();
  const orderNumber = String(req.params.order_number || '').trim().toUpperCase();
  const order = db.prepare('SELECT * FROM orders WHERE UPPER(order_number) = ?').get(orderNumber);
  if (!order) return res.status(404).json({ success: false, message: 'অর্ডার পাওয়া যায়নি' });

  order.items = JSON.parse(order.items || '[]');
  res.json({ success: true, order });
});

module.exports = router;
