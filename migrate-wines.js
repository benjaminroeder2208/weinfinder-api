const readline = require("readline");
const wines = require("./wines-data");

const BASE_URL = "https://app.premium-weinfinder.de/api";
const TENANT_ID = "b4d387b9-9789-43f7-a6b3-64adfec49341"; // anetteclosheim
const TEST_WINE_ID = "785615d4-3626-4857-aef5-850c8e1a2fa0";
const ADMIN_EMAIL = "benjamin@kontakt-2.de";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Admin-Passwort: ", async (password) => {
  rl.close();

  try {
    // 1. Login
    const loginRes = await fetch(`${BASE_URL}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password }),
    });
    if (!loginRes.ok) {
      console.error("Login fehlgeschlagen:", await loginRes.text());
      process.exit(1);
    }
    const setCookie = loginRes.headers.get("set-cookie");
    if (!setCookie) {
      console.error("Kein Cookie erhalten, Login-Antwort:", await loginRes.text());
      process.exit(1);
    }
    const cookie = setCookie.split(";")[0];
    console.log("Login erfolgreich.\n");

    // 2. Testwein löschen
    const delRes = await fetch(`${BASE_URL}/admin/wines/${TEST_WINE_ID}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    console.log(
      delRes.status === 204
        ? "Testwein gelöscht.\n"
        : `Testwein-Löschung: Status ${delRes.status} (evtl. bereits gelöscht)\n`
    );

    // 3. Weine anlegen
    let success = 0;
    let failed = 0;

    for (const wine of wines) {
      const res = await fetch(`${BASE_URL}/admin/tenants/${TENANT_ID}/wines`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(wine),
      });
      if (res.ok) {
        success++;
        console.log(`✓ ${wine.name}`);
      } else {
        failed++;
        console.error(`✗ ${wine.name}: ${await res.text()}`);
      }
    }

    console.log(`\nFertig: ${success} erfolgreich, ${failed} fehlgeschlagen.`);
    process.exit(0);
  } catch (err) {
    console.error("Fehler:", err.message);
    process.exit(1);
  }
});
