const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwlgHFwRhgW0C7authtebo5gHqdWH2U_dBCsLLoTY0RHQuevoaDVH9hIxYu4fYeFc-52w/exec';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ─────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // ── RESEND WEBHOOK — always return 200 immediately ─────────────────────
    if (url.pathname === '/resend-webhook') {
      // Return 200 to Resend RIGHT AWAY — Resend requires a fast response
      const responsePromise = new Response('ok', {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });

      // Process the webhook in the background without blocking the response
      (async () => {
        try {
          const data  = await request.json();
          const type  = data.type || '';
          const email = data.data?.email_id || data.email || data.data?.to?.[0] || '';
          const subject = data.data?.subject || data.subject || '';

          if (type === 'email.unsubscribed' && email) {
            await fetch(APPS_SCRIPT_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'addUnsubscribe', email })
            }).catch(() => {});
          } else {
            await fetch(APPS_SCRIPT_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'logAnalytics',
                eventType: type,
                email,
                subject,
                date: new Date().toISOString()
              })
            }).catch(() => {});
          }
        } catch(e) {}
      })();

      return responsePromise;
    }

    // ── Everything below requires POST ─────────────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // ── GENERATE RECIPE ────────────────────────────────────────────────────
    if (url.pathname === '/generate') {
      try {
        const body = await request.json();
        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      'claude-opus-4-5',
            max_tokens: 4096,
            messages:   body.messages || [{ role: 'user', content: body.prompt || '' }],
            system:     body.system || undefined,
          }),
        });
        const data = await anthropicRes.json();
        let content = data.content?.[0]?.text || '';
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) content = jsonMatch[0];
        try { JSON.parse(content); } catch(e) {
          return jsonResponse({ error: 'Invalid JSON from API', raw: content.substring(0, 200) }, 500);
        }
        return new Response(content, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch(error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ── ADMIN: APPROVE DRAFT ───────────────────────────────────────────────
    if (url.pathname === '/admin/approve-draft') {
      try {
        const { to, subject, message } = await request.json();
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:     'Manuel @ Free From That <man@freefromthat.com>',
            to:       [to],
            subject,
            reply_to: 'man@freefromthat.com',
            html: buildApproveHtml(message),
          }),
        });
        const emailData = await emailRes.json();
        if (!emailRes.ok) return jsonResponse({ ok: false, error: emailData }, 500);

        // Log to Sheets
        await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'markSent', email: to, subject })
        }).catch(() => {});

        return jsonResponse({ ok: true });
      } catch(e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // ── ADMIN: GENERATE BROADCAST WITH CLAUDE ──────────────────────────────
    if (url.pathname === '/admin/generate-broadcast') {
      try {
        const { brief, videoUrl, regions } = await request.json();
        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      'claude-opus-4-5',
            max_tokens: 2000,
            system: `You are Manuel, founder of Free From That (freefromthat.com), a premium vegan pastry ingredient brand based in Spain. Your wife Jessica is a classically trained pastry chef. Write warm, personal, conversational emails in Manuel's authentic voice. Always sign off as Manuel. Never be salesy or corporate.`,
            messages: [{
              role: 'user',
              content: `Write a broadcast email for our customers. Brief: ${brief}${videoUrl ? `\nVideo URL to feature: ${videoUrl}` : ''}\n\nRespond ONLY with valid JSON in this exact format:\n{"subject":"...", "message":"...(full HTML email body)..."}`
            }]
          }),
        });
        const data = await anthropicRes.json();
        let content = data.content?.[0]?.text || '';
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return jsonResponse({ ok: false, error: 'No JSON in Claude response' }, 500);
        const parsed = JSON.parse(jsonMatch[0]);
        return jsonResponse({ ok: true, subject: parsed.subject, message: parsed.message });
      } catch(e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // ── ADMIN: SEND BROADCAST ──────────────────────────────────────────────
    if (url.pathname === '/admin/broadcast-send') {
      try {
        const { subject, message, videoUrl, regionVersions, selectedRegions } = await request.json();

        // Fetch recipients from BigCommerce
        const bcBase    = `https://api.bigcommerce.com/stores/${env.BC_STORE_HASH}`;
        const bcHeaders = {
          'X-Auth-Token':  env.BC_ACCESS_TOKEN,
          'X-Auth-Client': env.BC_CLIENT_ID,
          'Content-Type':  'application/json',
          'Accept':        'application/json',
        };

        // Fetch all customers (paginated)
        let allCustomers = [];
        let page = 1;
        while (true) {
          const res = await fetch(`${bcBase}/v2/customers?limit=250&page=${page}`, { headers: bcHeaders });
          if (!res.ok) break;
          const batch = await res.json();
          if (!batch.length) break;
          allCustomers = allCustomers.concat(batch);
          if (batch.length < 250) break;
          page++;
        }

        // Fetch unsubscribe list
        let unsubscribed = new Set();
        try {
          const unsubRes  = await fetch(`${APPS_SCRIPT_URL}?action=getUnsubscribed`, { signal: AbortSignal.timeout(5000) });
          const unsubData = await unsubRes.json();
          unsubscribed = new Set((unsubData.emails || []).map(e => e.toLowerCase()));
        } catch(e) {}

        // Group emails by region
        const regionMap = {
          'ES': 'es', 'MX': 'mx', 'AR': 'ar', 'CO': 'co', 'PE': 'pe', 'CL': 'cl',
          'US': 'us', 'GB': 'uk', 'AU': 'au', 'CA': 'ca', 'FR': 'fr', 'DE': 'de',
          'IT': 'it', 'PT': 'pt', 'NL': 'nl', 'BE': 'be', 'CH': 'ch', 'AT': 'at',
        };

        const regionEmails = {};
        for (const c of allCustomers) {
          const email   = (c.email || '').toLowerCase();
          const country = (c.addresses?.[0]?.country_iso2 || c.country || 'ES').toUpperCase();
          const region  = regionMap[country] || 'es';
          if (!email) continue;
          if (unsubscribed.has(email)) continue;
          if (selectedRegions && selectedRegions.length && !selectedRegions.includes(region)) continue;
          if (!regionEmails[region]) regionEmails[region] = [];
          regionEmails[region].push(email);
        }

        // Build email list for Resend batch API
        const allEmails = [];
        for (const [regionKey, emails] of Object.entries(regionEmails)) {
          if (!emails.length) continue;
          const regionMsg = (regionVersions && regionVersions[regionKey]) ? regionVersions[regionKey] : message;
          for (const email of emails) {
            allEmails.push({
              from:     'Manuel @ Free From That <man@freefromthat.com>',
              to:       [email],
              subject,
              reply_to: 'man@freefromthat.com',
              html:     buildBroadcastHtml(regionMsg, videoUrl, email),
            });
          }
        }

        // Always add man@freefromthat.com as a copy (FIX: Manuel receives every broadcast)
        allEmails.push({
          from:     'Manuel @ Free From That <man@freefromthat.com>',
          to:       ['man@freefromthat.com'],
          subject:  `[BROADCAST COPY] ${subject}`,
          reply_to: 'man@freefromthat.com',
          html:     buildBroadcastHtml(message, videoUrl, 'man@freefromthat.com'),
        });

        // Send via Resend batch API — 100 emails per call
        let totalSent = 0;
        for (let i = 0; i < allEmails.length; i += 100) {
          const batch = allEmails.slice(i, i + 100);
          try {
            const res = await fetch('https://api.resend.com/emails/batch', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(batch)
            });
            if (res.ok) totalSent += batch.length;
          } catch(e) {}
        }

        // Log broadcast to Sheets
        await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action:    'logBroadcast',
            subject,
            sent:      totalSent,
            date:      new Date().toISOString(),
            regions:   Object.keys(regionEmails).join(', '),
          })
        }).catch(() => {});

        return jsonResponse({ ok: true, sent: totalSent });
      } catch(e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // ── ADMIN: GET DRAFTS ──────────────────────────────────────────────────
    if (url.pathname === '/admin/get-drafts') {
      try {
        const res  = await fetch(`${APPS_SCRIPT_URL}?action=getDrafts`);
        const data = await res.json();
        return jsonResponse(data);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── ADMIN: GET ANALYTICS ───────────────────────────────────────────────
    if (url.pathname === '/admin/get-analytics') {
      try {
        const res  = await fetch(`${APPS_SCRIPT_URL}?action=getAnalytics`);
        const data = await res.json();
        return jsonResponse(data);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    return new Response('Not found', { status: 404 });
  },

  // ── CRON: Daily AI Agent ──────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAIAgent(env));
  }
};

// ── AI AGENT: scan customers and generate drafts ─────────────────────────────
async function runAIAgent(env) {
  const bcBase    = `https://api.bigcommerce.com/stores/${env.BC_STORE_HASH}`;
  const bcHeaders = {
    'X-Auth-Token':  env.BC_ACCESS_TOKEN,
    'X-Auth-Client': env.BC_CLIENT_ID,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
  const MAX_DRAFTS_PER_RUN = 5;

  try {
    const now              = new Date();
    const ninetyDaysAgo    = new Date(now - 90  * 24 * 60 * 60 * 1000);
    const twentyFourHrsAgo = new Date(now -  1  * 24 * 60 * 60 * 1000);
    const fortyEightHrsAgo = new Date(now -  2  * 24 * 60 * 60 * 1000);

    // Parallel fetches
    const [sentRes, ordRes, abandRes, recipeRes] = await Promise.all([
      fetch(`${APPS_SCRIPT_URL}?action=getSentEmails`),
      fetch(`${bcBase}/v2/orders?limit=250&min_date_created=${twentyFourHrsAgo.toISOString()}&status_id=11`, { headers: bcHeaders }),
      fetch(`${bcBase}/v2/orders?limit=250&min_date_created=${fortyEightHrsAgo.toISOString()}&max_date_created=${twentyFourHrsAgo.toISOString()}&status_id=0`, { headers: bcHeaders }),
      fetch(`${APPS_SCRIPT_URL}?action=getRecipeEmails`),
    ]);

    const sentData   = await sentRes.json().catch(() => ({ emails: [] }));
    const orders     = await ordRes.json().catch(() => []);
    const abandoned  = await abandRes.json().catch(() => []);
    const recipeData = await recipeRes.json().catch(() => ({ emails: [] }));

    const sentEmails   = new Set((sentData.emails  || []).map(e => e.toLowerCase()));
    const recipeEmails = new Set((recipeData.emails || []).map(e => e.toLowerCase()));

    // Map recently ordered products
    const recentOrderProds = {};
    for (const o of (Array.isArray(orders) ? orders : [])) {
      if (o.billing_address?.email) {
        recentOrderProds[o.customer_id] = recentOrderProds[o.customer_id] || [];
      }
    }

    // Fetch customers
    let customers = [];
    let page = 1;
    while (true) {
      const res = await fetch(`${bcBase}/v2/customers?limit=250&page=${page}`, { headers: bcHeaders });
      if (!res.ok) break;
      const batch = await res.json();
      if (!batch.length) break;
      customers = customers.concat(batch);
      if (batch.length < 250) break;
      page++;
    }

    const abandonedEmails = new Set((Array.isArray(abandoned) ? abandoned : []).map(o => (o.billing_address?.email || '').toLowerCase()));

    const drafts = [];
    for (const c of customers) {
      if (drafts.length >= MAX_DRAFTS_PER_RUN) break;

      const email     = (c.email || '').toLowerCase();
      const firstName = c.first_name || 'Friend';
      const lastOrder = c.date_modified || null;

      if (!email || sentEmails.has(email)) continue;

      let trigger = null, context = {};

      if (abandonedEmails.has(email)) {
        trigger = 'abandoned_cart';
      } else if (recipeEmails.has(email) && !lastOrder) {
        trigger = 'recipes_no_purchase';
      } else if (lastOrder && new Date(lastOrder) < ninetyDaysAgo) {
        trigger  = 'gone_quiet';
        context  = { daysSince: Math.floor((now - new Date(lastOrder)) / (24*60*60*1000)) };
      } else if (recentOrderProds[c.id]) {
        trigger  = 'post_purchase';
        context  = { orders: recentOrderProds[c.id] };
      } else if (lastOrder && !recipeEmails.has(email)) {
        trigger = 'purchased_never_recipe';
        context = { lastOrder };
      }

      if (!trigger) continue;

      const draft = await generateDraft(env, { firstName, email, trigger, context });
      if (draft) drafts.push(draft);

      await new Promise(r => setTimeout(r, 500));
    }

    if (drafts.length > 0) {
      await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveDrafts', drafts })
      });
    }
  } catch(e) {
    console.error('AI Agent error:', e);
  }
}

// ── Generate email draft with Claude ─────────────────────────────────────────
async function generateDraft(env, { firstName, email, trigger, context }) {
  const prompts = {
    abandoned_cart:         `The customer ${firstName} (${email}) added products to their cart but didn't complete the purchase. Write a warm, personal email from Manuel (Founder, Free From That) following up. Mention they left something behind, offer to help, and suggest they reply for a special offer. Keep it short, genuine, no pressure.`,
    recipes_no_purchase:    `The customer ${firstName} (${email}) has used our free My Recipe Maker tool multiple times but has never purchased any products. Write a warm email from Manuel encouraging their first purchase. Mention their recipe activity shows they're passionate about vegan baking. Suggest they reply for a special offer on their first order.`,
    gone_quiet:             `The customer ${firstName} (${email}) hasn't ordered from Free From That in ${context.daysSince} days. Write a warm re-engagement email from Manuel. Express that we miss them, mention we have new products and Chef Jessica's Recipe Maker at freefromthat.com/myrecipemaker. Offer a special loyalty discount if they reply.`,
    post_purchase:          `The customer ${firstName} (${email}) just placed an order with Free From That. Write a warm follow-up email from Manuel, 24 hours after their purchase. Ask what they're planning to make. Suggest they try our free My Recipe Maker at freefromthat.com/myrecipemaker for recipe inspiration.`,
    purchased_never_recipe: `The customer ${firstName} (${email}) has purchased from Free From That but has never used our free My Recipe Maker. Write a warm email from Manuel introducing them to it at freefromthat.com/myrecipemaker. Chef Jessica developed it personally. Keep it short and personal.`,
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-opus-4-5',
        max_tokens: 1000,
        system:     'You are Manuel, founder of Free From That (freefromthat.com). Write warm, personal, authentic emails. Always sign as Manuel. Never be corporate or salesy. Respond ONLY with valid JSON: {"subject":"...","body":"..."}',
        messages:   [{ role: 'user', content: prompts[trigger] }],
      }),
    });
    const data    = await res.json();
    let   content = data.content?.[0]?.text || '';
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return { email, firstName, trigger, subject: parsed.subject, body: parsed.body, date: new Date().toISOString() };
  } catch(e) {
    return null;
  }
}

// ── HTML builder for broadcast emails ────────────────────────────────────────
function buildBroadcastHtml(message, videoUrl, recipientEmail) {
  const unsubLink = `https://fft-recipe.man-4bb.workers.dev/unsubscribe?email=${encodeURIComponent(recipientEmail)}`;
  const videoBlock = videoUrl ? `
    <div style="text-align:center;margin:20px 0;">
      <a href="${videoUrl}" target="_blank" style="display:inline-block;background:#f5c842;color:#17587E;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">▶ Watch Video</a>
    </div>` : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
    <div style="background:#17587E;padding:24px;text-align:center;">
      <h1 style="color:#f5c842;font-family:Georgia,serif;margin:0;font-size:28px;">Free From That</h1>
    </div>
    <div style="padding:32px 28px;color:#333;font-size:15px;line-height:1.7;">
      ${message}
      ${videoBlock}
    </div>
    <div style="background:#f9f9f9;padding:20px 28px;text-align:center;font-size:12px;color:#999;">
      <p>Free From That · Mallorca, Spain · <a href="https://freefromthat.com" style="color:#17587E;">freefromthat.com</a></p>
      <p><a href="${unsubLink}" style="color:#999;">Unsubscribe</a></p>
    </div>
  </div>
</body></html>`;
}

// ── HTML builder for approve-draft emails ────────────────────────────────────
function buildApproveHtml(message) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
    <div style="background:#17587E;padding:24px;text-align:center;">
      <h1 style="color:#f5c842;font-family:Georgia,serif;margin:0;font-size:28px;">Free From That</h1>
    </div>
    <div style="padding:32px 28px;color:#333;font-size:15px;line-height:1.7;">
      ${message}
    </div>
    <div style="background:#f9f9f9;padding:20px 28px;text-align:center;font-size:12px;color:#999;">
      <p>Free From That · Mallorca, Spain · <a href="https://freefromthat.com" style="color:#17587E;">freefromthat.com</a></p>
    </div>
  </div>
</body></html>`;
}

// ── JSON response helper ──────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
