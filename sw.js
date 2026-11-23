// 오프라인에서도 앱이 열리도록 화면 파일을 저장해 두는 서비스 워커.
// 할 일 데이터 동기화는 Firebase가 따로 처리해요 (여기서는 건드리지 않음).
const CACHE = 'todo-cal-v8';
const SHELL = [
  './', './index.html', './style.css', './app.js', './firebase-config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
const CDN_HOSTS = ['www.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 앱 파일: 인터넷이 되면 최신 버전, 안 되면 저장본
  if (url.origin === self.location.origin){
    e.respondWith(
      fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(res => {
        if (res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // 버전이 고정된 라이브러리·폰트: 저장본 우선
  if (CDN_HOSTS.includes(url.hostname)){
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === 'opaque'){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
  // 그 외(Firebase 서버 통신)는 그대로 통과
});
