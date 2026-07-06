const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const pool = require("./db");
const { matchWines } = require("./matching");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors());

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
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
      "SELECT slug, name, branding, features, quiz_config FROM tenants WHERE slug = $1 AND active = true",
      [slug]
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
    const answers = req.body;

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
      "SELECT id FROM tenants WHERE slug = $1 AND active = true",
      [slug]
    );
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: "Tenant nicht gefunden" });
    }
    const tenantId = tenantResult.rows[0].id;

    const winesResult = await pool.query(
      "SELECT * FROM wines WHERE tenant_id = $1",
      [tenantId]
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
      [tenantId, answers, result.top ? result.top.id : null]
    );

    res.json(result);
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
      "SELECT id, email, password_hash FROM admin_users WHERE email = $1",
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
      { adminId: admin.id, email: admin.email },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ email: admin.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

/* ---------- Admin: Tenants ---------- */

app.get("/admin/tenants", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, slug, name, active, created_at FROM tenants ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.post("/admin/tenants", requireAdmin, async (req, res) => {
  try {
    const { slug, name, branding, features } = req.body;
    const result = await pool.query(
      `INSERT INTO tenants (slug, name, branding, features)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [slug, name, branding || {}, features || {}]
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
    const { name, branding, features, active } = req.body;
    const result = await pool.query(
      `UPDATE tenants SET
        name = COALESCE($1, name),
        branding = COALESCE($2, branding),
        features = COALESCE($3, features),
        active = COALESCE($4, active)
       WHERE id = $5 RETURNING *`,
      [name, branding, features, active, id]
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

app.listen(process.env.PORT, () => {
  console.log(`Weinfinder API läuft auf Port ${process.env.PORT}`);
});