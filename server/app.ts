// The Express application. Used by Vercel (api/index.ts) and by `npm run dev` / `npm start` (server/index.ts).
import path from "node:path";
import fs from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import authRoutes from "./routes/auth";
import entryRoutes from "./routes/entries";
import dictionaryRoutes from "./routes/dictionary";
import voiceRoutes from "./routes/voice";
import legacyRoutes from "./routes/legacy";
import oauthRoutes from "./routes/oauth";

const app = express();
app.set("trust proxy", true); // behind Vercel's proxy: use the real protocol and host
app.disable("x-powered-by");
app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));

const api = express.Router();
api.use(authRoutes, entryRoutes, dictionaryRoutes, voiceRoutes, legacyRoutes, oauthRoutes);
api.use((_req, res) => void res.status(404).json({ error: "Not found." }));
app.use("/api", api);

// Outside Vercel (npm start), also serve the built React app and send unknown paths to it.
const dist = path.resolve(process.cwd(), "dist");
if (!process.env.VERCEL && fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// One place that turns unexpected errors into a tidy JSON reply.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    return void res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "That recording is too long. Keep it under a minute." : "That recording couldn't be read. Try again." });
  }
  if ((err as { type?: string })?.type === "entity.parse.failed") return void res.status(400).json({ error: "Bad request." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});

export default app;
