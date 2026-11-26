// Google Analytics 4 & Firebase Web Client SDK - public/js/firebase-analytics.js
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyAxTh1m1xp0ujbqMYHf9eCJD2oWCMCZngg",
    authDomain: "lungi-ghar.firebaseapp.com",
    projectId: "lungi-ghar",
    storageBucket: "lungi-ghar.firebasestorage.app",
    messagingSenderId: "645813806862",
    appId: "1:645813806862:web:748cd8b8ed87e985b7195f",
    measurementId: "G-FXY7NMQENH"
  };

  window.firebaseConfig = firebaseConfig;

  // Initialize dataLayer for Google Analytics
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', firebaseConfig.measurementId, {
    send_page_view: true,
    page_location: window.location.href,
    page_path: window.location.pathname
  });

  // Dynamically load Google Tag Manager gtag.js script if not present
  if (!document.querySelector(`script[src*="${firebaseConfig.measurementId}"]`)) {
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${firebaseConfig.measurementId}`;
    document.head.appendChild(s);
  }

  // E-Commerce & App Event Tracking API
  window.Analytics = {
    config: firebaseConfig,
    trackEvent(eventName, params = {}) {
      if (typeof window.gtag === 'function') {
        window.gtag('event', eventName, params);
      }
    },
    trackPageView(pageTitle = document.title, pagePath = window.location.pathname) {
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'page_view', {
          page_title: pageTitle,
          page_path: pagePath,
          page_location: window.location.href
        });
      }
    },
    trackViewItem(product) {
      if (!product) return;
      this.trackEvent('view_item', {
        currency: 'BDT',
        value: product.sale_price || product.price,
        items: [{
          item_id: String(product.id),
          item_name: product.name,
          item_category: product.category_name || 'Lungi',
          price: product.sale_price || product.price,
          quantity: 1
        }]
      });
    },
    trackAddToCart(product, quantity = 1, size = '', color = '') {
      if (!product) return;
      this.trackEvent('add_to_cart', {
        currency: 'BDT',
        value: (product.sale_price || product.price) * quantity,
        items: [{
          item_id: String(product.id),
          item_name: product.name,
          price: product.sale_price || product.price,
          item_variant: [size, color].filter(Boolean).join(' / '),
          quantity
        }]
      });
    },
    trackBeginCheckout(items = [], total = 0) {
      this.trackEvent('begin_checkout', {
        currency: 'BDT',
        value: total,
        items: items.map(item => ({
          item_id: String(item.product_id || item.id),
          item_name: item.name,
          price: item.price,
          quantity: item.quantity
        }))
      });
    },
    trackPurchase(orderNumber, total, items = [], paymentMethod = 'cod') {
      this.trackEvent('purchase', {
        transaction_id: String(orderNumber),
        value: Number(total),
        currency: 'BDT',
        payment_type: paymentMethod,
        items: items.map(item => ({
          item_id: String(item.product_id || item.id),
          item_name: item.name,
          price: item.price,
          quantity: item.quantity
        }))
      });
    }
  };

  // Automatically apply custom site favicon across all storefront pages
  try {
    fetch('/api/settings').then(r => r.json()).then(data => {
      if (data && data.success && data.settings && data.settings.site_favicon) {
        const fav = document.getElementById('siteFavicon');
        if (fav) fav.href = data.settings.site_favicon;
      }
    }).catch(() => {});
  } catch (_) {}
})();
