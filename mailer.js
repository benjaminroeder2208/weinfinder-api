const nodemailer = require("nodemailer");

// Nutzt dasselbe Strato-Mail-Muster wie beim Intervall Coach: ein festes,
// authentifiziertes Postfach. Personalisiert wird nur der Anzeigename,
// nicht die technische Absenderadresse (Strato lässt sonst nichts anderes
// als die authentifizierte Adresse als Envelope-From zu).
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "465", 10),
  secure: true, // Port 465 = implizites TLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildLeadEmailHtml({ tenant, wine, branding, unsubscribeUrl }) {
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
        weil du auf dessen Website eine Weinempfehlung angefragt und bestätigt hast.
      </p>
      ${
        unsubscribeUrl
          ? `<p style="text-align:center; margin-top:8px;">
               <a href="${escapeHtml(unsubscribeUrl)}" style="color:${text}; opacity:0.5; font-size:0.7rem;">
                 Keine weiteren E-Mails erhalten
               </a>
             </p>`
          : ""
      }
    </div>
  </div>`;
}

function buildConfirmationEmailHtml({ tenant, confirmUrl }) {
  return `
  <div style="background:#1c1612; padding:32px 16px; font-family:Georgia, serif;">
    <div style="max-width:480px; margin:0 auto; text-align:center;">
      <h1 style="color:#f2ede8; font-size:1.3rem; margin-bottom:16px;">
        Fast geschafft!
      </h1>
      <p style="color:#a89e94; margin-bottom:24px;">
        Bitte bestätige deine E-Mail-Adresse, damit ${escapeHtml(tenant.name)}
        dir deine Weinempfehlung zusenden kann.
      </p>
      <a href="${escapeHtml(confirmUrl)}" style="display:inline-block; background:#a0bd00; color:#1c1612; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:bold;">
        E-Mail-Adresse bestätigen
      </a>
      <p style="color:#a89e94; opacity:0.6; font-size:0.75rem; margin-top:24px;">
        Falls du diese Anfrage nicht gestellt hast, kannst du diese E-Mail einfach ignorieren.
      </p>
    </div>
  </div>`;
}

async function sendLeadEmail({ tenant, wine, toEmail, branding, unsubscribeUrl }) {
  const displayName = tenant.email_config?.displayName || tenant.name;
  const replyTo = tenant.email_config?.replyTo || undefined;

  await transporter.sendMail({
    from: {
      name: displayName,
      address: process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER,
    },
    to: toEmail,
    replyTo,
    subject: `Deine Weinempfehlung: ${wine.name}`,
    html: buildLeadEmailHtml({ tenant, wine, branding, unsubscribeUrl }),
    text: `Deine Weinempfehlung von ${tenant.name}: ${wine.name} - ${parseFloat(wine.price).toFixed(2)} €\n${wine.link || ""}${unsubscribeUrl ? `\n\nAbmelden: ${unsubscribeUrl}` : ""}`,
  });
}

async function sendConfirmationEmail({ tenant, toEmail, confirmUrl }) {
  const displayName = tenant.email_config?.displayName || tenant.name;

  await transporter.sendMail({
    from: {
      name: displayName,
      address: process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER,
    },
    to: toEmail,
    subject: `Bitte bestätige deine E-Mail-Adresse (${tenant.name})`,
    html: buildConfirmationEmailHtml({ tenant, confirmUrl }),
    text: `Bitte bestätige deine E-Mail-Adresse, damit ${tenant.name} dir deine Weinempfehlung zusenden kann: ${confirmUrl}`,
  });
}

module.exports = { sendLeadEmail, sendConfirmationEmail };