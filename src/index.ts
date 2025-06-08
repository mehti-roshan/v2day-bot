import "dotenv/config";
import { Bot, Context, InlineKeyboard, Keyboard, session, SessionFlavor } from "grammy";
import { Menu } from "@grammyjs/menu";
import { hydrateFiles, FileFlavor } from "@grammyjs/files";
import { RedisAdapter } from "@grammyjs/storage-redis";
import redis from "./redis";
import { ReceiptStatus } from "./generated/prisma";
import prisma from "./prisma";
import { z } from "zod";
import isV2rayConfig from "./utils/isV2rayConfig";
import { getAllAdmins, getUser } from "./controllers/user.controller";

const storage = new RedisAdapter({ instance: redis });

// Define session structure
interface SessionData {
  pendingSubscription?: {
    users: number;
    price: number;
  };
  pendingSubscriptionAccept?: {
    receiptId: number;
    selectedPlanKey: keyof typeof PRICING;
  }
}

type MyContext = FileFlavor<Context> & SessionFlavor<SessionData>;

// Create bot with session management
const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);
bot.api.config.use(hydrateFiles(bot.token, undefined));
bot.use(session({
  initial: () => ({}),
  storage,
}));

// Pricing configuration for 1-month plans only
const PRICING = {
  '1': { users: 1, price: 10 },
  '2': { users: 2, price: 18 },
  '3': { users: 3, price: 25 },
};

// Security constants
const CARD_NUMBER = "1234 5678 9012 3456"; // Replace with actual card number
const BANK_NAME = "Example Bank"; // Replace with actual bank name

// ======================
// Menus
// ======================

const mainMenu = new Menu<MyContext>("main-menu")
  .text("💰 Buy Config", async ctx => {
    await showSubscriptionOptions(ctx);
  })
// .text("📡 Get Config", async ctx => {
//   await handleConfigRequest(ctx);
// });

// ======================
// Command Handlers
// ======================

bot.use(mainMenu);

bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    await prisma.user.upsert({
      where: { telegramId: ctx.from.id },
      create: { telegramId: ctx.from.id },
      update: {}
    });
  }
  next();
});

bot.command("start", async (ctx) => {
  await ctx.reply("Welcome to VPN Service! Choose an option:", {
    reply_markup: mainMenu
  });
});

bot.command("admin", async (ctx) => {
  const user = await getUser(ctx.from!.id);
  if (user.isAdmin) {
    await handleAdminPanel(ctx);
  } else {
    await ctx.reply("⚠️ Unauthorized: Admin access required");
  }
});

// ======================
// Subscription Flow (1-month only)
// ======================

async function showSubscriptionOptions(ctx: MyContext) {
  // FIX: Create keyboard without using .back()
  const keyboard = new Keyboard()
    .text("1 Month - 1 User ($10)").row()
    .text("1 Month - 2 Users ($18)").row()
    .text("1 Month - 3 Users ($25)").row()
    .text("Back to Menu"); // Add "Back to Menu" as a regular button

  await ctx.reply("Choose subscription plan:", {
    reply_markup: keyboard
  });
}

// Handle "Back to Menu" button
bot.hears("Back to Menu", async (ctx) => {
  await ctx.reply("Choose an option:", {
    reply_markup: mainMenu
  });
});

bot.hears(/1 Month - (\d+) Users? \(\$(\d+)\)/, async (ctx) => {
  const [_, users, price] = ctx.match!;
  const key = users as keyof typeof PRICING;

  if (!PRICING[key]) {
    await ctx.reply("Invalid subscription option");
    return;
  }

  const user = await getUser(ctx.from!.id);
  const { price: requiredPrice } = PRICING[key];

  ctx.session.pendingSubscription = PRICING[key];
  await ctx.reply(
    `Please send $${requiredPrice} to:\n` +
    `Bank: ${BANK_NAME}\n` +
    `Card: ${CARD_NUMBER}\n\n` +
    "Reply with a photo of your payment receipt.",
    { reply_markup: { remove_keyboard: true } }
  );
});

// ======================
// Receipt Handling
// ======================

bot.on("message", async (ctx) => {
  if (ctx.session.pendingSubscriptionAccept) {
    const config = ctx.msg.text;
    if (!config || !isV2rayConfig(config)) return await ctx.reply('Invalid v2ray config');

    // Update receipt
    const { userId } = await prisma.receipt.update({
      where: { id: ctx.session.pendingSubscriptionAccept.receiptId },
      data: { status: ReceiptStatus.APPROVED },
      select: { userId: true }
    });

    // Add funds to user's balance
    const { users } = PRICING[ctx.session.pendingSubscriptionAccept.selectedPlanKey];

    await ctx.api.sendMessage(
      userId,
      `🎉 Config activated!\n` +
      `👥 Users: ${users}\n\n` +
      `Your config:\n\n\`${config}\``,
      { parse_mode: "Markdown" }
    );

    await ctx.answerCallbackQuery("Payment approved and subscription activated!");
    await ctx.deleteMessage();
  }
});

bot.on("message:photo", async (ctx) => {
  if (ctx.session.pendingSubscription) {
    const file = await ctx.getFile();
    const { users, price } = ctx.session.pendingSubscription;

    await prisma.receipt.create({
      data: {
        amount: price,
        image: file.file_id,
        status: ReceiptStatus.PENDING,
        userId: ctx.from!.id,
      }
    });

    // Notify admins
    const admins = await getAllAdmins();
    await Promise.all(admins.map(admin =>
      ctx.api.sendPhoto(admin.telegramId, file.file_id, {
        caption: `New receipt from ${ctx.from!.id} for $${price} (1 month, ${users} user(s))`,
        reply_markup: new InlineKeyboard()
          .text("✅ Approve", `approve_${ctx.from!.id}_${users}`)
          .text("❌ Reject", `reject_${ctx.from!.id}`)
      })
    ));

    await ctx.reply("Receipt submitted for review. You'll receive your config once approved.");
    ctx.session.pendingSubscription = undefined;
  }
});

// ======================
// Admin Approval Flow with Security Checks
// ======================

bot.callbackQuery(/approve_(\d+)_(\d+)/, async (ctx) => {
  // Security: Verify admin status
  const adminUser = await getUser(ctx.from!.id);

  if (!adminUser?.isAdmin) {
    await ctx.answerCallbackQuery("⚠️ Unauthorized: Admin access required");
    return;
  }

  const [_, userId, users] = ctx.match!;
  const numericUserId = parseInt(userId);
  const numericUsers = parseInt(users);

  // Verify valid user
  const user = await prisma.user.findUnique({
    where: { telegramId: numericUserId }
  });

  if (!user) {
    await ctx.answerCallbackQuery("User not found");
    return;
  }

  // Get pending receipt
  const receipt = await prisma.receipt.findFirst({
    where: {
      userId: numericUserId,
      status: ReceiptStatus.PENDING
    },
    orderBy: { createdAt: 'desc' }
  });

  if (!receipt) {
    await ctx.answerCallbackQuery("No pending receipt found");
    return;
  }

  ctx.session.pendingSubscriptionAccept = {
    receiptId: receipt.id,
    selectedPlanKey: users as keyof typeof PRICING
  };
  await ctx.answerCallbackQuery('Provide your config string: ');
});

bot.callbackQuery(/reject_(\d+)/, async (ctx) => {
  // Security: Verify admin status
  const adminUser = await getUser(ctx.from!.id);

  if (!adminUser?.isAdmin) {
    await ctx.answerCallbackQuery("⚠️ Unauthorized: Admin access required");
    return;
  }

  const userId = parseInt(ctx.match![1]);

  // Update all pending receipts for this user
  await prisma.receipt.updateMany({
    where: {
      userId,
      status: ReceiptStatus.PENDING
    },
    data: { status: ReceiptStatus.REJECTED }
  });

  await ctx.api.sendMessage(
    userId,
    "⚠️ Your payment was rejected. Please contact support if you believe this was a mistake."
  );

  await ctx.answerCallbackQuery("Payment rejected!");
  await ctx.deleteMessage();
});

// ======================
// Secure Helper Functions
// ======================

async function handleAdminPanel(ctx: MyContext) {
  const pendingCount = await prisma.receipt.count({
    where: { status: ReceiptStatus.PENDING }
  });

  await ctx.reply(`🔒 Admin Panel\nPending receipts: ${pendingCount}`, {
    reply_markup: new Keyboard()
      .text("📝 View Pending Receipts")
      .text("📊 Stats")
      .resized()
  });
}

// ======================
// Security Enhancements
// ======================

// Validate all callback queries have an admin user
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery?.data?.startsWith('approve_') ||
    ctx.callbackQuery?.data?.startsWith('reject_')) {
    const user = await getUser(ctx.from!.id);

    if (!user?.isAdmin) {
      await ctx.answerCallbackQuery("⚠️ Unauthorized: Admin access required");
      return;
    }
  }
  await next();
});

// Start the bot
bot.start();
console.log("Bot is running...");

// Error handling
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
});