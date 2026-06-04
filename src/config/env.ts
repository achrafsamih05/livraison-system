import dotenv from 'dotenv';

// Load variables from the .env file into process.env as early as possible.
dotenv.config();

/**
 * Reads a required environment variable and throws a descriptive error
 * if it is missing. This guarantees the server fails fast on misconfiguration
 * rather than crashing later with a cryptic runtime error.
 */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable "${key}". ` +
        `Please define it in your .env file (see .env.example).`
    );
  }
  return value;
}

/**
 * Reads an optional environment variable, falling back to a default value.
 */
function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.trim() !== '' ? value : fallback;
}

export const env = {
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  port: Number(optionalEnv('PORT', '5000')),
  supabase: {
    url: requireEnv('SUPABASE_URL'),
    anonKey: requireEnv('SUPABASE_ANON_KEY'),
    // Privileged server-side key. Bypasses RLS — must NEVER be exposed to
    // clients. Used by the trusted backend to verify tokens and read roles.
    serviceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  },
} as const;

export const isProduction = env.nodeEnv === 'production';
export const isDevelopment = env.nodeEnv === 'development';
