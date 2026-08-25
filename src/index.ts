import { VERSION } from "./version.js";

async function main() {
  // Checked before anything else — including the config-loading import
  // below, which is dynamic specifically so this path never triggers it.
  // config.ts searches for and reads an env file as a module-level side
  // effect the moment it's imported, so a static import at the top of this
  // file would run that search (and log a line about it) on every
  // `--version` invocation too. Importing it lazily, only once we know
  // we're not just printing the version, keeps `--version` from touching
  // config loading, Slack connection, or anything else in this file.
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const { loadConfig } = await import("./config.js");
  const { buildApp } = await import("./slack/app.js");

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
