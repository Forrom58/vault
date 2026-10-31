// ---------- Versione dell'app ----------
// A ogni aggiornamento cambiare QUI il numero E la riga VERSION in sw.js (stesso numero).
var APP_VERSION = '4.3';
document.querySelectorAll('.ver').forEach(function(el){
  el.textContent = 'v' + APP_VERSION;
  el.setAttribute('aria-label', 'versione ' + APP_VERSION);
});

// ---------- PWA: registrazione service worker (funzionamento offline) ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
  // Quando arriva una versione nuova, la pagina si ricarica da sola una volta,
  // così si vede subito senza dover chiudere e riaprire l'app.
  var hadController = !!navigator.serviceWorker.controller;
  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(function(reg){ reg.update(); })
    .catch(function(){});
}
