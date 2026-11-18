// Logika balasan, terpisah dari WhatsApp supaya mudah diuji.
import * as db from './db.js';
import { uraiPesan, bacaJumlah } from './parser.js';

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

*Foto struk:* kirim foto struk/nota/bukti transfer, AI akan membacanya lalu minta konfirmasi *ya* / *batal*.

Angka bisa ditulis 25rb, 25k, 25.000, 1,5jt.`;

function balasTercatat(t) {
  const s = db.saldo();
  const ikon = t.tipe === 'masuk' ? '🟢 Uang MASUK' : '🔴 Uang KELUAR';
  return `✅ Tercatat\n${ikon}: *${rupiah(t.jumlah)}*\n📝 ${t.keterangan}\n🏷️ ${t.kategori}\n\n💰 Saldo terakhir: *${rupiah(s.saldo)}*`;
}

// ---------- Struk dari foto: menunggu konfirmasi "ya" / "batal" ----------
const BATAS_TUNGGU = 15 * 60 * 1000;
const strukMenunggu = new Map(); // pengirim -> { tipe, jumlah, keterangan, kategori, dibuat, sampai }

/** Tanggal struk dipakai jika masuk akal (tidak di masa depan, maks. 90 hari lalu). */
function waktuDariStruk(tanggal, sekarang = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal || '')) return undefined;
  const d = new Date(tanggal + 'T00:00:00');
  const hariIni = new Date(sekarang.getFullYear(), sekarang.getMonth(), sekarang.getDate());
  if (isNaN(d) || d > hariIni || hariIni - d > 90 * 864e5) return undefined;
  if (+d === +hariIni) return undefined; // hari ini: pakai jam sekarang
  return `${tanggal} 12:00:00`;
}

/**
 * Mengubah hasil bacaStruk() menjadi balasan WA dan menyimpan draf yang menunggu konfirmasi.
 * @param {{ok:boolean, data?:object, alasan?:string}} hasil
 */
export function balasStruk(hasil, pengirim, caption = '') {
  if (!hasil.ok) return `⚠️ ${hasil.alasan}\n\nKamu tetap bisa mencatat manual, mis. *keluar 50rb belanja*.`;
  const s = hasil.data;
  if (!s.adalah_struk) return '🤔 Foto ini sepertinya bukan struk atau bukti pembayaran.\n\nKirim foto struk yang jelas, atau catat manual: *keluar 50rb belanja*.';
  const jumlah = Math.round(s.total);
  if (!(jumlah > 0)) return '🤔 Total di struk tidak terbaca. Coba foto ulang lebih dekat & terang, atau catat manual: *keluar 50rb belanja*.';

  const keterangan = (caption.trim() || s.ringkasan || s.toko || 'Belanja').slice(0, 200);
  const draf = { tipe: s.tipe, jumlah, keterangan, kategori: s.kategori, dibuat: waktuDariStruk(s.tanggal), sampai: Date.now() + BATAS_TUNGGU };
  strukMenunggu.set(pengirim, draf);

  const ikon = draf.tipe === 'masuk' ? '🟢 Uang MASUK' : '🔴 Uang KELUAR';
  return [
    '🧾 *Struk terbaca*',
    `${ikon}: *${rupiah(jumlah)}*`,
    s.toko ? `🏪 ${s.toko}` : null,
    s.tanggal ? `📅 ${s.tanggal}` : null,
    `📝 ${keterangan}`,
    `🏷️ ${draf.kategori}`,
    s.yakin ? null : '\n⚠️ Angkanya agak buram, tolong dicek.',
    '',
    'Balas *ya* untuk simpan, *batal* untuk membatalkan,',
    'atau ketik jumlah yang benar (mis. *87500*) untuk simpan dengan angka itu.',
  ].filter((x) => x !== null).join('\n');
}

function prosesKonfirmasi(teks, pengirim) {
  const draf = strukMenunggu.get(pengirim);
  if (!draf) return null;
  if (Date.now() > draf.sampai) { strukMenunggu.delete(pengirim); return null; }
  const k = teks.trim().toLowerCase();
  if (/^(ya|y|iya|ok|oke|simpan|benar|betul)$/.test(k)) {
    strukMenunggu.delete(pengirim);
    return balasTercatat(db.tambah({ ...draf, pengirim }));
  }
  if (/^(batal|tidak|gak|nggak|no|cancel)$/.test(k)) {
    strukMenunggu.delete(pengirim);
    return '❎ Struk tidak dicatat.';
  }
  const angka = k.match(/^(?:ubah\s+)?(?:rp\.?\s*)?(\d+(?:[.,]\d+)*\s*(?:rb|ribu|k|jt|juta)?)$/);
  if (angka) {
    const j = bacaJumlah(angka[1]);
    if (j) {
      strukMenunggu.delete(pengirim);
      return balasTercatat(db.tambah({ ...draf, jumlah: j.nilai, pengirim }));
    }
  }
  return null; // pesan lain diproses seperti biasa, draf tetap menunggu
}

/** Mengembalikan teks balasan, atau null bila pesan bukan untuk bot. */
export function prosesPesan(teks, pengirim) {
  const konfirmasi = prosesKonfirmasi(teks, pengirim);
  if (konfirmasi) return konfirmasi;

  const hasil = uraiPesan(teks);
  if (!hasil) return null;

  if (hasil.jenis === 'transaksi') {
    return balasTercatat(db.tambah({ ...hasil, pengirim }));
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
