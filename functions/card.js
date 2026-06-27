/* Cloudflare Pages Function — route /card (Pages serves card.html here via clean-URLs).
   Gives shared contact-card links a personalised social preview ("<Name> wants to keep
   in touch — via Sovenn") by rewriting the OG/Twitter title from the ?from= name.
   Additive + fail-safe: any error returns the original static page unchanged. */
export async function onRequest(context) {
  const res = await context.next();           // the static card.html asset served at /card
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
