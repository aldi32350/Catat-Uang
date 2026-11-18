import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argDb = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
const DB_PATH = argDb || process.env.DB_PATH || join(ROOT, 'data', 'keuangan.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
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
// Kolom penghubung transaksi ↔ hutang (ditambahkan untuk database lama).
const kolom = db.prepare('PRAGMA table_info(transaksi)').all().map((k) => k.name);
if (!kolom.includes('hutang_id')) db.exec('ALTER TABLE transaksi ADD COLUMN hutang_id INTEGER');
if (!kolom.includes('hutang_peran')) db.exec("ALTER TABLE transaksi ADD COLUMN hutang_peran TEXT"); // 'pokok' | 'bayar'

export function tambah({ tipe, jumlah, keterangan = '', kategori = 'Lainnya', pengirim = 'web', dibuat, hutang_id = null, hutang_peran = null }) {
  const r = db.prepare(`INSERT INTO transaksi (tipe, jumlah, keterangan, kategori, pengirim, dibuat, hutang_id, hutang_peran)
    VALUES (?,?,?,?,?, COALESCE(?, datetime('now','localtime')), ?, ?)`)
    .run(tipe, jumlah, keterangan, kategori, pengirim, dibuat ?? null, hutang_id, hutang_peran);
  return ambil(Number(r.lastInsertRowid));
}

export function ambil(id) {
  return db.prepare('SELECT * FROM transaksi WHERE id = ?').get(id);
}

/** Menghapus transaksi. Jika itu transaksi pokok hutang/piutang, catatan hutangnya ikut terhapus. */
export function hapus(id) {
  const t = ambil(id);
  if (!t) return false;
  if (t.hutang_id && t.hutang_peran === 'pokok') return hapusHutang(t.hutang_id);
  return db.prepare('DELETE FROM transaksi WHERE id = ?').run(id).changes > 0;
}

// ======================= Hutang & piutang =======================

const kunciNama = (n) => n.trim().toLowerCase().replace(/\s+/g, ' ');
const PERAN = {
  hutang:  { pokok: 'masuk',  bayar: 'keluar', katPokok: 'Hutang',  katBayar: 'Bayar Hutang' },
  piutang: { pokok: 'keluar', bayar: 'masuk',  katPokok: 'Piutang', katBayar: 'Terima Piutang' },
};

function dalamTransaksi(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const SQL_HUTANG = `
  SELECT h.*,
    COALESCE((SELECT SUM(t.jumlah) FROM transaksi t WHERE t.hutang_id = h.id AND t.hutang_peran = 'bayar'), 0) AS dibayar,
    (SELECT MAX(t.dibuat) FROM transaksi t WHERE t.hutang_id = h.id AND t.hutang_peran = 'bayar') AS terakhir_bayar
  FROM hutang h`;
const lengkapi = (h) => h && ({ ...h, sisa: h.jumlah - h.dibayar, lunas: h.jumlah - h.dibayar <= 0 });

export function ambilHutang(id) {
  const h = lengkapi(db.prepare(SQL_HUTANG + ' WHERE h.id = ?').get(id));
  if (h) h.riwayat = db.prepare('SELECT * FROM transaksi WHERE hutang_id = ? ORDER BY dibuat, id').all(id);
  return h;
}

/** Semua catatan hutang/piutang (yang belum lunas lebih dulu). */
export function daftarHutang({ jenis, terbuka } = {}) {
  let rows = db.prepare(SQL_HUTANG + ' ORDER BY h.dibuat').all().map(lengkapi);
  if (jenis) rows = rows.filter((h) => h.jenis === jenis);
  if (terbuka) rows = rows.filter((h) => !h.lunas);
  return rows.sort((a, b) => a.lunas - b.lunas);
}

/** Total sisa hutang & piutang yang belum lunas. */
export function totalHutang() {
  const r = { hutang: 0, piutang: 0 };
  for (const h of daftarHutang({ terbuka: true })) r[h.jenis] += h.sisa;
  return r;
}

/** Sisa per orang (gabungan beberapa catatan dengan nama sama). */
export function hutangPerOrang(jenis) {
  const map = new Map();
  for (const h of daftarHutang({ jenis, terbuka: true })) {
    const k = kunciNama(h.nama);
    const o = map.get(k) || { nama: h.nama, sisa: 0, jatuh_tempo: null, jumlahCatatan: 0 };
    o.sisa += h.sisa; o.jumlahCatatan++;
    if (h.jatuh_tempo && (!o.jatuh_tempo || h.jatuh_tempo < o.jatuh_tempo)) o.jatuh_tempo = h.jatuh_tempo;
    map.set(k, o);
  }
  return [...map.values()].sort((a, b) => b.sisa - a.sisa);
}

/**
 * Mencatat hutang/piutang baru. Saldo ikut berubah: hutang → uang masuk, piutang → uang keluar.
 * @returns {{hutang:object, transaksi:object}}
 */
export function buatHutang({ jenis, nama, jumlah, keterangan = '', jatuh_tempo = null, pengirim = 'web' }) {
  const p = PERAN[jenis];
  return dalamTransaksi(() => {
    const r = db.prepare('INSERT INTO hutang (jenis, nama, jumlah, keterangan, jatuh_tempo, pengirim) VALUES (?,?,?,?,?,?)')
      .run(jenis, nama, jumlah, keterangan, jatuh_tempo, pengirim);
    const id = Number(r.lastInsertRowid);
    const ket = (jenis === 'hutang' ? `Pinjam dari ${nama}` : `Pinjamkan ke ${nama}`) + (keterangan ? ` (${keterangan})` : '');
    const transaksi = tambah({ tipe: p.pokok, jumlah, keterangan: ket, kategori: p.katPokok, pengirim, hutang_id: id, hutang_peran: 'pokok' });
    return { hutang: ambilHutang(id), transaksi };
  });
}

/**
 * Membayar hutang / menerima pembayaran piutang. Bisa per id, atau per nama (dibagi ke catatan terlama dulu).
 * jumlah = null berarti lunasi semua sisanya.
 * @returns {{ok:true, dibayar:number, kelebihan:number, sisa:number, nama:string, lunas:boolean} | {ok:false, alasan:string}}
 */
export function bayarHutang({ jenis, id, nama, jumlah = null, pengirim = 'web' }) {
  let target = id ? [ambilHutang(id)].filter(Boolean) : daftarHutang({ jenis, terbuka: true })
    .filter((h) => kunciNama(h.nama) === kunciNama(nama || ''));
  if (id && target[0]) jenis = target[0].jenis;
  target = target.filter((h) => !h.lunas);
  if (!target.length) {
    return { ok: false, alasan: jenis === 'piutang' ? `Tidak ada piutang ${nama ?? ''} yang belum lunas.` : `Tidak ada hutang ke ${nama ?? ''} yang belum lunas.` };
  }
  const p = PERAN[jenis];
  const totalSisa = target.reduce((s, h) => s + h.sisa, 0);
  let bayar = jumlah == null ? totalSisa : Math.min(jumlah, totalSisa);
  const kelebihan = jumlah == null ? 0 : Math.max(0, jumlah - totalSisa);
  const namaTampil = target[0].nama;

  dalamTransaksi(() => {
    let sisaBayar = bayar;
    for (const h of target) {
      if (sisaBayar <= 0) break;
      const porsi = Math.min(h.sisa, sisaBayar);
      sisaBayar -= porsi;
      tambah({ tipe: p.bayar, jumlah: porsi, pengirim, hutang_id: h.id, hutang_peran: 'bayar', kategori: p.katBayar,
        keterangan: jenis === 'hutang' ? `Bayar hutang ke ${h.nama}` : `Piutang dibayar ${h.nama}` });
    }
  });
  const sisa = totalSisa - bayar;
  return { ok: true, dibayar: bayar, kelebihan, sisa, nama: namaTampil, lunas: sisa <= 0 };
}

/** Menghapus catatan hutang/piutang beserta semua transaksinya (saldo kembali seperti sebelumnya). */
export function hapusHutang(id) {
  return dalamTransaksi(() => {
    db.prepare('DELETE FROM transaksi WHERE hutang_id = ?').run(id);
    return db.prepare('DELETE FROM hutang WHERE id = ?').run(id).changes > 0;
  });
}

/** Transaksi terakhir yang dicatat oleh pengirim tertentu (untuk perintah "hapus"). */
export function terakhirDari(pengirim) {
  return db.prepare('SELECT * FROM transaksi WHERE pengirim = ? ORDER BY id DESC LIMIT 1').get(pengirim);
}

/** Saldo terakhir = total masuk - total keluar sepanjang waktu. */
export function saldo() {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipe='masuk'  THEN jumlah END),0) AS masuk,
           COALESCE(SUM(CASE WHEN tipe='keluar' THEN jumlah END),0) AS keluar
    FROM transaksi`).get();
  return { masuk: r.masuk, keluar: r.keluar, saldo: r.masuk - r.keluar };
}

/**
 * Ringkasan dalam rentang [dari, sampai) — format 'YYYY-MM-DD HH:MM:SS'.
 * Pinjaman & pembayaran hutang/piutang tidak dihitung sebagai pemasukan/pengeluaran.
 */
export function ringkasan(dari, sampai) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipe='masuk'  THEN jumlah END),0) AS masuk,
           COALESCE(SUM(CASE WHEN tipe='keluar' THEN jumlah END),0) AS keluar,
           COUNT(*) AS jumlahTransaksi
    FROM transaksi WHERE dibuat >= ? AND dibuat < ? AND hutang_id IS NULL`).get(dari, sampai);
  const perKategori = db.prepare(`
    SELECT kategori, SUM(jumlah) AS total FROM transaksi
    WHERE tipe='keluar' AND dibuat >= ? AND dibuat < ? AND hutang_id IS NULL
    GROUP BY kategori ORDER BY total DESC`).all(dari, sampai);
  return { ...r, selisih: r.masuk - r.keluar, perKategori };
}

/**
 * Daftar transaksi beserta saldo berjalan setelah tiap transaksi.
 * Saldo berjalan dihitung dari seluruh riwayat, jadi tetap benar walau difilter per bulan.
 */
export function daftar({ dari, sampai, limit } = {}) {
  const rows = db.prepare(`
    SELECT *, SUM(CASE WHEN tipe='masuk' THEN jumlah ELSE -jumlah END)
               OVER (ORDER BY dibuat, id) AS saldoSetelah
    FROM transaksi ORDER BY dibuat DESC, id DESC`).all();
  let hasil = rows;
  if (dari) hasil = hasil.filter((t) => t.dibuat >= dari);
  if (sampai) hasil = hasil.filter((t) => t.dibuat < sampai);
  if (limit) hasil = hasil.slice(0, limit);
  return hasil;
}
