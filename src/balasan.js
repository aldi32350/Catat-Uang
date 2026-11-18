// Logika balasan, terpisah dari WhatsApp supaya mudah diuji.
import * as db from './db.js';
import { uraiPesan, uraiHutang, uraiTabungan, bacaJumlah } from './parser.js';

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

*Hutang & piutang:*
• hutang 500rb ke budi buat modal
• piutang 200rb ke andi tempo 25/12
• bayar hutang budi 100rb  (atau *lunas*)
• terima piutang andi 50rb
• *hutang piutang* — lihat daftar & sisa

*Tabungan:*
• nabung 100rb umroh
• target umroh 10jt
• tarik tabungan umroh 50rb  (atau *semua*)
• *tabungan* — lihat semua & progresnya

*Foto struk:* kirim foto struk/nota/bukti transfer, bot membacanya lalu minta konfirmasi *ya* / *batal*.

Angka bisa ditulis 25rb, 25k, 25.000, 1,5jt.`;

function balasTercatat(t) {
  const s = db.saldo(t.user_id);
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
export function balasStruk(hasil, pengirim, caption = '', uid) {
  if (!hasil.ok) return `⚠️ ${hasil.alasan}\n\nKamu tetap bisa mencatat manual, mis. *keluar 50rb belanja*.`;
  const s = hasil.data;
  if (!s.adalah_struk) return '🤔 Foto ini sepertinya bukan struk atau bukti pembayaran.\n\nKirim foto struk yang jelas, atau catat manual: *keluar 50rb belanja*.';
  const jumlah = Math.round(s.total);
  if (!(jumlah > 0)) return '🤔 Total di struk tidak terbaca. Coba foto ulang lebih dekat & terang, atau catat manual: *keluar 50rb belanja*.';

  const keterangan = (caption.trim() || s.ringkasan || s.toko || 'Belanja').slice(0, 200);
  const draf = { tipe: s.tipe, jumlah, keterangan, kategori: s.kategori, dibuat: waktuDariStruk(s.tanggal), sampai: Date.now() + BATAS_TUNGGU };
  strukMenunggu.set(`${uid}:${pengirim}`, draf);

  const ikon = draf.tipe === 'masuk' ? '🟢 Uang MASUK' : '🔴 Uang KELUAR';
  return [
    '🧾 *Struk terbaca*',
    `${ikon}: *${rupiah(jumlah)}*`,
    s.toko ? `🏪 ${s.toko}` : null,
    s.tanggal ? `📅 ${s.tanggal}` : null,
    `📝 ${keterangan}`,
    `🏷️ ${draf.kategori}`,
    s.yakin ? null : (s.sumber === 'ocr' ? '\n⚠️ Baris TOTAL tidak ketemu, ini tebakan angka terbesar. Tolong dicek.' : '\n⚠️ Angkanya agak buram, tolong dicek.'),
    s.sumber === 'ocr' && s.yakin ? '\n_Dibaca OCR gratis, cek angkanya ya._' : null,
    '',
    'Balas *ya* untuk simpan, *batal* untuk membatalkan,',
    'atau ketik jumlah yang benar (mis. *87500*) untuk simpan dengan angka itu.',
  ].filter((x) => x !== null).join('\n');
}

function prosesKonfirmasi(teks, pengirim, uid) {
  const kunci = `${uid}:${pengirim}`;
  const draf = strukMenunggu.get(kunci);
  if (!draf) return null;
  if (Date.now() > draf.sampai) { strukMenunggu.delete(kunci); return null; }
  const k = teks.trim().toLowerCase();
  if (/^(ya|y|iya|ok|oke|simpan|benar|betul)$/.test(k)) {
    strukMenunggu.delete(kunci);
    return balasTercatat(db.tambah({ uid, ...draf, pengirim }));
  }
  if (/^(batal|tidak|gak|nggak|no|cancel)$/.test(k)) {
    strukMenunggu.delete(kunci);
    return '❎ Struk tidak dicatat.';
  }
  const angka = k.match(/^(?:ubah\s+)?(?:rp\.?\s*)?(\d+(?:[.,]\d+)*\s*(?:rb|ribu|k|jt|juta)?)$/);
  if (angka) {
    const j = bacaJumlah(angka[1]);
    if (j) {
      strukMenunggu.delete(kunci);
      return balasTercatat(db.tambah({ uid, ...draf, jumlah: j.nilai, pengirim }));
    }
  }
  return null; // pesan lain diproses seperti biasa, draf tetap menunggu
}

// ---------- Hutang & piutang ----------
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export function tglPendek(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${BULAN[m - 1]} ${y}`;
}
function infoTempo(iso, sekarang = new Date()) {
  if (!iso) return '';
  const hari = Math.round((new Date(iso + 'T00:00:00') - new Date(sekarang.getFullYear(), sekarang.getMonth(), sekarang.getDate())) / 864e5);
  if (hari < 0) return ` · ⚠️ lewat tempo ${tglPendek(iso)}`;
  if (hari === 0) return ' · ⏰ jatuh tempo hari ini';
  if (hari <= 7) return ` · ⏰ tempo ${hari} hari lagi`;
  return ` · tempo ${tglPendek(iso)}`;
}

function barisHutang(uid) {
  const t = db.totalHutang(uid);
  const tab = db.totalTabungan(uid);
  let teks = '';
  if (tab) teks += `\n🐷 Tabungan: ${rupiah(tab)}`;
  if (t.hutang || t.piutang) teks += `\n📕 Hutang saya: ${rupiah(t.hutang)}\n📗 Piutang (uang saya di orang): ${rupiah(t.piutang)}`;
  return teks ? '\n' + teks : '';
}

function daftarHutangTeks(filter, uid) {
  const bagian = [];
  for (const jenis of filter ? [filter] : ['hutang', 'piutang']) {
    const orang = db.hutangPerOrang(jenis, uid);
    const total = orang.reduce((s, o) => s + o.sisa, 0);
    const judul = jenis === 'hutang' ? `📕 *Hutang saya* — ${rupiah(total)}` : `📗 *Piutang (orang berhutang ke saya)* — ${rupiah(total)}`;
    bagian.push(judul + '\n' + (orang.length
      ? orang.map((o) => `• ${o.nama}: *${rupiah(o.sisa)}*${infoTempo(o.jatuh_tempo)}`).join('\n')
      : (jenis === 'hutang' ? '_Tidak ada hutang_ 🎉' : '_Tidak ada piutang_')));
  }
  return bagian.join('\n\n') + '\n\nBayar: *bayar hutang budi 100rb* · Terima: *terima piutang andi 50rb*';
}

function prosesHutang(h, pengirim, uid) {
  if (h.jenis === 'perintah') return daftarHutangTeks(h.filter, uid);

  if (h.jenis === 'hutang-baru') {
    const { hutang } = db.buatHutang({ uid, jenis: h.tipe, nama: h.nama, jumlah: h.jumlah, keterangan: h.keterangan, jatuh_tempo: h.tempo, pengirim });
    const totalOrang = db.hutangPerOrang(h.tipe, uid).find((o) => o.nama.toLowerCase() === hutang.nama.toLowerCase())?.sisa ?? hutang.jumlah;
    const isHutang = h.tipe === 'hutang';
    return [
      isHutang ? '📕 *Hutang tercatat*' : '📗 *Piutang tercatat*',
      `👤 ${hutang.nama}`,
      `💵 ${rupiah(hutang.jumlah)} ${isHutang ? '(uang masuk ke saldo)' : '(uang keluar dari saldo)'}`,
      hutang.keterangan ? `📝 ${hutang.keterangan}` : null,
      hutang.jatuh_tempo ? `📅 Jatuh tempo: ${tglPendek(hutang.jatuh_tempo)}` : null,
      '',
      isHutang ? `Total hutangmu ke ${hutang.nama}: *${rupiah(totalOrang)}*` : `Total piutang ${hutang.nama}: *${rupiah(totalOrang)}*`,
      `💰 Saldo terakhir: *${rupiah(db.saldo(uid).saldo)}*`,
    ].filter((x) => x !== null).join('\n');
  }

  // hutang-bayar
  if (h.jumlah === undefined) {
    const sisa = db.hutangPerOrang(h.tipe, uid).find((o) => o.nama.toLowerCase() === h.nama.toLowerCase())?.sisa;
    const contoh = h.tipe === 'hutang' ? `bayar hutang ${h.nama.toLowerCase()} 100rb` : `terima piutang ${h.nama.toLowerCase()} 100rb`;
    return (sisa ? `Sisa ${h.tipe === 'hutang' ? 'hutang ke' : 'piutang'} ${h.nama}: *${rupiah(sisa)}*\n\n` : '') +
      `Berapa jumlahnya? Contoh: *${contoh}*, atau tambahkan *lunas* untuk melunasi semuanya.`;
  }
  const r = db.bayarHutang({ uid, jenis: h.tipe, nama: h.nama, jumlah: h.jumlah, pengirim });
  if (!r.ok) return `🤔 ${r.alasan}\n\nKetik *hutang piutang* untuk melihat daftarnya.`;
  const isHutang = h.tipe === 'hutang';
  return [
    isHutang ? `✅ Bayar hutang ke ${r.nama}: *${rupiah(r.dibayar)}*` : `✅ Piutang dibayar ${r.nama}: *${rupiah(r.dibayar)}*`,
    r.kelebihan ? `⚠️ Kelebihan ${rupiah(r.kelebihan)} tidak dicatat (melebihi sisa).` : null,
    r.lunas ? (isHutang ? `🎉 Hutang ke ${r.nama} *LUNAS*` : `🎉 Piutang ${r.nama} *LUNAS*`)
      : `Sisa ${isHutang ? 'hutang ke' : 'piutang'} ${r.nama}: *${rupiah(r.sisa)}*`,
    '',
    `💰 Saldo terakhir: *${rupiah(db.saldo(uid).saldo)}*`,
  ].filter((x) => x !== null).join('\n');
}

// ---------- Tabungan ----------
function batang(persen) {
  const isi = Math.round((persen || 0) / 10);
  return '▓'.repeat(isi) + '░'.repeat(10 - isi);
}
function barisTabungan(b) {
  return b.target
    ? `${b.ikon} *${b.nama}*: ${rupiah(b.terkumpul)} / ${rupiah(b.target)} (${b.persen}%)\n   ${batang(b.persen)}${b.tercapai ? ' 🎉' : ''}`
    : `${b.ikon} *${b.nama}*: ${rupiah(b.terkumpul)}`;
}

function prosesTabungan(h, uid) {
  if (h.jenis === 'tabungan-daftar') {
    const list = db.daftarTabungan(uid);
    if (!list.length) return '🐷 Belum ada tabungan.\n\nMulai dengan: *nabung 100rb umroh*\nAtur target: *target umroh 10jt*';
    const total = list.reduce((s, b) => s + b.terkumpul, 0);
    return `🐷 *Tabungan* — total ${rupiah(total)}\n\n` + list.map(barisTabungan).join('\n') +
      `\n\n💰 Saldo dompet: *${rupiah(db.saldo(uid).saldo)}*\nNabung: *nabung 100rb umroh* · Tarik: *tarik tabungan umroh 50rb*`;
  }

  let b = db.cariTabungan(h.nama, uid);

  if (h.jenis === 'tabungan-target') {
    b = b ? db.ubahTabungan(b.id, uid, { target: h.target }) : db.buatTabungan({ uid, nama: h.nama, target: h.target });
    return `🎯 Target *${b.nama}*: ${rupiah(b.target)}\n${barisTabungan(b)}`;
  }

  if (h.jenis === 'tabungan-setor') {
    const baru = !b;
    if (!b) b = db.buatTabungan({ uid, nama: h.nama });
    const r = db.setorTabungan({ uid, id: b.id, jumlah: h.jumlah, pengirim: 'wa' });
    const saldo = db.saldo(uid).saldo;
    return [
      `🐷 Nabung *${rupiah(r.jumlah)}* ke *${r.tabungan.nama}*${baru ? ' (tabungan baru)' : ''}`,
      barisTabungan(r.tabungan),
      r.tabungan.tercapai ? '🎉 Target tercapai!' : (r.tabungan.target ? `Kurang ${rupiah(r.tabungan.target - r.tabungan.terkumpul)} lagi` : null),
      '',
      `💰 Saldo dompet: *${rupiah(saldo)}*`,
      saldo < 0 ? '⚠️ Saldo dompet jadi minus, cek lagi ya.' : null,
      baru && !r.tabungan.target ? `\nAtur target: *target ${r.tabungan.nama.toLowerCase()} 10jt*` : null,
    ].filter((x) => x !== null).join('\n');
  }

  // tabungan-tarik
  if (!b) {
    const ada = db.daftarTabungan(uid).map((x) => x.nama).join(', ');
    return `🤔 Tabungan "${h.nama}" tidak ditemukan.` + (ada ? `\nTabunganmu: ${ada}` : '');
  }
  if (h.jumlah === undefined) {
    return `Isi tabungan ${b.nama}: *${rupiah(b.terkumpul)}*\n\nBerapa yang ditarik? Contoh: *tarik tabungan ${b.nama.toLowerCase()} 100rb*, atau *... semua*.`;
  }
  const r = db.tarikTabungan({ uid, id: b.id, jumlah: h.jumlah, pengirim: 'wa' });
  if (!r.ok) return `🤔 ${r.alasan}`;
  return `💸 Tarik *${rupiah(r.jumlah)}* dari *${r.tabungan.nama}*\nSisa tabungan: ${rupiah(r.tabungan.terkumpul)}\n\n💰 Saldo dompet: *${rupiah(db.saldo(uid).saldo)}*`;
}

/** Mengembalikan teks balasan, atau null bila pesan bukan untuk bot. */
export function prosesPesan(teks, pengirim, uid) {
  const konfirmasi = prosesKonfirmasi(teks, pengirim, uid);
  if (konfirmasi) return konfirmasi;

  const tb = uraiTabungan(teks);
  if (tb) return prosesTabungan(tb, uid);

  const hh = uraiHutang(teks);
  if (hh) return prosesHutang(hh, pengirim, uid);

  const hasil = uraiPesan(teks);
  if (!hasil) return null;

  if (hasil.jenis === 'transaksi') {
    return balasTercatat(db.tambah({ uid, ...hasil, pengirim }));
  }

  switch (hasil.nama) {
    case 'bantuan':
      return BANTUAN;
    case 'saldo': {
      const s = db.saldo(uid);
      return `💰 *Saldo terakhir: ${rupiah(s.saldo)}*\n\n🟢 Total masuk: ${rupiah(s.masuk)}\n🔴 Total keluar: ${rupiah(s.keluar)}` + barisHutang(uid);
    }
    case 'laporan': {
      const [dari, sampai, label] = rentang(hasil.periode);
      const r = db.ringkasan(dari, sampai, uid);
      const s = db.saldo(uid);
      let teksLap = `📊 *Laporan ${label}*\n\n🟢 Masuk: ${rupiah(r.masuk)}\n🔴 Keluar: ${rupiah(r.keluar)}\n➖ Selisih: ${rupiah(r.selisih)}\n🧾 ${r.jumlahTransaksi} transaksi`;
      if (r.perKategori.length) {
        teksLap += '\n\n*Pengeluaran per kategori:*\n' +
          r.perKategori.map((k) => `• ${k.kategori}: ${rupiah(k.total)}`).join('\n');
      }
      return teksLap + `\n\n💰 Saldo terakhir: *${rupiah(s.saldo)}*` + barisHutang(uid);
    }
    case 'riwayat': {
      const list = db.daftar({ uid, limit: 10 });
      if (!list.length) return 'Belum ada transaksi. Ketik *bantuan* untuk cara mencatat.';
      return '🧾 *10 transaksi terakhir*\n\n' + list.map((t) =>
        `${t.tipe === 'masuk' ? '🟢 +' : '🔴 -'}${rupiah(t.jumlah)} ${t.keterangan}\n   ${t.dibuat.slice(0, 16)} · saldo ${rupiah(t.saldoSetelah)}`
      ).join('\n');
    }
    case 'hapus': {
      const t = db.terakhirDari(pengirim, uid);
      if (!t) return 'Tidak ada catatan darimu yang bisa dihapus.';
      db.hapus(t.id, uid);
      const ekstra = t.hutang_peran === 'pokok' ? `\n(catatan ${t.kategori.toLowerCase()} ini ikut dihapus)` : '';
      return `🗑️ Dihapus: ${t.tipe === 'masuk' ? '+' : '-'}${rupiah(t.jumlah)} ${t.keterangan}${ekstra}\n\n💰 Saldo terakhir: *${rupiah(db.saldo(uid).saldo)}*`;
    }
  }
  return null;
}
