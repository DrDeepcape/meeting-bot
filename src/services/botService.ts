/**
 * Deepcape-fork: ScreenApp-backendin statuskutsut on stubattu no-opeiksi.
 *
 * Upstream lähettää botin tilan ja lokit ScreenAppin backendiin
 * (`PATCH /meeting/app/bot/status` ja `/meeting/app/bot/log`). Deepcapen
 * asennuksessa sitä backendiä ei ole: `AUTH_BASE_URL_V2` osoittaa olemattomaan
 * porttiin, jolloin jokainen kutsu tuottaisi verkkovirheen ja `logger.error`-
 * rivin. Tallennus toimisi silti, mutta lokit täyttyisivät virheistä joita
 * kukaan ei voi korjata — ja aito vika hukkuisi kohinaan.
 *
 * Siksi kutsut eivät lähde lainkaan. Signatuurit, tyypit ja paluuarvot
 * pidetään ennallaan, joten yksikään kutsupaikka ei muutu ja upstream-synkka
 * pysyy halpana.
 *
 * Botin tila on Deepcapella näkyvissä bridgen kautta (webhook + portal), ei
 * tämän rajapinnan kautta.
 *
 * Ks. deepcape-meta: knowledge-bank/design/design-2026-08-26-meeting-bot-* (MB-03)
 */
import { BotStatus, LogCategory, LogSubCategory } from '../types';
import { Logger } from 'winston';

export const patchBotStatus = async ({
  eventId,
  botId,
  provider,
  status,
}: {
    eventId?: string,
    token: string,
    botId?: string,
    provider: 'google' | 'microsoft' | 'zoom',
    status: BotStatus[],
}, logger: Logger): Promise<boolean> => {
  // No-op: ScreenApp-backendiä ei ole. Kirjataan debug-tasolle, ei error-tasolle.
  logger.debug('patchBotStatus no-op (Deepcape-fork)', { eventId, botId, provider, status });
  return true;
};

export const addBotLog = async ({
  eventId,
  botId,
  provider,
  level,
  message,
  category,
  subCategory,
}: {
    eventId?: string,
    token: string,
    botId?: string,
    provider: 'google' | 'microsoft' | 'zoom',
    level: 'info' | 'error',
    message: string,
    category: LogCategory,
    subCategory: LogSubCategory<LogCategory>,
}, logger: Logger): Promise<boolean> => {
  // No-op: ks. yllä. Botin oma winston-loki säilyttää viestin paikallisesti.
  logger.debug('addBotLog no-op (Deepcape-fork)', { eventId, botId, provider, level, message, category, subCategory });
  return true;
};
