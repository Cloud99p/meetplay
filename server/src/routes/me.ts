import type { FastifyInstance } from 'fastify';
import { clerkEnabled, identify, identifyReadOnly } from '../auth/clerk.js';

/**
 * Account endpoints.
 *
 * DESIGN CONSTRAINTS (mirror auth/clerk.ts):
 *
 *  1. Accounts are OPTIONAL. Every response here is valid for a guest:
 *     `{ authenticated: false }`. No route 401s, because the client calls this
 *     on boot to decide whether to show an account menu — a 401 there would be
 *     an error for the normal guest case.
 *
 *  2. `POST /api/me` is the one place a `users` row is created. It is a write
 *     endpoint called deliberately after sign-in, so the lazy upsert belongs
 *     here rather than on every request.
 *
 *  3. `GET /api/me` is READ-ONLY: it never creates a row, so a page load can
 *     never write to the database (see `identifyReadOnly`).
 */
export async function meRoutes(app: FastifyInstance) {
  /**
   * Read the caller's identity without writing.
   *
   * `enabled` tells the client whether sign-in is even possible, so it can hide
   * the account UI entirely when Clerk is unconfigured (fresh clone / dev env)
   * instead of rendering a sign-in button that cannot work.
   */
  app.get('/api/me', async (req) => {
    const enabled = clerkEnabled();
    if (!enabled) {
      return { enabled: false, authenticated: false, user: null };
    }
    const id = await identifyReadOnly(req.headers.authorization);
    if (!id.clerkUserId) {
      return { enabled: true, authenticated: false, user: null };
    }
    return {
      enabled: true,
      authenticated: true,
      user: {
        id: id.userId,
        clerkUserId: id.clerkUserId,
        name: id.name,
        email: id.email,
        imageUrl: id.imageUrl,
      },
    };
  });

  /**
   * Confirm a signed-in session and materialise the local `users` row.
   *
   * Called by the client right after Clerk reports a session, so that a room
   * created moments later can be linked to the account. Returns
   * `{ authenticated: false }` rather than an error when no valid token is
   * presented — the client treats that as "still a guest", which is not a
   * failure.
   */
  app.post('/api/me', async (req) => {
    const enabled = clerkEnabled();
    if (!enabled) {
      return { enabled: false, authenticated: false, user: null };
    }
    const id = await identify(req.headers.authorization, req.log);
    if (!id.clerkUserId) {
      return { enabled: true, authenticated: false, user: null };
    }
    return {
      enabled: true,
      authenticated: true,
      user: {
        id: id.userId,
        clerkUserId: id.clerkUserId,
        name: id.name,
        email: id.email,
        imageUrl: id.imageUrl,
      },
    };
  });
}
