import { Bot, Context, InlineKeyboard, session, SessionFlavor } from "grammy";
import { RedisAdapter } from "@grammyjs/storage-redis";
import "dotenv/config";
import { z } from "zod";
import redis from "./redis";

enum SessionState {
  AWAITING_MONTHS = 'AWAITING_MONTHS',
  AWAITING_RECEIPT = 'AWAITING_RECEIPT',
}

interface SessionData {
  state?: SessionState;
  months?: number;
}

// Init bot
const botToken = z.string().safeParse(process.env.BOT_TOKEN);
if (!botToken.success) throw new Error('Bot token environment variable is invalid');
const bot = new Bot<Context & SessionFlavor<SessionData>>(botToken.data);

const storage = new RedisAdapter({ instance: redis });

bot.use(session({ storage, initial: () => ({}) }));

// Main menu
const menu = new InlineKeyboard()
  .text("🛒 Buy Subscription", "buy_subscription")
  .row()
  .text("⚙️ Request Config", "request_config");

// Start command
bot.command("start", (ctx) =>
  ctx.reply("Welcome! What do you want to do?", {
    reply_markup: menu,
  })
);

// Handle menu selection
bot.callbackQuery("buy_subscription", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Enter the number of months you want to subscribe for (1–12):");
  ctx.session = { state: SessionState.AWAITING_MONTHS };
});

bot.callbackQuery("request_config", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Here is your config: \n`your-config-value`", {
    parse_mode: "Markdown",
  });
});

// Message handler for input flow
bot.on("message", async (ctx) => {
  if (ctx.session.state === SessionState.AWAITING_MONTHS) {
    const num = await z.number({ coerce: true }).min(1).max(12).safeParseAsync(ctx.message.text);
    if (!num.success) {
      return ctx.reply("❌ Please enter a number between 1 and 12.");
    }
    ctx.session.months = num.data;
    ctx.session.state = SessionState.AWAITING_RECEIPT;
    return ctx.reply(
      `💳 To complete your purchase of ${num} month(s), send payment to this credit card:\n\n4242 4242 4242 4242\n\nThen, upload a photo of your receipt.`
    );
  }

  if (ctx.session.state === SessionState.AWAITING_RECEIPT) {
    if (!ctx.message.photo) {
      return ctx.reply("❌ Please upload a photo of the receipt.");
    }

    ctx.session.state = undefined; // Reset
    return ctx.reply("✅ Thank you! Your subscription will be activated shortly.");
  }

  ctx.reply("Use /start to begin.");
});

// Launch
bot.start();
console.log("🤖 Bot is running...");
