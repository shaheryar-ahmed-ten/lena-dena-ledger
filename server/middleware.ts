import type { NextFunction, Request, Response } from "express";
import { currentUser } from "./lib/auth";

/** Rejects the request with 401 unless a valid session cookie is present; sets req.user. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = await currentUser(req);
  if (!user) return void res.status(401).json({ error: "Please log in again." });
  req.user = user;
  next();
}

/** The signed-in user (only call after requireUser). */
export const me = (req: Request) => req.user!;

/** The address the browser used, as Vercel/proxies report it. */
export function requestOrigin(req: Request) {
  const host = req.get("x-forwarded-host") || req.get("host") || "localhost";
  const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0];
  return { host, origin: `${proto}://${host}` };
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
