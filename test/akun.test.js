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


test('tabungan: setor, tarik, target, tidak masuk laporan, terpisah per user', () => {
  const u = db.buatUser({ username: 'tabung', nama: 'Tabung', password: 'rahasia3' }).id;
  db.tambah({ uid: u, tipe: 'masuk', jumlah: 1000000, keterangan: 'gaji' });
  const b = db.buatTabungan({ uid: u, nama: 'Umroh', target: 500000 });
  assert.equal(db.setorTabungan({ uid: u, id: b.id, jumlah: 300000 }).tabungan.persen, 60);
  assert.equal(db.saldo(u).saldo, 700000, 'saldo dompet berkurang');
  assert.equal(db.tarikTabungan({ uid: u, id: b.id, jumlah: 999999 }).ok, false, 'tidak bisa tarik melebihi isi');
  assert.equal(db.tarikTabungan({ uid: u, id: b.id, jumlah: 100000 }).tabungan.terkumpul, 200000);
  assert.equal(db.totalTabungan(u), 200000);
  const r = db.ringkasan('2000-01-01 00:00:00', '2100-01-01 00:00:00', u);
  assert.equal(r.keluar, 0, 'nabung bukan pengeluaran');
  assert.equal(r.masuk, 1000000, 'tarik tabungan bukan pemasukan');
  assert.throws(() => db.buatTabungan({ uid: u, nama: 'umroh' }), /sudah ada/);
  const lain = db.cekLogin('aldi', 'baru123').id;
  assert.equal(db.ambilTabungan(b.id, lain), undefined, 'user lain tidak bisa melihat');
  db.hapusTabungan(b.id, u);
  assert.equal(db.saldo(u).saldo, 1000000, 'hapus tabungan: isi kembali ke saldo');
});

test('perangkat WA milik user, ikut terhapus bersama user', () => {
  const u = db.buatUser({ username: 'wauser', nama: 'WA', password: 'rahasia4' }).id;
  const p1 = db.buatPerangkat(u); db.buatPerangkat(u);
  db.setNomorPerangkat(p1.id, '6281111');
  assert.equal(db.daftarPerangkat(u).length, 2);
  assert.equal(db.ambilPerangkat(p1.id).nomor, '6281111');
  db.hapusUser(u);
  assert.equal(db.daftarPerangkat(u).length, 0);
});
