/**
 * Script tạo session string cho GramJS
 * Chạy 1 lần: pnpm auth:telegram
 * Sẽ hỏi phone number → nhập code → tạo session string
 * Copy session string vào .env TELEGRAM_SESSION=
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import * as readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  console.log("=== Telegram Session Generator ===\n");

  const apiId = await ask("Nhập API ID (từ my.telegram.org): ");
  const apiHash = await ask("Nhập API Hash: ");

  const session = new StringSession("");
  const client = new TelegramClient(session, parseInt(apiId), apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Nhập số điện thoại (VD: +84123456789): "),
    password: async () => await ask("Nhập mật khẩu 2FA (nếu có, nhấn Enter để bỏ qua): "),
    phoneCode: async () => await ask("Nhập code từ Telegram: "),
    onError: (err) => console.error("Error:", err),
  });

  const sessionString = client.session.save() as unknown as string;

  console.log("\n✅ Đã tạo session thành công!\n");
  console.log("Copy dòng sau vào file .env:\n");
  console.log(`TELEGRAM_SESSION=${sessionString}`);
  console.log(`\nTELEGRAM_API_ID=${apiId}`);
  console.log(`TELEGRAM_API_HASH=${apiHash}`);

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
