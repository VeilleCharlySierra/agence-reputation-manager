// Fonction serveur « remontees » : reçoit les messages du groupe WhatsApp de l'équipe, lus par le script de l'ordinateur de veille.
// Lecture seule : rien n'est jamais écrit dans le groupe. Chaque lien de publication (Facebook, TikTok, X) entre dans le socle
// comme remontée humaine ; ses données sont complétées au relevé suivant, puis la publication passe à l'analyse.
// Les captures jointes servent d'image à la publication ; une capture sans lien devient elle-même une remontée.
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-cle", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const rep = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’ʼ´`]/g, "'").replace(/\s+/g, " ");
const reseau = (u: string) => /\/storage\/v1\/object\/sign\/captures-equipe\//.test(u) ? "Capture" : /tiktok\.com/i.test(u) ? "TikTok" : /\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/]+\/status\//i.test(u) ? "X" : /facebook\.com|fb\.watch|fb\.com/i.test(u) ? "Facebook" : "";
const propre = (u: string) => {
  const t = String(u || "").replace("web.facebook.com", "www.facebook.com").replace("m.facebook.com", "www.facebook.com");
  return t.replace(/[?&](mibextid|rdid|__cft__|__tn__|_rdr|sfnsn|s|t)=[^&#]*/g, "").replace(/\?$/, "");
};

// captures jointes au message : déposées dans l'espace privé « captures-equipe », lues par lien signé (30 jours)
const BASE = Deno.env.get("SUPABASE_URL")!, SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function deposerCapture(dataUrl: string): Promise<string | null> {
  const m = String(dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const octets = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (octets.length < 2000 || octets.length > 3 * 1024 * 1024) return null;
  const chemin = new Date().toISOString().slice(0, 10) + "/" + crypto.randomUUID() + (m[1] === "image/png" ? ".png" : m[1] === "image/webp" ? ".webp" : ".jpg");
  const h = { Authorization: "Bearer " + SRV, apikey: SRV };
  const up = await fetch(`${BASE}/storage/v1/object/captures-equipe/${chemin}`, { method: "POST", headers: { ...h, "Content-Type": m[1] }, body: octets });
  if (!up.ok) return null;
  const sg = await fetch(`${BASE}/storage/v1/object/sign/captures-equipe/${chemin}`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 30 * 86400 }) });
  if (!sg.ok) return null;
  const j = await sg.json();
  return j.signedURL ? BASE + "/storage/v1" + j.signedURL : null;
}

// lecture des requêtes booléennes (même règle que la collecte) : seules les expressions principales nomment une marque
type Noeud = { t: "mot"; v: string } | { t: "et" | "ou"; g: Noeud; d: Noeud } | { t: "sauf"; g: Noeud; d: Noeud };
function analyser(src: string): Noeud {
  const jetons: string[] = [];
  const re = /"([^"]*)"|\(|\)|[^\s()"]+/g; let m;
  while ((m = re.exec(src))) jetons.push(m[1] !== undefined ? "\u0000" + m[1] : m[0]);
  let i = 0;
  const op = (j: string | undefined) => j && /^(ET|AND|OU|OR|SAUF|NOT)$/i.test(j) ? j.toUpperCase() : null;
  const primaire = (): Noeud => {
    const j = jetons[i];
    if (j === "(") { i++; const n = ou(); if (jetons[i] === ")") i++; return n; }
    const mots: string[] = [];
    while (i < jetons.length && jetons[i] !== "(" && jetons[i] !== ")" && !op(jetons[i])) {
      const x = jetons[i++]; mots.push(x.startsWith("\u0000") ? x.slice(1) : x);
      if (x.startsWith("\u0000")) break;
    }
    return { t: "mot", v: mots.join(" ").trim() };
  };
  const et = (): Noeud => {
    let g = primaire();
    for (;;) {
      const o = op(jetons[i]);
      if (o === "ET" || o === "AND") { i++; g = { t: "et", g, d: primaire() }; }
      else if (o === "SAUF" || o === "NOT") { i++; g = { t: "sauf", g, d: primaire() }; }
      else return g;
    }
  };
  const ou = (): Noeud => { let g = et(); while (op(jetons[i]) === "OU" || op(jetons[i]) === "OR") { i++; g = { t: "ou", g, d: et() }; } return g; };
  return ou();
}
// un terme doit apparaître comme mot entier : « OCI » ne correspond ni à « sociale » ni à « oči »
const motEntier = (texte: string, v: string) =>
  new RegExp("(^|[^\\p{L}\\p{N}])" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^\\p{L}\\p{N}])", "u").test(texte);
// expressions principales d'une requête : à gauche d'un ET ou d'un SAUF, de part et d'autre d'un OU
function ancres(n: Noeud): string[] {
  if (n.t === "mot") return n.v ? [n.v] : [];
  if (n.t === "ou") return [...ancres(n.g), ...ancres(n.d)];
  return ancres(n.g);
}

// une marque est nommée si le message contient son nom, ou l'une des expressions principales de ses mots-clés, en mot entier
function nommee(m: any, texte: string) {
  const t = norm(texte);
  if ((m.exclusions || []).some((x: string) => x && t.includes(norm(x)))) return false;
  const termes = [m.nom, ...(m.mots_cles || []).flatMap((q: string) => ancres(analyser(q)))].map((s: string) => norm(s)).filter((s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").length >= 4);
  return termes.some((s: string) => motEntier(t, s));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const cle = req.headers.get("x-cle") || "";
    const [e] = await sql`select valeur from prive.cles where nom = 'cle_remontees_empreinte'`;
    const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cle)))).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!e || !cle || h !== e.valeur) return rep({ ok: false, erreur: "clé invalide" }, 403);

    const corps = await req.json().catch(() => ({}));
    const messages: any[] = Array.isArray(corps.messages) ? corps.messages.slice(0, 200) : [];
    const marques = await sql`select m.id, m.nom, m.mots_cles, m.exclusions from public.marques m join public.clients c on c.id = m.client_id where c.actif and m.actif`;
    let recus = 0, liensAjoutes = 0, aJuger = 0;
    for (const m of messages) {
      const id = String(m.id || "").slice(0, 200);
      if (!id) continue;
      const texte = String(m.texte || "").slice(0, 4000);
      const liens = [...new Set([...(Array.isArray(m.liens) ? m.liens : []), ...(texte.match(/https?:\/\/[^\s<>"']+/g) || [])]
        .map((u: string) => { try { return propre(new URL(u).href); } catch { return ""; } })
        .filter((u: string) => u && reseau(u)))].slice(0, 10);
      const envoye = m.heure ? new Date(m.heure) : null;
      const images: string[] = Array.isArray(m.images) ? m.images.slice(0, 4) : [];
      const [deja] = await sql`select id, liens, cardinality(captures) as nc from public.remontees_equipe where message_id = ${id}`;
      if (deja) {
        // message déjà reçu sans ses captures (première version du script) : on ajoute seulement les captures
        if (deja.nc > 0 || !images.length) continue;
        const cap: string[] = [];
        for (const im of images) { const u = await deposerCapture(im); if (u) cap.push(u); }
        if (!cap.length) continue;
        await sql`update public.remontees_equipe set captures = ${cap} where id = ${deja.id}`;
        await sql`update socle.collecte set image = coalesce(image, ${cap[0]}) where lien = any(${deja.liens})`;
        await sql`update public.publications set capture = coalesce(capture, ${cap[0]}) where lien = any(${deja.liens})`;
        continue;
      }
      const captures: string[] = [];
      for (const im of images) { const u = await deposerCapture(im); if (u) captures.push(u); }
      // une capture sans lien devient elle-même une remontée à analyser
      const seule = !liens.length && captures.length ? captures[0] : null;
      if (seule) liens.push(seule);
      const [ins] = await sql`insert into public.remontees_equipe (message_id, groupe, auteur, texte, liens, captures, envoye_le)
        values (${id}, ${String(m.groupe || "").slice(0, 120)}, ${String(m.auteur || "").slice(0, 120)}, ${texte}, ${liens}, ${captures},
                ${envoye && !isNaN(envoye.getTime()) ? envoye : null})
        on conflict (message_id) do nothing returning id`;
      if (!ins) continue;
      recus++;
      if (!liens.length) continue;
      // le groupe remonte plusieurs marques : un lien va directement aux marques que le message nomme.
      // Sinon il part à l'analyse de chaque marque active, sans filtre de mots-clés (« à juger ») :
      // l'analyse lit la publication et garde ce qui parle réellement de la marque.
      const visees = marques.filter((x) => nommee(x, texte));
      const cibles = visees.length ? visees : marques;
      const motCle = visees.length ? "remontée de l'équipe" : "remontée de l'équipe (à juger)";
      for (const lien of liens) {
        const capture = lien === seule;
        const [c] = await sql`insert into socle.collecte (source, plateforme, lien, remontee_par, remontee_texte, mot_cle, image, texte, auteur, publiee_le, complete_le)
          values ('humaine', ${capture ? "Capture" : reseau(lien)}, ${lien}, ${String(m.auteur || "").slice(0, 120)}, ${texte}, 'remontée de l''équipe',
                  ${captures[0] || null}, ${capture ? texte : null}, ${capture ? "Capture de l'équipe" : null},
                  ${capture && envoye && !isNaN(envoye.getTime()) ? envoye : null}, ${capture ? new Date() : null})
          on conflict (lien) do update set remontee_par = coalesce(socle.collecte.remontee_par, excluded.remontee_par),
            remontee_texte = coalesce(socle.collecte.remontee_texte, excluded.remontee_texte),
            image = coalesce(socle.collecte.image, excluded.image) returning id`;
        if (!visees.length) aJuger++;
        for (const x of cibles) {
          const r = await sql`insert into socle.distribution (collecte_id, marque_id, type, mot_cle)
            values (${c.id}, ${x.id}, 'remontee', ${motCle}) on conflict do nothing returning 1`;
          if (r.length) liensAjoutes++;
        }
      }
    }
    if (recus) await sql`insert into public.journal (type, par, detail) values ('Publication', 'remontées de l''équipe', ${recus + " message(s) reçu(s), " + liensAjoutes + " lien(s) transmis à l'analyse, dont " + aJuger + " sans marque nommée"})`;
    return rep({ ok: true, recus, liens: liensAjoutes, a_juger: aJuger, a_trier: 0 });
  } catch (e) {
    return rep({ ok: false, erreur: (e as Error).message }, 500);
  }
});
