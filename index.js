const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const admin = require("firebase-admin");
const http = require("http");

let latestQR = null;
let connectionStatus = "starting";

const PORT = process.env.PORT || 3000;
http
  .createServer(async (req, res) => {
    if (req.url === "/qr" && latestQR) {
      const qrImage = await QRCode.toBuffer(latestQR, { width: 400 });
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(qrImage);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 40px;">
          <h2>WhatsApp Bot Status: ${connectionStatus}</h2>
          ${
            latestQR
              ? `<img src="/qr" style="width: 400px; height: 400px;" />
                 <p>Scan this with WhatsApp → Linked Devices → Link a Device</p>`
              : `<p>${
                  connectionStatus === "open"
                    ? "Already connected — no QR needed."
                    : "Waiting for QR code to generate..."
                }</p>`
          }
        </body>
      </html>
    `);
  })
  .listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

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

const ALLOWED_GROUP_JID = process.env.ALLOWED_GROUP_JID || "";
const TRIGGER_WORDS = ["@bot", "bot,", "hey bot"];

function isTriggered(text) {
  const lower = text.toLowerCase();
  return TRIGGER_WORDS.some((t) => lower.includes(t));
}

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
      latestQR = qr;
      connectionStatus = "waiting_for_scan";
      console.log("QR code ready — open the app's web URL to scan it.");
    }

    if (connection === "close") {
      connectionStatus = "closed";
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        "Connection closed.",
        shouldReconnect ? "Reconnecting..." : "Logged out, not reconnecting."
      );
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      latestQR = null;
      connectionStatus = "open";
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
        if (!isGroup) continue;
        if (ALLOWED_GROUP_JID && remoteJid !== ALLOWED_GROUP_JID) continue;

        const sender = msg.key.participant || remoteJid;
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        if (!text) continue;

        console.log(`[${remoteJid}] ${sender}: ${text}`);

        await db.collection("group_memory").add({
          groupId: remoteJid,
          sender,
          message: text,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

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

async function buildReply(incomingText, groupId) {
  return "Hey! I'm keeping track of what's happening here. The vote is Monday — let me know if you need a recap.";
}

startBot().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
