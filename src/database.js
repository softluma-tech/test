

import mongoose from 'mongoose';
import { config } from './config.js';
import logger from './utils/logger.js';

const mongooseOptions = {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
    heartbeatFrequencyMS: 10000,
};

export const connectDB = async (retries = 3, delay = 2000) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await mongoose.connect(config.dbUri, mongooseOptions);
            logger.info('MongoDB Connected successfully');
            return;
        } catch (error) {
            logger.error(`MongoDB Connection attempt ${attempt}/${retries} failed:`, error);
            if (attempt === retries) throw error;
            await new Promise((r) => setTimeout(r, delay * attempt));
        }
    }
};

mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
