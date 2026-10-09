"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { AuthCard, Field, SubmitButton } from "@/app/ui";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (!error) return router.push("/dashboard");
    setError(
      error.status === 403
        ? "Please verify your email first. A new link was printed to the server log."
        : (error.message ?? "Login failed."),
    );
  }

  return (
    <AuthCard title="Log in">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email" name="email" type="email" required />
        <Field label="Password" name="password" type="password" required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <SubmitButton pending={pending}>Log in</SubmitButton>
      </form>
      <p className="mt-4 text-sm">
        New here? <Link className="underline" href="/signup">Create an account</Link>
      </p>
    </AuthCard>
  );
}
