// Service Worker：讓網頁在沒有網路時也能開啟。由 build.mjs 把下面 BUILD 常數的占位字串換成這次建置的雜湊後輸出成 sw.js。
//
// 快取策略
//   頁面本身（導覽請求）  網路優先；網路失敗或超過 4 秒才用快取。所以一有網路就一定拿到最新版，離線時用上次的版本。
//   React 兩支腳本        版本固定的網址，快取優先（安裝時預先下載，離線時才有 React 可用）。
//   記憶體頭像            先給快取、同時背景更新（stale-while-revalidate）；頭像檔很大，只快取成功的回應。
//   其他（Google 試算表、廣告等）  完全不介入，照常走網路。記憶體資料本身由頁面存在 localStorage。
//
// 頁面用到的外部腳本網址必須和下面的 CDN_URLS 一致（tests/pwa.mjs 會檢查）。

const BUILD = '10676e0604';
const SHELL_CACHE = `dqsg-shell-${BUILD}`;
const ICON_CACHE = 'dqsg-portraits-v1';      // 頭像不隨版本更新而清掉
const CDN_URLS = [
    'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
    'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'
];
const LOCAL_SHELL = [
    './', './manifest.webmanifest',
    './app-icons/favicon.svg', './app-icons/favicon-32.png', './app-icons/icon-192.png', './app-icons/icon-512.png',
    './app-icons/icon-maskable-512.png', './app-icons/apple-touch-icon.png'
];
const NAVIGATE_TIMEOUT_MS = 4000;
const PORTRAIT_PATH = /\/memory-icons\/[^/]+\.webp$/;

const scopeUrl = (path) => new URL(path, self.registration.scope).href;

// 取得跨網域腳本：先用 CORS（得到可檢查的回應），不行再用 no-cors（opaque，照樣能當 <script> 使用）
const fetchCdn = async (url) => {
    try {
        const res = await fetch(url, { mode: 'cors' });
        if (res.ok) return res;
    } catch (e) { /* 改用 no-cors */ }
    return fetch(url, { mode: 'no-cors' });
};

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // 頁面本身一定要成功；其餘失敗（例如 CDN 暫時連不上）不擋安裝，下次載入時會由執行期補上
        const page = await fetch(scopeUrl('./'), { cache: 'reload' });
        if (!page.ok) throw new Error('precache page failed: ' + page.status);
        await cache.put(scopeUrl('./index.html'), page.clone());
        await cache.put(scopeUrl('./'), page);
        await Promise.allSettled([
            ...LOCAL_SHELL.filter(p => p !== './').map(async (p) => {
                const res = await fetch(scopeUrl(p), { cache: 'reload' });
                if (res.ok) await cache.put(scopeUrl(p), res);
            }),
            ...CDN_URLS.map(async (url) => {
                const res = await fetchCdn(url);
                if (res.ok || res.type === 'opaque') await cache.put(url, res);
            })
        ]);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = new Set([SHELL_CACHE, ICON_CACHE]);
        const names = await caches.keys();
        await Promise.all(names.filter(n => n.startsWith('dqsg-') && !keep.has(n)).map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

const navigate = async (request) => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = async () => (await cache.match(scopeUrl('./index.html'))) || (await cache.match(scopeUrl('./')));
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), NAVIGATE_TIMEOUT_MS);
        let res;
        try { res = await fetch(request, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
        // 網址可能帶分享用的查詢參數（?job=…），快取一律存成同一份 index.html
        if (res.ok && res.type === 'basic') await cache.put(scopeUrl('./index.html'), res.clone());
        return res;
    } catch (e) {
        // 網路失敗或太慢：用快取；連快取都沒有就再正常連一次（不設逾時），讓瀏覽器自己顯示原本的錯誤頁
        return (await cached()) || fetch(request);
    }
};

const cdnFirst = async (request) => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(request.url);
    if (hit) return hit;
    const res = await fetchCdn(request.url);
    if (res.ok || res.type === 'opaque') await cache.put(request.url, res.clone());
    return res;
};

const portrait = async (event) => {
    const cache = await caches.open(ICON_CACHE);
    const hit = await cache.match(event.request.url);
    const refresh = fetch(event.request).then(async (res) => {
        if (res.ok) await cache.put(event.request.url, res.clone());
        return res;
    });
    if (hit) { event.waitUntil(refresh.catch(() => {})); return hit; }
    return refresh;
};

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (request.mode === 'navigate' && url.origin === self.location.origin && url.href.startsWith(self.registration.scope)) {
        event.respondWith(navigate(request));
    } else if (CDN_URLS.includes(request.url)) {
        event.respondWith(cdnFirst(request));
    } else if (url.origin === self.location.origin && PORTRAIT_PATH.test(url.pathname)) {
        event.respondWith(portrait(event));
    } else if (url.origin === self.location.origin && url.href.startsWith(self.registration.scope)) {
        // 範圍內的其他檔案（manifest、圖示、og-image）：快取有就用，沒有走網路
        event.respondWith(caches.match(request.url, { cacheName: SHELL_CACHE }).then(hit => hit || fetch(request)));
    }
});
