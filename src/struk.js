// Membaca foto struk / nota / bukti transfer dengan Claude (vision + structured output).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { DAFTAR_KATEGORI } from './parser.js';
import { bacaStrukOCR } from './ocr.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const HasilStruk = z.object({
  adalah_struk: z.boolean().describe('true jika gambar berisi struk, nota, kuitansi, invoice, atau bukti transfer/pembayaran'),
  tipe: z.enum(['keluar', 'masuk']).describe('keluar = belanja/pembayaran oleh pemilik; masuk = pemilik menerima uang (mis. bukti transfer masuk)'),
  total: z.number().describe('Total akhir yang dibayar/diterima dalam rupiah, bilangan bulat, sudah termasuk pajak & diskon. 0 jika tidak terbaca'),
  toko: z.string().describe('Nama toko/penjual/pengirim, string kosong jika tidak ada'),
  tanggal: z.string().describe('Tanggal transaksi format YYYY-MM-DD, string kosong jika tidak terbaca'),
  ringkasan: z.string().describe('Keterangan singkat 2-6 kata bahasa Indonesia, mis. "belanja bulanan Indomaret"'),
  kategori: z.enum(DAFTAR_KATEGORI),
  yakin: z.boolean().describe('false jika angka total buram/terpotong/ragu'),
  metode_bayar: z.string().describe('Cara bayar yang tertulis: nama e-wallet (DANA, GoPay, OVO, ShopeePay, LinkAja), nama bank (BCA, BRI, BNI, Mandiri, BSI, …) untuk debit/transfer/QRIS bank, atau "Tunai". String kosong jika tidak tertulis'),
});

const PROMPT = `Kamu membantu aplikasi pencatatan keuangan pribadi di Indonesia.
Baca gambar ini. Jika berisi struk belanja, nota, kuitansi, invoice, atau bukti transfer/pembayaran, ambil datanya.
- "total" adalah jumlah akhir yang benar-benar dibayar (TOTAL / GRAND TOTAL / TOTAL BAYAR), bukan subtotal, bukan uang tunai yang diserahkan, bukan kembalian.
- Format angka Indonesia: titik adalah pemisah ribuan ("87.500" = 87500).
- Pilih kategori yang paling cocok dari daftar.
- "metode_bayar": cari tulisan cara bayar (TUNAI/CASH, DEBIT BCA, QRIS DANA, GOPAY, OVO, SHOPEEPAY, dsb.). Untuk bukti transfer, isi dengan bank/e-wallet penerima jika uang masuk, atau pengirim jika uang keluar. Jangan menebak bila tidak tertulis.
Jika gambar bukan struk/bukti pembayaran, set adalah_struk=false dan isi field lain seadanya.`;

let client;
function klien() {
  client ??= new Anthropic(); // kunci dibaca dari ANTHROPIC_API_KEY
  return client;
}

/** Benar jika ada kunci API di lingkungan. */
export const aiAktif = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/**
 * Pilih cara membaca struk: Claude bila kunci API dipasang (lebih akurat),
 * selain itu OCR lokal gratis. Bila Claude gagal, OCR dipakai sebagai cadangan.
 */
export async function bacaStrukOtomatis(gambar, mime, caption = '') {
  if (aiAktif()) {
    const hasil = await bacaStruk(gambar, mime, caption);
    if (hasil.ok) return hasil;
    console.error('Claude gagal membaca struk, memakai OCR:', hasil.alasan);
  }
  return bacaStrukOCR(gambar);
}

/**
 * @param {Buffer} gambar
 * @param {string} mime  mis. 'image/jpeg'
 * @param {string} [caption] teks yang dikirim bersama foto
 * @returns {Promise<{ok:true, data:z.infer<typeof HasilStruk>} | {ok:false, alasan:string}>}
 */
export async function bacaStruk(gambar, mime = 'image/jpeg', caption = '') {
  const media = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ? mime : 'image/jpeg';
  try {
    const res = await klien().beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // jika model menolak, API otomatis mencoba model cadangan
      output_config: { effort: 'low', format: betaZodOutputFormat(HasilStruk) },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: gambar.toString('base64') } },
          { type: 'text', text: PROMPT + (caption ? `\n\nCatatan dari pengguna: "${caption.slice(0, 200)}"` : '') },
        ],
      }],
    });
    if (res.stop_reason === 'refusal') return { ok: false, alasan: 'AI tidak bisa memproses gambar ini.' };
    if (!res.parsed_output) return { ok: false, alasan: 'AI tidak memberi jawaban yang bisa dibaca.' };
    return { ok: true, data: res.parsed_output };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, alasan: 'Kunci API Anthropic tidak valid.' };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, alasan: 'Kunci API tidak punya akses (cek saldo/izin akun Anthropic).' };
    if (e instanceof Anthropic.RateLimitError) return { ok: false, alasan: 'Terlalu banyak permintaan, coba lagi sebentar.' };
    if (e instanceof Anthropic.BadRequestError) return { ok: false, alasan: 'Gambar tidak bisa diproses: ' + e.message };
    if (e instanceof Anthropic.APIError) return { ok: false, alasan: `Layanan AI error (${e.status ?? 'jaringan'}).` };
    return { ok: false, alasan: 'Gagal membaca struk: ' + e.message };
  }
}
