"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { safeNext } from "@/lib/guard";
import { Notice } from "./Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Fixed copy only: never echo server details (account existence, lock state, IPs).
function loginMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Sign-in failed. Try again.";
  switch (err.status) {
    case 0:
      return err.message;
    case 401:
      return "Invalid username or password.";
    case 429:
      return "Too many sign-in attempts. Wait 15 minutes, then try again.";
    case 403:
      return "Your sign-in form expired. Reload the page and try again.";
    default:
      return "Sign-in failed. Try again.";
  }
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      router.replace(safeNext(next));
    } catch (err) {
      setPassword("");
      setError(loginMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate aria-describedby={error ? "login-error" : undefined}>
      <div className="space-y-1.5">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {showPassword ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
          </button>
        </div>
      </div>
      {error && (
        <Notice tone="danger" role="alert" id="login-error">
          {error}
        </Notice>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy && <Loader2 className="animate-spin" />}
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
