import { loadConfig } from "./config.js";
import { buildApp } from "./slack/app.js";

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);

  await app.start();
  console.log("⚡️ cctag is running (Socket Mode)");

  const shutdown = async () => {
    console.log("Shutting down…");
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("cctag failed to start:", err);
  process.exit(1);
});
