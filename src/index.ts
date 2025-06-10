import "dotenv/config";
import { Bot, Context, InlineKeyboard, Keyboard, session, SessionFlavor } from "grammy";
import { Menu } from "@grammyjs/menu";
import { hydrateFiles, FileFlavor } from "@grammyjs/files";
import { RedisAdapter } from "@grammyjs/storage-redis";
import redis from "./redis";
import { ReceiptStatus } from "./generated/prisma";
import prisma from "./prisma";
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

// Validate all callback queries have an admin user
bot.use(async (ctx, next) => {
  const user = await getUser(ctx.from!.id);
  
  if (ctx.callbackQuery?.data?.startsWith('approve_') ||
    ctx.callbackQuery?.data?.startsWith('reject_')) {
    if (!user?.isAdmin) {
      await ctx.answerCallbackQuery("⚠️ دسترسی غیرمجاز: دسترسی ادمین مورد نیاز است");
      return;
    }
  }
  await next();
});

// Pricing configuration for 1-month plans only
const PRICING = {
  '1': { users: 2, price: 150 },
  '2': { users: 3, price: 190 },
  '3': { users: 4, price: 230 },
  '4': { users: Infinity, price: 290 }
};

// Persian mapping for subscription options
const PERSIAN_MAPPING: Record<string, keyof typeof PRICING> = {
  'دو کاربره (150 هزار تومن)': '1',
  'سه کاربره (190 هزار تومن)': '2',
  'چهار کاربره (230 هزار تومن)': '3',
  'کاربر نامحدود (290 هزار تومن)': '4'
};

// Security constants
const CARD_NUMBER = "1234 5678 9012 3456"; // Replace with actual card number
const BANK_NAME = "بانک مثال"; // Replace with actual bank name

// ======================
// Menus
// ======================

const mainMenu = new Menu<MyContext>("main-menu")
  .text("💰 خرید کانفیگ", async ctx => {
    await showSubscriptionOptions(ctx);
  })
// .text("📡 دریافت کانفیگ", async ctx => {
//   await handleConfigRequest(ctx);
// });

// ======================
// Command Handlers
// ======================

bot.use(mainMenu);

bot.command("start", async (ctx) => {
  await ctx.reply("به سرویس VPN خوش آمدید! گزینه ای را انتخاب کنید:", {
    reply_markup: mainMenu
  });
});

bot.command("admin", async (ctx) => {
  const user = await getUser(ctx.from!.id);
  if (user.isAdmin) {
    await handleAdminPanel(ctx);
  } else {
    await ctx.reply("⚠️ دسترسی غیرمجاز: دسترسی ادمین مورد نیاز است");
  }
});

// ======================
// Subscription Flow (1-month only)
// ======================

async function showSubscriptionOptions(ctx: MyContext) {
  // FIX: Create keyboard without using .back()
  const keyboard = new Keyboard()
    .text("دو کاربره (150 هزار تومن)").row()
    .text("سه کاربره (190 هزار تومن)").row()
    .text("چهار کاربره (230 هزار تومن)").row()
    .text("کاربر نامحدود (290 هزار تومن)").row()
    .text("بازگشت به منو");

  await ctx.reply("پلن اشتراک مورد نظر را انتخاب کنید:", {
    reply_markup: keyboard
  });
}

// Handle "Back to Menu" button
bot.hears("بازگشت به منو", async (ctx) => {
  await ctx.reply("گزینه ای را انتخاب کنید:", {
    reply_markup: mainMenu
  });
});

// Fixed regex for Persian callbacks
bot.hears([
  "دو کاربره (150 هزار تومن)",
  "سه کاربره (190 هزار تومن)",
  "چهار کاربره (230 هزار تومن)",
  "کاربر نامحدود (290 هزار تومن)"
], async (ctx) => {
  const text = ctx.msg.text;
  const key = PERSIAN_MAPPING[text!];

  if (!key || !PRICING[key]) {
    await ctx.reply("گزینه اشتراک نامعتبر است");
    return;
  }

  const { users, price } = PRICING[key];
  ctx.session.pendingSubscription = PRICING[key];
  
  await ctx.reply(
    `لطفا مبلغ ${price} هزار تومان را به شماره کارت زیر واریز کنید:\n` +
    `بانک: ${BANK_NAME}\n` +
    `شماره کارت: ${CARD_NUMBER}\n\n` +
    "پس از پرداخت، عکس فیش واریزی را ارسال کنید.",
    { reply_markup: { remove_keyboard: true } }
  );
});

// ======================
// Receipt Handling
// ======================

bot.on("message", async (ctx) => {
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
        caption: `رسید جدید از کاربر ${ctx.from!.id} برای مبلغ ${price} هزار تومان (1 ماهه، ${users} کاربر)`,
        reply_markup: new InlineKeyboard()
          .text("✅ تایید", `approve_${ctx.from!.id}_${users}`)
          .text("❌ رد", `reject_${ctx.from!.id}`)
      })
    ));

    await ctx.reply("رسید پرداخت برای بررسی ارسال شد. پس از تایید، کانفیگ خود را دریافت خواهید کرد.");
    ctx.session.pendingSubscription = undefined;
  } else if (ctx.session.pendingSubscriptionAccept) {
    const config = ctx.msg.text;
    if (!config || !isV2rayConfig(config)) return await ctx.reply('کانفیگ v2ray نامعتبر است');

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
      `🎉 کانفیگ فعال شد!\n` +
      `👥 تعداد کاربران: ${users}\n\n` +
      `کانفیگ شما:\n\n\`${config}\``,
      { parse_mode: "Markdown" }
    );

    await ctx.reply("پرداخت تایید و کانفیگ ارسال شد!");
  }
});

// ======================
// Admin Approval Flow with Security Checks
// ======================

bot.callbackQuery(/approve_(\d+)_(\d+)/, async (ctx) => {
  // Security: Verify admin status
  const adminUser = await getUser(ctx.from!.id);

  if (!adminUser?.isAdmin) {
    await ctx.answerCallbackQuery("⚠️ دسترسی غیرمجاز: دسترسی ادمین مورد نیاز است");
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
    await ctx.answerCallbackQuery("کاربر یافت نشد");
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
    await ctx.answerCallbackQuery("هیچ رسید در حال انتظاری یافت نشد");
    return;
  }

  ctx.session.pendingSubscriptionAccept = {
    receiptId: receipt.id,
    selectedPlanKey: users as keyof typeof PRICING
  };
  await ctx.answerCallbackQuery('رشته کانفیگ خود را وارد کنید: ');
});

bot.callbackQuery(/reject_(\d+)/, async (ctx) => {
  // Security: Verify admin status
  const adminUser = await getUser(ctx.from!.id);

  if (!adminUser?.isAdmin) {
    await ctx.answerCallbackQuery("⚠️ دسترسی غیرمجاز: دسترسی ادمین مورد نیاز است");
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
    "⚠️ پرداخت شما رد شد. در صورتی که این خطا می‌باشد با پشتیبانی تماس بگیرید."
  );

  await ctx.answerCallbackQuery("پرداخت رد شد!");
  await ctx.deleteMessage();
});

// ======================
// Secure Helper Functions
// ======================

async function handleAdminPanel(ctx: MyContext) {
  const pendingCount = await prisma.receipt.count({
    where: { status: ReceiptStatus.PENDING }
  });

  await ctx.reply(`🔒 پنل ادمین\nتعداد رسیدهای در انتظار: ${pendingCount}`, {
    reply_markup: new Keyboard()
      .text("📝 مشاهده رسیدهای در انتظار")
      .text("📊 آمار")
      .resized()
  });
}

// Start the bot
bot.start();
console.log("Bot is running...");

bot.catch(err => console.error(err));

// Error handling
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
});