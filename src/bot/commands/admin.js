import { Markup } from 'telegraf';
import { adminKeyboard, moreKeyboard } from '../keyboards.js';
import { User } from '../../models/User.js';
import { Trader } from '../../models/Trader.js';
import { broadcastMessage, getBroadcastState, clearBroadcastState } from '../../services/broadcastService.js';
import { getConfig, setConfig } from '../../services/adminService.js';
import { getOrCreateUser } from '../../services/userService.js';
import { escapeHtml } from '../../utils/helpers.js';
import { handleManualPostbackMessage, clearManualPbSession } from './manualPostback.js';
import { buildInactiveReport, sendInactiveReport, findInactiveTraders, findLowDepositTraders, removeInactiveUsers, removeLowDepositUsers, getRemoveState, clearRemoveState, runPool, createRateLimiter, notifyFlood, removeFromChannelWithRetry } from '../../services/reportService.js';
import logger from '../../utils/logger.js';

const CHANNEL_COUNT = 5;

const buildConfigMenu = (forwardingOn) => {
    const forwardBtn = forwardingOn
        ? '📨 Forwarding: ON'
        : '📨 Forwarding: OFF';
    return [
        [Markup.button.callback('💰 Min Deposit', 'editcfg_dep'), Markup.button.callback('🗑️ Min Redeposit', 'editcfg_min_redeposit')],
        [Markup.button.callback('🔗 Affiliate LID', 'editcfg_lid'), Markup.button.callback('🎯 VIP Channels', 'cfg_channels')],
        [Markup.button.callback('🌐 Join Public', 'editcfg_btn_join_channel'), Markup.button.callback('🆘 Support', 'editcfg_support_id')],
        [Markup.button.callback('👤 Forward To', 'editcfg_forward_id'), Markup.button.callback('🎵 Welcome Voice', 'editcfg_welcome_voice')],
        [Markup.button.callback('🎬 Welcome Video', 'editcfg_welcome_video'), Markup.button.callback('📝 Log Channel', 'editcfg_log_channel')],
        [Markup.button.callback(forwardBtn, 'toggle_forwarding')],
    ];
};

const emojis = ['🥇', '🥈', '🥉', '🎖️', '🏅'];

const sendFailureList = async (ctx, users, label = 'Failed users') => {
    if (!Array.isArray(users) || users.length === 0) return;

    const lines = users.map((entry) => {
        const tgId = entry.telegramId ?? 'N/A';
        const username = entry.username && entry.username !== 'N/A'
            ? `@${escapeHtml(entry.username)}`
            : null;
        if (username) {
            return `<b>❌ ${username}</b> (${escapeHtml(String(tgId))})`;
        }
        const name = entry.name && entry.name !== 'N/A'
            ? escapeHtml(entry.name)
            : String(tgId);
        return `<b>❌ ${name}</b> (${escapeHtml(String(tgId))})`;
    });

    const CHUNK_SIZE = 25;
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
        const chunk = lines.slice(i, i + CHUNK_SIZE);
        const header = i === 0
            ? `<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> <b>${escapeHtml(label)} (${lines.length}):</b>\n\n`
            : '';
        await ctx.reply(header + chunk.join('\n'), { parse_mode: 'HTML' });
    }
};

const buildChannelMenu = () => {
    const channelButtons = Array.from({ length: CHANNEL_COUNT }, (_, i) =>
        Markup.button.callback(`${emojis[i]} Channel ${i + 1}`, `editcfg_channel_${i}`)
    );
    return [
        [channelButtons[0], channelButtons[1]],
        [channelButtons[2], channelButtons[3]],
        [channelButtons[4]],
        [Markup.button.callback('⬅️ Back to Config', 'cfg_back')],
    ];
};

const makeProgressCallback = (ctx, msg) => {
    let lastEdit = 0;
    return async (success, failed, total, skip) => {
        const now = Date.now();
        if (now - lastEdit < 1000) return;
        lastEdit = now;
        const pct = Math.floor((skip / total) * 100);
        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id, msg.message_id, null,
                `<b>📡 Broadcasting...</b>\n${skip}/${total} users (${pct}%)\n<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> ${success} • <tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> ${failed}`,
                { parse_mode: 'HTML' }
            );
        } catch (_) {}
    };
};

export const adminPanel = async (ctx) => {
    await ctx.reply('🛠️ Admin Panel', adminKeyboard);
};

export const handleMoreMenu = async (ctx) => {
    await ctx.reply('<b>📋 Welcome to More Options</b>', { parse_mode: 'HTML', reply_markup: moreKeyboard.reply_markup });
};

const NOTIFY_CONCURRENCY = 5;
const NOTIFY_PROGRESS_EVERY = 25;
const NOTIFY_PROGRESS_MIN_INTERVAL_MS = 2000;
const NOTIFY_STATE_FLUSH_EVERY = 25;
const NOTIFY_STATE_FLUSH_MS = 2000;
const notifyCache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let notifyJobRunning = false;

const buildInactiveNotifyMessage = (days) =>
    `<b><tg-emoji emoji-id="5981194327110456280">📣</tg-emoji> IMPORTANT REMINDER</b>\n\n` +
    `<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>We noticed no deposit or withdrawal activity in the last ${days} days.</b>\n\n` +
    `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Make a deposit to keep your VIP channel access and continue receiving daily signals.</b>\n\n` +
    `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Stay active &amp; happy trading!</b>`;

export const handleNotifyCommand = async (ctx) => {
    const notifyState = await getNotifyState();
    if (notifyState && (notifyState.status === 'running' || notifyState.status === 'interrupted')) {
        const pct = notifyState.total > 0
            ? Math.floor(((notifyState.currentIndex || 0) / notifyState.total) * 100)
            : 0;
        return ctx.reply(
            `<b><tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> Incomplete notification found!</b>\n\n` +
            `Progress: ${pct}% (${notifyState.currentIndex || 0}/${notifyState.total} users)\n` +
            `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> ${notifyState.sent || 0} delivered • <tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> ${notifyState.failed || 0} failed\n\n` +
            `Use the buttons below:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback('▶️ Resume', 'notify_resume'),
                            Markup.button.callback('🗑️ Cancel & Start New', 'notify_new'),
                        ]
                    ]
                }
            }
        );
    }

    if (notifyJobRunning) {
        return ctx.reply(`<b><tg-emoji emoji-id="5938558852482994666">⏳</tg-emoji> A notification job is already running. Please wait for it to complete.</b>`, { parse_mode: 'HTML' });
    }

    const user = await getOrCreateUser(ctx);
    user.state = 'editing_notify_days';
    await user.save();

    await ctx.reply(
        `<b><tg-emoji emoji-id="5981194327110456280">📣</tg-emoji> Notify Inactive Users</b>\n\n` +
        `Send the number of days to check for inactivity (numbers only):`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        }
    );
};

const getNotifyState = async () => getConfig('notify_state', null);
const clearNotifyState = async () => setConfig('notify_state', null);

const runNotifyJob = async (ctx, days, entries, resumeIndex = 0) => {
    notifyJobRunning = true;
    try {
        const total = entries.length;
        const existingState = await getNotifyState();
        const state = {
            status: 'running',
            days,
            total,
            currentIndex: resumeIndex,
            sent: (existingState?.status === 'completed' ? 0 : existingState?.sent) || 0,
            failed: (existingState?.status === 'completed' ? 0 : existingState?.failed) || 0,
            startedAt: existingState?.startedAt || new Date().toISOString(),
        };
        await setConfig('notify_state', state);

        const msg = buildInactiveNotifyMessage(days);
        const rateLimitFn = createRateLimiter();
        let sent = state.sent;
        let failed = state.failed;
        let done = 0;
        let lastEdit = 0;
        let lastFlush = Date.now();
        const failedUsers = [];

        const persist = async () => {
            state.currentIndex = resumeIndex + done;
            state.sent = sent;
            state.failed = failed;
            await setConfig('notify_state', state);
        };

        let progressMsg = null;
        try {
            progressMsg = await ctx.editMessageText(`<b><tg-emoji emoji-id="5981194327110456280">📣</tg-emoji> Sending inactivity reminders to ${total} users...</b>`, { parse_mode: 'HTML' });
        } catch {}

        const updateProgress = async () => {
            const now = Date.now();
            if (!progressMsg || now - lastEdit < NOTIFY_PROGRESS_MIN_INTERVAL_MS) return;
            lastEdit = now;
            const processed = resumeIndex + done;
            try {
                await ctx.telegram.editMessageText(
                    ctx.chat.id, progressMsg.message_id, null,
                    `<b><tg-emoji emoji-id="5981194327110456280">📣</tg-emoji> Sending inactivity reminders...</b>\n` +
                    `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> ${processed}/${total} (${Math.floor((processed / total) * 100)}%)\n` +
                    `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> ${sent} • <tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> ${failed}`,
                    { parse_mode: 'HTML' }
                );
            } catch {}
        };

        const worker = async (entry) => {
            const tgId = Number(entry.telegramId);
            if (!tgId) {
                failed++;
                failedUsers.push(entry);
                done++;
                return;
            }
            try {
                await rateLimitFn();
                await ctx.telegram.sendMessage(tgId, msg, { parse_mode: 'HTML' });
                sent++;
            } catch (err) {
                if (err?.response?.error_code === 429) {
                    const retryAfter = (err.response.parameters?.retry_after || 5) * 1000;
                    notifyFlood(retryAfter);
                    await sleep(retryAfter);
                    try {
                        await rateLimitFn();
                        await ctx.telegram.sendMessage(tgId, msg, { parse_mode: 'HTML' });
                        sent++;
                    } catch {
                        failed++;
                        failedUsers.push(entry);
                    }
                } else {
                    failed++;
                    failedUsers.push(entry);
                }
            }
            done++;
            if (done % NOTIFY_PROGRESS_EVERY === 0) {
                if (done % NOTIFY_STATE_FLUSH_EVERY === 0 || Date.now() - lastFlush >= NOTIFY_STATE_FLUSH_MS) {
                    lastFlush = Date.now();
                    await persist();
                }
                await updateProgress();
            }
        };

        const chunk = resumeIndex > 0 ? entries.slice(resumeIndex) : entries;
        await runPool(chunk, worker, NOTIFY_CONCURRENCY);
        await persist();
        await updateProgress();

        await ctx.reply(
            `<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Notification complete</b>\n\n` +
            `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> <b>Total inactive users:</b> ${state.total}\n` +
            `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> <b>Delivered:</b> ${sent}\n` +
            `<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> <b>Failed:</b> ${failed}`,
            { parse_mode: 'HTML' }
        );

        if (failedUsers.length > 0) {
            await sendFailureList(ctx, failedUsers);
        }

        await clearNotifyState();
    } catch (err) {
        const current = await getNotifyState();
        await setConfig('notify_state', { ...(current || {}), status: 'interrupted' });
        logger.error('Notify job error:', err);
        throw err;
    } finally {
        notifyJobRunning = false;
    }
};

export const handleNotifyConfirm = async (ctx) => {
    const adminUser = await getOrCreateUser(ctx);
    const state = adminUser.state || '';

    if (!state.startsWith('editing_notify_confirm_')) {
        return ctx.answerCbQuery('Nothing to confirm.').catch(() => {});
    }

    if (notifyJobRunning) {
        return ctx.answerCbQuery('A notification job is already running.').catch(() => {});
    }

    const persisted = await getNotifyState();
    if (persisted && (persisted.status === 'running' || persisted.status === 'interrupted')) {
        return ctx.answerCbQuery('Resume or cancel the existing job first.').catch(() => {});
    }

    const days = parseInt(state.replace('editing_notify_confirm_', ''), 10);
    if (Number.isNaN(days) || days < 1) {
        await User.findOneAndUpdate({ telegramId: adminUser.telegramId }, { state: 'start' });
        return ctx.answerCbQuery('Invalid days.').catch(() => {});
    }

    const adminId = adminUser.telegramId;
    const cached = notifyCache.get(adminId);
    let entries = cached && cached.days === days ? cached.entries : null;

    if (!entries) {
        try {
            entries = await buildInactiveReport(days);
        } catch (err) {
            logger.error('Inactive analysis error:', err);
            await User.findOneAndUpdate({ telegramId: adminUser.telegramId }, { state: 'start' });
            await ctx.answerCbQuery('Analysis failed.').catch(() => {});
            return ctx.reply(`<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed to analyze inactive users. Try again.</b>`, { parse_mode: 'HTML' });
        }
    }

    notifyCache.delete(adminId);
    await User.findOneAndUpdate({ telegramId: adminUser.telegramId }, { state: 'start' });

    if (entries.length === 0) {
        return ctx.reply(`<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> No inactive traders found in the last ${days} days.</b>`, { parse_mode: 'HTML' });
    }

    await ctx.answerCbQuery('Sending notifications...').catch(() => {});
    try {
        await runNotifyJob(ctx, days, entries, 0);
    } catch (err) {
        logger.error('Notify execution error:', err);
        await ctx.reply(`<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Notification interrupted. Use 📣 Notify Inactive to resume.</b>`, { parse_mode: 'HTML' });
    }
};

export const handleNotifyResume = async (ctx) => {
    const notifyState = await getNotifyState();
    if (!notifyState || !['running', 'interrupted'].includes(notifyState.status)) {
        await ctx.answerCbQuery('No notification job found.').catch(() => {});
        return;
    }
    if (notifyJobRunning) return ctx.answerCbQuery('Already running.').catch(() => {});

    const days = notifyState.days;
    let entries = null;
    try {
        entries = await buildInactiveReport(days);
    } catch (err) {
        logger.error('Inactive analysis error:', err);
        return ctx.reply(`<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed to analyze inactive users. Try again.</b>`, { parse_mode: 'HTML' });
    }

    await ctx.answerCbQuery('Resuming...').catch(() => {});
    try {
        await runNotifyJob(ctx, days, entries, notifyState.currentIndex || 0);
    } catch (err) {
        logger.error('Notify resume execution error:', err);
        await ctx.reply(`<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Notification interrupted. Use 📣 Notify Inactive to resume.</b>`, { parse_mode: 'HTML' });
    }
};

export const handleNotifyNew = async (ctx) => {
    if (notifyJobRunning) {
        return ctx.answerCbQuery('A job is running right now.').catch(() => {});
    }
    await clearNotifyState();
    await ctx.answerCbQuery('Old notification job cancelled.').catch(() => {});
    try {
        await ctx.editMessageText(`<tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Old notification job cancelled.\n\nUse <b>📣 Notify Inactive</b> to start a new one.`, { parse_mode: 'HTML' });
    } catch {
        await ctx.reply(`<tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Old notification job cancelled. Use <b>📣 Notify Inactive</b> to start a new one.`, { parse_mode: 'HTML' });
    }
};

export const handleMoreRemove = async (ctx) => {
    const state = await getRemoveState();
    if (state && (state.status === 'running' || state.status === 'interrupted') && (state.type || 'days') === 'lowdep') {
        return ctx.reply(
            `<b><tg-emoji emoji-id="6174916816951842220">💸</tg-emoji> A low-deposit removal is already in progress.</b>\n\n` +
            `Use <b>💸 Remove Low Deposit</b> to resume or cancel it.`,
            { parse_mode: 'HTML' }
        );
    }
    if (state && (state.status === 'running' || state.status === 'interrupted')) {
        const processed = state.processed?.length || 0;
        const pct = state.total > 0 ? Math.floor((processed / state.total) * 100) : 0;
        return ctx.reply(
            `<b><tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Incomplete removal found!</b>\n\n` +
            `Progress: ${pct}% (${processed}/${state.total} users)\n` +
            `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Removed: ${state.removed} • <tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed: ${state.failed}\n\n` +
            `Use the buttons below:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback('▶️ Resume', 'more_remove_resume'),
                            Markup.button.callback('🗑️ Cancel & Start New', 'more_remove_new'),
                        ]
                    ]
                }
            }
        );
    }

    const user = await getOrCreateUser(ctx);
    user.state = 'remove_days';
    await user.save();

    await ctx.reply(
        `<b><tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Remove Inactive Users</b>\n\n` +
        `Send the number of days to check for inactivity (numbers only):`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        }
    );
};

const runRemoval = async (ctx, days, resume) => {
    await ctx.answerCbQuery(resume ? 'Resuming removal...' : 'Removing inactive users...').catch(() => {});
    try {
        await ctx.editMessageText(`<b><tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Removing inactive users...</b>`, { parse_mode: 'HTML' });
    } catch {}

    const progressMsg = await ctx.reply(
        `<b>🗑️ Removing inactive users...</b>\n0/0 users (0%)`,
        { parse_mode: 'HTML' }
    );

    let lastEdit = 0;
    const onProgress = async (done, total, removed, failed) => {
        const now = Date.now();
        if (now - lastEdit < 1000) return;
        lastEdit = now;
        const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id, progressMsg.message_id, null,
                `<b>🗑️ Removing inactive users...</b>\n${done}/${total} users (${pct}%)\n` +
                `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Removed: ${removed} • <tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed: ${failed}`,
                { parse_mode: 'HTML' }
            );
        } catch {}
    };

    try {
        const result = await removeInactiveUsers(ctx.telegram, days, { onProgress, resume });
        const summary =
            `<b><tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Removal complete</b>\n\n` +
            `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> <b>Inactive (with access):</b> ${result.total}\n` +
            `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> <b>Removed:</b> ${result.removed}\n` +
            `<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> <b>Failed:</b> ${result.failed}\n` +
            `<tg-emoji emoji-id="5938386156142989281">⏭️</tg-emoji> <b>Skipped:</b> ${result.skipped}\n` +
            `<tg-emoji emoji-id="5981194327110456280">📣</tg-emoji> <b>Notified:</b> ${result.notified}` +
            (result.notifyFailed ? `\n<tg-emoji emoji-id="5938290000415167172">🔕</tg-emoji> <b>Notice failed:</b> ${result.notifyFailed}` : '');
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null, summary, { parse_mode: 'HTML' });
        } catch {
            await ctx.reply(summary, { parse_mode: 'HTML' });
        }

        await sendFailureList(ctx, result.failedUsers);
        await sendFailureList(ctx, result.noticeFailedUsers, 'Notice failed users');
    } catch (err) {
        logger.error('Bulk removal error:', err);
        if (err?.message?.includes('already running')) {
            await ctx.reply(`<tg-emoji emoji-id="5938558852482994666">⏳</tg-emoji> <b>A removal job is already running.</b>`, { parse_mode: 'HTML' });
        } else {
            await ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Removal interrupted. Use 🗑️ Remove User to resume.`, { parse_mode: 'HTML' });
        }
    }
};

export const handleRemoveConfirm = async (ctx) => {
    const adminUser = await getOrCreateUser(ctx);
    const state = adminUser.state || '';

    if (!state.startsWith('editing_remove_confirm_')) {
        return ctx.answerCbQuery('Nothing to confirm.').catch(() => {});
    }

    const days = parseInt(state.replace('editing_remove_confirm_', ''), 10);
    if (Number.isNaN(days) || days < 1) {
        await User.findOneAndUpdate({ telegramId: adminUser.telegramId }, { state: 'start' });
        return ctx.answerCbQuery('Invalid days.').catch(() => {});
    }

    await User.findOneAndUpdate({ telegramId: adminUser.telegramId }, { state: 'start' });

    return runRemoval(ctx, days, false);
};

export const handleRemoveResume = async (ctx) => {
    const removeState = await getRemoveState();
    if (!removeState || !['running', 'interrupted'].includes(removeState.status)) {
        await ctx.answerCbQuery('No removal job found.').catch(() => {});
        try {
            await ctx.editMessageText(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> No removal job to resume.`, { parse_mode: 'HTML' });
        } catch {}
        return;
    }

    if ((removeState.type || 'days') === 'lowdep') {
        return ctx.answerCbQuery('That job belongs to 💸 Remove Low Deposit.').catch(() => {});
    }

    return runRemoval(ctx, removeState.days, true);
};

export const handleRemoveNew = async (ctx) => {
    await clearRemoveState();
    await ctx.answerCbQuery('Old removal job cancelled.').catch(() => {});
    try {
        await ctx.editMessageText(`<tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Old removal job cancelled.\n\nUse <b>🗑️ Remove User</b> to start a new one.`, { parse_mode: 'HTML' });
    } catch {
        await ctx.reply(`<tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Old removal job cancelled. Use <b>🗑️ Remove User</b> to start a new one.`, { parse_mode: 'HTML' });
    }
};

export const handleRemoveLowDepositCommand = async (ctx) => {
    const state = await getRemoveState();
    if (state && (state.status === 'running' || state.status === 'interrupted')) {
        if ((state.type || 'days') !== 'lowdep') {
            return ctx.reply(
                `<b><tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> An inactive-user removal is already in progress.</b>\n\n` +
                `Finish or resume it via <b>🗑️ Remove User</b> first.`,
                { parse_mode: 'HTML' }
            );
        }
        const processed = state.processed?.length || 0;
        const pct = state.total > 0 ? Math.floor((processed / state.total) * 100) : 0;
        return ctx.reply(
            `<b><tg-emoji emoji-id="6174916816951842220">💸</tg-emoji> Incomplete low-deposit removal found!</b>\n\n` +
            `<b>Amount:</b> $${Number(state.amount ?? 0).toFixed(2)}\n` +
            `Progress: ${pct}% (${processed}/${state.total} users)\n` +
            `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Removed: ${state.removed} • <tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed: ${state.failed}\n\n` +
            `Use the buttons below:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback('▶️ Resume', 'more_remove_lowdep_resume'),
                            Markup.button.callback('🗑️ Cancel & Start New', 'more_remove_lowdep_new'),
                        ]
                    ]
                }
            }
        );
    }

    const user = await getOrCreateUser(ctx);
    user.state = 'editing_remove_lowdep_amount';
    await user.save();

    await ctx.reply(
        `<b><tg-emoji emoji-id="6174916816951842220">💸</tg-emoji> Remove Low Deposit Users</b>\n\n` +
        `Send the minimum deposit amount (numbers only) — users whose total deposit is below this will be removed from the VIP channels:`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        }
    );
};

const runLowDepRemoval = async (ctx, amount, resume) => {
    await ctx.answerCbQuery(resume ? 'Resuming removal...' : 'Removing low-deposit users...').catch(() => {});
    try {
        await ctx.editMessageText(`<b><tg-emoji emoji-id="6174916816951842220">💸</tg-emoji> Removing low-deposit users...</b>`, { parse_mode: 'HTML' });
    } catch {}

    const progressMsg = await ctx.reply(
        `<b>💸 Removing low-deposit users...</b>\n0/0 users (0%)`,
        { parse_mode: 'HTML' }
    );

    let lastEdit = 0;
    const onProgress = async (done, total, removed, failed) => {
        const now = Date.now();
        if (now - lastEdit < 1000) return;
        lastEdit = now;
        const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id, progressMsg.message_id, null,
                `<b>💸 Removing low-deposit users...</b>\n${done}/${total} users (${pct}%)\n` +
                `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Removed: ${removed} • <tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed: ${failed}`,
                { parse_mode: 'HTML' }
            );
        } catch {}
    };

    try {
        const result = await removeLowDepositUsers(ctx.telegram, amount, { onProgress, resume });
        const summary =
            `<b><tg-emoji emoji-id="6174916816951842220">💸</tg-emoji> Low-deposit removal complete</b>\n\n` +
            `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> <b>Below $${Number(amount).toFixed(2)} (with access):</b> ${result.total}\n` +
            `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> <b>Removed:</b> ${result.removed}\n` +
            `<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> <b>Failed:</b> ${result.failed}\n` +
            `<tg-emoji emoji-id="5938386156142989281">⏭️</tg-emoji> <b>Skipped:</b> ${result.skipped}\n` +
            `<tg-emoji emoji-id="5981194327110456280">📣</tg-emoji> <b>Notified:</b> ${result.notified}` +
            (result.notifyFailed ? `\n<tg-emoji emoji-id="5938290000415167172">🔕</tg-emoji> <b>Notice failed:</b> ${result.notifyFailed}` : '');
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null, summary, { parse_mode: 'HTML' });
        } catch {
            await ctx.reply(summary, { parse_mode: 'HTML' });
        }

        await sendFailureList(ctx, result.failedUsers);
        await sendFailureList(ctx, result.noticeFailedUsers, 'Notice failed users');
    } catch (err) {
        logger.error('Low-deposit bulk removal error:', err);
        if (err?.message?.includes('already running')) {
            await ctx.reply(`<tg-emoji emoji-id="5938558852482994666">⏳</tg-emoji> <b>A removal job is already running.</b>`, { parse_mode: 'HTML' });
        } else {
            await ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Removal interrupted. Use 💸 Remove Low Deposit to resume.`, { parse_mode: 'HTML' });
        }
    }
};

export const handleRemoveLowDepositConfirm = async (ctx) => {
    const adminUser = await getOrCreateUser(ctx);
    const state = adminUser.state || '';

    if (!state.startsWith('editing_remove_lowdep_confirm_')) {
        return ctx.answerCbQuery('Nothing to confirm.').catch(() => {});
    }

    const input = state.replace('editing_remove_lowdep_confirm_', '');
    const amount = parseFloat(input);
    if (Number.isNaN(amount) || amount <= 0) {
        await User.findOneAndUpdate({ telegramId: adminUser.telegramId }, { state: 'start' });
        return ctx.answerCbQuery('Invalid amount.').catch(() => {});
    }

    await User.findOneAndUpdate({ telegramId: adminUser.telegramId }, { state: 'start' });

    return runLowDepRemoval(ctx, amount, false);
};

export const handleRemoveLowDepositResume = async (ctx) => {
    const removeState = await getRemoveState();
    if (!removeState || !['running', 'interrupted'].includes(removeState.status)) {
        await ctx.answerCbQuery('No removal job found.').catch(() => {});
        try {
            await ctx.editMessageText(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> No removal job to resume.`, { parse_mode: 'HTML' });
        } catch {}
        return;
    }
    if ((removeState.type || 'days') !== 'lowdep') {
        return ctx.answerCbQuery('That job belongs to 🗑️ Remove User.').catch(() => {});
    }
    return runLowDepRemoval(ctx, removeState.amount, true);
};

export const handleRemoveLowDepositNew = async (ctx) => {
    await clearRemoveState();
    await ctx.answerCbQuery('Old removal job cancelled.').catch(() => {});
    try {
        await ctx.editMessageText(`<tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Old removal job cancelled.\n\nUse <b>💸 Remove Low Deposit</b> to start a new one.`, { parse_mode: 'HTML' });
    } catch {
        await ctx.reply(`<tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Old removal job cancelled. Use <b>💸 Remove Low Deposit</b> to start a new one.`, { parse_mode: 'HTML' });
    }
};

export const handleConfigMenu = async (ctx) => {
    const forwarding = await getConfig('forwarding', true);
    await ctx.reply('<b>⚙️ Bot Configuration</b>\n\nSelect a setting to update:', { parse_mode: 'HTML', reply_markup: { inline_keyboard: buildConfigMenu(forwarding) } });
};

export const handleChannelMenu = async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    try {
        await ctx.editMessageText('<b>📺 Channel Settings</b>\n\nSelect a channel to configure:', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buildChannelMenu() }
        });
    } catch {
        await ctx.reply('<b>📺 Channel Settings</b>\n\nSelect a channel to configure:', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buildChannelMenu() }
        });
    }
};

export const handleConfigBack = async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const forwarding = await getConfig('forwarding', true);
    try {
        await ctx.editMessageText('<b>⚙️ Bot Configuration</b>\n\nSelect a setting to update:', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buildConfigMenu(forwarding) }
        });
    } catch {
        await ctx.reply('<b>⚙️ Bot Configuration</b>\n\nSelect a setting to update:', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buildConfigMenu(forwarding) }
        });
    }
};

export const handleToggleForwarding = async (ctx) => {
    const current = await getConfig('forwarding', true);
    const next = !current;
    await setConfig('forwarding', next);
    await ctx.answerCbQuery(next ? '✅ Forwarding ON' : '❌ Forwarding OFF');
    try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: buildConfigMenu(next) });
    } catch {
        const forwarding = await getConfig('forwarding', true);
        await ctx.reply('<b>⚙️ Bot Configuration</b>\n\nSelect a setting to update:', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buildConfigMenu(forwarding) }
        });
    }
};

export const handleConfigCallback = async (ctx) => {
    const setting = ctx.match[1];
    const user = await getOrCreateUser(ctx);

    user.state = `editing_config_${setting}`;
    await user.save();

    const prompts = {
        'dep': 'Please send the new Minimum Deposit amount (numbers only):',
        'min_redeposit': 'Please send the new Minimum Redeposit amount required from removed users to regain access (numbers only):',
        'lid': 'Please send your new Quotex Affiliate LID:',
        'btn_join_channel': 'Please send the URL for the <b>Join Public Channel</b> button:',
        'support_id': 'Please send the Telegram username for support (e.g. softluma_support):',
        'forward_id': 'Please send the Telegram User ID to forward messages to (numbers only, e.g. 123456789):',
        'log_channel': 'Please send the Channel ID for the Log Channel (Make sure the bot is an admin in the channel):',
        'welcome_voice': 'Send a voice message directly to set as welcome audio, or paste a file_id / HTTP URL. Send "clear" to remove the current voice.',
        'welcome_video': 'Send a video message directly to set as welcome video, or paste a file_id / HTTP URL. Send "clear" to remove the current video.',
    };

    if (setting.startsWith('channel_')) {
        const idx = parseInt(setting.replace('channel_', ''), 10) + 1;
        prompts[setting] = `Please send the new Channel ID for Channel ${idx} (Make sure the bot is an admin in the channel):`;
    }

    const text = prompts[setting] || 'Please send the new value:';

    await ctx.answerCbQuery();
    await ctx.reply(`<b>✏️ Editing Setting:</b>\n\n${text}`, { 
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
    });
};

export const handleBroadcastCommand = async (ctx) => {
    const state = await getBroadcastState();
    if (state && (state.status === 'running' || state.status === 'interrupted')) {
        const pct = state.total > 0 ? Math.floor((state.skip / state.total) * 100) : 0;
        return ctx.reply(
            `<b><tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> Incomplete broadcast found!</b>\n\n` +
            `Progress: ${pct}% (${state.skip}/${state.total} users)\n` +
            `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> ${state.success} success • <tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> ${state.failed} failed\n\n` +
            `Reply to a message with /broadcast to start fresh, or use the buttons below:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback('▶️ Resume', 'bcast_resume'),
                            Markup.button.callback('🗑️ Cancel & Start New', 'bcast_new'),
                        ]
                    ]
                }
            }
        );
    }

    const user = await getOrCreateUser(ctx);
    user.state = 'editing_broadcast';
    await user.save();

    await ctx.reply(
        `<b><tg-emoji emoji-id="5981194327110456280">📢</tg-emoji> Broadcast</b>\n\nSend the message you want to broadcast to all users (text, photo, video, voice, etc.):`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        }
    );
};

export const handleBroadcastCallback = async (ctx) => {
    const action = ctx.match[1];
    const state = await getBroadcastState();

    if (!state || state.status !== 'running') {
        await ctx.answerCbQuery('No incomplete broadcast found.');
        return ctx.editMessageText(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> No incomplete broadcast to resume.`);
    }

    if (action === 'new') {
        await clearBroadcastState();
        await ctx.answerCbQuery('Old broadcast cancelled.');
        return ctx.editMessageText(`<tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Old broadcast cancelled. Reply to a message with /broadcast to start a new one.`);
    }

    await ctx.answerCbQuery('Resuming broadcast...');
        await ctx.editMessageText(`<tg-emoji emoji-id="5938069973535559743">▶️</tg-emoji> Resuming broadcast...`);

    const resumeSkip = state.skip || 0;

    const progressMsg = await ctx.reply(
        `<b>📡 Broadcasting...</b>\n0/${state.total} users (0%)`,
        { parse_mode: 'HTML' }
    );

    const onProgress = makeProgressCallback(ctx, progressMsg);

    try {
        const { successCount, failCount } = await broadcastMessage(
            ctx.telegram, state.sourceChatId, state.messageId, onProgress, resumeSkip
        );
        await ctx.reply(
            `<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Broadcast complete!</b>\n\n<tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> Total: ${state.total}\n<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Success: ${successCount}\n<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed: ${failCount}`,
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        logger.error('Broadcast execution error:', err);
        await ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Broadcast failed. Please try again.`);
    }
};

const runBroadcast = async (ctx, sourceChatId, messageId) => {
    const statusMsg = await ctx.reply(`<tg-emoji emoji-id="5981194327110456280">🚀</tg-emoji> Starting broadcast...`);
    const onProgress = makeProgressCallback(ctx, statusMsg);
    const { successCount, failCount } = await broadcastMessage(ctx.telegram, sourceChatId, messageId, onProgress);
    const state = await getBroadcastState();
    await ctx.reply(
        `<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Broadcast complete!</b>\n\n<tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> Total: ${state?.total || '?'}\n<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Success: ${successCount}\n<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed: ${failCount}`,
        { parse_mode: 'HTML' }
    );
};

export const executeBroadcast = async (ctx) => {
    if (!ctx.message.reply_to_message) {
        return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Please reply to the message you want to broadcast with /broadcast`);
    }

    const state = await getBroadcastState();
    if (state && state.status === 'running') {
        return ctx.reply(`<b><tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> There is already an incomplete broadcast. Use the broadcast button first to resume or cancel it.</b>`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [Markup.button.callback('📢 Manage Broadcast', 'bcast_resume')]
                    ]
                }
            }
        );
    }

    await clearBroadcastState();

    try {
        await runBroadcast(ctx, ctx.message.chat.id, ctx.message.reply_to_message.message_id);
    } catch (err) {
        logger.error('Broadcast execution error:', err);
        await ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Broadcast failed. Please try again.`);
    }
};

export const handleReportCommand = async (ctx) => {
    const user = await getOrCreateUser(ctx);
    user.state = 'editing_report_format';
    await user.save();

    await ctx.reply(
        `<b>✏️ Inactive Traders Report</b>\n\nSelect the report format:`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback('📊 Excel (.xlsx)', 'report_format_excel')],
                    [Markup.button.callback('📄 PDF', 'report_format_pdf')],
                    [Markup.button.callback('❌ Cancel', 'cancel_edit')],
                ]
            }
        }
    );
};

export const handleReportFormat = async (ctx) => {
    const format = ctx.match[1];
    if (!['excel', 'pdf'].includes(format)) {
        return ctx.answerCbQuery('Invalid format.');
    }

    const user = await getOrCreateUser(ctx);
    user.state = `editing_report_days_${format}`;
    await user.save();

    const text = `<b>✏️ Inactive Traders Report (${format === 'pdf' ? 'PDF' : 'Excel'})</b>\n\nSend the number of days (numbers only):`;
    await ctx.answerCbQuery().catch(() => {});
    try {
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        });
    } catch {
        await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        });
    }
};

export const viewStats = async (ctx) => {
    const [userCount, traderCount, verifiedTraders, noDeposit, totals] = await Promise.all([
        User.countDocuments(),
        Trader.countDocuments(),
        Trader.countDocuments({ $or: [{ first_deposit: true }, { deposited: true }] }),
        Trader.countDocuments({ registered: true, deposited: { $ne: true }, first_deposit: { $ne: true } }),
        Trader.aggregate([
            { $group: { _id: null, totalDep: { $sum: '$sumdep' }, totalWith: { $sum: '$sumwithdraw' } } }
        ]),
    ]);
    const totalDep = totals[0]?.totalDep || 0;
    const totalWith = totals[0]?.totalWith || 0;
    await ctx.reply(
        `<b><tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> System Stats</b>\n\n` +
        `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> Total Users: ${userCount}\n\n` +
        `<tg-emoji emoji-id="5938517659451658781">📈</tg-emoji> Total Traders: ${traderCount}\n\n` +
        `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> With Deposits: ${verifiedTraders}\n\n` +
        `<tg-emoji emoji-id="5938386156142989281">📋</tg-emoji> Registered (no deposit): ${noDeposit}\n\n` +
        `<tg-emoji emoji-id="5938531235843283484">💵</tg-emoji> Total Deposits: $${totalDep.toFixed(2)}\n\n` +
        `<tg-emoji emoji-id="5938074049459523495">💳</tg-emoji> Total Withdrawals: $${totalWith.toFixed(2)}`,
        { parse_mode: 'HTML' }
    );
};

export const handleSearchCommand = async (ctx) => {
    const user = await getOrCreateUser(ctx);
    user.state = 'editing_search_user';
    await user.save();

    await ctx.reply(
        `<b><tg-emoji emoji-id="5938517659451658781">🔍</tg-emoji> Search User</b>\n\nSend a <b>Trader ID</b> or <b>Telegram ID</b> to search:`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        }
    );
};

export const handleUnlinkCommand = async (ctx) => {
    const user = await getOrCreateUser(ctx);
    user.state = 'editing_unlink_id';
    await user.save();

    await ctx.reply(
        `<b><tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> Unlink Trader ID</b>\n\nSend the Trader ID to unlink:`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Cancel', 'cancel_edit')]] }
        }
    );
};

const buildUnlinkConfirmKeyboard = (traderId) => ({
    inline_keyboard: [
        [
            Markup.button.callback('✅ Unlink', `unlink_confirm_${traderId}`),
            Markup.button.callback('❌ Cancel', 'cancel_edit'),
        ]
    ]
});

export const handleUnlinkConfirm = async (ctx) => {
    const traderId = ctx.match[1];

    const trader = await Trader.findOne({ trader_id: traderId }).lean();
    if (!trader) {
        await ctx.answerCbQuery('Trader not found.').catch(() => {});
        try {
            await ctx.editMessageText(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Trader ID not found.`, { parse_mode: 'HTML' });
        } catch {}
        return;
    }

    const linkedUser = await User.findOne({
        $or: [
            { trader_id: traderId },
            ...(trader.telegramId ? [{ telegramId: trader.telegramId }] : []),
        ]
    }).lean();

    if (!linkedUser || !linkedUser.trader_id) {
        await ctx.answerCbQuery('No account linked.').catch(() => {});
        try {
            await ctx.editMessageText(`<tg-emoji emoji-id="5938558852482994666">ℹ️</tg-emoji> No Telegram account is linked to this Trader ID.`, { parse_mode: 'HTML' });
        } catch {}
        return;
    }

    const telegramId = linkedUser.telegramId;
    const rateLimitFn = createRateLimiter();

    const channelIds = await getConfig('channel_ids', ['', '', '', '', '']);
    const vipChannels = (Array.isArray(channelIds) ? channelIds : []).filter((id) => id && String(id).trim()).map(String);

    let removedChannels = 0;
    let failedChannels = 0;
    let skippedChannels = 0;

    for (const chId of vipChannels) {
        const result = await removeFromChannelWithRetry(ctx.telegram, chId, telegramId, rateLimitFn);
        if (result.action === 'kicked') removedChannels++;
        else if (result.action === 'error') failedChannels++;
        else skippedChannels++;
    }

    if (linkedUser.invite_link) {
        let inviteMap = {};
        try { inviteMap = JSON.parse(linkedUser.invite_link); } catch {}
        for (const [chId, link] of Object.entries(inviteMap)) {
            if (link) {
                try {
                    await rateLimitFn();
                    await ctx.telegram.revokeChatInviteLink(chId, link);
                } catch {}
            }
        }
    }

    await User.updateOne(
        { telegramId },
        { trader_id: null, access_granted: false, invite_link: null }
    );

    await Trader.updateOne({ trader_id: traderId }, { telegramId: null });

    await ctx.telegram.sendMessage(
        telegramId,
        `<b><tg-emoji emoji-id="6174916816951842220">⚠️</tg-emoji> Your Trader ID <code>${escapeHtml(traderId)}</code> has been unlinked by the admin and you were removed from the VIP channels.</b>\n\n` +
        `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Contact support if you have any questions.</b>`,
        { parse_mode: 'HTML' }
    ).catch((err) => logger.warn('Failed to notify unlinked user:', err.message));

    await ctx.answerCbQuery('Unlinked successfully.').catch(() => {});

    const summary =
        `<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Trader ID <code>${escapeHtml(traderId)}</code> unlinked</b>\n\n` +
        `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> <b>User:</b> ${escapeHtml([linkedUser.firstName, linkedUser.lastName].filter(Boolean).join(' ') || 'N/A')}\n` +
        `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Telegram ID:</b> <code>${telegramId}</code>\n` +
        `<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Channels:</b> ${removedChannels} removed • ${failedChannels} failed • ${skippedChannels} skipped\n` +
        `<tg-emoji emoji-id="5981194327110456280">📣</tg-emoji> <b>User notified:</b> ✅`;

    try {
        await ctx.editMessageText(summary, { parse_mode: 'HTML' });
    } catch {
        await ctx.reply(summary, { parse_mode: 'HTML' });
    }
};

export const handleCancelEdit = async (ctx) => {
    const user = await getOrCreateUser(ctx);
    if (user && (user.state?.startsWith('editing_') || user.state === 'remove_days')) {
        notifyCache.delete(user.telegramId);
        clearManualPbSession(user.telegramId);
        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
    }
    await ctx.answerCbQuery('Cancelled.');
    try {
        await ctx.editMessageText(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Edit cancelled.`, { parse_mode: 'HTML' });
    } catch {
        await ctx.reply(`<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Edit cancelled.</b>`, { parse_mode: 'HTML' });
    }
};

export const handleAdminMessageUpdate = async (ctx, user) => {
    const text = ctx.message.text || ctx.message.caption || '';

    if (text === '❌ Cancel') {
        notifyCache.delete(user.telegramId);
        clearManualPbSession(user.telegramId);
        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
        return ctx.reply(`<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Operation Cancelled</b>`, { parse_mode: 'HTML' });
    }

    if (user.state?.startsWith('editing_manual_pb_')) {
        return handleManualPostbackMessage(ctx, user);
    }

    if (user.state === 'editing_broadcast') {
        const broadcastState = await getBroadcastState();
        if (broadcastState && broadcastState.status === 'running') {
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<b><tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> A broadcast is already running. Manage it with the buttons below:</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                Markup.button.callback('▶️ Resume', 'bcast_resume'),
                                Markup.button.callback('🗑️ Cancel & Start New', 'bcast_new'),
                            ]
                        ]
                    }
                }
            );
        }

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });

        try {
            await runBroadcast(ctx, ctx.message.chat.id, ctx.message.message_id);
        } catch (err) {
            logger.error('Broadcast execution error:', err);
            await ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Broadcast failed. Please try again.`);
        }
        return;
    }

    if (user.state === 'editing_search_user') {
        if (!text || !text.trim()) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Please send a Trader ID or Telegram ID.`, { parse_mode: 'HTML' });

        const query = text.trim();
        const telegramNum = /^\d+$/.test(query) ? Number(query) : null;

        const [foundUsers, trader] = await Promise.all([
            User.find({
                $or: [
                    ...(telegramNum ? [{ telegramId: telegramNum }] : []),
                    { trader_id: query },
                ]
            }).lean(),
            Trader.findOne({
                $or: [
                    { trader_id: query },
                    ...(telegramNum ? [{ telegramId: telegramNum }] : []),
                ]
            }).lean(),
        ]);

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });

        if (foundUsers.length === 0 && !trader) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> <b>No user found</b> for <b>Trader ID / Telegram ID:</b> <code>${escapeHtml(query)}</code>`, { parse_mode: 'HTML' });
        }

        const formatDate = (date) => {
            if (!date) return 'N/A';
            const d = new Date(date);
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };

        const ACTIVITY_STATUSES = ['dep', 'ftd', 'withdrawal'];
        const analyseTrader = (t) => {
            const events = t.events || [];
            const isDeposit = (e) => ['dep', 'ftd'].includes(e.status) || (e.sumdep && e.sumdep > 0);
            const isWithdrawal = (e) => e.status === 'withdrawal' || (e.sumwithdraw && e.sumwithdraw > 0);
            const isActivity = (e) => ACTIVITY_STATUSES.includes(e.status) || isDeposit(e) || isWithdrawal(e);
            const depCount = events.filter(isDeposit).length;
            const ftdCount = events.filter((e) => e.status === 'ftd').length;
            const wdCount = events.filter(isWithdrawal).length;
            const lastActivity = events.reduce(
                (max, e) => (isActivity(e) && (!max || new Date(e.date) > new Date(max)) ? e.date : max),
                null
            );
            const inactiveDays = lastActivity
                ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86400000)
                : null;
            return { events, depCount, ftdCount, wdCount, lastActivity, inactiveDays };
        };

        const parts = [];

        if (foundUsers.length > 0) {
            parts.push(`<b><tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> Telegram Users (${foundUsers.length})</b>`);
            for (const u of foundUsers) {
                parts.push(
                    `<tg-emoji emoji-id="5210956306952758910">👤</tg-emoji> <b>Name:</b> ${escapeHtml([u.firstName, u.lastName].filter(Boolean).join(' ') || 'N/A')}\n` +
                    `<tg-emoji emoji-id="5215668805199473901">📣</tg-emoji> <b>Username:</b> ${u.username ? '@' + escapeHtml(u.username) : 'N/A'}\n` +
                    `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Telegram ID:</b> <code>${u.telegramId}</code>\n` +
                    `<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Trader ID:</b> ${u.trader_id ? `<code>${escapeHtml(u.trader_id)}</code>` : 'Not linked'}\n` +
                    `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> <b>Access:</b> ${u.access_granted ? 'Granted' : 'Not granted'}\n` +
                    `<tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> <b>Joined:</b> ${formatDate(u.createdAt)}\n` +
                    `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>State:</b> <code>${escapeHtml(u.state || 'start')}</code>`
                );
            }
        }

        if (trader) {
            parts.push(`<b><tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> Trader</b>`);
            parts.push(
                `<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Trader ID:</b> <code>${escapeHtml(trader.trader_id)}</code>\n` +
                `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Deposit:</b> $${(trader.sumdep || 0).toFixed(2)}\n` +
                `<tg-emoji emoji-id="5938074049459523495">💳</tg-emoji> <b>Withdraw:</b> $${(trader.sumwithdraw || 0).toFixed(2)}\n` +
                `<tg-emoji emoji-id="5938264290740933445">🎯</tg-emoji> <b>Country:</b> ${escapeHtml(trader.country || 'N/A')}\n` +
                `<tg-emoji emoji-id="5938517659451658781">📝</tg-emoji> <b>Events:</b> ${(trader.events || []).length}` +
                (trader.telegramId ? `\n<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Linked Telegram ID:</b> <code>${trader.telegramId}</code>` : '')
            );

            const a = analyseTrader(trader);
            const net = (trader.sumdep || 0) - (trader.sumwithdraw || 0);
            const isActive = a.lastActivity && a.inactiveDays <= 30;
            const activityLabel = a.lastActivity
                ? (isActive
                    ? `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> <b>Active</b> (last activity ${a.inactiveDays} day${a.inactiveDays === 1 ? '' : 's'} ago)`
                    : `<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>Inactive</b> (${a.inactiveDays} day${a.inactiveDays === 1 ? '' : 's'} since last activity)`)
                : `<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>No activity recorded</b>`;

            parts.push(
                `<b><tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> Analysis</b>\n` +
                `<tg-emoji emoji-id="5938517659451658781">📈</tg-emoji> <b>Deposits:</b> ${a.depCount} ($${(trader.sumdep || 0).toFixed(2)})\n` +
                `<tg-emoji emoji-id="5938074049459523495">💳</tg-emoji> <b>Withdrawals:</b> ${a.wdCount} ($${(trader.sumwithdraw || 0).toFixed(2)})\n` +
                `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Net:</b> $${net.toFixed(2)}\n` +
                `<tg-emoji emoji-id="5212985021870123409">⏳</tg-emoji> <b>Last Activity:</b> ${formatDate(a.lastActivity)}\n` +
                activityLabel
            );
        }

        return ctx.reply(parts.join('\n\n'), { parse_mode: 'HTML' });
    }

    if (user.state === 'editing_unlink_id') {
        const traderId = (text || '').trim();
        if (!traderId) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Please send a Trader ID.`, { parse_mode: 'HTML' });
        }

        const trader = await Trader.findOne({ trader_id: traderId }).lean();
        if (!trader) {
            return ctx.reply(
                `<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> <b>Invalid Trader ID</b> — no trader with ID <code>${escapeHtml(traderId)}</code> was found in the system. Try again:`,
                { parse_mode: 'HTML' }
            );
        }

        const linkedUser = await User.findOne({
            $or: [
                { trader_id: traderId },
                ...(trader.telegramId ? [{ telegramId: trader.telegramId }] : []),
            ]
        }).lean();

        if (!linkedUser || !linkedUser.trader_id) {
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(
                `<tg-emoji emoji-id="5938558852482994666">ℹ️</tg-emoji> <b>No account linked</b> — Trader ID <code>${escapeHtml(traderId)}</code> exists but is not linked to any Telegram account.`,
                { parse_mode: 'HTML' }
            );
        }

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: `editing_unlink_confirm_${traderId}` });

        const confirmText =
            `<b><tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> Unlink Trader ID</b>\n\n` +
            `<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Trader ID:</b> <code>${escapeHtml(traderId)}</code>\n` +
            `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Deposit:</b> $${(trader.sumdep || 0).toFixed(2)}\n` +
            `<tg-emoji emoji-id="5210956306952758910">👤</tg-emoji> <b>Name:</b> ${escapeHtml([linkedUser.firstName, linkedUser.lastName].filter(Boolean).join(' ') || 'N/A')}\n` +
            `<tg-emoji emoji-id="5215668805199473901">📣</tg-emoji> <b>Username:</b> ${linkedUser.username ? '@' + escapeHtml(linkedUser.username) : 'N/A'}\n` +
            `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Telegram ID:</b> <code>${linkedUser.telegramId}</code>\n\n` +
            `<tg-emoji emoji-id="6174916816951842220">⚠️</tg-emoji> <b>They will be removed from the VIP channels and notified. Confirm?</b>`;

        return ctx.reply(confirmText, {
            parse_mode: 'HTML',
            reply_markup: buildUnlinkConfirmKeyboard(traderId)
        });
    }

    if (user.state === 'editing_notify_days') {
        if (!text || !/^\d{1,4}$/.test(text.trim())) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Days must be a valid number (1-3650). Try again:`, { parse_mode: 'HTML' });
        }

        const days = parseInt(text.trim(), 10);
        if (days < 1 || days > 3650) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Days must be between 1 and 3650. Try again:`, { parse_mode: 'HTML' });
        }

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: `editing_notify_confirm_${days}` });

        await ctx.reply(`<tg-emoji emoji-id="5981194327110456280">🚀</tg-emoji> Analyzing inactive users (last <b>${days}</b> days)...`, { parse_mode: 'HTML' });

        let entries;
        try {
            entries = await buildInactiveReport(days);
        } catch (err) {
            logger.error('Inactive analysis error:', err);
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed to analyze inactive users. Try again.`, { parse_mode: 'HTML' });
        }

        if (entries.length === 0) {
            notifyCache.delete(user.telegramId);
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> No inactive traders found in the last <b>${days}</b> days.`, { parse_mode: 'HTML' });
        }

        notifyCache.set(user.telegramId, { days, entries });

        return ctx.reply(
            `<b><tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> Inactive users found: <b>${entries.length}</b> (last ${days} days)</b>\n\n` +
            `<b>Send the inactivity reminder to all of them?</b>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback('✅ Send Reminder', 'notify_confirm'),
                            Markup.button.callback('❌ Cancel', 'cancel_edit'),
                        ]
                    ]
                }
            }
        );
    }

    if (user.state === 'remove_days') {
        if (!text || !/^\d{1,4}$/.test(text.trim())) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Days must be a valid number (1-3650). Try again:`, { parse_mode: 'HTML' });
        }

        const days = parseInt(text.trim(), 10);
        if (days < 1 || days > 3650) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Days must be between 1 and 3650. Try again:`, { parse_mode: 'HTML' });
        }

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: `editing_remove_confirm_${days}` });

        await ctx.reply(`<tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Analyzing inactive users (last <b>${days}</b> days)...`, { parse_mode: 'HTML' });

        let rows;
        try {
            rows = await findInactiveTraders(days);
        } catch (err) {
            logger.error('Inactive analysis error:', err);
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed to analyze inactive users. Try again.`, { parse_mode: 'HTML' });
        }

        const actionable = rows.filter((r) => r.access_granted);

        if (actionable.length === 0) {
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> No inactive users with channel access in the last <b>${days}</b> days.`, { parse_mode: 'HTML' });
        }

        return ctx.reply(
            `<b><tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> Inactive users found: <b>${rows.length}</b> (last ${days} days)</b>\n\n` +
            `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> <b>With channel access:</b> ${actionable.length}\n\n` +
            `<b>They will be removed from the VIP channels, their invite links revoked, and they will be notified. Confirm?</b>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback('✅ Confirm Removal', `more_remove_confirm_${days}`),
                            Markup.button.callback('❌ Cancel', 'cancel_edit'),
                        ]
                    ]
                }
            }
        );
    }

    if (user.state === 'editing_remove_lowdep_amount') {
        if (!text || !/^\d+(\.\d{1,2})?$/.test(text.trim())) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Amount must be a valid number (max 2 decimals). Try again:`, { parse_mode: 'HTML' });
        }

        const input = text.trim();
        const amount = parseFloat(input);
        if (!(amount > 0)) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Amount must be greater than 0. Try again:`, { parse_mode: 'HTML' });
        }

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: `editing_remove_lowdep_confirm_${input}` });

        await ctx.reply(`<tg-emoji emoji-id="6174916816951842220">💸</tg-emoji> Analyzing users with total deposit below <b>$${input}</b>...`, { parse_mode: 'HTML' });

        let rows;
        try {
            rows = await findLowDepositTraders(amount);
        } catch (err) {
            logger.error('Low-deposit analysis error:', err);
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed to analyze users. Try again.`, { parse_mode: 'HTML' });
        }

        const actionable = rows.filter((r) => r.access_granted);

        if (actionable.length === 0) {
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> No users with VIP access have deposit below <b>$${input}</b>.`, { parse_mode: 'HTML' });
        }

        return ctx.reply(
            `<b><tg-emoji emoji-id="6174916816951842220">💸</tg-emoji> Users with deposit below $${input}: <b>${rows.length}</b></b>\n\n` +
            `<tg-emoji emoji-id="5938167138580741203">👥</tg-emoji> <b>With VIP access:</b> ${actionable.length}\n\n` +
            `<b>They will be removed from the VIP channels, their invite links revoked, and they will be notified. Confirm?</b>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback('✅ Confirm Removal', 'more_remove_lowdep_confirm'),
                            Markup.button.callback('❌ Cancel', 'cancel_edit'),
                        ]
                    ]
                }
            }
        );
    }

    if (user.state?.startsWith('editing_config_')) {
        const setting = user.state.replace('editing_config_', '');

        if (setting === 'welcome_voice' && ctx.message.voice) {
            const fileId = ctx.message.voice.file_id;
            await setConfig('welcome_voice', fileId);
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Welcome voice set.`, { parse_mode: 'HTML' });
        }

        if (setting === 'welcome_video' && ctx.message.video) {
            const fileId = ctx.message.video.file_id;
            await setConfig('welcome_video', fileId);
            await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
            return ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Welcome video set.`, { parse_mode: 'HTML' });
        }

        if (!ctx.message.text) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Please send text/numbers only for configuration.`, { parse_mode: 'HTML' });

        if (setting === 'dep') {
            const num = parseFloat(text);
            if (Number.isNaN(num) || num < 0) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Deposit must be a valid positive number. Try again:`, { parse_mode: 'HTML' });
            await setConfig('min_deposit', num);
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Minimum deposit set to $${num}`, { parse_mode: 'HTML' });
        } else if (setting === 'min_redeposit') {
            const num = parseFloat(text);
            if (Number.isNaN(num) || num < 0) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Redeposit must be a valid positive number. Try again:`, { parse_mode: 'HTML' });
            await setConfig('min_deposit_removed', num);
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Minimum redeposit for removed users set to $${num}`, { parse_mode: 'HTML' });
        } else if (setting === 'lid') {
            if (!text.trim()) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> LID cannot be empty.`, { parse_mode: 'HTML' });
            await setConfig('affiliate_lid', text.trim());
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Affiliate LID set to ${text.trim()}`, { parse_mode: 'HTML' });
        } else if (setting.startsWith('channel_')) {
            if (!text.trim()) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Channel ID cannot be empty.`, { parse_mode: 'HTML' });
            try {
                await ctx.telegram.getChat(text.trim());
            } catch {
                return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Invalid channel ID or the bot is not an admin in this channel. Verify and try again.`, { parse_mode: 'HTML' });
            }
            const idx = parseInt(setting.replace('channel_', ''), 10);
            const ids = await getConfig('channel_ids', ['', '', '', '', '']);
            ids[idx] = text.trim();
            await setConfig('channel_ids', ids);
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Channel ${idx + 1} ID set to ${text.trim()}`, { parse_mode: 'HTML' });
        } else if (setting === 'log_channel') {
            if (!text.trim()) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Channel ID cannot be empty.`, { parse_mode: 'HTML' });
            try {
                await ctx.telegram.getChat(text.trim());
            } catch {
                return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Invalid channel ID or the bot is not an admin in this channel. Verify and try again.`, { parse_mode: 'HTML' });
            }
            await setConfig('log_channel_id', text.trim());
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Log channel set to ${text.trim()}`, { parse_mode: 'HTML' });
        } else if (setting === 'btn_join_channel') {
            await setConfig('btn_join_channel', text);
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Join Public Channel URL has been updated!`, { parse_mode: 'HTML' });
        } else if (setting === 'support_id') {
            const username = text.replace(/^@/, '').trim();
            if (!username) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Username cannot be empty. Try again:`, { parse_mode: 'HTML' });
            await setConfig('support_id', username);
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Support account set to @${username}`, { parse_mode: 'HTML' });
        } else if (setting === 'forward_id') {
            const num = parseInt(text.trim(), 10);
            if (Number.isNaN(num)) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Forward ID must be a valid number. Try again:`, { parse_mode: 'HTML' });
            await setConfig('forwarding_target_id', num);
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Forward target ID set to ${num}`, { parse_mode: 'HTML' });
        } else if (setting === 'welcome_voice') {
            const val = text.trim();
            if (val.toLowerCase() === 'clear') {
                await setConfig('welcome_voice', '');
                return ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Welcome voice removed.`, { parse_mode: 'HTML' });
            }
            if (!val) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> File ID cannot be empty. Send "clear" to remove.`, { parse_mode: 'HTML' });

            const isUrl = /^https?:\/\//i.test(val);
            if (!isUrl) {
                try {
                    await ctx.telegram.getFile(val);
                } catch {
                    return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Invalid file ID — it may belong to a different bot. Send a voice message directly, or paste a valid file_id / HTTP URL.`, { parse_mode: 'HTML' });
                }
            }

            await setConfig('welcome_voice', val);
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Welcome voice set.`, { parse_mode: 'HTML' });
        } else if (setting === 'welcome_video') {
            const val = text.trim();
            if (val.toLowerCase() === 'clear') {
                await setConfig('welcome_video', '');
                return ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Welcome video removed.`, { parse_mode: 'HTML' });
            }
            if (!val) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> File ID cannot be empty. Send "clear" to remove.`, { parse_mode: 'HTML' });

            const isUrl = /^https?:\/\//i.test(val);
            if (!isUrl) {
                try {
                    await ctx.telegram.getFile(val);
                } catch {
                    return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Invalid file ID — it may belong to a different bot. Send a video message directly, or paste a valid file_id / HTTP URL.`, { parse_mode: 'HTML' });
                }
            }

            await setConfig('welcome_video', val);
            await ctx.reply(`<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Welcome video set.`, { parse_mode: 'HTML' });
        }

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
        return;
    }

    if (user.state?.startsWith('editing_report_days')) {
        if (!text) return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Please send numbers only. Try again:`, { parse_mode: 'HTML' });

        const daysInput = text.trim();
        if (!/^\d{1,4}$/.test(daysInput)) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Days must be a valid number (1-3650). Try again:`, { parse_mode: 'HTML' });
        }

        const days = parseInt(daysInput, 10);
        if (days < 1 || days > 3650) {
            return ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Days must be between 1 and 3650. Try again:`, { parse_mode: 'HTML' });
        }

        const format = user.state.endsWith('_pdf') ? 'pdf' : 'excel';

        await User.findOneAndUpdate({ telegramId: user.telegramId }, { state: 'start' });
        await ctx.reply(`<tg-emoji emoji-id="5981194327110456280">🚀</tg-emoji> Generating inactive traders report for the last <b>${days}</b> days (${format === 'pdf' ? 'PDF' : 'Excel'})...`, { parse_mode: 'HTML' });

        try {
            const entries = await buildInactiveReport(days);
            await sendInactiveReport(ctx, entries, days, format);
        } catch (err) {
            logger.error('Report generation error:', err);
            await ctx.reply(`<tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed to generate report. Please try again.`, { parse_mode: 'HTML' });
        }
        return;
    }
};
