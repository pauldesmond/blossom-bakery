// contact-enquiry — receives website contact submissions and forwards
// them to Helen via Resend.
//
// Required env (Supabase function secrets):
//   RESEND_API_KEY      — Resend API key
//   CONTACT_TO_EMAIL    — destination inbox, e.g. blossombakedgoods@gmail.com
//   CONTACT_FROM_EMAIL  — optional verified sender override
//   RESEND_FROM_EMAIL   — existing verified sender secret fallback

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const CONTACT_TO_EMAIL = Deno.env.get("CONTACT_TO_EMAIL") ?? "blossombakedgoods@gmail.com";
const CONTACT_FROM_EMAIL = Deno.env.get("CONTACT_FROM_EMAIL")
  ?? Deno.env.get("RESEND_FROM_EMAIL")
  ?? "";

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

function esc(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (!RESEND_API_KEY || !CONTACT_FROM_EMAIL) {
    return json({ ok: false, error: "Server not configured." }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const website = String(body.website ?? "").trim();
  if (website) return json({ ok: true });

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const date = String(body.date ?? "").trim();
  const type = String(body.type ?? "").trim();
  const guests = String(body.guests ?? "").trim();
  const message = String(body.message ?? "").trim();

  if (!name || !email || !message) {
    return json({ ok: false, error: "Name, email and message are required." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400);
  }
  if (message.length < 10) {
    return json({ ok: false, error: "Please add a little more detail to your message." }, 400);
  }

  const safe = {
    name: esc(name),
    email: esc(email),
    phone: esc(phone || "Not provided"),
    date: esc(date || "Not provided"),
    type: esc(type || "Not provided"),
    guests: esc(guests || "Not provided"),
    message: esc(message).replaceAll("\n", "<br>"),
  };

  const subject = `Blossom Bakery enquiry: ${type || "Website enquiry"} — ${name}`;
  const text = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || "Not provided"}`,
    `Date needed: ${date || "Not provided"}`,
    `Bake type: ${type || "Not provided"}`,
    `Guests: ${guests || "Not provided"}`,
    "",
    "Details:",
    message,
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#2b1f1c">
      <h2 style="margin:0 0 16px">New Blossom Bakery enquiry</h2>
      <p><strong>Name:</strong> ${safe.name}</p>
      <p><strong>Email:</strong> ${safe.email}</p>
      <p><strong>Phone:</strong> ${safe.phone}</p>
      <p><strong>Date needed:</strong> ${safe.date}</p>
      <p><strong>Bake type:</strong> ${safe.type}</p>
      <p><strong>Guests:</strong> ${safe.guests}</p>
      <p><strong>Details:</strong><br>${safe.message}</p>
    </div>
  `;

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: CONTACT_FROM_EMAIL,
      to: [CONTACT_TO_EMAIL],
      reply_to: email,
      subject,
      text,
      html,
    }),
  });

  if (!resendResp.ok) {
    const details = await resendResp.text();
    return json({ ok: false, error: "Failed to send enquiry.", details: details.slice(0, 500) }, 502);
  }

  return json({ ok: true });
});
