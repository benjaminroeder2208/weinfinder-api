const test = require("node:test");
const assert = require("node:assert/strict");
const { matchWines } = require("./matching");

// Hilfsfunktion: erzeugt einen Wein mit sinnvollen Defaults, einzelne Felder überschreibbar
function wine(overrides = {}) {
  return {
    id: overrides.id || "w" + Math.random().toString(36).slice(2, 8),
    name: "Testwein",
    price: 10,
    price_category: "10-20",
    color: "weiss",
    style: "leicht_frisch",
    occasion: [],
    food_pairing: [],
    acidity: "mittel",
    gift_score: 0,
    featured_score: 0,
    ...overrides,
  };
}

function answers(overrides = {}) {
  return {
    occasion: "abend",
    style: "leicht_frisch",
    food: "ohne_essen",
    color: "egal",
    priceCategory: "egal",
    acidity: "mittel",
    ...overrides,
  };
}

/* ---------- Filter ---------- */

test("Farbfilter: Rotwein-Wunsch schließt Weißweine aus", () => {
  const white = wine({ id: "white", color: "weiss" });
  const red = wine({ id: "red", color: "rot" });
  const r = matchWines([white, red], answers({ color: "rot" }));
  assert.equal(r.top.id, "red");
  assert.equal(r.alternatives.length, 0);
});

test("Preisfilter: nur die gewählte Preiskategorie kommt in Frage", () => {
  const cheap = wine({ id: "cheap", price_category: "unter10", price: 7 });
  const mid = wine({ id: "mid", price_category: "10-20", price: 15 });
  const r = matchWines([cheap, mid], answers({ priceCategory: "unter10" }));
  assert.equal(r.top.id, "cheap");
});

test("Fallback: Findet Farbe+Preis nichts, wird der Preisfilter gelockert, die Farbe bleibt", () => {
  const redExpensive = wine({ id: "redExp", color: "rot", price_category: "ueber20", price: 30 });
  const whiteCheap = wine({ id: "whiteCheap", color: "weiss", price_category: "unter10", price: 6 });
  const r = matchWines([redExpensive, whiteCheap], answers({ color: "rot", priceCategory: "unter10" }));
  assert.equal(r.top.id, "redExp");
});

test("Fallback: Findet die Farbe nichts, wird das gesamte Sortiment genommen", () => {
  const onlyWhite = wine({ id: "onlyWhite", color: "weiss" });
  const r = matchWines([onlyWhite], answers({ color: "rose" }));
  assert.equal(r.top.id, "onlyWhite");
});

test("Leeres Sortiment liefert keine Empfehlung statt eines Fehlers", () => {
  const r = matchWines([], answers());
  assert.equal(r.top, null);
  assert.deepEqual(r.alternatives, []);
  assert.equal(r.valueTip, null);
});

/* ---------- Scoring ---------- */

test("Exaktes Stil-Match schlägt Soft-Match", () => {
  const exact = wine({ id: "exact", style: "leicht_frisch" });
  const soft = wine({ id: "soft", style: "fruchtig_aromatisch" }); // Nachbar von leicht_frisch
  const r = matchWines([soft, exact], answers({ style: "leicht_frisch" }));
  assert.equal(r.top.id, "exact");
});

test("Soft-Match gibt Punkte, ein unverwandter Stil nicht", () => {
  const soft = wine({ id: "soft", style: "fruchtig_aromatisch" });
  const far = wine({ id: "far", style: "kraeftig_intensiv" });
  const r = matchWines([far, soft], answers({ style: "leicht_frisch" }));
  assert.equal(r.top.id, "soft");
});

test("Soft-Match bei Säure: Nachbarwert schlägt entfernten Wert", () => {
  const near = wine({ id: "near", acidity: "mittel" });
  const far = wine({ id: "far", acidity: "niedrig" });
  const r = matchWines([far, near], answers({ acidity: "hoch" }));
  assert.equal(r.top.id, "near");
});

test("Food-Pairing gibt Punkte, bei 'ohne_essen' aber nie", () => {
  const withFood = wine({ id: "withFood", food_pairing: ["fisch"] });
  const without = wine({ id: "without", food_pairing: [] });

  const r1 = matchWines([without, withFood], answers({ food: "fisch" }));
  assert.equal(r1.top.id, "withFood");

  // Bei ohne_essen darf das Food-Pairing keinen Unterschied machen:
  // beide haben denselben Score, Reihenfolge entscheidet featured_score
  const featured = wine({ id: "featured", food_pairing: [], featured_score: 5 });
  const r2 = matchWines([withFood, featured], answers({ food: "ohne_essen" }));
  assert.equal(r2.top.id, "featured");
});

test("'ohne_essen' im Food-Pairing eines Weins (Freitext im Admin-UI möglich) gibt keinen Bonus", () => {
  // Würde die Ausnahme fehlen, bekäme dieser Wein +2 und gewänne gegen den featured-Wein
  const taggedOhneEssen = wine({ id: "tagged", food_pairing: ["ohne_essen"] });
  const featured = wine({ id: "featured", food_pairing: [], featured_score: 5 });
  const r = matchWines([taggedOhneEssen, featured], answers({ food: "ohne_essen" }));
  assert.equal(r.top.id, "featured");
});

test("Anlass-Match gibt Punkte", () => {
  const match = wine({ id: "match", occasion: ["dinner"] });
  const noMatch = wine({ id: "noMatch", occasion: ["party"] });
  const r = matchWines([noMatch, match], answers({ occasion: "dinner" }));
  assert.equal(r.top.id, "match");
});

test("gift_score wirkt nur beim Anlass 'geschenk'", () => {
  const giftable = wine({ id: "giftable", gift_score: 5 });
  const plain = wine({ id: "plain", gift_score: 0, featured_score: 3 });

  // Ohne Geschenk-Anlass: gift_score ignoriert, featured_score entscheidet
  const r1 = matchWines([giftable, plain], answers({ occasion: "abend" }));
  assert.equal(r1.top.id, "plain");

  // Mit Geschenk-Anlass: gift_score (5 * 0.5 = 2.5) dreht es um
  const r2 = matchWines([giftable, plain], answers({ occasion: "geschenk" }));
  assert.equal(r2.top.id, "giftable");
});

test("gift_score überstimmt kein exaktes Stil-Match (max. +2,5 gegen +3)", () => {
  const styleMatch = wine({ id: "styleMatch", style: "leicht_frisch", gift_score: 0 });
  const giftOnly = wine({ id: "giftOnly", style: "kraeftig_intensiv", gift_score: 5 });
  const r = matchWines([giftOnly, styleMatch], answers({ occasion: "geschenk", style: "leicht_frisch" }));
  assert.equal(r.top.id, "styleMatch");
});

/* ---------- Gewichtungen (unabhängig vom Tie-Breaker) ---------- */
// Diese Tests sind so gebaut, dass der "falsche" Wein nur dann gewinnt, wenn die
// jeweilige Punktzahl im Code nicht stimmt - der Tie-Breaker hilft hier nicht.

test("Gewichtung Anlass (+2): Anlass-Treffer + exakte Säure schlagen exakten Stil + Soft-Säure", () => {
  const a = wine({ id: "a", style: "fruchtig_aromatisch", occasion: ["dinner"], acidity: "hoch" }); // 1+2+2 = 5
  const b = wine({ id: "b", style: "leicht_frisch", occasion: [], acidity: "mittel" }); // 3+1 = 4
  const r = matchWines([b, a], answers({ style: "leicht_frisch", occasion: "dinner", acidity: "hoch" }));
  assert.equal(r.top.id, "a");
});

test("Gewichtung Food (+2): Food-Treffer + Soft-Säure schlagen reine exakte Säure", () => {
  const a = wine({ id: "a", style: "kraeftig_intensiv", food_pairing: ["fisch"], acidity: "mittel" }); // 0+2+1 = 3
  const b = wine({ id: "b", style: "kraeftig_intensiv", food_pairing: [], acidity: "hoch" }); // 0+2 = 2
  const r = matchWines([b, a], answers({ style: "leicht_frisch", food: "fisch", acidity: "hoch" }));
  assert.equal(r.top.id, "a");
});

test("Gewichtung Säure: exakter Treffer (+2) schlägt Soft-Treffer (+1), auch gegen höheren featured_score", () => {
  const exact = wine({ id: "exact", acidity: "hoch", featured_score: 0 });
  const soft = wine({ id: "soft", acidity: "mittel", featured_score: 5 });
  const r = matchWines([soft, exact], answers({ acidity: "hoch" }));
  assert.equal(r.top.id, "exact");
});

test("Gewichtung Preis (+2) greift im Fallback 'gesamtes Sortiment' (Farbe nicht vorhanden)", () => {
  // Kein Rosé im Sortiment -> es wird das gesamte Sortiment bewertet; dort bekommt
  // die passende Preiskategorie +2, obwohl featured_score des anderen Weins höher ist
  const inBudget = wine({ id: "inBudget", color: "weiss", price_category: "10-20", featured_score: 0 });
  const overBudget = wine({ id: "overBudget", color: "weiss", price_category: "ueber20", featured_score: 5 });
  const r = matchWines([overBudget, inBudget], answers({ color: "rose", priceCategory: "10-20" }));
  assert.equal(r.top.id, "inBudget");
});

/* ---------- Tie-Breaker ---------- */

test("Tie-Breaker: bei gleichem Score entscheidet zuletzt featured_score", () => {
  const a = wine({ id: "a", featured_score: 1 });
  const b = wine({ id: "b", featured_score: 4 });
  const r = matchWines([a, b], answers());
  assert.equal(r.top.id, "b");
});

test("Tie-Breaker: exaktes Stil-Match steht vor Anlass-Match bei Punktgleichheit", () => {
  // styleOnly: Stil exakt (+3) = 3 Punkte
  // occasionOnly: Stil Soft (+1) + Anlass (+2) = 3 Punkte -> Gleichstand
  const styleOnly = wine({ id: "styleOnly", style: "leicht_frisch", occasion: [] });
  const occasionOnly = wine({
    id: "occasionOnly",
    style: "fruchtig_aromatisch",
    occasion: ["abend"],
    featured_score: 5, // soll den Tie-Break NICHT gewinnen
  });
  const r = matchWines([occasionOnly, styleOnly], answers({ style: "leicht_frisch", occasion: "abend", acidity: "hoch" }));
  assert.equal(r.top.id, "styleOnly");
});

/* ---------- Ergebnis-Struktur ---------- */

test("Es gibt höchstens zwei Alternativen", () => {
  const wines = Array.from({ length: 6 }, (_, i) => wine({ id: "w" + i, featured_score: i }));
  const r = matchWines(wines, answers());
  assert.equal(r.alternatives.length, 2);
});

test("Preis-Leistungs-Tipp ist der günstigste Wein, der nicht die Top-Empfehlung ist", () => {
  const top = wine({ id: "top", price: 20, style: "leicht_frisch", featured_score: 5 });
  const cheap = wine({ id: "cheap", price: 5, style: "kraeftig_intensiv" });
  const mid = wine({ id: "mid", price: 12, style: "kraeftig_intensiv" });
  const r = matchWines([top, mid, cheap], answers());
  assert.equal(r.top.id, "top");
  assert.equal(r.valueTip.id, "cheap");
});

test("Preise als Strings (so liefert PostgreSQL NUMERIC) werden numerisch sortiert", () => {
  const top = wine({ id: "top", price: "20.00", featured_score: 5 });
  const nine = wine({ id: "nine", price: "9.50", style: "kraeftig_intensiv" });
  const hundred = wine({ id: "hundred", price: "100.00", style: "kraeftig_intensiv" });
  const r = matchWines([top, hundred, nine], answers());
  // Als String-Vergleich wäre "100.00" < "9.50" - numerisch muss 9.50 gewinnen
  assert.equal(r.valueTip.id, "nine");
});

test("Weine ohne food_pairing/occasion-Arrays (null) führen nicht zum Absturz", () => {
  const broken = wine({ id: "broken", food_pairing: null, occasion: null });
  assert.doesNotThrow(() => matchWines([broken], answers({ food: "fisch", occasion: "dinner" })));
});
