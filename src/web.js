// Dashboard web sederhana (tanpa framework).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { tebakKategori } from './parser.js';

const HTML = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');

function json(res, kode, data) {
  res.writeHead(kode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function bacaBody(req) {
  return new Promise((ok, gagal) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { gagal(e); } });
  });
}

/** "2026-11" → ['2026-11-01 00:00:00', '2026-12-01 00:00:00'] */
function rentangBulan(bulan) {
  if (!/^\d{4}-\d{2}$/.test(bulan || '')) return [undefined, undefined];
  const [y, m] = bulan.split('-').map(Number);
  const akhir = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${bulan}-01 00:00:00`, `${akhir}-01 00:00:00`];
}

export function mulaiWeb({ port, host, status }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(HTML));
      }
      if (req.method === 'GET' && url.pathname === '/logo.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
        return res.end(readFileSync(join(dirname(HTML), 'logo.svg')));
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return json(res, 200, status || { terhubung: false, nonaktif: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/ringkasan') {
        const [dari, sampai] = rentangBulan(url.searchParams.get('bulan'));
        return json(res, 200, {
          total: db.saldo(),
          periode: dari ? db.ringkasan(dari, sampai) : null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/transaksi') {
        const [dari, sampai] = rentangBulan(url.searchParams.get('bulan'));
        return json(res, 200, db.daftar({ dari, sampai }));
      }
      if (req.method === 'POST' && url.pathname === '/api/transaksi') {
        const b = await bacaBody(req);
        const jumlah = Math.round(Number(b.jumlah));
        if (!['masuk', 'keluar'].includes(b.tipe) || !(jumlah > 0)) {
          return json(res, 400, { error: 'Tipe atau jumlah tidak valid' });
        }
        const keterangan = String(b.keterangan || '').trim().slice(0, 200)
          || (b.tipe === 'masuk' ? 'Pemasukan' : 'Pengeluaran');
        return json(res, 201, db.tambah({
          tipe: b.tipe, jumlah, keterangan,
          kategori: tebakKategori(keterangan, b.tipe), pengirim: 'web',
        }));
      }
      // ---------- Hutang & piutang ----------
      if (req.method === 'GET' && url.pathname === '/api/hutang') {
        return json(res, 200, { total: db.totalHutang(), daftar: db.daftarHutang() });
      }
      if (req.method === 'POST' && url.pathname === '/api/hutang') {
        const b = await bacaBody(req);
        const jumlah = Math.round(Number(b.jumlah));
        const nama = String(b.nama || '').trim().slice(0, 60);
        const tempo = /^\d{4}-\d{2}-\d{2}$/.test(b.jatuh_tempo || '') ? b.jatuh_tempo : null;
        if (!['hutang', 'piutang'].includes(b.jenis) || !nama || !(jumlah > 0)) {
          return json(res, 400, { error: 'Jenis, nama, atau jumlah tidak valid' });
        }
        return json(res, 201, db.buatHutang({ jenis: b.jenis, nama, jumlah,
          keterangan: String(b.keterangan || '').trim().slice(0, 200), jatuh_tempo: tempo, pengirim: 'web' }));
      }
      const mHutang = url.pathname.match(/^\/api\/hutang\/(\d+)(\/bayar)?$/);
      if (mHutang) {
        const id = Number(mHutang[1]);
        if (req.method === 'GET' && !mHutang[2]) {
          const h = db.ambilHutang(id);
          return h ? json(res, 200, h) : json(res, 404, { error: 'Tidak ditemukan' });
        }
        if (req.method === 'POST' && mHutang[2]) {
          const b = await bacaBody(req);
          const jumlah = b.jumlah == null ? null : Math.round(Number(b.jumlah));
          if (jumlah !== null && !(jumlah > 0)) return json(res, 400, { error: 'Jumlah tidak valid' });
          const r = db.bayarHutang({ id, jumlah, pengirim: 'web' });
          return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.alasan });
        }
        if (req.method === 'DELETE' && !mHutang[2]) {
          return json(res, db.hapusHutang(id) ? 200 : 404, {});
        }
      }
      const mHapus = url.pathname.match(/^\/api\/transaksi\/(\d+)$/);
      if (req.method === 'DELETE' && mHapus) {
        return json(res, db.hapus(Number(mHapus[1])) ? 200 : 404, {});
      }
      if (req.method === 'GET' && url.pathname === '/api/ekspor.csv') {
        const [dari, sampai] = rentangBulan(url.searchParams.get('bulan'));
        const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
        const baris = db.daftar({ dari, sampai }).reverse().map((t) =>
          [t.dibuat, t.tipe, t.tipe === 'masuk' ? t.jumlah : '', t.tipe === 'keluar' ? t.jumlah : '',
            t.keterangan, t.kategori, t.saldoSetelah].map(esc).join(';'));
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="keuangan-${url.searchParams.get('bulan') || 'semua'}.csv"`,
        });
        return res.end('﻿' + ['Tanggal;Tipe;Masuk;Keluar;Keterangan;Kategori;Saldo', ...baris].join('\r\n'));
      }
      json(res, 404, { error: 'Tidak ditemukan' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  server.listen(port, host, () => console.log(`🌐 Dashboard: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
  return server;
}
