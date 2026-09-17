import { Markup } from 'telegraf';
import { randomUUID } from 'node:crypto';
import { User } from '../../models/User.js';
import { Trader } from '../../models/Trader.js';
import { handlePostbackData } from '../../services/traderService.js';
import { getOrCreateUser } from '../../services/userService.js';
import { escapeHtml } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const manualPbCache = new Map();
const MANUAL_PB_CACHE_MAX = 500;

export const clearManualPbSession = (telegramId) => {
    manualPbCache.delete(telegramId);
};

const buildTraderInfo = (trader) => {
    if (!trader) return null;
    return (
        `<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Trader ID:</b> <code>${escapeHtml(trader.trader_id)}</code>\n` +
        `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Total Deposit:</b> $${(trader.sumdep || 0).toFixed(2)}\n` +
        `<tg-emoji emoji-id="5938074049459523495">💳</tg-emoji> <b>Total Withdraw:</b> $${(trader.sumwithdraw || 0).toFixed(2)}\n` +
        `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> <b>FTD:</b> ${trader.first_deposit ? 'Yes' : 'No'} • <b>Deposited:</b> ${trader.deposited ? 'Yes' : 'No'} • <b>Registered:</b> ${trader.registered ? 'Yes' : 'No'}\n` +
        `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> <b>Events:</b> ${(trader.events || []).length}` +
        (trader.telegramId ? `\n<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Linked Telegram ID:</b> <code>${trader.telegramId}</code>` : '')
    );
};

export const handleManualPostbackCommand = async (ctx) => {
    const user = await getOrCreateUser(ctx);
    user.state = 'editing_manual_pb_trader';
    await user.save();

    await ctx.reply(
        `<b><tg-emoji emoji-id="5936181055508713274">📨</tg-emoji> Manual Postback</b>\n\n` +
        `Send the <b>Trader ID</b> to record a deposit for:`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        }
    );
};

export const handleManualPostbackMessage = async (ctx, user) => {
    const text = (ctx.message.text || ctx.message.caption || '').trim();
    if (!text) {
        return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Please send a Trader ID.`, { parse_mode: 'HTML' });
    }

    if (user.state === 'editing_manual_pb_trader') {
        if (text.length > 64) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Trader ID too long (max 64 characters). Try again:`, { parse_mode: 'HTML' });
        }

        const trader = await Trader.findOne({ trader_id: text }).lean();
        const info = buildTraderInfo(trader);

        await User.findOneAndUpdate(
            { telegramId: user.telegramId },
            { state: `editing_manual_pb_amount_${text}` }
        );

        const heading = trader
            ? `<b><tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> Trader found</b>\n\n${info}\n\n`
            : `<b><tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> New trader</b>\n\n<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Trader ID:</b> <code>${escapeHtml(text)}</code>\n<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>This trader does not exist yet — a new record will be created.</b>\n\n`;

        const formatWarning = !/^\d{8}$/.test(text)
            ? `<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>Note:</b> this ID does not match the 8-digit format users must send to link it — they may not be able to claim it from the bot.\n\n`
            : '';

        return ctx.reply(
            heading + formatWarning + `Send the <b>deposit amount</b> for this postback (numbers only, e.g. 50 or 50.50):`,
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
            }
        );
    }

    if (user.state?.startsWith('editing_manual_pb_amount_')) {
        if (!/^\d+(\.\d{1,2})?$/.test(text)) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Amount must be a valid number (max 2 decimals). Try again:`, { parse_mode: 'HTML' });
        }

        const amount = parseFloat(text);
        if (amount <= 0) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Amount must be greater than 0. Try again:`, { parse_mode: 'HTML' });
        }

        const traderId = user.state.replace('editing_manual_pb_amount_', '');
        const trader = await Trader.findOne({ trader_id: traderId }).lean();
        const eventType = trader && (trader.first_deposit || trader.deposited || (trader.sumdep || 0) > 0) ? 'dep' : 'ftd';

        manualPbCache.set(user.telegramId, { traderId, amount, eventType });
        if (manualPbCache.size > MANUAL_PB_CACHE_MAX) {
            const toDelete = [...manualPbCache.keys()].slice(0, 50);
            toDelete.forEach((k) => manualPbCache.delete(k));
        }

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'editing_manual_pb_confirm' });

        const info = buildTraderInfo(trader);
        const confirmText =
            `<b><tg-emoji emoji-id="5936181055508713274">📨</tg-emoji> Manual Postback — Confirm</b>\n\n` +
            (info ? `${info}\n\n` : `<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Trader ID:</b> <code>${escapeHtml(traderId)}</code> (new trader)\n\n`) +
            `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Event:</b> <code>${eventType}</code>\n` +
            `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Deposit Amount:</b> $${amount.toFixed(2)}\n\n` +
            `<b>This will be stored exactly like a Quotex postback and will update the trader record. Confirm?</b>`;

        return ctx.reply(confirmText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        Markup.button.callback('✅ Confirm', 'manual_pb_confirm'),
                        Markup.button.callback('❌ Cancel', 'cancel_edit'),
                    ]
                ]
            }
        });
    }

    return ctx.reply(
        `<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> <b>Invalid input for the current step.</b>\n\n<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> Use the buttons in the latest message, or press <b>❌ Cancel</b> and start again.`,
        { parse_mode: 'HTML' }
    );
};

export const handleManualPostbackConfirm = async (ctx) => {
    const adminUser = await getOrCreateUser(ctx);
    if (adminUser.state !== 'editing_manual_pb_confirm') {
        return ctx.answerCbQuery('Nothing to confirm.').catch(() => {});
    }

    const payload = manualPbCache.get(adminUser.telegramId);
    await User.findOneAndUpdate({ telegramId: adminUser.telegramId }, { state: 'start' });
    manualPbCache.delete(adminUser.telegramId);

    if (!payload) {
        await ctx.answerCbQuery('Session expired. Start again.').catch(() => {});
        return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Manual postback session expired. Please start again.`, { parse_mode: 'HTML' });
    }

    await ctx.answerCbQuery('Processing...').catch(() => {});

    const { traderId, amount, eventType } = payload;
    const eid = `manual-${randomUUID()}`;
    const postbackData = { status: eventType, uid: traderId, sumdep: String(amount), eid };
    postbackData[eventType] = 'true';

    logger.info(`Manual postback by admin ${adminUser.telegramId}: uid=${traderId} event=${eventType} sumdep=${amount}`);

    const result = await handlePostbackData(postbackData);

    if (!result.success) {
        return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> <b>Manual postback failed.</b>\n\n<code>${escapeHtml(result.error || 'Unknown error')}</code>`, { parse_mode: 'HTML' });
    }

    if (result.skipped) {
        await ctx.answerCbQuery('Event already existed').catch(() => {});
        return ctx.reply(
            `<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>Nothing stored</b> — an event with this ID already exists for trader <code>${escapeHtml(traderId)}</code>. No data was changed.`,
            { parse_mode: 'HTML' }
        );
    }

    const trader = await Trader.findOne({ trader_id: traderId }).lean();
    const info = buildTraderInfo(trader);

    const text =
        `<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Manual Postback Stored</b>\n\n` +
        `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Event:</b> <code>${eventType}</code>\n` +
        `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Amount:</b> $${amount.toFixed(2)}\n\n` +
        (info ? `${info}\n\n` : '') +
        `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Future Quotex postbacks for this trader ID will update the same record.</b>`;

    try {
        await ctx.editMessageText(text, { parse_mode: 'HTML' });
    } catch {
        await ctx.reply(text, { parse_mode: 'HTML' });
    }
};
