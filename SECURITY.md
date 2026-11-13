# Konfigurasi privat dan publikasi

Simpan private key, API key/secret/passphrase, wallet, dan RPC bertoken hanya di
`.env` lokal atau `~/.config/polymarket-eligible-live.env`, dengan izin `0600`.
Runner riset opsional dapat memakai `~/.config/polymarket-ai-shadow.env`;
file tersebut juga harus tetap privat.
`.env.example` harus tetap memakai field rahasia kosong. Jangan mengunggah file
environment asli ke issue, chat publik, atau Git.

`data/` memuat ledger, signed order, manifest, diagnosis, dan bukti transaksi.
`logs/` serta catatan insiden bertanggal dalam `docs/` juga bersifat privat.
`.gitignore` melindungi file baru; file yang sudah pernah dilacak Git tetap ada
di history. Karena itu, publikasikan hasil **ekspor bersih** untuk repo baru:

```bash
npm run release:check
npm run release:export -- ../polymarket-eligible-bot-public
cd ../polymarket-eligible-bot-public
git init -b main
git config core.hooksPath .githooks
git add .
node scripts/release.js check --staged
git diff --cached --stat
```

Ekspor memakai daftar file yang diizinkan, memeriksa pola key dan nilai privat
lokal yang diketahui, menolak symlink/binary, dan tidak menyalin `.git`, `.env`,
ledger, log, atau catatan insiden. Direktori tujuan harus baru. Ekspor tidak
menginisialisasi Git, membuat commit, maupun push. Hook memeriksa isi **index**,
bukan hanya versi file pada disk; hook lokal tetap dapat dilewati. Pemeriksaan
pola bukan jaminan mendeteksi seluruh format rahasia: tinjau berkas sebelum push.

Ekspor juga mengganti default path perangkat pada dua template service, wrapper
Node lama, dan default database router dengan nilai portable. Sumber deployment
yang sedang berjalan tetap dipertahankan. Kode ekspor memiliki identitas sumber
baru; jangan memakainya untuk melewati pemeriksaan periode live yang lama.

Bila kredensial pernah ter-push, rotasi kredensial tersebut; menghapus file pada
commit terbaru tidak menghapus history. Untuk private key wallet, pindahkan dana
ke wallet baru dan cabut izin yang relevan.

## Migrasi perangkat

Ekspor publik bukan backup wallet. Jangan jalankan dua bot dengan wallet yang
sama di dua perangkat: lock hanya melindungi satu host. Saat migrasi, hentikan
instance lama, salin konfigurasi dan **seluruh ledger/continuation privat** lewat
kanal privat, lalu rekonsiliasi sebelum start. Path, sumber, RPC, dan identitas
periode terikat hash; perubahan dapat memerlukan migrasi yang ditinjau. Jangan
hapus ledger, stop, atau history untuk melewati pemeriksaan.

Gunakan wallet terpisah untuk aktivitas manual agar rekonsiliasi lebih mudah.
Bot memisahkan aktivitas eksternal dari trade miliknya; aktivitas manual tetap
harus direkonsiliasi. Saldo atau bukti transaksi yang belum terverifikasi dapat
menunda entry sampai rekonsiliasi selesai.
