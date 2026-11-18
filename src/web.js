// Dashboard web (tanpa framework) dengan login, data per user, dan menu admin.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { tebakKategori } from './parser.js';

const HTML = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
const COOKIE = 'catat_sesi';

function json(res, kode, data, header = {}) {
  res.writeHead(kode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...header });
  res.end(JSON.stringify(data));
}

function bacaBody(req) {
  return new Promise((ok, gagal) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { gagal(e); } });
  });
}

const bacaCookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';')
  .map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const setCookie = (token, umurDetik) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${umurDetik}`;
const jeda = (ms) => new Promise((r) => setTimeout(r, ms));

/** "2026-11" → ['2026-11-01 00:00:00', '2026-12-01 00:00:00'] */
function rentangBulan(bulan) {
  if (!/^\d{4}-\d{2}$/.test(bulan || '')) return [undefined, undefined];
  const [y, m] = bulan.split('-').map(Number);
  const akhir = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${bulan}-01 00:00:00`, `${akhir}-01 00:00:00`];
}

/**
 * @param {{port:number, host:string, wa: null | typeof import('./bot.js')}} opsi
 */
export function mulaiWeb({ port, host, wa }) {
  const statusWA = (uid) => (wa ? wa.statusWA(uid) : []);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const M = req.method;
    try {
      // ---------- file statis ----------
      if (M === 'GET' && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(HTML));
      }
      if (M === 'GET' && (p === '/logo.svg' || p === '/wa.svg')) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
        return res.end(readFileSync(join(dirname(HTML), p.slice(1))));
      }
      if (!p.startsWith('/api/')) return json(res, 404, { error: 'Tidak ditemukan' });

      // Perubahan data hanya lewat JSON (melindungi dari form lintas situs).
      if (M !== 'GET' && M !== 'DELETE' && !String(req.headers['content-type'] || '').includes('application/json')) {
        return json(res, 415, { error: 'Harus JSON' });
      }

      // ---------- login ----------
      const token = bacaCookie(req)[COOKIE];
      const user = db.userDariSesi(token);

      if (M === 'GET' && p === '/api/saya') {
        if (!user) return json(res, 401, { error: 'Belum login', perluSetup: db.jumlahUser() === 0 });
        return json(res, 200, { user });
      }
      if (M === 'POST' && p === '/api/setup') {
        if (db.jumlahUser() > 0) return json(res, 403, { error: 'Admin sudah dibuat. Silakan login.' });
        const b = await bacaBody(req);
        const baru = db.buatUser({ username: b.username, nama: b.nama, password: b.password, role: 'admin' });
        if (wa?.pindahkanSesiLama(baru.id)) wa.mulaiSemua();
        return json(res, 201, { user: baru }, { 'Set-Cookie': setCookie(db.buatSesi(baru.id), 30 * 86400) });
      }
      if (M === 'POST' && p === '/api/login') {
        const b = await bacaBody(req);
        const u = db.cekLogin(b.username, b.password);
        if (!u) { await jeda(600); return json(res, 401, { error: 'Username atau password salah' }); }
        return json(res, 200, { user: u }, { 'Set-Cookie': setCookie(db.buatSesi(u.id), 30 * 86400) });
      }
      if (M === 'POST' && p === '/api/logout') {
        if (token) db.hapusSesi(token);
        return json(res, 200, {}, { 'Set-Cookie': setCookie('', 0) });
      }

      // Semua di bawah ini wajib login.
      if (!user) return json(res, 401, { error: 'Belum login' });
      const uid = user.id;

      if (M === 'POST' && p === '/api/ganti-password') {
        const b = await bacaBody(req);
        if (!db.cekLogin(user.username, b.lama)) return json(res, 400, { error: 'Password lama salah' });
        db.gantiPassword(uid, b.baru);
        return json(res, 200, {}, { 'Set-Cookie': setCookie(db.buatSesi(uid), 30 * 86400) });
      }

      // ---------- WhatsApp milik user ini (bisa banyak nomor) ----------
      if (M === 'GET' && p === '/api/wa') return json(res, 200, { aktif: Boolean(wa), perangkat: statusWA(uid) });
      if (p.startsWith('/api/wa/') && !wa) return json(res, 400, { error: 'Server dijalankan tanpa WhatsApp (npm run web).' });
      if (M === 'POST' && p === '/api/wa/tambah') return json(res, 200, await wa.tambahNomor(uid));
      const mWa = p.match(/^\/api\/wa\/(\d+)\/(hubungkan|hapus)$/);
      if (mWa && M === 'POST') {
        const pid = Number(mWa[1]);
        if (db.ambilPerangkat(pid)?.user_id !== uid) return json(res, 404, { error: 'Nomor tidak ditemukan' });
        if (mWa[2] === 'hubungkan') return json(res, 200, await wa.hubungkan(pid));
        await wa.hapusNomor(pid);
        return json(res, 200, {});
      }

      // ---------- Admin ----------
      if (p.startsWith('/api/admin/')) {
        if (user.role !== 'admin') return json(res, 403, { error: 'Khusus admin' });
        if (M === 'GET' && p === '/api/admin/users') {
          return json(res, 200, db.daftarUser().map((u) => ({ ...u, wa: statusWA(u.id), saldo: db.saldo(u.id).saldo })));
        }
        if (M === 'POST' && p === '/api/admin/users') {
          const b = await bacaBody(req);
          try { return json(res, 201, db.buatUser(b)); } catch (e) { return json(res, 400, { error: e.message }); }
        }
        const mU = p.match(/^\/api\/admin\/users\/(\d+)(\/password)?$/);
        if (mU) {
          const id = Number(mU[1]);
          if (!db.ambilUser(id)) return json(res, 404, { error: 'User tidak ditemukan' });
          if (M === 'POST' && mU[2]) {
            const b = await bacaBody(req);
            try { db.gantiPassword(id, b.password); return json(res, 200, {}); } catch (e) { return json(res, 400, { error: e.message }); }
          }
          if (M === 'DELETE' && !mU[2]) {
            if (id === uid) return json(res, 400, { error: 'Tidak bisa menghapus akunmu sendiri' });
            if (wa) await wa.hapusSemuaNomor(id);
            db.hapusUser(id);
            return json(res, 200, {});
          }
        }
        return json(res, 404, { error: 'Tidak ditemukan' });
      }

      // ---------- Transaksi ----------
      if (M === 'GET' && p === '/api/ringkasan') {
        const [dari, sampai] = rentangBulan(url.searchParams.get('bulan'));
        return json(res, 200, { total: db.saldo(uid), periode: dari ? db.ringkasan(dari, sampai, uid) : null });
      }
      if (M === 'GET' && p === '/api/transaksi') {
        const [dari, sampai] = rentangBulan(url.searchParams.get('bulan'));
        return json(res, 200, db.daftar({ uid, dari, sampai }));
      }
      if (M === 'POST' && p === '/api/transaksi') {
        const b = await bacaBody(req);
        const jumlah = Math.round(Number(b.jumlah));
        if (!['masuk', 'keluar'].includes(b.tipe) || !(jumlah > 0)) return json(res, 400, { error: 'Tipe atau jumlah tidak valid' });
        const keterangan = String(b.keterangan || '').trim().slice(0, 200) || (b.tipe === 'masuk' ? 'Pemasukan' : 'Pengeluaran');
        return json(res, 201, db.tambah({ uid, tipe: b.tipe, jumlah, keterangan, kategori: tebakKategori(keterangan, b.tipe), pengirim: 'web' }));
      }
      const mHapus = p.match(/^\/api\/transaksi\/(\d+)$/);
      if (M === 'DELETE' && mHapus) return json(res, db.hapus(Number(mHapus[1]), uid) ? 200 : 404, {});

      // ---------- Tabungan ----------
      if (M === 'GET' && p === '/api/tabungan') {
        return json(res, 200, { total: db.totalTabungan(uid), daftar: db.daftarTabungan(uid) });
      }
      if (M === 'POST' && p === '/api/tabungan') {
        const b = await bacaBody(req);
        try {
          return json(res, 201, db.buatTabungan({ uid, nama: b.nama, target: Number(b.target) || null,
            tenggat: /^\d{4}-\d{2}-\d{2}$/.test(b.tenggat || '') ? b.tenggat : null, ikon: String(b.ikon || '🐷').slice(0, 8) }));
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      const mTab = p.match(/^\/api\/tabungan\/(\d+)(?:\/(setor|tarik|ubah))?$/);
      if (mTab) {
        const id = Number(mTab[1]);
        const aksi = mTab[2];
        if (M === 'GET' && !aksi) {
          const t = db.ambilTabungan(id, uid);
          return t ? json(res, 200, t) : json(res, 404, { error: 'Tidak ditemukan' });
        }
        if (M === 'DELETE' && !aksi) return json(res, db.hapusTabungan(id, uid) ? 200 : 404, {});
        if (M === 'POST' && aksi) {
          const b = await bacaBody(req);
          if (aksi === 'ubah') {
            const t = db.ubahTabungan(id, uid, { nama: b.nama, target: b.target === undefined ? undefined : Number(b.target) || null,
              tenggat: b.tenggat === undefined ? undefined : (/^\d{4}-\d{2}-\d{2}$/.test(b.tenggat || '') ? b.tenggat : null), ikon: b.ikon });
            return t ? json(res, 200, t) : json(res, 404, { error: 'Tidak ditemukan' });
          }
          const jumlah = b.jumlah == null ? null : Math.round(Number(b.jumlah));
          const r = aksi === 'setor'
            ? db.setorTabungan({ uid, id, jumlah, pengirim: 'web' })
            : db.tarikTabungan({ uid, id, jumlah, pengirim: 'web' });
          return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.alasan });
        }
      }

      // ---------- Hutang & piutang ----------
      if (M === 'GET' && p === '/api/hutang') {
        return json(res, 200, { total: db.totalHutang(uid), daftar: db.daftarHutang({ uid }) });
      }
      if (M === 'POST' && p === '/api/hutang') {
        const b = await bacaBody(req);
        const jumlah = Math.round(Number(b.jumlah));
        const nama = String(b.nama || '').trim().slice(0, 60);
        const tempo = /^\d{4}-\d{2}-\d{2}$/.test(b.jatuh_tempo || '') ? b.jatuh_tempo : null;
        if (!['hutang', 'piutang'].includes(b.jenis) || !nama || !(jumlah > 0)) {
          return json(res, 400, { error: 'Jenis, nama, atau jumlah tidak valid' });
        }
        return json(res, 201, db.buatHutang({ uid, jenis: b.jenis, nama, jumlah,
          keterangan: String(b.keterangan || '').trim().slice(0, 200), jatuh_tempo: tempo, pengirim: 'web' }));
      }
      const mHutang = p.match(/^\/api\/hutang\/(\d+)(\/bayar)?$/);
      if (mHutang) {
        const id = Number(mHutang[1]);
        if (M === 'GET' && !mHutang[2]) {
          const h = db.ambilHutang(id, uid);
          return h ? json(res, 200, h) : json(res, 404, { error: 'Tidak ditemukan' });
        }
        if (M === 'POST' && mHutang[2]) {
          const b = await bacaBody(req);
          const jumlah = b.jumlah == null ? null : Math.round(Number(b.jumlah));
          if (jumlah !== null && !(jumlah > 0)) return json(res, 400, { error: 'Jumlah tidak valid' });
          const r = db.bayarHutang({ uid, id, jumlah, pengirim: 'web' });
          return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.alasan });
        }
        if (M === 'DELETE' && !mHutang[2]) return json(res, db.hapusHutang(id, uid) ? 200 : 404, {});
      }

      if (M === 'GET' && p === '/api/ekspor.csv') {
        const [dari, sampai] = rentangBulan(url.searchParams.get('bulan'));
        const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
        const baris = db.daftar({ uid, dari, sampai }).reverse().map((t) =>
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
