import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argDb = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
const DB_PATH = argDb || process.env.DB_PATH || join(ROOT, 'data', 'keuangan.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    nama       TEXT    NOT NULL,
    hash       TEXT    NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    nomor_lain TEXT    NOT NULL DEFAULT '',
    dibuat     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS sesi (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    kadaluarsa INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transaksi (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tipe       TEXT    NOT NULL CHECK (tipe IN ('masuk','keluar')),
    jumlah     INTEGER NOT NULL CHECK (jumlah > 0),
    keterangan TEXT    NOT NULL DEFAULT '',
    kategori   TEXT    NOT NULL DEFAULT 'Lainnya',
    pengirim   TEXT    NOT NULL DEFAULT 'web',
    dibuat     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_transaksi_dibuat ON transaksi(dibuat);
  -- hutang = saya meminjam dari orang lain; piutang = orang lain meminjam dari saya
  CREATE TABLE IF NOT EXISTS hutang (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    jenis       TEXT    NOT NULL CHECK (jenis IN ('hutang','piutang')),
    nama        TEXT    NOT NULL,
    jumlah      INTEGER NOT NULL CHECK (jumlah > 0),
    keterangan  TEXT    NOT NULL DEFAULT '',
    jatuh_tempo TEXT,
    pengirim    TEXT    NOT NULL DEFAULT 'web',
    dibuat      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);
// Kolom tambahan untuk database lama.
function tambahKolom(tabel, nama, tipe) {
  const ada = db.prepare(`PRAGMA table_info(${tabel})`).all().some((k) => k.name === nama);
  if (!ada) db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${nama} ${tipe}`);
}
tambahKolom('transaksi', 'hutang_id', 'INTEGER');
tambahKolom('transaksi', 'hutang_peran', 'TEXT'); // 'pokok' | 'bayar'
tambahKolom('transaksi', 'user_id', 'INTEGER');
tambahKolom('hutang', 'user_id', 'INTEGER');
tambahKolom('transaksi', 'tabungan_id', 'INTEGER');
tambahKolom('transaksi', 'akun_id', 'INTEGER');
tambahKolom('transaksi', 'transfer', 'INTEGER');
tambahKolom('users', 'akun_default', 'INTEGER');
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_perangkat (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    nomor   TEXT,
    dibuat  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  -- Sumber dana: tunai, rekening bank, e-wallet, atau nama bebas
  CREATE TABLE IF NOT EXISTS akun (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    nama    TEXT    NOT NULL,
    jenis   TEXT    NOT NULL DEFAULT 'lainnya' CHECK (jenis IN ('tunai','bank','ewallet','lainnya')),
    dibuat  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS tabungan (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    nama    TEXT    NOT NULL,
    target  INTEGER,
    tenggat TEXT,
    ikon    TEXT    NOT NULL DEFAULT '🐷',
    dibuat  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_transaksi_user ON transaksi(user_id, dibuat)');

function dalamTransaksi(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ============================ User & login ============================

function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
function cocokPassword(pw, simpanan) {
  const [salt, hash] = simpanan.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
const publik = (u) => u && ({ id: u.id, username: u.username, nama: u.nama, role: u.role, dibuat: u.dibuat });

export const jumlahUser = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const ambilUser = (id) => publik(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
export const daftarUser = () => db.prepare('SELECT * FROM users ORDER BY id').all().map(publik);

export function validasiUser({ username, nama, password }) {
  if (!/^[a-z0-9._-]{3,30}$/i.test(username || '')) return 'Username 3–30 karakter: huruf, angka, titik, - atau _';
  if (!String(nama || '').trim()) return 'Nama wajib diisi';
  if (String(password || '').length < 6) return 'Password minimal 6 karakter';
  return null;
}

/** Membuat user. User pertama otomatis admin & mewarisi data lama yang belum punya pemilik. */
export function buatUser({ username, nama, password, role = 'user' }) {
  const err = validasiUser({ username, nama, password });
  if (err) throw new Error(err);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new Error('Username sudah dipakai');
  return dalamTransaksi(() => {
    const pertama = jumlahUser() === 0;
    const r = db.prepare('INSERT INTO users (username, nama, hash, role) VALUES (?,?,?,?)')
      .run(username.trim(), String(nama).trim().slice(0, 60), hashPassword(password), pertama ? 'admin' : role === 'admin' ? 'admin' : 'user');
    const id = Number(r.lastInsertRowid);
    if (pertama) {
      db.prepare('UPDATE transaksi SET user_id = ? WHERE user_id IS NULL').run(id);
      db.prepare('UPDATE hutang SET user_id = ? WHERE user_id IS NULL').run(id);
      migrasiAkun();
    }
    akunUtama(id); // setiap user langsung punya sumber dana "Tunai"
    return ambilUser(id);
  });
}

export function cekLogin(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  return u && cocokPassword(String(password || ''), u.hash) ? publik(u) : null;
}

export function gantiPassword(id, password) {
  if (String(password || '').length < 6) throw new Error('Password minimal 6 karakter');
  db.prepare('UPDATE users SET hash = ? WHERE id = ?').run(hashPassword(password), id);
  db.prepare('DELETE FROM sesi WHERE user_id = ?').run(id); // keluarkan dari semua perangkat
}

/** Menghapus user beserta seluruh datanya. */
export function hapusUser(id) {
  return dalamTransaksi(() => {
    db.prepare('DELETE FROM transaksi WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM hutang WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM tabungan WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM wa_perangkat WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM akun WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM sesi WHERE user_id = ?').run(id);
    return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  });
}

const UMUR_SESI = 30 * 864e5;
export function buatSesi(userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sesi WHERE kadaluarsa < ?').run(Date.now());
  db.prepare('INSERT INTO sesi (token, user_id, kadaluarsa) VALUES (?,?,?)').run(token, userId, Date.now() + UMUR_SESI);
  return token;
}
export function userDariSesi(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sesi WHERE token = ? AND kadaluarsa > ?').get(token, Date.now());
  return s ? ambilUser(s.user_id) : null;
}
export const hapusSesi = (token) => db.prepare('DELETE FROM sesi WHERE token = ?').run(token);

// ============================ Transaksi (per user) ============================

export function tambah({ uid, tipe, jumlah, keterangan = '', kategori = 'Lainnya', pengirim = 'web', dibuat, hutang_id = null, hutang_peran = null, tabungan_id = null, akun_id = null, transfer = false }) {
  // Sumber dana wajib: bila tidak disebut, pakai sumber utama milik user
  const akun = (akun_id && ambilAkun(akun_id, uid)) || akunUtama(uid);
  const r = db.prepare(`INSERT INTO transaksi (user_id, tipe, jumlah, keterangan, kategori, pengirim, dibuat, hutang_id, hutang_peran, tabungan_id, akun_id, transfer)
    VALUES (?,?,?,?,?,?, COALESCE(?, datetime('now','localtime')), ?, ?, ?, ?, ?)`)
    .run(uid, tipe, jumlah, keterangan, kategori, pengirim, dibuat ?? null, hutang_id, hutang_peran, tabungan_id, akun?.id ?? null, transfer ? 1 : null);
  return ambil(Number(r.lastInsertRowid), uid);
}

export const ambil = (id, uid) => db.prepare(`SELECT t.*, a.nama AS akun_nama, a.jenis AS akun_jenis FROM transaksi t
  LEFT JOIN akun a ON a.id = t.akun_id WHERE t.id = ? AND t.user_id = ?`).get(id, uid);

/** Menghapus transaksi. Jika itu transaksi pokok hutang/piutang, catatan hutangnya ikut terhapus. */
export function hapus(id, uid) {
  const t = ambil(id, uid);
  if (!t) return false;
  if (t.hutang_id && t.hutang_peran === 'pokok') return hapusHutang(t.hutang_id, uid);
  return db.prepare('DELETE FROM transaksi WHERE id = ? AND user_id = ?').run(id, uid).changes > 0;
}

/** Transaksi terakhir yang dicatat oleh pengirim tertentu (untuk perintah "hapus"). */
export const terakhirDari = (pengirim, uid) =>
  db.prepare('SELECT * FROM transaksi WHERE pengirim = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(pengirim, uid);

/** Saldo terakhir = total masuk - total keluar sepanjang waktu. */
export function saldo(uid) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipe='masuk'  THEN jumlah END),0) AS masuk,
           COALESCE(SUM(CASE WHEN tipe='keluar' THEN jumlah END),0) AS keluar
    FROM transaksi WHERE user_id = ?`).get(uid);
  return { masuk: r.masuk, keluar: r.keluar, saldo: r.masuk - r.keluar };
}

/**
 * Ringkasan dalam rentang [dari, sampai) — format 'YYYY-MM-DD HH:MM:SS'.
 * Pinjaman & pembayaran hutang/piutang tidak dihitung sebagai pemasukan/pengeluaran.
 */
export function ringkasan(dari, sampai, uid) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipe='masuk'  THEN jumlah END),0) AS masuk,
           COALESCE(SUM(CASE WHEN tipe='keluar' THEN jumlah END),0) AS keluar,
           COUNT(*) AS jumlahTransaksi
    FROM transaksi WHERE user_id = ? AND dibuat >= ? AND dibuat < ? AND hutang_id IS NULL AND tabungan_id IS NULL AND transfer IS NULL`).get(uid, dari, sampai);
  const perKategori = db.prepare(`
    SELECT kategori, SUM(jumlah) AS total FROM transaksi
    WHERE user_id = ? AND tipe='keluar' AND dibuat >= ? AND dibuat < ? AND hutang_id IS NULL AND tabungan_id IS NULL AND transfer IS NULL
    GROUP BY kategori ORDER BY total DESC`).all(uid, dari, sampai);
  return { ...r, selisih: r.masuk - r.keluar, perKategori };
}

/**
 * Daftar transaksi beserta saldo berjalan setelah tiap transaksi.
 * Saldo berjalan dihitung dari seluruh riwayat, jadi tetap benar walau difilter per bulan.
 */
export function daftar({ uid, dari, sampai, limit, akun_id } = {}) {
  let hasil = db.prepare(`
    SELECT t.*, a.nama AS akun_nama, a.jenis AS akun_jenis,
           SUM(CASE WHEN t.tipe='masuk' THEN t.jumlah ELSE -t.jumlah END) OVER (ORDER BY t.dibuat, t.id) AS saldoSetelah
    FROM transaksi t LEFT JOIN akun a ON a.id = t.akun_id
    WHERE t.user_id = ? ORDER BY t.dibuat DESC, t.id DESC`).all(uid);
  if (akun_id) hasil = hasil.filter((t) => t.akun_id === akun_id);
  if (dari) hasil = hasil.filter((t) => t.dibuat >= dari);
  if (sampai) hasil = hasil.filter((t) => t.dibuat < sampai);
  if (limit) hasil = hasil.slice(0, limit);
  return hasil;
}

// ============================ Hutang & piutang (per user) ============================

const kunciNama = (n) => n.trim().toLowerCase().replace(/\s+/g, ' ');
const PERAN = {
  hutang:  { pokok: 'masuk',  bayar: 'keluar', katPokok: 'Hutang',  katBayar: 'Bayar Hutang' },
  piutang: { pokok: 'keluar', bayar: 'masuk',  katPokok: 'Piutang', katBayar: 'Terima Piutang' },
};

const SQL_HUTANG = `
  SELECT h.*,
    COALESCE((SELECT SUM(t.jumlah) FROM transaksi t WHERE t.hutang_id = h.id AND t.hutang_peran = 'bayar'), 0) AS dibayar
  FROM hutang h`;
const lengkapi = (h) => h && ({ ...h, sisa: h.jumlah - h.dibayar, lunas: h.jumlah - h.dibayar <= 0 });

export function ambilHutang(id, uid) {
  const h = lengkapi(db.prepare(SQL_HUTANG + ' WHERE h.id = ? AND h.user_id = ?').get(id, uid));
  if (h) h.riwayat = db.prepare('SELECT * FROM transaksi WHERE hutang_id = ? ORDER BY dibuat, id').all(id);
  return h;
}

/** Semua catatan hutang/piutang milik user (yang belum lunas lebih dulu). */
export function daftarHutang({ uid, jenis, terbuka } = {}) {
  let rows = db.prepare(SQL_HUTANG + ' WHERE h.user_id = ? ORDER BY h.dibuat').all(uid).map(lengkapi);
  if (jenis) rows = rows.filter((h) => h.jenis === jenis);
  if (terbuka) rows = rows.filter((h) => !h.lunas);
  return rows.sort((a, b) => a.lunas - b.lunas);
}

/** Total sisa hutang & piutang yang belum lunas. */
export function totalHutang(uid) {
  const r = { hutang: 0, piutang: 0 };
  for (const h of daftarHutang({ uid, terbuka: true })) r[h.jenis] += h.sisa;
  return r;
}

/** Sisa per orang (gabungan beberapa catatan dengan nama sama). */
export function hutangPerOrang(jenis, uid) {
  const map = new Map();
  for (const h of daftarHutang({ uid, jenis, terbuka: true })) {
    const k = kunciNama(h.nama);
    const o = map.get(k) || { nama: h.nama, sisa: 0, jatuh_tempo: null, jumlahCatatan: 0 };
    o.sisa += h.sisa; o.jumlahCatatan++;
    if (h.jatuh_tempo && (!o.jatuh_tempo || h.jatuh_tempo < o.jatuh_tempo)) o.jatuh_tempo = h.jatuh_tempo;
    map.set(k, o);
  }
  return [...map.values()].sort((a, b) => b.sisa - a.sisa);
}

/** Mencatat hutang/piutang baru. Saldo ikut berubah: hutang → uang masuk, piutang → uang keluar. */
export function buatHutang({ uid, jenis, nama, jumlah, keterangan = '', jatuh_tempo = null, pengirim = 'web', akun_id = null }) {
  const p = PERAN[jenis];
  return dalamTransaksi(() => {
    const r = db.prepare('INSERT INTO hutang (user_id, jenis, nama, jumlah, keterangan, jatuh_tempo, pengirim) VALUES (?,?,?,?,?,?,?)')
      .run(uid, jenis, nama, jumlah, keterangan, jatuh_tempo, pengirim);
    const id = Number(r.lastInsertRowid);
    const ket = (jenis === 'hutang' ? `Pinjam dari ${nama}` : `Pinjamkan ke ${nama}`) + (keterangan ? ` (${keterangan})` : '');
    const transaksi = tambah({ uid, tipe: p.pokok, jumlah, keterangan: ket, kategori: p.katPokok, pengirim, hutang_id: id, hutang_peran: 'pokok', akun_id });
    return { hutang: ambilHutang(id, uid), transaksi };
  });
}

/**
 * Membayar hutang / menerima pembayaran piutang. Bisa per id, atau per nama (dibagi ke catatan terlama dulu).
 * jumlah = null berarti lunasi semua sisanya.
 */
export function bayarHutang({ uid, jenis, id, nama, jumlah = null, pengirim = 'web', akun_id = null }) {
  let target = id ? [ambilHutang(id, uid)].filter(Boolean) : daftarHutang({ uid, jenis, terbuka: true })
    .filter((h) => kunciNama(h.nama) === kunciNama(nama || ''));
  if (id && target[0]) jenis = target[0].jenis;
  target = target.filter((h) => !h.lunas);
  if (!target.length) {
    return { ok: false, alasan: jenis === 'piutang' ? `Tidak ada piutang ${nama ?? ''} yang belum lunas.` : `Tidak ada hutang ke ${nama ?? ''} yang belum lunas.` };
  }
  const p = PERAN[jenis];
  const totalSisa = target.reduce((s, h) => s + h.sisa, 0);
  const bayar = jumlah == null ? totalSisa : Math.min(jumlah, totalSisa);
  const kelebihan = jumlah == null ? 0 : Math.max(0, jumlah - totalSisa);
  const namaTampil = target[0].nama;

  dalamTransaksi(() => {
    let sisaBayar = bayar;
    for (const h of target) {
      if (sisaBayar <= 0) break;
      const porsi = Math.min(h.sisa, sisaBayar);
      sisaBayar -= porsi;
      tambah({ uid, tipe: p.bayar, jumlah: porsi, pengirim, akun_id, hutang_id: h.id, hutang_peran: 'bayar', kategori: p.katBayar,
        keterangan: jenis === 'hutang' ? `Bayar hutang ke ${h.nama}` : `Piutang dibayar ${h.nama}` });
    }
  });
  const sisa = totalSisa - bayar;
  return { ok: true, dibayar: bayar, kelebihan, sisa, nama: namaTampil, lunas: sisa <= 0 };
}

/** Menghapus catatan hutang/piutang beserta semua transaksinya (saldo kembali seperti sebelumnya). */
export function hapusHutang(id, uid) {
  return dalamTransaksi(() => {
    if (!db.prepare('SELECT 1 FROM hutang WHERE id = ? AND user_id = ?').get(id, uid)) return false;
    db.prepare('DELETE FROM transaksi WHERE hutang_id = ? AND user_id = ?').run(id, uid);
    return db.prepare('DELETE FROM hutang WHERE id = ? AND user_id = ?').run(id, uid).changes > 0;
  });
}

// ============================ Tabungan (per user) ============================
// Setor = uang pindah dari saldo dompet ke tabungan (transaksi "keluar" kategori Tabungan).
// Tarik = uang kembali ke saldo dompet (transaksi "masuk" kategori Tarik Tabungan).
// Keduanya tidak dihitung sebagai pemasukan/pengeluaran di laporan.

const SQL_TABUNGAN = `
  SELECT b.*,
    COALESCE((SELECT SUM(CASE WHEN t.tipe = 'keluar' THEN t.jumlah ELSE -t.jumlah END)
              FROM transaksi t WHERE t.tabungan_id = b.id), 0) AS terkumpul
  FROM tabungan b`;
const lengkapiTab = (b) => b && ({ ...b, persen: b.target ? Math.min(100, Math.round((b.terkumpul / b.target) * 100)) : null,
  tercapai: Boolean(b.target && b.terkumpul >= b.target) });

export function daftarTabungan(uid) {
  return db.prepare(SQL_TABUNGAN + ' WHERE b.user_id = ? ORDER BY b.dibuat').all(uid).map(lengkapiTab);
}
export function ambilTabungan(id, uid) {
  const b = lengkapiTab(db.prepare(SQL_TABUNGAN + ' WHERE b.id = ? AND b.user_id = ?').get(id, uid));
  if (b) b.riwayat = db.prepare('SELECT * FROM transaksi WHERE tabungan_id = ? ORDER BY dibuat DESC, id DESC').all(id);
  return b;
}
export const totalTabungan = (uid) => daftarTabungan(uid).reduce((s, b) => s + b.terkumpul, 0);

export function cariTabungan(nama, uid) {
  const k = kunciNama(nama || '');
  return daftarTabungan(uid).find((b) => kunciNama(b.nama) === k) || null;
}

export function buatTabungan({ uid, nama, target = null, tenggat = null, ikon = '🐷' }) {
  nama = String(nama || '').trim().slice(0, 40);
  if (!nama) throw new Error('Nama tabungan wajib diisi');
  if (cariTabungan(nama, uid)) throw new Error(`Tabungan "${nama}" sudah ada`);
  const r = db.prepare('INSERT INTO tabungan (user_id, nama, target, tenggat, ikon) VALUES (?,?,?,?,?)')
    .run(uid, nama, target > 0 ? Math.round(target) : null, tenggat || null, ikon || '🐷');
  return ambilTabungan(Number(r.lastInsertRowid), uid);
}

export function ubahTabungan(id, uid, { nama, target, tenggat, ikon }) {
  const b = ambilTabungan(id, uid);
  if (!b) return null;
  db.prepare('UPDATE tabungan SET nama = ?, target = ?, tenggat = ?, ikon = ? WHERE id = ? AND user_id = ?').run(
    nama !== undefined ? String(nama).trim().slice(0, 40) || b.nama : b.nama,
    target !== undefined ? (target > 0 ? Math.round(target) : null) : b.target,
    tenggat !== undefined ? tenggat || null : b.tenggat,
    ikon !== undefined ? ikon || '🐷' : b.ikon, id, uid);
  return ambilTabungan(id, uid);
}

/** Setor ke tabungan. Saldo dompet berkurang. */
export function setorTabungan({ uid, id, jumlah, pengirim = 'web', akun_id = null }) {
  const b = ambilTabungan(id, uid);
  if (!b) return { ok: false, alasan: 'Tabungan tidak ditemukan.' };
  if (!(jumlah > 0)) return { ok: false, alasan: 'Jumlah tidak valid.' };
  tambah({ uid, tipe: 'keluar', jumlah, kategori: 'Tabungan', keterangan: `Nabung ke ${b.nama}`, pengirim, tabungan_id: id, akun_id });
  return { ok: true, jumlah, tabungan: ambilTabungan(id, uid) };
}

/** Tarik dari tabungan (jumlah null = semua). Saldo dompet bertambah. */
export function tarikTabungan({ uid, id, jumlah = null, pengirim = 'web', akun_id = null }) {
  const b = ambilTabungan(id, uid);
  if (!b) return { ok: false, alasan: 'Tabungan tidak ditemukan.' };
  if (b.terkumpul <= 0) return { ok: false, alasan: `Tabungan ${b.nama} masih kosong.` };
  const tarik = jumlah == null ? b.terkumpul : jumlah;
  if (!(tarik > 0)) return { ok: false, alasan: 'Jumlah tidak valid.' };
  if (tarik > b.terkumpul) return { ok: false, alasan: `Isi tabungan ${b.nama} hanya Rp${b.terkumpul.toLocaleString('id-ID')}.` };
  tambah({ uid, tipe: 'masuk', jumlah: tarik, kategori: 'Tarik Tabungan', keterangan: `Tarik dari ${b.nama}`, pengirim, tabungan_id: id, akun_id });
  return { ok: true, jumlah: tarik, tabungan: ambilTabungan(id, uid) };
}

/** Hapus tabungan beserta riwayatnya; uang yang terkumpul kembali ke saldo dompet. */
export function hapusTabungan(id, uid) {
  return dalamTransaksi(() => {
    if (!db.prepare('SELECT 1 FROM tabungan WHERE id = ? AND user_id = ?').get(id, uid)) return false;
    db.prepare('DELETE FROM transaksi WHERE tabungan_id = ? AND user_id = ?').run(id, uid);
    return db.prepare('DELETE FROM tabungan WHERE id = ? AND user_id = ?').run(id, uid).changes > 0;
  });
}

// ============================ Perangkat WhatsApp (banyak nomor per user) ============================

export const daftarPerangkat = (uid) => db.prepare('SELECT * FROM wa_perangkat WHERE user_id = ? ORDER BY id').all(uid);
export const semuaPerangkat = () => db.prepare('SELECT * FROM wa_perangkat ORDER BY id').all();
export const ambilPerangkat = (id) => db.prepare('SELECT * FROM wa_perangkat WHERE id = ?').get(id);
export function buatPerangkat(uid) {
  const r = db.prepare('INSERT INTO wa_perangkat (user_id) VALUES (?)').run(uid);
  return ambilPerangkat(Number(r.lastInsertRowid));
}
export const setNomorPerangkat = (id, nomor) => db.prepare('UPDATE wa_perangkat SET nomor = ? WHERE id = ?').run(nomor, id);
export const hapusPerangkat = (id) => db.prepare('DELETE FROM wa_perangkat WHERE id = ?').run(id).changes > 0;

// ============================ Sumber dana (akun) ============================

/** Pilihan siap pakai. alias = kata yang dikenali di chat WA. */
export const AKUN_PRESET = [
  { nama: 'Tunai', jenis: 'tunai', alias: ['tunai', 'cash', 'kas', 'uang tunai', 'dompet'] },
  { nama: 'BCA', jenis: 'bank', alias: ['bca'] },
  { nama: 'BRI', jenis: 'bank', alias: ['bri', 'brimo'] },
  { nama: 'BNI', jenis: 'bank', alias: ['bni'] },
  { nama: 'Mandiri', jenis: 'bank', alias: ['mandiri', 'livin'] },
  { nama: 'BSI', jenis: 'bank', alias: ['bsi'] },
  { nama: 'BTN', jenis: 'bank', alias: ['btn'] },
  { nama: 'CIMB Niaga', jenis: 'bank', alias: ['cimb niaga', 'cimb'] },
  { nama: 'Permata', jenis: 'bank', alias: ['permata'] },
  { nama: 'Jago', jenis: 'bank', alias: ['bank jago', 'jago'] },
  { nama: 'SeaBank', jenis: 'bank', alias: ['seabank', 'sea bank'] },
  { nama: 'blu', jenis: 'bank', alias: ['blu bca', 'blu'] },
  { nama: 'DANA', jenis: 'ewallet', alias: ['dana'] },
  { nama: 'GoPay', jenis: 'ewallet', alias: ['gopay', 'go pay', 'go-pay'] },
  { nama: 'OVO', jenis: 'ewallet', alias: ['ovo'] },
  { nama: 'ShopeePay', jenis: 'ewallet', alias: ['shopeepay', 'shopee pay', 'spay'] },
  { nama: 'LinkAja', jenis: 'ewallet', alias: ['linkaja', 'link aja'] },
];
// Nama yang juga kata sehari-hari: hanya dikenali bila didahului "pakai/via/dari/ke/…"
export const ALIAS_BUTUH_PENANDA = new Set(['dana', 'kas', 'dompet', 'jago', 'blu', 'permata', 'mandiri', 'livin']);
const JENIS_AKUN = ['tunai', 'bank', 'ewallet', 'lainnya'];
const rapikanNama = (n) => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 30);

export const daftarAkunPolos = (uid) => db.prepare('SELECT * FROM akun WHERE user_id = ? ORDER BY id').all(uid);
export const ambilAkun = (id, uid) => db.prepare('SELECT * FROM akun WHERE id = ? AND user_id = ?').get(id, uid);
export const cariAkunNama = (nama, uid) =>
  db.prepare('SELECT * FROM akun WHERE user_id = ? AND lower(nama) = lower(?)').get(uid, rapikanNama(nama));

/** Sumber dana utama user (dibuat "Tunai" otomatis bila belum ada). */
export function akunUtama(uid) {
  if (!uid) return null;
  const u = db.prepare('SELECT akun_default FROM users WHERE id = ?').get(uid);
  let a = u?.akun_default && ambilAkun(u.akun_default, uid);
  if (a) return a;
  // Utama = Tunai (bukan sumber yang kebetulan dibuat lebih dulu, mis. BCA dari "masuk ... ke bca")
  a = daftarAkunPolos(uid).find((x) => x.jenis === 'tunai') || buatAkun({ uid, nama: 'Tunai', jenis: 'tunai' });
  db.prepare('UPDATE users SET akun_default = ? WHERE id = ?').run(a.id, uid);
  return a;
}
export function setAkunUtama(id, uid) {
  if (!ambilAkun(id, uid)) return false;
  db.prepare('UPDATE users SET akun_default = ? WHERE id = ?').run(id, uid);
  return true;
}

export function buatAkun({ uid, nama, jenis = 'lainnya' }) {
  nama = rapikanNama(nama);
  if (!nama) throw new Error('Nama sumber dana wajib diisi');
  if (cariAkunNama(nama, uid)) throw new Error(`"${nama}" sudah ada`);
  const r = db.prepare('INSERT INTO akun (user_id, nama, jenis) VALUES (?,?,?)')
    .run(uid, nama, JENIS_AKUN.includes(jenis) ? jenis : 'lainnya');
  return ambilAkun(Number(r.lastInsertRowid), uid);
}

export function ubahAkun(id, uid, { nama, jenis }) {
  const a = ambilAkun(id, uid);
  if (!a) return null;
  const baru = nama !== undefined ? rapikanNama(nama) : a.nama;
  if (!baru) throw new Error('Nama sumber dana wajib diisi');
  const kembar = cariAkunNama(baru, uid);
  if (kembar && kembar.id !== id) throw new Error(`"${baru}" sudah ada`);
  db.prepare('UPDATE akun SET nama = ?, jenis = ? WHERE id = ? AND user_id = ?')
    .run(baru, JENIS_AKUN.includes(jenis) ? jenis : a.jenis, id, uid);
  return ambilAkun(id, uid);
}

/** Hapus sumber dana; transaksinya dipindah ke sumber utama (atau sumber lain bila ini yang utama). */
export function hapusAkun(id, uid) {
  const a = ambilAkun(id, uid);
  if (!a) return { ok: false, alasan: 'Tidak ditemukan' };
  const lain = daftarAkunPolos(uid).filter((x) => x.id !== id);
  if (!lain.length) return { ok: false, alasan: 'Minimal harus ada satu sumber dana.' };
  return dalamTransaksi(() => {
    let utama = akunUtama(uid);
    if (utama.id === id) { utama = lain[0]; setAkunUtama(utama.id, uid); }
    const pindah = db.prepare('UPDATE transaksi SET akun_id = ? WHERE akun_id = ? AND user_id = ?').run(utama.id, id, uid).changes;
    db.prepare('DELETE FROM akun WHERE id = ? AND user_id = ?').run(id, uid);
    return { ok: true, pindah, ke: utama.nama };
  });
}

/** Semua sumber dana + saldonya masing-masing. */
export function daftarAkun(uid) {
  const utama = akunUtama(uid);
  return db.prepare(`
    SELECT a.*, COALESCE(SUM(CASE WHEN t.tipe = 'masuk' THEN t.jumlah WHEN t.tipe = 'keluar' THEN -t.jumlah END), 0) AS saldo,
           COUNT(t.id) AS jumlahTransaksi
    FROM akun a LEFT JOIN transaksi t ON t.akun_id = a.id
    WHERE a.user_id = ? GROUP BY a.id ORDER BY a.id`).all(uid).map((a) => ({ ...a, utama: a.id === utama.id }));
}

/** Pindah saldo antar sumber dana (mis. tarik tunai, top up e-wallet). Tidak dihitung di laporan. */
export function transferAkun({ uid, dari, ke, jumlah, pengirim = 'web', dibuat }) {
  const a = ambilAkun(dari, uid), b = ambilAkun(ke, uid);
  if (!a || !b || a.id === b.id) return { ok: false, alasan: 'Pilih dua sumber dana yang berbeda.' };
  if (!(jumlah > 0)) return { ok: false, alasan: 'Jumlah tidak valid.' };
  dalamTransaksi(() => {
    tambah({ uid, tipe: 'keluar', jumlah, kategori: 'Transfer', keterangan: `Pindah ke ${b.nama}`, pengirim, akun_id: a.id, transfer: true, dibuat });
    tambah({ uid, tipe: 'masuk', jumlah, kategori: 'Transfer', keterangan: `Pindah dari ${a.nama}`, pengirim, akun_id: b.id, transfer: true, dibuat });
  });
  return { ok: true, dari: a.nama, ke: b.nama, jumlah };
}

/** Sekali saat start: transaksi lama tanpa sumber dana → sumber utama pemiliknya. */
function migrasiAkun() {
  for (const { user_id } of db.prepare('SELECT DISTINCT user_id FROM transaksi WHERE akun_id IS NULL AND user_id IS NOT NULL').all()) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(user_id)) continue;
    const a = akunUtama(user_id);
    db.prepare('UPDATE transaksi SET akun_id = ? WHERE akun_id IS NULL AND user_id = ?').run(a.id, user_id);
  }
}
migrasiAkun();
