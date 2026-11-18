// Koneksi WhatsApp lewat scan QR (seperti WhatsApp Web), memakai Baileys.
import * as Baileys from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import { join, dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prosesPesan, balasStruk } from './balasan.js';
import { bacaStruk, aiAktif } from './struk.js';

const B = Baileys.default?.makeWASocket ? Baileys.default : Baileys;
const makeWASocket = B.makeWASocket || B.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = B;

const AUTH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sesi-wa');

// Nomor lain (selain nomor bot sendiri) yang boleh mencatat, mis. "6281234567890,6285..."
const NOMOR_DIIZINKAN = (process.env.NOMOR_DIIZINKAN || '')
  .split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);

export const status = { terhubung: false, nomor: null, qr: null };

const nomorDari = (jid = '') => jid.split('@')[0].split(':')[0];

export async function mulaiBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* pakai bawaan */ }

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['Catat Keuangan', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });
  const terkirim = new Set(); // id pesan balasan bot, agar tidak diproses ulang

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      status.qr = await QRCode.toDataURL(qr);
      console.log('\n📱 Scan QR ini dengan WhatsApp (Perangkat tertaut → Tautkan perangkat):');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('   ...atau buka dashboard di browser untuk scan QR yang lebih jelas.\n');
    }
    if (connection === 'open') {
      status.terhubung = true;
      status.qr = null;
      status.nomor = nomorDari(sock.user?.id);
      console.log(`✅ WhatsApp terhubung sebagai ${status.nomor}`);
      console.log('   Kirim "bantuan" ke chat dirimu sendiri (Message yourself) untuk mulai.');
    }
    if (connection === 'close') {
      status.terhubung = false;
      const kode = lastDisconnect?.error?.output?.statusCode;
      if (kode === DisconnectReason.loggedOut) {
        // Sesi lama tidak berlaku lagi: hapus lalu mulai ulang supaya QR baru muncul.
        console.log('⚠️  Keluar dari WhatsApp (perangkat dilepas). Menyiapkan QR baru...');
        status.nomor = null;
        rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(() => mulaiBot().catch(console.error), 2000);
      } else {
        console.log('🔄 Koneksi terputus, menyambung ulang...');
        setTimeout(() => mulaiBot().catch(console.error), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid || '';
        if (!msg.message || terkirim.has(msg.key.id)) continue;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // abaikan grup & status

        // Foto dikirim biasa, atau sebagai dokumen bergambar
        const doc = msg.message.documentMessage;
        const foto = msg.message.imageMessage || (doc?.mimetype?.startsWith('image/') ? doc : null);
        const teks = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || foto?.caption
          || '';
        if (!teks && !foto) continue;

        const diriSendiri = [sock.user?.id, sock.user?.lid].filter(Boolean).map(nomorDari);
        const chatDiri = diriSendiri.includes(nomorDari(jid));
        const pengirimNomor = msg.key.fromMe ? status.nomor : nomorDari(msg.key.senderPn || jid);

        // Boleh: pesan di chat diri sendiri, atau dari nomor yang diizinkan.
        const boleh = (msg.key.fromMe && chatDiri) || (!msg.key.fromMe && NOMOR_DIIZINKAN.includes(pengirimNomor));
        if (!boleh) continue;

        const balas = async (text) => {
          const kirim = await sock.sendMessage(jid, { text }, { quoted: msg });
          if (kirim?.key?.id) terkirim.add(kirim.key.id);
        };

        // Caption berisi perintah/transaksi lengkap (mis. "keluar 50rb makan") → catat langsung tanpa AI
        const dariTeks = teks ? prosesPesan(teks, pengirimNomor) : null;
        if (dariTeks) { await balas(dariTeks); continue; }
        if (!foto) continue;

        if (!aiAktif()) {
          await balas('📷 Fitur baca struk belum aktif: kunci API Anthropic belum dipasang (lihat README, bagian "Foto struk").\n\nCatat manual dulu, mis. *keluar 50rb belanja*.');
          continue;
        }
        await balas('🔎 Sedang membaca struk...');
        const gambar = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        const hasil = await bacaStruk(gambar, foto.mimetype, teks);
        await balas(balasStruk(hasil, pengirimNomor, teks));
      } catch (e) {
        console.error('Gagal memproses pesan:', e.message);
      }
    }
  });

  return sock;
}
