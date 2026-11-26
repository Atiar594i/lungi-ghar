// Automated Forgot Password & Analytics Verification Test
const http = require('http');

async function run() {
  const app = require('../server');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(3003, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:3003';

  console.log('Testing Forgot Password & Analytics against', baseUrl);

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
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            } catch (_) {
              parsed = data;
            }
            resolve({
              status: res.statusCode,
              headers: res.headers,
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

  // 1. Create a customer to test forgot password
  const testPhone = '018' + Math.floor(10000000 + Math.random() * 90000000);
  const testEmail = `forgot_test_${Date.now()}@example.com`;
  console.log('\n--- 1. Seed verified test user in DB ---');
  const { getDb } = require('../lib/db');
  const db = getDb();
  const bcrypt = require('bcryptjs');
  const hashedOldPass = bcrypt.hashSync('oldPassword123', 10);
  const userRes = db.prepare(`
    INSERT INTO users (name, phone, email, email_verified, password, status)
    VALUES (?, ?, ?, 1, ?, 'active')
  `).run('Forgot Test User', testPhone, testEmail, hashedOldPass);
  const testUserId = userRes.lastInsertRowid;
  console.log('Seeded test user id:', testUserId);

  // 2. Request Forgot Password OTP
  console.log('\n--- 2. Request Forgot Password OTP ---');
  const forgotRes = await request('POST', '/api/auth/forgot-password', {
    identifier: testPhone // Request by phone number
  });
  console.log('Forgot password response:', forgotRes.status, forgotRes.body);
  if (!forgotRes.body.success) {
    throw new Error('Forgot password request failed: ' + forgotRes.body.message);
  }

  // Set known code for testing in email_verifications
  const testCode = '789123';
  const testCodeHash = bcrypt.hashSync(testCode, 8);
  db.prepare('UPDATE email_verifications SET code_hash = ? WHERE user_id = ?').run(testCodeHash, testUserId);
  console.log('Test reset code prepared:', testCode);

  // 3. Attempt reset with wrong code
  console.log('\n--- 3. Attempt reset with wrong code ---');
  const wrongRes = await request('POST', '/api/auth/reset-password', {
    email: testEmail,
    code: '000000',
    new_password: 'brandNewPassword123'
  });
  console.log('Wrong code response:', wrongRes.status, wrongRes.body);
  if (wrongRes.status !== 400 || wrongRes.body.success) {
    throw new Error('Should reject invalid reset code');
  }

  // 4. Reset with valid code
  console.log('\n--- 4. Reset with valid code ---');
  const successReset = await request('POST', '/api/auth/reset-password', {
    email: testEmail,
    code: testCode,
    new_password: 'brandNewPassword123'
  });
  console.log('Reset response:', successReset.status, successReset.body);
  if (!successReset.body.success) {
    throw new Error('Valid reset failed: ' + successReset.body.message);
  }

  // 5. Old password login must fail
  console.log('\n--- 5. Verify old password fails ---');
  const oldLogin = await request('POST', '/api/auth/login', {
    identifier: testEmail,
    password: 'oldPassword123'
  });
  console.log('Old password login status:', oldLogin.status);
  if (oldLogin.status !== 401 || oldLogin.body.success) {
    throw new Error('Old password should no longer work');
  }

  // 6. New password login must succeed
  console.log('\n--- 6. Verify new password succeeds ---');
  const newLogin = await request('POST', '/api/auth/login', {
    identifier: testEmail,
    password: 'brandNewPassword123'
  });
  console.log('New password login status:', newLogin.status, 'User:', newLogin.body.user?.email);
  if (!newLogin.body.success) {
    throw new Error('New password login failed');
  }

  // 7. Verify /forgot-password page serves 200
  console.log('\n--- 7. Verify /forgot-password HTML route ---');
  const pageRes = await request('GET', '/forgot-password');
  console.log('/forgot-password status:', pageRes.status);
  if (pageRes.status !== 200) throw new Error('Forgot password page not found');

  // 8. Verify /js/firebase-analytics.js serves 200 and contains G-FXY7NMQENH
  console.log('\n--- 8. Verify /js/firebase-analytics.js ---');
  const analyticsRes = await request('GET', '/js/firebase-analytics.js');
  console.log('/js/firebase-analytics.js status:', analyticsRes.status);
  if (analyticsRes.status !== 200 || !analyticsRes.body.includes('G-FXY7NMQENH')) {
    throw new Error('Analytics file does not contain measurement ID');
  }

  console.log('\n ALL FORGOT PASSWORD & ANALYTICS TESTS PASSED! ');
  server.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('\n TEST FAILED:', err);
  process.exit(1);
});
