// Firebase Cloud Firestore Service (Spark Free Plan Optimized) - lib/firebase.js
const fs = require('fs');
const path = require('path');

let adminModule = null;
let firestoreModule = null;
let activeApp = null;
let activeConfigHash = '';
let lastInitError = null;

function loadAdminSdk() {
  if (!adminModule) {
    adminModule = require('firebase-admin');
    try {
      firestoreModule = require('firebase-admin/firestore');
    } catch (_) {}
  }
  return adminModule;
}

function getServiceAccountFromConfig(db) {
  // 1. Check DB settings first (configured via Admin Panel)
  if (db) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'firebase_service_account_json'").get();
      if (row && row.value && row.value.trim().startsWith('{')) {
        return JSON.parse(row.value.trim());
      }
    } catch (err) {
      lastInitError = 'Invalid Firebase Service Account JSON in Settings';
      return null;
    }
  }

  // 2. Check local file firebase-service-account.json
  const jsonFile = path.join(__dirname, '..', 'firebase-service-account.json');
  if (fs.existsSync(jsonFile)) {
    try {
      return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    } catch (err) {
      lastInitError = 'Invalid firebase-service-account.json file';
      return null;
    }
  }

  // 3. Check .env
  if (process.env.FIREBASE_SERVICE_ACCOUNT && process.env.FIREBASE_SERVICE_ACCOUNT.trim().startsWith('{')) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT.trim());
    } catch (_) {}
  }

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }

  return null;
}

function getFirestore(db) {
  const sa = getServiceAccountFromConfig(db);
  if (!sa || !sa.project_id || !sa.client_email || !sa.private_key) {
    return null;
  }

  const hash = `${sa.project_id}|${sa.client_email}|${sa.private_key.slice(0, 40)}`;
  const admin = loadAdminSdk();
  const getFs = (app) => {
    if (firestoreModule && typeof firestoreModule.getFirestore === 'function') {
      return firestoreModule.getFirestore(app);
    }
    if (typeof app.firestore === 'function') {
      return app.firestore();
    }
    return admin.firestore(app);
  };

  if (activeApp && activeConfigHash === hash) {
    return getFs(activeApp);
  }

  try {
    const appName = 'lungi-ghar-' + Buffer.from(hash).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const existingApps = typeof admin.getApps === 'function' ? admin.getApps() : (admin.apps || []);
    const existing = existingApps.find((a) => a && a.name === appName);
    const cert = admin.cert ? admin.cert(sa) : (admin.credential ? admin.credential.cert(sa) : null);
    activeApp = existing || admin.initializeApp({ credential: cert }, appName);
    activeConfigHash = hash;
    lastInitError = null;
    return getFs(activeApp);
  } catch (err) {
    lastInitError = err.message;
    console.error('Firebase init error:', err.message);
    return null;
  }
}

function resetFirebaseCache() {
  activeConfigHash = '';
  lastInitError = null;
}

function getFirebaseStatus(db) {
  const sa = getServiceAccountFromConfig(db);
  if (!sa) {
    return { configured: false, projectId: null, error: lastInitError };
  }
  return {
    configured: Boolean(sa.project_id && sa.client_email && sa.private_key),
    projectId: sa.project_id || null,
    clientEmail: sa.client_email || null,
    error: lastInitError
  };
}

function computeTotalsSnapshot(db) {
  const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
  const pendingOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'pending'").get().count;
  const confirmedOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'confirmed'").get().count;
  const deliveredOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'delivered'").get().count;
  const cancelledOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'cancelled'").get().count;

  const totalRevenue =
    db
      .prepare("SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE order_status != 'cancelled' AND (payment_status = 'paid' OR payment_method = 'cod')")
      .get().sum || 0;

  const bkashOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE payment_method = 'bkash'").get().count;
  const codOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE payment_method = 'cod'").get().count;
  const paidBkashRevenue =
    db.prepare("SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE payment_method = 'bkash' AND payment_status = 'paid'").get().sum || 0;

  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const verifiedUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE email_verified = 1').get().count;
  const activeUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'active'").get().count;
  const totalProducts = db.prepare('SELECT COUNT(*) as count FROM products WHERE active = 1').get().count;
  const totalCategories = db.prepare('SELECT COUNT(*) as count FROM categories').get().count;
  const totalSubscribers = db.prepare('SELECT COUNT(*) as count FROM subscribers').get().count;

  return {
    totalOrders,
    pendingOrders,
    confirmedOrders,
    deliveredOrders,
    cancelledOrders,
    totalRevenue: Number(totalRevenue),
    bkashOrders,
    codOrders,
    paidBkashRevenue: Number(paidBkashRevenue),
    totalUsers,
    verifiedUsers,
    activeUsers,
    totalProducts,
    totalCategories,
    totalSubscribers,
    updatedAt: new Date().toISOString()
  };
}

async function syncTotalsToFirebase(db) {
  const firestore = getFirestore(db);
  if (!firestore) return false;
  try {
    const snapshot = computeTotalsSnapshot(db);
    await firestore.collection('analytics').doc('totals').set(snapshot, { merge: true });
    return true;
  } catch (err) {
    console.error('Firebase totals sync error:', err.message);
    return false;
  }
}

async function syncDoc(db, collection, docId, payload, alsoTotals = false) {
  const firestore = getFirestore(db);
  if (!firestore) return false;
  try {
    await firestore.collection(collection).doc(String(docId)).set(payload, { merge: true });
    if (alsoTotals) {
      await syncTotalsToFirebase(db);
    }
    return true;
  } catch (err) {
    console.error(`Firebase sync error (${collection}/${docId}):`, err.message);
    return false;
  }
}

async function deleteDoc(db, collection, docId, alsoTotals = false) {
  const firestore = getFirestore(db);
  if (!firestore) return false;
  try {
    await firestore.collection(collection).doc(String(docId)).delete();
    if (alsoTotals) {
      await syncTotalsToFirebase(db);
    }
    return true;
  } catch (err) {
    console.error(`Firebase delete error (${collection}/${docId}):`, err.message);
    return false;
  }
}

async function testFirebaseConnection(db) {
  const firestore = getFirestore(db);
  if (!firestore) {
    return {
      success: false,
      message: lastInitError || 'Firebase Service Account JSON সেট করা হয়নি।'
    };
  }
  try {
    const totals = computeTotalsSnapshot(db);
    await firestore.collection('analytics').doc('totals').set(totals, { merge: true });
    const doc = await firestore.collection('analytics').doc('totals').get();
    const status = getFirebaseStatus(db);
    return {
      success: doc.exists,
      projectId: status.projectId,
      message: `Firebase Firestore (${status.projectId}) সফলভাবে কানেক্ট হয়েছে!`
    };
  } catch (err) {
    return {
      success: false,
      message: `Firebase কানেকশন ব্যর্থ: ${err.message}`
    };
  }
}

async function syncAllToFirestore(db) {
  const firestore = getFirestore(db);
  if (!firestore) {
    return { success: false, message: 'প্রথমে Firebase Service Account JSON সংরক্ষণ করুন।' };
  }

  try {
    const ops = [];

    const categories = db.prepare('SELECT * FROM categories').all();
    for (const c of categories) {
      ops.push({
        ref: firestore.collection('categories').doc(String(c.id)),
        data: {
          id: c.id,
          name: c.name,
          name_en: c.name_en || '',
          slug: c.slug,
          description: c.description || '',
          description_en: c.description_en || '',
          created_at: c.created_at
        }
      });
    }

    const products = db.prepare('SELECT * FROM products').all();
    for (const p of products) {
      ops.push({
        ref: firestore.collection('products').doc(String(p.id)),
        data: {
          id: p.id,
          name: p.name,
          name_en: p.name_en || '',
          slug: p.slug,
          description: p.description || '',
          description_en: p.description_en || '',
          price: p.price,
          sale_price: p.sale_price || null,
          category_id: p.category_id || null,
          stock: p.stock,
          images: JSON.parse(p.images || '[]'),
          sizes: JSON.parse(p.sizes || '[]'),
          colors: JSON.parse(p.colors || '[]'),
          featured: Boolean(p.featured),
          active: Boolean(p.active),
          total_sold: p.total_sold || 0,
          created_at: p.created_at
        }
      });
    }

    const users = db
      .prepare('SELECT id, name, phone, email, email_verified, district, address, status, created_at, last_login FROM users')
      .all();
    for (const u of users) {
      ops.push({
        ref: firestore.collection('users').doc(String(u.id)),
        data: {
          id: u.id,
          name: u.name,
          phone: u.phone,
          email: u.email || '',
          email_verified: Boolean(u.email_verified),
          district: u.district || '',
          address: u.address || '',
          status: u.status,
          created_at: u.created_at,
          last_login: u.last_login || null
        }
      });
    }

    const orders = db.prepare('SELECT * FROM orders').all();
    for (const o of orders) {
      ops.push({
        ref: firestore.collection('orders').doc(String(o.order_number)),
        data: {
          id: o.id,
          order_number: o.order_number,
          user_id: o.user_id || null,
          customer_name: o.customer_name,
          customer_phone: o.customer_phone,
          customer_email: o.customer_email || '',
          shipping_address: o.shipping_address,
          district: o.district,
          thana: o.thana || '',
          items: JSON.parse(o.items || '[]'),
          subtotal: o.subtotal,
          shipping_cost: o.shipping_cost,
          total: o.total,
          payment_method: o.payment_method,
          payment_status: o.payment_status,
          order_status: o.order_status,
          bkash_transaction_id: o.bkash_transaction_id || '',
          created_at: o.created_at
        }
      });
    }

    const subscribers = db.prepare('SELECT * FROM subscribers').all();
    for (const s of subscribers) {
      ops.push({
        ref: firestore.collection('subscribers').doc(String(s.phone)),
        data: { phone: s.phone, created_at: s.created_at }
      });
    }

    const totals = computeTotalsSnapshot(db);
    ops.push({
      ref: firestore.collection('analytics').doc('totals'),
      data: totals
    });

    // Batch write in chunks of 400 (Spark Free Plan safe)
    for (let i = 0; i < ops.length; i += 400) {
      const batch = firestore.batch();
      const slice = ops.slice(i, i + 400);
      for (const item of slice) {
        batch.set(item.ref, item.data, { merge: true });
      }
      await batch.commit();
    }

    return {
      success: true,
      syncedCount: ops.length,
      totals,
      message: `Firebase-এ মোট ${ops.length} টি ডকুমেন্ট এবং ড্যাশবোর্ড টোটাল সিঙ্ক সম্পন্ন হয়েছে!`
    };
  } catch (err) {
    console.error('Firebase syncAll error:', err.message);
    return { success: false, message: `সিঙ্ক ব্যর্থ হয়েছে: ${err.message}` };
  }
}

async function getFirebaseTotals(db) {
  const firestore = getFirestore(db);
  if (!firestore) return null;
  try {
    const doc = await firestore.collection('analytics').doc('totals').get();
    return doc.exists ? doc.data() : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getFirestore,
  getFirebaseStatus,
  resetFirebaseCache,
  computeTotalsSnapshot,
  syncTotalsToFirebase,
  syncDoc,
  deleteDoc,
  testFirebaseConnection,
  syncAllToFirestore,
  getFirebaseTotals
};
