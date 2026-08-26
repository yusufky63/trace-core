export async function technocore(path: string, method: "GET" | "POST" = "GET", body?: unknown) {
  const response = await fetch("/api/technocore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, method, body }),
  });
  const text = await response.text();
  if (!response.ok) {
    let parsed: { error?: unknown } | null = null;
    try {
      parsed = JSON.parse(text) as { error?: unknown };
    } catch {}
    if (typeof parsed?.error === "string") throw new Error(parsed.error);
    throw new Error(text || `Technocore returned ${response.status}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
