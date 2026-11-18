// Membaca foto struk secara GRATIS & lokal dengan OCR (Tesseract.js), tanpa kunci API.
// Hasilnya berbentuk sama dengan bacaStruk() versi Claude, supaya alur konfirmasi tetap sama.
import { createWorker } from 'tesseract.js';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tebakKategori } from './parser.js';

const CACHE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tessdata');

let workerJanji = null;
let antrean = Promise.resolve();
function worker() {
  if (!workerJanji) {
    mkdirSync(CACHE, { recursive: true });
    // Data bahasa Indonesia + Inggris diunduh sekali (pertama kali), lalu disimpan di data/tessdata.
    workerJanji = createWorker(['ind', 'eng'], 1, { cachePath: CACHE }).catch((e) => { workerJanji = null; throw e; });
  }
  return workerJanji;
}

// ---------------------------------------------------------------------------
// Pengurai teks struk (murni, tanpa OCR) — bisa diuji langsung.
// ---------------------------------------------------------------------------

// Urutan = prioritas. Kata yang lebih spesifik di atas.
const KUNCI_TOTAL = [
  /grand\s*total/, /total\s*(bayar|pembayaran|belanja|harga|tagihan|transaksi|transfer|akhir)/,
  /jumlah\s*(bayar|transfer|pembayaran|tagihan)/, /\bnominal\b/, /\btotal\b/, /\bjumlah\b/, /\btagihan\b/,
];
// Baris yang BUKAN total akhir.
const BUKAN_TOTAL = /sub\s*-?\s*total|total\s*(item|qty|disc|diskon|hemat|potongan|ppn|pajak|barang|jenis)|\b(tunai|cash|kembali|kembalian|change|uang\s*diterima|dibayar\s*tunai|ppn|dpp|diskon|disc|hemat|potongan|poin|point|saldo)\b/;

const BULAN = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };

/** Memperbaiki salah baca OCR yang umum di dalam angka: O→0, l/I→1, S→5, B→8. */
function rapikanAngka(s) {
  return s.replace(/(?<=[\d.,])[oO]|[oO](?=[\d.,])/g, '0').replace(/(?<=[\d.,])[lI|]|[lI|](?=[\d.,]{2})/g, '1')
    .replace(/(?<=\d)[sS](?=\d)/g, '5').replace(/(?<=\d)B(?=\d)/g, '8');
}

/** Semua nominal rupiah pada satu baris. "87.500", "87,500", "87.500,00", "Rp87500" → 87500 */
export function nominalDiBaris(baris) {
  const hasil = [];
  const re = /(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{3,9})(?:[.,](\d{2}))?(?!\d)/gi;
  for (const m of rapikanAngka(baris).matchAll(re)) {
    const angka = Number(m[1].replace(/[.,]/g, ''));
    if (angka >= 100 && angka < 1e10) hasil.push(angka);
  }
  return hasil;
}

function bacaTanggal(teks, sekarang = new Date()) {
  const t = teks.toLowerCase();
  let d, m, y;
  let r = t.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (r) [, y, m, d] = r.map(Number);
  if (!r && (r = t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) { [, d, m, y] = r.map(Number); }
  if (!r && (r = t.match(/\b(\d{1,2})[\s-]*(jan|feb|mar|apr|mei|may|jun|jul|agu|agt|aug|sep|okt|oct|nov|des|dec)[a-z]*[\s-]*(\d{2,4})\b/))) {
    d = Number(r[1]); m = BULAN[r[2]]; y = Number(r[3]);
  }
  if (!r) return '';
  if (y < 100) y += 2000;
  const tgl = new Date(y, m - 1, d);
  if (tgl.getMonth() !== m - 1 || tgl > sekarang || y < 2000) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function bacaToko(baris) {
  for (const b of baris.slice(0, 6)) {
    const bersih = b.replace(/[^\p{L}\p{N}&.' -]/gu, ' ').replace(/\s+/g, ' ').trim();
    const huruf = (bersih.match(/\p{L}/gu) || []).length;
    if (huruf >= 3 && huruf / bersih.length > 0.6 && !/struk|receipt|nota|invoice|kasir|jl\.?|jalan|telp|npwp/i.test(bersih)) {
      return bersih.slice(0, 40).replace(/\b\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    }
  }
  return '';
}

/** Mengubah teks hasil OCR menjadi data struk. */
export function uraiTeksStruk(teks, sekarang = new Date()) {
  const baris = teks.split(/\r?\n/).map((b) => b.trim()).filter(Boolean);
  const kecil = baris.map((b) => b.toLowerCase());

  // 1) Cari baris total menurut prioritas kata kunci
  let total = 0, yakin = false;
  cari: for (const kunci of KUNCI_TOTAL) {
    for (let i = kecil.length - 1; i >= 0; i--) { // dari bawah: total biasanya di bagian akhir
      if (!kunci.test(kecil[i]) || BUKAN_TOTAL.test(kecil[i])) continue;
      const angka = nominalDiBaris(baris[i]).length ? nominalDiBaris(baris[i]) : nominalDiBaris(baris[i + 1] || '');
      if (angka.length) { total = Math.max(...angka); yakin = true; break cari; }
    }
  }
  // 2) Cadangan: nominal terbesar yang bukan uang tunai/kembalian
  if (!total) {
    const semua = baris.filter((_, i) => !BUKAN_TOTAL.test(kecil[i]) && !/telp|npwp|no\.|nomor|kode|ref/i.test(kecil[i]))
      .flatMap(nominalDiBaris);
    if (semua.length) total = Math.max(...semua);
  }

  const gabung = kecil.join(' ');
  const masuk = /transfer\s*masuk|dana\s*masuk|uang\s*masuk|diterima\s*dari|menerima|terima\s*dana|kredit\s*masuk/.test(gabung);
  const toko = bacaToko(baris);
  const tanggal = bacaTanggal(teks, sekarang);
  const adaTandaStruk = /total|jumlah|bayar|tunai|kembali|nominal|transfer|struk|kasir|qty|harga/.test(gabung);
  const tipe = masuk ? 'masuk' : 'keluar';
  return {
    adalah_struk: total > 0 && (adaTandaStruk || Boolean(tanggal)),
    tipe,
    total,
    toko,
    tanggal,
    ringkasan: toko ? (tipe === 'masuk' ? `transfer dari ${toko}` : `belanja ${toko}`) : (tipe === 'masuk' ? 'transfer masuk' : 'belanja'),
    kategori: tebakKategori(`${toko} ${gabung.slice(0, 400)}`, tipe),
    yakin,
    metode_bayar: bacaMetodeBayar(gabung),
    sumber: 'ocr',
  };
}

/** Cara bayar yang tertulis di struk → nama sumber dana ('' bila tidak ketemu). E-wallet & bank didahulukan dari tunai. */
export function bacaMetodeBayar(teks) {
  const t = ` ${teks.toLowerCase()} `;
  const POLA = [
    [/go\s*-?\s*pay\b/, 'GoPay'], [/\bovo\b/, 'OVO'], [/shopee\s*pay|\bspay\b/, 'ShopeePay'], [/link\s*aja/, 'LinkAja'],
    [/\bdana\b(?!\s*(?:masuk|keluar|darurat|tunai))/, 'DANA'],
    [/\bbca\b/, 'BCA'], [/\bbri\b|brimo/, 'BRI'], [/\bbni\b/, 'BNI'], [/\bmandiri\b|livin/, 'Mandiri'], [/\bbsi\b/, 'BSI'],
    [/\bbtn\b/, 'BTN'], [/\bcimb\b/, 'CIMB Niaga'], [/seabank|sea bank/, 'SeaBank'], [/bank\s*jago/, 'Jago'],
    [/\b(?:tunai|cash)\b/, 'Tunai'],
  ];
  for (const [re, nama] of POLA) if (re.test(t)) return nama;
  return '';
}

/**
 * Membaca foto struk dengan OCR lokal.
 * @returns {Promise<{ok:true, data:object, teks:string} | {ok:false, alasan:string}>}
 */
export function bacaStrukOCR(gambar) {
  // Satu per satu supaya komputer tidak berat bila beberapa foto masuk bersamaan.
  const kerja = antrean.then(async () => {
    try {
      const w = await worker();
      const { data } = await w.recognize(gambar);
      return { ok: true, data: uraiTeksStruk(data.text || ''), teks: data.text || '' };
    } catch (e) {
      const offline = /fetch|network|ENOTFOUND|ECONN/i.test(e.message);
      return { ok: false, alasan: offline
        ? 'OCR belum bisa mengunduh data bahasa (butuh internet sekali saat pertama dipakai).'
        : 'Gagal membaca foto: ' + e.message };
    }
  });
  antrean = kerja.catch(() => {});
  return kerja;
}
