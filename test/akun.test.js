import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db, prosesPesan;
before(async () => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'catat-')), 'uji.db');
  db = await import('../src/db.js');
  ({ prosesPesan } = await import('../src/balasan.js'));
});

test('user pertama jadi admin dan mewarisi data lama tanpa pemilik', () => {
  db.tambah({ uid: null, tipe: 'masuk', jumlah: 5000, keterangan: 'data lama' }); // data sebelum ada login
  const admin = db.buatUser({ username: 'Aldi', nama: 'Aldi', password: 'rahasia1', role: 'user' });
  assert.equal(admin.role, 'admin');
  assert.equal(db.saldo(admin.id).saldo, 5000);
});

test('login, sesi, ganti password', () => {
  assert.ok(db.cekLogin('aldi', 'rahasia1'), 'username tidak peka huruf besar');
  assert.equal(db.cekLogin('aldi', 'salah'), null);
  const u = db.cekLogin('aldi', 'rahasia1');
  const token = db.buatSesi(u.id);
  assert.equal(db.userDariSesi(token).username, 'Aldi');
  db.gantiPassword(u.id, 'baru123');
  assert.equal(db.userDariSesi(token), null, 'sesi lama dicabut setelah ganti password');
  assert.ok(db.cekLogin('aldi', 'baru123'));
});

test('validasi pembuatan user', () => {
  assert.throws(() => db.buatUser({ username: 'aldi', nama: 'X', password: 'rahasia1' }), /sudah dipakai/);
  assert.throws(() => db.buatUser({ username: 'a', nama: 'X', password: 'rahasia1' }), /Username/);
  assert.throws(() => db.buatUser({ username: 'budi', nama: 'Budi', password: '123' }), /minimal 6/);
});

test('data antar user terpisah (transaksi, hutang, WA)', () => {
  const a = db.cekLogin('aldi', 'baru123').id;
  const b = db.buatUser({ username: 'siti', nama: 'Siti', password: 'rahasia2' }).id;
  prosesPesan('masuk 1jt gaji', '628111', b);
  prosesPesan('hutang 200rb ke budi', '628111', b);
  assert.equal(db.saldo(b).saldo, 1200000);
  assert.equal(db.saldo(a).saldo, 5000, 'saldo admin tidak berubah');
  assert.equal(db.totalHutang(a).hutang, 0);
  assert.equal(db.totalHutang(b).hutang, 200000);
  assert.match(prosesPesan('bayar hutang budi 50rb', '628111', a), /Tidak ada hutang/);

  // user lain tidak bisa menghapus transaksi milik user lain
  const tSiti = db.daftar({ uid: b })[0];
  assert.equal(db.hapus(tSiti.id, a), false);
  assert.equal(db.daftar({ uid: b }).length, 2);

  // hapus user menghapus semua datanya
  db.hapusUser(b);
  assert.equal(db.daftar({ uid: b }).length, 0);
  assert.equal(db.daftarHutang({ uid: b }).length, 0);
});

test('nomor lain dibersihkan & 08 → 628', () => {
  const a = db.cekLogin('aldi', 'baru123').id;
  assert.equal(db.setNomorLain(a, '0812-3456-7890, +62 811 222 333, abc'), '6281234567890,62811222333');
});
