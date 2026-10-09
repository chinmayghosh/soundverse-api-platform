import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-xl flex-1 flex-col justify-center gap-4 p-4">
      <h1 className="text-2xl font-semibold">Soundverse API</h1>
      <p>Generate royalty-free to fully owned music from a prompt, over a simple REST API.</p>
      <div className="flex gap-4 text-sm">
        <Link className="underline" href="/signup">Sign up</Link>
        <Link className="underline" href="/login">Log in</Link>
        <a className="underline" href="/docs">Docs</a>
      </div>
    </main>
  );
}
