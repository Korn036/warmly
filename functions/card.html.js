/* Cloudflare Pages Function — scoped to /card.html only.
   Gives shared contact-card links a personalised social preview ("<Name> wants to keep
   in touch — via Sovenn") by rewriting the OG/Twitter title with the ?from= name.
   Additive + fail-safe: any error returns the original static card.html unchanged. */
export async function onRequest(context) {
  const res = await context.next();           // the static card.html asset
  try {
    const from = (new URL(context.request.url).searchParams.get('from') || '')
      .slice(0, 40).replace(/[<>&"]/g, '').trim();
    if (!from) return res;
    const title = from + ' wants to keep in touch — via Sovenn';
    return new HTMLRewriter()
      .on('meta[property="og:title"]',  { element(e) { e.setAttribute('content', title); } })
      .on('meta[name="twitter:title"]', { element(e) { e.setAttribute('content', title); } })
      .transform(res);
  } catch (e) {
    return res;
  }
}
