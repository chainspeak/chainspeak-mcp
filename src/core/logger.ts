import pino, { type Logger } from 'pino'

export const createLogger = (level: string): Logger => pino({ level }, pino.destination(2))

export const createWorkerLogger = (level: string): Logger =>
  pino({ level, browser: { asObject: true } })
