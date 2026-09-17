

import mongoose from 'mongoose';

const eventSchema = new mongoose.Schema({
    event_id: { type: String },
    status: { type: String },
    sumdep: { type: Number, default: 0 },
    sumwithdraw: { type: Number, default: 0 },
    date: { type: Date, default: Date.now }
});

const traderSchema = new mongoose.Schema({
    trader_id: { type: String, required: true, unique: true },
    telegramId: { type: Number, index: true }, // Links to User.js
    
    country: { type: String, default: '' },
    click_id: { type: String, default: '' },
    site_id: { type: String, default: '' },
    lid: { type: String, default: '' },
    
    status: { type: String, default: '' },
    registered: { type: Boolean, default: false },
    email_confirmed: { type: Boolean, default: false },
    first_deposit: { type: Boolean, default: false },
    deposited: { type: Boolean, default: false },
    withdrawal: { type: Boolean, default: false },
    
    sumdep: { type: Number, default: 0 },
    sumwithdraw: { type: Number, default: 0 },
    
    events: [eventSchema]
}, { timestamps: true });

traderSchema.index({ 'events.event_id': 1 }, { unique: true, sparse: true });
traderSchema.index({ 'events.date': -1 });

export const Trader = mongoose.model('Trader', traderSchema);
