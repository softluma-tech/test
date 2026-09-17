

import { Trader } from '../models/Trader.js';
import { User } from '../models/User.js';
import logger from '../utils/logger.js';

const MAX_EVENTS = 500;

const parseBool = (val) => val === 'true' || val === '1' || val === true || val === 'yes' || val === 1;

export const handlePostbackData = async (data) => {
    try {
        const { status, eid, cid, sid, lid, uid, country, sumdep, sumwithdraw } = data;

        if (!uid || typeof uid !== 'string') {
            throw new Error('Missing or invalid trader_id (uid)');
        }

        const sumdepNum = Math.round(parseFloat(sumdep) * 100) / 100;
        const sumwithdrawNum = Math.round(parseFloat(sumwithdraw) * 100) / 100;

        const setFields = {};
        const incFields = {};

        if (status) setFields.status = String(status).slice(0, 50);

        if (parseBool(data.reg) || status === 'reg') setFields.registered = true;
        if (parseBool(data.conf) || status === 'conf') setFields.email_confirmed = true;
        if (parseBool(data.ftd) || status === 'ftd') setFields.first_deposit = true;
        if (parseBool(data.dep) || status === 'dep') setFields.deposited = true;
        if (parseBool(data.withdrawal) || status === 'withdrawal') setFields.withdrawal = true;

        if (!Number.isNaN(sumdepNum) && sumdepNum > 0) incFields.sumdep = Math.round(sumdepNum * 100) / 100;
        if (!Number.isNaN(sumwithdrawNum) && sumwithdrawNum > 0) incFields.sumwithdraw = Math.round(sumwithdrawNum * 100) / 100;

        const telegramIdFromCid = parseInt(cid, 10);
        const telegramId = (!Number.isNaN(telegramIdFromCid) && telegramIdFromCid > 0) ? telegramIdFromCid : null;

        const eventEntry = eid && eid.length > 0 ? {
            event_id: eid,
            status: status || '',
            sumdep: !Number.isNaN(sumdepNum) ? sumdepNum : 0,
            sumwithdraw: !Number.isNaN(sumwithdrawNum) ? sumwithdrawNum : 0
        } : null;

        const updateOps = {
            $set: setFields,
            $setOnInsert: {
                trader_id: uid,
                telegramId,
                country: country || '',
                click_id: cid || '',
                site_id: sid || '',
                lid: lid || ''
            },
        };

        if (Object.keys(incFields).length > 0) {
            updateOps.$inc = incFields;
        }

        if (eventEntry) {
            updateOps.$push = { events: { $each: [eventEntry], $slice: -MAX_EVENTS } };
        }

        try {
            await Trader.findOneAndUpdate(
                { trader_id: uid },
                updateOps,
                { upsert: true, returnDocument: 'after' }
            );
        } catch (err) {
            if (err.code === 11000 && eid && err.keyPattern?.['events.event_id']) {
                logger.info(`Duplicate event ${eid} for trader ${uid}, skipping (unique index)`);
                return { success: true, skipped: true };
            }
            throw err;
        }

        if (telegramId && !setFields.registered) {
            await User.findOneAndUpdate({ telegramId }, { trader_id: uid }).catch(() => {});
        }

        return { success: true };
    } catch (error) {
        logger.error('Error in handlePostbackData:', error);
        return { success: false, error: error.message };
    }
};

export const checkRedeposit = async (user, trader, minDepositRemoved) => {
    try {
        if (!user?.removed_at) return { eligible: false, reason: 'not_removed' };
        if (!trader) return { eligible: false, reason: 'not_found' };

        const threshold = typeof minDepositRemoved === 'number' ? minDepositRemoved : 20;
        const reDeposited = (trader.sumdep || 0) - (user.sumdep_at_removal || 0);
        const eligible = reDeposited >= threshold;

        return { eligible, reDeposited, threshold };
    } catch (error) {
        logger.error('Error in checkRedeposit:', error);
        return { eligible: false, reason: 'error' };
    }
};

export const checkTraderStatus = async (telegramId, traderId, minDeposit) => {
    try {
        const trader = await Trader.findOne({ trader_id: traderId });

        if (!trader) {
            return { valid: false, reason: 'not_found' };
        }

        const updated = await Trader.findOneAndUpdate(
            {
                trader_id: traderId,
                $or: [{ telegramId: null }, { telegramId: telegramId }]
            },
            { telegramId },
            { returnDocument: 'after' }
        );

        if (!updated) {
            return { valid: false, reason: 'already_claimed' };
        }

        const user = await User.findOneAndUpdate(
            { telegramId, $or: [{ trader_id: null }, { trader_id: traderId }] },
            { trader_id: traderId },
            { returnDocument: 'after' }
        );

        const meetsMinDeposit = Number(updated.sumdep || 0) >= Number(minDeposit);

        if (meetsMinDeposit) {
            return { valid: true, deposited: true, sumdep: updated.sumdep };
        }

        return { valid: true, deposited: false, sumdep: updated.sumdep };
    } catch (error) {
        logger.error('Error in checkTraderStatus:', error);
        return { valid: false, reason: 'error' };
    }
};
