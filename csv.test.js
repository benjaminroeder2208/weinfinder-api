const test = require("node:test");
const assert = require("node:assert/strict");
const { winesToCSV, parseCSV, WINE_COLUMNS } = require("./csv");

function sampleWine(overrides = {}) {
  return {
    name: "Riesling Kabinett",
    weingut: "Weingut ABC",
    price: "9.90", // PostgreSQL liefert NUMERIC als String
    price_category: "unter10",
    color: "weiss",
    style: "fruchtig_aromatisch",
    occasion: ["abend", "party"],
    food_pairing: ["fisch", "vegetarisch"],
    body: "leicht",
    acidity: "hoch",
    sweetness: "trocken",
    aroma_notes: ["Apfel", "Zitrus"],
    grape_variety: "Riesling",
    region: "Mosel",
    vintage: "2022",
    alcohol: "11.5%",
    gift_score: 2,
    featured_score: 3,
    link: "https://example.com/riesling",
    description: "Frischer Riesling mit Apfel und Zitrusnoten.",
    ...overrides,
  };
}

test("Export: Kopfzeile enthält alle Spalten in definierter Reihenfolge", () => {
  const csv = winesToCSV([sampleWine()]);
  const header = csv.split("\n")[0];
  assert.equal(header, WINE_COLUMNS.join(","));
});

test("Export: Arrays werden mit | getrennt", () => {
  const csv = winesToCSV([sampleWine()]);
  assert.match(csv, /abend\|party/);
  assert.match(csv, /fisch\|vegetarisch/);
});

test("Roundtrip: Export und erneuter Import liefern dieselben Daten", () => {
  const original = sampleWine();
  const [parsed] = parseCSV(winesToCSV([original]));
  assert.equal(parsed.name, original.name);
  assert.equal(parsed.price, 9.9);
  assert.deepEqual(parsed.occasion, ["abend", "party"]);
  assert.deepEqual(parsed.food_pairing, ["fisch", "vegetarisch"]);
  assert.deepEqual(parsed.aroma_notes, ["Apfel", "Zitrus"]);
  assert.equal(parsed.gift_score, 2);
  assert.equal(parsed.featured_score, 3);
  assert.equal(parsed.vintage, "2022");
  assert.equal(parsed.link, original.link);
});

test("Roundtrip: Kommas, Anführungszeichen und Zeilenumbrüche in Beschreibungen bleiben erhalten", () => {
  const tricky = 'Kräftig, dicht und "mineralisch".\nZweite Zeile, mit Komma.';
  const [parsed] = parseCSV(winesToCSV([sampleWine({ description: tricky })]));
  assert.equal(parsed.description, tricky);
});

test("Roundtrip: mehrere Weine bleiben in Reihenfolge und Anzahl erhalten", () => {
  const wines = [sampleWine({ name: "A" }), sampleWine({ name: "B" }), sampleWine({ name: "C" })];
  const parsed = parseCSV(winesToCSV(wines));
  assert.deepEqual(parsed.map((w) => w.name), ["A", "B", "C"]);
});

test("Import: Windows-Zeilenenden (CRLF) werden korrekt gelesen", () => {
  const csv = "name,price\r\nWein A,9.5\r\nWein B,12\r\n";
  const parsed = parseCSV(csv);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Wein A");
  assert.equal(parsed[1].price, 12);
});

test("Import: komplett leere Zeilen werden ignoriert", () => {
  const csv = "name,price\nWein A,9.5\n\n\nWein B,12\n";
  const parsed = parseCSV(csv);
  assert.equal(parsed.length, 2);
});

test("Import: leere Array-Felder ergeben leere Arrays, keine [''] ", () => {
  const csv = "name,occasion,food_pairing\nWein A,,\n";
  const [parsed] = parseCSV(csv);
  assert.deepEqual(parsed.occasion, []);
  assert.deepEqual(parsed.food_pairing, []);
});

test("Import: Leerzeichen um Array-Elemente werden entfernt", () => {
  const csv = "name,occasion\nWein A, abend | party \n";
  const [parsed] = parseCSV(csv);
  assert.deepEqual(parsed.occasion, ["abend", "party"]);
});

test("Import: ungültiger Preis wird zu 0 (dokumentiertes Verhalten)", () => {
  const [parsed] = parseCSV("name,price\nWein A,abc\n");
  assert.equal(parsed.price, 0);
});

test("Import: Preis mit Dezimalpunkt wird als Zahl gelesen", () => {
  const [parsed] = parseCSV("name,price\nWein A,12.9\n");
  assert.equal(parsed.price, 12.9);
});

test("Import: leere Datei und reine Kopfzeile ergeben leere Liste", () => {
  assert.deepEqual(parseCSV(""), []);
  assert.deepEqual(parseCSV("name,price\n"), []);
});

test("Import: letzte Zeile ohne abschließenden Zeilenumbruch wird nicht verschluckt", () => {
  const parsed = parseCSV("name,price\nWein A,9.5");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, "Wein A");
});

test("Export: null/undefined-Felder werden zu leeren Zellen statt 'null'", () => {
  const csv = winesToCSV([sampleWine({ description: null, region: undefined })]);
  assert.doesNotMatch(csv, /null/);
  assert.doesNotMatch(csv, /undefined/);
});
