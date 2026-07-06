// Ähnlichkeits-Tabellen für Soft Matching
const STYLE_SIMILARITY = {
  leicht_frisch: ["fruchtig_aromatisch"],
  fruchtig_aromatisch: ["leicht_frisch", "weich_harmonisch"],
  weich_harmonisch: ["fruchtig_aromatisch", "kraeftig_intensiv"],
  kraeftig_intensiv: ["weich_harmonisch"],
};

const ACIDITY_SIMILARITY = {
  niedrig: ["mittel"],
  mittel: ["niedrig", "hoch"],
  hoch: ["mittel"],
};

/**
 * Reine Matching-Funktion. Kennt keinen Tenant, arbeitet nur mit
 * den übergebenen Weinen und Quiz-Antworten.
 *
 * @param {Array} wines - Liste der Weine eines Tenants (aus der DB)
 * @param {Object} answers - { occasion, style, food, color, priceCategory, acidity }
 * @returns {{ top: Object|null, alternatives: Object[], valueTip: Object|null }}
 */
function matchWines(wines, answers) {
  // SCHRITT 1 – FILTER
  let candidates = wines.filter((wine) => {
    const colorOk = answers.color === "egal" || wine.color === answers.color;
    const priceOk =
      answers.priceCategory === "egal" ||
      wine.price_category === answers.priceCategory;
    return colorOk && priceOk;
  });

  // Fallback: Preisfilter lockern, falls keine Treffer (Farbfilter bleibt bestehen)
  if (candidates.length === 0) {
    candidates = wines.filter(
      (wine) => answers.color === "egal" || wine.color === answers.color
    );
  }

  // Fallback 2: falls immer noch leer (z.B. sehr kleines Sortiment), alle Weine nehmen
  if (candidates.length === 0) {
    candidates = wines;
  }

  // SCHRITT 2 + 3 – SCORING inkl. Soft Matching
  const scored = candidates.map((wine) => {
    let score = 0;
    let styleMatch = false;
    let occasionMatch = false;

    if (wine.style === answers.style) {
      score += 3;
      styleMatch = true;
    } else if (STYLE_SIMILARITY[answers.style]?.includes(wine.style)) {
      score += 1;
    }

    if (
      answers.food !== "ohne_essen" &&
      wine.food_pairing?.includes(answers.food)
    ) {
      score += 2;
    }

    if (wine.occasion?.includes(answers.occasion)) {
      score += 2;
      occasionMatch = true;
    }

    if (
      answers.priceCategory !== "egal" &&
      wine.price_category === answers.priceCategory
    ) {
      score += 2;
    }

    if (wine.acidity === answers.acidity) {
      score += 2;
    } else if (ACIDITY_SIMILARITY[answers.acidity]?.includes(wine.acidity)) {
      score += 1;
    }

    // SCHRITT 4 – ZUSATZFAKTOREN
    if (answers.occasion === "geschenk") {
      score += (wine.gift_score || 0) * 0.5;
    }

    return { wine, score, styleMatch, occasionMatch };
  });

  // SCHRITT 5 – SORTIERUNG mit Tie-Breaker
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.styleMatch !== b.styleMatch) return a.styleMatch ? -1 : 1;
    if (a.occasionMatch !== b.occasionMatch) return a.occasionMatch ? -1 : 1;
    return (b.wine.featured_score || 0) - (a.wine.featured_score || 0);
  });

  const top = scored[0]?.wine ?? null;
  const alternatives = scored.slice(1, 3).map((m) => m.wine);

  // Preis-Leistungs-Tipp: günstigster Kandidat, der nicht die Hauptempfehlung ist
  const valueTip =
    scored
      .filter((m) => m.wine.id !== top?.id)
      .sort((a, b) => parseFloat(a.wine.price) - parseFloat(b.wine.price))[0]
      ?.wine ?? null;

  return { top, alternatives, valueTip };
}

module.exports = { matchWines, STYLE_SIMILARITY, ACIDITY_SIMILARITY };
