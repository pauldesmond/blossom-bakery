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

  let body: { password?: string; draft?: unknown; message?: string; revertSha?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (body.password !== PUBLISH_PASSWORD) {
    return json({ ok: false, error: "Wrong password." }, 401);
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

  // GitHub doesn't return the run ID from dispatches — list recent runs to
  // find the one we just kicked off. Best-effort; the editor polls anyway.
  await new Promise((r) => setTimeout(r, 1500));
  const runsResp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
    { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" } },
  );
  let runUrl = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;
  let runId: number | null = null;
  if (runsResp.ok) {
    const data = await runsResp.json();
    if (data.workflow_runs?.[0]) {
      runUrl = data.workflow_runs[0].html_url;
      runId = data.workflow_runs[0].id;
    }
  }

  return json({ ok: true, runUrl, runId });
});
