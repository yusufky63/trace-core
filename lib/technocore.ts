export async function technocore(path: string, method: "GET" | "POST" = "GET", body?: unknown) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
        const errorMsg = typeof parsed?.error === "string" ? parsed.error : text || `Technocore returned ${response.status}.`;
        if ([502, 503, 504].includes(response.status) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 300));
          continue;
        }
        throw new Error(errorMsg);
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      lastError = err;
      if (attempt < 3 && err instanceof Error && !err.message.includes("404") && !err.message.includes("limit")) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}
