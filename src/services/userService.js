

import { User } from '../models/User.js';
import logger from '../utils/logger.js';

export const getOrCreateUser = async (ctx) => {
    try {
        const telegramId = ctx.from.id;
        let user = await User.findOne({ telegramId });

        if (!user) {
            user = new User({
                telegramId,
                username: ctx.from.username || '',
                firstName: ctx.from.first_name || '',
                lastName: ctx.from.last_name || '',
            });
            await user.save();
        }
        return user;
    } catch (error) {
        logger.error('Error in getOrCreateUser:', error);
        throw error;
    }
};
