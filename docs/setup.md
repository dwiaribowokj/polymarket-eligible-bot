# Setup polymarket-eligible-bot

Panduan ini untuk **Eligible live tanpa AI**: keputusan entry berasal dari aturan
tetap, dengan eksekusi CLOB V2 dan saldo pUSD pada Polygon. Tidak diperlukan
Docker, checkpoint model, server Laya, atau API provider AI. Eksperimen paper dan
jalur historis dijelaskan terpisah di [referensi](reference.md).

## 1. Runtime

Gunakan Linux, Node.js 24, npm, dan `flock` dari util-linux. Pengelolaan layanan
memakai systemd user. NVM opsional; `.nvmrc` memilih major 24.

```bash
nvm install
nvm use
node --version
npm ci
```

`npm ci` memakai versi dependency dalam lockfile dan menjalankan patch lokal
melalui `postinstall`. Wrapper `./scripts/poly` mencari Node 24 pada PATH atau
instalasi NVM. Untuk lokasi lain, set `POLYMARKET_NODE` ke executable Node 24.

## 2. Konfigurasi privat

Untuk instalasi baru:

```bash
cp .env.example .env
chmod 600 .env
```

Isi `.env` menggunakan editor lokal. Jangan menimpa konfigurasi deployment yang
sudah berjalan dengan template ini.

| Variabel | Kegunaan |
| --- | --- |
| `PRIVATE_KEY` | Private key EOA signer, bukan seed phrase |
| `PROXY_WALLET_ADDRESS` | Safe Polymarket yang dimiliki signer dan menyimpan pUSD |
| `CLOB_API_KEY`, `CLOB_API_SECRET`, `CLOB_API_PASSPHRASE` | Isi ketiganya, atau kosongkan ketiganya untuk derivasi kredensial dari signer |
| `POLYGON_RPC_URL`, `POLYGON_RPC_BACKUP_URL` | RPC Polygon chain 137; endpoint utama dan cadangan harus berbeda |
| `RESTART_DATA_DIR` | Root seluruh ledger; default `data/restart` dalam checkout |
| `ELIGIBLE_LIVE_CONFIG` | Path absolut konfigurasi eligible tambahan; default `~/.config/polymarket-eligible-live.env` |
| `POLYMARKET_ENV_FILE` | Path absolut file wallet terpisah, jika digunakan |

Prioritas nilai adalah **environment proses > `.env` proyek > konfigurasi eligible
privat > `POLYMARKET_ENV_FILE`**. Nilai kosong juga menimpa sumber berprioritas
lebih rendah. Jika wallet disimpan di file terpisah, hapus baris wallet/CLOB
kosong dari `.env` agar kredensial file tersebut dapat dipakai. Terapkan mode
`600` pada setiap file privat dan gunakan sumber konfigurasi yang sama untuk
CLI dan layanan.

Safe memerlukan pUSD untuk entry. **EOA signer memerlukan POL untuk gas** redeem
dan penarikan; menambah pUSD tidak menambah gas. Preflight memeriksa signer,
Safe, saldo, gas, allowance, order/trade, inventory, dan rekonsiliasi. Perintah
pemeriksaan tidak mengirim approval atau menyiapkan wallet otomatis.

### Kebijakan template

Template menetapkan `ELIGIBLE_CONTINUOUS_TRADING=true`: bot terus mengevaluasi
entry setelah win/loss, dan drawdown 10 pUSD menjadi peringatan (`observe_only`).
Saldo cukup, data valid, rekonsiliasi wallet, dan guard transaksi tetap wajib
lulus. Tanpa variabel tersebut, default kode adalah `false` dan drawdown 10 pUSD
dapat menghentikan entry. Mengubah template tidak mengubah deployment lama.

Filter default template memakai `ELIGIBLE_ENTRY_COST_CAP=true`,
`ELIGIBLE_ENTRY_COST_CAP_MAX=0.85`, dan `ELIGIBLE_ENTRY_BUFFER=false`. Biaya
full-fill lima shares pada limit order, termasuk fee dan estimasi gas, harus
memenuhi batas 0.85 pUSD/share. Cost-cap dan buffer tidak boleh aktif bersamaan.
`RESTART_PAPER_GAS_USD=0.05` adalah estimasi USD untuk perhitungan ini, bukan
saldo POL atau harga gas RPC. Jika cost-cap aktif tanpa nilai maksimum eksplisit,
default kode juga 0.85; template menuliskannya eksplisit agar kebijakan mudah diperiksa.

<a id="eligible-tanpa-ai-manual"></a>

## 3. Eligible tanpa AI (manual)

```bash
./scripts/poly config
./scripts/poly status
./scripts/poly check
```

`config` menampilkan kebijakan yang terpilih. `status` membaca ledger dan status
layanan; `check` memverifikasi kesiapan melalui jaringan. Ketiganya tidak membuat
order, mengirim transaksi, atau mengubah ledger. `check` juga dapat melaporkan
kesiapan recovery saja; itu belum berarti entry sudah diizinkan.

Setelah konfigurasi dan hasil pemeriksaan sesuai, aktivasi live memakai saldo
wallet:

```bash
./scripts/poly start
./scripts/poly status
./scripts/poly logs
node scripts/eligible-live.js report
```

`start` memeriksa ulang guard, memasang unit jika diperlukan, melakukan
`daemon-reload`, lalu menjalankan `polymarket-eligible-live.service`. Unit berbeda
yang sudah terpasang ditolak agar deployment lama tidak tertimpa. `poly install`
tersedia untuk menulis unit saja, tanpa memulai layanan. Mode continuous membuat
unit melakukan restart setelah kegagalan proses; aktivasi awal tetap manual dan
installer tidak mengaktifkan start saat boot.

Unit menyimpan alamat publik wallet yang terpilih agar monitor dapat memverifikasi
wallet runtime. Mengganti wallet atau checkout memerlukan peninjauan dan pembaruan
unit; mengganti `.env` saja tidak mengganti alamat yang sudah dipin di unit.

Untuk berhenti:

```bash
./scripts/poly stop
./scripts/poly status
```

`stop` menghentikan runner dan tidak menjual atau menutup posisi otomatis.
Periksa inventory serta settlement yang belum selesai. Controller hanya mengelola
layanan eligible; jangan menjalankan runner lain dengan wallet yang sama.

Tanpa systemd user, jalankan foreground dengan Node 24 dari checkout yang sama:

```bash
node scripts/eligible-live.js preflight
node scripts/eligible-live.js run --live
```

Jangan jalankan foreground bersamaan dengan layanan. `Ctrl+C` meminta graceful
shutdown. Tidak ada batas otomatis jumlah market atau durasi live; entry tetap
menunggu sinyal dan harga yang memenuhi syarat.

<a id="penarikan-profit-live-opsional"></a>

## 4. Penarikan profit live opsional

Penarikan memakai Bridge resmi dari pUSD di Safe menjadi **native USDC pada
Polygon chain 137** di EOA penerima. Nama `LAYA_PROFIT_*` masih digunakan oleh
modul bersama; variabel tersebut tidak mengaktifkan AI.

Template menyiapkan `LAYA_PROFIT_TRIGGER=wallet_balance` dan
`LAYA_PROFIT_LOSS_PROTECTION_ENABLED=true`, tetapi **seluruh penarikan tetap
nonaktif** karena `LAYA_PROFIT_TAKING_ENABLED=false` dan recipient kosong.
Untuk mengaktifkan, isi `LAYA_PROFIT_RECIPIENT` dengan EOA tujuan milik sendiri
dan set master switch ke `true` sebelum memulai periode baru. Pada periode aktif,
hentikan runner, backup seluruh ledger, lalu tinjau migrasi kebijakannya sebelum
menerapkan perubahan; jangan membuat periode kosong untuk melewati guard.

Aturan mode saldo wallet setelah fitur aktif:

- Normal: kas wallet terverifikasi minimal 15 pUSD, tarik 5 pUSD bruto, sisakan
  minimal 10 pUSD.
- Setelah trade terisi kalah: saldo terverifikasi sebelum entry minimal 14 pUSD
  dan sesudah loss lebih dari 10 pUSD, tarik 5 pUSD bruto. Sisa boleh di bawah 10.
- Bot harus tanpa posisi/order terbuka; entry menunggu penarikan selesai, lalu
  live berlanjut dengan dana tersisa jika anggaran entry cukup.

Deposit dapat memenuhi pemicu saldo normal, tetapi tetap bukan profit trading.
Bukti saldo sebelum/sesudah loss harus cocok dengan trade; aktivitas manual
selama trade tidak boleh membuatnya memenuhi syarat. Satu loss hanya memicu satu
penarikan. Pemeriksaan normal dilakukan setiap 30 detik saat flat di luar
jendela entry, sehingga saldo mencapai ambang tidak berarti transfer seketika.

Batas estimasi biaya Bridge adalah 0.05 USD dan gas penarikan 0.15 USD. Rute atau
biaya yang belum terverifikasi membuat penarikan ditunda. Debit 5 pUSD adalah
bruto; USDC bersih mengikuti receipt tujuan. Penarikan baru selesai setelah
debit sumber dan penerimaan tujuan terverifikasi. Jangan menghapus pending atau
mengirim transaksi kedua ketika hasil pengiriman sebelumnya belum pasti.

Lihat `profitTaking` pada `node scripts/eligible-live.js report` untuk tahap,
biaya, serta rekonsiliasi terakhir. Penarikan tidak mereset PnL, drawdown, atau
riwayat. Mode kode tanpa `LAYA_PROFIT_TRIGGER` menggunakan `realized_profit`
dengan aturan modal berbeda; gunakan nilai eksplisit sesuai template.

`bridge_relay_mapping_unavailable` berarti pemetaan transaksi provider belum
terverifikasi; status tetap pending dan pembacaan dicoba ulang. Jalur Relay v2
yang dipakai pemetaan ini dijadwalkan berhenti pada 24 November 2026; migrasi
ke v3 memerlukan API key integrator. Pertahankan ledger dan bukti transaksi
ketika memperbarui integrasi tersebut.

## 5. Repository baru dan perpindahan perangkat

Untuk membuat salinan kode publik tanpa `.git`, environment privat, ledger,
runtime, log, atau dokumen operasi privat:

```bash
npm run release:check
npm run release:export -- ../polymarket-eligible-bot-public
```

Tujuan harus direktori baru. Periksa hasil ekspor sebelum membuat repository
GitHub. Ekspor tidak menjalankan `git init`, commit, atau push, serta tidak
mengubah layanan pada deployment lama. Setelah repository Git baru dibuat,
hook pemeriksaan lokal dapat dipasang dengan
`git config core.hooksPath .githooks`.

**Ekspor kode bukan migrasi live.** Perubahan source, metadata paket, atau path
dapat mengubah identitas runtime. Untuk meneruskan wallet/periode lama:

1. Hentikan runner lama dan periksa posisi, order, transaksi, serta penarikan.
2. Backup dan pindahkan **seluruh** root ledger privat yang benar-benar dipakai,
   termasuk riwayat periode, manifest, receipt, stop, dan record continuation.
3. Pertahankan wallet dan identitas periode; tinjau continuation/migrasi yang
   mengikat runtime baru ke riwayat lama sebelum mengganti unit layanan.
4. Jalankan `poly config`, `poly status`, dan `poly check` pada deployment tujuan,
   lalu lakukan aktivasi manual setelah guard lulus.

`poly new-period` adalah operasi terpisah untuk menyiapkan periode risiko baru,
bukan langkah instalasi atau pengganti migrasi. Jangan menghapus ledger, memilih
root data kosong, atau menyalin sebagian stop/receipt untuk menghilangkan history.
Perbaikan kode dan pergantian filter pada periode aktif memakai record migrasi
yang ditinjau sambil mempertahankan saldo, PnL, pendanaan, serta drawdown. Detail
kebijakan dan eksperimen tersedia di [referensi](reference.md).

## 6. Monitor dan pemecahan masalah

Status service `active` belum membuktikan entry siap. Periksa heartbeat, stop,
`entryHolds`, posisi, serta penarikan pada laporan, kemudian gunakan `poly check`
untuk pemeriksaan jaringan terbaru.

| Gejala | Pemeriksaan |
| --- | --- |
| Node bukan major 24 | Jalankan `nvm use` atau pilih executable melalui `POLYMARKET_NODE` |
| `eligible_installed_unit_differs` | Bandingkan unit pengguna dengan checkout, Node, dan konfigurasi tujuan sebelum menggantinya |
| `insufficient_polygon_gas` / `insufficient_action_gas` | Periksa POL di EOA signer; pUSD berada di Safe dan bukan gas |
| `insufficient_pusd` | Periksa kas pUSD dan anggaran entry; mode continuous tidak mengabaikan saldo |
| RPC timeout / `provider_health_check` | Baca log recovery dan endpoint cadangan; entry menunggu bukti/data yang valid |
| `wallet_ledger_mismatch`, stop, atau transaksi unknown | Rekonsiliasi receipt dan ledger; jangan menghapus guard atau mencoba ulang transfer |
| Monitor menampilkan saldo `n/a` | Periksa kesesuaian wallet runtime dengan alamat publik yang dipin pada unit |

Kekurangan gas sebelum transaksi disiapkan dapat dicoba ulang otomatis setelah
POL tersedia. Transaksi yang sudah dikirim atau hasilnya tidak pasti tetap
memerlukan pemeriksaan hash/nonce dan receipt; top-up bukan alasan mengirim ulang.

RPC baca dapat memakai cadangan setelah chain dan anchor blok terverifikasi.
Scan aktivitas wallet memakai halaman maksimal 100 blok dan jeda retry
1/2/4/8/16/32/60 detik. Entry menunggu riwayat wallet selesai diverifikasi.
Pembacaan receipt settlement memakai jeda 5/15/30/60 detik; simpan ledger dan
tunggu bukti sebelum melakukan pemulihan manual.

Monitor opsional memerlukan Python 3 dan zona waktu `Asia/Jakarta`:

```bash
python3 scripts/cron-check-polymarket.py --init-baseline
python3 scripts/cron-check-polymarket.py
```

Monitor menemukan ledger dari runtime layanan, hanya membaca ledger trading,
dan menulis tracker miliknya. Tidak ada pemasangan cron atau pengiriman pesan
otomatis. `OK_SILENT` berarti tidak ada transisi baru. Discovery yang tidak dapat
memastikan runtime gagal tanpa memilih periode historis. Baseline pertama tidak
memutar ulang trade lama; periksa status awal secara terpisah.

Untuk ledger eksplisit, gunakan `--state-file=/absolute/path/ledger.json` dan
`--tracker=/absolute/private/path/monitor.json`. Pilih tracker terpisah untuk
setiap ledger. Pada mode eksplisit, saldo on-chain hanya dibaca bila
`PROXY_WALLET_ADDRESS` berisi wallet yang benar; monitor tidak membutuhkan private
key. Simpan tracker serta output di penyimpanan privat.

Tes lokal dijalankan dengan `npm test`. Tes tidak menggantikan preflight wallet
dan koneksi pada perangkat tujuan.
