import { initWdk, disposeWdk } from './core/wdk-setup.js';
import { closeDb } from './core/db.js';
import { startAutopilot, stopAutopilot } from './agents/autopilot.js';
import { createWebServer } from './web/server.js';

async function main() {
  console.log('Nexus — Autonomous Treasury Agent');
  console.log('Initializing WDK...');

  initWdk();
  console.log('WDK initialized.');

  const webPort = parseInt(process.env.WEB_PORT ?? '3000', 10);
  createWebServer(webPort);

  const shutdown = () => {
    stopAutopilot();
    closeDb();
    disposeWdk();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    // No Telegram — start autopilot in WebSocket-only mode
    // Autonomous actions (health factor protection, APY monitoring) still run every 5 min
    // Alerts broadcast to connected web terminal clients via broadcastCallbacks
    startAutopilot(null, []);
    console.log('Autopilot running (web terminal alerts only — set TELEGRAM_BOT_TOKEN for Telegram alerts).');
    return;
  }

  console.log('Starting Telegram bot...');
  const { createBot } = await import('./chat/telegram.js');
  const bot = createBot();

  process.on('SIGINT', () => bot.stop());
  process.on('SIGTERM', () => bot.stop());

  await bot.start({
    onStart: (info) => {
      console.log(`Bot running as @${info.username}`);

      const allowedUsers = process.env.TELEGRAM_ALLOWED_USERS;
      if (allowedUsers) {
        const userIds = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
        startAutopilot(bot, userIds);
        console.log(`Autopilot monitoring ${userIds.length} Telegram user(s).`);
      } else {
        startAutopilot(null, []);
        console.log('Autopilot running (web terminal alerts only — set TELEGRAM_ALLOWED_USERS for Telegram alerts).');
      }

      console.log('Ready. Send a message on Telegram or open the web terminal.');
    },
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  stopAutopilot();
  closeDb();
  disposeWdk();
  process.exit(1);
});
