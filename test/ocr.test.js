import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uraiTeksStruk, nominalDiBaris } from '../src/ocr.js';

const SEKARANG = new Date(2026, 10, 18);

test('nominal rupiah di satu baris', () => {
  assert.deepEqual(nominalDiBaris('TOTAL Rp 87.500'), [87500]);
  assert.deepEqual(nominalDiBaris('Total 87,500.00'), [87500]);
  assert.deepEqual(nominalDiBaris('GRAND TOTAL 1.250.000,00'), [1250000]);
  assert.deepEqual(nominalDiBaris('TOTAL 87.5O0'), [87500], 'huruf O dibaca 0');
  assert.deepEqual(nominalDiBaris('1 x 125.000'), [125000], 'jumlah barang tidak tergabung');
});

test('struk minimarket: ambil TOTAL, bukan TUNAI/KEMBALI', () => {
  const s = uraiTeksStruk(`INDOMARET
JL. MERDEKA NO 10
18.11.2026 14:22
INDOMIE GORENG    3    9.300
AQUA 600ML        2    7.000
SUB TOTAL             16.300
DISKON                 1.000
TOTAL                 15.300
TUNAI                 20.000
KEMBALI                4.700`, SEKARANG);
  assert.equal(s.total, 15300);
  assert.equal(s.toko, 'Indomaret');
  assert.equal(s.tanggal, '2026-11-18');
  assert.equal(s.kategori, 'Belanja');
  assert.equal(s.tipe, 'keluar');
  assert.equal(s.adalah_struk, true);
  assert.equal(s.yakin, true);
});

test('grand total lebih diutamakan dari total', () => {
  const s = uraiTeksStruk(`WARUNG MAKAN SEDERHANA
Nasi Rames 2 50.000
Es Teh 2 10.000
Total 60.000
PPN 10% 6.000
Grand Total 66.000
Cash 100.000
Change 34.000`, SEKARANG);
  assert.equal(s.total, 66000);
  assert.equal(s.kategori, 'Makan & Minum');
});

test('angka total di baris berikutnya', () => {
  const s = uraiTeksStruk(`APOTEK SEHAT
TOTAL BAYAR
Rp 45.000`, SEKARANG);
  assert.equal(s.total, 45000);
  assert.equal(s.kategori, 'Kesehatan');
});

test('bukti transfer masuk', () => {
  const s = uraiTeksStruk(`Transfer Berhasil
Dana masuk dari BUDI SANTOSO
Nominal Rp 750.000
17 Nov 2026 09:10`, SEKARANG);
  assert.equal(s.tipe, 'masuk');
  assert.equal(s.total, 750000);
  assert.equal(s.tanggal, '2026-11-17');
});

test('foto bukan struk', () => {
  const s = uraiTeksStruk('Selamat ulang tahun\nsemoga panjang umur', SEKARANG);
  assert.equal(s.adalah_struk, false);
  assert.equal(s.total, 0);
});
