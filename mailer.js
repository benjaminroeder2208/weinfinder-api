const nodemailer = require("nodemailer");

const SENDER_DOMAIN = "service.premium-weinfinder.de";

// Sendet über den lokalen Postfix (wie beim Intervall Coach) - kein externer
// Dienst nötig. Host/Port sind über .env überschreibbar, falls sich das
// Postfix-Setup mal ändert.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 25,
  secure: false,
  tls: { rejectUnauthorized: false },
});

// Nur Kleinbuchstaben, Zahlen, Punkt und Bindestrich - verhindert Header-
// Injection über das frei konfigurierbare Feld "Absendername".
function sanitizeSenderName(name) {
  const clean = (name || "weinfinder").toLowerCase().replace(/[^a-z0-9.-]/g, "");
  return clean || "weinfinder";
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildLeadEmailHtml({ tenant, wine, branding }) {
  const accent = branding?.primaryColor || "#a0bd00";
  const bg = branding?.backgroundColor || "#1c1612";
  const text = branding?.textColor || "#f2ede8";
  const cardBg = branding?.cardBackgroundColor || "#2a221c";
  const cardText = branding?.cardTextColor || "#a89e94";

  return `
  <div style="background:${bg}; padding:32px 16px; font-family:Georgia, serif;">
    <div style="max-width:480px; margin:0 auto;">
      <h1 style="color:${text}; font-size:1.4rem; text-align:center; margin-bottom:24px;">
        Deine persönliche Weinempfehlung
      </h1>
      <div style="background:${cardBg}; border-radius:14px; padding:24px;">
        <div style="color:${accent}; font-size:0.75rem; letter-spacing:0.08em; text-transform:uppercase; margin-bottom:8px;">
          Empfohlen von ${escapeHtml(tenant.name)}
        </div>
        <h2 style="color:${cardText}; margin:0 0 8px;">${escapeHtml(wine.name)}</h2>
        <p style="color:${cardText}; margin:0 0 16px;">${escapeHtml(wine.weingut || "")}</p>
        <p style="color:${cardText}; margin:0 0 16px;">${escapeHtml(wine.description || "")}</p>
        <div style="color:${accent}; font-size:1.3rem; font-weight:bold; margin-bottom:16px;">
          ${parseFloat(wine.price).toFixed(2).replace(".", ",")} €
        </div>
        ${
          wine.link
            ? `<a href="${escapeHtml(wine.link)}" style="display:inline-block; background:${accent}; color:${bg}; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Zum Wein</a>`
            : ""
        }
      </div>
      <p style="color:${text}; opacity:0.6; font-size:0.75rem; text-align:center; margin-top:24px;">
        Diese E-Mail wurde von ${escapeHtml(tenant.name)} über Weinfinder verschickt,
        weil du auf dessen Website eine Weinempfehlung angefragt hast.
      </p>
    </div>
  </div>`;
}

async function sendLeadEmail({ tenant, wine, toEmail, branding }) {
  const senderName = sanitizeSenderName(tenant.email_config?.senderName);
  const fromAddress = `${senderName}@${SENDER_DOMAIN}`;
  const replyTo = tenant.email_config?.replyTo || undefined;

  await transporter.sendMail({
    from: `"${tenant.name}" <${fromAddress}>`,
    to: toEmail,
    replyTo,
    subject: `Deine Weinempfehlung: ${wine.name}`,
    html: buildLeadEmailHtml({ tenant, wine, branding }),
    text: `Deine Weinempfehlung von ${tenant.name}: ${wine.name} - ${parseFloat(wine.price).toFixed(2)} €\n${wine.link || ""}`,
  });
}

module.exports = { sendLeadEmail };
