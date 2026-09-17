import { User } from '../models/User.js';
import { setConfig, getConfig } from './adminService.js';
import logger from '../utils/logger.js';

const CONCURRENCY = 20;
const BATCH_SIZE = 500;
const MAX_RETRIES = 3;
const MESSAGES_PER_SEC = 20;
const STATE_FLUSH_INTERVAL_MS = 2000;
const PROGRESS_INTERVAL = 100;
const CURSOR_TIMEOUT_MS = 3600000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const createRateLimiter = () => {
    let msgTimestamps = [];
    return async () => {
        const now = Date.now();
        msgTimestamps = msgTimestamps.filter((t) => now - t < 1000);
        if (msgTimestamps.length >= MESSAGES_PER_SEC) {
            const wait = 1000 - (now - msgTimestamps[0]);
            if (wait > 0) await sleep(wait);
        }
        msgTimestamps.push(Date.now());
    };
};

const blockedUserIds = new Set();

const sendWithRetry = async (telegram, chatId, sourceChatId, messageId, rateLimitFn, attempt = 1) => {
    try {
        await rateLimitFn();
        await telegram.copyMessage(chatId, sourceChatId, messageId);
        blockedUserIds.delete(chatId);
        return true;
    } catch (err) {
        const code = err?.response?.error_code;

        if (code === 403) {
            blockedUserIds.add(chatId);
            return false;
        }

        if (code === 429) {
            const retryAfter = (err.response.parameters?.retry_after || 5) * 1000;
            logger.warn(`Flood wait ${retryAfter}ms for ${chatId}, attempt ${attempt}/${MAX_RETRIES}`);
            await sleep(retryAfter);
            if (attempt < MAX_RETRIES) {
                return sendWithRetry(telegram, chatId, sourceChatId, messageId, rateLimitFn, attempt + 1);
            }
            return false;
        }

        if (code === 400) return false;

        if (attempt < MAX_RETRIES) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 10000);
            logger.warn(`Retry ${chatId} in ${Math.round(backoff)}ms, attempt ${attempt + 1}/${MAX_RETRIES}`);
            await sleep(backoff);
            return sendWithRetry(telegram, chatId, sourceChatId, messageId, rateLimitFn, attempt + 1);
        }

        return false;
    }
};

export const getBroadcastState = async () => {
    return getConfig('broadcast_state', null);
};

export const clearBroadcastState = async () => {
    await setConfig('broadcast_state', null);
};

const flushState = async (state) => {
    if (!state) return;
    await setConfig('broadcast_state', {
        total: state.total,
        skip: state.skip,
        success: state.success,
        failed: state.failed,
        status: state.status,
        sourceChatId: state.sourceChatId,
        messageId: state.messageId,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
    });
};

export const broadcastMessage = async (telegram, sourceChatId, messageId, onProgress = null, resumeSkip = 0) => {
    try {
        let successCount = 0;
        let failCount = 0;
        const errors = [];

        const rateLimitFn = createRateLimiter();

        const total = await User.countDocuments();
        if (total === 0) {
            return { successCount: 0, failCount: 0 };
        }

        const startedAt = new Date().toISOString();
        const existingState = await getConfig('broadcast_state');
        const state = {
            total,
            skip: resumeSkip,
            success: existingState?.success || 0,
            failed: existingState?.failed || 0,
            status: 'running',
            sourceChatId,
            messageId,
            startedAt: existingState?.startedAt || startedAt,
            completedAt: null,
        };
        await flushState(state);

        const cursor = User.find({})
            .lean()
            .skip(resumeSkip)
            .batchSize(BATCH_SIZE)
            .cursor();

        const sendBatch = async (users) => {
            const results = await Promise.allSettled(
                users.map((user) =>
                    blockedUserIds.has(user.telegramId)
                        ? Promise.resolve(false)
                        : sendWithRetry(telegram, user.telegramId, sourceChatId, messageId, rateLimitFn)
                )
            );

            for (const result of results) {
                if (result.status === 'fulfilled') {
                    if (result.value === true) {
                        successCount++;
                    } else {
                        failCount++;
                    }
                } else {
                    failCount++;
                    errors.push(result.reason?.message || 'Unknown');
                }
            }
        };

        let batch = [];
        let lastFlush = Date.now();
        let lastProgressCount = 0;
        let lastProgressPct = 0;

        for await (const user of cursor) {
            batch.push(user);

            if (batch.length >= CONCURRENCY) {
                await sendBatch(batch);
                state.skip += batch.length;
                state.success = successCount;
                state.failed = failCount;
                const processed = successCount + failCount;
                batch = [];

                const now = Date.now();
                if (now - lastFlush >= STATE_FLUSH_INTERVAL_MS) {
                    await flushState(state);
                    lastFlush = now;
                }

                if (onProgress) {
                    const pct = total > 0 ? Math.floor((state.skip / total) * 100) : 0;
                    if (pct >= lastProgressPct + 10 || processed - lastProgressCount >= PROGRESS_INTERVAL) {
                        lastProgressCount = processed;
                        lastProgressPct = pct;
                        await onProgress(successCount, failCount, total, state.skip);
                    }
                }
            }
        }

        if (batch.length > 0) {
            await sendBatch(batch);
            state.skip += batch.length;
            state.success = successCount;
            state.failed = failCount;
        }

        state.status = 'completed';
        state.completedAt = new Date().toISOString();
        await flushState(state);

        if (onProgress) {
            await onProgress(successCount, failCount, total, state.skip);
        }

        if (errors.length > 0) {
            logger.warn(`Broadcast errors (non-blocked): ${JSON.stringify(errors.slice(0, 20))}`);
        }

        logger.info(`Broadcast complete: ${successCount} success, ${failCount} failed`);
        return { successCount, failCount };
    } catch (error) {
        await setConfig('broadcast_state', {
            ...(await getConfig('broadcast_state', {})),
            status: 'interrupted',
        });
        logger.error('Broadcast Error:', error);
        return { successCount: 0, failCount: 0 };
    }
};
