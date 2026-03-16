var CACHE_NAME = 'budgetwise-v19';
var ASSETS = [
    '/',
    '/index.html',
    '/dashboard.html',
    '/css/auth.css',
    '/css/dashboard.css',
    '/js/auth.js',
    '/js/app.js',
    '/js/supabase-config.js',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/manifest.json'
];

self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(
                keys.filter(function(k) { return k !== CACHE_NAME; })
                    .map(function(k) { return caches.delete(k); })
            );
        })
    );
    self.clients.claim();
});

// Push notification handler
self.addEventListener('push', function(e) {
    var data = e.data ? e.data.json() : {};
    var title = data.title || 'BudgetWise';
    var options = {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: data.tag || 'bw-notification',
        data: { url: data.url || '/dashboard.html' }
    };
    e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click — open the app
self.addEventListener('notificationclick', function(e) {
    e.notification.close();
    var url = e.notification.data && e.notification.data.url ? e.notification.data.url : '/dashboard.html';
    e.waitUntil(
        clients.matchAll({ type: 'window' }).then(function(windowClients) {
            for (var i = 0; i < windowClients.length; i++) {
                if (windowClients[i].url.indexOf('dashboard') !== -1) {
                    return windowClients[i].focus();
                }
            }
            return clients.openWindow(url);
        })
    );
});

// Message handler for showing notifications from the app
self.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
        self.registration.showNotification(e.data.title, {
            body: e.data.body,
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: e.data.tag || 'bw-notification',
            data: { url: '/dashboard.html' }
        });
    }
});

self.addEventListener('fetch', function(e) {
    var url = new URL(e.request.url);

    // Network-first for API calls and auth
    if (url.hostname !== location.hostname || e.request.method !== 'GET') {
        return;
    }

    // Network-first for everything — fall back to cache if offline
    e.respondWith(
        fetch(e.request).then(function(res) {
            var clone = res.clone();
            caches.open(CACHE_NAME).then(function(cache) {
                cache.put(e.request, clone);
            });
            return res;
        }).catch(function() {
            return caches.match(e.request);
        })
    );
});
