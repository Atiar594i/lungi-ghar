// Database Setup - setup.js
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./lib/db');

function safeAddColumn(db, table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`);
  } catch (_) {
    // Column already exists
  }
}

function initDatabase() {
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      email_verified INTEGER DEFAULT 0,
      password TEXT NOT NULL,
      district TEXT,
      address TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      expires_at INTEGER NOT NULL,
      last_sent_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_en TEXT,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      description_en TEXT,
      image TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_en TEXT,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      description_en TEXT,
      price REAL NOT NULL,
      sale_price REAL,
      category_id INTEGER,
      stock INTEGER DEFAULT 0,
      images TEXT DEFAULT '[]',
      sizes TEXT DEFAULT '[]',
      colors TEXT DEFAULT '[]',
      featured INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      total_sold INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT NOT NULL,
      address TEXT,
      district TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      customer_id INTEGER,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      shipping_address TEXT NOT NULL,
      district TEXT NOT NULL,
      thana TEXT,
      items TEXT NOT NULL,
      subtotal REAL NOT NULL,
      shipping_cost REAL DEFAULT 0,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT DEFAULT 'pending',
      order_status TEXT DEFAULT 'pending',
      bkash_transaction_id TEXT,
      bkash_payment_id TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS bkash_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      payment_id TEXT,
      transaction_id TEXT,
      amount REAL,
      status TEXT,
      raw_response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      subtitle TEXT,
      image TEXT,
      link TEXT,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT DEFAULT 'Home',
      recipient_name TEXT NOT NULL,
      recipient_phone TEXT NOT NULL,
      district TEXT NOT NULL,
      thana TEXT,
      address TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT DEFAULT 'percentage',
      discount_value REAL NOT NULL,
      min_order_amount REAL DEFAULT 0,
      max_discount_amount REAL,
      usage_limit INTEGER DEFAULT 1000,
      times_used INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe migrations for existing databases
  safeAddColumn(db, 'categories', 'name_en TEXT');
  safeAddColumn(db, 'categories', 'description_en TEXT');
  safeAddColumn(db, 'products', 'name_en TEXT');
  safeAddColumn(db, 'products', 'description_en TEXT');
  safeAddColumn(db, 'orders', 'user_id INTEGER');
  safeAddColumn(db, 'orders', 'coupon_code TEXT');
  safeAddColumn(db, 'orders', 'discount REAL DEFAULT 0');
  safeAddColumn(db, 'users', 'email_verified INTEGER DEFAULT 0');
  safeAddColumn(db, 'admins', "role TEXT DEFAULT 'admin'");
  safeAddColumn(db, 'admins', "permissions TEXT DEFAULT '[\"all\"]'");
  safeAddColumn(db, 'admins', "status TEXT DEFAULT 'active'");
  safeAddColumn(db, 'admins', 'last_login DATETIME');

  // Seed default admin if none exists
  const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get().count;
  if (adminCount === 0) {
    const defaultUser = process.env.ADMIN_USERNAME || 'admin';
    const defaultPass = process.env.ADMIN_PASSWORD || 'admin123';
    const hashedPassword = bcrypt.hashSync(defaultPass, 10);
    db.prepare('INSERT OR IGNORE INTO admins (username, password, name, role, permissions, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(defaultUser, hashedPassword, 'Super Admin', 'super_admin', '["all"]', 'active');
  } else {
    try {
      db.prepare("UPDATE admins SET role = 'super_admin', permissions = '[\"all\"]', status = 'active' WHERE username = 'admin'").run();
    } catch (_) {}
  }

  // Insert default settings
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('shop_name', process.env.SHOP_NAME || 'লুঙ্গি ঘর');
  insertSetting.run('shop_name_en', 'Lungi Ghar');
  insertSetting.run('shop_phone', process.env.SHOP_PHONE || '01700000000');
  insertSetting.run('shop_email', process.env.SHOP_EMAIL || 'info@lungigor.com');
  insertSetting.run('shop_address', process.env.SHOP_ADDRESS || 'ঢাকা, বাংলাদেশ');
  insertSetting.run('shop_address_en', 'Dhaka, Bangladesh');
  insertSetting.run('shipping_inside_dhaka', '60');
  insertSetting.run('shipping_outside_dhaka', '120');
  insertSetting.run('free_shipping_above', '1500');
  insertSetting.run('facebook_url', 'https://facebook.com');
  insertSetting.run('instagram_url', '');
  insertSetting.run('whatsapp', '01700000000');
  insertSetting.run('bkash_env', 'sandbox');
  insertSetting.run('bkash_mode', 'auto');
  insertSetting.run('smtp_from_name', 'Lungi Ghar');
  insertSetting.run('announcement_enabled', '1');
  insertSetting.run('announcement_text', 'লুঙ্গি ঘর-এ স্বাগতম! সারাদেশে ক্যাশ অন ডেলিভারি এবং ১৫০০ টাকার অর্ডারে ফ্রি ডেলিভারি!');
  insertSetting.run('announcement_text_en', 'Welcome to Lungi Ghar! Cash on delivery all over Bangladesh & free delivery above ৳1500!');

  // Seed default coupons if table is empty
  const couponCount = db.prepare('SELECT COUNT(*) as count FROM coupons').get().count;
  if (couponCount === 0) {
    const insertCoupon = db.prepare(`
      INSERT OR IGNORE INTO coupons (code, discount_type, discount_value, min_order_amount, is_active)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertCoupon.run('LUNGI10', 'percentage', 10, 800, 1);
    insertCoupon.run('WELCOME50', 'fixed', 50, 500, 1);
  }

  // Seed categories & products only on fresh setup
  const catCount = db.prepare('SELECT COUNT(*) as count FROM categories').get().count;
  if (catCount === 0) {
    const insertCat = db.prepare(
      'INSERT OR IGNORE INTO categories (name, name_en, slug, description, description_en) VALUES (?, ?, ?, ?, ?)'
    );
    insertCat.run(
      'সুতি লুঙ্গি',
      'Cotton Lungis',
      'suti-lungi',
      'খাঁটি সুতি কাপড়ের আরামদায়ক লুঙ্গি',
      'Breathable 100% pure combed cotton handloom lungis'
    );
    insertCat.run(
      'সিল্ক লুঙ্গি',
      'Silk Lungis',
      'silk-lungi',
      'মসৃণ সিল্ক লুঙ্গি বিশেষ অনুষ্ঠানের জন্য',
      'Lustrous silk-blend zari border lungis for Eid & weddings'
    );
    insertCat.run(
      'চেক লুঙ্গি',
      'Checkered Lungis',
      'check-lungi',
      'ক্লাসিক চেক ডিজাইনের লুঙ্গি',
      'Classic yarn-dyed Baburhat plaid check weaves'
    );
    insertCat.run(
      'প্রিন্ট লুঙ্গি',
      'Heritage Print Lungis',
      'print-lungi',
      'বিভিন্ন সুন্দর প্রিন্টের লুঙ্গি',
      'Traditional Jamdani & heritage block-print motif lungis'
    );
  }

  const prodCount = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
  if (prodCount === 0) {
    const insertProduct = db.prepare(`
      INSERT OR IGNORE INTO products (
        name, name_en, slug, description, description_en, price, sale_price,
        category_id, stock, images, sizes, colors, featured, total_sold
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProduct.run(
      'প্রিমিয়াম সুতি লুঙ্গি - আইভরি সাদা',
      'Premium Cotton Lungi - Ivory White',
      'premium-suti-lungi-white',
      'পাবনা ও সিরাজগঞ্জের খাঁটি ১০০% সুতি সুতায় বোনা প্রিমিয়াম মানের লুঙ্গি। দৈর্ঘ্য ৫.৫ হাত, সেলাই করা (রেডি টু ওয়্যার)। দৈনন্দিন ব্যবহারের জন্য অত্যন্ত আরামদায়ক ও রঙ পাকা।',
      'Finely woven 100% pure cotton lungi crafted by Sirajganj master weavers. Pre-stitched 5.5 haat standard length with colorfast emerald & gold border.',
      450, 380, 1, 50,
      JSON.stringify(['/uploads/lungi-suti-white.jpg']),
      JSON.stringify(['ফ্রি সাইজ (৫.৫ হাত)', 'এক্সট্রা লম্বা (৬ হাত)']),
      JSON.stringify(['সাদা', 'ক্রিম']),
      1, 42
    );

    insertProduct.run(
      'রাজকীয় চেক লুঙ্গি - রয়্যাল নীল',
      'Royal Heritage Check Lungi - Indigo Blue',
      'rajkiyo-check-lungi-blue',
      'ঐতিহ্যবাহী বাবুরহাটের চেক ডিজাইনের প্রিমিয়াম লুঙ্গি। ৮০ কাউন্টের মিহি সুতা ব্যবহার করা হয়েছে, গরমে খুবই আরামদায়ক।',
      'Classic Baburhat 80-count yarn-dyed indigo plaid lungi. Ultra-soft handfeel with crisp woven borders and guaranteed zero color bleed.',
      550, 480, 3, 30,
      JSON.stringify(['/uploads/lungi-check-blue.jpg']),
      JSON.stringify(['ফ্রি সাইজ (৫.৫ হাত)', 'এক্সট্রা লম্বা (৬ হাত)']),
      JSON.stringify(['নীল', 'সবুজ', 'মেরুন']),
      1, 65
    );

    insertProduct.run(
      'সিল্ক স্পেশাল জরি লুঙ্গি - সোনালি',
      'Signature Zari Silk Lungi - Antique Gold',
      'silk-special-lungi',
      'বিয়ে, ঈদ ও বিশেষ অনুষ্ঠানের জন্য জরি পাড়ের সেরা সিল্ক লুঙ্গি। আকর্ষণীয় গিফট বক্সসহ পাবেন।',
      'Festive golden silk-blend lungi finished with rich maroon zari border. Ideal for Eid prayers, weddings, and premium gifting.',
      850, 790, 2, 20,
      JSON.stringify(['/uploads/lungi-silk-gold.jpg']),
      JSON.stringify(['ফ্রি সাইজ (৫.৫ হাত)']),
      JSON.stringify(['সোনালি', 'রূপালি', 'মেরুন']),
      1, 28
    );

    insertProduct.run(
      'গ্রীষ্মকালীন পাতলা সুতি লুঙ্গি',
      'Summer Featherlight Cotton Lungi',
      'grism-patla-lungi',
      'গরমের দিনে ঘরে পরার জন্য নরম ও বাতাস চলাচলযোগ্য পাতলা সুতি লুঙ্গি। রঙ উঠবে না গ্যারান্টি।',
      'Airy, featherweight combed cotton lungi designed for humid tropical summers. Pre-washed for immediate softness.',
      350, 290, 1, 100,
      JSON.stringify(['/uploads/lungi-summer-cotton.jpg']),
      JSON.stringify(['ফ্রি সাইজ (৫.৫ হাত)']),
      JSON.stringify(['আকাশী', 'হালকা সবুজ', 'সাদা']),
      0, 91
    );

    insertProduct.run(
      'ঐতিহ্যবাহী জামদানি প্রিন্ট লুঙ্গি',
      'Traditional Jamdani Motif Lungi',
      'oitijhyobahi-print-lungi',
      'বাংলাদেশের ঐতিহ্যবাহী জামদানি মোটিফ দিয়ে প্রিন্ট করা দৃষ্টিনন্দন লুঙ্গি। সেলাইসহ রেডি।',
      'Artisanal heritage motif printed cotton lungi inspired by Bengal Jamdani geometry. Pre-stitched and ready to wear.',
      620, 550, 4, 40,
      JSON.stringify(['/uploads/lungi-print-traditional.jpg']),
      JSON.stringify(['ফ্রি সাইজ (৫.৫ হাত)', 'এক্সট্রা লম্বা (৬ হাত)']),
      JSON.stringify(['লাল', 'সবুজ', 'কমলা']),
      1, 37
    );

    const insertReview = db.prepare(`
      INSERT INTO reviews (product_id, customer_name, rating, comment)
      VALUES (?, ?, ?, ?)
    `);
    insertReview.run(1, 'রফিকুল ইসলাম (ঢাকা)', 5, 'কাপড়ের মান অসাধারণ! একদম খাঁটি সুতি, রঙও পাকা।');
    insertReview.run(2, 'তানভীর আহমেদ (সিলেট)', 5, 'চেক ডিজাইনটা দারুণ লেগেছে, ডেলিভারি ২ দিনেই পেয়েছি।');
    insertReview.run(3, 'মাহমুদুল হাসান (চট্টগ্রাম)', 5, 'বাবাকে ঈদে উপহার দিয়েছি, খুব পছন্দ করেছেন।');
  }
}

if (require.main === module) {
  initDatabase();
  console.log('Database initialized successfully.');
  getDb().close();
}

module.exports = { initDatabase };
