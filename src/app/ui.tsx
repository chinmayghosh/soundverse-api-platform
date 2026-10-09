// Small shared UI primitives. Plain Tailwind; the dashboard only needs to work.

export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-300 p-6 dark:border-neutral-700">
        <h1 className="mb-4 text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...input } = props;
  return (
    <label className="block text-sm">
      <span className="mb-1 block">{label}</span>
      <input
        {...input}
        className="w-full rounded border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
      />
    </label>
  );
}

export function SubmitButton({ pending, children }: { pending?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
    >
      {pending ? "…" : children}
    </button>
  );
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "danger" }) {
  const { variant, className, ...rest } = props;
  const color =
    variant === "danger"
      ? "border-red-600 text-red-600"
      : "border-neutral-400 dark:border-neutral-600";
  return (
    <button {...rest} className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${color} ${className ?? ""}`} />
  );
}

