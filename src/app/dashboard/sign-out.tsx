"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/app/ui";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button onClick={async () => { await authClient.signOut(); router.push("/login"); }}>
      Sign out
    </Button>
  );
}
