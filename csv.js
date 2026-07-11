const WINE_COLUMNS = [
  "name",
  "weingut",
  "price",
  "price_category",
  "color",
  "style",
  "occasion",
  "food_pairing",
  "body",
  "acidity",
  "sweetness",
  "aroma_notes",
  "grape_variety",
  "region",
  "vintage",
  "alcohol",
  "gift_score",
  "featured_score",
  "link",
  "description",
];

// Diese Felder sind TEXT[]-Spalten in der DB und werden im CSV mit "|" getrennt
const ARRAY_FIELDS = ["occasion", "food_pairing", "aroma_notes"];

function escapeCsvField(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",;\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function winesToCSV(wines) {
  const header = WINE_COLUMNS.join(",");
  const lines = wines.map((w) =>
    WINE_COLUMNS.map((col) => {
      let value = w[col];
      if (ARRAY_FIELDS.includes(col)) {
        value = Array.isArray(value) ? value.join("|") : "";
      }
      return escapeCsvField(value);
    }).join(",")
  );
  return [header, ...lines].join("\n");
}

// Minimaler RFC4180-CSV-Parser: unterstützt Anführungszeichen, Kommas
// und Zeilenumbrüche innerhalb von Feldern.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else {
      if (char === '"') inQuotes = true;
      else if (char === ",") pushField();
      else if (char === "\n") {
        pushField();
        pushRow();
      } else if (char === "\r") {
        // ignorieren, \n übernimmt Zeilenumbruch
      } else {
        field += char;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());

  return rows
    .slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => {
      const obj = {};
      header.forEach((col, idx) => {
        const raw = r[idx] !== undefined ? r[idx] : "";
        if (ARRAY_FIELDS.includes(col)) {
          obj[col] = raw ? raw.split("|").map((s) => s.trim()).filter(Boolean) : [];
        } else if (col === "price") {
          obj[col] = parseFloat(raw) || 0;
        } else if (col === "gift_score" || col === "featured_score") {
          obj[col] = parseInt(raw, 10) || 0;
        } else {
          obj[col] = raw;
        }
      });
      return obj;
    });
}

module.exports = { winesToCSV, parseCSV, WINE_COLUMNS };
