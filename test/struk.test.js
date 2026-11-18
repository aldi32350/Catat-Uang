import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let balasStruk, prosesPesan, db;
before(async () => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'catat-')), 'uji.db'); // jangan sentuh data asli
  ({ balasStruk, prosesPesan } = await import('../src/balasan.js'));
  db = await import('../src/db.js');
});

const struk = (data) => ({ ok: true, data: {
  adalah_struk: true, tipe: 'keluar', total: 87500, toko: 'Toko Maju', tanggal: '',
  ringkasan: 'belanja bulanan', kategori: 'Belanja', yakin: true, ...data } });

test('struk dibaca lalu disimpan setelah "ya"', () => {
  const b = balasStruk(struk(), 'A');
  assert.match(b, /Rp87\.500/);
  assert.match(b, /Balas \*ya\*/);
  assert.equal(db.saldo().keluar, 0); // belum tersimpan sebelum konfirmasi
  assert.match(prosesPesan('ya', 'A'), /Tercatat/);
  assert.equal(db.saldo().keluar, 87500);
  assert.equal(prosesPesan('ya', 'A'), null); // draf sudah habis
});

test('"batal" tidak menyimpan, angka koreksi menyimpan dengan angka baru', () => {
  const awal = db.saldo().keluar;
  balasStruk(struk(), 'B');
  assert.match(prosesPesan('batal', 'B'), /tidak dicatat/);
  assert.equal(db.saldo().keluar, awal);

  balasStruk(struk(), 'B');
  assert.match(prosesPesan('85rb', 'B'), /Rp85\.000/);
  assert.equal(db.saldo().keluar, awal + 85000);
});

test('caption jadi keterangan, struk lain orang tidak tercampur', () => {
  balasStruk(struk({ total: 20000 }), 'C', 'oleh-oleh');
  assert.equal(prosesPesan('ya', 'D'), null); // D tidak punya draf
  assert.match(prosesPesan('ya', 'C'), /oleh-oleh/);
});

test('bukan struk / total kosong / error AI', () => {
  assert.match(balasStruk(struk({ adalah_struk: false }), 'E'), /bukan struk/);
  assert.match(balasStruk(struk({ total: 0 }), 'E'), /tidak terbaca/);
  assert.match(balasStruk({ ok: false, alasan: 'Kunci API Anthropic tidak valid.' }, 'E'), /tidak valid/);
  assert.equal(prosesPesan('ya', 'E'), null);
});

test('tanggal struk lama dipakai sebagai tanggal transaksi', () => {
  const d = new Date(Date.now() - 3 * 864e5);
  const tgl = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  balasStruk(struk({ tanggal: tgl, total: 1000 }), 'F');
  prosesPesan('ya', 'F');
  assert.equal(db.daftar({ limit: 50 }).find((t) => t.jumlah === 1000).dibuat, `${tgl} 12:00:00`);
});
