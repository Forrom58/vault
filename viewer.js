(function(){
  'use strict';
  var $ = function(id){ return document.getElementById(id); };

  var entries = null;
  var pendingFile = null;
  var busy = false;


  // Testo inserito con breve ritardo dopo aver reso visibile il riquadro: così i
  // lettori di schermo lo annunciano davvero.
  function showMsg(el, text, type){
    clearTimeout(el._t);
    el.className = 'msg show ' + type;
    el.setAttribute('aria-live', type === 'err' ? 'assertive' : 'polite');
    el.textContent = '';
    el._t = setTimeout(function(){ el.textContent = text; }, 60);
  }
  function clearMsg(el){ clearTimeout(el._t); el.className = 'msg'; el.textContent = ''; }
  function announce(text){
    var live = $('srLive'); live.textContent = '';
    setTimeout(function(){ live.textContent = text; }, 60);
  }

  // ---------- crypto: vedi vault-crypto.js ----------

  function readImageData(file){
    return new Promise(function(resolve, reject){
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function(){
        try{
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          var x = c.getContext('2d');
          x.drawImage(img, 0, 0);
          var d = x.getImageData(0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(d);
        }catch(e){ URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('Immagine non leggibile')); };
      img.src = url;
    });
  }

  async function copyText(t){
    try{ await navigator.clipboard.writeText(t); return true; }catch(e){}
    try{
      var ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly','');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, t.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    }catch(e){ return false; }
  }

  function mkBtn(label, onClick){
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'sm'; b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
  function copyBtn(getVal, ariaLabel){
    var b = mkBtn('copia', async function(){
      var ok = await copyText(getVal());
      announce(ok ? 'Copiato' : 'Errore: copia non riuscita');
      b.textContent = ok ? 'copiato' : 'errore';
      setTimeout(function(){ b.textContent = 'copia'; }, 1200);
    });
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    return b;
  }
  function field(label){
    var f = document.createElement('div'); f.className = 'f';
    var k = document.createElement('div'); k.className = 'k'; k.textContent = label;
    f.appendChild(k);
    return f;
  }

  function matches(e, t){
    if (!t) return true;
    t = t.toLowerCase();
    return String(e.site||'').toLowerCase().indexOf(t) !== -1
        || String(e.user||'').toLowerCase().indexOf(t) !== -1
        || String(e.notes||'').toLowerCase().indexOf(t) !== -1;
  }

  // Se "Sito / servizio" è un indirizzo web (con o senza schema) restituisce l'URL
  // http(s) assoluto, altrimenti null. Solo http/https: nessun altro schema
  // (javascript:, data:, ecc.) può diventare un link. Identico a vault-stego-18.
  var SITE_URL_RE = /^(https?:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d{1,5})?([\/?#]\S*)?$/i;
  function siteToUrl(text){
    var t = String(text || '').trim();
    if (!SITE_URL_RE.test(t)) return null;
    try{
      var u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    }catch(e){ return null; }
  }

  function render(){
    var list = $('list');
    list.textContent = '';
    var term = $('q').value.trim();
    var shown = entries.filter(function(e){ return matches(e, term); });
    $('count').textContent = term ? (shown.length + ' di ' + entries.length + ' voci') : (entries.length + ' voci');
    if (!shown.length){
      var d = document.createElement('div'); d.className = 'empty';
      d.textContent = entries.length ? 'Nessuna voce corrisponde alla ricerca.' : 'Il vault non contiene voci.';
      list.appendChild(d);
      return;
    }
    shown.forEach(function(e){
      var card = document.createElement('div'); card.className = 'card';
      var nm = e.site || 'voce senza nome';
      var h = document.createElement('h3');
      var siteUrl = siteToUrl(e.site);
      if (siteUrl){
        var a = document.createElement('a');
        a.href = siteUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'site-link';
        a.textContent = String(e.site);
        h.appendChild(a);
      } else {
        h.textContent = e.site || '—';
      }
      card.appendChild(h);

      if (e.user){
        var fu = field('Utente');
        var vu = document.createElement('div'); vu.className = 'v';
        var tu = document.createElement('span'); tu.className = 't'; tu.textContent = e.user;
        var bu = document.createElement('div'); bu.className = 'b';
        bu.appendChild(copyBtn(function(){ return e.user; }, 'copia utente di ' + nm));
        vu.appendChild(tu); vu.appendChild(bu); fu.appendChild(vu); card.appendChild(fu);
      }

      var fp = field('Password');
      var vp = document.createElement('div'); vp.className = 'v';
      var tp = document.createElement('span'); tp.className = 't mask'; tp.textContent = '••••••••••';
      tp.setAttribute('aria-hidden', 'true');
      var bp = document.createElement('div'); bp.className = 'b';
      var shownPw = false;
      var eye = mkBtn('mostra', function(){
        shownPw = !shownPw;
        tp.textContent = shownPw ? (e.pass || 'vuoto') : '••••••••••';
        tp.className = shownPw ? 't' : 't mask';
        eye.textContent = shownPw ? 'nascondi' : 'mostra';
        tp.setAttribute('aria-hidden', shownPw ? 'false' : 'true');
        eye.setAttribute('aria-label', (shownPw ? 'nascondi' : 'mostra') + ' password di ' + nm);
        eye.setAttribute('aria-pressed', shownPw ? 'true' : 'false');
        if (shownPw) announce(e.pass || 'password vuota');
      });
      eye.setAttribute('aria-label', 'mostra password di ' + nm);
      eye.setAttribute('aria-pressed', 'false');
      bp.appendChild(eye);
      bp.appendChild(copyBtn(function(){ return e.pass || ''; }, 'copia password di ' + nm));
      vp.appendChild(tp); vp.appendChild(bp); fp.appendChild(vp); card.appendChild(fp);

      if (e.notes){
        var fn = field('Note');
        var n = document.createElement('div'); n.className = 'n'; n.textContent = e.notes;
        fn.appendChild(n); card.appendChild(fn);
      }
      list.appendChild(card);
    });
  }

  function setPill(on, text){ $('pill').textContent = text; $('pill').className = 'pill' + (on ? ' on' : ''); }

  function resetPwPanel(){
    $('pw').value = '';
    $('pw').type = 'password';
    $('btnEye').textContent = 'mostra';
    $('btnEye').setAttribute('aria-pressed','false');
    clearMsg($('pwMsg'));
  }

  $('btnLoad').addEventListener('click', function(){ $('fileIn').click(); });

  $('fileIn').addEventListener('change', function(e){
    var f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    clearMsg($('startMsg'));
    if (!(window.crypto && crypto.subtle)){
      showMsg($('startMsg'), 'Web Crypto non disponibile in questo contesto (serve una pagina sicura). Impossibile decifrare.', 'err');
      return;
    }
    pendingFile = f;
    resetPwPanel();
    $('startPanel').classList.add('hidden');
    $('pwPanel').classList.remove('hidden');
    $('pw').focus();
  });

  $('btnEye').addEventListener('click', function(){
    var show = $('pw').type === 'password';
    $('pw').type = show ? 'text' : 'password';
    $('btnEye').textContent = show ? 'nascondi' : 'mostra';
    $('btnEye').setAttribute('aria-pressed', show ? 'true' : 'false');
  });

  $('btnCancel').addEventListener('click', function(){
    if (busy) return;
    pendingFile = null;
    resetPwPanel();
    $('pwPanel').classList.add('hidden');
    $('startPanel').classList.remove('hidden');
    $('btnLoad').focus();
  });
  $('pw').addEventListener('keydown', function(e){ if (e.key === 'Escape') $('btnCancel').click(); });

  $('pw').addEventListener('keydown', function(e){ if (e.key === 'Enter'){ e.preventDefault(); unlock(); } });
  $('btnUnlock').addEventListener('click', unlock);

  async function unlock(){
    if (busy || !pendingFile) return;
    var pwMsg = $('pwMsg');
    clearMsg(pwMsg);
    var pw = $('pw').value;
    busy = true;
    $('btnUnlock').disabled = true; $('btnCancel').disabled = true;
    showMsg(pwMsg, 'Sblocco in corso…', 'ok');

    var imageData;
    try{
      imageData = await readImageData(pendingFile);
    }catch(err){
      showMsg(pwMsg, 'Errore nella lettura del file immagine: ' + err.message, 'err');
      busy = false; $('btnUnlock').disabled = false; $('btnCancel').disabled = false;
      return;
    }

    try{
      var obj = await window.VaultCrypto.openVault(imageData, pw);
      entries = obj.entries;
      pendingFile = null;
      resetPwPanel();
      $('pwPanel').classList.add('hidden');
      $('vaultPanel').classList.remove('hidden');
      $('q').value = '';
      setPill(true, 'sbloccato');
      render();
      $('count').focus();
    }catch(err){
      // Un solo messaggio: password errata e file non valido sono indistinguibili (nessun oracolo).
      showMsg(pwMsg, 'Password errata, oppure il file non è un vault valido creato da questa app.', 'err');
      setTimeout(function(){ $('pw').focus(); }, 0);
    }finally{
      imageData = null;
      busy = false; $('btnUnlock').disabled = false; $('btnCancel').disabled = false;
    }
  }

  $('q').addEventListener('input', function(){ if (entries) render(); });

  $('btnLock').addEventListener('click', function(){
    entries = null;
    pendingFile = null;
    $('list').textContent = '';
    $('count').textContent = '';
    $('q').value = '';
    $('vaultPanel').classList.add('hidden');
    $('startPanel').classList.remove('hidden');
    clearMsg($('startMsg'));
    setPill(false, 'bloccato');
    $('btnLoad').focus();
  });
})();

