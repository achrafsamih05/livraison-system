import { Request, Response, NextFunction } from 'express';
import { supabase, supabaseAdmin } from '../../config/supabase';
import { UnauthorizedError } from '../errors/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { isUserRole, UserRole } from '../types/roles';

/**
 * Extracts a Bearer token from the Authorization header.
 * Returns null when the header is missing or malformed.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token || token.trim() === '') {
    return null;
  }
  return token.trim();
}

/**
 * requireAuth
 * -----------
 * 1. Pulls the Bearer token from the Authorization header.
 * 2. Verifies it with Supabase Auth (`supabase.auth.getUser`).
 * 3. Loads the user's custom role from the `profiles` table.
 * 4. Attaches { id, email, role } to `req.user` for downstream handlers.
 *
 * Any failure short-circuits with a 401 via the centralized error handler.
 */
export const requireAuth = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearerToken(req.headers.authorization);

    if (!token) {
      throw new UnauthorizedError('Authentication required: missing Bearer token.');
    }

    // Verify the JWT against Supabase Auth.
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      throw new UnauthorizedError('Invalid or expired authentication token.');
    }

    const authUser = data.user;

    // Fetch the application role from our profiles table.
    // Use the service-role (admin) client here: the profiles table is
    // protected by RLS, and this server query carries no end-user JWT,
    // so the anon client would see zero rows. The token was already
    // verified above, so this privileged read is safe.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', authUser.id)
      .single();

    if (profileError || !profile) {
      throw new UnauthorizedError('User profile not found for the authenticated account.');
    }

    if (!isUserRole(profile.role)) {
      throw new UnauthorizedError('User profile has an invalid role.');
    }

    const role: UserRole = profile.role;

    // Attach the authenticated user for downstream middleware/controllers.
    req.user = {
      id: authUser.id,
      email: authUser.email ?? null,
      role,
    };

    next();
  }
);
