// ---------- Versione dell'app ----------
// A ogni aggiornamento cambiare QUI il numero E la riga VERSION in sw.js (stesso numero).
var APP_VERSION = '3.1';
document.querySelectorAll('.ver').forEach(function(el){
  el.textContent = 'v' + APP_VERSION;
  el.setAttribute('aria-label', 'versione ' + APP_VERSION);
});

// ---------- PWA: registrazione service worker (funzionamento offline) ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
  navigator.serviceWorker.register('sw.js').catch(function(){});
}
