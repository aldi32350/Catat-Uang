// Koneksi WhatsApp per user lewat scan QR (seperti WhatsApp Web), memakai Baileys.
// Setiap user punya sesi sendiri di data/sesi-wa/<userId>/ dan mencatat ke bukunya sendiri.
import * as Baileys from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { join, dirname } from 'node:path';
import { existsSync, readdirSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { prosesPesan, balasStruk } from './balasan.js';
import { bacaStruk, aiAktif } from './struk.js';

const B = Baileys.default?.makeWASocket ? Baileys.default : Baileys;
const makeWASocket = B.makeWASocket || B.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = B;

const SESI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sesi-wa');
const dirUser = (uid) => join(SESI_DIR, String(uid));
const nomorDari = (jid = '') => jid.split('@')[0].split(':')[0];
const MAKS_QR = 6; // ±2 menit menunggu scan, lalu berhenti sampai user menekan "Hubungkan" lagi

/** uid -> { sock, status, berhenti } */
const bots = new Map();

/** Status WhatsApp milik satu user, untuk dashboard. */
export function statusWA(uid) {
  const b = bots.get(uid);
  if (!b) return { status: existsSync(join(dirUser(uid), 'creds.json')) ? 'menyambung' : 'putus', nomor: null, qr: null };
  return { ...b.status };
}

/** Sesi lama (sebelum ada fitur multi-user) dipindah ke folder milik admin pertama. */
export function pindahkanSesiLama(uid) {
  if (!existsSync(join(SESI_DIR, 'creds.json'))) return false;
  const sementara = SESI_DIR + '-lama';
  renameSync(SESI_DIR, sementara);
  mkdirSync(SESI_DIR, { recursive: true });
  renameSync(sementara, dirUser(uid));
  return true;
}

/** Saat server menyala: sambungkan ulang semua user yang pernah menautkan WhatsApp. */
export function mulaiSemua() {
  if (!existsSync(SESI_DIR)) return;
  for (const nama of readdirSync(SESI_DIR)) {
    const uid = Number(nama);
    if (uid && db.ambilUser(uid) && existsSync(join(dirUser(uid), 'creds.json'))) {
      hubungkan(uid).catch((e) => console.error(`WA user ${uid}:`, e.message));
    }
  }
}

/** Mulai koneksi (menampilkan QR bila belum tertaut). */
export async function hubungkan(uid) {
  const lama = bots.get(uid);
  if (lama && ['terhubung', 'menyambung', 'qr'].includes(lama.status.status)) return statusWA(uid);

  const { state, saveCreds } = await useMultiFileAuthState(dirUser(uid));
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* pakai bawaan */ }

  const bot = { sock: null, status: { status: 'menyambung', nomor: null, qr: null }, berhenti: false, qrKe: 0, terkirim: new Set() };
  bots.set(uid, bot);
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
        bot.status = { status: 'putus', nomor: null, qr: null, pesan: 'QR kedaluwarsa. Tekan "Hubungkan" lagi.' };
        try { sock.end(undefined); } catch { /* abaikan */ }
        if (!state.creds.registered) rmSync(dirUser(uid), { recursive: true, force: true });
        return;
      }
      bot.status = { status: 'qr', nomor: null, qr: await QRCode.toDataURL(qr) };
    }
    if (connection === 'open') {
      bot.qrKe = 0;
      bot.status = { status: 'terhubung', nomor: nomorDari(sock.user?.id), qr: null };
      console.log(`✅ WhatsApp user ${uid} terhubung sebagai ${bot.status.nomor}`);
    }
    if (connection === 'close') {
      const kode = lastDisconnect?.error?.output?.statusCode;
      if (kode === DisconnectReason.loggedOut) {
        // Perangkat dilepas dari HP: sesi tidak berlaku lagi
        console.log(`⚠️  WhatsApp user ${uid} keluar (perangkat dilepas).`);
        bot.berhenti = true;
        bot.status = { status: 'putus', nomor: null, qr: null, pesan: 'WhatsApp terputus dari HP. Tekan "Hubungkan" untuk scan ulang.' };
        rmSync(dirUser(uid), { recursive: true, force: true });
      } else {
        bot.status = { ...bot.status, status: 'menyambung', qr: null };
        bots.delete(uid);
        setTimeout(() => hubungkan(uid).catch(console.error), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) prosesMasuk(uid, bot, msg).catch((e) => console.error(`Pesan user ${uid}:`, e.message));
  });
  return statusWA(uid);
}

/** Putuskan WhatsApp: perangkat dilepas dari HP dan sesi dihapus. */
export async function putuskan(uid) {
  const bot = bots.get(uid);
  if (bot) {
    bot.berhenti = true;
    try {
      if (bot.status.status === 'terhubung') await bot.sock.logout();
      else bot.sock.end(undefined);
    } catch { /* tetap lanjut hapus sesi */ }
    bots.delete(uid);
  }
  rmSync(dirUser(uid), { recursive: true, force: true });
  return statusWA(uid);
}

async function prosesMasuk(uid, bot, msg) {
  const sock = bot.sock;
  const jid = msg.key.remoteJid || '';
  if (!msg.message || bot.terkirim.has(msg.key.id)) return;
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return; // abaikan grup & status

  // Foto dikirim biasa, atau sebagai dokumen bergambar
  const doc = msg.message.documentMessage;
  const foto = msg.message.imageMessage || (doc?.mimetype?.startsWith('image/') ? doc : null);
  const teks = msg.message.conversation || msg.message.extendedTextMessage?.text || foto?.caption || '';
  if (!teks && !foto) return;

  const user = db.ambilUser(uid);
  if (!user) return;
  const diriSendiri = [sock.user?.id, sock.user?.lid].filter(Boolean).map(nomorDari);
  const chatDiri = diriSendiri.includes(nomorDari(jid));
  const pengirimNomor = msg.key.fromMe ? bot.status.nomor : nomorDari(msg.key.senderPn || jid);
  const nomorLain = user.nomor_lain ? user.nomor_lain.split(',') : [];

  // Boleh: pesan di chat diri sendiri, atau dari nomor lain yang diizinkan user ini.
  const boleh = (msg.key.fromMe && chatDiri) || (!msg.key.fromMe && nomorLain.includes(pengirimNomor));
  if (!boleh) return;

  const balas = async (text) => {
    const kirim = await sock.sendMessage(jid, { text }, { quoted: msg });
    if (kirim?.key?.id) bot.terkirim.add(kirim.key.id);
  };

  // Caption berisi perintah/transaksi lengkap (mis. "keluar 50rb makan") → catat langsung tanpa AI
  const dariTeks = teks ? prosesPesan(teks, pengirimNomor, uid) : null;
  if (dariTeks) return balas(dariTeks);
  if (!foto) return;

  if (!aiAktif()) {
    return balas('📷 Fitur baca struk belum aktif: kunci API Anthropic belum dipasang (lihat README, bagian "Foto struk").\n\nCatat manual dulu, mis. *keluar 50rb belanja*.');
  }
  await balas('🔎 Sedang membaca struk...');
  const gambar = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
  const hasil = await bacaStruk(gambar, foto.mimetype, teks);
  await balas(balasStruk(hasil, pengirimNomor, teks, uid));
}
