import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uraiPesan, bacaJumlah } from '../src/parser.js';

test('membaca format jumlah', () => {
  assert.equal(bacaJumlah('25rb').nilai, 25000);
  assert.equal(bacaJumlah('25k').nilai, 25000);
  assert.equal(bacaJumlah('25.000').nilai, 25000);
  assert.equal(bacaJumlah('1,5jt').nilai, 1500000);
  assert.equal(bacaJumlah('1.5 juta').nilai, 1500000);
  assert.equal(bacaJumlah('Rp 1.250.000').nilai, 1250000);
  assert.equal(bacaJumlah('2.500rb').nilai, 2500000);
});

test('transaksi masuk & keluar', () => {
  assert.deepEqual(uraiPesan('masuk 5jt gaji'),
    { jenis: 'transaksi', tipe: 'masuk', jumlah: 5000000, keterangan: 'gaji', kategori: 'Gaji', tanggal: null });
  const k = uraiPesan('keluar 25rb makan siang');
  assert.equal(k.tipe, 'keluar'); assert.equal(k.jumlah, 25000);
  assert.equal(k.keterangan, 'makan siang'); assert.equal(k.kategori, 'Makan & Minum');
  const b = uraiPesan('beli bensin 20000');
  assert.equal(b.tipe, 'keluar'); assert.equal(b.keterangan, 'beli bensin'); assert.equal(b.kategori, 'Transportasi');
  assert.equal(uraiPesan('+150rb jual kue').kategori, 'Usaha');
  assert.equal(uraiPesan('-1,5jt bayar kos').jumlah, 1500000);
  assert.equal(uraiPesan('keluar 30 kopi').jumlah, 30); // "k" pada "kopi" bukan satuan ribu
});

test('perintah', () => {
  assert.equal(uraiPesan('Saldo').nama, 'saldo');
  assert.deepEqual(uraiPesan('laporan'), { jenis: 'perintah', nama: 'laporan', periode: 'bulan ini' });
  assert.equal(uraiPesan('hari ini').periode, 'hari ini');
  assert.equal(uraiPesan('laporan minggu ini').periode, 'minggu ini');
  assert.equal(uraiPesan('hapus').nama, 'hapus');
});

test('chat biasa diabaikan', () => {
  assert.equal(uraiPesan('halo apa kabar'), null);
  assert.equal(uraiPesan('keluar sebentar ya'), null);
  assert.equal(uraiPesan(''), null);
});

test('tanggal mundur di pesan WA', async () => {
  const { uraiPesan } = await import('../src/parser.js');
  const now = new Date(2026, 10, 18, 19, 0); // Rabu, 18 Nov 2026
  const t = (p) => uraiPesan(p, now);
  assert.equal(t('keluar 25rb bakso').tanggal, null);
  assert.equal(t('keluar 25rb bakso kemarin').tanggal, '2026-11-17');
  assert.equal(t('keluar 25rb bakso kemarin').keterangan, 'bakso');
  assert.equal(t('keluar 20rb parkir kemarin lusa').tanggal, '2026-11-16');
  assert.equal(t('keluar 30rb makan 3 hari lalu').tanggal, '2026-11-15');
  assert.equal(t('beli bensin 20000 senin').tanggal, '2026-11-16');
  assert.equal(t('keluar tgl 15/11 50rb bensin').jumlah, 50000, 'tanggal tidak terbaca sebagai jumlah');
  assert.equal(t('keluar tgl 15/11 50rb bensin').tanggal, '2026-11-15');
  assert.equal(t('keluar 100rb arisan tanggal 25').tanggal, '2026-10-25', 'tgl 25 sudah lewat bulan lalu');
  assert.equal(t('keluar 75rb pulsa 10 nov').tanggal, '2026-11-10');
  assert.equal(t('keluar 200rb kado 2/10/2025').tanggal, '2025-10-02');
  assert.equal(t('keluar 50rb uang jajan minggu ini').tanggal, null);
  assert.equal(t('keluar 50rb uang jajan minggu ini').keterangan, 'uang jajan minggu ini');
  assert.equal(t('keluar 25rb makan tadi siang').tanggal, null);
});
