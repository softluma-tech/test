import dotenv from 'dotenv';
import logger from './utils/logger.js';

dotenv.config();

export const config = {
    botToken: process.env.BOT_TOKEN,
    dbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/quotex_bot',
    port: parseInt(process.env.PORT, 10) || 3000,
    adminId: parseInt(process.env.ADMIN_ID, 10) || null,
    webhookPath: '/softluma/tg-bot',
    webhookUrl: process.env.WEBHOOK_URL || null,
    miniAppUrl: process.env.MINI_APP_URL || (process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL}/app` : null),
};

const missing = [];
if (!config.botToken) missing.push('BOT_TOKEN');
if (!config.dbUri) missing.push('MONGODB_URI');

if (missing.length > 0) {
    logger.warn(`Missing environment variables: ${missing.join(', ')}`);
}

