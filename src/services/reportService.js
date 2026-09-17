import { Input } from 'telegraf';
import ExcelJS from 'exceljs';
import PDFMake from 'pdfmake/build/pdfmake.js';
import vfsFonts from 'pdfmake/build/vfs_fonts.js';
import { Trader } from '../models/Trader.js';
import { User } from '../models/User.js';
import { getConfig, setConfig, patchConfig } from './adminService.js';
import logger from '../utils/logger.js';

PDFMake.vfs = vfsFonts.pdfMake?.vfs || vfsFonts.vfs;

const ACTIVITY_STATUSES = ['dep', 'ftd', 'withdrawal'];
const DEPOSIT_STATUSES = ['dep', 'ftd'];

const REMOVE_MAX_RETRIES = 3;
const REMOVE_RATE_PER_SEC = 20;
const REMOVE_SLEEP_MS = 300;
const REMOVE_CONCURRENCY = 5;
const REMOVE_BULK_CHUNK = 50;
const REMOVE_STATE_FLUSH_EVERY = 25;

let removalInProgress = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let floodUntil = 0;

export const notifyFlood = (ms) => {
    floodUntil = Math.max(floodUntil, Date.now() + ms);
};

const waitForFlood = async () => {
    while (Date.now() < floodUntil) await sleep(floodUntil - Date.now());
};

export const createRateLimiter = () => {
    let timestamps = [];
    return async () => {
        await waitForFlood();
        const now = Date.now();
        timestamps = timestamps.filter((t) => now - t < 1000);
        if (timestamps.length >= REMOVE_RATE_PER_SEC) {
            const wait = 1000 - (now - timestamps[0]);
            if (wait > 0) await sleep(wait);
            await waitForFlood();
        }
        timestamps.push(Date.now());
    };
};

export const runPool = async (items, worker, size = REMOVE_CONCURRENCY) => {
    let idx = 0;
    const n = Math.min(size, items.length);
    const workers = Array.from({ length: n }, async () => {
        while (true) {
            const i = idx++;
            if (i >= items.length) break;
            await worker(items[i], i);
        }
    });
    await Promise.all(workers);
};

const formatDate = (date) => {
    if (!date) return 'N/A';
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const lastEventDate = (events, statuses) => {
    let max = null;
    for (const event of events || []) {
        if (event.date && statuses.includes(event.status) && (!max || new Date(event.date) > new Date(max))) {
            max = event.date;
        }
    }
    return max;
};

const buildDisplayName = (user, traderId) => {
    if (!user) return String(traderId || 'N/A');
    const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    if (full) return full;
    if (user.username) return `@${user.username}`;
    return String(traderId || 'N/A');
};

const toRow = (entry) => [
    formatDate(entry.createdAt),
    String(entry.name),
    `@${entry.username}`,
    String(entry.telegramId),
    String(entry.traderId),
    Number(entry.totalDeposit).toFixed(2),
    Number(entry.totalWithdraw).toFixed(2),
    formatDate(entry.lastDepositDate),
];

const HEADERS = ['Created', 'Name', 'Username', 'Telegram ID', 'Trader ID', 'Total Deposit', 'Total Withdraw', 'Last Deposit'];

export const buildInactiveReport = async (days) => {
    const cutoff = new Date(Date.now() - days * 86400000);

    const activeIds = await Trader.distinct('_id', {
        events: {
            $elemMatch: {
                status: { $in: ACTIVITY_STATUSES },
                date: { $gte: cutoff }
            }
        }
    });

    const traders = await Trader.find({ _id: { $nin: activeIds } })
        .sort({ createdAt: -1 })
        .lean();

    if (traders.length === 0) return [];

    const telegramIds = traders.filter((t) => t.telegramId).map((t) => t.telegramId);
    const traderIds = traders.map((t) => t.trader_id);

    const users = await User.find({
        $or: [
            { telegramId: { $in: telegramIds } },
            { trader_id: { $in: traderIds } }
        ]
    }).lean();

    const byTelegramId = new Map();
    const byTraderId = new Map();
    for (const user of users) {
        byTelegramId.set(String(user.telegramId), user);
        if (user.trader_id) byTraderId.set(user.trader_id, user);
    }

    return traders
        .filter((trader) => {
            const linkedUser = (trader.telegramId && byTelegramId.get(String(trader.telegramId)))
                || byTraderId.get(trader.trader_id);
            return Boolean(linkedUser);
        })
        .map((trader) => {
            const user = (trader.telegramId && byTelegramId.get(String(trader.telegramId)))
                || byTraderId.get(trader.trader_id)
                || null;

            return {
                createdAt: trader.createdAt,
                name: buildDisplayName(user, trader.trader_id),
                username: user?.username || 'N/A',
                telegramId: user?.telegramId || trader.telegramId || 'N/A',
                traderId: trader.trader_id,
                totalDeposit: trader.sumdep || 0,
                totalWithdraw: trader.sumwithdraw || 0,
                lastDepositDate: lastEventDate(trader.events, DEPOSIT_STATUSES),
            };
        });
};

export const buildExcelBuffer = async (entries) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Quotex Bot';
    const sheet = workbook.addWorksheet('Inactive Traders');

    sheet.columns = HEADERS.map((header) => ({
        header,
        key: header.replace(/\s+/g, '').toLowerCase(),
        width: Math.max(header.length + 4, 18),
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
    headerRow.alignment = { vertical: 'middle' };
    headerRow.height = 20;

    for (const entry of entries) {
        const row = toRow(entry);
        const values = {};
        HEADERS.forEach((header, i) => {
            values[header.replace(/\s+/g, '').toLowerCase()] = row[i];
        });
        sheet.addRow(values);
    }

    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS.length } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
};

export const buildPdfBuffer = (entries, days) => {
    const ALIGNMENTS = ['center', 'left', 'left', 'center', 'center', 'right', 'right', 'center'];
    const body = entries.map((entry) =>
        toRow(entry).map((cell, i) => ({
            text: String(cell),
            alignment: ALIGNMENTS[i],
            bold: i === 5 || i === 6,
        }))
    );

    const docDefinition = {
        pageOrientation: 'landscape',
        pageSize: 'A4',
        pageMargins: [24, 40, 70, 40],
        content: [
            { text: 'Inactive Traders Report', style: 'title' },
            { text: `Period: last ${days} days  •  Generated: ${formatDate(new Date())}  •  Total: ${entries.length}`, style: 'subtitle' },
            {
                layout: {
                    fillColor: (rowIndex) => (rowIndex % 2 === 0 ? '#F2F4F8' : null),
                    hLineWidth: (rowIndex, node) => (rowIndex === 0 ? 2 : (rowIndex === node.table.body.length ? 1 : 0.5)),
                    hLineColor: (rowIndex) => (rowIndex === 0 ? '#305496' : '#CCCCCC'),
                    vLineWidth: () => 0.5,
                    vLineColor: () => '#DDDDDD',
                    paddingTop: () => 4,
                    paddingBottom: () => 4,
                    paddingLeft: () => 5,
                    paddingRight: () => 5,
                },
                table: {
                    headerRows: 1,
                    widths: [75, '*', 105, 70, 95, 90, 90, 105],
                    body: [
                        HEADERS.map((header, i) => ({
                            text: header,
                            style: 'tableHeader',
                            alignment: ALIGNMENTS[i],
                        })),
                        ...body,
                    ],
                },
            },
            { text: '— End of Report —', alignment: 'center', margin: [0, 24, 0, 0], color: '#999999', fontSize: 8 },
        ],
        styles: {
            title: { fontSize: 16, bold: true, alignment: 'center', margin: [0, 0, 0, 4] },
            subtitle: { fontSize: 9, alignment: 'center', margin: [0, 0, 0, 12], color: '#555555' },
            tableHeader: { bold: true, fontSize: 9, color: '#FFFFFF', fillColor: '#305496' },
        },
        defaultStyle: { fontSize: 9 },
    };

    return new Promise((resolve, reject) => {
        try {
            const pdfDoc = PDFMake.createPdf(docDefinition);
            pdfDoc.getBuffer((buffer) => resolve(Buffer.from(buffer)));
        } catch (err) {
            reject(err);
        }
    });
};

export const sendInactiveReport = async (ctx, entries, days, format = 'excel') => {
    const caption = `<b><tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> Inactive Traders Report (last ${days} days)</b>\n\n<b>Total:</b> ${entries.length}`;

    if (entries.length === 0) {
        return ctx.reply(`<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> No inactive traders found in the last ${days} days.</b>`, { parse_mode: 'HTML' });
    }

    const isPdf = format === 'pdf';

    try {
        const buffer = isPdf
            ? await buildPdfBuffer(entries, days)
            : await buildExcelBuffer(entries);

        await ctx.telegram.sendDocument(
            ctx.chat.id,
            Input.fromBuffer(buffer, isPdf ? 'inactive_traders_report.pdf' : 'inactive_traders_report.xlsx'),
            {
                caption: `${caption}\n\n<b>Format:</b> ${isPdf ? 'PDF' : 'Excel (.xlsx)'}`,
                parse_mode: 'HTML',
            }
        );
    } catch (err) {
        logger.error('Failed to send report file:', err);
        await ctx.reply(`<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Failed to generate report file. Please try again.</b>`, { parse_mode: 'HTML' });
    }
};

export const findInactiveTraders = async (days) => {
    const cutoff = new Date(Date.now() - days * 86400000);

    const traders = await Trader.find({
        telegramId: { $ne: null },
        events: { $not: { $elemMatch: { status: { $in: ACTIVITY_STATUSES }, date: { $gte: cutoff } } } },
    }).lean();

    if (traders.length === 0) return [];

    const telegramIds = traders.map((t) => t.telegramId);
    const users = await User.find({ telegramId: { $in: telegramIds } }).lean();
    const byTgId = new Map(users.map((u) => [String(u.telegramId), u]));

    return traders
        .filter((t) => byTgId.has(String(t.telegramId)))
        .map((trader) => {
            const user = byTgId.get(String(trader.telegramId));
            return {
                telegramId: trader.telegramId,
                traderId: trader.trader_id,
                name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'N/A',
                username: user.username || 'N/A',
                sumdep: trader.sumdep || 0,
                sumwithdraw: trader.sumwithdraw || 0,
                access_granted: user.access_granted || false,
                invite_link: user.invite_link || null,
                removed_at: user.removed_at || null,
            };
        });
};

export const findLowDepositTraders = async (amount) => {
    const threshold = Number(amount);

    const traders = await Trader.find({
        telegramId: { $ne: null },
        sumdep: { $lt: threshold },
    }).lean();

    if (traders.length === 0) return [];

    const telegramIds = traders.map((t) => t.telegramId);
    const users = await User.find({ telegramId: { $in: telegramIds } }).lean();
    const byTgId = new Map(users.map((u) => [String(u.telegramId), u]));

    return traders
        .filter((t) => byTgId.has(String(t.telegramId)))
        .map((trader) => {
            const user = byTgId.get(String(trader.telegramId));
            return {
                telegramId: trader.telegramId,
                traderId: trader.trader_id,
                name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'N/A',
                username: user.username || 'N/A',
                sumdep: trader.sumdep || 0,
                sumwithdraw: trader.sumwithdraw || 0,
                access_granted: user.access_granted || false,
                invite_link: user.invite_link || null,
                removed_at: user.removed_at || null,
            };
        });
};

export const removeFromChannelWithRetry = async (telegram, channelId, userId, rateLimitFn, attempt = 1) => {
    try {
        await rateLimitFn();
        await telegram.kickChatMember(channelId, userId);
        await rateLimitFn();
        await telegram.unbanChatMember(channelId, userId);
        return { action: 'kicked' };
    } catch (err) {
        const code = err?.response?.error_code;
        const desc = err?.response?.description || err?.message || '';

        if (code === 400) {
            return { action: 'skip', reason: desc };
        }

        if (code === 429) {
            const retryAfter = (err.response.parameters?.retry_after || 5) * 1000;
            logger.warn(`Flood wait ${retryAfter}ms for ${userId} in ${channelId}, attempt ${attempt}/${REMOVE_MAX_RETRIES}`);
            notifyFlood(retryAfter);
            await sleep(retryAfter);
            if (attempt < REMOVE_MAX_RETRIES) {
                return removeFromChannelWithRetry(telegram, channelId, userId, rateLimitFn, attempt + 1);
            }
            return { action: 'error', message: 'Flood wait exceeded' };
        }

        if (code === 403) {
            logger.warn(`No permission to remove ${userId} from ${channelId}: ${desc}`);
            return { action: 'error', message: 'no_permission' };
        }

        if (attempt < REMOVE_MAX_RETRIES) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 10000);
            logger.warn(`Retry remove ${userId} from ${channelId} in ${Math.round(backoff)}ms, attempt ${attempt + 1}/${REMOVE_MAX_RETRIES}`);
            await sleep(backoff);
            return removeFromChannelWithRetry(telegram, channelId, userId, rateLimitFn, attempt + 1);
        }

        logger.error(`Failed to remove ${userId} from ${channelId}:`, err);
        return { action: 'error', message: err.message };
    }
};

export const getRemoveState = async () => getConfig('remove_state', null);

export const clearRemoveState = async () => setConfig('remove_state', null);

let stateFlushChain = Promise.resolve();

const flushRemoveState = (state, includeIds = false) => {
    const snapshot = {
        status: state.status,
        startedAt: state.startedAt,
        completedAt: state.completedAt || null,
        type: state.type,
        days: state.days,
        amount: state.amount,
        total: state.total,
        removed: state.removed,
        failed: state.failed,
        skipped: state.skipped,
        notified: state.notified,
        notifyFailed: state.notifyFailed || 0,
        processed: state.processed,
        failedIds: state.failedIds || [],
        notifyFailedIds: state.notifyFailedIds || [],
    };
    if (includeIds) snapshot.traderIds = state.traderIds;
    stateFlushChain = stateFlushChain.then(() => patchConfig('remove_state', snapshot));
    return stateFlushChain;
};

let bulkFlushChain = Promise.resolve();

const flushBulk = (bulkOps) => {
    const ops = bulkOps.splice(0, bulkOps.length);
    if (ops.length === 0) return Promise.resolve();
    bulkFlushChain = bulkFlushChain.then(() =>
        User.bulkWrite(ops).catch((e) => logger.error('Remove bulk write error:', e))
    );
    return bulkFlushChain;
};

const findRowsByJob = async (jobType, jobValue) => {
    if (jobType === 'lowdep') return findLowDepositTraders(jobValue);
    return findInactiveTraders(jobValue);
};

const removeUsersByJob = async (telegram, { jobType, jobValue, onProgress = null, resume = false } = {}) => {
    if (removalInProgress) {
        throw new Error('A removal job is already running.');
    }
    removalInProgress = true;

    try {
        let state = resume ? await getRemoveState() : null;
        let rows = null;

        if (!state || !Array.isArray(state.traderIds)) {
            rows = await findRowsByJob(jobType, jobValue);
            const actionable = rows.filter((r) => r.access_granted);
            state = {
                status: 'running',
                startedAt: new Date().toISOString(),
                completedAt: null,
                type: jobType,
                days: jobType === 'days' ? jobValue : undefined,
                amount: jobType === 'lowdep' ? jobValue : undefined,
                total: actionable.length,
                removed: 0,
                failed: 0,
                skipped: 0,
                notified: 0,
                notifyFailed: 0,
                traderIds: actionable.map((r) => r.traderId),
                processed: [],
                failedIds: [],
                notifyFailedIds: [],
            };
        } else {
            state.status = 'running';
            state.completedAt = null;
            state.notifyFailed = state.notifyFailed || 0;
            jobType = state.type || 'days';
            jobValue = state.amount ?? state.days;
        }

        if (state.total === 0) {
            await clearRemoveState();
            return { total: 0, removed: 0, failed: 0, skipped: 0, notified: 0, notifyFailed: 0, failedUsers: [], noticeFailedUsers: [] };
        }

        await flushRemoveState(state, true);

        const [channelIds, minRedeposit] = await Promise.all([
            getConfig('channel_ids', ['', '', '', '', '']),
            getConfig('min_deposit_removed', 20),
        ]);

        const vipChannels = (Array.isArray(channelIds) ? channelIds : []).filter((id) => id && String(id).trim()).map(String);

        const processedSet = new Set(state.processed);
        const pendingIds = state.traderIds.filter((id) => !processedSet.has(id));

        if (!rows) {
            rows = await findRowsByJob(jobType, jobValue);
        }
        const rowMap = new Map(rows.map((r) => [r.traderId, r]));
        const pending = pendingIds.map((id) => rowMap.get(id)).filter(Boolean);

        const healedCount = pendingIds.length - pending.length;
        if (healedCount > 0) {
            for (const id of pendingIds) {
                if (!rowMap.has(id)) {
                    state.processed.push(id);
                    state.skipped++;
                }
            }
            await flushRemoveState(state);
        }

        const rateLimitFn = createRateLimiter();

        const buildNotice = (row) => {
            if (jobType === 'lowdep') {
                return (
                    `<b><tg-emoji emoji-id="6174916816951842220">⚠️</tg-emoji> VIP Access Removed — Deposit Below Minimum</b>\n\n` +
                    `<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>Your total deposit ($${Number(row.sumdep || 0).toFixed(2)}) is below the required minimum of $${Number(jobValue).toFixed(2)}.</b>\n\n` +
                    `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Redeposit $${minRedeposit} and send your Trader ID to regain access.</b>`
                );
            }
            return (
                `<b><tg-emoji emoji-id="6174916816951842220">⚠️</tg-emoji> VIP Access Removed</b>\n\n` +
                `<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>Your channel access was removed due to inactivity (no deposit or withdrawal in the last ${jobValue} days).</b>\n\n` +
                `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Redeposit $${minRedeposit} and send your Trader ID to regain access.</b>`
            );
        };

        const bulkOps = [];
        let lastFlush = Date.now();
        let doneCount = 0;

        const processUser = async (row) => {
            try {
                let removedFromAny = false;
                let removalFailed = false;

                for (const chId of vipChannels) {
                    const result = await removeFromChannelWithRetry(telegram, chId, row.telegramId, rateLimitFn);
                    if (result.action === 'kicked') removedFromAny = true;
                    if (result.action === 'error') removalFailed = true;
                }

                if (removedFromAny) {
                    if (row.invite_link) {
                        let inviteMap = {};
                        try { inviteMap = JSON.parse(row.invite_link); } catch {}
                        for (const [chId, link] of Object.entries(inviteMap)) {
                            if (link) {
                                try {
                                    await rateLimitFn();
                                    await telegram.revokeChatInviteLink(chId, link);
                                } catch {}
                            }
                        }
                    }

                    try {
                        await rateLimitFn();
                        await telegram.sendMessage(row.telegramId, buildNotice(row), { parse_mode: 'HTML' });
                        state.notified++;
                    } catch (err) {
                        state.notifyFailed = (state.notifyFailed || 0) + 1;
                        state.notifyFailedIds.push(row.traderId);
                        if (err?.response?.error_code === 429) {
                            notifyFlood((err.response.parameters?.retry_after || 5) * 1000);
                        }
                    }

                    bulkOps.push({
                        updateOne: {
                            filter: { telegramId: row.telegramId },
                            update: {
                                access_granted: false,
                                invite_link: null,
                                removed_at: new Date(),
                                sumdep_at_removal: row.sumdep,
                            },
                        },
                    });

                    state.removed++;
                } else if (removalFailed) {
                    state.failed++;
                    state.failedIds.push(row.traderId);
                } else {
                    state.skipped++;
                }

                state.processed.push(row.traderId);
                doneCount++;

                const now = Date.now();
                if (
                    state.processed.length % REMOVE_BULK_CHUNK === 0 ||
                    state.processed.length % REMOVE_STATE_FLUSH_EVERY === 0 ||
                    now - lastFlush >= 2000
                ) {
                    await Promise.all([flushBulk(bulkOps), flushRemoveState(state)]);
                    lastFlush = now;
                }

                if (onProgress) {
                    await onProgress(state.processed.length, state.total, state.removed, state.failed);
                }

                await sleep(REMOVE_SLEEP_MS);
            } catch (err) {
                logger.error(`Error processing user ${row.telegramId}:`, err);
                if (!state.processed.includes(row.traderId)) {
                    state.processed.push(row.traderId);
                    state.failed++;
                    state.failedIds.push(row.traderId);
                    doneCount++;
                }
                if (onProgress) {
                    await onProgress(state.processed.length, state.total, state.removed, state.failed);
                }
            }
        };

        let failedUsers = [];
        let noticeFailedUsers = [];

        try {
            await runPool(pending, processUser);

            await Promise.all([flushBulk(bulkOps), flushRemoveState(state)]);

            failedUsers = (state.failedIds || []).map((id) => rowMap.get(id)).filter(Boolean);
            noticeFailedUsers = (state.notifyFailedIds || []).map((id) => rowMap.get(id)).filter(Boolean);

            if (state.processed.length === state.total) {
                state.status = 'completed';
                state.completedAt = new Date().toISOString();
                await flushRemoveState(state);
            } else {
                state.status = 'interrupted';
                await flushRemoveState(state);
                logger.warn(`Removal incomplete: ${state.processed.length}/${state.total} processed`);
            }

            if (onProgress) {
                await onProgress(state.processed.length, state.total, state.removed, state.failed);
            }

            logger.info(`Removal complete: ${state.removed} removed, ${state.failed} failed, ${state.skipped} skipped`);
        } catch (error) {
            await flushBulk(bulkOps);
            state.status = 'interrupted';
            await flushRemoveState(state);
            logger.error('Bulk removal error:', error);
            throw error;
        }

        await clearRemoveState();

        return {
            total: state.total,
            removed: state.removed,
            failed: state.failed,
            skipped: state.skipped,
            notified: state.notified,
            notifyFailed: state.notifyFailed || 0,
            failedUsers,
            noticeFailedUsers,
        };
    } finally {
        removalInProgress = false;
    }
};

export const removeInactiveUsers = async (telegram, days, opts = {}) =>
    removeUsersByJob(telegram, { jobType: 'days', jobValue: days, ...opts });

export const removeLowDepositUsers = async (telegram, amount, opts = {}) =>
    removeUsersByJob(telegram, { jobType: 'lowdep', jobValue: amount, ...opts });
