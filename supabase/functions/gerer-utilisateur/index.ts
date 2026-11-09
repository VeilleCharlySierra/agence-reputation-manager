// Agence Reputation Manager — fonction « gerer-utilisateur »
// Crée, modifie, désactive ou supprime un compte, et réinitialise un mot de passe.
// Règles :
//  - super_viral gère tous les rôles ;
//  - admin_viral gère les rôles d'agence et clients (pas les rôles Viral) ;
//  - admin_agence gère admin_agence, user_agence et user_client ;
//  - personne ne modifie ni ne supprime son propre compte par cette fonction.
// Amorçage : action « amorcer » avec l'en-tête x-jeton égal à prive.cles('jeton_amorce'),
// possible une seule fois, tant qu'aucun super_viral n'existe.
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-jeton",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const rep = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ROLES = ["super_viral", "admin_viral", "admin_agence", "user_agence", "user_client"];
const GERE: Record<string, string[]> = {
  super_viral: ROLES,
  admin_viral: ["admin_agence", "user_agence", "user_client"],
  admin_agence: ["admin_agence", "user_agence", "user_client"],
};

function motDePasse(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(b, (x) => a[x % a.length]).join("");
}

async function auth(chemin: string, methode: string, corps?: unknown) {
  const r = await fetch(URL_SB + "/auth/v1/admin/" + chemin, {
    method: methode,
    headers: { Authorization: "Bearer " + SRV, apikey: SRV, "Content-Type": "application/json" },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const t = await r.text();
  let j: any = {};
  try { j = t ? JSON.parse(t) : {}; } catch { j = { brut: t }; }
  if (!r.ok) throw new Error(j.msg || j.message || j.error_description || ("auth " + r.status));
  return j;
}

async function idAuth(email: string): Promise<string | null> {
  const r = await sql`select id::text from auth.users where lower(email) = ${email}`;
  return r.length ? r[0].id : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const corps = await req.json();
    const action = String(corps.action || "");

    // ---- Amorçage du premier super administrateur ----
    if (action === "amorcer") {
      const j = await sql`select valeur from prive.cles where nom = 'jeton_amorce'`;
      if (!j.length || req.headers.get("x-jeton") !== j[0].valeur) return rep({ ok: false, erreur: "jeton invalide" }, 403);
      const deja = await sql`select 1 from public.utilisateurs where role = 'super_viral'`;
      if (deja.length) return rep({ ok: false, erreur: "déjà amorcé" }, 409);
      const email = String(corps.email || "").trim().toLowerCase();
      const mdp = motDePasse();
      await auth("users", "POST", { email, password: mdp, email_confirm: true });
      await sql`insert into public.utilisateurs (email, nom, role, ajoute_par) values (${email}, ${corps.nom || null}, 'super_viral', 'amorçage')`;
      await sql`delete from prive.cles where nom = 'jeton_amorce'`;
      await sql`insert into public.journal (type, par, detail) values ('Administration', 'amorçage', ${"Super administrateur créé : " + email})`;
      return rep({ ok: true, email, mot_de_passe: mdp });
    }

    // ---- Appelant authentifié ----
    const u = await fetch(URL_SB + "/auth/v1/user", {
      headers: { Authorization: req.headers.get("authorization") || "", apikey: SRV },
    });
    if (!u.ok) return rep({ ok: false, erreur: "session invalide" }, 401);
    const moi = String((await u.json()).email || "").toLowerCase();
    const r = await sql`select role from public.utilisateurs where email = ${moi} and actif`;
    if (!r.length || !GERE[r[0].role]) return rep({ ok: false, erreur: "réservé aux administrateurs" }, 403);
    const monRole: string = r[0].role;
    const autorises = GERE[monRole];

    const email = String(corps.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return rep({ ok: false, erreur: "adresse e-mail invalide" }, 400);
    if (email === moi) return rep({ ok: false, erreur: "vous ne pouvez pas modifier votre propre compte ici" }, 400);

    const existant = await sql`select role from public.utilisateurs where email = ${email}`;
    if (existant.length && !autorises.includes(existant[0].role))
      return rep({ ok: false, erreur: "ce compte relève d'un niveau supérieur au vôtre" }, 403);

    if (action === "creer" || action === "modifier") {
      const role = String(corps.role || "");
      if (!ROLES.includes(role) || !autorises.includes(role)) return rep({ ok: false, erreur: "rôle non autorisé" }, 403);
      const clients: number[] = Array.isArray(corps.clients) ? corps.clients.map(Number).filter((x: number) => x > 0) : [];
      const clientId = role === "user_client" ? Number(corps.client_id) || null : null;
      if (role === "user_client" && !clientId) return rep({ ok: false, erreur: "choisissez le client de cet utilisateur" }, 400);
      if (role === "user_agence" && !clients.length) return rep({ ok: false, erreur: "attribuez au moins un client" }, 400);
      const nom = corps.nom ? String(corps.nom).slice(0, 80) : null;
      let mdp: string | null = null;

      if (action === "creer") {
        if (existant.length) return rep({ ok: false, erreur: "ce compte existe déjà" }, 409);
        mdp = motDePasse();
        if (await idAuth(email)) {
          await auth("users/" + (await idAuth(email)), "PUT", { password: mdp, email_confirm: true });
        } else {
          await auth("users", "POST", { email, password: mdp, email_confirm: true });
        }
        await sql`insert into public.utilisateurs (email, nom, role, client_id, ajoute_par) values (${email}, ${nom}, ${role}, ${clientId}, ${moi})`;
      } else {
        if (!existant.length) return rep({ ok: false, erreur: "compte introuvable" }, 404);
        const actif = corps.actif === undefined ? true : !!corps.actif;
        await sql`update public.utilisateurs set nom = ${nom}, role = ${role}, client_id = ${clientId}, actif = ${actif} where email = ${email}`;
      }
      await sql`delete from public.utilisateur_clients where email = ${email}`;
      if (role === "user_agence") {
        for (const c of clients) await sql`insert into public.utilisateur_clients (email, client_id) values (${email}, ${c}) on conflict do nothing`;
      }
      await sql`insert into public.journal (type, par, detail) values ('Administration', ${moi}, ${(action === "creer" ? "Compte créé : " : "Compte modifié : ") + email + " (" + role + ")"})`;
      return rep({ ok: true, mot_de_passe: mdp });
    }

    if (action === "reinitialiser") {
      if (!existant.length) return rep({ ok: false, erreur: "compte introuvable" }, 404);
      const id = await idAuth(email);
      if (!id) return rep({ ok: false, erreur: "identifiant introuvable" }, 404);
      const mdp = motDePasse();
      await auth("users/" + id, "PUT", { password: mdp });
      await sql`update public.utilisateurs set doit_changer_mdp = true where email = ${email}`;
      await sql`insert into public.journal (type, par, detail) values ('Administration', ${moi}, ${"Mot de passe réinitialisé : " + email})`;
      return rep({ ok: true, mot_de_passe: mdp });
    }

    if (action === "supprimer") {
      if (!existant.length) return rep({ ok: false, erreur: "compte introuvable" }, 404);
      const id = await idAuth(email);
      await sql`delete from public.utilisateurs where email = ${email}`;
      if (id) await auth("users/" + id, "DELETE");
      await sql`insert into public.journal (type, par, detail) values ('Administration', ${moi}, ${"Compte supprimé : " + email})`;
      return rep({ ok: true });
    }

    return rep({ ok: false, erreur: "action inconnue" }, 400);
  } catch (e) {
    return rep({ ok: false, erreur: (e as Error).message }, 500);
  }
});
