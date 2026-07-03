import { Bot, webhookCallback, InlineKeyboard } from "grammy";

export interface Env {
  BOT_TOKEN: string;
  DB: D1Database;
  AI: any;
}

const CATEGORIES: Record<string, { label: string; emoji: string }> = {
  Food: { label: "Makanan", emoji: "🍔" },
  Transport: { label: "Transportasi", emoji: "🚗" },
  Shopping: { label: "Belanja", emoji: "🛍️" },
  Bills: { label: "Tagihan", emoji: "💵" },
  Entertainment: { label: "Hiburan", emoji: "🎬" },
  Others: { label: "Lainnya", emoji: "📦" }
};

// Validated Parser Rupiah - Menghindari bug parseFloat("150.000") -> 150 di JS
function parseRupiahInput(text: string): number {
  let cleaned = text.trim().replace(/[,.]00$/, ""); 
  cleaned = cleaned.replace(/\D/g, ""); 
  const amount = parseInt(cleaned, 10);
  return isNaN(amount) ? 0 : amount;
}

function formatRupiah(amount: number): string {
  return "Rp " + Math.round(amount).toLocaleString("id-ID");
}

function generateProgressBar(ratio: number, size = 10): string {
  const filledSize = Math.min(size, Math.max(0, Math.round(ratio * size)));
  const emptySize = size - filledSize;
  return "█".repeat(filledSize) + "░".repeat(emptySize);
}

async function ensureUser(db: D1Database, userId: number, username: string | undefined) {
  await db.prepare("INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)")
    .bind(userId, username || null)
    .run();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/setup") {
      const bot = new Bot<any>(env.BOT_TOKEN);
      try {
        const webhookUrl = `${url.origin}/webhook`;
        await bot.api.setWebhook(webhookUrl);
        return new Response(`Webhook successfully set to: ${webhookUrl}`, { status: 200 });
      } catch (err: any) {
        return new Response(`Webhook setup failed: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/webhook") {
      const bot = new Bot<any>(env.BOT_TOKEN);

      // Register User Middleware
      bot.use(async (ctx, next) => {
        if (ctx.from) {
          await ensureUser(env.DB, ctx.from.id, ctx.from.username);
        }
        await next();
      });

      // Command /start
      bot.command("start", async (ctx) => {
        const text = `👋 *Halo! Selamat datang di AI Expense Tracker Bot!*\n\n` +
          `Bot ini berjalan 100% gratis di Cloudflare Edge Server via GitHub CI/CD.\n\n` +
          `🤖 *Fitur Utama:*\n` +
          `1. 📸 *Scan Struk Belanja:* Cukup kirim foto struk, AI Google Gemma 4 akan memprosesnya secara instan!\n` +
          `2. 📝 *Manual Input:* Tambahkan pengeluaran manual via tombol /add.\n` +
          `3. 📊 *Grafik Pengeluaran:* Ketik /chart untuk melihat visualisasi bulanan.\n` +
          `4. 🎯 *Set Budget:* Pantau limit belanja kategori bulanan via /budgets.\n\n` +
          `Hubungi /help jika butuh panduan lengkap.`;
        await ctx.reply(text, { parse_mode: "Markdown" });
      });

      // Command /help
      bot.command("help", async (ctx) => {
        const helpText = `🛠️ *Daftar Perintah Bot:*\n\n` +
          `• /add - Membuka menu interaktif tambah transaksi.\n` +
          `• /add <jumlah> <kategori> <keterangan> - Input cepat manual (Contoh: \`/add 50000 Food Nasi Goreng\`).\n` +
          `• /history - Melihat histori pengeluaran ter-paginasi.\n` +
          `• /setbudget - Mengonfigurasi batasan pengeluaran bulanan.\n` +
          `• /budgets - Memantau sisa budget dilengkapi progress bar.\n` +
          `• /chart - Laporan keuangan visual dilengkapi persentase.\n\n` +
          `💡 *Tips:* Cukup kirimkan foto struk belanja untuk deteksi otomatis via AI!`;
        await ctx.reply(helpText, { parse_mode: "Markdown" });
      });

      // Command /add Manual
      bot.command("add", async (ctx) => {
        const args = ctx.match ? ctx.match.trim().split(/\s+/) : [];
        if (args.length >= 2) {
          const amount = parseRupiahInput(args[0]);
          const categoryInput = args[1];
          const description = args.slice(2).join(" ") || "Tanpa keterangan";

          const matchingKey = Object.keys(CATEGORIES).find(
            key => key.toLowerCase() === categoryInput.toLowerCase() || CATEGORIES[key].label.toLowerCase() === categoryInput.toLowerCase()
          );

          if (amount <= 0 || !matchingKey) {
            await ctx.reply("❌ *Format Salah!*\nGunakan format: `/add <jumlah> <kategori> <keterangan>`\nContoh: `/add 50000 Food Nasi Goreng`\n\nPilihan kategori: `Food, Transport, Shopping, Bills, Entertainment, Others`", { parse_mode: "Markdown" });
            return;
          }

          await env.DB.prepare(
            "INSERT INTO transactions (user_id, amount, category, description, date, status) VALUES (?, ?, ?, ?, date('now'), 'confirmed')"
          )
            .bind(ctx.from?.id, amount, matchingKey, description)
            .run();

          await ctx.reply(`✅ *Transaksi Disimpan!*\n💰 Nominal: ${formatRupiah(amount)}\n🏷️ Kategori: ${CATEGORIES[matchingKey].emoji} ${CATEGORIES[matchingKey].label}\n📝 Keterangan: ${description}`, { parse_mode: "Markdown" });
          return;
        }

        const kb = new InlineKeyboard();
        for (const [key, value] of Object.entries(CATEGORIES)) {
          kb.text(`${value.emoji} ${value.label}`, `tx:add_cat:${key}`).row();
        }
        await ctx.reply("💬 *Pilih Kategori Transaksi Baru:*", { reply_markup: kb });
      });

      // Command /history
      bot.command("history", async (ctx) => {
        await sendHistoryPage(ctx, env, 1);
      });

      // Command /setbudget
      bot.command("setbudget", async (ctx) => {
        const kb = new InlineKeyboard();
        for (const [key, value] of Object.entries(CATEGORIES)) {
          kb.text(`${value.emoji} ${value.label}`, `budget:select:${key}`).row();
        }
        await ctx.reply("🎯 *Pilih kategori yang ingin diatur limit budget bulanan-nya:*", { reply_markup: kb });
      });

      // Command /budgets
      bot.command("budgets", async (ctx) => {
        const userId = ctx.from?.id;
        const budgets = await env.DB.prepare("SELECT category, amount FROM budgets WHERE user_id = ?")
          .bind(userId)
          .all<{ category: string; amount: number }>();

        if (!budgets.results || budgets.results.length === 0) {
          await ctx.reply("📋 *Anda belum mengatur budget bulanan.*\nKetik /setbudget untuk menyeting limit kategori belanja Anda.");
          return;
        }

        let response = "🎯 *MONITORING BUDGET BULAN INI*\n";
        response += `---------------------------------------\n\n`;

        for (const b of budgets.results) {
          const cat = CATEGORIES[b.category] || { label: b.category, emoji: "📝" };
          const spendResult = await env.DB.prepare(
            "SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND category = ? AND status = 'confirmed' AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now')"
          )
            .bind(userId, b.category)
            .first<{ total: number }>();

          const totalSpend = spendResult?.total || 0;
          const ratio = b.amount > 0 ? totalSpend / b.amount : 0;
          const bar = generateProgressBar(ratio);
          const percent = ratio * 100;

          response += `${cat.emoji} *${cat.label}*\n`;
          response += `├ Pengeluaran: ${formatRupiah(totalSpend)} / ${formatRupiah(b.amount)}\n`;
          response += `├ Rasio: ${percent.toFixed(1)}%\n`;
          response += `└ Limit: \`[${bar}]\` ${totalSpend > b.amount ? "⚠️ *OVER BUDGET!*" : ""}\n\n`;
        }

        await ctx.reply(response, { parse_mode: "Markdown" });
      });

      // Command /chart
      bot.command("chart", async (ctx) => {
        const userId = ctx.from?.id;
        const records = await env.DB.prepare(
          "SELECT category, SUM(amount) as total FROM transactions WHERE user_id = ? AND status = 'confirmed' AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now') GROUP BY category"
        )
          .bind(userId)
          .all<{ category: string; total: number }>();

        if (!records.results || records.results.length === 0) {
          await ctx.reply("📊 Belum ada transaksi tercatat untuk bulan ini.");
          return;
        }

        let grandTotal = 0;
        for (const r of records.results) {
          grandTotal += r.total;
        }

        const dateLabel = new Date().toLocaleString("id-ID", { month: "long", year: "numeric" });
        let chartText = `📊 *RINGKASAN BELANJA BULAN INI*\n`;
        chartText += `📅 _Periode: ${dateLabel}_\n`;
        chartText += `---------------------------------------\n\n`;

        for (const r of records.results) {
          const cat = CATEGORIES[r.category] || { label: r.category, emoji: "📝" };
          const percentage = (r.total / grandTotal) * 100;
          const bar = generateProgressBar(r.total / grandTotal, 10);

          chartText += `${cat.emoji} *${cat.label}*\n`;
          chartText += `├ Total: ${formatRupiah(r.total)} (${percentage.toFixed(1)}%)\n`;
          chartText += `└ Grafik: \`[${bar}]\`\n\n`;
        }

        chartText += `---------------------------------------\n`;
        chartText += `💰 *TOTAL PENGELUARAN:* ${formatRupiah(grandTotal)}`;

        await ctx.reply(chartText, { parse_mode: "Markdown" });
      });

      // OCR Vision Scanner (Powered by Google Gemma 4 MoE - Flat Vision Schema)
      bot.on("message:photo", async (ctx) => {
        const userId = ctx.from?.id;
        const waitingMsg = await ctx.reply("⏳ *Sedang membaca struk belanja Anda menggunakan Google Gemma 4 AI...*", { parse_mode: "Markdown" });

        try {
          const photos = ctx.message.photo;
          const fileId = photos[photos.length - 1].file_id;
          const file = await ctx.api.getFile(fileId);
          
          const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
          const imageRes = await fetch(fileUrl);
          const imageBuffer = await imageRes.arrayBuffer();

          const systemPrompt = `Anda adalah asisten keuangan pintar. Analisis gambar struk/nota belanja ini dan ekstrak data penting.
Berikan output strictly dalam format JSON murni tanpa hiasan markdown backtick, percakapan pembuka, ataupun penutup.
Struktur JSON yang WAJIB dipatuhi:
{
  "amount": <angka total belanja dalam tipe data float/integer, hilangkan titik ribuan/simbol mata uang, misal: 150000>,
  "category": "<pilih salah satu: Food, Transport, Shopping, Bills, Entertainment, Others>",
  "description": "<singkat, tuliskan nama merchant atau barang dominan dibeli, maksimal 40 karakter>"
}`;

          // Menggunakan Skema Visi Datar (Flat Schema) - Terbukti Tangguh & Bebas Eror 5006
          const aiResponse = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
            prompt: systemPrompt,
            image: [...new Uint8Array(imageBuffer)]
          });

          let textResult = "";
          if (typeof aiResponse === "string") {
            textResult = aiResponse;
          } else if (aiResponse && typeof aiResponse === "object") {
            if ("response" in aiResponse) {
              textResult = aiResponse.response;
            } else if ("choices" in aiResponse && Array.isArray(aiResponse.choices) && aiResponse.choices.length > 0) {
              textResult = aiResponse.choices[0].message?.content || "";
            }
          }

          const jsonStart = textResult.indexOf("{");
          const jsonEnd = textResult.lastIndexOf("}");
          if (jsonStart === -1 || jsonEnd === -1) {
            throw new Error("Gagal membaca struktur belanja struk.");
          }
          const parsedData = JSON.parse(textResult.substring(jsonStart, jsonEnd + 1));

          // Guardrail 1: Validasi struktur data hasil parsing AI
          const amount = parseFloat(parsedData.amount);
          const category = parsedData.category || "Others";
          const description = parsedData.description || "Struk Belanja";

          // Guardrail 2: Cek nominal tidak masuk akal / eror OCR
          if (isNaN(amount) || amount <= 0 || amount > 50000000) { 
            throw new Error("Nominal belanja terdeteksi di luar batas wajar (Rp 0 - Rp 50.000.000).");
          }

          // SQLite 3.35+ RETURNING clause (Type-Safe)
          const insertResult = await env.DB.prepare(
            "INSERT INTO transactions (user_id, amount, category, description, date, status) VALUES (?, ?, ?, ?, date('now'), 'pending') RETURNING id"
          )
            .bind(userId, amount, category, description)
            .first<{ id: number }>();

          const draftId = insertResult?.id;
          const cat = CATEGORIES[category] || { label: "Lainnya", emoji: "📦" };

          const confirmKb = new InlineKeyboard()
            .text("✅ Konfirmasi Sesuai", `ai_yes:${draftId}`)
            .text("❌ Batalkan", `ai_no:${draftId}`);

          await ctx.api.deleteMessage(ctx.chat.id, waitingMsg.message_id);
          await ctx.reply(
            `🤖 *HASIL DETEKSI STRUK (AI GEMMA 4)*\n` +
            `-----------------------------------\n` +
            `💰 *Nominal:* ${formatRupiah(amount)}\n` +
            `🏷️ *Kategori:* ${cat.emoji} ${cat.label}\n` +
            `📝 *Keterangan:* ${description}\n` +
            `-----------------------------------\n` +
            `Apakah data ekstraksi AI di atas sudah benar?`,
            { parse_mode: "Markdown", reply_markup: confirmKb }
          );

        } catch (err: any) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, waitingMsg.message_id);
          } catch {}
          await ctx.reply(`❌ *AI Gagal Memproses Gambar:*\n${err.message || "Pastikan foto struk cukup terang dan terbaca."}`);
        }
      });

      // Wizard State Interceptor (Force Replies)
      bot.on("message:text", async (ctx) => {
        if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
          const replyText = ctx.message.reply_to_message.text;
          const textContent = ctx.message.text.trim();

          // 1. Edit Nominal
          const amtMatch = replyText.match(/\[✏️ EDIT NOMINAL #(\d+)\]/);
          if (amtMatch) {
            const txId = parseInt(amtMatch[1]);
            const newAmount = parseRupiahInput(textContent);
            
            if (newAmount <= 0) {
              await ctx.reply("❌ Nominal tidak valid. Harus berupa angka positif.");
              return;
            }

            await env.DB.prepare("UPDATE transactions SET amount = ? WHERE id = ? AND user_id = ?")
              .bind(newAmount, txId, ctx.from.id)
              .run();

            await ctx.reply(`✅ *Selesai!* Nominal transaksi #${txId} berhasil diubah menjadi: *${formatRupiah(newAmount)}*`, { parse_mode: "Markdown" });
            return;
          }

          // 2. Tambah Transaksi Wizard
          const addMatch = replyText.match(/\[➕ TAMBAH TRANSAKSI #(\w+)\]/);
          if (addMatch) {
            const category = addMatch[1];
            const spaceIndex = textContent.indexOf(" ");
            let amountStr = textContent;
            let desc = "Tanpa keterangan";

            if (spaceIndex !== -1) {
              amountStr = textContent.substring(0, spaceIndex);
              desc = textContent.substring(spaceIndex + 1);
            }

            const amount = parseRupiahInput(amountStr);
            if (amount <= 0) {
              await ctx.reply("❌ Nominal tidak valid. Contoh input: \`50000 Nasi Padang\`.", { parse_mode: "Markdown" });
              return;
            }

            await env.DB.prepare(
              "INSERT INTO transactions (user_id, amount, category, description, date, status) VALUES (?, ?, ?, ?, date('now'), 'confirmed')"
            )
              .bind(ctx.from.id, amount, category, desc)
              .run();

            const cat = CATEGORIES[category];
            let budgetWarning = "";
            const budget = await env.DB.prepare("SELECT amount FROM budgets WHERE user_id = ? AND category = ?")
              .bind(ctx.from.id, category)
              .first<{ amount: number }>();

            if (budget) {
              const currentSpend = await env.DB.prepare(
                "SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND category = ? AND status = 'confirmed' AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now')"
              )
                .bind(ctx.from.id, category)
                .first<{ total: number }>();

              const total = currentSpend?.total || 0;
              if (total > budget.amount) {
                budgetWarning = `\n\n⚠️ *OVER BUDGET BULAN INI!* Total spend ${cat.emoji} ${cat.label} Anda telah mencapai *${formatRupiah(total)}* (Batas: ${formatRupiah(budget.amount)}).`;
              }
            }

            await ctx.reply(`✅ *Berhasil Disimpan!*\n\n🏷️ Kategori: ${cat.emoji} ${cat.label}\n💰 Nominal: *${formatRupiah(amount)}*\n📝 Keterangan: ${desc}${budgetWarning}`, { parse_mode: "Markdown" });
            return;
          }

          // 3. Set Budget Manual
          const bMatch = replyText.match(/\[🎯 SET BUDGET #(\w+)\]/);
          if (bMatch) {
            const category = bMatch[1];
            const budgetAmt = parseRupiahInput(textContent);

            if (budgetAmt <= 0) {
              await ctx.reply("❌ Budget tidak valid. Harap masukkan nominal angka positif.");
              return;
            }

            await env.DB.prepare(
              "INSERT INTO budgets (user_id, category, amount) VALUES (?, ?, ?) ON CONFLICT(user_id, category) DO UPDATE SET amount = EXCLUDED.amount"
            )
              .bind(ctx.from.id, category, budgetAmt)
              .run();

            const cat = CATEGORIES[category];
            await ctx.reply(`🎯 *Budget Tersimpan!*\nLimit bulanan untuk kategori ${cat.emoji} *${cat.label}* diset sebesar: *${formatRupiah(budgetAmt)}*`, { parse_mode: "Markdown" });
            return;
          }
        }
      });

      // Interactive Action Router
      bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data;
        const userId = ctx.from.id;

        try {
          if (data.startsWith("ai_yes:")) {
            const txId = parseInt(data.split(":")[1]);
            await env.DB.prepare("UPDATE transactions SET status = 'confirmed' WHERE id = ?").bind(txId).run();
            const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();

            if (tx) {
              const cat = CATEGORIES[tx.category] || { label: "Lainnya", emoji: "📦" };
              await ctx.editMessageText(`✅ *Transaksi Terkonfirmasi & Disimpan!*\n\n💰 *Nominal:* ${formatRupiah(tx.amount)}\n🏷️ *Kategori:* ${cat.emoji} ${cat.label}\n📝 *Keterangan:* ${tx.description || "-"}`, { parse_mode: "Markdown" });
            }
          }
          else if (data.startsWith("ai_no:")) {
            const txId = parseInt(data.split(":")[1]);
            await env.DB.prepare("DELETE FROM transactions WHERE id = ?").bind(txId).run();
            await ctx.editMessageText("❌ *Transaksi Dibatalkan.*\nDraft pengeluaran berhasil dihapus.", { parse_mode: "Markdown" });
          }
          else if (data.startsWith("hist:page:")) {
            const pageNum = parseInt(data.split(":")[2]);
            await sendHistoryPage(ctx, env, pageNum, true);
          }
          else if (data.startsWith("tx:view:")) {
            const txId = parseInt(data.split(":")[2]);
            const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ? AND user_id = ?").bind(txId, userId).first<any>();

            if (!tx) {
              await ctx.answerCallbackQuery({ text: "Transaksi tidak ditemukan.", show_alert: true });
              return;
            }

            const cat = CATEGORIES[tx.category] || { label: tx.category, emoji: "📝" };
            const detailText = `📝 *DETAIL TRANSAKSI #${tx.id}*\n` +
              `-------------------------------------\n` +
              `📅 *Tanggal:* ${tx.date}\n` +
              `🏷️ *Kategori:* ${cat.emoji} ${cat.label}\n` +
              `💰 *Jumlah:* ${formatRupiah(tx.amount)}\n` +
              `📝 *Keterangan:* ${tx.description || "-"}\n` +
              `-------------------------------------\n` +
              `Silakan pilih aksi manajemen transaksi di bawah ini:`;

            const kb = new InlineKeyboard()
              .text("🏷️ Ubah Kategori", `tx:edit_cat:${tx.id}`)
              .text("✏️ Ubah Nominal", `tx:edit_amt:${tx.id}`).row()
              .text("🗑️ Hapus Transaksi", `tx:delete:${tx.id}`).row()
              .text("🔙 Kembali", "hist:page:1");

            await ctx.editMessageText(detailText, { parse_mode: "Markdown", reply_markup: kb });
          }
          else if (data.startsWith("tx:edit_cat:")) {
            const txId = parseInt(data.split(":")[2]);
            const kb = new InlineKeyboard();
            for (const [key, value] of Object.entries(CATEGORIES)) {
              kb.text(`${value.emoji} ${value.label}`, `tx:set_cat:${txId}:${key}`).row();
            }
            kb.text("🔙 Batal", `tx:view:${txId}`);

            await ctx.editMessageText(`🏷️ *UBAH KATEGORI TRANSAKSI #${txId}*\n\nPilih kategori baru di bawah ini:`, { reply_markup: kb });
          }
          else if (data.startsWith("tx:set_cat:")) {
            const parts = data.split(":");
            const txId = parseInt(parts[2]);
            const newCat = parts[3];

            await env.DB.prepare("UPDATE transactions SET category = ? WHERE id = ? AND user_id = ?").bind(newCat, txId, userId).run();
            await ctx.answerCallbackQuery({ text: "Kategori berhasil diperbarui!" });
            
            const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
            const cat = CATEGORIES[tx.category];
            await ctx.editMessageText(
              `✅ *Kategori Transaksi Berhasil Diubah!*\n\nNominal: ${formatRupiah(tx.amount)}\nKategori Baru: ${cat.emoji} ${cat.label}`,
              { reply_markup: new InlineKeyboard().text("🔙 Kembali ke Detail", `tx:view:${txId}`) }
            );
          }
          else if (data.startsWith("tx:edit_amt:")) {
            const txId = parseInt(data.split(":")[2]);
            await ctx.reply(`[✏️ EDIT NOMINAL #${txId}] Balas pesan ini dengan nominal angka yang baru (Contoh: 75000):`, {
              reply_markup: { force_reply: true }
            });
            await ctx.answerCallbackQuery();
          }
          else if (data.startsWith("tx:delete:")) {
            const txId = parseInt(data.split(":")[2]);
            await env.DB.prepare("DELETE FROM transactions WHERE id = ? AND user_id = ?").bind(txId, userId).run();
            await ctx.answerCallbackQuery({ text: "Transaksi berhasil dihapus." });
            await ctx.editMessageText("🗑️ *Transaksi telah berhasil dihapus secara permanen.*", { parse_mode: "Markdown" });
          }
          else if (data.startsWith("tx:add_cat:")) {
            const catKey = data.split(":")[2];
            await ctx.reply(`[➕ TAMBAH TRANSAKSI #${catKey}] Balas pesan ini dengan nominal & keterangan.\n\nContoh: \`35000 Bakso Bakar\``, {
              reply_markup: { force_reply: true }
            });
            await ctx.answerCallbackQuery();
          }
          else if (data.startsWith("budget:select:")) {
            const catKey = data.split(":")[2];
            await ctx.reply(`[🎯 SET BUDGET #${catKey}] Balas pesan ini dengan batasan nominal pengeluaran bulanan Anda (Contoh: 1500000):`, {
              reply_markup: { force_reply: true }
            });
            await ctx.answerCallbackQuery();
          }

        } catch (e: any) {
          await ctx.answerCallbackQuery({ text: "Gagal memproses aksi.", show_alert: true });
        }
      });

      return webhookCallback(bot, "cloudflare-mod")(request);
    }

    return new Response("Bot is active and running!", { status: 200 });
  }
};

async function sendHistoryPage(ctx: any, env: Env, page: number, isEdit = false) {
  const userId = ctx.from?.id;
  const LIMIT = 5;
  const offset = (page - 1) * LIMIT;

  const records = await env.DB.prepare(
    "SELECT * FROM transactions WHERE user_id = ? AND status = 'confirmed' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
  )
    .bind(userId, LIMIT, offset)
    .all<any>();

  const totalRes = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND status = 'confirmed'"
  )
    .bind(userId)
    .first<{ count: number }>();

  const totalCount = totalRes?.count || 0;

  if (totalCount === 0) {
    const defaultText = "📋 *Belum ada riwayat transaksi tercatat.*";
    if (isEdit) {
      await ctx.editMessageText(defaultText);
    } else {
      await ctx.reply(defaultText, { parse_mode: "Markdown" });
    }
    return;
  }

  let text = `📜 *RIWAYAT TRANSAKSI ANDA* (Halaman ${page})\n`;
  text += `Klik pada salah satu tombol daftar transaksi di bawah ini untuk mengedit atau menghapusnya:\n\n`;

  const kb = new InlineKeyboard();
  for (const tx of records.results) {
    const cat = CATEGORIES[tx.category] || { label: tx.category, emoji: "📝" };
    const label = `${cat.emoji} ${formatRupiah(tx.amount)} | ${tx.description || "-"}`;
    kb.text(label, `tx:view:${tx.id}`).row();
  }

  kb.row();
  if (page > 1) {
    kb.text("◀️ Sebelum", `hist:page:${page - 1}`);
  }
  if (offset + LIMIT < totalCount) {
    kb.text("Lanjut ▶️", `hist:page:${page + 1}`);
  }

  if (isEdit) {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}
