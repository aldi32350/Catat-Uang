import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db, prosesPesan, bacaAkun, uid;
before(async () => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'catat-')), 'uji.db');
  db = await import('../src/db.js');
  ({ prosesPesan } = await import('../src/balasan.js'));
  ({ bacaAkun } = await import('../src/parser.js'));
  uid = db.buatUser({ username: 'dompet', nama: 'Dompet', password: 'rahasia1' }).id;
});
const baca = (t, milik = []) => bacaAkun(t, milik, db.AKUN_PRESET, db.ALIAS_BUTUH_PENANDA);

test('user baru langsung punya Tunai sebagai sumber utama', () => {
  const list = db.daftarAkun(uid);
  assert.equal(list.length, 1);
  assert.equal(list[0].nama, 'Tunai');
  assert.equal(list[0].utama, true);
});

test('pembaca sumber dana di kalimat', () => {
  assert.equal(baca('keluar 25rb bakso pakai dana').akun.nama, 'DANA');
  assert.equal(baca('keluar 25rb bakso pakai dana').sisa, 'keluar 25rb bakso');
  assert.equal(baca('masuk 5jt gaji ke bca').akun.nama, 'BCA');
  assert.equal(baca('beli bensin 20rb gopay').akun.nama, 'GoPay');
  assert.equal(baca('keluar 40rb jajan shopee pay').akun.nama, 'ShopeePay');
  assert.equal(baca('nabung 100rb ke dana darurat').akun, null, '"dana darurat" bukan DANA');
  assert.equal(baca('keluar 25rb bakso dana').akun, null, 'kata ambigu perlu penanda');
  assert.equal(baca('keluar 50rb pulsa pakai dana 2 hari lalu').akun.nama, 'DANA');
  assert.equal(baca('masuk 200rb jualan ke kas toko', [{ nama: 'Kas Toko', jenis: 'lainnya' }]).akun.nama, 'Kas Toko');
  assert.equal(baca('keluar 15rb parkir').akun, null);
});

test('WA: transaksi masuk ke sumber yang disebut, preset dibuat otomatis', () => {
  prosesPesan('masuk 5jt gaji ke bca', '62', uid);
  prosesPesan('keluar 25rb bakso pakai dana', '62', uid);
  // tanpa sumber dana & sumbernya >1 → bot bertanya dulu, belum dicatat
  assert.match(prosesPesan('keluar 15rb parkir', '62', uid), /Pakai uang dari mana/);
  assert.equal(db.saldo(uid).saldo, 4975000, 'belum tercatat sebelum dijawab');
  assert.match(prosesPesan('1', '62', uid), /Tercatat[\s\S]*Tunai/); // 1 = Tunai
  const s = Object.fromEntries(db.daftarAkun(uid).map((a) => [a.nama, a.saldo]));
  assert.deepEqual(s, { Tunai: -15000, BCA: 5000000, DANA: -25000 });
  assert.equal(db.saldo(uid).saldo, 4960000);
});

test('pindah saldo tidak mengubah total & tidak masuk laporan', () => {
  const sebelum = db.saldo(uid).saldo;
  assert.match(prosesPesan('pindah 200rb dari bca ke dana', '62', uid), /BCA → 📱 DANA/);
  assert.match(prosesPesan('tarik tunai 100rb bca', '62', uid), /BCA → 💵 Tunai/);
  const s = Object.fromEntries(db.daftarAkun(uid).map((a) => [a.nama, a.saldo]));
  assert.deepEqual(s, { Tunai: 85000, BCA: 4700000, DANA: 175000 });
  assert.equal(db.saldo(uid).saldo, sebelum);
  const r = db.ringkasan('2000-01-01 00:00:00', '2100-01-01 00:00:00', uid);
  assert.equal(r.masuk, 5000000);
  assert.equal(r.keluar, 40000);
});

test('hapus sumber dana memindahkan transaksinya ke sumber utama', () => {
  const dana = db.cariAkunNama('DANA', uid);
  const r = db.hapusAkun(dana.id, uid);
  assert.equal(r.ok, true);
  assert.equal(r.ke, 'Tunai');
  assert.equal(db.cariAkunNama('DANA', uid), undefined);
  assert.equal(db.saldo(uid).saldo, 4960000, 'total tidak berubah');
  const tunai = db.akunUtama(uid);
  assert.equal(db.hapusAkun(tunai.id, uid).ok, true, 'utama boleh dihapus bila ada sumber lain');
  assert.equal(db.akunUtama(uid).nama, 'BCA');
  assert.equal(db.hapusAkun(db.akunUtama(uid).id, uid).ok, false, 'sumber terakhir tidak boleh dihapus');
});

test('tanya sumber dana: jawab nama, batal, dan perintah lain tidak terganggu', () => {
  const u = db.buatUser({ username: 'tanya', nama: 'Tanya', password: 'rahasia1' }).id;
  assert.match(prosesPesan('keluar 10rb parkir', '62', u), /Tercatat/, 'hanya 1 sumber → langsung');
  db.buatAkun({ uid: u, nama: 'BCA', jenis: 'bank' });
  assert.match(prosesPesan('masuk 1jt gaji', '62', u), /masuk ke mana/);
  assert.match(prosesPesan('saldo', '62', u), /Saldo total/, 'perintah lain tetap jalan saat menunggu');
  assert.match(prosesPesan('bca', '62', u), /Tercatat[\s\S]*BCA/);
  assert.match(prosesPesan('hutang 300rb ke budi', '62', u), /masuk ke mana/);
  assert.match(prosesPesan('batal', '62', u), /Dibatalkan/);
  assert.equal(db.totalHutang(u).hutang, 0);
  assert.match(prosesPesan('nabung 100rb umroh', '62', u), /dari mana/);
  assert.match(prosesPesan('gopay', '62', u), /Nabung[\s\S]*GoPay/, 'sumber baru lewat nama');
});

test('kalimat alami bayar hutang & piutang', () => {
  const u = db.buatUser({ username: 'alami', nama: 'Alami', password: 'rahasia1' }).id;
  prosesPesan('hutang 500rb ke budi tunai', '62', u);
  prosesPesan('piutang 200rb ke andi tunai', '62', u);
  assert.match(prosesPesan('sudah bayar hutang ke budi 100rb tunai', '62', u), /Sisa hutang ke Budi: \*Rp400\.000/);
  assert.match(prosesPesan('aku udah bayar budi 100rb tunai', '62', u), /Rp300\.000/);
  assert.match(prosesPesan('andi sudah bayar 50rb tunai', '62', u), /Piutang dibayar Andi/);
  assert.match(prosesPesan('andi lunas tunai', '62', u), /LUNAS/);
  assert.match(prosesPesan('hutang budi lunas tunai', '62', u), /LUNAS/);
  assert.equal(prosesPesan('aku bayar', '62', u), null);
});

test('bantuan: menu & topik', () => {
  assert.match(prosesPesan('bantuan', '62', uid), /bantuan \+ nomor/);
  assert.match(prosesPesan('bantuan 3', '62', uid), /Hutang & piutang/);
  assert.match(prosesPesan('bantuan tabungan', '62', uid), /🐷 \*Tabungan\*/);
  assert.match(prosesPesan('menu', '62', uid), /Catat Uang — Bantuan/);
});
