// ---------- PWA: registrazione service worker (funzionamento offline) ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
  navigator.serviceWorker.register('sw.js').catch(function(){});
}
