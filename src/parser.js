// Mengubah pesan chat bahasa Indonesia menjadi perintah / transaksi.

const KATA_MASUK = ['masuk', 'pemasukan', 'terima', 'dapat', 'income', 'in'];
const KATA_KELUAR = ['keluar', 'pengeluaran', 'bayar', 'beli', 'belanja', 'out'];

const KATEGORI = [
  ['Makan & Minum', ['makan', 'minum', 'kopi', 'sarapan', 'nasi', 'bakso', 'jajan', 'snack', 'resto', 'warung']],
  ['Transportasi', ['bensin', 'bbm', 'ojek', 'ojol', 'gojek', 'grab', 'parkir', 'tol', 'angkot', 'tiket', 'servis motor']],
  ['Belanja', ['belanja', 'sayur', 'pasar', 'sabun', 'beras', 'minyak', 'baju', 'sepatu', 'indomaret', 'alfamart']],
  ['Tagihan', ['listrik', 'pln', 'air', 'pdam', 'wifi', 'internet', 'pulsa', 'kuota', 'token', 'cicilan', 'kredit', 'sewa', 'kos', 'bpjs']],
  ['Kesehatan', ['obat', 'dokter', 'apotek', 'klinik', 'rumah sakit']],
  ['Pendidikan', ['sekolah', 'spp', 'buku', 'kursus', 'les']],
  ['Sosial & Ibadah', ['sedekah', 'infaq', 'infak', 'zakat', 'donasi', 'kondangan', 'sumbangan', 'wakaf']],
  ['Gaji', ['gaji', 'upah', 'honor', 'thr', 'bonus']],
  ['Usaha', ['jual', 'jualan', 'penjualan', 'omzet', 'order', 'pesanan', 'laba']],
];

export const DAFTAR_KATEGORI = [...KATEGORI.map(([nama]) => nama), 'Pemasukan Lain', 'Lainnya'];

const SATUAN ={ rb: 1e3, ribu: 1e3, k: 1e3, jt: 1e6, juta: 1e6, m: 1e6 };
const RE_JUMLAH = /(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)\s*(rb|ribu|k|jt|juta|m)?(?![a-z])/i;

/** "25rb" → 25000, "1,5jt" → 1500000, "25.000" → 25000. Mengembalikan null bila tidak valid. */
export function bacaJumlah(teks) {
  const m = teks.match(RE_JUMLAH);
  if (!m) return null;
  let [, angka, satuan] = m;
  let nilai;
  if (satuan) {
    const pemisah = angka.match(/[.,]/g) || [];
    // "1,5jt" / "1.5jt" → desimal; "1.500rb" → ribuan
    nilai = pemisah.length === 1 && /[.,]\d{1,2}$/.test(angka)
      ? parseFloat(angka.replace(',', '.'))
      : parseFloat(angka.replace(/[.,]/g, ''));
    nilai *= SATUAN[satuan.toLowerCase()];
  } else {
    nilai = parseFloat(angka.replace(/[.,]/g, ''));
  }
  nilai = Math.round(nilai);
  return nilai > 0 ? { nilai, cocok: m[0] } : null;
}

export function tebakKategori(keterangan, tipe) {
  const t = ` ${keterangan.toLowerCase()} `;
  for (const [nama, kata] of KATEGORI) {
    if (kata.some((k) => t.includes(k))) return nama;
  }
  return tipe === 'masuk' ? 'Pemasukan Lain' : 'Lainnya';
}

// ======================= Hutang & piutang =======================

const GELAR = '(?:pak|bu|bang|mas|mbak|mba|kak|om|tante|teh|a|bude|pakde|bi|mang|cak|ning)';
const RE_TEMPO = /\b(?:jatuh\s+tempo|tempo|jt\s+tempo|deadline)\s+(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/i;
const judul = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** "25/12" → '2026-12-25' (tahun depan jika tanggal itu sudah lewat). */
export function bacaTempo(teks, sekarang = new Date()) {
  const m = teks.match(RE_TEMPO);
  if (!m) return { tempo: null, sisa: teks };
  const [, d, b, t] = m.map(Number);
  let tahun = t ? (t < 100 ? 2000 + t : t) : sekarang.getFullYear();
  const hariIni = new Date(sekarang.getFullYear(), sekarang.getMonth(), sekarang.getDate());
  if (!t && new Date(tahun, b - 1, d) < hariIni) tahun++;
  const tgl = new Date(tahun, b - 1, d);
  if (tgl.getMonth() !== b - 1 || b < 1 || b > 12) return { tempo: null, sisa: teks.replace(m[0], ' ') };
  const iso = `${tahun}-${String(b).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { tempo: iso, sisa: teks.replace(m[0], ' ') };
}

/** Memisahkan nama orang & keterangan. Nama diambil setelah ke/dari/sama, atau kata pertama. */
function pisahNama(teks) {
  const t = teks.replace(/\s+/g, ' ').trim();
  const reNama = `(${GELAR}\\s+)?([\\p{L}][\\p{L}'-]*)`;
  let m = t.match(new RegExp(`(?:^|\\s)(?:ke|dari|sama|ama|kepada|pada)\\s+${reNama}`, 'iu'));
  if (!m) m = t.match(new RegExp(`^${reNama}`, 'iu'));
  if (!m) return { nama: '', keterangan: t };
  const nama = judul(((m[1] || '') + m[2]).trim().toLowerCase());
  const keterangan = t.replace(m[0], ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(untuk|buat|utk|karena|krn)\s+/i, '');
  return { nama, keterangan };
}

/**
 * Hasil:
 *  { jenis: 'hutang-baru', tipe: 'hutang'|'piutang', nama, jumlah, keterangan, tempo }
 *  { jenis: 'hutang-bayar', tipe, nama, jumlah: number|null (null = lunasi) }
 *  { jenis: 'perintah', nama: 'daftar-hutang', filter: 'hutang'|'piutang'|null }
 */
export function uraiHutang(pesan) {
  const teks = (pesan || '').trim().replace(/\s+/g, ' ').replace(/^[/!.#]/, '');
  const k = teks.toLowerCase().replace(/\butang\b/g, 'hutang');

  const daftar = k.match(/^(?:daftar |cek |lihat )?(hutang|piutang|hutang ?piutang|hutang & piutang|hutang dan piutang)$/);
  if (daftar) {
    const f = daftar[1] === 'hutang' ? 'hutang' : daftar[1] === 'piutang' ? 'piutang' : null;
    return { jenis: 'perintah', nama: 'daftar-hutang', filter: f };
  }

  // Bayar hutang / terima piutang
  let bayar = k.match(/^(bayar|cicil|lunasi|lunas) hutang (.+)$/);
  let tipe = 'hutang';
  if (!bayar) { bayar = k.match(/^(terima|lunasi|lunas|tagih) piutang (.+)$/); tipe = 'piutang'; }
  if (!bayar) {
    const m = k.match(/^piutang (.+?) (?:dibayar|bayar|lunas|nyicil|cicil)(.*)$/);
    if (m) { bayar = [null, /lunas/.test(k) && !bacaJumlah(m[2]) ? 'lunas' : 'bayar', `${m[1]} ${m[2]}`]; tipe = 'piutang'; }
  }
  if (bayar) {
    let sisa = bayar[2];
    const lunas = /\blunas\b/.test(sisa) || ['lunasi', 'lunas'].includes(bayar[1]);
    sisa = sisa.replace(/\blunas\b/g, ' ');
    const j = bacaJumlah(sisa);
    if (j) sisa = sisa.replace(j.cocok, ' ');
    const { nama } = pisahNama(sisa);
    if (!nama) return null;
    if (!j && !lunas) return { jenis: 'hutang-bayar', tipe, nama, jumlah: undefined }; // minta jumlah
    return { jenis: 'hutang-bayar', tipe, nama, jumlah: j && !(lunas && !j) ? j.nilai : null };
  }

  // Hutang / piutang baru
  let baru = k.match(/^(hutang|pinjam|minjam|ngutang) (.+)$/);
  tipe = 'hutang';
  if (!baru) { baru = k.match(/^(piutang|pinjamkan|pinjami|minjemin|ngutangin|kasih pinjam|meminjamkan) (.+)$/); tipe = 'piutang'; }
  if (!baru) return null;
  // Ambil dari teks asli (bukan huruf kecil) supaya keterangan tetap rapi
  const asli = teks.split(' ').slice(baru[1].split(' ').length).join(' ');
  const { tempo, sisa: tanpaTempo } = bacaTempo(asli);
  const j = bacaJumlah(tanpaTempo);
  if (!j) return null;
  const { nama, keterangan } = pisahNama(tanpaTempo.replace(j.cocok, ' '));
  if (!nama) return null;
  return { jenis: 'hutang-baru', tipe, nama, jumlah: j.nilai, keterangan, tempo };
}

// ======================= Tabungan =======================

function namaTabungan(teks) {
  return judul(teks.replace(/\s+/g, ' ').trim()
    .replace(/^(ke|untuk|buat|utk|di|dari|tabungan|celengan)\s+/i, '')
    .replace(/^(ke|untuk|buat|utk|di|dari)\s+/i, '').trim().toLowerCase());
}

/**
 * Hasil:
 *  { jenis: 'tabungan-daftar' }
 *  { jenis: 'tabungan-setor', nama, jumlah }
 *  { jenis: 'tabungan-tarik', nama, jumlah: number|null (null = semua) }
 *  { jenis: 'tabungan-target', nama, target }
 */
export function uraiTabungan(pesan) {
  const teks = (pesan || '').trim().replace(/\s+/g, ' ').replace(/^[/!.#]/, '');
  const k = teks.toLowerCase();
  if (/^(tabungan|celengan|tabunganku|daftar tabungan|cek tabungan|lihat tabungan)$/.test(k)) return { jenis: 'tabungan-daftar' };

  let m = k.match(/^(?:tarik|ambil)(?: uang)? (?:tabungan|celengan) ?(.*)$/);
  if (m) {
    let sisa = m[1];
    const semua = /\b(semua|semuanya|habis)\b/.test(sisa);
    sisa = sisa.replace(/\b(semua|semuanya|habis)\b/g, ' ');
    const j = bacaJumlah(sisa);
    if (j) sisa = sisa.replace(j.cocok, ' ');
    if (!j && !semua) return { jenis: 'tabungan-tarik', nama: namaTabungan(sisa), jumlah: undefined };
    return { jenis: 'tabungan-tarik', nama: namaTabungan(sisa), jumlah: j ? j.nilai : null };
  }

  m = k.match(/^target (?:tabungan |celengan )?(.+)$/);
  if (m) {
    const j = bacaJumlah(m[1]);
    if (!j) return null;
    return { jenis: 'tabungan-target', nama: namaTabungan(m[1].replace(j.cocok, ' ')), target: j.nilai };
  }

  m = k.match(/^(?:nabung|menabung|tabung|setor tabungan|setor celengan|isi tabungan|isi celengan) (.+)$/);
  if (m) {
    const asli = teks.split(' ').slice(k.startsWith('setor ') || k.startsWith('isi ') ? 2 : 1).join(' ');
    const j = bacaJumlah(asli);
    if (!j) return null;
    return { jenis: 'tabungan-setor', nama: namaTabungan(asli.replace(j.cocok, ' ')) || 'Tabungan', jumlah: j.nilai };
  }
  return null;
}

/**
 * Hasil:
 *  { jenis: 'transaksi', tipe, jumlah, keterangan, kategori }
 *  { jenis: 'perintah', nama: 'saldo'|'laporan'|'riwayat'|'hapus'|'bantuan', periode? }
 *  null bila pesan tidak dikenali
 */
export function uraiPesan(pesan) {
  const teks = (pesan || '').trim().replace(/\s+/g, ' ');
  if (!teks) return null;
  const kecil = teks.toLowerCase().replace(/^[/!.#]/, '');

  // ---- Perintah ----
  if (/^(saldo|sisa|cek saldo|saldo terakhir)$/.test(kecil)) return { jenis: 'perintah', nama: 'saldo' };
  if (/^(bantuan|help|menu|cara|\?)$/.test(kecil)) return { jenis: 'perintah', nama: 'bantuan' };
  if (/^(riwayat|histori|history|mutasi)$/.test(kecil)) return { jenis: 'perintah', nama: 'riwayat' };
  if (/^(hapus|batal|undo|hapus terakhir)$/.test(kecil)) return { jenis: 'perintah', nama: 'hapus' };
  const lap = kecil.match(/^(?:laporan|rekap|ringkasan)?\s*(hari ini|kemarin|minggu ini|bulan ini|bulan lalu)?$/);
  if (lap && (kecil.startsWith('laporan') || kecil.startsWith('rekap') || kecil.startsWith('ringkasan') || lap[1])) {
    return { jenis: 'perintah', nama: 'laporan', periode: lap[1] || 'bulan ini' };
  }

  // ---- Transaksi ----
  let tipe = null;
  let sisa = teks;
  const tanda = teks.match(/^([+-])\s*/);
  if (tanda) {
    tipe = tanda[1] === '+' ? 'masuk' : 'keluar';
    sisa = teks.slice(tanda[0].length);
  } else {
    const kataPertama = kecil.split(' ')[0];
    if (KATA_MASUK.includes(kataPertama)) tipe = 'masuk';
    else if (KATA_KELUAR.includes(kataPertama)) tipe = 'keluar';
    if (tipe) {
      // "beli"/"bayar"/"belanja" ikut jadi keterangan supaya tetap bermakna
      sisa = ['beli', 'bayar', 'belanja'].includes(kataPertama) ? teks : teks.slice(kataPertama.length);
    }
  }
  if (!tipe) return null;

  const jumlah = bacaJumlah(sisa);
  if (!jumlah) return null;

  const keterangan = sisa.replace(jumlah.cocok, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(untuk|buat|utk|dari)\s+/i, '') || (tipe === 'masuk' ? 'Pemasukan' : 'Pengeluaran');

  return {
    jenis: 'transaksi',
    tipe,
    jumlah: jumlah.nilai,
    keterangan,
    kategori: tebakKategori(keterangan, tipe),
  };
}
