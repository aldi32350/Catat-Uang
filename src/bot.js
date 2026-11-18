// Koneksi WhatsApp lewat scan QR (seperti WhatsApp Web), memakai Baileys.
// Satu user bisa menautkan BANYAK nomor. Tiap nomor = satu "perangkat" dengan sesi sendiri
// di data/sesi-wa/p<idPerangkat>/, dan semuanya mencatat ke buku milik user tersebut.
import * as Baileys from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { join, dirname } from 'node:path';
import { existsSync, readdirSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { prosesPesan, balasStruk } from './balasan.js';
import { bacaStrukOtomatis, aiAktif } from './struk.js';

const B = Baileys.default?.makeWASocket ? Baileys.default : Baileys;
const makeWASocket = B.makeWASocket || B.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = B;

const SESI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sesi-wa');
const dirPerangkat = (pid) => join(SESI_DIR, `p${pid}`);
const adaSesi = (pid) => existsSync(join(dirPerangkat(pid), 'creds.json'));
const nomorDari = (jid = '') => jid.split('@')[0].split(':')[0];
const MAKS_QR = 6; // ±2 menit menunggu scan, lalu berhenti sampai user menekan "Tampilkan QR" lagi

/** pid -> { sock, status, berhenti, qrKe, terkirim } */
const bots = new Map();

/** Status satu nomor WhatsApp. */
export function statusPerangkat(pid) {
  const p = db.ambilPerangkat(pid);
  const b = bots.get(pid);
  const dasar = { id: pid, nomor: p?.nomor || null };
  if (b) return { ...dasar, ...b.status, nomor: b.status.nomor || dasar.nomor };
  return { ...dasar, status: adaSesi(pid) ? 'menyambung' : 'putus', qr: null };
}

/** Semua nomor WhatsApp milik user. */
export const statusWA = (uid) => db.daftarPerangkat(uid).map((p) => statusPerangkat(p.id));

/**
 * Memindahkan sesi dari versi lama ke format per-perangkat:
 *  - data/sesi-wa/creds.json        (versi 1 user)    → milik uidAdmin
 *  - data/sesi-wa/<userId>/creds.json (versi 1 nomor/user)
 */
export function pindahkanSesiLama(uidAdmin) {
  if (!existsSync(SESI_DIR)) return false;
  let pindah = false;
  if (uidAdmin && existsSync(join(SESI_DIR, 'creds.json'))) {
    const p = db.buatPerangkat(uidAdmin);
    const sementara = SESI_DIR + '-lama';
    renameSync(SESI_DIR, sementara);
    mkdirSync(SESI_DIR, { recursive: true });
    renameSync(sementara, dirPerangkat(p.id));
    pindah = true;
  }
  for (const nama of readdirSync(SESI_DIR)) {
    if (!/^\d+$/.test(nama) || !existsSync(join(SESI_DIR, nama, 'creds.json'))) continue;
    const uid = Number(nama);
    if (!db.ambilUser(uid)) continue;
    const p = db.buatPerangkat(uid);
    renameSync(join(SESI_DIR, nama), dirPerangkat(p.id));
    pindah = true;
  }
  return pindah;
}

/** Saat server menyala: sambungkan ulang semua nomor yang pernah tertaut. */
export function mulaiSemua() {
  pindahkanSesiLama(null);
  for (const p of db.semuaPerangkat()) {
    if (!db.ambilUser(p.user_id)) continue;
    if (adaSesi(p.id)) hubungkan(p.id).catch((e) => console.error(`WA #${p.id}:`, e.message));
  }
}

/** Tambah nomor baru untuk user → langsung siapkan QR. */
export async function tambahNomor(uid) {
  // Jangan menumpuk: pakai slot kosong yang belum pernah tertaut bila ada
  const kosong = db.daftarPerangkat(uid).find((p) => !p.nomor && !adaSesi(p.id) && !bots.has(p.id));
  const p = kosong || db.buatPerangkat(uid);
  return hubungkan(p.id);
}

/** Mulai koneksi satu nomor (menampilkan QR bila belum tertaut). */
export async function hubungkan(pid) {
  const lama = bots.get(pid);
  if (lama && ['terhubung', 'menyambung', 'qr'].includes(lama.status.status)) return statusPerangkat(pid);
  const perangkat = db.ambilPerangkat(pid);
  if (!perangkat) throw new Error('Perangkat tidak ditemukan');

  const { state, saveCreds } = await useMultiFileAuthState(dirPerangkat(pid));
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* pakai bawaan */ }

  const bot = { sock: null, status: { status: 'menyambung', qr: null }, berhenti: false, qrKe: 0, terkirim: new Set() };
  bots.set(pid, bot);
  const sock = makeWASocket({
    auth: state, version,
    logger: pino({ level: 'silent' }),
    browser: ['Catat Uang', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });
  bot.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (bot.berhenti) return;
    if (qr) {
      bot.qrKe++;
      if (bot.qrKe > MAKS_QR) { // tidak di-scan: hentikan supaya tidak berputar terus
        bot.berhenti = true;
        bot.status = { status: 'putus', qr: null, pesan: 'QR kedaluwarsa. Tekan "Tampilkan QR" untuk mencoba lagi.' };
        try { sock.end(undefined); } catch { /* abaikan */ }
        if (!state.creds.registered) rmSync(dirPerangkat(pid), { recursive: true, force: true });
        return;
      }
      bot.status = { status: 'qr', qr: await QRCode.toDataURL(qr) };
    }
    if (connection === 'open') {
      const nomor = nomorDari(sock.user?.id);
      // Nomor yang sama tidak boleh tertaut dua kali (pesan akan tercatat ganda)
      const kembar = db.semuaPerangkat().find((p) => p.id !== pid && p.nomor === nomor && bots.get(p.id)?.status.status === 'terhubung');
      if (kembar) {
        console.log(`⚠️  WA #${pid}: nomor ${nomor} sudah tertaut di perangkat #${kembar.id}, dilepas.`);
        bot.berhenti = true;
        try { await sock.logout(); } catch { /* abaikan */ }
        rmSync(dirPerangkat(pid), { recursive: true, force: true });
        bot.status = { status: 'putus', qr: null, pesan: `Nomor ${nomor} sudah tertaut sebelumnya. Pakai nomor lain.` };
        return;
      }
      bot.qrKe = 0;
      db.setNomorPerangkat(pid, nomor);
      bot.status = { status: 'terhubung', nomor, qr: null };
      console.log(`✅ WhatsApp #${pid} (user ${perangkat.user_id}) terhubung sebagai ${nomor}`);
    }
    if (connection === 'close') {
      const kode = lastDisconnect?.error?.output?.statusCode;
      if (kode === DisconnectReason.loggedOut) {
        // Perangkat dilepas dari HP: sesi tidak berlaku lagi
        console.log(`⚠️  WhatsApp #${pid} keluar (perangkat dilepas dari HP).`);
        bot.berhenti = true;
        bot.status = { status: 'putus', qr: null, pesan: 'Terputus dari HP. Tekan "Tampilkan QR" untuk scan ulang.' };
        rmSync(dirPerangkat(pid), { recursive: true, force: true });
      } else {
        bots.delete(pid);
        setTimeout(() => hubungkan(pid).catch(console.error), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) prosesMasuk(pid, bot, msg).catch((e) => console.error(`Pesan WA #${pid}:`, e.message));
  });
  return statusPerangkat(pid);
}

/** Putuskan & hapus satu nomor: perangkat dilepas dari HP, sesi & datanya dihapus. */
export async function hapusNomor(pid) {
  const bot = bots.get(pid);
  if (bot) {
    bot.berhenti = true;
    try {
      if (bot.status.status === 'terhubung') await bot.sock.logout();
      else bot.sock.end(undefined);
    } catch { /* tetap lanjut */ }
    bots.delete(pid);
  }
  rmSync(dirPerangkat(pid), { recursive: true, force: true });
  db.hapusPerangkat(pid);
}

/** Putuskan semua nomor milik user (mis. saat user dihapus). */
export async function hapusSemuaNomor(uid) {
  for (const p of db.daftarPerangkat(uid)) await hapusNomor(p.id);
}

async function prosesMasuk(pid, bot, msg) {
  const sock = bot.sock;
  const jid = msg.key.remoteJid || '';
  if (!msg.message || bot.terkirim.has(msg.key.id)) return;
  if (!msg.key.fromMe) return; // hanya pesan yang kamu kirim sendiri…
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;

  // …di chat ke diri sendiri ("Message yourself")
  const diriSendiri = [sock.user?.id, sock.user?.lid].filter(Boolean).map(nomorDari);
  if (!diriSendiri.includes(nomorDari(jid))) return;

  const perangkat = db.ambilPerangkat(pid);
  if (!perangkat || !db.ambilUser(perangkat.user_id)) return;
  const uid = perangkat.user_id;
  const pengirim = bot.status.nomor || nomorDari(sock.user?.id);

  const doc = msg.message.documentMessage;
  const foto = msg.message.imageMessage || (doc?.mimetype?.startsWith('image/') ? doc : null);
  const teks = msg.message.conversation || msg.message.extendedTextMessage?.text || foto?.caption || '';
  if (!teks && !foto) return;

  const balas = async (text) => {
    const kirim = await sock.sendMessage(jid, { text }, { quoted: msg });
    if (kirim?.key?.id) bot.terkirim.add(kirim.key.id);
  };

  // Caption berisi perintah/transaksi lengkap (mis. "keluar 50rb makan") → catat langsung
  const dariTeks = teks ? prosesPesan(teks, pengirim, uid) : null;
  if (dariTeks) return balas(dariTeks);
  if (!foto) return;

  await balas(aiAktif() ? '🔎 Sedang membaca struk...' : '🔎 Sedang membaca struk (OCR, ±10–30 detik)...');
  const gambar = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
  const hasil = await bacaStrukOtomatis(gambar, foto.mimetype, teks);
  await balas(balasStruk(hasil, pengirim, teks, uid));
}
