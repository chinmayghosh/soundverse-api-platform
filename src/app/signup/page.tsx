"use client";
import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { AuthCard, Field, SubmitButton } from "@/app/ui";

export default function SignupPage() {
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const email = String(form.get("email"));
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")),
      email,
      password: String(form.get("password")),
      callbackURL: "/dashboard",
    });
    setPending(false);
    if (error) setError(error.message ?? "Sign up failed.");
    else setSentTo(email);
  }

  if (sentTo) {
    return (
      <AuthCard title="Verify your email">
        <p className="text-sm">
          We sent a verification link to <b>{sentTo}</b>. In this local build the link is printed
          to the server log (look for <code>[email] verify</code>).
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name" name="name" required />
        <Field label="Email" name="email" type="email" required />
        <Field label="Password (10+ characters)" name="password" type="password" minLength={10} required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <SubmitButton pending={pending}>Sign up</SubmitButton>
      </form>
      <p className="mt-4 text-sm">
        Already have an account? <Link className="underline" href="/login">Log in</Link>
      </p>
    </AuthCard>
  );
}
