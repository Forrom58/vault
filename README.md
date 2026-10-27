# Vault

PWA per conservare password in modo cifrato dentro un'immagine PNG, ad alto contrasto per ipovedenti.

- **Consulta password** (`viewer.html`): apre un vault PNG e mostra le voci.
- **Registra password** (`editor.html`): crea un vault, aggiunge/modifica voci, esporta il PNG (con verifica automatica che il file sia leggibile).

## Sicurezza
- Tutto avviene nel browser: nessun dato viene inviato in rete.
- Cifratura AES-256-GCM, chiave derivata dalla master password con PBKDF2-SHA256 (600.000 iterazioni).
- I dati cifrati sono nascosti nei pixel dell'immagine (steganografia LSB).
- **Non caricare mai i PNG dei vault in questa repository.**
- Il PNG non va ricompresso (WhatsApp, Google Foto, ecc. lo rendono illeggibile).
- Non esiste recupero della master password.

## Aggiornare l'app
Dopo aver modificato i file, aumentare `VERSION` in `sw.js` (es. `vault-v2`).
