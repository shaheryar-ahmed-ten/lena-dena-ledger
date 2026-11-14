// Lets route handlers use req.user after the requireUser middleware has run.
import type { SessionUser } from "./lib/auth";

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}
export {};
