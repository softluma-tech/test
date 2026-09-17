import { Markup } from "telegraf";
import { getOrCreateUser } from "../../services/userService.js";
import { checkTraderStatus, checkRedeposit } from "../../services/traderService.js";
import {
  generateAffiliateLink,
  validateTraderId,
  escapeHtml,
} from "../../utils/helpers.js";
import { getConfig } from "../../services/adminService.js";
import { User } from "../../models/User.js";
import { Trader } from "../../models/Trader.js";
import logger from "../../utils/logger.js";

const buildHelpButtons = () => [
  [
    {
      text: "FREE VIP JOINING PROCESS",
      callback_data: "help_join_vip",
      style: "primary",
    },
  ],
  [
    {
      text: "HOW TO CREATE QUOTEX NEW ACCOUNT",
      callback_data: "help_how_register",
      style: "success",
    },
  ],
  [
    {
      text: "HOW TO DELETE QUOTEX OLD ACCOUNT",
      callback_data: "help_delete_account",
      style: "danger",
    },
  ],
  [
    {
      text: "I WANT TO JOIN PUBLIC GROUP",
      callback_data: "help_join_public",
      style: "primary",
    },
  ],
  [
    {
      text: "ASK ANY QUESTION OR PROBLEM",
      callback_data: "help_support",
      style: "primary",
    },
  ],
];

const buildWelcomeText = (ctx, joinChannel, supportId) => {
  const name = escapeHtml(ctx.from.first_name);
  const botName = escapeHtml(ctx.botInfo?.first_name || 'Quotex Bot');
  const support = supportId ? `@${supportId}` : "softluma.tech";
  const channel = joinChannel || "https://softluma.tech";
  return `<b><tg-emoji emoji-id="5938348905891632091">✨</tg-emoji> Hello ${name}

<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> Welcome to ${botName}

<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> ${name} thanks for contacting!

<tg-emoji emoji-id="5215668805199473901">📣</tg-emoji> Our public group: ${channel}

<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> join now for Daily Updates 

<tg-emoji emoji-id="5981194327110456280">🚀</tg-emoji> If Any Doubts Messege Me: ${support}</b>`;
};

const tryEdit = async (ctx, text, buttons) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (err1) {
    logger.warn(
      "tryEdit editMessageText failed, trying caption fallback:",
      err1.message,
    );
    try {
      await ctx.editMessageCaption(text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (err2) {
      logger.error(
        "tryEdit both editMessageText and editMessageCaption failed:",
        err2,
      );
    }
  }
};

export const startCommand = async (ctx) => {
  const user = await getOrCreateUser(ctx);
  user.state = "start";
  await user.save();

  const [joinChannel, supportId, welcomeVoice, welcomeVideo] = await Promise.all([
    getConfig("btn_join_channel"),
    getConfig("support_id"),
    getConfig("welcome_voice"),
    getConfig("welcome_video"),
  ]);

  const text = buildWelcomeText(ctx, joinChannel, supportId);

  if (welcomeVideo) {
    try {
      await ctx.replyWithVideo(welcomeVideo, {
        caption: text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buildHelpButtons() },
      });
    } catch (err) {
      logger.warn("Failed to send welcome video:", err.message);
      await ctx.reply(text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buildHelpButtons() },
      });
    }
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buildHelpButtons() },
    });
  }

  if (welcomeVoice) {
    try {
      await ctx.replyWithVoice(welcomeVoice);
    } catch (err) {
      logger.warn("Failed to send welcome voice:", err.message);
    }
  }
};

export const handleHowRegister = async (ctx) => {
  const lid = await getConfig("affiliate_lid");
  const link = generateAffiliateLink(lid);
  const text = `<b><tg-emoji emoji-id="5938348905891632091">📚</tg-emoji> HOW TO CREATE QUOTEX NEW ACCOUNT</b>
    
<b><tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 1. Click on my link:</b>
<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> ${link}
    
<b><tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 2. Select Country, put new email and strong password</b>
    
<b><tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 3. Accept terms &amp; conditions</b>
    
<b><tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 4. Click on registration – account registration successful.</b>
    
<b><tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 5. Check your email – you received a link for verification – verify your email.</b>
    
<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Done! You create account with my link and send me trader id.</b>`;
  await tryEdit(ctx, text, [[Markup.button.callback("⬅️ Back", "help_back")]]);
};

export const handleDeleteAccount = async (ctx) => {
  const text = `<b><tg-emoji emoji-id="6174916816951842220">🗑️</tg-emoji> HOW TO DELETE QUOTEX OLD ACCOUNT
    
<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 1. Go to profile option
    
<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 2. Scroll down and select delete account
    
<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 3. Check your email – you will receive a link for deleting the account
    
<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> 4. Click on the link you received on email – account is deleted successfully.
    
<tg-emoji emoji-id="5215394081911351762">ℹ️</tg-emoji> Now you can Register a new account using our link.</b>`;
  await tryEdit(ctx, text, [[Markup.button.callback("⬅️ Back", "help_back")]]);
};

export const handleSupport = async (ctx) => {
  const supportId = await getConfig("support_id");
  const contact = supportId ? `@${supportId}` : "softluma.tech";
  const text = `<b><tg-emoji emoji-id="5215173273347698630">🎧</tg-emoji> ASK ANY QUESTION OR PROBLEM</b>
    
<tg-emoji emoji-id="5215668805199473901">📣</tg-emoji> <b>MESSAGE US FOR INSTANT SUPPORT</b>
    
<tg-emoji emoji-id="5210956306952758910">👤</tg-emoji> <b>Contact: ${contact}</b>
    
<tg-emoji emoji-id="5212985021870123409">⏳</tg-emoji> <b>We reply within minutes.</b>`;
  await tryEdit(ctx, text, [[Markup.button.callback("⬅️ Back", "help_back")]]);
};

export const handleJoinVipCallback = async (ctx) => {
  const user = await getOrCreateUser(ctx);
  const [minDeposit, lid] = await Promise.all([
    getConfig("min_deposit", 10),
    getConfig("affiliate_lid"),
  ]);
  const link = generateAffiliateLink(lid);
  const text = `<b><tg-emoji emoji-id="5938264290740933445">💎</tg-emoji> FREE VIP JOINING PROCESS
    
<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> CREATE NEW ACCOUNT WITH THIS LINK
    
<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> ${link}
    
<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> Deposit Amount minimum ${minDeposit}$
   
<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> Use <code>BFSSTAMIL</code> Code For 50% Additional Bonus And For A Fast Withdrawal LINK
    
<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> SEND YOUR TRADER ID IN THIS BOT
    
<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> Start your trading journey with us &amp; earn profit with proper money management <tg-emoji emoji-id="5938517659451658781">📈</tg-emoji></b>`;
  await tryEdit(ctx, text, [
    [
      {
        text: "✅ I WANT TO JOIN",
        callback_data: "join_vip_confirm",
        style: "success",
      },
    ],
    [Markup.button.callback("⬅️ Back", "help_back")],
  ]);
};

export const handleJoinVipConfirm = async (ctx) => {
  const user = await getOrCreateUser(ctx);

  const text = `<b><tg-emoji emoji-id="5215351548850218245">🔐</tg-emoji> Almost There!

<tg-emoji emoji-id="5215394081911351762">ℹ️</tg-emoji> I will check your account and deposit, then give you access to the channel.

<tg-emoji emoji-id="6174916816951842220">⚠️</tg-emoji> Note: Make sure you waited 2–3 minutes after depositing before sending your UID.

<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> Send Your Trader UID Now :-</b>`;
  await tryEdit(ctx, text, [[Markup.button.callback("⬅️ Back", "help_back")]]);
};

export const handleJoinPublic = async (ctx) => {
  const joinChannel = await getConfig("btn_join_channel");
  const channel = joinChannel || "https://softluma.tech";
  const text = `<b><tg-emoji emoji-id="5940725397195853882">💎</tg-emoji> I WANT TO JOIN PUBLIC GROUP
    
<tg-emoji emoji-id="5938231700529090901">🤝</tg-emoji> Welcome to Public Group
    
<tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> Follow money management and risk management to make profit daily
    
<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> Group link <tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji></b>
${channel}`;
  await tryEdit(ctx, text, [
    [Markup.button.url("🔗 Join Group", channel)],
    [Markup.button.callback("⬅️ Back", "help_back")],
  ]);
};

export const handleHelpBack = async (ctx) => {
  const user = await getOrCreateUser(ctx);
  user.state = "start";
  await user.save();

  const [joinChannel, supportId] = await Promise.all([
    getConfig("btn_join_channel"),
    getConfig("support_id"),
  ]);

  const text = buildWelcomeText(ctx, joinChannel, supportId);

  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buildHelpButtons() },
    });
  } catch (err) {
    logger.error("Failed to restore welcome message:", err);
  }
};

export const handleTextMessage = async (ctx) => {
  const user = await getOrCreateUser(ctx);
  const text = ctx.message.text;

  if (text === "❌ Cancel") {
    return startCommand(ctx);
  }

  const isTraderId = validateTraderId(text);
  if (isTraderId) {

    if (user.trader_id && user.trader_id !== text) {
      return ctx.reply(
        `<tg-emoji emoji-id="6174916816951842220">‼️</tg-emoji> <b>Another Trader ID is already linked to your account.</b>\n\n<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji><b> You can only have one Trader ID per Telegram account.</b>\n\n <b>If you need help, contact support.</b>`,
        { parse_mode: "HTML" },
      );
    }

    const [minDeposit, lid] = await Promise.all([
      getConfig("min_deposit", 10),
      getConfig("affiliate_lid"),
    ]);
    const status = await checkTraderStatus(ctx.from.id, text, minDeposit);

    if (!status.valid && status.reason === "already_claimed") {
      return ctx.reply(
        `<tg-emoji emoji-id="6174916816951842220">‼️</tg-emoji><b> Trader ID already linked to another account.</b>`,
        { parse_mode: "HTML" },
      );
    }

    if (!status.valid) {
      const link = generateAffiliateLink(lid);
      return ctx.reply(
        `<tg-emoji emoji-id="6174916816951842220">‼️</tg-emoji> <b>Trader ID not found.</b>\n\n<tg-emoji emoji-id="5938264290740933445">💎</tg-emoji> <a href="${link}">Register here</a>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
    }

    await User.updateOne(
      { telegramId: ctx.from.id },
      { state: "start" },
    );

    const totalDep = status.sumdep || 0;

    if (!status.deposited) {
      return ctx.reply(
        `<tg-emoji emoji-id="5938558852482994666">⚠️</tg-emoji> <b>Trader ID: ${text}</b>\n\n<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Deposit Amount:$${totalDep.toFixed(2)}</b> \n\n<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Min Deposit: $${minDeposit}</b>\n\n<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji><b> Deposit $${minDeposit} and send your trader ID again.</b>`,
        { parse_mode: "HTML" },
      );
    }

    if (user.removed_at) {
      const trader = await Trader.findOne({ trader_id: text }).lean();
      const minRemoved = await getConfig("min_deposit_removed", 20);
      const redep = await checkRedeposit(user, trader, minRemoved);

      if (!redep.eligible) {
        const required = redep.threshold ?? minRemoved;
        const deposited = redep.reDeposited || 0;
        return ctx.reply(
          `<tg-emoji emoji-id="6174916816951842220">⚠️</tg-emoji> <b>Access Removed Due To Inactivity</b>\n\n` +
            `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Deposited after removal:</b> $${deposited.toFixed(2)}\n` +
            `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Required:</b> $${required}\n\n` +
            `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Redeposit $${required} and send your Trader ID again to regain access.</b>`,
          { parse_mode: "HTML" },
        );
      }

      await User.updateOne(
        { telegramId: ctx.from.id },
        { removed_at: null, sumdep_at_removal: null },
      );

      const logChannelId = await getConfig("log_channel_id", "");
      if (logChannelId) {
        const logText =
          `<tg-emoji emoji-id="5938069973535559743">🔁</tg-emoji> <b>Redeposit Verified — Re-access Granted</b>\n\n` +
          `<tg-emoji emoji-id="5210956306952758910">👤</tg-emoji> <b>Name:</b> ${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(" ") || "N/A")}\n` +
          `<tg-emoji emoji-id="5215668805199473901">📣</tg-emoji> <b>Username:</b> ${user.username ? "@" + escapeHtml(user.username) : "N/A"}\n` +
          `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Telegram ID:</b> <code>${user.telegramId}</code>\n` +
          `<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Trader ID:</b> <code>${escapeHtml(text)}</code>\n` +
          `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Deposited after removal:</b> $${(redep.reDeposited || 0).toFixed(2)}\n` +
          `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Required:</b> $${(redep.threshold ?? minRemoved).toFixed(2)}\n` +
          `<tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> <b>Time:</b> ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} (IST)`;
        await ctx.telegram
          .sendMessage(logChannelId, logText, { parse_mode: "HTML" })
          .catch((err) => logger.warn("Failed to send redeposit log:", err.message));
      }
    }

    return ctx.reply(
      `<tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> <b>Account Verified</b>\n\n<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Trader ID:</b> ${text}\n\n<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Deposit Amount:</b> $${totalDep.toFixed(2)}\n\n<b>Confirm below to receive your link:</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Get Access",
                callback_data: "get_access",
                style: "success",
              },
            ],
          ],
        },
      },
    );
  }
};

export const handleGetAccess = async (ctx) => {
  const user = await getOrCreateUser(ctx);

  if (user.access_granted) {
    await ctx.answerCbQuery().catch(() => {});
    return ctx.reply(
      `<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> You already have access. Use the invite link sent earlier or contact support if you need help.</b>`,
      { parse_mode: "HTML" },
    );
  }

  if (user.invite_link) {
    let oldMap = {};
    try { oldMap = JSON.parse(user.invite_link); } catch {}
    for (const [chId, link] of Object.entries(oldMap)) {
      if (link) {
        try { await ctx.telegram.revokeChatInviteLink(chId, link); } catch {}
      }
    }
    user.invite_link = null;
    await user.save();
  }

  const channelIds = await getConfig("channel_ids", ['', '', '', '', '']);

  await ctx.answerCbQuery().catch(() => {});

  const activeChannels = channelIds.filter((id) => id && id.trim());

  if (activeChannels.length === 0) {
    return ctx.reply(
      `<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> VIP channels are not configured yet. Please contact support.</b>`,
      { parse_mode: "HTML" },
    );
  }

  const inviteMap = {};
  const links = [];

  for (const channelId of activeChannels) {
    const trimmedId = channelId.trim();
    try {
      const chat = await ctx.telegram.getChat(trimmedId);
      const invite = await ctx.telegram.createChatInviteLink(trimmedId, {
        creates_join_request: true,
      });
      inviteMap[chat.id] = invite.invite_link;
      links.push(invite.invite_link);
    } catch (err) {
      logger.error(`Error generating invite link for channel ${trimmedId}:`, err);
    }
  }

  if (links.length === 0) {
    return ctx.reply(
      `<b><tg-emoji emoji-id="5938290000415167172">❌</tg-emoji> Could not generate any channel invite link. Make sure the bot is an admin in the target channels and the channel IDs are set properly.</b>`,
      { parse_mode: "HTML" },
    );
  }

  user.invite_link = JSON.stringify(inviteMap);
  user.access_granted = true;
  await user.save();

  const linksHtml = links.map((l, i) => `<tg-emoji emoji-id="5936181055508713274">🔗</tg-emoji> <b>Channel ${i + 1}:</b> ${l}`).join("\n\n");

  const text = `<tg-emoji emoji-id="5938264290740933445">👑</tg-emoji> <b>Congratulation Access Granted</b>\n\n${linksHtml}\n\n<tg-emoji emoji-id="5938517659451658781">📈</tg-emoji> <b>Always follow money management rules</b>\n\n<tg-emoji emoji-id="5938348905891632091">✨</tg-emoji> <b>Happy Trading</b>`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            Markup.button.callback("⬅️ Back to Main Menu", "back_main_menu"),
          ],
        ],
      },
    });
  } catch {
    await ctx.telegram.sendMessage(ctx.from.id, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            Markup.button.callback("⬅️ Back to Main Menu", "back_main_menu"),
          ],
        ],
      },
    });
  }
};

export const handleBackMainMenu = async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return startCommand(ctx);
};

export const handleChatJoinRequest = async (ctx) => {
  const telegramId = ctx.chatJoinRequest.from.id;
  const channelId = ctx.chatJoinRequest.chat.id;

  try {
    const user = await User.findOne({ telegramId });
    if (!user || !user.trader_id) {
      return ctx.telegram
        .declineChatJoinRequest(channelId, telegramId)
        .catch(() => {});
    }

    const minDeposit = await getConfig("min_deposit", 10);
    const status = await checkTraderStatus(
      telegramId,
      user.trader_id,
      minDeposit,
    );

    if (status.valid && status.deposited && Number(status.sumdep || 0) >= Number(minDeposit)) {
      if (user.removed_at) {
        const trader = await Trader.findOne({ trader_id: user.trader_id }).lean();
        const minRemoved = await getConfig("min_deposit_removed", 20);
        const redep = await checkRedeposit(user, trader, minRemoved);
        if (!redep.eligible) {
          return ctx.telegram
            .declineChatJoinRequest(channelId, telegramId)
            .catch(() => {});
        }
      }

      await ctx.telegram
        .approveChatJoinRequest(channelId, telegramId)
        .catch(() => {});
      await ctx.telegram
        .sendMessage(
          telegramId,
          `<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> Your request to join the VIP channel has been approved! Welcome aboard! <tg-emoji emoji-id="5981194327110456280">🚀</tg-emoji></b>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      const logChannelId = await getConfig("log_channel_id", "");
      if (logChannelId) {
        const chat = ctx.chatJoinRequest.chat || {};
        const logText =
          `<b><tg-emoji emoji-id="5938109560249127910">✅</tg-emoji> VIP Join Approved</b>\n\n` +
          `<tg-emoji emoji-id="5210956306952758910">👤</tg-emoji> <b>Name:</b> ${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(" ") || "N/A")}\n` +
          `<tg-emoji emoji-id="5215668805199473901">📣</tg-emoji> <b>Username:</b> ${user.username ? "@" + escapeHtml(user.username) : "N/A"}\n` +
          `<tg-emoji emoji-id="5938264290740933445">⭐</tg-emoji> <b>Telegram ID:</b> <code>${telegramId}</code>\n` +
          `<tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> <b>Trader ID:</b> <code>${escapeHtml(user.trader_id)}</code>\n` +
          `<tg-emoji emoji-id="5938489471581293873">💰</tg-emoji> <b>Deposit:</b> $${(status.sumdep || 0).toFixed(2)}\n` +
          `<tg-emoji emoji-id="5938069973535559743">➡️</tg-emoji> <b>Channel:</b> ${chat.title ? escapeHtml(chat.title) : channelId}\n` +
          `<tg-emoji emoji-id="5938517659451658781">📊</tg-emoji> <b>Time:</b> ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} (IST)`;
        await ctx.telegram
          .sendMessage(logChannelId, logText, { parse_mode: "HTML" })
          .catch((err) => logger.warn("Failed to send VIP log message:", err.message));
      }

      if (user.invite_link) {
        let inviteMap = {};
        try { inviteMap = JSON.parse(user.invite_link); } catch {}
        const linkForChannel = inviteMap[String(channelId)];
        if (linkForChannel) {
          await ctx.telegram
            .revokeChatInviteLink(channelId, linkForChannel)
            .catch(() => {});
          delete inviteMap[String(channelId)];
          user.invite_link = JSON.stringify(inviteMap);
          await user.save().catch(() => {});
        }
      }
    } else {
      await ctx.telegram
        .declineChatJoinRequest(channelId, telegramId)
        .catch(() => {});
    }
  } catch (err) {
    logger.error("handleChatJoinRequest error:", err);
  }
};
