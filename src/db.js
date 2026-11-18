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
const publik = (u) => u && ({ id: u.id, username: u.username, nama: u.nama, role: u.role, nomor_lain: u.nomor_lain, dibuat: u.dibuat });

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
    }
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

export function setNomorLain(id, nomor) {
  const bersih = String(nomor || '').split(/[,;\n]+/).map((n) => n.replace(/\D/g, '').replace(/^0/, '62')).filter((n) => n.length >= 9).join(',');
  db.prepare('UPDATE users SET nomor_lain = ? WHERE id = ?').run(bersih, id);
  return bersih;
}

/** Menghapus user beserta seluruh datanya. */
export function hapusUser(id) {
  return dalamTransaksi(() => {
    db.prepare('DELETE FROM transaksi WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM hutang WHERE user_id = ?').run(id);
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

export function tambah({ uid, tipe, jumlah, keterangan = '', kategori = 'Lainnya', pengirim = 'web', dibuat, hutang_id = null, hutang_peran = null }) {
  const r = db.prepare(`INSERT INTO transaksi (user_id, tipe, jumlah, keterangan, kategori, pengirim, dibuat, hutang_id, hutang_peran)
    VALUES (?,?,?,?,?,?, COALESCE(?, datetime('now','localtime')), ?, ?)`)
    .run(uid, tipe, jumlah, keterangan, kategori, pengirim, dibuat ?? null, hutang_id, hutang_peran);
  return ambil(Number(r.lastInsertRowid), uid);
}

export const ambil = (id, uid) => db.prepare('SELECT * FROM transaksi WHERE id = ? AND user_id = ?').get(id, uid);

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
    FROM transaksi WHERE user_id = ? AND dibuat >= ? AND dibuat < ? AND hutang_id IS NULL`).get(uid, dari, sampai);
  const perKategori = db.prepare(`
    SELECT kategori, SUM(jumlah) AS total FROM transaksi
    WHERE user_id = ? AND tipe='keluar' AND dibuat >= ? AND dibuat < ? AND hutang_id IS NULL
    GROUP BY kategori ORDER BY total DESC`).all(uid, dari, sampai);
  return { ...r, selisih: r.masuk - r.keluar, perKategori };
}

/**
 * Daftar transaksi beserta saldo berjalan setelah tiap transaksi.
 * Saldo berjalan dihitung dari seluruh riwayat, jadi tetap benar walau difilter per bulan.
 */
export function daftar({ uid, dari, sampai, limit } = {}) {
  let hasil = db.prepare(`
    SELECT *, SUM(CASE WHEN tipe='masuk' THEN jumlah ELSE -jumlah END)
               OVER (ORDER BY dibuat, id) AS saldoSetelah
    FROM transaksi WHERE user_id = ? ORDER BY dibuat DESC, id DESC`).all(uid);
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
export function buatHutang({ uid, jenis, nama, jumlah, keterangan = '', jatuh_tempo = null, pengirim = 'web' }) {
  const p = PERAN[jenis];
  return dalamTransaksi(() => {
    const r = db.prepare('INSERT INTO hutang (user_id, jenis, nama, jumlah, keterangan, jatuh_tempo, pengirim) VALUES (?,?,?,?,?,?,?)')
      .run(uid, jenis, nama, jumlah, keterangan, jatuh_tempo, pengirim);
    const id = Number(r.lastInsertRowid);
    const ket = (jenis === 'hutang' ? `Pinjam dari ${nama}` : `Pinjamkan ke ${nama}`) + (keterangan ? ` (${keterangan})` : '');
    const transaksi = tambah({ uid, tipe: p.pokok, jumlah, keterangan: ket, kategori: p.katPokok, pengirim, hutang_id: id, hutang_peran: 'pokok' });
    return { hutang: ambilHutang(id, uid), transaksi };
  });
}

/**
 * Membayar hutang / menerima pembayaran piutang. Bisa per id, atau per nama (dibagi ke catatan terlama dulu).
 * jumlah = null berarti lunasi semua sisanya.
 */
export function bayarHutang({ uid, jenis, id, nama, jumlah = null, pengirim = 'web' }) {
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
      tambah({ uid, tipe: p.bayar, jumlah: porsi, pengirim, hutang_id: h.id, hutang_peran: 'bayar', kategori: p.katBayar,
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
