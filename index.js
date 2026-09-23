const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const admin = require("firebase-admin");

// ---------- Firebase setup ----------
// Set FIREBASE_SERVICE_ACCOUNT_BASE64 as an env var on Railway:
// base64 of your Firebase service account JSON key file.
if (!admin.apps.length) {
  const saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!saB64) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64 env var.");
    process.exit(1);
  }
  const serviceAccount = JSON.parse(
    Buffer.from(saB64, "base64").toString("utf8")
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ---------- Config ----------
// Optional: restrict the bot to only respond inside one specific group.
// Leave blank to allow it to respond in any group it's a member of.
const ALLOWED_GROUP_JID = process.env.ALLOWED_GROUP_JID || "";

// Trigger word(s) that make the bot reply
const TRIGGER_WORDS = ["@bot", "bot,", "hey bot"];

function isTriggered(text) {
  const lower = text.toLowerCase();
  return TRIGGER_WORDS.some((t) => lower.includes(t));
}

// ---------- Bot logic ----------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nScan this QR code with WhatsApp (Linked Devices):\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        "Connection closed.",
        shouldReconnect ? "Reconnecting..." : "Logged out, not reconnecting."
      );
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid || "";
        const isGroup = remoteJid.endsWith("@g.us");
        if (!isGroup) continue; // ignore 1:1 DMs for this bot
        if (ALLOWED_GROUP_JID && remoteJid !== ALLOWED_GROUP_JID) continue;

        const sender = msg.key.participant || remoteJid;
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        if (!text) continue;

        console.log(`[${remoteJid}] ${sender}: ${text}`);

        // Log every message to Firestore
        await db.collection("group_memory").add({
          groupId: remoteJid,
          sender,
          message: text,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Reply when triggered
        if (isTriggered(text)) {
          const replyText = await buildReply(text, remoteJid);
          await sock.sendMessage(remoteJid, { text: replyText });
        }
      } catch (err) {
        console.error("Error handling message:", err);
        try {
          await db.collection("bot_errors").add({
            error: String(err),
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (_) {}
      }
    }
  });
}

// Customize this to pull recent context, answer questions about the vote, etc.
async function buildReply(incomingText, groupId) {
  // Simple starter reply — replace with your own logic
  // (e.g. look up recent messages from Firestore about "vote" and summarize them)
  return "Hey! I'm keeping track of what's happening here. The vote is Monday — let me know if you need a recap.";
}

startBot().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
