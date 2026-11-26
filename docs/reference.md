# Referensi strategi dan eksperimen

Panduan utama bot eligible ada di [README](../README.md) dan [setup](setup.md).
Dokumen ini menyimpan detail migrasi eligible serta eksperimen paper opsional.
Bagian Laya/Gemini/GPT memerlukan konfigurasi model tersendiri dan tidak dijalankan
oleh layanan eligible. Eksperimen tidak mengganti strategi live secara otomatis.


## Eligible live tanpa AI (manual)

`eligible` mengambil satu-satunya sisi yang lolos aturan harga, waktu, spread,
depth, dan validasi data. Tidak memanggil Laya, tokenizer, atau 9router.
Keunggulan hasil paper sementara belum membuktikan strategi ini layak live.

```bash
./scripts/poly check
./scripts/poly status
./scripts/poly start    # Aktivasi manual dengan uang nyata jika preflight lulus
./scripts/poly stop
./scripts/poly logs
```

Untuk menjalankan dari direktori mana pun, pasang symlink ke checkout yang
dibekukan; `~/.local/bin` harus ada di `PATH`:

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/scripts/poly" "$HOME/.local/bin/poly"
poly check
```

Tanpa argumen, `poly` menampilkan status. `poly install` hanya memasang unit
`polymarket-eligible-live.service`; tidak memulai layanan atau memasang autostart.
`laya` tetap menunjuk runner Laya. Lihat [setup eligible](setup.md#eligible-tanpa-ai-manual)
untuk konfigurasi wallet serta migrasi riwayat.

Target tetap 5 shares, biaya entry maksimal $5, FAK dengan limit awal, satu
percobaan per market, history valid 180 detik, dan latency minimum 250 ms sebelum
validasi eksekusi. Tidak ada cutoff jam/jumlah market. Drawdown $10 tetap
menjadi batas default dan tersimpan. Kedua runner berbagi lock dan seluruh riwayat pilot; stop, inventory,
penarikan belum pasti, atau periode live lama memblokir aktivasi biasa.
`poly start` tidak menghapus stop atau mengawali puncak modal baru secara diam-diam.
Saat guard memblokir, `poly check` dan `poly status` menampilkan alasannya.

`poly check` dan `poly start` menampilkan progres pemeriksaan setiap 15 detik,
dengan batas 10 menit untuk audit wallet dan deposit. Setelah lama tidak aktif,
pemindaian riwayat on-chain dapat memerlukan beberapa menit. Layanan belum
dimulai selama preflight berjalan. Timeout ditampilkan sebagai
`eligible_preflight_timeout`; laporan kosong atau rusak sebagai
`eligible_preflight_report_unavailable`. Keduanya tidak memulai layanan.

`ELIGIBLE_CONTINUOUS_TRADING=true` mengaktifkan mode sampai `poly stop`: drawdown
tetap dicatat tanpa menghentikan trading, dan gangguan operasional yang dikenali
dipulihkan setelah bukti wallet, order, serta data terbaru lulus. Order atau
receipt yang belum pasti tetap direkonsiliasi sebelum entry berikutnya; order
lama tidak dikirim ulang. Nilai yang diterima hanya `true` atau `false`, default
`false`. Urutan prioritas konfigurasi: environment proses, `.env` checkout,
config eligible privat, lalu `POLYMARKET_ENV_FILE`.

`ELIGIBLE_ENTRY_COST_CAP=true` menambahkan filter biaya tetap: estimasi pembelian
penuh 5 shares pada limit awal, termasuk fee dan estimasi gas, harus maksimal
$0.85 per share secara default. `ELIGIBLE_ENTRY_COST_CAP_MAX=0.82` memilih batas
$0.82; nilai yang diterima hanya `0.82` atau `0.85`, dan variabel ini wajib disertai
`ELIGIBLE_ENTRY_COST_CAP=true`. Buffer dan cost-cap tetap tidak boleh digabungkan.
Peluang di atas batas dilewati. Filter diperiksa kembali sebelum
submit; harga dan ukuran tidak dinaikkan agar order lolos. Batas ini berlaku pada
estimasi full-fill; biaya gas per share aktual pada partial fill bisa lebih besar.
Nilai default `false` mempertahankan strategi lama.
Batas $0.82 adalah kandidat riset yang masih memerlukan bukti dari trade baru;
hasil historis tidak membuktikan profit atau winrate yang lebih baik. Perubahan
batas live memerlukan persetujuan eksplisit dan riwayat strategi yang terpisah.

`ELIGIBLE_ENTRY_BINANCE_LEAD_VETO=true` menambahkan veto arah jangka pendek dari
feed WebSocket Binance `btcusdt@bookTicker` (rotasi endpoint otomatis dengan
watchdog koneksi 10 detik dan ping 30 detik). Dengan lookback 5 detik, entry
ditolak secara fail-closed (`SKIP` / veto eksekusi) bila harga BTC bergerak
berlawanan minimal `2 bps` dari arah trade yang diusulkan, feed belum siap, atau
usia sampel melebihi `3 detik`, dan diperiksa ulang tepat sebelum order dikirim.
Flag ini wajib disertai `ELIGIBLE_ENTRY_COST_CAP=true`, tidak boleh digabungkan
dengan `ELIGIBLE_ENTRY_BUFFER=true`, dan hanya menerima `true` atau `false`
(default kode `false`). Perubahan pada periode live aktif memerlukan persetujuan
dan continuation teraudit `user_entry_binance_lead_veto` dengan epoch baru.

`ELIGIBLE_ENTRY_BUFFER=true` memakai aturan arm `buffer` pada paper: spot dan
TWAP searah, masing-masing berjarak minimal satu sigma dari referensi pembukaan.
Dalam 60 detik terakhir, history TWAP penutupan yang teramati wajib tersedia dan
jarak terhadap ambang sisa TWAP juga harus memenuhi satu sigma. Aturan memakai
fungsi paper yang sama dan diperiksa lagi sebelum order dikirim. Filter ini
tidak memakai AI atau tambahan batas biaya $0.85/share; batas entry tetap $5.
Mengaktifkan buffer dan cost-cap bersamaan ditolak agar strategi tidak berubah
menjadi `combined` tanpa sengaja. Default buffer adalah `false`.

Pergantian cost-cap ke buffer menggunakan
`node scripts/eligible-migrate-buffer.js` untuk pemeriksaan, lalu `--apply`
untuk menerapkan migrasi lokal setelah bukti akun dan saldo cocok.
Continuation privat harus mengikat manifest kedua runtime dan persetujuan
sebelumnya. Migrasi menambah epoch strategi, mempertahankan riwayat keuangan dan
risiko, serta tidak membuka stop yang belum terselesaikan atau memulai layanan.
Hasil paper dan hasil live buffer ditampilkan terpisah; hasil paper positif
belum membuktikan keuntungan live.

Untuk kembali dari buffer ke cost-cap, gunakan konfigurasi kandidat dengan
`ELIGIBLE_ENTRY_COST_CAP=true` dan `ELIGIBLE_ENTRY_BUFFER=false`, lalu
`node scripts/eligible-return-cost-cap.js --apply` setelah continuation privat
`user_return_cost_cap` disiapkan. Tanpa `--apply`, perintah hanya memeriksa.
Migrasi membuktikan saldo, receipt, dan inventory terbaru; posisi manual yang
sudah direkonsiliasi tetap dicatat terpisah. Order terbuka atau transaksi bot
yang belum selesai harus diselesaikan dahulu. Epoch baru menyimpan hasil
cost-cap terpisah, tanpa menghapus kerugian, drawdown, atau pendanaan lama.
Setelah runtime, konfigurasi, dan launcher dipasang, gunakan `poly check`,
`poly start`, dan `poly stop` seperti biasa. Migrasi tidak memulai layanan.
Filter biaya memakai aturan paper yang sama, tetapi collector dan jadwal
eksekusi live tetap berbeda; hasil paper tidak disalin menjadi profit live.

Ledger live yang sudah memiliki riwayat memerlukan migrasi terikat manifest dan
review akun kosong melalui `node scripts/eligible-migrate-cost-cap.js`; tambahkan
`--apply` untuk menerapkan hasil pemeriksaan tersebut. Migrasi membutuhkan
continuation privat yang cocok dengan kedua runtime, memakai lock wallet, dan
menyimpan backup ledger. Saldo, PnL, puncak equity, drawdown, dan periode risiko
tetap sama. Hasil filter baru ditampilkan dalam `strategyEvaluation` terpisah dari
hasil lama; profit paper tidak ikut dihitung. Perintah ini tidak memulai layanan.
Saldo di bawah kebutuhan entry tetap dapat dipantau dalam periode continuous;
order menunggu modal yang cukup tanpa mengecilkan target 5 shares.

Dalam mode eligible continuous, deposit pUSD dikenali otomatis dari transfer
terkonfirmasi di Polygon, termasuk mint melalui jalur wrap USDC yang tervalidasi.
Bot memeriksa receipt dan jumlahnya sebelum menambah modal, menyimpan identitas
transfer agar restart tidak menghitung dua kali, lalu membuka kembali penahanan
entry yang berasal dari deposit tersebut. Tidak perlu restart setelah top-up.
Deposit saat bot mati diperiksa ketika `poly start` dijalankan. Selama bukti masih
ditunggu, monitoring dan penyelesaian posisi tetap berjalan.

Kas dari aktivitas manual dapat dialokasikan sebagai modal bot melalui review
terpisah dengan persetujuan eksplisit, ketika bot tidak memiliki posisi atau
order pending. Alokasi menyimpan bukti receipt dan saldo tanpa mengubah riwayat
transaksi wallet. Nilainya menambah modal, bukan profit trading atau anggaran
take-profit; aktivitas manual berikutnya tetap dicatat terpisah.

Top-up bukan profit: pencatatan modal dipisahkan dari hasil trading dan anggaran
take-profit. Equity serta puncaknya bertambah sebesar setoran yang sama sehingga
drawdown tidak hilang; baseline posisi terbuka ikut disesuaikan agar profit trade
tetap benar. Token selain pUSD di wallet trading belum menjadi modal sampai
konversi/deposit menghasilkan pUSD.

Mode eligible continuous juga menyinkronkan aktivitas manual otomatis dari
receipt pUSD dan CTF yang terkonfirmasi. Pembelian, penjualan, redeem, dan transfer
manual dicatat sebagai kas/inventory eksternal; profit manual tidak menambah
profit atau modal bot secara otomatis. Posisi manual pada market lain boleh tetap terbuka.
Pemeriksaan memakai checkpoint tersendiri, termasuk ketika perubahan kas bersih
nol, sehingga tidak perlu review manual baru setiap selesai trading.

Saldo seluruh token CTF dibaca melalui `balanceOfBatch` pada blok yang sama,
termasuk token historis bersaldo nol. Saat eligible continuous tidak memiliki
posisi, audit lengkap dijadwalkan berkala dan memberi prioritas pada slot entry.
Sebelum setiap order, saldo terbaru, holdings market, order manual, dan status
trade tetap diverifikasi. Audit tertunda tidak dianggap sukses dan tidak membuka
hold; pemulihan error serta pengelolaan posisi tetap memakai pemeriksaan lengkap.

Bot melewati market dengan posisi/order manual sebelum entry. Sisa order BUY
manual mengurangi saldo yang boleh dipakai bot. Bila aktivitas manual berimpit
dengan posisi bot yang sudah terbuka, penyelesaian menunggu bukti pemisahan
receipt; bot tidak boleh mengklaim atau menjual inventory manual. Status belum
terbukti menahan entry sambil dicoba ulang, tanpa mematikan layanan. Gunakan
`poly status` untuk membedakan menunggu sinkronisasi, modal, dan peluang entry.

Untuk ledger lama yang memerlukan pemulihan terkontrol,
`node scripts/eligible-reconcile-manual.js` memeriksa insiden saldo tertentu dengan
review privat `ELIGIBLE_MANUAL_WALLET_REVIEW`; `--apply` menerapkan pencatatannya
secara lokal setelah receipt, saldo checkpoint, inventory, dan akun terbaru cocok.
Review harus mengikat ledger yang tepat. Hasil manual dicatat terpisah: kas
trading bot, profit, setoran, dan puncak equity tidak dinaikkan. Stop terkait baru
dibuka setelah bukti lolos, dengan backup dan arsip insiden. Perintah ini tidak
mengirim transaksi atau menyalakan layanan.

Migrasi buffer dapat mempertahankan token manual kalah yang telah direview jika
payout resmi tepat nol, identitas token dan jumlahnya terbukti on-chain, serta
tidak ada kaitan dengan posisi bot. Token tersebut tetap tercatat sebagai
inventory eksternal bernilai nol; tidak dianggap telah di-redeem. Posisi yang
masih berpotensi membayar, belum resolved, atau tidak dikenal tetap memblokir
migrasi. Saldo di bawah kebutuhan entry membuat runner continuous menunggu
deposit; target 5 shares dan anggaran $5 tetap berlaku.

Unit continuous memakai `Restart=on-failure` dengan jeda lima detik tanpa batas
percobaan restart; aktivasi awal tetap manual dan `poly stop` tetap menghentikan
layanan. Mode default memakai `Restart=no`. Flag yang dipakai saat render ikut
disimpan di unit agar kebijakan runner dan restart sama. Perubahan mode memerlukan
unit yang dirender ulang; installer tetap menolak menimpa unit yang berbeda.

Gas transaksi dibayar dengan POL pada wallet penandatangan. Kekurangan gas atau
lonjakan biaya saat persiapan redeem menunda percobaan selama 30-60 detik;
rekonsiliasi dan redeem oleh protokol tetap dipantau. Log `action_gas_unavailable`
menampilkan saldo POL, cadangan maksimum yang diperlukan, dan kekurangannya.
Transaksi yang sudah dikirim tetap ditelusuri melalui hash tersimpan.

Kegagalan JSON-RPC pada operasi baca live dicatat dengan `rpcCode`, `rpcReason`,
dan `rpcMethod`, tanpa pesan mentah atau URL berkredensial. Gangguan provider
memakai RPC cadangan setelah chain dan blok cocok, dengan circuit breaker.
Dalam mode continuous, penolakan `eth_call` untuk saldo, holdings, atau payout
menahan entry sementara dan diperiksa ulang dengan jeda hingga 60 detik.
Entry menunggu pembacaan serta rekonsiliasi yang berhasil; transaksi tulis
tidak dikirim ulang lewat mekanisme ini.

Stop saldo dari versi lama yang kehilangan detail RPC memerlukan review
terikat ledger dan manifest runtime. `node scripts/eligible-recover-wallet.js`
memeriksa bukti akun tanpa perubahan; `--apply` mengarsipkan stop dan hold
setelah backup di bawah lock wallet. Perintah ini membutuhkan catatan review
privat, tidak mengubah modal/PnL, dan tidak memulai live.

Harga ringkasan trade API dapat tetap menunjukkan limit order ketika eksekusi
terjadi pada beberapa harga yang lebih baik. Jumlah saham dan identitas API
dipakai untuk menemukan transaksi; biaya pokok, fee, dan batas kumulatif order
tetap dibuktikan dari receipt on-chain.

Stop `invalid_owned_trade` akibat asumsi harga API lama dapat diperiksa dengan
`node scripts/eligible-recover-trade.js` dan review privat
`ELIGIBLE_OWNED_TRADE_REVIEW`. Recovery ini hanya menerima insiden yang fill dan
redemption-nya sudah tercatat, dengan inventory nol serta bukti akun dan saldo
terbaru yang cocok. `--apply` menyimpan backup dan arsip pemulihan di bawah lock
wallet. Perintah tidak mengirim transaksi, mengubah saldo/PnL, atau memulai live.

Untuk memulai periode risiko baru secara manual setelah periode lama selesai,
hentikan runner wallet, pastikan inventory/order serta transaksi atau penarikan
pending sudah selesai, dan backup seluruh ledger. Gunakan data root yang sama:

```bash
poly new-period
poly check
poly start    # Aktivasi manual dengan uang nyata jika preflight lulus
```

`new-period` menyiapkan periode baru setelah pemeriksaan wallet dan riwayat lulus;
perintah ini tidak memasang atau memulai layanan, mengirim order, atau transaksi.
Ledger, stop, dan drawdown periode lama tetap disimpan. Saat `start` kemudian
dijalankan, saldo pUSD diverifikasi ulang menjadi modal awal periode baru dan
drawdown memiliki ambang **$10 dari puncak equity periode baru**: mode default
menghentikan entry, sedangkan mode continuous hanya mencatat peringatan. Restart berikutnya
mempertahankan drawdown serta stop periode tersebut. Inventory atau transaksi
yang belum pasti tetap memblokir pembuatan periode baru.
Status API lama `MATCHED`/`MINED` untuk maker CLOB V1 dapat diverifikasi lewat
receipt order yang cocok, payout resmi, dan saldo token nol pada blok yang sama.
Bukti dicatat dan diperiksa ulang saat startup; status API tidak diubah.
Untuk signed FAK, estimasi biaya awal dipisahkan dari batas aktual entry $5.
Fee yang naik saat harga membaik dapat dibuktikan dari receipt selama principal
dan total biaya tetap memenuhi batas; semua transfer tetap harus cocok persis.

## Paper tuning Laya independen

`laya-filter-paper` menguji lima ledger virtual $20 terpisah: `laya` (kontrol candidate-v2), `spot-twap`, `price-cap-085`, `combined`, dan `model-edge`. Satu snapshot dan satu inference Laya dibagikan ke semua varian. `model-edge` menambahkan gate kuantitatif yang sudah ada (margin minimum $5 terhadap referensi BTC, z minimum 1,5, dan estimasi edge setelah biaya minimum 0,05); estimasi ini bukan probabilitas menang yang terbukti. Parameter tidak dilatih ulang dari loss terakhir.

```bash
node scripts/laya-filter-paper.js preflight --out="$PWD/data/laya-filter-paper/period-001" --smoke
node scripts/laya-filter-paper.js run --out="$PWD/data/laya-filter-paper/period-001"
node scripts/laya-filter-paper.js report --out="$PWD/data/laya-filter-paper/period-001" --history
```

Gunakan Node.js 24, konfigurasi feed dan Laya lokal yang sama, serta systemd user. Template: `deploy/polymarket-laya-filter-paper.service`. Sesuaikan path absolut Node/repo/output. Bekukan salinan kode selama periode; perubahan kode/parameter memerlukan direktori periode baru. Output dan manifest privat berada di bawah `data/`, terpisah dari ledger live. Inference paper ditahan saat layanan live, paper Laya lama, atau AI shadow aktif; pemeriksaan status layanan yang gagal juga menahan inference. Layanan lain tidak dihentikan otomatis.

Entry memakai history valid 180 detik, referensi TWAP pembukaan, slot 90/60/30 detik, data maksimum 5 detik, dan simulasi FAK pada book baru setelah minimal 250 ms dengan limit awal. Periode v3 (`laya-independent-filter-paper-v3`) memakai timeout adaptif `snapshot-freshness-budget-v1`; batas respons tetap 3 detik berlaku pada periode v2. Waktu admission bersama dan satu snapshot book eksekusi yang sama tetap digunakan untuk varian dari keputusan/slot yang sama. Budget serta veto tiap varian tetap diperiksa sendiri. Waktu dan hash book disimpan untuk memeriksa kesetaraan simulasi.

Sebelum memanggil AI, usia sumber dan metadata tetap maksimum 1.600 ms agar tersedia minimal 3 detik untuk inference, latency paper 250 ms, serta cadangan penjadwalan 150 ms. Bot menunggu update sumber yang nyata selama masih dalam toleransi slot 2 detik; jika waktunya tidak cukup, slot dilewati dengan alasan tercatat. Pada v3, deadline absolut respons dihitung dari timestamp paling tua antara sumber asli, validasi metadata, dan verifikasi tick bila ada: timestamp tersebut + 5.000 - 250 - 150 ms. Deadline juga dibatasi agar eksekusi menyisakan minimal 10 detik sebelum market berakhir. Respons di atas 3 detik dapat diterima bila masih memenuhi deadline dan seluruh pemeriksaan admission serta eksekusi; budget maksimum dari data baru adalah 4.600 ms. Update feed berikutnya tidak memperpanjang umur snapshot atau metadata asli. Hanya satu inference aktif; respons setelah timeout dicatat untuk laporan dengan drain maksimal 30 detik sejak request dimulai.

Perubahan timeout ini memerlukan direktori periode v3 baru setelah inventory dan inference periode lama selesai. Arsip v2 tetap memakai kebijakan serta manifest aslinya. Pemeriksaan freshness saat eksekusi, harga maksimum pada limit awal, depth book, batas modal, dan stop risiko tetap berlaku; kebijakan ini hanya diterapkan pada `laya-filter-paper`.

Setiap varian menargetkan 5 shares, maksimal $5 termasuk estimasi biaya, satu percobaan entry per market, dan settlement payout resmi. Tidak ada transaksi riil, batas 30 market, atau deadline otomatis. Drawdown riset $10 menghentikan entry varian terkait; inventory tetap dikelola. Restart mempertahankan fill dan stop.

Laporan tersimpan setiap menit dan setelah settlement melalui worker terpisah. Perintah `report` membaca ledger periode yang dipilih dan manifest aslinya, sehingga tidak membutuhkan kredensial atau kecocokan fingerprint kode terbaru. Laporan menyertakan jumlah slot yang diamati/dilewati, alasan per sisi, freshness, kegagalan eksekusi, dan pemeriksaan kesamaan sumber fill. Telemetri timeout menampilkan p50/p95 budget keputusan, respons di atas 3 detik yang diterima sebelum deadline, jumlah yang mereservasi minimal satu arm, respons selesai setelah timeout, serta timeout yang belum memiliki respons selesai. Semuanya dihitung sekali dari keputusan bersama, bukan lima kali dari setiap arm. Penerimaan respons tidak menjamin fill. Budget dan counter penerimaan yang tidak tersedia pada periode lama dinyatakan tidak tersedia.

Hasil hanya dibandingkan pada cohort market berlabel resmi yang sama, termasuk keputusan SKIP/timeout yang sudah final; hasil belum selesai tidak dianggap nol. Biaya inference dihitung sekali dan biaya komputasi yang belum diketahui ditampilkan terpisah. Kelayakan riset membutuhkan minimal tujuh hari, 100 market selesai dengan fill per varian, profit positif, dan bootstrap harian yang memenuhi syarat. Saat mengganti versi, tunggu inventory dan inference selesai, arsipkan ledger serta laporan, lalu gunakan direktori periode baru. `history.json` dapat menautkan periode arsip melalui `{ "periods": [{ "id": "ID_LAMA", "dataDir": "/absolute/old-period", "archivedAt": 0 }] }`; `report --history` menampilkan hasil masing-masing secara terpisah. Hasil lama tidak digabung dan tidak ada aktivasi live otomatis.

## Paper perbandingan keputusan Laya dan Gemini

`decision-paper` membuka lima ledger virtual independen, masing-masing $20: `laya`, `laya-filtered`, `gemini`, `eligible`, dan `skip`. Laya mempertahankan prompt serta input candidate-v2 asli. Gemini melalui 9router meminta model alias `polymarket-decision`, snapshot dasar yang sama, dan konteks tambahan yang dihitung deterministik: biaya penuh pada limit entry, probabilitas break-even, serta TWAP penutupan yang sudah teramati dan rata-rata sisa yang diperlukan. Perhitungan hanya memakai data yang tersedia saat snapshot; tidak memakai harga masa depan. `allowed` menyatakan sisi yang lolos guard, bukan prediksi menang. Probabilitas break-even juga bukan estimasi probabilitas menang.

```bash
node scripts/decision-paper.js preflight --out="$PWD/data/decision-paper/period-001" --smoke
node scripts/decision-paper.js run --out="$PWD/data/decision-paper/period-001"
node scripts/decision-paper.js report --out="$PWD/data/decision-paper/period-001" --history
```

Konfigurasi memakai `~/.config/polymarket-ai-shadow.env`, termasuk Laya lokal, `NINEROUTER_URL`, `NINEROUTER_KEY`, dan `AI_SHADOW_ROUTER_DB` (path absolut database lokal 9router untuk verifikasi alias secara read-only). Preflight memeriksa metadata model dan feed; `--smoke` tidak mengirim inference maupun transaksi. Template systemd user tersedia di `deploy/polymarket-decision-paper.service`; sesuaikan path absolut sebelum dipasang. Pergantian versi memakai direktori periode baru setelah inference dan inventory lama selesai, lalu arsipkan ledger, manifest, dan laporan lama. Bekukan kode serta kebijakan selama satu periode. `history.json` memakai format arsip pada bagian sebelumnya; laporan lama tetap dihitung memakai manifest dan kebijakannya sendiri, tanpa digabung dengan eksperimen baru.

Alias wajib menunjuk tepat satu model `ag/gemini-3.8-flash-low` untuk periode ini. Adapter memeriksa mapping sebelum pengiriman dan penerimaan, serta identitas respons termasuk versi upstream `gemini-3.8-flash-n`. Pergantian model atau reasoning memerlukan periode evaluasi baru. Metadata ready tidak membuktikan latency inference. Batas output 128 adalah permintaan klien; 9router/provider dapat memakai batas internal lebih besar untuk reasoning.

Deadline entry tetap mengikuti freshness snapshot asli, maksimal 5 detik termasuk eksekusi. Setelah deadline, Gemini tetap ditunggu secara asinkron hingga 120 detik untuk mencatat keputusan, identitas, biaya, dan latency sebagai pembanding; respons terlambat tidak menghasilkan fill. Satu HTTP lokal boleh aktif pada satu waktu. Jika transport gagal atau belum selesai setelah 120 detik, koneksi dibatalkan dan cooldown 120 detik dipersist. Setelah jeda dan preflight berhasil, snapshot baru boleh diajukan kembali secara otomatis; snapshot lama tidak di-retry. Abort lokal tidak membuktikan pembatalan upstream. Restart dengan request tidak pasti menyimpan jeda drain ditambah cooldown sebelum melanjutkan. Fault penyimpanan tetap menahan inference agar ledger tidak rusak. Laya dan arm lain berjalan independen.

Replay prompt historis opsional memakai input asli yang sama dan label resmi hanya setelah inference. Jalankan saat layanan yang memakai Laya sudah berhenti dan inventory periode lama selesai; observer file lokal boleh tetap aktif. Direktori output wajib baru, dan hasil replay tidak menjadi PnL atau bukti kelulusan:

```bash
node scripts/decision-prompt-replay.js --ledger=/absolute/old-period/id/ledger.json --out=/absolute/validation/prompt-replay-001 --pairs=4
```

Laya dan Gemini meminta keputusan secara paralel. Tiap arm menerima responsnya sendiri segera setelah siap dan tidak menunggu provider yang lebih lambat. `eligible` membeli satu sisi yang memenuhi syarat tanpa inference dan memakai latency paper 250 ms; `skip` selalu tanpa entry. Semua entry memakai guard freshness, metadata, limit harga, depth, modal, dan risiko yang sama. Book serta waktu fill boleh berbeda karena waktu respons berbeda. Slot 90/60/30 detik, target 5 shares, cap $5, timeout adaptif, settlement resmi, dan drawdown riset $10 mengikuti kebijakan paper. Tidak ada transaksi riil atau promosi live otomatis.

Laporan membandingkan konfigurasi model, prompt, input, dan latency; hasilnya tidak mengisolasi keunggulan model murni. PnL setelah fee/gas mencerminkan kemampuan eksekusi pada latency aktual. Delta terhadap Laya dan `eligible` memakai cohort market berlabel resmi yang sama, termasuk SKIP dan timeout yang sudah final; hasil yang belum selesai tidak dianggap nol. Kualitas arah BUY tepat waktu ditampilkan terpisah dari PnL karena biaya entry, pilihan market, dan fill memengaruhi hasil trading. Confidence jawaban tidak dianggap probabilitas terkalibrasi. Interval bootstrap harian Asia/Jakarta tetap kosong sampai hari dan jumlah market mencukupi.

Laya `typed-decisions` mendukung pilihan `BUY_UP`, `BUY_DOWN`, dan `SKIP`; bot tidak membatasi respons ke boolean. `answer_confidence` merupakan probabilitas pilihan maksimum, sedangkan `confidence` berbasis entropy. Keduanya belum membuktikan probabilitas kemenangan BTC setelah biaya. Laporan `layaConfidenceDiagnostics` menampilkan skor versus payout resmi, dipisahkan per arah dan respons tepat waktu/terlambat, dengan kelompok skor dan coverage cutoff tetap. Tidak ada cutoff entry baru atau pemilihan threshold otomatis. `responseDecisionQuality` juga menilai jawaban Gemini terlambat secara terpisah, tanpa mengubahnya menjadi profit hipotetis.

Varian `laya-filtered` berbagi respons Laya asli, lalu memberi veto bila spot dan TWAP tidak searah dengan posisi atau jaraknya dari acuan pembukaan kurang dari satu unit volatilitas horizon (`sigma * sqrt(sisa detik)`). Bila sebagian TWAP penutupan tersedia, jarak dari ambang rata-rata sisa juga diperiksa. Ambang tetap satu, tanpa fitting atau perubahan otomatis, dan bukan probabilitas menang. Varian ini adalah kandidat riset: seleksi retrospektif membuang sebagian pemenang dan masih menyisakan kekalahan. Bukti profit harus berasal dari periode prospektif baru.

Kedua arm Laya yang lolos memakai satu waktu admission dan cohort book eksekusi yang sama. Respons mentah tetap tersedia ketika filter menghasilkan SKIP. Filter veto tidak menghabiskan percobaan order, sehingga slot berikutnya masih bisa dinilai; hanya satu order per market di setiap arm. Tidak ada inference duplikat per snapshot, tetapi varian yang masih tersedia dapat menambah jumlah snapshot yang membutuhkan inference. Laporan menampilkan veto, `candidateOnlyRequests`, dan biaya per provider; biaya virtual antar-arm tidak dijumlahkan.

Gemini memakai respons streaming dengan jawaban JSON action ringkas. Parser menunggu `stop` dan akhir stream yang bersih, memeriksa identitas tiap chunk, serta membatasi ukuran respons; potongan respons tidak bisa menghasilkan entry. Telemetri memisahkan persiapan lokal, header, byte pertama, konten pertama, dan penyelesaian. Reasoning mentah tidak disimpan. Waktu antrean upstream tidak dapat dipisahkan dari jaringan/komputasi dan tetap tidak diketahui. Streaming tidak menjamin respons lebih cepat dari deadline.

Drawdown tetap berdasarkan nilai likuidasi inventory dan puncak historis periode; dapat berbeda dari rugi setelah settlement. Pemicu stop sekarang menyimpan equity, kas, posisi, waktu/book mark, kedalaman likuidasi dan evidence settlement. Stop tidak dihapus saat posisi akhirnya menang. Setelah seluruh arm eksekusi provider terkena stop risiko, inference boleh berlanjut sebagai `diagnosticOnly`; hasil dan biayanya masuk `postStopDecisionQuality`/`postStopCosts`, terpisah dari hasil trading. Pergantian kode/prompt/filter wajib memakai periode baru; arsip dan stop lama dipertahankan.

Request, status, latency respons p50/p95, timeout, identitas model/prompt, serta biaya API yang diketahui dan belum diketahui dicatat sekali per provider dan snapshot. Waktu menunggu timeout tidak dianggap latency respons selesai; respons terlambat tetap dapat melengkapi telemetri biaya/latency. Biaya komputasi lokal tetap belum diketahui. Profit ledger virtual tidak dijumlahkan sebagai hasil satu portofolio. Laporan privat ditulis ke `<out>/<id>/reports/latest.json` dan `latest.md` setiap menit serta setelah settlement melalui worker terpisah.

## Paper filter entry tanpa AI

`entry-filter-paper` menguji empat ledger virtual $20 dengan satu keputusan deterministik dan snapshot eksekusi bersama. `eligible` menjadi kontrol tanpa filter tambahan; `cost-cap` membatasi estimasi biaya penuh per share menjadi $0,85; `buffer` memakai keselarasan spot/TWAP dan buffer volatilitas satu sigma; `combined` mewajibkan kedua filter. Angka $0,85 mencakup harga limit, fee, dan estimasi gas untuk full fill, bukan batas harga ask dan bukan probabilitas menang. Partial fill dapat memiliki biaya gas per share lebih tinggi; laporan mencatat biaya aktual simulasi secara terpisah.

```bash
node scripts/entry-filter-paper.js preflight --out="$PWD/data/entry-filter-paper/period-v2-001" --smoke
node scripts/entry-filter-paper.js run --out="$PWD/data/entry-filter-paper/period-v2-001"
node scripts/entry-filter-paper.js report --out="$PWD/data/entry-filter-paper/period-v2-001" --history
```

Gunakan Node.js 24 dan konfigurasi feed/RPC lokal. Template layanan tersedia di `deploy/polymarket-entry-filter-paper.service`. Proses tidak memanggil Laya/9router dan dapat berjalan berdampingan dengan eksperimen AI serta live. Client hanya menyediakan pembacaan publik; saldo virtual, periode, dan runtime harus terpisah. Simpan konfigurasi privat di luar Git.

Periode v2 (`entry-filter-paper-v2`) memakai slot 90/57/30 detik sebelum penutupan, target 5 shares, dan cap entry $5. Feed BTC mengumpulkan history langsung 180 detik saat warmup. Slot 57 detik memberi jeda 3 detik setelah awal jendela TWAP penutupan; observasi dalam menit terakhir menunggu sumber yang benar-benar sudah masuk ke jendela tersebut selama toleransi slot masih tersedia. Filter buffer dalam menit terakhir tetap memerlukan konteks TWAP penutupan yang valid; history atau sumber yang belum siap dicatat sebagai masalah data/konteks.

Freshness sumber tetap maksimal 5 detik. Bila WebSocket belum siap atau sedang warmup, observasi dan eksekusi boleh memakai pasangan book REST baru dengan verifikasi metadata, token, tick independen, respons tanpa cache, dan timestamp sumber asli. Respons HTTP baru tidak membuat timestamp book lama menjadi segar. Kegagalan verifikasi melewatkan peluang dengan alasan tercatat. Pemulihan book tidak menggantikan kebutuhan history BTC dan tidak memperpanjang umur snapshot admission.

Keputusan lokal menyisakan latency paper minimal 250 ms dan cadangan 150 ms dalam budget freshness. Snapshot, keputusan, dan reservasi semua arm pada cohort yang sama dicatat atomik, lalu simulasi FAK memakai satu book eksekusi baru dan satu timestamp bersama setelah latency tersebut. Limit harga dibekukan saat admission; partial fill diterima tanpa mengejar sisa atau menaikkan limit. Laporan memeriksa kesamaan hash, waktu, dan sumber book tiap arm serta bukti verifikasi REST bila dipakai.

Parameter dibekukan dalam manifest sebelum pengumpulan data. Filter veto boleh dinilai lagi pada slot berikutnya, tetapi satu percobaan order menghabiskan kesempatan market pada arm tersebut. Settlement memakai payout resmi. Stop drawdown riset $10 dan pelanggaran ambang pilot $2 bertahan setelah restart; inventory tetap dikelola. Kebijakan paper ini tidak mengubah pengaturan risiko live.

Laporan tiap menit menampilkan tanggal mulai dan umur observasi periode, entry/fill/settlement terakhir per arm, serta durasi tanpa fill baru. Timestamp yang belum tercatat tetap tidak diketahui; order pending tidak dihitung sebagai fill. Jumlah snapshot unik, slot, dan market unik ditampilkan terpisah. Alasan penolakan filter strategi dibedakan dari kegagalan pipeline, data/konteks yang belum siap, arm yang tidak tersedia, serta kegagalan eksekusi. Status sumber book, pemulihan REST, waktu tunggu, profit setelah fee/gas, win/loss, drawdown, partial/no-fill, dan loss yang terhindar atau win yang terlewat pada cohort bersama tetap tersedia.

Review awal setelah 24 jam menilai operasional dan hasil sementara. Bukti riset tetap membutuhkan sedikitnya 7 hari dan 100 market selesai dengan fill per arm, profit positif, serta interval bootstrap harian yang memenuhi syarat. Empat varian merupakan pengujian hipotesis; memilih yang terlihat paling untung belum membuktikan keunggulannya. Tidak ada promosi live atau perubahan parameter otomatis.

Perubahan kode atau parameter memerlukan direktori periode baru setelah inventory lama selesai. Simpan ledger, manifest, stop risiko, dan laporan periode lama; tautkan arsip melalui `history.json` untuk `report --history`. Periode v1 tetap memakai kebijakan tersimpannya, termasuk slot 90/60/30 detik, sedangkan v2 memakai manifest dan saldo virtual baru. Laporan tiap periode dihitung terpisah; fill, win/loss, profit, dan saldo antarperiode maupun antar-arm tidak dijumlahkan menjadi satu hasil trading.

### Uji slot entry dan penurunan ask

Profil opt-in `live-tuning-v1` memulai tiga ledger virtual $20 pada direktori baru:

| Arm | Aturan tambahan di atas Cost-cap |
| --- | --- |
| `cost-cap-control` | Kontrol: slot 90/60/30 detik sebelum penutupan |
| `cost-cap-90s` | Hanya slot 90 detik |
| `cost-cap-drop-2c` | Slot 90/60/30; batalkan percobaan jika ask turun lebih dari $0,02 sejak snapshot |

```bash
node scripts/entry-filter-paper.js preflight --profile=live-tuning-v1 --out="$PWD/data/entry-filter-paper/tuning-001" --smoke
node scripts/entry-filter-paper.js run --profile=live-tuning-v1 --out="$PWD/data/entry-filter-paper/tuning-001"
node scripts/entry-filter-paper.js report --out="$PWD/data/entry-filter-paper/tuning-001" --history
```

Profil ini memakai waktu observasi dan Cost-cap live: slot 90/60/30, target umur
snapshot 1.600 ms, book WebSocket tervalidasi, history BTC 180 detik, dan tanpa
syarat tambahan konteks TWAP penutupan dari profil v2. REST memvalidasi metadata;
profil ini tidak menggunakan fallback book REST v2. Gap feed menunggu pemulihan
dan warmup sambil proses tetap berjalan. Hasil live dicatat terpisah.

Semua arm memakai snapshot dan book eksekusi bersama, minimum latency 250 ms,
5 shares, cap entry $5, dan estimasi all-in maksimal $0,85/share. Filter ask
membandingkan ask awal dengan ask eksekusi, bukan dengan limit yang mengandung
slippage. Penurunan tepat $0,02 tetap diizinkan. Veto saat eksekusi menghabiskan
satu percobaan market, dicatat sebagai keputusan filter dengan eksposur nol,
dan tidak mengejar order pada slot berikutnya. Kedua hipotesis diuji terpisah.

Simulasi menyapu depth sampai 5 shares pada limit awal. FAK live dapat menghasilkan
lebih dari 5 shares ketika harga membaik; hasil paper tidak menjanjikan fill atau
PnL live yang identik. Laporan menyimpan checkpoint pertama setelah 24 jam dan
mempertahankan syarat 7 hari/100 fill per arm. Saldo, hasil, dan kerugian periode
lama tetap terpisah; tidak ada promosi otomatis ke live.

### Pengumpulan berkelanjutan untuk tuning

Profil `live-tuning-v2` mempertahankan tiga hipotesis, slot 90/60/30 detik,
modal virtual $20 per arm, target 5 shares, dan stop drawdown $10. Profil ini
memperbaiki coverage dengan pasangan book REST yang diverifikasi ketika
WebSocket belum siap atau terputus. Metadata, token, tick, cache, dan timestamp
sumber tetap diperiksa; book maksimal berusia 5 detik. Pemulihan tidak
memperpanjang deadline, menaikkan limit awal, atau menggantikan history BTC
180 detik. Perubahan sumber data ini memerlukan periode baru; hasilnya tidak
digabung sebagai kelanjutan profil v1.

```bash
node scripts/entry-filter-paper.js preflight --profile=live-tuning-v2 --out="$PWD/data/entry-filter-paper/tuning-v2-001" --smoke
node scripts/entry-filter-paper.js run --profile=live-tuning-v2 --out="$PWD/data/entry-filter-paper/tuning-v2-001"
node scripts/entry-filter-paper.js report --out="$PWD/data/entry-filter-paper/tuning-v2-001" --history
```

Snapshot dan label payout resmi tetap dikumpulkan ketika arm sedang memiliki
posisi, sudah memakai kesempatan market, kekurangan kas virtual, atau terkena
stop risiko. Snapshot dengan harga yang tidak memenuhi entry juga disimpan
beserta alasan penolakan. Kandidat diagnostik memakai anggaran riset awal;
setiap reservasi tetap memeriksa kas aktual, posisi, dan stop arm. Pengumpulan
ini tidak mereset saldo atau menambah trade pada arm yang sudah berhenti.
Data setelah stop ditandai terpisah dan tidak menjadi bukti profit simulasi.

Manifest membekukan rencana evaluasi: sedikitnya 7 hari observasi dan 100 fill
selesai per arm, pembandingan pada jendela entry yang berakhir saat stop arm
pertama, serta validasi pada periode 7 hari berikutnya dengan kebijakan yang
sudah dipilih dan dibekukan sebelumnya. Settlement dari entry di dalam jendela
tetap dihitung walaupun selesai setelah batas jendela. Jumlah snapshot pasif
tidak menggantikan syarat fill atau hari cohort trading. Bila stop terjadi
lebih awal, hasil risiko tersebut tetap berlaku dan tidak dihapus agar syarat
sampel terpenuhi. Checkpoint 24 jam memeriksa operasional; pemilihan strategi,
periode validasi berikutnya, dan promosi live memerlukan review hasil.

### Uji prospektif batas biaya 0,85 vs 0,82

Profil `live-cost-cap-v1` membandingkan dua ledger virtual baru: `cost-cap-control`
memakai batas all-in $0,85/share dan `cost-cap-082` memakai $0,82/share. Keduanya
menghitung harga limit yang dibekukan, fee, dan estimasi gas untuk full fill.
Batas ini bukan harga ask atau prediksi probabilitas menang.

```bash
node scripts/entry-filter-paper.js preflight --profile=live-cost-cap-v1 --out="$PWD/data/entry-filter-paper/cost-cap-001" --smoke
node scripts/entry-filter-paper.js run --profile=live-cost-cap-v1 --out="$PWD/data/entry-filter-paper/cost-cap-001"
node scripts/entry-filter-paper.js report --out="$PWD/data/entry-filter-paper/cost-cap-001" --history
```

Modal $20 per arm, 5 shares, cap entry $5, slot 90/60/30 detik, latency 250 ms,
fee/gas, depth, batas freshness, dan recovery book mengikuti `live-tuning-v2`.
Kedua arm mendapat snapshot bersama; bila masuk pada slot yang sama, book dan
waktu simulasi eksekusinya juga sama. Veto biaya membolehkan penilaian ulang pada
slot berikutnya; reservasi order menghabiskan satu kesempatan market per arm.
Tidak ada filter slot khusus atau veto penurunan ask pada profil ini. Partial
fill bisa memiliki biaya per share di atas batas admission karena gas tetap.

Manifest membekukan kedua batas dan rencana evaluasi sebelum data dikumpulkan.
Checkpoint 24 jam menilai operasional; evaluasi membutuhkan sedikitnya 7 hari
dan 100 trade terisi selesai per arm dalam jendela pembandingan bersama yang
berakhir saat stop arm pertama. Stop drawdown riset $10 tetap persisten;
snapshot/label setelah stop adalah data diagnostik. Tujuh hari adalah syarat
bukti minimum, bukan perintah berhenti atau reset otomatis.

Bandingkan profit bersih setelah fee/gas, expectancy, drawdown, fill rate, loss
yang terhindar, dan win yang terlewat. Kandidat perlu menunjukkan keunggulan
pada data baru, lalu dikonfirmasi pada periode tujuh hari berikutnya dengan
parameter tetap sebelum dipertimbangkan untuk live. Paper menyapu depth sampai
5 shares; FAK live dapat mengisi lebih banyak saat harga membaik, sehingga hasil
paper tidak menjamin hasil eksekusi live yang identik.

Gunakan runtime yang dibekukan dan direktori periode baru, arsipkan periode
sebelumnya setelah inventory kosong, serta tautkan seluruh riwayat melalui
`history.json`. Jangan menggabungkan PnL antarperiode atau mereset stop lama.
Tidak ada perubahan parameter maupun promosi live otomatis.

Replikasi dengan kebijakan yang sama memakai direktori periode baru dan
protokol evaluasi yang dicatat sebelum startup. Simpan protokol bertanggal
serta hasil operasional di catatan deployment privat; semua periode yang
terkena stop tetap ditautkan dalam riwayat evaluasi.

## Paper momentum 30 detik tanpa AI

Profil `live-momentum-v1` menguji tiga ledger virtual dengan batas estimasi
biaya penuh 0,82 per share yang sama:

| Arm | Aturan tambahan |
| --- | --- |
| `cost-cap-control` | Kontrol pada slot 90/60/30 detik |
| `cost-cap-momentum30` | Hipotesis utama: return BTC 30 detik >0 untuk UP, <0 untuk DOWN |
| `cost-cap-drop-2c` | Hipotesis sekunder: tolak bila ask turun >0,02 dari snapshot ke book eksekusi |

Nilai return nol, hilang, non-finite, atau input yang gagal pemeriksaan hash,
identitas dan waktu ditolak oleh arm momentum. Tidak ada optimasi ambang
magnitudo atau gabungan kedua filter. Penurunan ask tepat 0,02 tetap boleh;
harga fill atau hasil market setelah entry tidak menjadi input keputusan.

```bash
node scripts/entry-filter-paper.js preflight --profile=live-momentum-v1 --out="$PWD/data/entry-filter-paper/momentum-001" --smoke
node scripts/entry-filter-paper.js run --profile=live-momentum-v1 --out="$PWD/data/entry-filter-paper/momentum-001"
node scripts/entry-filter-paper.js report --out="$PWD/data/entry-filter-paper/momentum-001" --history
```

Modal virtual 20 per arm, target 5 shares, cap entry 5, gas/fee, freshness dan
stop drawdown riset 10 tetap berlaku. Veto admission membolehkan slot berikutnya;
reservasi order menghabiskan kesempatan market, termasuk saat veto ask-drop
menolak eksekusinya. Snapshot dan book eksekusi bersama mencegah perbedaan
waktu antar-arm yang masuk bersamaan. Paper memakai fixed-share depth sweep;
FAK live dapat memperoleh lebih banyak shares dengan principal yang sama.

Manifest membekukan definisi momentum dan peran primary/secondary sebelum
startup. Bandingkan net PnL pada cohort market yang sama, winrate profit,
drawdown, fill rate serta peluang yang dilewatkan. Jangan menganggap data
observasi yang hilang sebagai return nol. Rata-rata selisih PnL memakai market
berlabel resmi dengan observasi entry yang layak dan hasil seluruh arm
lengkap; observasi diagnostik saja, tanpa sisi eligible, serta entry di luar
jendela bersama dikeluarkan dari denominator. Coverage slot dilaporkan terpisah.
Target minimum tetap 7 hari aktif
bersama, 7 hari entry teramati dan 100 fills selesai per arm; penilaian
berakhir pada stop arm pertama. Hasil tidak cukup bila stop terjadi lebih
awal. Checkpoint 24 jam hanya memeriksa operasional.

Pertahankan periode dan stop lama; gunakan direktori baru untuk hipotesis
ini. Pembanding ask-drop tetap eksploratif, bukan pengganti hipotesis utama
yang gagal. Perlu konfirmasi periode independen berikutnya dengan parameter
tetap sebelum review live. Tidak ada promosi atau reset otomatis.

## Paper entry sebelum pembukaan dengan momentum dan AI

Default `premarket-paper` memakai profil `legacy-three-candles-v1` untuk menguji
market BTC 5 menit berikutnya pada **240 detik sebelum pembukaan**. Empat ledger
virtual terpisah masing-masing dimulai dari $20:

- `premarket-momentum`: tiga candle 1 menit selesai bearish dengan close berurutan
  lebih rendah memilih Down; tiga candle bullish dengan close lebih tinggi memilih
  Up. Selain itu SKIP. Volatilitas dan pantulan dicatat sebagai diagnostik.
- `laya-premarket`: checkpoint `typed-decisions` memilih Up, Down, atau SKIP dari
  snapshot yang sama; konteks dan pertanyaan sebenarnya diperiksa terhadap batas
  1.024 token tanpa pemotongan.
- `router-premarket`: model tetap `cx/gpt-6.1-sol` melalui 9router, reasoning
  `medium`, tanpa fallback. `PREMARKET_ROUTER_MODEL=cx/gpt-6-astra` dapat dipilih
  sebelum periode baru; tidak mengganti alias eksperimen lama.
- `late-cost-cap`: kontrol late-entry pada market yang sama, slot 90/60/30 detik
  sebelum penutupan, ask $0.72-$0.90, dan estimasi all-in maksimal $0.85/share.

```bash
node scripts/premarket-paper.js preflight --out="$PWD/data/premarket-paper/period-001" --smoke
node scripts/premarket-paper.js run --out="$PWD/data/premarket-paper/period-001"
node scripts/premarket-paper.js report --out="$PWD/data/premarket-paper/period-001" --history
```

Default menjalankan keempat arm. Untuk eksperimen paper GPT terpisah, pilih
`PREMARKET_ACTIVE_ARMS=router-premarket` dengan direktori output baru:

```bash
PREMARKET_ACTIVE_ARMS=router-premarket node scripts/premarket-paper.js preflight --out="$PWD/data/premarket-paper/gpt-period-001" --smoke
PREMARKET_ACTIVE_ARMS=router-premarket node scripts/premarket-paper.js run --out="$PWD/data/premarket-paper/gpt-period-001"
node scripts/premarket-paper.js report --out="$PWD/data/premarket-paper/gpt-period-001"
```

Pilihan beberapa arm dipisahkan koma dan dibekukan dalam manifest. Empat ledger
tetap tersedia, tetapi arm yang tidak dipilih tidak menjalankan entry/inference.
Arm tidak aktif juga tidak menjadi kontrol PnL nol: perbandingannya ditandai
`arm_not_selected`. Periode GPT saja tidak memerlukan Laya atau tokenizer.

Untuk membandingkan rule momentum, Laya, dan GPT pada data serta waktu yang sama,
gunakan profil opt-in `fair-near-open-30m-v1` dengan direktori periode baru:

```bash
PREMARKET_PROFILE=fair-near-open-30m-v1 node scripts/premarket-paper.js preflight --out="$PWD/data/premarket-paper/fair-near-open-30m-001" --smoke
PREMARKET_PROFILE=fair-near-open-30m-v1 node scripts/premarket-paper.js run --out="$PWD/data/premarket-paper/fair-near-open-30m-001"
node scripts/premarket-paper.js report --out="$PWD/data/premarket-paper/fair-near-open-30m-001" --history
```

Profil fair mewajibkan tiga arm aktif: `premarket-momentum`, `laya-premarket`, dan
`router-premarket`. Masing-masing memiliki modal virtual $20, target 5 shares,
dan cap entry $5 termasuk fee/gas. `premarket-momentum` menjadi kontrol paired;
`late-cost-cap` tidak aktif dan hanya menjadi referensi historis. Hasil kontrol
late-entry tidak dipakai sebagai baseline setara untuk perbandingan ini.

Aturan momentum 30 menit dibekukan sebagai hipotesis baru: return 5/15/30 menit
harus searah dan masing-masing memiliki kekuatan absolut minimal 0,5/1/1 setelah
dibagi `sigma * sqrt(durasi detik)`. Minimal lima dari enam candle 5 menit harus
searah, dan return 60 detik terakhir tidak boleh berbalik melawan arah tersebut.
Data tidak lengkap, volatilitas tidak valid, atau syarat gagal menghasilkan SKIP.
Aturan ini tidak menghasilkan probabilitas menang dan belum dituning pada hasil
periode baru; aturan tiga candle legacy tetap milik profil lama.

Snapshot dibekukan **60 detik sebelum pembukaan** dari 30 candle Chainlink BTC/USD
1 menit yang sudah selesai dan diketahui saat cutoff. Semua arm menerima input
ringkas yang sama, termasuk perubahan harga 30/60 detik dan 3/5/15/30 menit. Harga
OHLC dibulatkan ke sen terdekat dan enam kelompok 5 menit diturunkan dari 30
candle yang sama; ini mengurangi presisi harga, tanpa menghapus candle atau
memendekkan history. Kuantisasi dicatat dalam coverage dan aturan momentum juga
memakai representasi tersebut. Data asli tetap tersedia sebagai audit snapshot.

Input dan pertanyaan aktual dihitung dengan tokenizer Laya terhadap batas 1.024
token sebelum ketiga arm dapat masuk. Jika history kurang, tokenizer gagal,
identitas konteks tidak cocok, atau input tidak muat, seluruh cohort melewati
entry dengan alasan tercatat. Tidak ada pemotongan diam-diam atau input GPT yang
lebih lengkap. Laya dan GPT memiliki budget keputusan 30 detik; momentum menunggu
cutoff keputusan bersama. Semua keputusan BUY yang valid memakai validasi book
baru dan antrean eksekusi bersama, lalu simulasi FAK setelah minimal 250 ms.
SKIP, timeout, dan no-fill tetap masuk cohort paired ketika outcome sudah final.

Laporan mencatat hash input tiap arm, coverage 30 menit, pengukuran konteks Laya,
dan bukti eksekusi bersama. Bukti yang hilang atau berbeda menghasilkan status
comparability `incomplete`; kesetaraan tidak diasumsikan dari nama profil saja.
Warmup atau kegagalan gate bersama yang tercatat menghasilkan SKIP seragam:
market tetap masuk cohort sebagai PnL nol, tetapi dihitung terpisah dari market
dengan keputusan atas input lengkap. Laporan tidak mengklaim ada input atau
inference pada slot yang gagal sebelum snapshot terbentuk.
Biaya inference yang belum diketahui tetap `null`; biaya compute lokal juga
belum diketahui. Hasil lama tidak digabung ke sampel atau kualifikasi profil baru.

Profil sebelumnya `near-open-30m-v1` mengambil snapshot **60 detik sebelum pembukaan**
dan hanya mendukung `router-premarket`. Mulai periode baru dengan `--out` baru:

```bash
PREMARKET_PROFILE=near-open-30m-v1 PREMARKET_ACTIVE_ARMS=router-premarket node scripts/premarket-paper.js preflight --out="$PWD/data/premarket-paper/gpt-near-open-30m-001" --smoke
PREMARKET_PROFILE=near-open-30m-v1 PREMARKET_ACTIVE_ARMS=router-premarket node scripts/premarket-paper.js run --out="$PWD/data/premarket-paper/gpt-near-open-30m-001"
node scripts/premarket-paper.js report --out="$PWD/data/premarket-paper/gpt-near-open-30m-001" --history
```

Profil ini mengirim seluruh 30 candle Chainlink BTC/USD 1 menit yang sudah
selesai, enam kelompok berurutan masing-masing lima candle (5 menit), dan
perubahan harga 30/60 detik serta 3/5/15/30 menit. Seluruh input dibekukan sebelum
inference; konteks yang terlalu besar ditolak, tanpa pemotongan diam-diam. Model
tetap `cx/gpt-6.1-sol`, reasoning `medium`, dengan budget AI 30 detik. Pemilihan
Laya atau arm lain untuk profil ini ditolak; format JSON penuh profil lama ini
tidak muat dalam konteks Laya 1.024 token. Gunakan profil fair untuk perbandingan
ketiga arm dengan representasi ringkas bersama.

Startup, restart, atau gap feed memerlukan minimal 30 menit pengamatan LIVE
tanpa putus, sampai 30 candle selesai tersedia. Penyelarasan batas menit dapat
menambah waktu warmup. Tidak ada backfill untuk melengkapi warmup. Slot selama
warmup dilewati, bukan diisi history lama atau data yang datang setelah cutoff.

Gunakan Node.js 24 dan konfigurasi feed/RPC lokal, `AI_SHADOW_LAYA_URL`,
`AI_SHADOW_LAYA_CONTAINER`, `NINEROUTER_URL` berakhiran `/v1`, serta
`NINEROUTER_KEY` di file privat sesuai provider yang dipilih. GPT memakai koneksi
langganan dan key lokal 9router yang sudah ada; tidak perlu API key OpenAI baru.
Template service:
`deploy/polymarket-premarket-paper.service`. Sesuaikan lokasi Node, checkout,
EnvironmentFile dan direktori periode sebelum memasangnya. Preflight/smoke
memeriksa API, metadata, book market mendatang, BTC, dan provider yang dipilih
(termasuk tokenizer untuk Laya); tidak mengirim inference ataupun transaksi.
Client paper memblokir operasi order, cancel, dan transaksi on-chain.
Autentikasi feed BTC tetap membutuhkan
kredensial wallet lokal. Tidak ada live atau promosi live otomatis.

Sinyal menggunakan candle dengan waktu sumber dan penerimaan sebelum waktu
keputusan tetap. Pada profil legacy, startup atau gap perlu mengumpulkan kembali
tiga candle lengkap; history 15 menit tersedia bertahap sebagai diagnostik.
Kedua profil near-open mewajibkan history 30 menit lengkap. Referensi TWAP pembukaan
market mendatang belum diketahui dan dikirim sebagai `null`, bukan harga sekarang.
Hasil tetap berasal dari payout CTF resmi. Pembelian pada 23:36 untuk market
23:40-23:45 memprediksi hasil periode 23:40-23:45.

Pada profil legacy dan near-open router, kontrak GPT mencantumkan sisi, satuan harga, biaya penuh termasuk fee/gas, dan
probabilitas break-even. Jawaban menyertakan `estimatedUpProbability` (boleh
`null`), `reasonCode`, serta alasan singkat. Estimasi probabilitas ini belum
terkalibrasi; `expectedNetUsd` dihitung dari estimasi tersebut dan biaya order.
BUY harus diizinkan dan memiliki estimasi net positif. GPT tetap boleh SKIP
karena bukti lemah atau sinyal bertentangan; perubahan kontrak tidak menjamin BUY
atau profit. Kedua TWAP masa depan yang belum diketahui adalah bagian dari tugas
prediksi sebelum pembukaan.

Pada profil fair, Laya dan GPT menerima instruksi semantik yang sama untuk memilih
BUY hanya bila estimasi nilai setelah biaya positif; SKIP selalu diperbolehkan.
GPT tidak memiliki gate numerik tambahan yang tidak dapat dipenuhi protokol Laya.
Estimasi probabilitas GPT bersifat opsional dan hanya diagnostik; distribusi
pilihan Laya bukan probabilitas menang. Allowed actions serta pengaman biaya dan
eksekusi berlaku sama untuk kedua AI dan kontrol momentum.

Watchdog memeriksa umur harga BTC dan TWAP, termasuk saat socket masih menerima
pong. Setelah 15 detik tanpa harga valid, history direset dan subscription lama
ditutup sebelum menyambungkan ulang dengan jeda 2-30 detik. Subscription yang
belum selesai ditutup tidak ditumpuk dengan subscription baru. Candle perlu
warmup ulang setelah gap; batas usia data untuk keputusan tetap 5 detik.

AI punya waktu maksimal 30 detik sejak snapshot ditangkap. Data saat penangkapan
harus berusia maksimal 5 detik; snapshot prediksi sengaja dibekukan selama inference.
Book eksekusi diperiksa lagi dan tetap maksimal 5 detik. Forecast dapat lebih tua
dari book tersebut. Harga limit tetap berasal dari snapshot awal, dengan toleransi
satu tick atau $0.01. Jawaban terlambat, invalid, atau berbeda model menjadi SKIP.
Status kegagalan tersebut dicatat terpisah dari respons valid model yang memilih
SKIP; alasan model lama yang tidak tersimpan ditampilkan sebagai `unknown`.
Satu request aktif per mesin; request terlambat ditunggu sampai maksimal 60 detik
tanpa antrean/retry. Status inference yang tidak pasti setelah drain atau restart
menonaktifkan arm tersebut secara persisten dalam periode ini.

Target 5 shares, maksimal $5 termasuk estimasi fee/gas, spread maksimum $0.02,
dan satu market aktif per arm. Market berikutnya dapat dilewati selama inventory
masih tertahan. Simulasi FAK memakai book baru setelah minimal 250 ms, menerima
partial fill tanpa mengejar sisa. Harga sekitar $0.50 adalah contoh per share,
bukan jaminan fill atau batas harga tetap; premarket mencatat harga/biaya aktual.
Modal $1 untuk dua shares di UI tidak identik dengan target 5 shares eksperimen.

Laporan per menit memisahkan profit trading setelah fee/gas, biaya inference,
akurasi arah, fill/no-fill/partial, timeout, posisi terbuka, waktu modal tertahan,
serta selisih terhadap kontrol pada cohort market yang sama termasuk SKIP.
Jumlah aksi valid, arah prediksi, alasan SKIP model, dan hasil admission/eksekusi
ditampilkan terpisah; prediksi arah Up/Down tidak selalu menghasilkan BUY.
Biaya kuota langganan 9router dan komputasi lokal yang belum dinilai tidak dianggap
nol. Confidence model bukan probabilitas menang yang terkalibrasi. Drawdown riset
$10 memakai equity hasil settlement; ini bukan drawdown valuasi inventory yang
belum selesai. Stop bertahan setelah restart, dan inventory tetap diselesaikan.

Bekukan kode, model, prompt, input, pilihan arm, dan parameter selama periode.
Perubahan membutuhkan `--out` baru; hasil, ledger, dan stop lama tetap terpisah.
Gunakan salinan runtime tetap agar perubahan checkout tidak mengubah identitas
eksperimen saat restart.
Pada runtime versi ini, saat mengganti periode router, kirim `SIGUSR1` ke prosesnya untuk
membekukan entry dan membatalkan order paper yang belum matched. Inference yang
sudah berjalan tetap dicatat; fill yang sudah matched/filled tetap diselesaikan
dengan payout resmi. Tunggu inventory kosong dan seluruh request selesai sebelum
mengarsipkan manifest, ledger, dan laporan periode itu. `entryCutoffAt` membatasi
durasi bukti, sementara settlement setelah cutoff tetap dihitung.
Catat arsip dalam `history.json` direktori baru dengan `id`, `dataDir` absolut,
dan `archivedAt` milik periode lama. `report --history` membaca kebijakan setiap
manifest secara terpisah; hasil historis tidak digabung dengan profil baru.
Eksperimen momentum lama pada open minus 240 detik dapat tetap berjalan sebagai
referensi pada runtime dan ledger tersendiri; jangan reset hasil atau modalnya.
Tinjau operasional setelah settlement pertama dan hasil sementara setelah 24 jam.
Sampel pendek atau model yang lebih besar belum membuktikan strategi menguntungkan.
Interval 95% memakai bootstrap blok hari WIB pada cohort yang sudah selesai,
termasuk SKIP/no-fill. Interval belum tersedia sebelum dua hari teramati; bukti
tetap ditandai kurang sebelum tujuh hari dan 100 market terisi per arm. Lolos
ambang laporan tidak mengaktifkan live secara otomatis.

## Paper candle berikutnya: konfirmasi reversal

Profil `next-reversal-30x5m-v1` menargetkan candle lima menit yang langsung
mengikuti candle sinyal. Input tetap 30 candle Binance BTCUSDT lima menit selesai
(150 menit). Bila candle sinyal selesai pada waktu `T`, keputusan dijadwalkan
pada `T+5 detik` untuk market Polymarket `[T, T+5 menit]`. Contohnya, candle sinyal
17.10-17.15 WIB menghasilkan keputusan sekitar 17.15.05 untuk market
17.15-17.20 WIB. Entry terjadi pada awal market yang sudah berjalan; profil
sembilan menit sebelum pembukaan tetap tersedia sebagai `early-reversal-30x5m-v1`.

Aturan tetap: minimal tiga candle searah, kemudian candle pertama berlawanan,
memprediksi kelanjutan arah candle berlawanan itu. Tiga atau lebih candle naik
lalu satu turun menawarkan `BUY_DOWN`; pola cermin menawarkan `BUY_UP`.
Doji memutus streak. Tanpa pola valid, seluruh arm memilih `SKIP`.

Tiga arm memakai 30 OHLC dan snapshot yang sama. `premarket-momentum` menjadi
kontrol aturan. Laya dan GPT melalui 9router menjadi **filter konfirmasi**:
masing-masing boleh menerima BUY pada sisi aturan atau memilih `SKIP`.
Pilihan sisi berlawanan tidak diterima sebagai entry. Adanya pola tidak memaksa
AI membeli; AI tetap mempertimbangkan harga, biaya, dan bukti yang tersedia.

Budget AI bersama tetap 30 detik. Setelah cutoff, readiness sementara dapat
dicoba lagi sampai 30 detik, dengan batas akhir entry `T+90 detik`. Keputusan dan
limit dari snapshot dibekukan. Setelah admission bersama, mesin menunggu minimal
250 ms lalu membaca pasangan book REST baru untuk satu simulasi FAK bersama.
Validasi metadata/tick/fee, bukti REST tanpa cache, depth, freshness, dan modal
tetap berlaku; partial fill tidak mengejar sisa. Tiga arm mendapat book/waktu
eksekusi yang sama dengan likuiditas virtual dihitung independen.

```bash
# Terminal/service kolektor, memakai cache yang sama dengan paper.
node scripts/market-history.js run --cache "$PWD/data/market-history/btcusdt-5m.json"

# Terminal/service paper; direktori ini harus merupakan periode baru.
export PREMARKET_PROFILE=next-reversal-30x5m-v1
export PREMARKET_ACTIVE_ARMS=premarket-momentum,laya-premarket,router-premarket
export PREMARKET_CANDLE_CACHE="$PWD/data/market-history/btcusdt-5m.json"
node scripts/premarket-paper.js preflight --out="$PWD/data/premarket-paper/next-reversal-001" --smoke
node scripts/premarket-paper.js run --out="$PWD/data/premarket-paper/next-reversal-001"
node scripts/premarket-paper.js report --out="$PWD/data/premarket-paper/next-reversal-001" --history
```

Setiap arm mulai dengan $20 virtual, target lima shares, cap $5 per entry,
maksimal satu market aktif, dan stop drawdown riset $10. Jalankan profil ini
sebagai proses paper tersendiri dengan konektivitas IPv4. Laya/tokenizer dan
9router harus siap; collector melakukan backfill tanpa warmup langsung 150 menit.

Uji retrospektif 60 hari Binance dengan ambang tetap minimal tiga candle memberi
akurasi candle berikutnya **341/669 atau 50,97%** pada holdout 20 hari terakhir
(Wilson 95%: 47,19%-54,74%; doji target dihitung terpisah). Baseline arah sekitar
50%. Hasil ini belum membuktikan keunggulan yang konsisten atau keuntungan setelah
biaya. Harga Binance dan hasil candle spot bukan harga maupun settlement
Polymarket: target Polymarket memakai Chainlink TWAP 60 detik dan payout resmi.

Pergantian horizon dan peran AI ini wajib memakai periode baru. Selesaikan
inventory/inference periode sebelumnya dan arsipkan manifest, ledger, serta
laporannya, termasuk seluruh kerugian dan stop. Jangan menimpa atau menggabungkan
hasil lama dengan hasil profil baru. Tidak ada transaksi live atau promosi live
otomatis dari hasil penelitian ini.

### Opsi GPT: prediksi arah yang dapat dievaluasi

Pada profil `next-reversal-30x5m-v1`, set
`PREMARKET_ROUTER_POLICY=next-directional-v1` untuk menguji tugas GPT yang
berbeda. Gunakan direktori output baru. Tanpa variabel ini, prompt lama berlaku.

GPT membuat prediksi `UP` atau `DOWN` dari 30 candle yang sama, dengan kekuatan
kualitatif `weak`, `moderate`, atau `strong` dan alasan singkat. Target tetap
market langsung berikutnya. TWAP penutupan belum diketahui karena itulah yang
diprediksi; ketiadaannya di input tidak dengan sendirinya membatalkan history.
Instruksi menjelaskan rekonstruksi delta OHLC, body/wick candle pembalikan,
konteks tren, volatilitas, dan book. Prediksi boleh berlawanan dengan aturan.

Jika prediksi sesuai sisi sinyal yang diizinkan, GPT mengembalikan BUY sisi itu;
jika berlawanan atau tidak ada sisi yang diizinkan, action harus `SKIP`.
Parser menolak ketidaksesuaian, tanpa mengubah SKIP atau respons invalid menjadi
BUY. Data invalid, respons terlambat, serta batas eksekusi tetap dapat mencegah
entry. Kekuatan prediksi bukan probabilitas menang; persetujuan arah ini tidak
membuktikan expected value positif pada harga kontrak yang tersedia.

Kontrol dan prompt Laya tidak berubah. Data snapshot dan peluang eksekusi tetap
sama, tetapi prompt/tugas GPT berbeda dan identitasnya dicatat terpisah.
Laporan memisahkan akurasi prediksi, termasuk SKIP, dari akurasi BUY dan PnL
trade terisi. Snapshot tanpa panggilan GPT tidak dianggap prediksi. Uji ulang
snapshot historis hanya memeriksa perilaku, bukan hasil forward atau bukti
keuntungan. Arsip lama tidak digabung dengan periode prompt baru.

## Early paper historis: 30 candle lima menit

Profil `early-reversal-30x5m-v1` memakai 30 candle BTCUSDT lima menit yang sudah
selesai (150 menit), dari Binance spot. Snapshot dijadwalkan sembilan menit sebelum
market Polymarket mulai: misalnya 17.16 WIB untuk market 17.25-17.30 WIB, dengan
toleransi capture maksimal 10 detik untuk validasi data. Candle
yang masih berjalan tidak menjadi candle terakhir. Prediksi menargetkan market
tersebut, bukan candle Binance berikutnya; hasil tetap mengikuti payout CTF resmi.
History tetap dibatasi pada candle yang sudah selesai dan teramati saat waktu
keputusan terjadwal; toleransi capture tidak menambahkan candle setelah waktu itu.

Kolektor terpisah mengisi history melalui REST saat startup, menyimpannya secara
atomik, lalu memperbaruinya dengan WebSocket. Gap diperbaiki melalui REST tanpa
menghapus history yang valid. Koneksi yang gagal mendapat timeout, backoff, dan
reconnect. Cache basi atau belum lengkap membuat slot dilewati, lalu slot berikutnya
mencoba lagi; tidak perlu warmup 150 menit setelah restart. Cache harus terverifikasi
dalam 90 detik.

Kebijakan book `early-paper-rest-current-depth-v1` memverifikasi dua full order book
melalui REST tanpa cache, disertai endpoint tick independen dan metadata market
terbaru. Timestamp exchange asli tetap disimpan, meskipun sudah lama pada market
masa depan yang sepi; waktu penerimaan/verifikasi REST dicatat terpisah. Bukti
mencakup identitas token/condition, minimum order, fee, tick/grid harga, status market
menerima order, kedalaman, HTTP Date/Age/cache, serta durasi request. Receipt dan
metadata berlaku maksimal lima detik, setiap request maksimal tiga detik dan tetap
dibatasi deadline slot. Response terlambat, cache lama, identitas berubah, atau
kedalaman malformed ditolak. Jalur early ini memakai snapshot REST terverifikasi
tanpa mewajibkan quote WebSocket baru untuk setiap market yang sepi.

Proses early paper memakai urutan DNS IPv4 terlebih dahulu dan menonaktifkan
perlombaan koneksi IPv4/IPv6 Node yang dapat memutus percobaan IPv4 terlalu cepat
pada host tanpa IPv6. Host harus memiliki konektivitas IPv4. Pengaturan ini berlaku
di proses early paper; jalankan profil tersebut sebagai proses/service tersendiri.
Verifikasi clock memiliki jalur baca sendiri. Gagal refresh karena transport hanya
boleh memakai sampel clock sebelumnya sampai usia aslinya 30 detik, tanpa
memperpanjang timestamp sampel.

```bash
# Terminal/service kolektor; tidak membutuhkan wallet atau API key.
node scripts/market-history.js run --cache "$PWD/data/market-history/btcusdt-5m.json"

# Terminal/service paper, memakai cache yang sama dan periode baru.
export PREMARKET_PROFILE=early-reversal-30x5m-v1
export PREMARKET_CANDLE_CACHE="$PWD/data/market-history/btcusdt-5m.json"
node scripts/premarket-paper.js preflight --out="$PWD/data/premarket-paper/early-rest-001" --smoke
node scripts/premarket-paper.js run --out="$PWD/data/premarket-paper/early-rest-001"
node scripts/premarket-paper.js report --out="$PWD/data/premarket-paper/early-rest-001" --history
```

Tiga arm menerima 30 OHLC yang sama: aturan streak-reversal, Laya, dan 9router.
Baseline aturan membaca minimal tiga candle searah lalu tepat satu candle berlawanan,
dan memilih arah terakhir; doji memutus rangkaian. Ini hipotesis awal yang belum
terbukti. Kedua AI menilai keseluruhan history dan boleh memilih arah lain atau SKIP.
Semua memakai input/hash yang sama, tanpa pemotongan candle, serta cutoff keputusan
30 detik bersama sejak snapshot. Laya tetap harus lolos tokenizer aktual 1.024 token.

Setelah cutoff AI, readiness sebelum admission dapat dicoba lagi selama maksimal
30 detik, dengan jeda dasar satu detik dan mengikuti `Retry-After` bila lebih lama.
Retry hanya untuk kegagalan sementara seperti transport, rate limit, atau clock;
perubahan identitas/constraint tetap menggagalkan entry. Deadline juga dibatasi
sebelum market membuka. Keputusan AI dan limit harga dari snapshot tetap dibekukan:
retry readiness tidak memanggil AI lagi atau mengubah harga limit.

Setiap arm yang diterima memakai waktu admission bersama. Setelah minimal 250 ms,
mesin mengambil book REST baru untuk satu simulasi FAK dengan limit awal. Semua
arm pada snapshot itu memakai pasangan book dan waktu eksekusi yang sama, dengan
likuiditas virtual dihitung independen. Kegagalan baca akhir menghasilkan skip;
partial fill/no-fill tidak diulang dan sisa order tidak dikejar. Laporan menyimpan
bukti request setelah latency, hash book bersama, dan seluruh percobaan readiness.

Masing-masing memiliki $20 virtual, target lima shares, maksimum $5 per entry,
satu market aktif, partial fill tanpa mengejar sisa, dan batas drawdown riset $10.
Dengan entry awal, modal dapat tertahan lebih lama dan slot lain bisa dilewati
karena market masih aktif. Tidak ada transaksi live atau promosi otomatis.
Gunakan `deploy/polymarket-market-history.service` untuk kolektor dan salinan
`deploy/polymarket-premarket-paper.service` dengan environment/path profil baru
untuk prediktor. Keduanya bisa restart terpisah; pertahankan cache dan ledger.

Perubahan transport, toleransi capture, dan kontrak eksekusi ini memerlukan `--out`
periode baru. Selesaikan inventory/inference periode lama dan arsipkan manifest,
ledger, serta laporannya sebelum pindah. Arsip early lama tetap dilaporkan menurut
kebijakan aslinya, terpisah dari periode REST baru; hasilnya tidak digabung sebagai
satu eksperimen. Parameter strategi, input 30 candle, dan budget AI 30 detik tetap
tercatat di manifest setiap periode.

## Collector nilai/harga BTC 5 menit

`scripts/value-collector.js` mengumpulkan data untuk riset probabilitas settlement
dan biaya entry. Collector memakai API baca yang sama dengan paper, tanpa
simulasi posisi, inference, order, redeem, atau penarikan. Autentikasi signer
dipakai untuk akses feed Chainlink melalui Polybolt. Strategi live tetap
berbasis aturan; menjalankan collector tidak mengganti strategi live.

```bash
node scripts/value-collector.js preflight --out="$PWD/data/value-collector/period-001"
node scripts/value-collector.js run --out="$PWD/data/value-collector/period-001"
node scripts/value-collector.js report --out="$PWD/data/value-collector/period-001"
```

Node.js 24 dan konfigurasi feed/RPC dari environment proses atau `.env` diperlukan.
Template service terpisah tersedia di `deploy/polymarket-value-collector.service`.
Sesuaikan path Node, runtime, environment privat, serta output sebelum memasangnya.
Collector ini tidak membaca konfigurasi live secara otomatis. Estimasi gas memakai
`RESTART_PAPER_GAS_USD` yang sudah ada; template rahasia tambahan tidak diperlukan.

Setiap market dijadwalkan pada sisa 270, 240, 210, 180, 150, 120, 90, 75, 60, 50,
40, 30, 20, 15, 10, dan 5 detik. Toleransi mulai dua detik dan budget capture tiga
detik; waktu snapshot sebenarnya tetap dicatat, bukan diganti waktu jadwal.
Tidak ada filter favorit, arah, rentang harga, posisi aktif, atau batas risiko
paper lama yang menentukan pencatatan. Kedua sisi selalu dinilai. Slot terlewat,
market tidak tersedia, warming, clock gagal, dan data tidak valid tetap tercatat
sebagai `missed` atau `partial`.

Snapshot menyimpan sumber dan waktu penerimaan harga spot, TWAP 60 detik,
opening boundary, full depth UP/DOWN, serta bukti verifikasi REST. Data yang belum
diterima pada snapshot tidak masuk fitur. Integral closing memakai satu cutoff:
timestamp spot kausal terakhir. Pengujian rolling TWAP memakai timestamp TWAP-nya
sendiri dan ditandai terpisah. Opening yang tidak teramati tepat waktu tidak
direkonstruksi menggunakan settlement masa depan. Warmup memerlukan history
180 detik dan opening boundary baru, sehingga snapshot awal dapat `partial`.

Quote untuk 5, 10, dan 20 shares menghitung biaya berdasarkan ask depth yang
terlihat, fee taker, dan asumsi gas. Depth tidak cukup menghasilkan biaya penuh
`null`; quote bukan jaminan fill. Spread, harga mahal, dan sisi tanpa asks tetap
berguna sebagai data. Nilai gas adalah asumsi, bukan biaya on-chain yang diukur.

Timestamp exchange dapat berarti perubahan book terakhir, berbeda dari waktu
verifikasi REST saat ini. Collector menyimpan usia tersebut secara eksplisit,
termasuk book yang belum berubah dalam lima detik. Receipt, HTTP cache, metadata,
identitas, serta tick tetap diverifikasi; timestamp masa depan ditolak. Kebijakan
pengumpulan ini tidak mengubah guard eksekusi live.

Output privat berisi manifest policy/source, checkpoint kecil `state.json`,
observasi immutable per slot dalam `observations/`, serta label terpisah dalam
`labels/`. Label berasal dari payout CTF resmi pada block terkonfirmasi, termasuk
hasil split; belum resolved tetap pending dan dicoba ulang. Tidak ada label
prediksi dari arah spot atau TWAP. Hash fitur mengikat isi snapshot. Restart
merekonstruksi coverage dari file durable, menolak perubahan manifest dan konflik
isi; perubahan policy/source memerlukan periode baru. Jangan gabungkan periode
yang berbeda sebagai satu eksperimen atau masukkan file output ke Git.

Storage dibatasi 4 GiB untuk record immutable dan menyisakan minimal 2 GiB ruang
filesystem. Saat batas tercapai, collector berhenti dengan exit 78; service tidak
mengulang startup otomatis untuk kode ini. Data tidak dihapus. Periksa kapasitas
dan arsipkan ke penyimpanan lain sebelum memulai periode baru.

Data ini adalah discovery, belum bukti peningkatan win rate. Mulai evaluasi
coverage setelah sedikitnya tujuh hari penuh dan 1.000 market berlabel; durasi
itu juga bukan bukti strategi untung. Laporkan missingness menurut slot, sisi,
harga, dan waktu. Semua slot dari satu market harus berada dalam partisi yang
sama; pemisahan training/calibration/evaluation harus kronologis. Setelah model
dan kriteria entry dibekukan, kumpulkan periode masa depan yang belum dipakai
untuk fitting atau memilih threshold. Bandingkan kalibrasi, Brier score, biaya
eksekusi, coverage, dan drawdown, bukan win rate saja. Tidak ada training atau
promosi ke live otomatis.

### Paper perbandingan waktu eksekusi dua versi

Jalankan dengan Node 24: `node scripts/paired-version-paper/runner.mjs check /path/config.json`
untuk memverifikasi pin, `run` untuk paper, dan `report` untuk hasil terkini. Konfigurasi privat berisi
`output` (direktori khusus paper), `startAt` (epoch ms), `ledger` (sumber hanya-baca), `collector`
(direktori pengamat nilai BTC), dua berkas kalibrasi `persistCalibration` / `submitCalibration`, dan
`arms.old` / `arms.new` dengan `root` dan `manifestPath` absolut. `protocol` membekukan schema 1,
sourceHash runner (ekspor `sourceHash()`), SHA-256 manifest collector dan kalibrasi, collectorId,
periodId, epochId, liveRuntimeId, serta commit, runtimeId dan manifestSha256 kedua arm. Pin sumber dan
pengaturan sebelum mulai; perubahan memerlukan direktori eksperimen baru. Gunakan direktori runtime
terisolasi tanpa file env, kredensial atau signer.

Perbandingan ini berlaku pada snapshot BTC 5 menit yang benar-benar diproduksi sumber bersama.
Kedua provider membaca input dan waktu tahap yang sama. Lama baca wallet, persiapan metadata, dan
penulisan ledger menentukan estimasi waktu periksa dan siap kirim masing-masing versi. Rasio waktu
simpan berasal dari benchmark store lama/baru pada state identik sebelum periode. Waktu signing dan
jarak pemeriksaan terakhir ke pencatatan submit memakai median percobaan historis yang sudah selesai
diukur sebelum periode. Tidak ada signing, pengiriman order, atau perkiraan antrean exchange.
Kuantitas yang terlihat pada buku pertama saat atau setelah waktu estimasi dipakai untuk simulasi FAK;
selisih sampel dibatasi 300 ms. Kekurangan data pada salah satu versi mengecualikan slot untuk keduanya.
Slot yang tidak menghasilkan snapshot sumber juga dicatat, bukan dianggap trade atau laba nol.

Cash virtual 20 pUSD per versi; fee sesuai market, asumsi gas 0.05 per fill, dan label payout resmi
dengan identitas token terverifikasi. Stop bersama saat drawdown berdasarkan settlement salah satu
versi mencapai 10 pUSD; posisi yang sudah ada tetap dihitung saat label tersedia. Bacalah jumlah
slot yang dapat dibandingkan, fill, PnL neto, dan drawdown bersama. Tujuh hari bersama dan 100 trade
selesai per versi hanya minimum untuk review; model ini tidak mereproduksi seluruh bot lama, order
yang tak pernah dikirim, kegagalan broker historis, atau keuntungan aktual. Tidak ada promosi live otomatis.
