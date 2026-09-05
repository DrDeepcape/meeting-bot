/**
 * Deepcape-fork: authGate-portin päätöstesti (#1789).
 *
 * Ajo:  npm run test:auth      (tai: npx ts-node scripts/test-auth-gate.ts)
 * Exit: 0 = kaikki vihreä, 1 = vähintään yksi punainen
 *
 * MIKSI TÄMÄ ON OLEMASSA: portti on invariantti joka ei saa hiljaa rikkoutua
 * upstream-mergessä. Repossa ei ole testiajuria (playwright.config.ts osoittaa
 * hakemistoon ./tests jota ei ole), joten tämä ajaa portin oikeaa express-pinoa
 * vasten omalla http-palvelimellaan — ei mockeja, ei stubattua middlewarea.
 *
 * MITÄ ASSERTOIDAAN: HTTP-status JA se, ajoiko suojattu käsittelijä. Pelkkä status
 * ei riitä — kortin vaatimus on "hylätään ENNEN mitään sivuvaikutusta", joten
 * jokainen hylkäystapaus tarkistaa myös että sivuvaikutuslaskuri ei liikkunut.
 */
import express, { Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { requireBearerToken } from '../src/middleware/authGate';
import messageBroker from '../src/connect/messageBroker';
import { globalJobStore } from '../src/lib/globalJobStore';
import { RedisConsumerService } from '../src/connect/RedisConsumerService';

const VALID_SECRET = 'a'.repeat(64); // 64 merkkiä, kuten `openssl rand -hex 32`
const WRONG_SECRET = 'b'.repeat(64);
const SHORT_SECRET = 'c'.repeat(31); // yksi alle MIN_SECRET_LENGTHin

// Sivuvaikutuslaskuri: kasvaa vain jos suojattu käsittelijä oikeasti ajoi.
let sideEffects = 0;

const app = express();
app.use(express.json());
app.post('/google/join', requireBearerToken, (_req: Request, res: Response) => {
  sideEffects += 1;
  res.status(202).json({ success: true });
});
app.get('/debug', requireBearerToken, (_req: Request, res: Response) => {
  sideEffects += 1;
  res.status(200).json({ success: true });
});

const server = http.createServer(app);

interface CallResult {
  status: number;
  authenticateHeader?: string;
}

const call = (
  method: 'GET' | 'POST',
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<CallResult> =>
  new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        res.resume(); // runko ei kiinnosta, mutta virta on kulutettava
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, authenticateHeader: res.headers['www-authenticate'] as string | undefined })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

let pass = 0;
let fail = 0;

const check = (name: string, actual: unknown, expected: unknown) => {
  if (actual === expected) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} — sai ${String(actual)}, odotettiin ${String(expected)}`);
  }
};

/** Ajaa yhden tapauksen ja tarkistaa sekä statuksen että sivuvaikutuksen. */
const expectCall = async (
  name: string,
  expectedStatus: number,
  expectSideEffect: boolean,
  method: 'GET' | 'POST',
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<CallResult> => {
  const before = sideEffects;
  const res = await call(method, urlPath, opts);
  check(`${name} → ${expectedStatus}`, res.status, expectedStatus);
  check(
    `${name} → sivuvaikutus ${expectSideEffect ? 'ajoi' : 'EI ajanut'}`,
    sideEffects - before,
    expectSideEffect ? 1 : 0
  );
  return res;
};

const clearSecretEnv = () => {
  delete process.env.MEETING_BOT_AUTH_TOKEN;
  delete process.env.MEETING_BOT_AUTH_TOKEN_FILE;
};

const main = async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log('authGate — päätöstestit\n');

  const validBody = {
    bearerToken: VALID_SECRET,
    url: 'https://meet.google.com/abc-defg-hij',
    name: 'Dr. Deepcape (tallentaa)',
    teamId: 't1',
    timezone: 'Europe/Helsinki',
    userId: 'u1',
    botId: 'b1',
  };

  console.log('== PORTTI KIINNI: konfiguraatio puuttuu tai on kelvoton (503) ==');
  clearSecretEnv();
  await expectCall('salaisuutta ei asetettu', 503, false, 'POST', '/google/join', { body: validBody });

  process.env.MEETING_BOT_AUTH_TOKEN = SHORT_SECRET;
  await expectCall('salaisuus alle 32 merkkiä', 503, false, 'POST', '/google/join', {
    body: { ...validBody, bearerToken: SHORT_SECRET },
  });

  clearSecretEnv();
  process.env.MEETING_BOT_AUTH_TOKEN_FILE = path.join(os.tmpdir(), 'mb-auth-does-not-exist-' + process.pid);
  await expectCall('salaisuustiedosto lukukelvoton', 503, false, 'POST', '/google/join', { body: validBody });

  // Fail-closed sen tärkein muoto: konfiguroitu mutta lukukelvoton tiedosto EI saa
  // pudota takaisin inline-muuttujaan, vaikka se olisi asetettu ja oikein.
  process.env.MEETING_BOT_AUTH_TOKEN = VALID_SECRET;
  await expectCall('lukukelvoton tiedosto EI palaa inline-arvoon', 503, false, 'POST', '/google/join', {
    body: validBody,
  });

  console.log('\n== PORTTI ARMED: kutsuja ei tunnistaudu (401) ==');
  clearSecretEnv();
  process.env.MEETING_BOT_AUTH_TOKEN = VALID_SECRET;

  await expectCall('ei tokenia lainkaan', 401, false, 'POST', '/google/join', {
    body: { ...validBody, bearerToken: undefined },
  });
  await expectCall('väärä token rungossa', 401, false, 'POST', '/google/join', {
    body: { ...validBody, bearerToken: WRONG_SECRET },
  });
  await expectCall('väärä token headerissa', 401, false, 'POST', '/google/join', {
    headers: { Authorization: `Bearer ${WRONG_SECRET}` },
    body: validBody,
  });
  await expectCall('tyhjä token', 401, false, 'POST', '/google/join', {
    body: { ...validBody, bearerToken: '   ' },
  });

  // Rikkinäinen header ei saa laskea heikommalle polulle: runko on oikein, mutta
  // Authorization on läsnä ja väärän muotoinen → hylkäys, ei fallbackia.
  await expectCall('rikkinäinen Authorization EI putoa runkoon', 401, false, 'POST', '/google/join', {
    headers: { Authorization: VALID_SECRET }, // puuttuu "Bearer "
    body: validBody,
  });

  const denied = await call('POST', '/google/join', { body: { ...validBody, bearerToken: WRONG_SECRET } });
  check('401 palauttaa WWW-Authenticate: Bearer', denied.authenticateHeader, 'Bearer');

  console.log('\n== PORTTI ARMED: kelvollinen token (läpi) ==');
  await expectCall('oikea token rungossa', 202, true, 'POST', '/google/join', { body: validBody });
  await expectCall('oikea token Authorization-headerissa', 202, true, 'POST', '/google/join', {
    headers: { Authorization: `Bearer ${VALID_SECRET}` },
    body: { ...validBody, bearerToken: undefined },
  });
  await expectCall('header voittaa rungon (oikea header, väärä runko)', 202, true, 'POST', '/google/join', {
    headers: { Authorization: `Bearer ${VALID_SECRET}` },
    body: { ...validBody, bearerToken: WRONG_SECRET },
  });

  console.log('\n== /debug on saman portin takana ==');
  await expectCall('/debug ilman tokenia', 401, false, 'GET', '/debug');
  await expectCall('/debug oikealla tokenilla', 200, true, 'GET', '/debug', {
    headers: { Authorization: `Bearer ${VALID_SECRET}` },
  });

  console.log('\n== Salaisuus tiedostosta ==');
  const secretPath = path.join(os.tmpdir(), `mb-auth-${process.pid}.token`);
  fs.writeFileSync(secretPath, `${VALID_SECRET}\n`); // rivinvaihto mukana: trim on osa sopimusta
  clearSecretEnv();
  process.env.MEETING_BOT_AUTH_TOKEN_FILE = secretPath;
  try {
    await expectCall('tiedostosta luettu token kelpaa', 202, true, 'POST', '/google/join', { body: validBody });
    await expectCall('tiedosto asetettu, väärä token', 401, false, 'POST', '/google/join', {
      body: { ...validBody, bearerToken: WRONG_SECRET },
    });

    // Kierrätys ilman uudelleenkäynnistystä: salaisuus luetaan joka pyynnöllä.
    fs.writeFileSync(secretPath, WRONG_SECRET);
    await expectCall('kierrätetty salaisuus astuu voimaan heti', 401, false, 'POST', '/google/join', {
      body: validBody,
    });
  } finally {
    fs.rmSync(secretPath, { force: true });
  }

  console.log('\n== Redis-jonopolku on saman portin takana (Osa 1b) ==');
  //
  // Jono on toinen sisääntulo samaan job storeen. Ajetaan oikeaa
  // RedisConsumerService.processMessage:a vasten; vain jonon reunat on korvattu
  // laskureilla, jotta nähdään kumpi haara ajoi.
  //
  // ONNISTUMISPOLKUA EI TESTATA TÄÄLLÄ TARKOITUKSELLA: kelvollinen token veisi
  // suoraan addJob:iin, uploaderiin ja oikeaan selaimeen. Se mitä tässä on
  // todistettava on hylkäys ja sen jonosemantiikka — ja että addJob EI ajanut.
  //
  // messageBroker on inertti kun REDIS_CONSUMER_ENABLED != 'true' (meetbot-klientti
  // jää nulliksi, ks. RedisMessageBroker:14), joten mitään Redis-yhteyttä ei avata.
  const spies = { ack: 0, returned: 0, addJob: 0 };
  const broker = messageBroker as unknown as {
    acknowledgeProcessingMeetingbotJob: (m: string) => Promise<number>;
    returnProcessingMeetingbotJob: (m: string) => Promise<number>;
  };
  broker.acknowledgeProcessingMeetingbotJob = async () => {
    spies.ack += 1;
    return 1;
  };
  broker.returnProcessingMeetingbotJob = async () => {
    spies.returned += 1;
    return 1;
  };
  const store = globalJobStore as unknown as {
    addJob: (...args: unknown[]) => Promise<{ accepted: boolean }>;
  };
  store.addJob = async () => {
    spies.addJob += 1;
    return { accepted: false };
  };

  const consumer = new RedisConsumerService();
  const processMessage = (
    consumer as unknown as { processMessage: (m: string) => Promise<void> }
  ).processMessage.bind(consumer);

  const queueJob = (token: unknown) =>
    JSON.stringify({ ...validBody, bearerToken: token, provider: 'google' });

  const expectQueue = async (
    name: string,
    token: unknown,
    expected: { ack: number; returned: number }
  ) => {
    spies.ack = 0;
    spies.returned = 0;
    spies.addJob = 0;
    await processMessage(queueJob(token));
    check(`${name} → addJob EI ajanut`, spies.addJob, 0);
    check(`${name} → ack ${expected.ack}`, spies.ack, expected.ack);
    check(`${name} → palautus pending-jonoon ${expected.returned}`, spies.returned, expected.returned);
  };

  clearSecretEnv();
  // Portti kiinni: palvelinvika, ei viallinen työ → viesti jää processing-jonoon
  // talteen. Ei ackia (ei hukata) eikä palautusta pending-jonoon (ei kuumaa silmukkaa).
  await expectQueue('jono, portti konfiguroimatta', VALID_SECRET, { ack: 0, returned: 0 });

  process.env.MEETING_BOT_AUTH_TOKEN = VALID_SECRET;
  // Myrkkyviesti: kuitataan pois jonosta, ei jää kiertämään.
  await expectQueue('jono, väärä token', WRONG_SECRET, { ack: 1, returned: 0 });
  await expectQueue('jono, token puuttuu', undefined, { ack: 1, returned: 0 });
  await expectQueue('jono, token ei ole merkkijono', { evil: true }, { ack: 1, returned: 0 });

  console.log('\n----------------------------------------');
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (fail > 0) {
    console.log('PUNAISIA — portti ei ole siinä kunnossa kuin #1789 vaatii.');
    process.exit(1);
  }
  console.log('Kaikki vihreä.');
};

main().catch((err) => {
  console.error('Testiajo kaatui:', err);
  process.exit(1);
});
