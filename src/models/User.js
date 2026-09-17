

import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: { type: String, default: '' },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    
    state: { type: String, default: 'start' },
    trader_id: { type: String, default: null, index: true }, // Links to Trader.js
    invite_link: { type: String, default: null },
    access_granted: { type: Boolean, default: false },
    removed_at: { type: Date, default: null },
    sumdep_at_removal: { type: Number, default: null }
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
