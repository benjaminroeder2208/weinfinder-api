const readline = require("readline");
const bcrypt = require("bcrypt");
require("dotenv").config();
const pool = require("./db");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("E-Mail: ", (email) => {
  rl.question("Passwort: ", async (password) => {
    const hash = await bcrypt.hash(password, 12);
    try {
      await pool.query(
        "INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)",
        [email, hash]
      );
      console.log(`Admin-User ${email} erfolgreich angelegt.`);
    } catch (err) {
      console.error("Fehler:", err.message);
    }
    rl.close();
    process.exit(0);
  });
});
