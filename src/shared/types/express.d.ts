import { UserRole } from './roles';

/**
 * Augments Express's Request type so `req.user` is strongly typed across
 * the whole codebase after `requireAuth` runs. Without this, TypeScript
 * would reject any access to `req.user`.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  role: UserRole;
}

export {};
