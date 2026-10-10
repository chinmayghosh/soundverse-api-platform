import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "../db/client";
import { authAccounts, authSessions, authUsers, authVerifications } from "../db/schema";
import { env } from "../env";

// Better Auth handles dashboard login only. API keys, limits and metering are
// our own code (src/server/keys, limits, billing). The tenant account is
// created on first dashboard load (after verification), not in a sign-up
// hook: that hook runs before the email is verified.
function createAuth() {
  return betterAuth({
    baseURL: env().APP_URL,
    secret: env().BETTER_AUTH_SECRET,
    trustedOrigins: [env().APP_URL],
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      // No email provider: the brief allows printing the link to the server log.
      sendVerificationEmail: async ({ user, url }) => {
        console.log(`\n[email] verify ${user.email}: ${url}\n`);
      },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
const g = globalThis as unknown as { __svAuth?: Auth };

// Lazy so `next build` can import route modules without runtime env.
export function getAuth(): Auth {
  return (g.__svAuth ??= createAuth());
}
