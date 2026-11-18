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
`);

export function tambah({ tipe, jumlah, keterangan = '', kategori = 'Lainnya', pengirim = 'web' }) {
  const r = db
    .prepare('INSERT INTO transaksi (tipe, jumlah, keterangan, kategori, pengirim) VALUES (?,?,?,?,?)')
    .run(tipe, jumlah, keterangan, kategori, pengirim);
  return ambil(Number(r.lastInsertRowid));
}

export function ambil(id) {
  return db.prepare('SELECT * FROM transaksi WHERE id = ?').get(id);
}

export function hapus(id) {
  return db.prepare('DELETE FROM transaksi WHERE id = ?').run(id).changes > 0;
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

/** Ringkasan dalam rentang [dari, sampai) — format 'YYYY-MM-DD HH:MM:SS'. */
export function ringkasan(dari, sampai) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipe='masuk'  THEN jumlah END),0) AS masuk,
           COALESCE(SUM(CASE WHEN tipe='keluar' THEN jumlah END),0) AS keluar,
           COUNT(*) AS jumlahTransaksi
    FROM transaksi WHERE dibuat >= ? AND dibuat < ?`).get(dari, sampai);
  const perKategori = db.prepare(`
    SELECT kategori, SUM(jumlah) AS total FROM transaksi
    WHERE tipe='keluar' AND dibuat >= ? AND dibuat < ?
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
