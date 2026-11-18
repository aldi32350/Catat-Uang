import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Baca pengaturan dari file .env (mis. ANTHROPIC_API_KEY) bila ada.
try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env')); } catch { /* tidak ada .env */ }

const { mulaiWeb } = await import('./web.js');

const argPort = process.argv.find((a) => a.startsWith('--port='))?.slice(7);
const PORT = Number(argPort || process.env.PORT || 3000);
// Default hanya bisa dibuka dari komputer ini. Set HOST=0.0.0.0 agar bisa dibuka dari HP di Wi-Fi yang sama.
const HOST = process.env.HOST || '127.0.0.1';
const tanpaWA = process.argv.includes('--tanpa-wa');

let wa = null;
if (!tanpaWA) {
  wa = await import('./bot.js');
  wa.mulaiSemua(); // sambungkan ulang WhatsApp semua user yang pernah tertaut
}
mulaiWeb({ port: PORT, host: HOST, wa });
