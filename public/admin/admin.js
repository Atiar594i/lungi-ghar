// Admin Common JS - public/admin/admin.js
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer') || (() => {
    const el = document.createElement('div');
    el.className = 'toast-container';
    el.id = 'toastContainer';
    document.body.appendChild(el);
    return el;
  })();
  const iconName = type === 'success' ? 'checkCircle' : type === 'error' ? 'alertCircle' : 'info';
  const icon = typeof svgIcon === 'function' ? svgIcon(iconName, 16) : '';
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const loc = typeof getLang === 'function' && getLang() === 'en' ? 'en-US' : 'bn-BD';
  return d.toLocaleDateString(loc) + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
}

function getStatusLabels() {
  if (typeof t === 'function') {
    return {
      pending: t('status_pending'),
      confirmed: t('status_confirmed'),
      processing: t('status_processing'),
      shipped: t('status_shipped'),
      delivered: t('status_delivered'),
      cancelled: t('status_cancelled')
    };
  }
  return {
    pending: 'অপেক্ষামান', confirmed: 'নিশ্চিত', processing: 'প্রক্রিয়াধীন',
    shipped: 'পাঠানো হয়েছে', delivered: 'ডেলিভারি সম্পন্ন', cancelled: 'বাতিল'
  };
}

function getPaymentStatusLabels() {
  if (typeof t === 'function') {
    return { pending: t('pay_pending'), paid: t('pay_paid'), failed: t('pay_failed') };
  }
  return { pending: 'অপেক্ষামান', paid: 'পরিশোধিত', failed: 'ব্যর্থ' };
}

const statusClasses = {
  pending: 'badge-pending',
  confirmed: 'badge-confirmed',
  processing: 'badge-processing',
  shipped: 'badge-shipped',
  delivered: 'badge-delivered',
  cancelled: 'badge-cancelled'
};

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('open');
  let backdrop = document.getElementById('sidebarBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'sidebarBackdrop';
    backdrop.className = 'sidebar-backdrop';
    backdrop.onclick = toggleSidebar;
    document.body.appendChild(backdrop);
  }
  backdrop.classList.toggle('open', sidebar.classList.contains('open'));
}

let _currentAdmin = null;
let _activeAdminPage = '';

function renderAdminSidebar(activePage, admin) {
  if (activePage) _activeAdminPage = activePage;
  if (admin) _currentAdmin = admin;
  const current = admin || _currentAdmin;
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar || typeof svgIcon !== 'function') return;
  const en = typeof getLang === 'function' && getLang() === 'en';

  const allNav = [
    { key: 'dashboard', href: '/admin/dashboard', icon: 'chart', label: en ? 'Overview' : 'ড্যাশবোর্ড', perm: null },
    { key: 'orders', href: '/admin/orders', icon: 'package', label: en ? 'Orders' : 'অর্ডারসমূহ', perm: 'orders', badge: true },
    { key: 'products', href: '/admin/products', icon: 'bag', label: en ? 'Products' : 'পণ্যসমূহ', perm: 'products' },
    { key: 'categories', href: '/admin/categories', icon: 'layers', label: en ? 'Categories' : 'ক্যাটাগরি', perm: 'categories' },
    { key: 'customers', href: '/admin/customers', icon: 'users', label: en ? 'Users & Buyers' : 'ইউজার ও ক্রেতা', perm: 'customers' },
    { key: 'coupons', href: '/admin/coupons', icon: 'sparkles', label: en ? 'Coupons & Promo' : 'কুপন ও ডিসকাউন্ট', perm: 'coupons' },
    { key: 'settings', href: '/admin/settings', icon: 'settings', label: en ? 'Settings & bKash' : 'সেটিংস ও বিকাশ', perm: 'settings' },
    { key: 'admins', href: '/admin/admins', icon: 'shield', label: en ? 'Admins & Roles' : 'অ্যাডমিন ও রোল', perm: 'admins' }
  ];

  const canAccess = (item) => {
    if (!item.perm) return true;
    if (!current) return true;
    if (current.role === 'super_admin') return true;
    const perms = Array.isArray(current.permissions) ? current.permissions : [];
    if (perms.includes('all')) return true;
    return perms.includes(item.perm);
  };

  const nav = allNav.filter(canAccess);

  sidebar.innerHTML = `
    <div class="sidebar-logo">
      <div class="sidebar-logo-mark">${svgIcon('layers', 18)}</div>
      <div>
        <div class="title">${en ? 'Lungi Ghar' : 'লুঙ্গি ঘর'}</div>
        <div class="sub">${en ? 'Admin Console' : 'অ্যাডমিন প্যানেল'}</div>
      </div>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-section">
        <div class="nav-section-title">${en ? 'Management' : 'ব্যবস্থাপনা'}</div>
        ${nav.map(item => `
          <a href="${item.href}" class="sidebar-link ${_activeAdminPage === item.key ? 'active' : ''}">
            <span class="icon">${svgIcon(item.icon, 17)}</span>
            <span>${item.label}</span>
            ${item.badge ? '<span class="badge" id="pendingBadge" style="display:none;">0</span>' : ''}
          </a>
        `).join('')}
      </div>
      <div class="nav-section">
        <div class="nav-section-title">${en ? 'Storefront' : 'অন্যান্য'}</div>
        <a href="/" target="_blank" class="sidebar-link">
          <span class="icon">${svgIcon('externalLink', 17)}</span>
          <span>${en ? 'View Storefront' : 'ওয়েবসাইট দেখুন'}</span>
        </a>
        <a href="/admin/logout" class="sidebar-link" style="color:#fca5a5;">
          <span class="icon">${svgIcon('logOut', 17)}</span>
          <span>${en ? 'Sign Out' : 'লগআউট'}</span>
        </a>
      </div>
    </nav>
  `;
}

document.addEventListener('DOMContentLoaded', () => {
  // Hook language switch to keep admin sidebar localized
  if (typeof window.setLang === 'function' && !window._adminLangHooked) {
    window._adminLangHooked = true;
    const prevSetLang = window.setLang;
    window.setLang = function (lang) {
      prevSetLang(lang);
      renderAdminSidebar(_activeAdminPage);
    };
  }

  const topbar = document.querySelector('.admin-topbar');
  if (topbar) {
    if (!topbar.querySelector('.mobile-menu-btn')) {
      const btn = document.createElement('button');
      btn.className = 'mobile-menu-btn';
      btn.type = 'button';
      btn.innerHTML = typeof svgIcon === 'function' ? svgIcon('menu', 18) : '=';
      btn.onclick = toggleSidebar;
      topbar.insertBefore(btn, topbar.firstChild);
    }
    const actions = topbar.querySelector('.topbar-actions');
    if (actions && !actions.querySelector('[data-lang-switcher]')) {
      const holder = document.createElement('div');
      holder.setAttribute('data-lang-switcher', '');
      actions.insertBefore(holder, actions.firstChild);
      if (typeof renderLangSwitchers === 'function') renderLangSwitchers();
    }
  }
});

async function checkSession() {
  const data = await fetch('/admin/api/session').then(r => r.json()).catch(() => null);
  if (!data || !data.admin) {
    window.location.href = '/admin/login';
    return null;
  }
  _currentAdmin = data.admin;
  renderAdminSidebar(_activeAdminPage, data.admin);

  const avatar = document.querySelector('.admin-avatar');
  if (avatar && data.admin.name) avatar.textContent = data.admin.name[0].toUpperCase();
  return data.admin;
}
