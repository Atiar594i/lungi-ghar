// Full System End-to-End Test
const http = require('http');

async function run() {
  const app = require('../server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(3002, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:3002';

  console.log('Running Full System Tests against', baseUrl);

  function request(method, path, body, cookie = '') {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {})
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            const setCookie = res.headers['set-cookie'];
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            } catch (_) {
              parsed = data;
            }
            resolve({
              status: res.statusCode,
              headers: res.headers,
              cookie: setCookie ? setCookie.map((c) => c.split(';')[0]).join('; ') : cookie,
              body: parsed
            });
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 1. Storefront APIs
  console.log('\n=== 1. Storefront APIs ===');
  const prods = await request('GET', '/api/products');
  console.log('Products API status:', prods.status, 'Count:', prods.body.products?.length);
  if (!prods.body.products || prods.body.products.length === 0) throw new Error('No products found');
  const testProduct = prods.body.products[0];

  const cats = await request('GET', '/api/categories');
  console.log('Categories API status:', cats.status, 'Count:', cats.body.categories?.length);

  const settings = await request('GET', '/api/settings');
  console.log('Public Settings API status:', settings.status, 'Shop:', settings.body.settings?.shop_name);
  if (settings.body.settings?.bkash_app_secret || settings.body.settings?.firebase_service_account_json) {
    throw new Error('Public settings leaked sensitive credentials!');
  }

  // 2. User Registration, OTP Verification, Profile & Address Book
  console.log('\n=== 2. User Registration & Address Book ===');
  const testPhone = '017' + Math.floor(10000000 + Math.random() * 90000000);
  const testEmail = `user_${Date.now()}@test.com`;

  const regRes = await request('POST', '/api/auth/register', {
    name: 'Customer Test',
    phone: testPhone,
    email: testEmail,
    password: 'password123'
  });
  console.log('Registration status:', regRes.status, 'Success:', regRes.body.success, 'RequiresVerification:', regRes.body.requiresVerification);
  if (!regRes.body.success) throw new Error('Customer registration failed: ' + regRes.body.message);

  const otpCode = regRes.body.demoCode || '123456';
  const verifyRes = await request('POST', '/api/auth/verify-email', {
    email: testEmail,
    code: otpCode
  });
  console.log('OTP Verification status:', verifyRes.status, 'Success:', verifyRes.body.success);
  if (!verifyRes.body.success) throw new Error('Email verification failed: ' + verifyRes.body.message);
  const userCookie = verifyRes.cookie;

  // Update address book via /api/auth/profile
  const addrRes = await request('PUT', '/api/auth/profile', {
    name: 'Customer Test Updated',
    district: 'সিরাজগঞ্জ',
    address: 'তাঁত পল্লী, বেলকুচি, সিরাজগঞ্জ'
  }, userCookie);
  console.log('Update Address Book:', addrRes.body);
  if (!addrRes.body.success) throw new Error('Address book update failed');

  // Verify address in profile via /api/auth/me
  const profileRes = await request('GET', '/api/auth/me', null, userCookie);
  console.log('Profile district:', profileRes.body.user.district, 'Address:', profileRes.body.user.address);
  if (profileRes.body.user.district !== 'সিরাজগঞ্জ') throw new Error('District mismatch');

  // 3. Checkout (COD Order)
  console.log('\n=== 3. Checkout Order ===');
  const orderRes = await request('POST', '/api/orders', {
    customer_name: 'Customer Test',
    customer_phone: testPhone,
    customer_email: testEmail,
    district: 'সিরাজগঞ্জ',
    shipping_address: 'তাঁত পল্লী, বেলকুচি, সিরাজগঞ্জ',
    payment_method: 'cod',
    items: [
      {
        product_id: testProduct.id,
        quantity: 2,
        size: testProduct.sizes?.[0] || 'ফ্রি সাইজ',
        color: testProduct.colors?.[0] || 'নীল'
      }
    ]
  }, userCookie);
  console.log('Order creation:', orderRes.body);
  if (!orderRes.body.success) throw new Error('Order creation failed: ' + orderRes.body.message);
  const orderNumber = orderRes.body.order_number;

  // View order in user profile via /api/auth/orders
  const myOrders = await request('GET', '/api/auth/orders', null, userCookie);
  console.log('User orders count:', myOrders.body.orders.length, 'Latest order:', myOrders.body.orders[0]?.order_number);
  if (myOrders.body.orders[0]?.order_number !== orderNumber) throw new Error('Order not found in user history');

  // 4. Admin Management & RBAC
  console.log('\n=== 4. Admin RBAC Verification ===');
  const adminLogin = await request('POST', '/admin/login-action', {
    username: 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123'
  });
  if (!adminLogin.body.success) throw new Error('Admin login failed');
  const superCookie = adminLogin.cookie;

  // Create an Order Operator sub-admin (can only view & update orders)
  const operatorUsername = 'op_' + Date.now();
  const opCreate = await request('POST', '/admin/api/admins', {
    name: 'Order Operator',
    username: operatorUsername,
    password: 'password123',
    role: 'order_operator',
    permissions: ['orders']
  }, superCookie);
  console.log('Create operator:', opCreate.body);
  if (!opCreate.body.success) throw new Error('Failed to create operator');
  const opId = opCreate.body.adminId;

  // Operator login
  const opLogin = await request('POST', '/admin/login-action', {
    username: operatorUsername,
    password: 'password123'
  });
  const opCookie = opLogin.cookie;

  // Operator views orders (ALLOWED)
  const opOrders = await request('GET', '/admin/api/orders', null, opCookie);
  console.log('Operator orders access:', opOrders.status, 'Total orders:', opOrders.body.total);
  if (opOrders.status !== 200) throw new Error('Operator should have access to orders');

  // Operator updates order status to 'confirmed' (ALLOWED)
  const targetOrderId = myOrders.body.orders[0].id;
  const updateStatus = await request('PUT', `/admin/api/orders/${targetOrderId}/status`, {
    order_status: 'confirmed'
  }, opCookie);
  console.log('Operator update status:', updateStatus.body);
  if (!updateStatus.body.success) throw new Error('Operator failed to update order status');

  // Operator tries to access products or settings or admin list (BLOCKED with 403)
  const opBlockProds = await request('GET', '/admin/api/products', null, opCookie);
  const opBlockSettings = await request('GET', '/admin/api/settings', null, opCookie);
  const opBlockAdmins = await request('GET', '/admin/api/admins', null, opCookie);
  console.log('Operator block checks:', {
    products: opBlockProds.status,
    settings: opBlockSettings.status,
    admins: opBlockAdmins.status
  });
  if (opBlockProds.status !== 403 || opBlockSettings.status !== 403 || opBlockAdmins.status !== 403) {
    throw new Error('Operator access violation: non-order endpoints must return 403');
  }

  // Super Admin updates store social media links (ALLOWED)
  console.log('\n=== 5. Super Admin Settings & Social Media Links ===');
  const setSocial = await request('POST', '/admin/api/settings', {
    facebook_url: 'https://facebook.com/lungighar.bd',
    instagram_url: 'https://instagram.com/lungighar.bd',
    whatsapp: '01712345678',
    announcement_text: 'লুঙ্গি ঘর-এ নতুন কালেকশন এসেছে!'
  }, superCookie);
  console.log('Save store settings:', setSocial.body);
  if (!setSocial.body.success) throw new Error('Failed to save settings');

  // Clean up operator
  await request('DELETE', `/admin/api/admins/${opId}`, null, superCookie);
  console.log('Cleaned up test operator');

  console.log('\n ALL SYSTEM TESTS PASSED SUCCESSFULLY! Everything is fully functioning. ');
  server.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('\n SYSTEM TEST FAILED:', err);
  process.exit(1);
});
