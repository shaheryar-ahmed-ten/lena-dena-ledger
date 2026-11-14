// Local server: `npm run dev` (API only, Vite serves the pages) or `npm start` (API + built pages).
import app from "./app";

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`Ledger API listening on http://localhost:${port}`));
