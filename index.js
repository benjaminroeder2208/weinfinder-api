const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const pool = require("./db");
const { matchWines } = require("./matching");
const { winesToCSV, parseCSV, WINE_COLUMNS } = require("./csv");
const { sendLeadEmail } = require("./mailer");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use(cors());

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 });
app.use(generalLimiter);

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// Middleware: Admin-Routen schützen
function requireAdmin(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) {
    return res.status(401).json({ error: "Nicht angemeldet" });
  }
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiges Token" });
  }
}

/* ---------- Öffentliche Routen ---------- */

app.get("/tenants/:slug/config", async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await pool.query(
      "SELECT slug, name, branding, features, quiz_config, content, pricing_tier, demo_sources FROM tenants WHERE slug = $1 AND active = true",
      [slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tenant nicht gefunden" });
    }
    const tenant = result.rows[0];

    // Bei Demo-Tenants: Namen der auswählbaren Quell-Kunden mitschicken
    if (tenant.pricing_tier === "demo" && tenant.demo_sources?.length > 0) {
      const sources = await pool.query(
        "SELECT slug, name FROM tenants WHERE slug = ANY($1) AND active = true ORDER BY name",
        [tenant.demo_sources]
      );
      tenant.demo_options = sources.rows;
    } else {
      tenant.demo_options = [];
    }

    res.json(tenant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.get("/tenants/:slug/wines", async (req, res) => {
  try {
    const { slug } = req.params;
    const tenantResult = await pool.query(
      "SELECT id FROM tenants WHERE slug = $1 AND active = true",
      [slug]
    );
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: "Tenant nicht gefunden" });
    }
    const tenantId = tenantResult.rows[0].id;
    const wines = await pool.query(
      "SELECT * FROM wines WHERE tenant_id = $1",
      [tenantId]
    );
    res.json(wines.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// Quiz-Ergebnis berechnen und speichern
app.post("/tenants/:slug/quiz-result", async (req, res) => {
  try {
    const { slug } = req.params;
    const { sourceSlugs, sourceSlug, ...answers } = req.body;
    // sourceSlugs (Array) ist der aktuelle Weg, sourceSlug (einzeln) bleibt aus Kompatibilität erhalten
    const requestedSlugs = Array.isArray(sourceSlugs) && sourceSlugs.length > 0
      ? sourceSlugs
      : sourceSlug
      ? [sourceSlug]
      : [];

    const requiredFields = [
      "occasion",
      "style",
      "food",
      "color",
      "priceCategory",
      "acidity",
    ];
    const missing = requiredFields.filter((f) => !answers[f]);
    if (missing.length > 0) {
      return res
        .status(400)
        .json({ error: `Fehlende Antworten: ${missing.join(", ")}` });
    }

    const tenantResult = await pool.query(
      "SELECT id, pricing_tier, demo_sources FROM tenants WHERE slug = $1 AND active = true",
      [slug]
    );
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: "Tenant nicht gefunden" });
    }
    const tenant = tenantResult.rows[0];
    let wineTenantIds = [tenant.id];

    // Demo-Tenants dürfen mit Erlaubnis (demo_sources) die Weine 1-n anderer Kunden kombinieren
    if (requestedSlugs.length > 0 && tenant.pricing_tier === "demo") {
      const invalid = requestedSlugs.filter((s) => !tenant.demo_sources?.includes(s));
      if (invalid.length > 0) {
        return res.status(403).json({ error: `Quelle(n) nicht freigegeben: ${invalid.join(", ")}` });
      }
      const sourceResult = await pool.query(
        "SELECT id FROM tenants WHERE slug = ANY($1) AND active = true",
        [requestedSlugs]
      );
      if (sourceResult.rows.length === 0) {
        return res.status(404).json({ error: "Keine der Quellen gefunden" });
      }
      wineTenantIds = sourceResult.rows.map((r) => r.id);
    }

    const winesResult = await pool.query(
      "SELECT * FROM wines WHERE tenant_id = ANY($1)",
      [wineTenantIds]
    );

    if (winesResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Keine Weine für diesen Tenant hinterlegt" });
    }

    const result = matchWines(winesResult.rows, answers);

    await pool.query(
      `INSERT INTO quiz_results (tenant_id, answers, recommended_wine_id)
       VALUES ($1, $2, $3)`,
      [tenant.id, answers, result.top ? result.top.id : null]
    );

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

const HIDDEN_LEAD_CAPTURE_TIERS = ["basis", "pilot"];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lead speichern (E-Mail-Formular auf der Ergebnisseite)
app.post("/tenants/:slug/leads", async (req, res) => {
  try {
    const { slug } = req.params;
    const { email, wineId, answers, consent } = req.body;

    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Ungültige E-Mail-Adresse" });
    }
    if (!consent) {
      return res.status(400).json({ error: "Einwilligung zur Kontaktaufnahme erforderlich" });
    }

    const tenantResult = await pool.query(
      "SELECT id, name, pricing_tier, email_config, branding FROM tenants WHERE slug = $1 AND active = true",
      [slug]
    );
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: "Tenant nicht gefunden" });
    }
    const tenant = tenantResult.rows[0];

    if (HIDDEN_LEAD_CAPTURE_TIERS.includes(tenant.pricing_tier)) {
      return res.status(403).json({ error: "Lead-Erfassung für dieses Paket nicht verfügbar" });
    }

    await pool.query(
      `INSERT INTO leads (tenant_id, email, wine_id, answers, consent)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenant.id, email, wineId || null, answers ? JSON.stringify(answers) : null, true]
    );

    // Mailversand ist optional aktivierbar (email_config.enabled) und blockiert
    // die Lead-Speicherung nicht, falls er fehlschlägt - der Lead ist in dem
    // Fall trotzdem im Admin-UI sichtbar.
    if (tenant.email_config?.enabled && wineId) {
      try {
        const wineResult = await pool.query("SELECT * FROM wines WHERE id = $1", [wineId]);
        if (wineResult.rows.length > 0) {
          await sendLeadEmail({
            tenant,
            wine: wineResult.rows[0],
            toEmail: email,
            branding: tenant.branding,
          });
        }
      } catch (mailErr) {
        console.error("Mailversand fehlgeschlagen:", mailErr);
      }
    }

    res.status(201).json({ email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

/* ---------- Admin: Auth ---------- */

app.post("/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query(
      "SELECT id, email, username, password_hash FROM admin_users WHERE email = $1 OR username = $1",
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Ungültige Anmeldedaten" });
    }
    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Ungültige Anmeldedaten" });
    }
    const token = jwt.sign(
      { adminId: admin.id, email: admin.email, username: admin.username },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ email: admin.email, username: admin.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.post("/admin/logout", (req, res) => {
  res.clearCookie("admin_token", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });
  res.status(204).send();
});

/* ---------- Admin: Tenants ---------- */

app.get("/admin/tenants", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, slug, name, active, pricing_tier, created_at FROM tenants ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

/* ---------- Schema-Hinweis ----------
   Erfordert einmalig:
   ALTER TABLE tenants ADD COLUMN content JSONB NOT NULL DEFAULT '{}';
------------------------------------- */

const DEFAULT_QUIZ_CONFIG = [
  {
    field: "occasion",
    question: "Wann möchtest du den Wein trinken?",
    options: [
      { label: "gemütlicher Abend", value: "abend" },
      { label: "Dinner mit Freunden", value: "dinner" },
      { label: "Geschenk", value: "geschenk" },
      { label: "Party / Feier", value: "party" },
      { label: "zum Essen", value: "essen" },
    ],
  },
  {
    field: "style",
    question: "Welcher Weinstil passt am besten zu dir?",
    options: [
      { label: "leicht & frisch", value: "leicht_frisch" },
      { label: "fruchtig & aromatisch", value: "fruchtig_aromatisch" },
      { label: "weich & harmonisch", value: "weich_harmonisch" },
      { label: "kräftig & intensiv", value: "kraeftig_intensiv" },
    ],
  },
  {
    field: "food",
    question: "Möchtest du den Wein zu einem Essen trinken?",
    options: [
      { label: "Fisch / Meeresfrüchte", value: "fisch" },
      { label: "Fleisch / Grill", value: "fleisch" },
      { label: "Pasta / mediterran", value: "pasta" },
      { label: "vegetarisch", value: "vegetarisch" },
      { label: "ohne Essen / nach dem Essen", value: "ohne_essen" },
    ],
  },
  {
    field: "color",
    question: "Welche Weinart möchtest du?",
    options: [
      { label: "Rotwein", value: "rot" },
      { label: "Weißwein", value: "weiss" },
      { label: "Rosé", value: "rose" },
      { label: "egal – überrasche mich", value: "egal" },
    ],
  },
  {
    field: "priceCategory",
    question: "In welchem Preisbereich suchst du?",
    options: [
      { label: "unter 10 €", value: "unter10" },
      { label: "10–20 €", value: "10-20" },
      { label: "über 20 €", value: "ueber20" },
      { label: "egal", value: "egal" },
    ],
  },
  {
    field: "acidity",
    question: "Wie frisch und lebendig darf der Wein wirken?",
    options: [
      { label: "eher mild und weich", value: "niedrig" },
      { label: "ausgewogen", value: "mittel" },
      { label: "schön frisch und lebendig", value: "hoch" },
    ],
  },
];

app.get("/admin/tenants/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM tenants WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tenant nicht gefunden" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.post("/admin/tenants", requireAdmin, async (req, res) => {
  try {
    const { slug, name, branding, features, quiz_config, content, pricing_tier, demo_sources } = req.body;
    const result = await pool.query(
      `INSERT INTO tenants (slug, name, branding, features, quiz_config, content, pricing_tier, demo_sources)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        slug,
        name,
        JSON.stringify(branding || {}),
        JSON.stringify(features || {}),
        JSON.stringify(quiz_config || DEFAULT_QUIZ_CONFIG),
        JSON.stringify(content || {}),
        pricing_tier || "basis",
        JSON.stringify(demo_sources || []),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "Slug bereits vergeben" });
    }
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.patch("/admin/tenants/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, branding, features, active, quiz_config, content, pricing_tier, demo_sources, email_config } = req.body;
    const result = await pool.query(
      `UPDATE tenants SET
        name = COALESCE($1, name),
        branding = COALESCE($2, branding),
        features = COALESCE($3, features),
        active = COALESCE($4, active),
        quiz_config = COALESCE($5, quiz_config),
        content = COALESCE($6, content),
        pricing_tier = COALESCE($7, pricing_tier),
        demo_sources = COALESCE($8, demo_sources),
        email_config = COALESCE($9, email_config)
       WHERE id = $10 RETURNING *`,
      [
        name,
        branding ? JSON.stringify(branding) : null,
        features ? JSON.stringify(features) : null,
        active,
        quiz_config ? JSON.stringify(quiz_config) : null,
        content ? JSON.stringify(content) : null,
        pricing_tier || null,
        demo_sources ? JSON.stringify(demo_sources) : null,
        email_config ? JSON.stringify(email_config) : null,
        id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tenant nicht gefunden" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

/* ---------- Admin: Weine ---------- */

app.get("/admin/tenants/:id/wines", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM wines WHERE tenant_id = $1 ORDER BY name",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.get("/admin/wines/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM wines WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Wein nicht gefunden" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.post("/admin/tenants/:id/wines", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const w = req.body;
    const result = await pool.query(
      `INSERT INTO wines (
        tenant_id, name, weingut, price, price_category, color, style,
        occasion, food_pairing, body, acidity, sweetness, aroma_notes,
        grape_variety, region, vintage, alcohol, gift_score, featured_score,
        link, description
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [id, w.name, w.weingut, w.price, w.price_category, w.color, w.style,
       w.occasion, w.food_pairing, w.body, w.acidity, w.sweetness, w.aroma_notes,
       w.grape_variety, w.region, w.vintage, w.alcohol, w.gift_score || 0,
       w.featured_score || 0, w.link, w.description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.patch("/admin/wines/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const w = req.body;
    const result = await pool.query(
      `UPDATE wines SET
        name = COALESCE($1, name), weingut = COALESCE($2, weingut),
        price = COALESCE($3, price), price_category = COALESCE($4, price_category),
        color = COALESCE($5, color), style = COALESCE($6, style),
        occasion = COALESCE($7, occasion), food_pairing = COALESCE($8, food_pairing),
        body = COALESCE($9, body), acidity = COALESCE($10, acidity),
        sweetness = COALESCE($11, sweetness), aroma_notes = COALESCE($12, aroma_notes),
        grape_variety = COALESCE($13, grape_variety), region = COALESCE($14, region),
        vintage = COALESCE($15, vintage), alcohol = COALESCE($16, alcohol),
        gift_score = COALESCE($17, gift_score), featured_score = COALESCE($18, featured_score),
        link = COALESCE($19, link), description = COALESCE($20, description)
       WHERE id = $21 RETURNING *`,
      [w.name, w.weingut, w.price, w.price_category, w.color, w.style,
       w.occasion, w.food_pairing, w.body, w.acidity, w.sweetness, w.aroma_notes,
       w.grape_variety, w.region, w.vintage, w.alcohol, w.gift_score,
       w.featured_score, w.link, w.description, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Wein nicht gefunden" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.delete("/admin/wines/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM wines WHERE id = $1", [id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.delete("/admin/tenants/:id/wines", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM wines WHERE tenant_id = $1", [id]);
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

/* ---------- Admin: CSV Import/Export ---------- */

app.get("/admin/tenants/:id/wines/export", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM wines WHERE tenant_id = $1 ORDER BY name",
      [id]
    );
    const csv = winesToCSV(result.rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="weine.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.post("/admin/tenants/:id/wines/import", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { csv } = req.body;
    if (!csv) {
      return res.status(400).json({ error: "Kein CSV-Inhalt übermittelt" });
    }

    let rows;
    try {
      rows = parseCSV(csv);
    } catch (err) {
      return res.status(400).json({ error: "CSV konnte nicht gelesen werden" });
    }

    let imported = 0;
    let failed = 0;
    const errors = [];

    for (const row of rows) {
      try {
        await pool.query(
          `INSERT INTO wines (
            tenant_id, name, weingut, price, price_category, color, style,
            occasion, food_pairing, body, acidity, sweetness, aroma_notes,
            grape_variety, region, vintage, alcohol, gift_score, featured_score,
            link, description
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            id, row.name, row.weingut, row.price, row.price_category, row.color, row.style,
            row.occasion, row.food_pairing, row.body, row.acidity, row.sweetness, row.aroma_notes,
            row.grape_variety, row.region, row.vintage, row.alcohol, row.gift_score,
            row.featured_score, row.link, row.description,
          ]
        );
        imported++;
      } catch (err) {
        failed++;
        errors.push(`${row.name || "(ohne Name)"}: ${err.message}`);
      }
    }

    res.json({ imported, failed, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

/* ---------- Admin: Leads ---------- */

app.get("/admin/tenants/:id/leads", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT l.id, l.email, l.created_at, w.name AS wine_name
       FROM leads l
       LEFT JOIN wines w ON w.id = l.wine_id
       WHERE l.tenant_id = $1
       ORDER BY l.created_at DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.get("/admin/tenants/:id/leads/export", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT l.email, l.created_at, w.name AS wine_name
       FROM leads l
       LEFT JOIN wines w ON w.id = l.wine_id
       WHERE l.tenant_id = $1
       ORDER BY l.created_at DESC`,
      [id]
    );
    const header = "email,empfohlener_wein,datum";
    const lines = result.rows.map((r) => {
      const date = new Date(r.created_at).toISOString();
      const wine = (r.wine_name || "").replace(/,/g, ";");
      return `${r.email},${wine},${date}`;
    });
    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

/* ---------- Admin: Analytics ---------- */

app.get("/admin/tenants/:id/analytics", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const totalResult = await pool.query(
      `SELECT count(*)::int AS total FROM quiz_results
       WHERE tenant_id = $1 AND created_at > now() - interval '30 days'`,
      [id]
    );

    const topOccasions = await pool.query(
      `SELECT answers->>'occasion' AS value, count(*)::int AS count
       FROM quiz_results WHERE tenant_id = $1
       GROUP BY value ORDER BY count DESC LIMIT 3`,
      [id]
    );

    const topStyles = await pool.query(
      `SELECT answers->>'style' AS value, count(*)::int AS count
       FROM quiz_results WHERE tenant_id = $1
       GROUP BY value ORDER BY count DESC LIMIT 3`,
      [id]
    );

    const topWine = await pool.query(
      `SELECT w.name, count(*)::int AS count
       FROM quiz_results qr
       JOIN wines w ON w.id = qr.recommended_wine_id
       WHERE qr.tenant_id = $1
       GROUP BY w.name ORDER BY count DESC LIMIT 1`,
      [id]
    );

    res.json({
      last30Days: totalResult.rows[0].total,
      topOccasions: topOccasions.rows,
      topStyles: topStyles.rows,
      topRecommendedWine: topWine.rows[0] || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Weinfinder API läuft auf Port ${process.env.PORT}`);
});