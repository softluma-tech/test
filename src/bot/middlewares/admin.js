import { config } from '../../config.js';
import { getConfig } from '../../services/adminService.js';
import logger from '../../utils/logger.js';

const userRateLimit = new Map();
const RATE_LIMIT_WINDOW = 10000;
const RATE_LIMIT_MAX = 10;
const COOLDOWN_NOTIFY_INTERVAL = 8000;

export const rateLimiter = async (ctx, next) => {
    if (ctx.from?.id === config.adminId) return next();
    if (ctx.updateType !== 'message' || !ctx.message?.text) return next();

    const text = ctx.message.text;
    if (text.startsWith('/') || text.startsWith('editcfg_') || text.startsWith('bcast_') || text.startsWith('cfg_') || text.startsWith('help_') || text.startsWith('join_') || text.startsWith('back_') || text.startsWith('toggle_') || text === 'cancel_edit' || text === 'get_access') return next();

    const now = Date.now();
    const userId = ctx.from.id;
    let record = userRateLimit.get(userId);

    if (!record) {
        record = { timestamps: [], lastWarn: 0 };
        userRateLimit.set(userId, record);
    }

    record.timestamps = record.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);

    if (record.timestamps.length >= RATE_LIMIT_MAX) {
        if (now - record.lastWarn > COOLDOWN_NOTIFY_INTERVAL) {
            record.lastWarn = now;
            await ctx.reply(
                `<b>⏳ Please slow down!</b>\n\nYou can send up to ${RATE_LIMIT_MAX} messages per ${RATE_LIMIT_WINDOW / 1000} seconds. Wait a moment and try again.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
        return;
    }

    record.timestamps.push(now);
    return next();
};

export const adminGuard = async (ctx, next) => {
    try {
        if (config.adminId && ctx.from.id === config.adminId) return next();
        return ctx.reply(`<b>⛔ You do not have permission to use this command.</b>`);
    } catch (err) {
        logger.error('adminGuard error:', err);
        return ctx.reply(`<b><tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> An error occurred. Please try again.</b>`);
    }
};

export const maintenanceGuard = async (ctx, next) => {
    try {
        const isMaintenance = await getConfig('maintenance', false);
        if (!isMaintenance) return next();
        if (config.adminId && ctx.from.id === config.adminId) return next();
        return ctx.reply(
            '<b>🛠️ Maintenance Break</b>\n\nThe bot is currently undergoing maintenance and updates. Please check back shortly!',
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        logger.error('maintenanceGuard error:', err);
        return ctx.reply(`<b><tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> An error occurred. Please try again.</b>`);
    }
};
