
import { Config } from '../models/Config.js';
import logger from '../utils/logger.js';

export const getConfig = async (key, defaultValue = null) => {
    try {
        const config = await Config.findOne({ key }).lean();
        return config ? config.value : defaultValue;
    } catch (error) {
        logger.error(`Error getting config ${key}:`, error);
        return defaultValue;
    }
};

export const setConfig = async (key, value, description = '') => {
    try {
        await Config.findOneAndUpdate(
            { key },
            { value, description },
            { upsert: true, returnDocument: 'after' }
        );
        return true;
    } catch (error) {
        logger.error(`Error setting config ${key}:`, error);
        return false;
    }
};

export const patchConfig = async (key, patch, unset = []) => {
    try {
        const existing = await Config.findOne({ key }).lean();
        if (!existing) {
            await Config.create({ key, value: patch });
            return true;
        }
        const value = { ...(existing.value || {}), ...patch };
        for (const k of unset) delete value[k];
        await Config.updateOne({ key }, { $set: { value } });
        return true;
    } catch (error) {
        logger.error(`Error patching config ${key}:`, error);
        return false;
    }
};

export const initializeConfigs = async () => {
    const defaults = {
        'min_deposit': 10,
        'min_deposit_removed': 20,
        'affiliate_lid': '2155288',
        'channel_ids': ['', '', '', '', ''],
        'maintenance': false,
        'btn_join_channel': 'https://softluma.tech',
        'support_id': '',
        'forwarding': true,
        'forwarding_target_id': '',
        'welcome_voice': '',
        'welcome_video': '',
        'log_channel_id': ''
    };

    const ops = Object.entries(defaults).map(([key, value]) => ({
        updateOne: {
            filter: { key },
            update: { $setOnInsert: { key, value } },
            upsert: true,
        }
    }));

    if (ops.length > 0) {
        await Config.bulkWrite(ops);
    }
};
