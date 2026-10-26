/**
 * Minimal example. Run inside a host bot that already has a connected Baileys
 * socket: `node examples/basic.js`
 */
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { getCaller } from "../src/index.js";

const { state, saveCreds } = await useMultiFileAuthState("./session");
const sock = makeWASocket({ auth: state, printQRInTerminal: true });
sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", async ({ connection }) => {
  if (connection !== "open") return;

  const caller = await getCaller(sock);
  caller.on("error", (error) => console.error("[caller]", error));

  await caller.setAutoAnswer({
    enabled: true,
    audioSource: "./audio/welcome.mp3",
    delayMs: 500,
    maxSeconds: 120,
  }).preloadAudio(["./audio/welcome.mp3"]);

  console.log("wa-caller ready. Incoming calls will be answered.");
});
