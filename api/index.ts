// Vercel runs this file as a serverless function for every /api/* request (see vercel.json rewrites).
// An Express app is itself a (req, res) handler, so it can be exported as-is.
import app from "../server/app";

export default app;
