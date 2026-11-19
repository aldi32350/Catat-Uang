// Logika balasan, terpisah dari WhatsApp supaya mudah diuji.
import * as db from './db.js';
import { uraiPesan, uraiHutang, uraiTabungan, bacaJumlah, bacaAkun, bacaSemuaAkun, bacaTanggalLalu } from './parser.js';

// ---------- Sumber dana ----------
export const IKON_AKUN = { tunai: '💵', bank: '🏦', ewallet: '📱', lainnya: '💳' };
/** Cari sumber dana yang disebut di pesan (mis. "pakai dana", "ke bca", "gopay"). */
const sebutAkun = (teks, uid) => bacaAkun(teks, db.daftarAkunPolos(uid), db.AKUN_PRESET, db.ALIAS_BUTUH_PENANDA);
/** Sumber dana yang disebut → milik user; preset (bank/e-wallet) yang belum ada otomatis dibuat. */
function pastikanAkun(sebut, uid) {
  if (!sebut) return null;
  return db.cariAkunNama(sebut.nama, uid) || db.buatAkun({ uid, nama: sebut.nama, jenis: sebut.jenis });
}
function infoAkun(akunId, uid) {
  const a = db.daftarAkun(uid).find((x) => x.id === akunId);
  return a ? `${IKON_AKUN[a.jenis]} ${a.nama} · saldo ${rupiah(a.saldo)}` : '';
}

export const rupiah = (n) => (n < 0 ? '−Rp' : 'Rp') + Math.round(Math.abs(n)).toLocaleString('id-ID');

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

// ---------- Bantuan: menu singkat + rincian per topik ----------
const MENU_BANTUAN = `📒 *Catat Uang — Bantuan*

Cukup ketik seperti ngobrol biasa:
*apa + berapa + untuk apa + pakai apa*

✍️ Contoh:
• keluar 25rb bakso pakai dana
• masuk 5jt gaji ke bca

Pilih topik, balas *bantuan + nomor* (mis. *bantuan 1*):

*1.* 💸 Uang masuk & keluar
*2.* 💳 Sumber dana (bank, e-wallet, tunai)
*3.* 🤝 Hutang & piutang
*4.* 🐷 Tabungan
*5.* 📊 Cek saldo & laporan
*6.* 🧾 Foto struk & catat yang terlupa

Angka boleh ditulis *25rb*, *25k*, *25.000*, *1,5jt*.`;

const TOPIK_BANTUAN = [
  { kata: /^(1|catat|masuk|keluar|uang|transaksi)/, teks: `💸 *Uang masuk & keluar*

Pola: *masuk/keluar + jumlah + keterangan + sumber dana*

🟢 Uang masuk:
• masuk 5jt gaji ke bca
• masuk 150rb jual kue ke dana
• +200rb bonus tunai

🔴 Uang keluar:
• keluar 25rb makan siang pakai gopay
• beli bensin 20rb tunai
• bayar listrik 300rb pakai bri
• -1,5jt bayar kos pakai mandiri

Kalau sumber dana tidak disebut, bot akan *bertanya* dulu: cukup balas nomornya.
Salah catat? Ketik *hapus* untuk membatalkan catatan terakhir.` },
  { kata: /^(2|sumber|dana|bank|e-?wallet|rekening|dompet|pindah|transfer)/, teks: `💳 *Sumber dana*

Sebut di akhir kalimat dengan *pakai / ke / dari / via*:
• … *pakai dana* · … *pakai gopay* · … *pakai ovo*
• … *ke bca* · … *ke bri* · … *ke mandiri*
• … *tunai* / *cash*
Nama bank/e-wallet baru otomatis ditambahkan.

🔁 Pindah saldo antar sumber (tidak dihitung pengeluaran):
• pindah 100rb dari bca ke dana
• topup gopay 50rb dari bri
• tarik tunai 500rb bca
• setor tunai 1jt ke bri

Ketik *saldo* untuk melihat saldo tiap sumber dana.` },
  { kata: /^(3|hutang|utang|piutang|pinjam)/, teks: `🤝 *Hutang & piutang*

📕 *Kamu pinjam uang* (hutang):
• hutang 500rb ke budi masuk ke bca
• hutang 1jt ke pak joko tempo 25/12 tunai

💵 *Kamu bayar hutang*:
• sudah bayar hutang ke budi 100rb pakai dana
• bayar hutang budi lunas pakai bca

📗 *Orang pinjam uangmu* (piutang):
• piutang 200rb ke andi pakai bca
• pinjamkan 150rb ke rina tunai

💰 *Orang membayar ke kamu*:
• andi sudah bayar 50rb ke dana
• rina lunas ke bca

📋 Lihat daftar: *hutang piutang*` },
  { kata: /^(4|tabung|nabung|celengan)/, teks: `🐷 *Tabungan*

• nabung 100rb umroh dari bca
• nabung 50rb dana darurat pakai gopay
• target umroh 10jt
• tarik tabungan umroh 200rb ke bca
• tarik tabungan umroh semua ke dana

📋 Lihat semua tabungan: *tabungan*
Uang yang ditabung pindah dari sumber dana ke tabungan (bukan pengeluaran).` },
  { kata: /^(5|saldo|laporan|cek|rekap|riwayat)/, teks: `📊 *Cek saldo & laporan*

• *saldo* — saldo total & per sumber dana
• *laporan* — rekap bulan ini
• *hari ini* / *kemarin* / *minggu ini* / *bulan lalu*
• *riwayat* — 10 transaksi terakhir
• *hutang piutang* — sisa hutang & piutang
• *tabungan* — progres tabungan` },
  { kata: /^(6|struk|foto|nota|tanggal|lupa|kemarin)/, teks: `🧾 *Foto struk*
Kirim foto struk/nota/bukti transfer ke chat ini. Bot membaca totalnya, lalu balas:
• *ya* — simpan
• *ya pakai bca* — simpan dengan sumber dana lain
• *87500* — simpan dengan angka yang benar
• *batal* — tidak jadi

📅 *Lupa mencatat?* Tambahkan kapan:
• keluar 25rb bakso pakai dana *kemarin*
• keluar 50rb bensin tunai *tgl 15*
• masuk 2jt gaji ke bca *3 hari lalu* / *senin* / *10 nov*` },
];

function bantuan(topik) {
  if (!topik) return MENU_BANTUAN;
  const t = TOPIK_BANTUAN.find((x) => x.kata.test(topik.trim().toLowerCase()));
  return t ? `${t.teks}\n\n↩️ Menu bantuan: ketik *bantuan*` : MENU_BANTUAN;
}
export const BANTUAN = MENU_BANTUAN;

const HARI_WA = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
function balasTercatat(t) {
  const s = db.saldo(t.user_id);
  const ikon = t.tipe === 'masuk' ? '🟢 Uang MASUK' : '🔴 Uang KELUAR';
  // Tampilkan tanggal bila bukan hari ini (transaksi yang dicatat mundur)
  const now = new Date();
  const hariIni = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const tgl = t.dibuat.slice(0, 10);
  const baris = tgl !== hariIni ? `\n📅 ${HARI_WA[new Date(tgl + 'T00:00').getDay()]}, ${tglPendek(tgl)}` : '';
  const akun = t.akun_id ? `\n${infoAkun(t.akun_id, t.user_id)}` : '';
  return `✅ Tercatat\n${ikon}: *${rupiah(t.jumlah)}*\n📝 ${t.keterangan}\n🏷️ ${t.kategori}${baris}${akun}\n\n💰 Saldo total: *${rupiah(s.saldo)}*`;
}

// ---------- Pindah saldo antar sumber dana ----------
const CONTOH_PINDAH = '• *pindah 100rb dari bca ke dana*\n• *topup gopay 50rb dari bri*\n• *tarik tunai 500rb bca*\n• *setor tunai 1jt ke bri*';
function prosesTransfer(teks, pengirim, uid) {
  const m = teks.trim().toLowerCase().match(/^(pindah(?:kan)?|transfer|tf|top\s?up|isi\s+saldo|tarik\s+tunai|setor\s+tunai)\b/);
  if (!m) return null;
  const cmd = m[1].replace(/\s+/g, ' ');
  const { cocok, sisa } = bacaSemuaAkun(teks, db.daftarAkunPolos(uid), db.AKUN_PRESET, db.ALIAS_BUTUH_PENANDA, 2);
  const { tanggal, sisa: tanpaTgl } = bacaTanggalLalu(sisa);
  const jumlah = bacaJumlah(tanpaTgl);
  if (!jumlah) return null;
  if (!cocok.length) {
    // "transfer 100rb ke budi" = membayar orang, bukan pindah saldo
    return `🤔 Sumber dananya belum disebut.\n\nUntuk pindah saldo antar rekening/e-wallet:\n${CONTOH_PINDAH}\n\nUntuk bayar/transfer ke orang lain, catat sebagai pengeluaran:\n• *keluar 100rb transfer budi pakai bca*`;
  }
  const awal = (c, re) => re.test(c.teks.trim());
  let dari = null, ke = null;
  if (cmd === 'tarik tunai') { ke = cocok.find((c) => c.akun.jenis === 'tunai'); dari = cocok.find((c) => c !== ke); }
  else if (cmd === 'setor tunai') { dari = cocok.find((c) => c.akun.jenis === 'tunai'); ke = cocok.find((c) => c !== dari); }
  else {
    dari = cocok.find((c) => awal(c, /^dari\b/i));
    ke = cocok.find((c) => c !== dari && awal(c, /^(ke|masuk\s+ke|transfer\s+ke|tf\s+ke)\b/i));
    const lain = cocok.filter((c) => c !== dari && c !== ke);
    if (/^(top|isi)/.test(cmd)) { ke = ke || lain.shift(); dari = dari || lain.shift(); }
    else { dari = dari || lain.shift(); ke = ke || lain.shift(); }
  }
  const akKe = ke && pastikanAkun(ke.akun, uid);
  let akDari = dari && pastikanAkun(dari.akun, uid);
  if (!akDari && akKe && /^(top|isi)/.test(cmd)) { const u = db.akunUtama(uid); if (u.id !== akKe.id) akDari = u; }
  if (!akDari || !akKe) return `🤔 Sebutkan asal dan tujuannya ya. Contoh:\n${CONTOH_PINDAH}`;
  const r = db.transferAkun({ uid, dari: akDari.id, ke: akKe.id, jumlah: jumlah.nilai, pengirim, dibuat: waktuMundur(tanggal) });
  if (!r.ok) return `🤔 ${r.alasan}`;
  return [
    `🔁 *Pindah saldo ${rupiah(r.jumlah)}*`,
    `${IKON_AKUN[akDari.jenis]} ${akDari.nama} → ${IKON_AKUN[akKe.jenis]} ${akKe.nama}`,
    tanggal ? `📅 ${tglPendek(tanggal)}` : null,
    '',
    infoAkun(akDari.id, uid),
    infoAkun(akKe.id, uid),
    '',
    '_Tidak dihitung sebagai pemasukan/pengeluaran._',
  ].filter((x) => x !== null).join('\n');
}

/** 'YYYY-MM-DD' lampau → waktu simpan dengan jam sekarang (urutan tetap rapi). */
function waktuMundur(tanggal) {
  if (!tanggal) return undefined;
  const t = new Date(), pad = (n) => String(n).padStart(2, '0');
  return `${tanggal} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
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

  // Sumber dana: dari caption ("pakai dana") atau dari metode bayar yang terbaca di struk ("QRIS DANA", "Debit BCA")
  const dariCaption = caption ? sebutAkun(caption, uid) : { akun: null, sisa: '' };
  const akun = dariCaption.akun || (s.metode_bayar ? sebutAkun('pakai ' + s.metode_bayar, uid).akun : null);
  const keterangan = (dariCaption.sisa.trim() || s.ringkasan || s.toko || 'Belanja').slice(0, 200);
  const draf = { tipe: s.tipe, jumlah, keterangan, kategori: s.kategori, dibuat: waktuDariStruk(s.tanggal), akun, sampai: Date.now() + BATAS_TUNGGU };
  strukMenunggu.set(`${uid}:${pengirim}`, draf);

  const ikon = draf.tipe === 'masuk' ? '🟢 Uang MASUK' : '🔴 Uang KELUAR';
  const utama = db.akunUtama(uid);
  return [
    '🧾 *Struk terbaca*',
    `${ikon}: *${rupiah(jumlah)}*`,
    s.toko ? `🏪 ${s.toko}` : null,
    s.tanggal ? `📅 ${s.tanggal}` : null,
    `📝 ${keterangan}`,
    `🏷️ ${draf.kategori}`,
    akun ? `${IKON_AKUN[akun.jenis]} ${draf.tipe === 'masuk' ? 'Masuk ke' : 'Bayar pakai'}: *${akun.nama}*`
      : `${IKON_AKUN[utama.jenis]} Sumber dana: *${utama.nama}* _(utama)_`,
    s.yakin ? null : (s.sumber === 'ocr' ? '\n⚠️ Baris TOTAL tidak ketemu, ini tebakan angka terbesar. Tolong dicek.' : '\n⚠️ Angkanya agak buram, tolong dicek.'),
    s.sumber === 'ocr' && s.yakin ? '\n_Dibaca OCR gratis, cek angkanya ya._' : null,
    '',
    'Balas *ya* untuk simpan, *batal* untuk membatalkan,',
    'atau ketik jumlah yang benar (mis. *87500*).',
    'Ganti sumber dana: *ya pakai bca* / *ya pakai gopay*.',
  ].filter((x) => x !== null).join('\n');
}

function prosesKonfirmasi(teks, pengirim, uid) {
  const kunci = `${uid}:${pengirim}`;
  const draf = strukMenunggu.get(kunci);
  if (!draf) return null;
  if (Date.now() > draf.sampai) { strukMenunggu.delete(kunci); return null; }
  // "ya pakai bca" → ganti sumber dana lalu simpan
  const ganti = sebutAkun(teks, uid);
  const k = ganti.sisa.trim().toLowerCase();
  const akunDraf = ganti.akun || draf.akun;
  const simpan = (jumlah) => balasTercatat(db.tambah({ uid, ...draf, jumlah, akun_id: pastikanAkun(akunDraf, uid)?.id ?? null, pengirim }));
  if (/^(ya|y|iya|ok|oke|simpan|benar|betul)?$/.test(k) && (k || ganti.akun)) {
    strukMenunggu.delete(kunci);
    return simpan(draf.jumlah);
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
      return simpan(j.nilai);
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

function prosesHutang(h, pengirim, uid, akunId = () => null) {
  if (h.jenis === 'perintah') return daftarHutangTeks(h.filter, uid);

  if (h.jenis === 'hutang-baru') {
    const ak = akunId();
    const { hutang } = db.buatHutang({ uid, jenis: h.tipe, nama: h.nama, jumlah: h.jumlah, keterangan: h.keterangan, jatuh_tempo: h.tempo, pengirim, akun_id: ak });
    const totalOrang = db.hutangPerOrang(h.tipe, uid).find((o) => o.nama.toLowerCase() === hutang.nama.toLowerCase())?.sisa ?? hutang.jumlah;
    const isHutang = h.tipe === 'hutang';
    return [
      isHutang ? '📕 *Hutang tercatat*' : '📗 *Piutang tercatat*',
      `👤 ${hutang.nama}`,
      `💵 ${rupiah(hutang.jumlah)} ${isHutang ? '(uang masuk ke saldo)' : '(uang keluar dari saldo)'}`,
      infoAkun(ak, uid),
      hutang.keterangan ? `📝 ${hutang.keterangan}` : null,
      hutang.jatuh_tempo ? `📅 Jatuh tempo: ${tglPendek(hutang.jatuh_tempo)}` : null,
      '',
      isHutang ? `Total hutangmu ke ${hutang.nama}: *${rupiah(totalOrang)}*` : `Total piutang ${hutang.nama}: *${rupiah(totalOrang)}*`,
      `💰 Saldo total: *${rupiah(db.saldo(uid).saldo)}*`,
    ].filter((x) => x !== null).join('\n');
  }

  // hutang-bayar
  if (h.jumlah === undefined) {
    const sisa = db.hutangPerOrang(h.tipe, uid).find((o) => o.nama.toLowerCase() === h.nama.toLowerCase())?.sisa;
    const contoh = h.tipe === 'hutang' ? `bayar hutang ${h.nama.toLowerCase()} 100rb` : `terima piutang ${h.nama.toLowerCase()} 100rb`;
    return (sisa ? `Sisa ${h.tipe === 'hutang' ? 'hutang ke' : 'piutang'} ${h.nama}: *${rupiah(sisa)}*\n\n` : '') +
      `Berapa jumlahnya? Contoh: *${contoh}*, atau tambahkan *lunas* untuk melunasi semuanya.`;
  }
  const ak = akunId();
  const r = db.bayarHutang({ uid, jenis: h.tipe, nama: h.nama, jumlah: h.jumlah, pengirim, akun_id: ak });
  if (!r.ok) return `🤔 ${r.alasan}\n\nKetik *hutang piutang* untuk melihat daftarnya.`;
  const isHutang = h.tipe === 'hutang';
  return [
    isHutang ? `✅ Bayar hutang ke ${r.nama}: *${rupiah(r.dibayar)}*` : `✅ Piutang dibayar ${r.nama}: *${rupiah(r.dibayar)}*`,
    r.kelebihan ? `⚠️ Kelebihan ${rupiah(r.kelebihan)} tidak dicatat (melebihi sisa).` : null,
    r.lunas ? (isHutang ? `🎉 Hutang ke ${r.nama} *LUNAS*` : `🎉 Piutang ${r.nama} *LUNAS*`)
      : `Sisa ${isHutang ? 'hutang ke' : 'piutang'} ${r.nama}: *${rupiah(r.sisa)}*`,
    infoAkun(ak, uid),
    '',
    `💰 Saldo total: *${rupiah(db.saldo(uid).saldo)}*`,
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

function prosesTabungan(h, uid, akunId = () => null) {
  if (h.jenis === 'tabungan-daftar') {
    const list = db.daftarTabungan(uid);
    if (!list.length) return '🐷 Belum ada tabungan.\n\nMulai dengan: *nabung 100rb umroh*\nAtur target: *target umroh 10jt*';
    const total = list.reduce((s, b) => s + b.terkumpul, 0);
    return `🐷 *Tabungan* — total ${rupiah(total)}\n\n` + list.map(barisTabungan).join('\n') +
      `\n\n💰 Saldo total: *${rupiah(db.saldo(uid).saldo)}*\nNabung: *nabung 100rb umroh* · Tarik: *tarik tabungan umroh 50rb*`;
  }

  let b = db.cariTabungan(h.nama, uid);

  if (h.jenis === 'tabungan-target') {
    b = b ? db.ubahTabungan(b.id, uid, { target: h.target }) : db.buatTabungan({ uid, nama: h.nama, target: h.target });
    return `🎯 Target *${b.nama}*: ${rupiah(b.target)}\n${barisTabungan(b)}`;
  }

  if (h.jenis === 'tabungan-setor') {
    const baru = !b;
    if (!b) b = db.buatTabungan({ uid, nama: h.nama });
    const ak = akunId();
    const r = db.setorTabungan({ uid, id: b.id, jumlah: h.jumlah, pengirim: 'wa', akun_id: ak });
    const saldo = db.saldo(uid).saldo;
    return [
      `🐷 Nabung *${rupiah(r.jumlah)}* ke *${r.tabungan.nama}*${baru ? ' (tabungan baru)' : ''}`,
      barisTabungan(r.tabungan),
      r.tabungan.tercapai ? '🎉 Target tercapai!' : (r.tabungan.target ? `Kurang ${rupiah(r.tabungan.target - r.tabungan.terkumpul)} lagi` : null),
      '',
      `💰 Saldo total: *${rupiah(saldo)}*`,
      infoAkun(ak, uid),
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
  const ak = akunId();
  const r = db.tarikTabungan({ uid, id: b.id, jumlah: h.jumlah, pengirim: 'wa', akun_id: ak });
  if (!r.ok) return `🤔 ${r.alasan}`;
  return `💸 Tarik *${rupiah(r.jumlah)}* dari *${r.tabungan.nama}*\nSisa tabungan: ${rupiah(r.tabungan.terkumpul)}\n\n💰 Saldo total: *${rupiah(db.saldo(uid).saldo)}*\n${infoAkun(ak, uid)}`;
}

// ---------- Menunggu pilihan sumber dana ----------
const tungguAkun = new Map(); // `${uid}:${pengirim}` -> { teks, sampai }

function ringkasTabungan(tb, uid) {
  if (tb.jenis === 'tabungan-setor') return `🐷 Nabung *${rupiah(tb.jumlah)}* ke ${tb.nama}`;
  const b = db.cariTabungan(tb.nama, uid);
  return `💸 Tarik *${tb.jumlah == null ? rupiah(b?.terkumpul || 0) + ' (semua)' : rupiah(tb.jumlah)}* dari tabungan ${tb.nama}`;
}
function ringkasHutang(hh) {
  const j = hh.jumlah == null ? 'sampai lunas' : `*${rupiah(hh.jumlah)}*`;
  if (hh.jenis === 'hutang-baru') return hh.tipe === 'hutang' ? `📕 Pinjam ${j} dari ${hh.nama}` : `📗 Pinjamkan ${j} ke ${hh.nama}`;
  return hh.tipe === 'hutang' ? `📕 Bayar hutang ke ${hh.nama} ${j}` : `📗 ${hh.nama} membayar ${j}`;
}

function tanyaAkun(teks, ringkas, masuk, pengirim, uid) {
  tungguAkun.set(`${uid}:${pengirim}`, { teks, sampai: Date.now() + BATAS_TUNGGU });
  const list = db.daftarAkun(uid);
  return [
    masuk ? '💳 *Uangnya masuk ke mana?*' : '💳 *Pakai uang dari mana?*',
    ringkas,
    '',
    'Balas *nomornya* saja:',
    ...list.map((a, i) => `*${i + 1}.* ${IKON_AKUN[a.jenis]} ${a.nama}${a.utama ? ' _(utama)_' : ''}`),
    '',
    'Atau ketik nama lain, mis. *gopay* / *bri*. Ketik *batal* untuk membatalkan.',
    `_Lain kali bisa langsung: …${masuk ? ' ke bca' : ' pakai dana'}_`,
  ].join('\n');
}

function jawabAkun(teks, pengirim, uid) {
  const kunci = `${uid}:${pengirim}`;
  const t = tungguAkun.get(kunci);
  if (!t) return null;
  if (Date.now() > t.sampai) { tungguAkun.delete(kunci); return null; }
  const j = teks.trim().toLowerCase();
  if (/^(batal|cancel|gak jadi|ga jadi|nggak jadi|tidak jadi|gajadi)$/.test(j)) { tungguAkun.delete(kunci); return '❎ Dibatalkan, tidak ada yang dicatat.'; }
  const list = db.daftarAkun(uid);
  let nama = null;
  const no = j.match(/^(\d{1,2})\.?$/);
  if (no) nama = list[Number(no[1]) - 1]?.nama;
  if (!nama) {
    // Seluruh balasan berupa nama sumber dana: "bca", "pakai dana", "kas toko"
    const s = sebutAkun(/^(pakai|pake|via|dari|ke|lewat)\b/.test(j) ? teks.trim() : `via ${teks.trim()}`, uid);
    if (s.akun && !s.sisa.trim()) nama = s.akun.nama;
  }
  if (!nama) return null; // bukan jawaban → diproses seperti pesan biasa, pertanyaan tetap menunggu
  tungguAkun.delete(kunci);
  return prosesPesan(`${t.teks} via ${nama}`, pengirim, uid);
}

/** Mengembalikan teks balasan, atau null bila pesan bukan untuk bot. */
export function prosesPesan(teks, pengirim, uid) {
  const konfirmasi = prosesKonfirmasi(teks, pengirim, uid);
  if (konfirmasi) return konfirmasi;

  const jawaban = jawabAkun(teks, pengirim, uid);
  if (jawaban) return jawaban;

  const pindah = prosesTransfer(teks, pengirim, uid);
  if (pindah) return pindah;

  // Sumber dana yang disebut ("pakai dana", "ke bca", "gopay") dibaca & dibuang dulu dari kalimat.
  // Akunnya baru dibuat (bila belum ada) saat benar-benar ada transaksi yang dicatat.
  const { akun: sebut, sisa: kalimat } = sebutAkun(teks, uid);
  const akunId = () => (pastikanAkun(sebut, uid) || db.akunUtama(uid)).id;
  // Sumber dana wajib jelas: bila tidak disebut & user punya >1 sumber, tanya dulu
  const perluTanya = !sebut && db.daftarAkunPolos(uid).length > 1;

  const tb = uraiTabungan(kalimat);
  if (tb) {
    const gerak = tb.jenis === 'tabungan-setor' || (tb.jenis === 'tabungan-tarik' && tb.jumlah !== undefined && db.cariTabungan(tb.nama, uid));
    if (gerak && perluTanya) return tanyaAkun(teks, ringkasTabungan(tb, uid), tb.jenis === 'tabungan-tarik', pengirim, uid);
    return prosesTabungan(tb, uid, akunId);
  }

  const hh = uraiHutang(kalimat);
  if (hh) {
    const adaCatatan = hh.jenis === 'hutang-bayar' && db.hutangPerOrang(hh.tipe, uid).some((o) => o.nama.toLowerCase() === hh.nama.toLowerCase());
    const gerak = hh.jenis === 'hutang-baru' || (hh.jenis === 'hutang-bayar' && hh.jumlah !== undefined && adaCatatan);
    if (gerak && perluTanya) {
      const masuk = (hh.jenis === 'hutang-baru') === (hh.tipe === 'hutang'); // pinjam uang / piutang dibayar = uang masuk
      return tanyaAkun(teks, ringkasHutang(hh), masuk, pengirim, uid);
    }
    return prosesHutang(hh, pengirim, uid, akunId);
  }

  const hasil = uraiPesan(kalimat);
  if (!hasil) return null;

  if (hasil.jenis === 'transaksi') {
    if (perluTanya) {
      const ringkas = `${hasil.tipe === 'masuk' ? '🟢 Masuk' : '🔴 Keluar'} *${rupiah(hasil.jumlah)}* · ${hasil.keterangan}`;
      return tanyaAkun(teks, ringkas, hasil.tipe === 'masuk', pengirim, uid);
    }
    return balasTercatat(db.tambah({ uid, ...hasil, pengirim, dibuat: waktuMundur(hasil.tanggal), akun_id: akunId() }));
  }

  switch (hasil.nama) {
    case 'bantuan':
      return bantuan(hasil.topik);
    case 'saldo': {
      const s = db.saldo(uid);
      const akun = db.daftarAkun(uid);
      const rinci = akun.map((a) => `${IKON_AKUN[a.jenis]} ${a.nama}${a.utama ? ' _(utama)_' : ''}: *${rupiah(a.saldo)}*`).join('\n');
      return `💰 *Saldo total: ${rupiah(s.saldo)}*\n\n${rinci}` + barisHutang(uid) +
        '\n\nPindah saldo: *pindah 100rb dari bca ke dana* · *tarik tunai 500rb bca*';
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
      return teksLap + `\n\n💰 Saldo total: *${rupiah(s.saldo)}*` + barisHutang(uid);
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
      return `🗑️ Dihapus: ${t.tipe === 'masuk' ? '+' : '-'}${rupiah(t.jumlah)} ${t.keterangan}${ekstra}\n\n💰 Saldo total: *${rupiah(db.saldo(uid).saldo)}*`;
    }
  }
  return null;
}
