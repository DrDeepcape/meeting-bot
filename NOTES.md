# Deepcape-forkin muistiinpanot

Tämä on Deepcapen fork repolle [`screenappai/meeting-bot`](https://github.com/screenappai/meeting-bot).
Forkin tarkoitus: Dr. Deepcape liittyy Deepcape-kontekstin Google Meet -kokouksiin,
tallentaa ne ja tuottaa suomenkielisen muistion omalla raudalla.

Suunnitelma ja backlog: `deepcape-meta` → `knowledge-bank/design/design-2026-08-26-meeting-bot-*`
plan-id: `design-2026-08-26-meeting-bot-google-meet-muistioputki`

## Lisenssikuittaus (MB-02)

Kuitattu 25.8.2026, varmennettu koneellisesti 26.8.2026.

- **Lisenssi:** MIT (SPDX: `MIT`), `LICENSE` upstreamin juuressa.
- **Ei per-tiedosto-poikkeuksia.** Varmennettu `gh api repos/screenappai/meeting-bot`
  → `license.spdx_id = MIT`, repo public, default branch `main`.
- MIT sallii forkin, muokkauksen ja yksityisen käytön. Ehto on
  copyright-ilmoituksen ja lisenssitekstin säilyttäminen — `LICENSE` säilyy
  tässä forkissa muuttumattomana.

## Forkin rajaus — lue tämä ennen kuin muutat mitään

**Forkin sisäiset muutokset pidetään minimissä.** Vain se, mitä arm64-ajo ja
ScreenApp-backendin irrotus vaativat:

1. `docker-compose.yml`: `platform: linux/amd64` pois, `chrome-cdp`-sidecar pois
2. `src/services/botService.ts`: ScreenApp-statuskutsut no-opeiksi

**Kaikki Deepcape-äly on bridgen ja runnerin puolella** (`deepcape-portal`), ei täällä.
Syy: upstream-synkan on pysyttävä halpana. Jokainen forkkiin lisätty rivi on rivi,
joka konfliktoi seuraavassa upstream-mergessä.

Jos olet lisäämässä ominaisuutta tähän repoon — älä. Se kuuluu bridgeen.

## Repokuri

- **Ruleset `dc-main-pr-only`** (aktiivinen): main vaatii PR:n, ei force-pushia,
  ei branchin poistoa. Sama konventio kuin kuudessa sisarrepossa
  (`dc-mail-mcp`, `dc-personal-health-ops`, `dc-personal-health-phone`,
  `deepcape-meta`, `deepcape-portal`, `DeepcapePhone`).
- **Omistaja:** `DrDeepcape` (käyttäjätili). Deepcape-organisaatiota ei ole
  olemassa — koko Deepcape-jalanjälki on käyttäjätileillä. Tämä on tiedostettu:
  ks. MB-02:n avoin kohta alla.

## Avoin kohta — forkin koti (kynnyspäätös)

Backlog sanoi "fork → Deepcape-org". **Sellaista orgia ei ole** (`GET orgs/Deepcape`
→ 404, `search/users?q=deepcape+type:org` → 0 osumaa). Fork tehtiin nykyisen
konvention mukaisesti `DrDeepcape`-tilin alle, eli tämä on "7. repo".

Vaihtoehto B — oikean Deepcape-orgin perustaminen ja repojen siirto sinne — on
isompi päätös, joka koskisi myös kuutta nykyistä repoa. Se on yhä auki ja
tehtävissä myöhemmin: forkin voi siirtää orgiin omistajuutta vaihtamalla.
