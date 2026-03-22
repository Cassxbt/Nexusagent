import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      OPENAI_API_KEY: 'test-key',
      TELEGRAM_BOT_TOKEN: 'test-token',
      WDK_API_KEY: 'test-key',
      WDK_APP_ID: 'test-app',
      WDK_WALLET_ID: 'test-wallet',
    },
  },
});
