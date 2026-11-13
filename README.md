# Polymarket Eligible Bot

Bot berbasis aturan untuk market Bitcoin Up/Down 5 menit di [Polymarket](https://polymarket.com).
Runner `eligible` memilih sisi yang memenuhi syarat harga, waktu, spread,
likuiditas, dan validitas data. Keputusan berjalan tanpa inference AI.

Menggunakan Node.js 24, CLOB V2, collateral pUSD, dan jaringan Polygon.
Paper memakai dana virtual; live diaktifkan secara eksplisit melalui `poly start`.

## Mulai

Siapkan Linux, Node.js 24, npm, serta `flock` dari util-linux. Systemd user
dipakai untuk layanan live. Instalasi utama tidak memerlukan Docker atau model AI.

```bash
git clone https://github.com/dwiaribowokj/polymarket-eligible-bot.git
cd polymarket-eligible-bot
nvm install
nvm use
npm ci
cp .env.example .env
chmod 600 .env
```

Isi `.env` dengan signer, Safe Polymarket, dan kredensial sendiri. Safe memegang
pUSD untuk trading; EOA signer memerlukan POL untuk gas redeem dan penarikan.
Panduan lengkap tersedia di [docs/setup.md](docs/setup.md).

## Live

```bash
./scripts/poly config
./scripts/poly status
./scripts/poly check
```

`check` memverifikasi jaringan, wallet, saldo, gas, allowance, order, inventory,
dan ledger tanpa mengirim order atau transaksi. Aktivasi berikut memakai uang nyata:

```bash
./scripts/poly start
./scripts/poly logs
./scripts/poly stop
```

`start` menjalankan preflight, memasang unit yang cocok, lalu memulai
`polymarket-eligible-live.service`. Tidak ada aktivasi otomatis setelah instalasi.
`stop` menghentikan proses; periksa posisi dan transaksi sebelum restart.
Laporan lengkap tersedia melalui `node scripts/eligible-live.js report`.

Untuk memakai perintah `poly` dari direktori lain:

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/scripts/poly" "$HOME/.local/bin/poly"
```

Pastikan `~/.local/bin` masuk `PATH`. Pada deployment yang sudah berjalan,
launcher harus tetap menunjuk runtime yang terikat dengan ledger aktif.

## Aturan entry

- Target 5 shares, anggaran per entry maksimal 5 pUSD, satu posisi bot aktif.
- Slot penilaian 90, 60, dan 30 detik sebelum market selesai.
- Tepat satu sisi harus memenuhi syarat; selain itu keputusan `SKIP`.
- Contoh konfigurasi memakai biaya full-fill maksimal 0,85 pUSD/share,
  termasuk fee dan estimasi gas pada limit awal.
- Order FAK memakai limit tetap; partial fill diterima tanpa mengejar sisa order.
- Harga, likuiditas, saldo, dan kesegaran data diperiksa lagi sebelum eksekusi.

Bot tidak melatih atau mengubah aturannya sendiri dari win/loss. Hasil paper
dan data live dipakai untuk evaluasi terpisah sebelum perubahan strategi.

## Mode continuous

`.env.example` memilih `ELIGIBLE_CONTINUOUS_TRADING=true`: live tetap memantau
pasar sampai dihentikan manual. Drawdown 10 pUSD menjadi peringatan, tanpa
menghentikan entry. Jika flag tidak diisi, default kode adalah `false` dan
batas drawdown diberlakukan.

Entry tetap menunggu modal cukup, penyelesaian posisi atau penarikan sebelumnya,
serta bukti wallet dan data yang valid. Deposit pUSD terkonfirmasi dikenali
otomatis. Kekurangan POL menunda redeem dengan retry 30-60 detik; isi POL pada
EOA signer agar penyelesaian dapat dilanjutkan. RPC cadangan menangani kegagalan
baca yang dapat dipulihkan setelah chain dan blok diverifikasi.

Mode continuous memakai restart layanan setelah crash. Stop manual tetap
dihormati. Restart tidak menghapus posisi, transaksi pending, atau riwayat.

## Penarikan otomatis

Template menonaktifkan penarikan sampai EOA penerima sendiri dikonfigurasi.
Variabel `LAYA_PROFIT_*` dipertahankan sebagai nama konfigurasi modul bersama;
fitur ini berjalan tanpa AI.

Jika diaktifkan dengan kebijakan pada template:

- Saldo pUSD terverifikasi minimal 15 memicu penarikan 5 pUSD bruto.
- Setelah trade kalah, saldo sebelum trade minimal 14 dan sesudah loss lebih
  dari 10 dapat memicu penarikan 5 pUSD; sisa saldo boleh di bawah 10.
- Dana dikonversi melalui Bridge resmi menjadi native USDC di Polygon.
- Entry dilanjutkan setelah penarikan selesai, selama anggaran entry cukup.

Deposit tetap dicatat sebagai modal. Biaya Bridge dan gas diperiksa sebelum
transfer. Lihat [setup penarikan](docs/setup.md#penarikan-profit-live-opsional)
untuk aktivasi, rekonsiliasi, dan perubahan kebijakan pada periode aktif.

## Paper tanpa AI

Profil berikut membandingkan batas biaya 0,85 dan 0,82 pada ledger virtual
terpisah, masing-masing dengan modal awal 20 pUSD:

```bash
node scripts/entry-filter-paper.js preflight --profile=live-cost-cap-v1 --out="$PWD/data/entry-filter-paper/period-001" --smoke
node scripts/entry-filter-paper.js run --profile=live-cost-cap-v1 --out="$PWD/data/entry-filter-paper/period-001"
node scripts/entry-filter-paper.js report --out="$PWD/data/entry-filter-paper/period-001" --history
```

Jalankan laporan di terminal lain. Gunakan direktori periode baru saat mengganti
kebijakan, dan pertahankan riwayat periode lama. Stop drawdown riset paper
tetap 10 pUSD. Hasil paper tidak mengaktifkan atau mengubah live otomatis.

`npm start` dan `npm run paper` tetap menjalankan simulasi aturan dasar.
Rincian profil dan runner riset lain ada di [referensi](docs/reference.md).

## Repository baru

Ekspor bersih menyalin kode dan dokumentasi publik tanpa `.git`, konfigurasi
privat, ledger, log, atau runtime deployment:

```bash
npm run release:check
npm run release:export -- ../polymarket-eligible-bot-public
```

Tujuan harus berupa direktori yang belum ada; ekspor tidak melakukan git init,
commit, atau push. Penerusan wallet live yang sama memerlukan pemindahan seluruh
state privat dan verifikasi identitas runtime. Mengganti nama repository tidak
mereset periode, saldo, stop, atau drawdown. Lihat [panduan migrasi](docs/setup.md).

## Pengembangan

```bash
npm test
```

| Lokasi | Fungsi |
| --- | --- |
| `scripts/poly`, `scripts/eligible-live-control.js` | Controller live |
| `src/eligible-live/` | Keputusan aturan, filter entry, dan identitas periode |
| `src/laya-live/` | Mesin eksekusi bersama, RPC, rekonsiliasi, dan settlement |
| `src/restart/` | Client dasar, penyimpanan, dan simulasi aturan |
| `src/entry-filter-paper/` | Evaluasi paper tanpa AI |
| `test/` | Tes guard, eksekusi, dan recovery |

Nama internal `laya-live` masih dipakai mesin bersama. Layanan eligible memakai
provider `deterministic-eligible-v1` dengan `inference: false`. Runner model dan
eksperimen opsional didokumentasikan terpisah di [referensi](docs/reference.md).
