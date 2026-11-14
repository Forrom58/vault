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
        || String(e.notes||'').toLowerCase().indexOf(t) !== -1
        // campi aggiuntivi: nomi e valori NON segreti
        || (Array.isArray(e.fields) && e.fields.some(function(f){
             return String(f.name||'').toLowerCase().indexOf(t) !== -1
                 || (!f.secret && String(f.value||'').toLowerCase().indexOf(t) !== -1);
           }));
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

  var openKeys = {}; // schede aperte (di default tutte chiuse)
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
    // Ordine alfabetico per titolo (senza distinguere maiuscole e accenti)
    shown.sort(function(a, b){ return String(a.site || '').localeCompare(String(b.site || ''), 'it', { sensitivity: 'base', numeric: true }); });
    shown.forEach(function(e){
      var card = document.createElement('div'); card.className = 'card';
      var nm = e.site || 'voce senza nome';
      var h = document.createElement('h3');
      var siteUrl = siteToUrl(e.site);
      // Titolo = pulsante che apre/chiude la scheda (di default chiusa)
      var key = String(e.id || e.site);
      var isOpen = !!openKeys[key];
      var tgl = document.createElement('button');
      tgl.type = 'button'; tgl.className = 'entry-toggle';
      tgl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      var arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = isOpen ? '▾' : '▸';
      var tname = document.createElement('span'); tname.textContent = e.site || '—';
      tgl.appendChild(arrow); tgl.appendChild(tname);
      h.appendChild(tgl);
      card.appendChild(h);
      if (!isOpen) card.classList.add('closed');
      tgl.addEventListener('click', function(){
        var open = card.classList.toggle('closed') === false;
        if (open) openKeys[key] = true; else delete openKeys[key];
        tgl.setAttribute('aria-expanded', open ? 'true' : 'false');
        arrow.textContent = open ? '▾' : '▸';
      });
      if (siteUrl){
        var fa = field('Indirizzo');
        var a = document.createElement('a');
        a.href = siteUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'site-link';
        a.textContent = String(e.site);
        fa.appendChild(a); card.appendChild(fa);
      }

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

      // Campi aggiuntivi (PIN, codici...): i segreti nascosti con "mostra" e "copia"
      (Array.isArray(e.fields) ? e.fields : []).forEach(function(f){
        var fname = f.name || 'Campo';
        var ff = field(fname);
        var vf = document.createElement('div'); vf.className = 'v';
        var tf = document.createElement('span');
        var bf = document.createElement('div'); bf.className = 'b';
        if (f.secret){
          tf.className = 't mask'; tf.textContent = '••••••••••';
          tf.setAttribute('aria-hidden', 'true');
          var vis = false;
          var eyeF = mkBtn('mostra', function(){
            vis = !vis;
            tf.textContent = vis ? (f.value || 'vuoto') : '••••••••••';
            tf.className = vis ? 't' : 't mask';
            tf.setAttribute('aria-hidden', vis ? 'false' : 'true');
            eyeF.textContent = vis ? 'nascondi' : 'mostra';
            eyeF.setAttribute('aria-label', (vis ? 'nascondi ' : 'mostra ') + fname + ' di ' + nm);
            eyeF.setAttribute('aria-pressed', vis ? 'true' : 'false');
            if (vis) announce(f.value || 'vuoto');
          });
          eyeF.setAttribute('aria-label', 'mostra ' + fname + ' di ' + nm);
          eyeF.setAttribute('aria-pressed', 'false');
          bf.appendChild(eyeF);
        } else {
          tf.className = 't'; tf.textContent = f.value || '—';
        }
        if (f.value) bf.appendChild(copyBtn(function(){ return f.value; }, 'copia ' + fname + ' di ' + nm));
        vf.appendChild(tf); vf.appendChild(bf); ff.appendChild(vf); card.appendChild(ff);
      });

      if (e.notes){
        var fn = field('Note');
        var n = document.createElement('div'); n.className = 'n'; n.textContent = e.notes;
        fn.appendChild(n); card.appendChild(fn);
      }
      // tutto quello che segue il titolo va nel corpo apribile
      var body = document.createElement('div'); body.className = 'card-body';
      while (h.nextSibling) body.appendChild(h.nextSibling);
      card.appendChild(body);
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
    // Impronta attiva: si propone subito l'impronta, la password solo su richiesta
    var bio = window.VaultBio && VaultBio.isEnabled();
    setBioMode(bio);
    if (bio) startBio(true); else $('pw').focus();
  });

  function setBioMode(on){
    $('bioArea').classList.toggle('hidden', !on);
    $('pwArea').classList.toggle('hidden', on);
    $('btnUnlock').classList.toggle('hidden', on);
  }
  $('btnUsePw').addEventListener('click', function(){
    clearMsg($('pwMsg'));
    setBioMode(false);
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

  var lastPw = null; // master password in memoria finché il vault è aperto (serve per attivare l'impronta)
  async function unlock(pwOverride){
    if (busy || !pendingFile) return;
    var pwMsg = $('pwMsg');
    clearMsg(pwMsg);
    var pw = (typeof pwOverride === 'string') ? pwOverride : $('pw').value;
    busy = true;
    $('btnUnlock').disabled = true; $('btnCancel').disabled = true; $('btnBio').disabled = true; $('btnUsePw').disabled = true;
    showMsg(pwMsg, 'Sblocco in corso…', 'ok');

    var imageData;
    try{
      imageData = await readImageData(pendingFile);
    }catch(err){
      showMsg(pwMsg, 'Errore nella lettura del file immagine: ' + err.message, 'err');
      busy = false; $('btnUnlock').disabled = false; $('btnCancel').disabled = false; $('btnBio').disabled = false; $('btnUsePw').disabled = false;
      return;
    }

    try{
      var obj = await window.VaultCrypto.openVault(imageData, pw);
      entries = obj.entries;
      lastPw = pw;
      pendingFile = null;
      resetPwPanel();
      $('pwPanel').classList.add('hidden');
      $('vaultPanel').classList.remove('hidden');
      $('q').value = '';
      setPill(true, 'sbloccato');
      $('btnLock').classList.remove('hidden');
      document.documentElement.classList.add('unlocked');
      clearMsg($('bioMsg'));
      updateBioToggle();
      render();
      $('count').focus();
    }catch(err){
      // Un solo messaggio: password errata e file non valido sono indistinguibili (nessun oracolo).
      showMsg(pwMsg, 'Password errata, oppure il file non è un vault valido creato da questa app.', 'err');
      setTimeout(function(){ $('pw').focus(); }, 0);
    }finally{
      imageData = null;
      busy = false; $('btnUnlock').disabled = false; $('btnCancel').disabled = false; $('btnBio').disabled = false; $('btnUsePw').disabled = false;
    }
  }

  // auto = richiesta automatica appena scelto il file: se viene annullata non si mostra un errore,
  // si lascia il pulsante "Sblocca con impronta" pronto da toccare.
  var bioBusy = false;
  async function startBio(auto){
    if (busy || bioBusy || !pendingFile) return;
    bioBusy = true;
    var pw;
    try{ pw = await VaultBio.getPassword(); }
    catch(err){
      bioBusy = false;
      if (auto && err.message === 'ANNULLATO'){ $('btnBio').focus(); return; }
      showMsg($('pwMsg'), VaultBio.messageFor(err), 'err');
      $('btnBio').focus();
      return;
    }
    bioBusy = false;
    unlock(pw);
  }
  $('btnBio').addEventListener('click', function(){ startBio(false); });

  function updateBioToggle(){
    var b = $('btnBioToggle');
    if (!window.VaultBio || !VaultBio.isSupported()){ b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    b.textContent = VaultBio.isEnabled() ? 'Disattiva sblocco con impronta' : 'Attiva sblocco con impronta';
  }
  $('btnBioToggle').addEventListener('click', async function(){
    var m = $('bioMsg');
    clearMsg(m);
    if (VaultBio.isEnabled()){
      VaultBio.disable();
      updateBioToggle();
      showMsg(m, 'Sblocco con impronta disattivato su questo telefono. La passkey "Vault" resta nel gestore password: se vuoi, eliminala da lì.', 'ok');
      return;
    }
    if (!lastPw) return;
    $('btnBioToggle').disabled = true;
    try{
      await VaultBio.enable(lastPw);
      showMsg(m, 'Sblocco con impronta attivato su questo telefono. La master password resta valida e indispensabile sugli altri dispositivi: non dimenticarla.', 'ok');
    }catch(err){
      showMsg(m, VaultBio.messageFor(err), 'err');
    }finally{
      $('btnBioToggle').disabled = false;
      updateBioToggle();
    }
  });

  $('q').addEventListener('input', function(){ if (entries) render(); });

  $('btnLock').addEventListener('click', function(){
    entries = null;
    lastPw = null;
    openKeys = {};
    clearMsg($('bioMsg'));
    pendingFile = null;
    $('list').textContent = '';
    $('count').textContent = '';
    $('q').value = '';
    $('vaultPanel').classList.add('hidden');
    $('startPanel').classList.remove('hidden');
    clearMsg($('startMsg'));
    setPill(false, 'bloccato');
    $('btnLock').classList.add('hidden');
    document.documentElement.classList.remove('unlocked');
    $('btnLoad').focus();
  });
})();

