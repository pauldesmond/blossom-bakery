// publish-draft — broker between Helen's editor and the apply-helen-draft
// GitHub Actions workflow. Validates a shared password, base64-encodes the
// draft, dispatches the workflow, and returns the run URL/ID so the editor
// can poll for completion.
//
// Required env (Supabase function secrets):
//   PUBLISH_PASSWORD   — the shared secret Helen types in the editor
//   BLOSSOM_GH_PAT     — fine-grained PAT for pauldesmond/blossom-bakery
//                         with `actions:write` and `contents:write` scopes
//   BLOSSOM_REPO       — optional override (default: pauldesmond/blossom-bakery)
//   BLOSSOM_WORKFLOW   — optional override (default: apply-helen-draft.yml)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PUBLISH_PASSWORD = Deno.env.get("PUBLISH_PASSWORD") ?? "";
const GH_TOKEN = Deno.env.get("BLOSSOM_GH_PAT") ?? "";
const REPO = Deno.env.get("BLOSSOM_REPO") ?? "pauldesmond/blossom-bakery";
const WORKFLOW = Deno.env.get("BLOSSOM_WORKFLOW") ?? "apply-helen-draft.yml";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Base64 encode a UTF-8 string.
function b64(str: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (!PUBLISH_PASSWORD || !GH_TOKEN) {
    return json({ ok: false, error: "Server not configured (missing secrets)." }, 500);
  }

  let body: {
    password?: string;
    draft?: unknown;
    message?: string;
    revertSha?: string;
    mode?: string;
    oldSrc?: string;
    dataUrl?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (body.password !== PUBLISH_PASSWORD) {
    return json({ ok: false, error: "Wrong password." }, 401);
  }

  // ──────────────────────────────────────────────────────────────────
  // Image upload mode — single photo per request, so iPad Safari's
  // fetch-body wobble on multi-MB POSTs never bites. Editor calls this
  // once per swapped photo BEFORE the publish call. We commit the
  // image straight to /images/<derived-name>.<ext> via the GitHub
  // Contents API and return the new src path, which the editor then
  // substitutes into draft.images as a plain string. The publish call
  // ends up text-only and tiny.
  // ──────────────────────────────────────────────────────────────────
  if (body.mode === "upload") {
    const oldSrc = String(body.oldSrc ?? "").trim();
    const dataUrl = String(body.dataUrl ?? "");
    if (!oldSrc || !dataUrl) {
      return json({ ok: false, error: "oldSrc and dataUrl required" }, 400);
    }
    const m = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!m) return json({ ok: false, error: "Invalid dataUrl" }, 400);
    const mime = m[1];
    const b64data = m[2];
    const ext = mime === "image/jpeg"
      ? "jpg"
      : mime === "image/png"
      ? "png"
      : mime === "image/webp"
      ? "webp"
      : "bin";
    // Strip any existing -edit / -edit-XXX suffix so repeat swaps don't
    // accumulate ("foo-edit-abc.jpg" becomes "foo" → "foo-edit-NEW.jpg").
    const base = oldSrc.replace(/^.*\//, "").replace(/\.[^.]+$/, "")
      .replace(/-edit(-[0-9a-z]+)?$/i, "");
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const newName = `${base}-edit-${stamp}.${ext}`;
    const newPath = `images/${newName}`;
    const writeResp = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${newPath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          message: `[image] upload via editor: ${newName}`,
          content: b64data,
        }),
      },
    );
    if (!writeResp.ok) {
      const text = await writeResp.text();
      return json({ ok: false, error: "Upload failed.", details: text.slice(0, 500) }, 502);
    }
    return json({ ok: true, newSrc: newPath });
  }

  const inputs: Record<string, string> = { draft_path: "", message: "", revert_sha: "" };

  if (body.revertSha) {
    if (!/^[0-9a-f]{7,40}$/i.test(body.revertSha)) {
      return json({ ok: false, error: "Bad SHA" }, 400);
    }
    inputs.revert_sha = body.revertSha;
  } else {
    if (!body.draft) return json({ ok: false, error: "draft required" }, 400);
    // We used to strip images here and base64-encode the slim draft into
    // the workflow_dispatch input — but workflow_dispatch caps inputs at
    // ~65KB, so any photo swap (~1MB+ as a data URL) would have blown the
    // limit. The editor stripped images upfront to compensate, with the
    // side effect that image swaps never reached publish at all.
    //
    // New flow: commit the FULL draft (images and all) to a staging file
    // in the repo, then dispatch the workflow with just the file path.
    // The workflow reads from disk and removes the staging file as part
    // of its commit. No 65KB limit, no stripping.
    const draftStr = JSON.stringify(body.draft);
    // Belt-and-braces sanity ceiling. Supabase edge functions cap request
    // bodies around 10MB; this gives headroom for the JSON wrapper too.
    if (draftStr.length > 8 * 1024 * 1024) {
      return json({
        ok: false,
        error: "Draft too large (>8MB). Split photo swaps into smaller batches, or send to Paul via Save Draft.",
      }, 413);
    }
    const draftId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const draftPath = `_drafts/auto-${draftId}.json`;
    const writeResp = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${draftPath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          message: `[draft] queue: ${String(body.message ?? "helen edits").slice(0, 100)}`,
          content: b64(draftStr),
        }),
      },
    );
    if (!writeResp.ok) {
      const text = await writeResp.text();
      return json({ ok: false, error: "Failed to stage draft.", details: text.slice(0, 500) }, 502);
    }
    inputs.draft_path = draftPath;
    inputs.message = String(body.message ?? "").slice(0, 200);
  }

  const dispatch = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );
  if (!dispatch.ok) {
    const text = await dispatch.text();
    return json({ ok: false, error: "Failed to start publish.", details: text.slice(0, 500) }, 502);
  }

  // GitHub doesn't return the run ID from dispatches — list recent runs
  // to find the one we just kicked off. Without the runId the editor's
  // pollRunStatus exits early and the draft-clear-on-done effect never
  // fires. Retry up to ~6s with backoff so we don't lose the runId on
  // the occasional slow dispatch registration.
  let runUrl = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;
  let runId: number | null = null;
  const dispatchedAt = Date.now();
  for (const wait of [1500, 1500, 1500, 1500]) {
    await new Promise((r) => setTimeout(r, wait));
    const runsResp = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
      { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" } },
    );
    if (!runsResp.ok) continue;
    const data = await runsResp.json();
    // Find the most recent run that started AFTER we dispatched. Listing
    // top-1 was racy — could return a previous publish if GitHub hasn't
    // registered the new run yet, and on the next dispatch we'd return
    // an outdated run.
    const candidate = (data.workflow_runs || []).find((r: { created_at?: string; run_started_at?: string; html_url?: string; id?: number }) => {
      const t = Date.parse(r.run_started_at || r.created_at || "");
      return t && t >= dispatchedAt - 5000;
    });
    if (candidate) {
      runUrl = candidate.html_url || runUrl;
      runId = candidate.id || null;
      break;
    }
  }

  return json({ ok: true, runUrl, runId });
});
