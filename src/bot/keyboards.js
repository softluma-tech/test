import { Markup } from 'telegraf';

export const adminKeyboard = Markup.keyboard([
    ['⚙️ Config', '📢 Broadcast'],
    ['📊 View Stats', '📋 More'],
    ['⬅️ Back to User Panel']
]).resize();

export const moreKeyboard = Markup.keyboard([
    ['📊 Report', '🔍 Search User'],
    ['📣 Notify Inactive', '🗑️ Remove User'],
    ['🔗 Unlink ID', '📨 Manual Postback'],
    ['💸 Remove Low Deposit'],
    ['⬅️ Back to Admin Panel']
]).resize();

export const cancelKeyboard = Markup.keyboard([
    ['❌ Cancel']
]).resize();
