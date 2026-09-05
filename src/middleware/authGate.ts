/**
 * Deepcape-fork: fail-closed portti jokaiselle reitille jolla on sivuvaikutus.
 *
 * Upstream vaatii `bearerToken`-kentän join-reiteillä, mutta ei tarkista sitä
 * koskaan — kenttä vain välitetään ScreenAppin backendille. Deepcapen forkissa
 * se backend on stubattu pois (`services/botService.ts`), joten kenttä ei
 * todentanut yhtään mitään: kuka tahansa joka tavoitti portin pystyi
 * käynnistämään selaimen, liittymään mihin tahansa kokoukseen ja tallentamaan
 * sen (#1787 A5.1 → #1789).
 *
 * Tämä moduuli tekee kentästä aidon tunnisteen: jaettu salaisuus jonka
 * operaattori konfiguroi koodin ulkopuolelta, verrattuna vakioajassa ENNEN kuin
 * pyyntö pääsee jonoon tai selaimeen.
 *
 * Fail-closed tässä järjestyksessä — jokainen haara hylkää:
 *   - salaisuutta ei konfiguroitu             -> 503, mitään ei aja
 *   - salaisuus konfiguroitu mutta liian lyhyt -> 503, mitään ei aja
 *   - salaisuustiedosto lukukelvoton           -> 503, mitään ei aja
 *   - pyyntö ei esitä tokenia                  -> 401
 *   - esitetty token ei täsmää                 -> 401
 * Ei ole ympäristöä, headeria eikä lippua joka avaa portin ilman osumaa.
 *
 * Salaisuus luetaan ympäristöstä JOKAISELLA pyynnöllä, ei moduulin latautuessa:
 * kierrätys ei silloin vaadi prosessin uudelleenkäynnistystä, ja lukukelvottomaksi
 * muuttunut tiedosto kaataa seuraavan pyynnön eikä seuraavaa bootia. Join-pyyntöjä
 * tulee korkeintaan muutama tunnissa, joten luku on ilmainen.
 */
import crypto from 'crypto';
import fs from 'fs';
import { NextFunction, Request, Response } from 'express';

/** Tätä lyhyempi jaettu salaisuus on arvattavissa rajapinnalta jolla ei ole rate limitiä. */
const MIN_SECRET_LENGTH = 32;

export type AuthDenyReason =
  | 'unconfigured' // palvelimella ei ole kelvollista salaisuutta — operaattorin virhe, ei kutsujan
  | 'missing' // kutsuja ei esittänyt tokenia
  | 'invalid'; // kutsuja esitti tokenin joka ei täsmännyt

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: AuthDenyReason; detail: string };

type ResolvedSecret = { secret: string } | { secret: null; detail: string };

/**
 * Ratkaisee konfiguroidun salaisuuden. Palauttaa nullin kun portin on pysyttävä
 * kiinni. `detail` ei koskaan sisällä salaisuutta eikä sen osaa.
 */
const resolveSecret = (): ResolvedSecret => {
  const secretFile = process.env.MEETING_BOT_AUTH_TOKEN_FILE?.trim();

  // Konfiguroitu tiedosto voittaa inline-muuttujan, ja lukukelvoton tiedosto on
  // kiinni oleva portti — ei koskaan hiljaista paluuta siihen mitä muuta sattuu
  // olemaan asetettuna.
  if (secretFile) {
    let contents: string;
    try {
      contents = fs.readFileSync(secretFile, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'read failed';
      return { secret: null, detail: `MEETING_BOT_AUTH_TOKEN_FILE is set but unreadable (${code})` };
    }
    const fromFile = contents.trim();
    if (fromFile.length < MIN_SECRET_LENGTH) {
      return {
        secret: null,
        detail: `secret in MEETING_BOT_AUTH_TOKEN_FILE is shorter than ${MIN_SECRET_LENGTH} characters`,
      };
    }
    return { secret: fromFile };
  }

  const inline = process.env.MEETING_BOT_AUTH_TOKEN?.trim();
  if (!inline) {
    return {
      secret: null,
      detail: 'neither MEETING_BOT_AUTH_TOKEN nor MEETING_BOT_AUTH_TOKEN_FILE is set',
    };
  }
  if (inline.length < MIN_SECRET_LENGTH) {
    return {
      secret: null,
      detail: `MEETING_BOT_AUTH_TOKEN is shorter than ${MIN_SECRET_LENGTH} characters`,
    };
  }
  return { secret: inline };
};

/**
 * Vertailu SHA-256-digestien kautta, jolloin se on sekä vakioaikainen että
 * kiinteämittainen — paljas timingSafeEqual vuotaisi yhä salaisuuden pituuden.
 */
const constantTimeEquals = (a: string, b: string): boolean => {
  const digest = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
};

/**
 * Jaettu tarkistus molemmille sisääntuloille (HTTP ja Redis-jono). Ottaa
 * esitetyn tokenin eikä pyyntöä, jotta jonokuluttaja voi käyttää samaa.
 */
export const verifyBearerToken = (presented: unknown): AuthResult => {
  const configured = resolveSecret();
  if (configured.secret === null) {
    return { ok: false, reason: 'unconfigured', detail: configured.detail };
  }

  if (typeof presented !== 'string' || presented.trim().length === 0) {
    return { ok: false, reason: 'missing', detail: 'no bearer token presented' };
  }

  if (!constantTimeEquals(presented.trim(), configured.secret)) {
    return { ok: false, reason: 'invalid', detail: 'bearer token does not match' };
  }

  return { ok: true };
};

/**
 * Lukee kutsujan esittämän tokenin. `Authorization: Bearer <token>` on ensisijainen;
 * runkokenttä hyväksytään koska se on upstreamin sopimus ja kutsujat lähettävät sen
 * jo. Rikkinäinen Authorization-header on hylkäys eikä syy katsoa runkoa — muuten
 * viallinen header laskisi hiljaa heikommalle polulle.
 */
const presentedToken = (req: Request): unknown => {
  const header = req.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
  }
  return (req.body as { bearerToken?: unknown } | undefined)?.bearerToken;
};

/**
 * Express-middleware. Mountataan jokaisen sellaisen reitin eteen joka käynnistää
 * selaimen, koskee jonoon tai kirjoittaa tallennustilaan — eli routerien eteen,
 * jotta yksikään käsittelijä ei ole tavoitettavissa portin ohi.
 */
export const requireBearerToken = (req: Request, res: Response, next: NextFunction) => {
  const result = verifyBearerToken(presentedToken(req));

  if (result.ok) {
    return next();
  }

  // Hylkäys ennen kuin mitään havaittavaa tapahtuu. Ei koskaan esitettyä tokenia lokiin.
  if (result.reason === 'unconfigured') {
    console.error(
      `[authGate] DENIED ${req.method} ${req.originalUrl} — auth gate is not configured: ${result.detail}`
    );
    return res.status(503).json({
      success: false,
      error: 'Meeting bot auth gate is not configured. Refusing all requests.',
    });
  }

  console.warn(
    `[authGate] DENIED ${req.method} ${req.originalUrl} from ${req.ip ?? 'unknown'} — ${result.reason}`
  );
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({
    success: false,
    error: 'Unauthorized: a valid bearer token is required.',
  });
};

/**
 * Lokitetaan kerran bootissa, jotta väärin konfiguroitu portti näkyy ennen
 * ensimmäistä pyyntöä eikä vasta sen jälkeen. Kertoo tilan — ei koskaan salaisuutta.
 */
export const logAuthGateState = (): void => {
  const configured = resolveSecret();
  if (configured.secret === null) {
    console.error(
      `[authGate] CLOSED — every join request will be refused with 503: ${configured.detail}`
    );
    return;
  }
  const source = process.env.MEETING_BOT_AUTH_TOKEN_FILE?.trim()
    ? 'MEETING_BOT_AUTH_TOKEN_FILE'
    : 'MEETING_BOT_AUTH_TOKEN';
  console.info(`[authGate] ARMED — bearer token required on all join routes (source: ${source})`);
};
