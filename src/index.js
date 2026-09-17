

import mongoose from 'mongoose';
import { config } from './config.js';
import { connectDB } from './database.js';
import { initializeConfigs } from './services/adminService.js';
import app from './server/app.js';
import { setupBot } from './bot/index.js';
import logger from './utils/logger.js';

const start = async () => {
    try {
        await connectDB();
        await initializeConfigs();

        const bot = setupBot();

        if (!bot) {
            app.listen(config.port, '0.0.0.0', () => {
                logger.info(`Express Server running on port ${config.port} (no bot)`);
            });
            return;
        }

        try {
            bot.botInfo = await bot.telegram.getMe();
            logger.info(`Bot ready: @${bot.botInfo.username}`);
        } catch (err) {
            logger.error('Failed to fetch bot info (invalid BOT_TOKEN?):', err);
            process.exit(1);
        }

        const isDev = process.env.NODE_ENV === 'development';

        let server;

        if (isDev) {
            await bot.launch();
            logger.info('Bot started in polling mode');
        } else {
            app.use(bot.webhookCallback(config.webhookPath));
            logger.info(`Bot webhook callback mounted at ${config.webhookPath}`);

            server = app.listen(config.port, '0.0.0.0', () => {
                logger.info(`Express Server running on port ${config.port}`);
            });

            if (config.webhookUrl) {
                const webhookUrl = config.webhookUrl.replace(/\/+$/, '') + '/' + config.webhookPath.replace(/^\/+/, '');
                try {
                    await bot.telegram.setWebhook(webhookUrl);
                    logger.info(`Webhook set to ${webhookUrl}`);
                } catch (err) {
                    logger.error(`Failed to set webhook at ${webhookUrl}:`, err);
                    process.exit(1);
                }
                try {
                    const webhookInfo = await bot.telegram.getWebhookInfo();
                    if (webhookInfo.url !== webhookUrl) {
                        logger.error(`Webhook verification failed: expected ${webhookUrl}, got ${webhookInfo.url}`);
                        process.exit(1);
                    }
                    if (webhookInfo.last_error_date) {
                        logger.warn(`Webhook has last error at ${new Date(webhookInfo.last_error_date * 1000).toISOString()}: ${webhookInfo.last_error_message}`);
                    }
                    logger.info('Webhook verified successfully');
                } catch (err) {
                    logger.error('Failed to verify webhook:', err);
                    process.exit(1);
                }
            } else {
                logger.warn('WEBHOOK_URL not configured — webhook not set on Telegram');
            }
        }

        const shutdown = async (signal) => {
            logger.info(`Received ${signal}, shutting down...`);
            try { await bot.telegram.deleteWebhook(); } catch (_) {}
            bot?.stop(signal);
            if (server) {
                await new Promise((resolve) => server.close(resolve));
            }
            await mongoose.disconnect();
            process.exit(0);
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));

    } catch (error) {
        logger.error('Startup Error:', error);
        process.exit(1);
    }
};

start();
