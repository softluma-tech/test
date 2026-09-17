import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { adminGuard, maintenanceGuard, rateLimiter } from './middlewares/admin.js';
import { escapeHtml } from '../utils/helpers.js';

import { User } from '../models/User.js';
import { forwardToAdminGroup, handleAdminReply } from './commands/forwarding.js';

import {
    startCommand,
    handleTextMessage,
    handleChatJoinRequest,
    handleHowRegister,
    handleDeleteAccount,
    handleSupport,
    handleJoinVipCallback,
    handleJoinVipConfirm,
    handleGetAccess,
    handleJoinPublic,
    handleHelpBack,
    handleBackMainMenu
} from './commands/user.js';

import {
    adminPanel,
    handleMoreMenu,
    handleNotifyCommand,
    handleNotifyConfirm,
    handleMoreRemove,
    handleRemoveConfirm,
    handleRemoveResume,
    handleRemoveNew,
    handleRemoveLowDepositCommand,
    handleRemoveLowDepositConfirm,
    handleRemoveLowDepositResume,
    handleRemoveLowDepositNew,
    handleConfigMenu,
    handleChannelMenu,
    handleConfigBack,
    handleToggleForwarding,
    handleConfigCallback,
    handleBroadcastCommand,
    handleBroadcastCallback,
    executeBroadcast,
    viewStats,
    handleCancelEdit,
    handleAdminMessageUpdate,
    handleReportCommand,
    handleReportFormat,
    handleSearchCommand,
    handleUnlinkCommand,
    handleUnlinkConfirm,
    handleNotifyResume,
    handleNotifyNew
} from './commands/admin.js';

import {
    handleManualPostbackCommand,
    handleManualPostbackConfirm
} from './commands/manualPostback.js';

export const setupBot = () => {
    if (!config.botToken) {
        logger.error('No BOT_TOKEN provided, skipping bot initialization.');
        return null;
    }

    const bot = new Telegraf(config.botToken, {
        telegram: { timeout: 30000 },
        handlerTimeout: 30000,
    });

    const _sendMessage = bot.telegram.sendMessage.bind(bot.telegram);
    bot.telegram.sendMessage = (chatId, text, opts) => {
        const finalText = text.startsWith('<b>') ? text : `<b>${text}</b>`;
        return _sendMessage(chatId, finalText, { ...opts, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    };

    bot.catch(async (err, ctx) => {
        logger.error(`Ooops, encountered an error for ${ctx.updateType}`, err);

        const userId = String(ctx.from?.id || 'unknown');
        const username = ctx.from?.username ? `@${escapeHtml(ctx.from.username)}` : 'N/A';
        const errMsg = escapeHtml(err?.message || 'Unknown error');
        const stack = err?.stack ? `\n<code>${(err.stack).slice(0, 1500)}</code>` : '';

        const text = `🚨 <b>Bot Error</b>\n\n` +
            `<b>Type:</b> <code>${escapeHtml(ctx.updateType)}</code>\n` +
            `<b>User:</b> <code>${userId}</code> (${username})\n` +
            `<b>Error:</b> <code>${errMsg}</code>${stack}\n` +
            `<b>Time:</b> ${new Date().toISOString()}`;

        try {
            if (config.adminId) {
                await ctx.telegram.sendMessage(config.adminId, text, { parse_mode: 'HTML' });
            }
        } catch (notifyErr) {
            logger.error('Failed to notify admin about error:', notifyErr);
        }
    });

    bot.use(rateLimiter);
    bot.use(forwardToAdminGroup);

    bot.start(maintenanceGuard, startCommand);

    bot.command('app', maintenanceGuard, async (ctx) => {
        if (!config.miniAppUrl) {
            return ctx.reply(
                `<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> The Signals Mini App is not configured yet. Please try again later.</b>`,
                { parse_mode: 'HTML' },
            );
        }
        await ctx.reply(
            `<b><tg-emoji emoji-id="5938517659451658781">📈</tg-emoji> Open the Signal Tracker below and start earning:</b>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🚀 Open Signal Tracker',
                                web_app: { url: config.miniAppUrl },
                            },
                        ],
                    ],
                },
            },
        );
    });

    bot.action('help_how_register', maintenanceGuard, handleHowRegister);
    bot.action('help_delete_account', maintenanceGuard, handleDeleteAccount);
    bot.action('help_support', maintenanceGuard, handleSupport);
    bot.action('help_join_vip', maintenanceGuard, handleJoinVipCallback);
    bot.action('join_vip_confirm', maintenanceGuard, handleJoinVipConfirm);
    bot.action('get_access', maintenanceGuard, handleGetAccess);
    bot.action('back_main_menu', maintenanceGuard, handleBackMainMenu);
    bot.action('help_join_public', maintenanceGuard, handleJoinPublic);
    bot.action('help_back', maintenanceGuard, handleHelpBack);

    bot.command('adm', adminGuard, adminPanel);
    bot.hears('⬅️ Back to User Panel', startCommand);

    bot.hears('⚙️ Config', adminGuard, handleConfigMenu);
    bot.action('cfg_channels', adminGuard, handleChannelMenu);
    bot.action('cfg_back', adminGuard, handleConfigBack);
    bot.action('toggle_forwarding', adminGuard, handleToggleForwarding);
    bot.action(/^editcfg_(.+)$/, adminGuard, handleConfigCallback);

    bot.hears('📢 Broadcast', adminGuard, handleBroadcastCommand);
    bot.command('broadcast', adminGuard, executeBroadcast);
    bot.action(/^bcast_(.+)$/, adminGuard, handleBroadcastCallback);

    bot.hears('📊 View Stats', adminGuard, viewStats);
    bot.hears('📋 More', adminGuard, handleMoreMenu);
    bot.hears('⬅️ Back to Admin Panel', adminGuard, adminPanel);
    bot.hears('📣 Notify Inactive', adminGuard, handleNotifyCommand);
    bot.action('notify_confirm', adminGuard, handleNotifyConfirm);
    bot.action('notify_resume', adminGuard, handleNotifyResume);
    bot.action('notify_new', adminGuard, handleNotifyNew);
    bot.hears('🗑️ Remove User', adminGuard, handleMoreRemove);
    bot.action(/^more_remove_confirm_(.+)$/, adminGuard, handleRemoveConfirm);
    bot.action('more_remove_resume', adminGuard, handleRemoveResume);
    bot.action('more_remove_new', adminGuard, handleRemoveNew);
    bot.hears('💸 Remove Low Deposit', adminGuard, handleRemoveLowDepositCommand);
    bot.action('more_remove_lowdep_confirm', adminGuard, handleRemoveLowDepositConfirm);
    bot.action('more_remove_lowdep_resume', adminGuard, handleRemoveLowDepositResume);
    bot.action('more_remove_lowdep_new', adminGuard, handleRemoveLowDepositNew);
    bot.hears('📊 Report', adminGuard, handleReportCommand);
    bot.hears('🔍 Search User', adminGuard, handleSearchCommand);
    bot.hears('🔗 Unlink ID', adminGuard, handleUnlinkCommand);
    bot.action(/^unlink_confirm_(.+)$/, adminGuard, handleUnlinkConfirm);
    bot.hears('📨 Manual Postback', adminGuard, handleManualPostbackCommand);
    bot.action('manual_pb_confirm', adminGuard, handleManualPostbackConfirm);
    bot.action(/^report_format_(excel|pdf)$/, adminGuard, handleReportFormat);

    bot.action('cancel_edit', adminGuard, handleCancelEdit);

    bot.on('message', handleAdminReply);

    bot.on('message', async (ctx, next) => {
        const text = ctx.message.text;
        if (text && text.startsWith('/')) return next();

        try {
            const user = await User.findOne({ telegramId: ctx.from.id }).lean();
            if (!user) return next();

            if (user.state?.startsWith('editing_') || user.state === 'remove_days') {
                return handleAdminMessageUpdate(ctx, user);
            }

            if (!text) return next();

            return maintenanceGuard(ctx, async () => {
                await handleTextMessage(ctx);
            });
        } catch (err) {
            logger.error('Global message handler error:', err);
        }
    });

    bot.on('chat_join_request', async (ctx) => {
        try {
            await handleChatJoinRequest(ctx);
        } catch (err) {
            logger.error('Chat join request handler error:', err);
        }
    });

    return bot;
};
