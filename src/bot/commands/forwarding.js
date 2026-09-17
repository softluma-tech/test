import { config } from '../../config.js';
import { getConfig } from '../../services/adminService.js';
import logger from '../../utils/logger.js';
import { adminKeyboard, cancelKeyboard, moreKeyboard } from '../keyboards.js';

const forwardedMessages = new Map();
const MAX_FORWARDED = 1000;

const buttonTexts = new Set();
for (const kb of [adminKeyboard, cancelKeyboard, moreKeyboard]) {
    for (const row of kb.reply_markup.keyboard) {
        for (const btn of row) {
            buttonTexts.add(typeof btn === 'string' ? btn : btn.text);
        }
    }
}

export const forwardToAdminGroup = async (ctx, next) => {
    if (ctx.updateType !== 'message') return next();
    if (ctx.chat?.type !== 'private') return next();
    if (!ctx.message) return next();

    const forwarding = await getConfig('forwarding', true);
    if (!forwarding) return next();

    const targetId = await getConfig('forwarding_target_id', null) || config.adminId;
    if (!targetId) return next();

    if (ctx.from.id === targetId) return next();

    const text = ctx.message.text;
    if (text && (text.startsWith('/') || buttonTexts.has(text))) return next();

    try {
        const forwarded = await ctx.forwardMessage(targetId);
        forwardedMessages.set(forwarded.message_id, ctx.from.id);
        if (forwardedMessages.size > MAX_FORWARDED) {
            const toDelete = [...forwardedMessages.keys()].slice(0, 100);
            toDelete.forEach((k) => forwardedMessages.delete(k));
        }
    } catch (err) {
        logger.error('Failed to forward message to target:', err);
    }

    return next();
};

export const handleAdminReply = async (ctx, next) => {
    const targetId = await getConfig('forwarding_target_id', null) || config.adminId;
    if (!targetId) return next();
    if (ctx.chat?.id !== targetId) return next();
    if (!ctx.message?.text) return next();
    if (!ctx.message.reply_to_message) return next();

    const repliedMsgId = ctx.message.reply_to_message.message_id;
    const userId = forwardedMessages.get(repliedMsgId);
    if (!userId) return next();

    try {
        await ctx.telegram.sendMessage(userId, ctx.message.text, { parse_mode: 'HTML' });
        forwardedMessages.delete(repliedMsgId);
        await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Reply sent to user.`, { parse_mode: 'HTML' });
    } catch (err) {
        logger.error('Failed to send admin reply:', err);
        await ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed to send reply. User may have blocked the bot.`, { parse_mode: 'HTML' });
    }
};
