// Logika balasan, terpisah dari WhatsApp supaya mudah diuji.
import * as db from './db.js';
import { uraiPesan } from './parser.js';

export const rupiah = (n) => 'Rp' + Math.round(n).toLocaleString('id-ID');

const pad = (n) => String(n).padStart(2, '0');
const tgl = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;

export function rentang(periode, sekarang = new Date()) {
  const y = sekarang.getFullYear(), m = sekarang.getMonth(), d = sekarang.getDate();
  switch (periode) {
    case 'hari ini': return [tgl(new Date(y, m, d)), tgl(new Date(y, m, d + 1)), 'Hari ini'];
    case 'kemarin': return [tgl(new Date(y, m, d - 1)), tgl(new Date(y, m, d)), 'Kemarin'];
    case 'minggu ini': {
      const senin = new Date(y, m, d - ((sekarang.getDay() + 6) % 7));
      return [tgl(senin), tgl(new Date(y, m, d + 1)), 'Minggu ini'];
    }
    case 'bulan lalu': return [tgl(new Date(y, m - 1, 1)), tgl(new Date(y, m, 1)),
      new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })];
    default: return [tgl(new Date(y, m, 1)), tgl(new Date(y, m + 1, 1)),
      sekarang.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })];
  }
}

export const BANTUAN = `📒 *Catat Keuangan*

*Catat uang masuk:*
• masuk 5jt gaji
• +150rb jual kue

*Catat uang keluar:*
• keluar 25rb makan siang
• beli bensin 20000
• -1,5jt bayar kos

*Perintah:*
• *saldo* — saldo terakhir
• *laporan* — rekap bulan ini
• *hari ini* / *minggu ini* / *bulan lalu*
• *riwayat* — 10 transaksi terakhir
• *hapus* — batalkan catatan terakhirmu

Angka bisa ditulis 25rb, 25k, 25.000, 1,5jt.`;

/** Mengembalikan teks balasan, atau null bila pesan bukan untuk bot. */
export function prosesPesan(teks, pengirim) {
  const hasil = uraiPesan(teks);
  if (!hasil) return null;

  if (hasil.jenis === 'transaksi') {
    const t = db.tambah({ ...hasil, pengirim });
    const s = db.saldo();
    const ikon = t.tipe === 'masuk' ? '🟢 Uang MASUK' : '🔴 Uang KELUAR';
    return `✅ Tercatat\n${ikon}: *${rupiah(t.jumlah)}*\n📝 ${t.keterangan}\n🏷️ ${t.kategori}\n\n💰 Saldo terakhir: *${rupiah(s.saldo)}*`;
  }

  switch (hasil.nama) {
    case 'bantuan':
      return BANTUAN;
    case 'saldo': {
      const s = db.saldo();
      return `💰 *Saldo terakhir: ${rupiah(s.saldo)}*\n\n🟢 Total masuk: ${rupiah(s.masuk)}\n🔴 Total keluar: ${rupiah(s.keluar)}`;
    }
    case 'laporan': {
      const [dari, sampai, label] = rentang(hasil.periode);
      const r = db.ringkasan(dari, sampai);
      const s = db.saldo();
      let teksLap = `📊 *Laporan ${label}*\n\n🟢 Masuk: ${rupiah(r.masuk)}\n🔴 Keluar: ${rupiah(r.keluar)}\n➖ Selisih: ${rupiah(r.selisih)}\n🧾 ${r.jumlahTransaksi} transaksi`;
      if (r.perKategori.length) {
        teksLap += '\n\n*Pengeluaran per kategori:*\n' +
          r.perKategori.map((k) => `• ${k.kategori}: ${rupiah(k.total)}`).join('\n');
      }
      return teksLap + `\n\n💰 Saldo terakhir: *${rupiah(s.saldo)}*`;
    }
    case 'riwayat': {
      const list = db.daftar({ limit: 10 });
      if (!list.length) return 'Belum ada transaksi. Ketik *bantuan* untuk cara mencatat.';
      return '🧾 *10 transaksi terakhir*\n\n' + list.map((t) =>
        `${t.tipe === 'masuk' ? '🟢 +' : '🔴 -'}${rupiah(t.jumlah)} ${t.keterangan}\n   ${t.dibuat.slice(0, 16)} · saldo ${rupiah(t.saldoSetelah)}`
      ).join('\n');
    }
    case 'hapus': {
      const t = db.terakhirDari(pengirim);
      if (!t) return 'Tidak ada catatan darimu yang bisa dihapus.';
      db.hapus(t.id);
      return `🗑️ Dihapus: ${t.tipe === 'masuk' ? '+' : '-'}${rupiah(t.jumlah)} ${t.keterangan}\n\n💰 Saldo terakhir: *${rupiah(db.saldo().saldo)}*`;
    }
  }
  return null;
}
