<img src="public/logo.svg" width="72" alt="Logo Catat Uang">

# Catat Uang — Catat Keuangan via WhatsApp

Catat uang **masuk** dan **keluar** cukup dengan chat WhatsApp. Bot langsung membalas dengan **saldo terakhir**. Ada juga dashboard web untuk melihat riwayat dan mengunduh Excel.

## Cara menjalankan

1. Butuh **Node.js 22.5 atau lebih baru**.
2. Di folder ini, jalankan:
   ```bash
   npm install
   npm start
   ```
3. Buka **http://localhost:3000**. Scan kode QR yang muncul (atau yang tampil di terminal) dari HP:
   WhatsApp → **Perangkat tertaut** → **Tautkan perangkat**.
4. Setelah terhubung, buka chat **dirimu sendiri** ("Message yourself") di WhatsApp lalu ketik `bantuan`.

Sesi login disimpan di `data/sesi-wa`, jadi scan cukup sekali. Data transaksi ada di `data/keuangan.db`.

## Contoh chat

| Kamu ketik | Hasil |
|---|---|
| `masuk 5jt gaji` | Uang masuk Rp5.000.000 |
| `+150rb jual kue` | Uang masuk Rp150.000 |
| `keluar 25rb makan siang` | Uang keluar Rp25.000 |
| `beli bensin 20000` | Uang keluar Rp20.000 |
| `-1,5jt bayar kos` | Uang keluar Rp1.500.000 |
| `saldo` | Saldo terakhir + total masuk/keluar |
| `laporan` / `hari ini` / `minggu ini` / `bulan lalu` | Rekap per periode + per kategori |
| `riwayat` | 10 transaksi terakhir |
| `hapus` | Membatalkan catatan terakhirmu |

Penulisan angka yang dikenali: `25rb`, `25k`, `25.000`, `1,5jt`, `Rp 1.250.000`. Kategori (Makan, Transportasi, Tagihan, dll.) dipilih otomatis dari keterangannya.

## Foto struk (dibaca AI)

Kirim foto struk, nota, atau bukti transfer ke chat dirimu sendiri. AI (Claude) membaca total, nama toko, tanggal, dan kategorinya, lalu bot meminta konfirmasi:

> 🧾 Struk terbaca — 🔴 Uang KELUAR: **Rp87.500** · 🏪 Toko Maju · 🏷️ Belanja
> Balas **ya** untuk simpan, **batal** untuk membatalkan, atau ketik jumlah yang benar (mis. **87500**).

- Caption pada foto dipakai sebagai keterangan (mis. "belanja bulanan").
- Jika caption sudah berupa catatan lengkap (mis. `keluar 50rb makan`), foto tidak dikirim ke AI.
- Draf menunggu konfirmasi selama 15 menit.

**Cara mengaktifkan:**
1. Buat kunci API di https://console.anthropic.com/settings/keys (akun perlu diisi saldo; tiap foto memakai sedikit biaya API).
2. Salin `.env.example` menjadi `.env`, lalu isi `ANTHROPIC_API_KEY=...`.
3. Jalankan ulang `npm start`.

File `.env` tidak ikut ke git. Model default `claude-opus-5-5` (ubah dengan `CLAUDE_MODEL`). Jika model menolak memproses gambar, API otomatis mencoba model cadangan (fitur *server-side fallback*).

## Pengaturan (opsional)

Taruh di file `.env` (lihat `.env.example`) atau sebagai variabel lingkungan.

| Variabel | Fungsi |
|---|---|
| `ANTHROPIC_API_KEY=...` | Mengaktifkan fitur baca foto struk |
| `NOMOR_DIIZINKAN=6281234567890,6285...` | Nomor lain (mis. pasangan) yang boleh mencatat dengan chat ke nomor bot |
| `PORT=3000` | Port dashboard |
| `HOST=0.0.0.0` | Agar dashboard bisa dibuka dari HP di Wi-Fi yang sama (default hanya dari komputer ini) |

Mode hanya dashboard tanpa WhatsApp: `npm run web`. Untuk menjalankan tes: `npm test`.

## Penting

- Koneksi WhatsApp memakai **Baileys** (cara tidak resmi, seperti WhatsApp Web). Gratis, tapi ada risiko kecil nomor diblokir WhatsApp. Lebih aman pakai **nomor cadangan** sebagai nomor bot.
- Bot hanya membalas chat ke diri sendiri dan nomor di `NOMOR_DIIZINKAN`. Chat lain dan grup diabaikan.
- Dashboard tidak memakai password. Jangan buka ke internet tanpa menambahkan login.
