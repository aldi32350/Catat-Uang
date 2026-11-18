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

const SATUAN = { rb: 1e3, ribu: 1e3, k: 1e3, jt: 1e6, juta: 1e6, m: 1e6 };
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
