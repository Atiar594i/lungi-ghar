// Automated RBAC & Sub-Admin Verification Test
const http = require('http');

async function run() {
  const app = require('../server');
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(3001, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:3001`;

  console.log('Testing RBAC against', baseUrl);

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

  // 1. Login as Super Admin
  console.log('\n--- 1. Login as Super Admin ---');
  const loginRes = await request('POST', '/admin/login-action', {
    username: 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123'
  });
  console.log('Super Admin login status:', loginRes.status, loginRes.body);
  if (!loginRes.body.success) throw new Error('Super admin login failed');
  const superCookie = loginRes.cookie;

  // 2. Super Admin gets session
  const sessionRes = await request('GET', '/admin/api/session', null, superCookie);
  console.log('Super Admin session:', sessionRes.body);
  if (sessionRes.body.admin.role !== 'super_admin') throw new Error('Expected super_admin role');

  // 3. Super Admin lists admins
  const adminsListRes = await request('GET', '/admin/api/admins', null, superCookie);
  console.log('Admins list count:', adminsListRes.body.admins.length);

  // 4. Create new sub-admin with ONLY products permission
  console.log('\n--- 2. Create Sub-Admin (Product Editor) ---');
  const subAdminUser = 'test_editor_' + Date.now();
  const createRes = await request('POST', '/admin/api/admins', {
    name: 'Kamrul Editor',
    username: subAdminUser,
    password: 'password123',
    role: 'product_editor',
    permissions: ['products']
  }, superCookie);
  console.log('Create sub-admin:', createRes.body);
  if (!createRes.body.success) throw new Error('Failed to create sub-admin: ' + JSON.stringify(createRes.body));
  const newAdminId = createRes.body.adminId;

  // 5. Login as the new sub-admin
  console.log('\n--- 3. Login as Sub-Admin ---');
  const subLoginRes = await request('POST', '/admin/login-action', {
    username: subAdminUser,
    password: 'password123'
  });
  console.log('Sub-Admin login:', subLoginRes.body);
  if (!subLoginRes.body.success) throw new Error('Sub-admin login failed');
  const subCookie = subLoginRes.cookie;

  // 6. Sub-Admin accesses products (ALLOWED)
  console.log('\n--- 4. Verify Allowed Access (Products) ---');
  const prodRes = await request('GET', '/admin/api/products', null, subCookie);
  console.log('Access products status:', prodRes.status, 'success:', prodRes.body.success);
  if (prodRes.status !== 200 || !prodRes.body.success) throw new Error('Sub-admin could not access products');

  // 7. Sub-Admin accesses protected routes (BLOCKED with 403)
  console.log('\n--- 5. Verify Forbidden Access (RBAC Enforcement) ---');
  const forbiddenRoutes = [
    { name: 'Settings', path: '/admin/api/settings' },
    { name: 'Admins Management', path: '/admin/api/admins' },
    { name: 'Orders', path: '/admin/api/orders' },
    { name: 'Coupons', path: '/admin/api/coupons' },
    { name: 'Users', path: '/admin/api/users' }
  ];

  for (const r of forbiddenRoutes) {
    const res = await request('GET', r.path, null, subCookie);
    console.log(`Access ${r.name} (${r.path}): status=${res.status}, body=${JSON.stringify(res.body)}`);
    if (res.status !== 403) {
      throw new Error(`Security breach! Expected 403 Forbidden for ${r.name}, got ${res.status}`);
    }
  }

  // 8. Super Admin grants 'orders' permission to sub-admin
  console.log('\n--- 6. Update Sub-Admin Permissions ---');
  const updateRes = await request('PUT', `/admin/api/admins/${newAdminId}`, {
    name: 'Kamrul Editor & Orders',
    role: 'custom',
    permissions: ['products', 'orders']
  }, superCookie);
  console.log('Update permissions response:', updateRes.body);
  if (!updateRes.body.success) throw new Error('Failed to update permissions');

  // 9. Sub-Admin can now access orders!
  console.log('\n--- 7. Verify Newly Granted Orders Access ---');
  const ordersRes = await request('GET', '/admin/api/orders', null, subCookie);
  console.log('Access orders status:', ordersRes.status, 'success:', ordersRes.body.success);
  if (ordersRes.status !== 200 || !ordersRes.body.success) {
    throw new Error('Sub-admin should now have access to orders');
  }

  // Settings should still be 403
  const settingsRes = await request('GET', '/admin/api/settings', null, subCookie);
  if (settingsRes.status !== 403) throw new Error('Settings should still be forbidden');
  console.log('Settings still forbidden (403): PASS');

  // 10. Super Admin suspends the sub-admin
  console.log('\n--- 8. Suspend Sub-Admin ---');
  const suspendRes = await request('PUT', `/admin/api/admins/${newAdminId}/status`, {
    status: 'suspended'
  }, superCookie);
  console.log('Suspend response:', suspendRes.body);

  // Active session of suspended sub-admin should now be rejected immediately!
  const suspendedReq = await request('GET', '/admin/api/products', null, subCookie);
  console.log('Suspended sub-admin active request status:', suspendedReq.status, suspendedReq.body);
  if (suspendedReq.status !== 403 || !suspendedReq.body.suspended) {
    throw new Error('Suspended sub-admin was not rejected immediately');
  }

  // Login as suspended sub-admin should be rejected
  const loginSuspended = await request('POST', '/admin/login-action', {
    username: subAdminUser,
    password: 'password123'
  });
  console.log('Login suspended sub-admin:', loginSuspended.body);
  if (loginSuspended.body.success) {
    throw new Error('Suspended user should not be able to log in');
  }

  // 11. Reactivate and delete
  console.log('\n--- 9. Reactivate & Delete Sub-Admin ---');
  await request('PUT', `/admin/api/admins/${newAdminId}/status`, { status: 'active' }, superCookie);
  const deleteRes = await request('DELETE', `/admin/api/admins/${newAdminId}`, null, superCookie);
  console.log('Delete sub-admin:', deleteRes.body);
  if (!deleteRes.body.success) throw new Error('Failed to delete sub-admin');

  // 12. Security checks on primary super admin
  console.log('\n--- 10. Verify Primary Super Admin Protections ---');
  const selfDelete = await request('DELETE', '/admin/api/admins/1', null, superCookie);
  console.log('Attempt delete primary super admin:', selfDelete.body);
  if (selfDelete.status !== 400) throw new Error('Primary super admin should not be deletable');

  const selfSuspend = await request('PUT', '/admin/api/admins/1/status', { status: 'suspended' }, superCookie);
  console.log('Attempt suspend primary super admin:', selfSuspend.body);
  if (selfSuspend.status !== 400) throw new Error('Primary super admin should not be suspendable');

  console.log('\n ALL RBAC & SUB-ADMIN TESTS PASSED SUCCESSFULLY! ');
  server.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('\n TEST FAILED:', err);
  process.exit(1);
});
