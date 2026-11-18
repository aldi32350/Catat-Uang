import { mulaiWeb } from './web.js';

const PORT = Number(process.env.PORT || 3000);
// Default hanya bisa dibuka dari komputer ini. Set HOST=0.0.0.0 agar bisa dibuka dari HP di Wi-Fi yang sama.
const HOST = process.env.HOST || '127.0.0.1';
const tanpaWA = process.argv.includes('--tanpa-wa');

let status = null;
if (!tanpaWA) {
  const bot = await import('./bot.js');
  status = bot.status;
  bot.mulaiBot().catch((e) => console.error('Gagal memulai WhatsApp:', e));
}
mulaiWeb({ port: PORT, host: HOST, status });
