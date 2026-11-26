// Cart, Wishlist & Shared Auth Header Helpers - public/js/cart.js
let cart = JSON.parse(localStorage.getItem('lungi_cart') || '[]');
let wishlist = JSON.parse(localStorage.getItem('lungi_wishlist') || '[]');
window.currentUser = null;

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function saveCart() {
  localStorage.setItem('lungi_cart', JSON.stringify(cart));
  updateCartUI();
}

function addToCart(productId, name, price, image, selectedColor, selectedSize, qty = 1, shouldOpenCart = true, nameEn = '') {
  const color = selectedColor || '';
  const size = selectedSize || 'ফ্রি সাইজ (৫.৫ হাত)';
  const addQty = Math.max(1, parseInt(qty, 10) || 1);

  const existingItem = cart.find(
    (i) => i.product_id === productId && (i.color || '') === color && (i.size || 'ফ্রি সাইজ (৫.৫ হাত)') === size
  );

  if (existingItem) {
    existingItem.quantity += addQty;
  } else {
    cart.push({
      product_id: productId,
      name,
      name_en: nameEn || name,
      price,
      image: image || '/img/no-image.svg',
      color,
      size,
      quantity: addQty
    });
  }

  saveCart();
  const msg = typeof t === 'function' && getLang() === 'en' ? 'Added to cart' : 'পণ্যটি কার্টে যোগ হয়েছে';
  showToast(msg, 'success');
  if (shouldOpenCart) openCart();
}

function removeFromCart(index) {
  cart.splice(index, 1);
  saveCart();
  renderCartItems();
}

function updateCartQty(index, delta) {
  cart[index].quantity = Math.max(1, cart[index].quantity + delta);
  saveCart();
  renderCartItems();
}

function updateCartUI() {
  const badge = document.getElementById('cartBadge');
  const totalItems = cart.reduce((sum, i) => sum + i.quantity, 0);

  if (badge) {
    badge.textContent = totalItems;
    badge.style.display = totalItems > 0 ? 'flex' : 'none';
  }
  renderCartItems();
}

function renderCartItems() {
  const cartItemsEl = document.getElementById('cartItems');
  const cartFooter = document.getElementById('cartFooter');
  if (!cartItemsEl) return;

  const isEn = typeof getLang === 'function' && getLang() === 'en';
  const fmt = typeof formatPrice === 'function' ? formatPrice : (n) => '৳' + n;
  const trAttr = typeof translateAttr === 'function' ? translateAttr : (v) => v;

  if (cart.length === 0) {
    const emptyT = typeof t === 'function' ? t('cart_empty_t') : 'কার্ট খালি';
    const emptyD = typeof t === 'function' ? t('cart_empty_d') : 'পছন্দের লুঙ্গি যোগ করুন';
    const bagIcon = typeof svgIcon === 'function' ? svgIcon('bag', 42) : '';
    cartItemsEl.innerHTML = `
      <div class="empty-cart">
        <div class="empty-icon-circle">${bagIcon}</div>
        <h3>${escapeHtml(emptyT)}</h3>
        <p>${escapeHtml(emptyD)}</p>
      </div>
    `;
    if (cartFooter) cartFooter.style.display = 'none';
    return;
  }

  const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const trashIcon = typeof svgIcon === 'function' ? svgIcon('trash', 16) : '×';

  cartItemsEl.innerHTML = cart
    .map((item, idx) => {
      const title = isEn && item.name_en ? item.name_en : item.name;
      const colorTxt = item.color ? trAttr(item.color) : '';
      const sizeTxt = trAttr(item.size);
      return `
    <div class="cart-item">
      <img class="cart-item-img" src="${escapeHtml(item.image)}" alt="${escapeHtml(title)}" onerror="this.src='/img/no-image.svg'">
      <div class="cart-item-info">
        <div class="cart-item-name">${escapeHtml(title)}</div>
        <div class="cart-item-meta">${colorTxt ? escapeHtml(colorTxt) + ' · ' : ''}${escapeHtml(sizeTxt)}</div>
        <div class="cart-item-price">${fmt(item.price * item.quantity)}</div>
        <div class="cart-qty">
          <button type="button" class="qty-btn" onclick="updateCartQty(${idx}, -1)">−</button>
          <span class="qty-num">${item.quantity}</span>
          <button type="button" class="qty-btn" onclick="updateCartQty(${idx}, 1)">+</button>
        </div>
      </div>
      <button type="button" class="cart-remove" onclick="removeFromCart(${idx})" aria-label="Remove">${trashIcon}</button>
    </div>
  `;
    })
    .join('');

  document.getElementById('cartSubtotal').textContent = fmt(subtotal);
  document.getElementById('cartTotal').textContent = fmt(subtotal);
  if (cartFooter) cartFooter.style.display = 'block';
}

function openCart() {
  document.getElementById('cartSidebar')?.classList.add('open');
  document.getElementById('cartOverlay')?.classList.add('open');
  document.body.style.overflow = 'hidden';
  renderCartItems();
}

function closeCart() {
  document.getElementById('cartSidebar')?.classList.remove('open');
  document.getElementById('cartOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
}

async function ensureLoggedIn(redirectTarget = '/checkout') {
  try {
    const res = await fetch('/api/auth/me').then((r) => r.json());
    window.currentUser = res.user || null;
  } catch (_) {
    window.currentUser = null;
  }
  renderAuthHeader();

  if (!window.currentUser) {
    const msg = typeof t === 'function' ? t('login_required_checkout') : 'চেকআউট করতে অনুগ্রহ করে আগে লগইন করুন';
    showToast(msg, 'info', 2500);
    setTimeout(() => {
      window.location.href = `/login?redirect=${encodeURIComponent(redirectTarget)}`;
    }, 550);
    return false;
  }
  return true;
}

async function goToCheckout() {
  if (cart.length === 0) {
    showToast(typeof t === 'function' ? t('cart_empty_t') : 'কার্ট খালি', 'error');
    return;
  }
  closeCart();
  const ok = await ensureLoggedIn('/checkout');
  if (ok) {
    window.location.href = '/checkout';
  }
}

function clearCart() {
  cart = [];
  saveCart();
}

function isWishlisted(productId) {
  return wishlist.includes(productId);
}

function toggleWishlist(productId, btnEl) {
  const idx = wishlist.indexOf(productId);
  const isEn = typeof getLang === 'function' && getLang() === 'en';
  if (idx > -1) {
    wishlist.splice(idx, 1);
    if (btnEl) {
      btnEl.classList.remove('active');
      btnEl.innerHTML = typeof svgIcon === 'function' ? svgIcon('heart', 17) : '';
    }
    showToast(isEn ? 'Removed from wishlist' : 'উইশলিস্ট থেকে সরানো হয়েছে', 'info');
  } else {
    wishlist.push(productId);
    if (btnEl) {
      btnEl.classList.add('active');
      btnEl.innerHTML = typeof svgIcon === 'function' ? svgIcon('heartFilled', 17) : '';
    }
    showToast(isEn ? 'Saved to wishlist' : 'উইশলিস্টে সংরক্ষিত হয়েছে', 'success');
  }
  localStorage.setItem('lungi_wishlist', JSON.stringify(wishlist));
}

function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const iconName = type === 'success' ? 'checkCircle' : type === 'error' ? 'alertCircle' : 'info';
  const iconHtml = typeof svgIcon === 'function' ? svgIcon(iconName, 17) : '';

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${iconHtml}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => toast.remove(), duration);
}

async function initAuthHeader() {
  const slot = document.getElementById('authHeaderSlot');
  if (!slot) return null;
  try {
    const res = await fetch('/api/auth/me').then((r) => r.json());
    window.currentUser = res.user || null;
  } catch (_) {
    window.currentUser = null;
  }
  renderAuthHeader();
  return window.currentUser;
}

function renderAuthHeader() {
  const slot = document.getElementById('authHeaderSlot');
  if (!slot) return;
  const userIcon = typeof svgIcon === 'function' ? svgIcon(window.currentUser ? 'userCheck' : 'user', 18) : '';

  if (window.currentUser) {
    const first = window.currentUser.name.split(' ')[0];
    slot.innerHTML = `
      <a href="/account" class="action-btn account-pill" title="${escapeHtml(window.currentUser.name)}">
        <span class="icon">${userIcon}</span>
        <span class="label">${escapeHtml(first)}</span>
      </a>
    `;
  } else {
    const loginLabel = typeof t === 'function' ? t('login') : 'লগইন';
    slot.innerHTML = `
      <a href="/login" class="action-btn account-pill">
        <span class="icon">${userIcon}</span>
        <span class="label" data-i18n="login">${escapeHtml(loginLabel)}</span>
      </a>
    `;
  }
}
