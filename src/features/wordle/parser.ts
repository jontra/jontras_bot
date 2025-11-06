import { WordleResult } from './types'

const WORDLE_REGEX = /^[\s\S]*Wordle[\s]+(\d+)[\s]+(X|\d)\/6(\*?)([\s\S]*)/i
const FIRST_WORDLE_DATE_UTC = Date.UTC(2021, 5, 20, 0, 0, 0) // June 20 2021

const SECONDS_IN_DAY = 24 * 60 * 60

export function getWordleDay(reference: Date = new Date()): number {
    const diffMs = reference.getTime() - FIRST_WORDLE_DATE_UTC
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    return diffDays + 1
}

export function secondsSinceMidnight(date: Date): number {
    return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()
}

export function parseWordleResult(message: string, playerId: string, submittedAt: Date = new Date()): WordleResult | null {
    const sanitized = message.replace(/,/g, '')
    const match = sanitized.match(WORDLE_REGEX)

    if (!match) {
        return null
    }

    const wordleDay = Number.parseInt(match[1], 10)
    if (Number.isNaN(wordleDay)) {
        return null
    }

    const guessesRaw = match[2]
    const guesses = guessesRaw === 'X' ? -1 : Number.parseInt(guessesRaw, 10)
    const hardMode = match[3] === '*'
    const grid = match[4].trim()

    const result: WordleResult = {
        wordleDay,
        guesses,
        hardMode,
        grid,
        playerId,
        secondsSinceMidnight: secondsSinceMidnight(submittedAt),
        submittedAt,
    }

    return isValidResult(result) ? result : null
}

export function isValidResult(result: WordleResult): boolean {
    if (result.guesses < -1 || result.guesses > 6) {
        return false
    }

    const expectedRows = result.guesses === -1 ? 6 : result.guesses
    const rows = result.grid.split('\n').filter((line) => line.trim().length > 0)

    if (rows.length !== expectedRows) {
        return false
    }

    if (!result.playerId) {
        return false
    }

    return true
}

export function clampWordleDay(wordleDay: number, tolerance = 1, reference: Date = new Date()): boolean {
    const today = getWordleDay(reference)
    return Math.abs(wordleDay - today) <= tolerance
}

export function normalizeWordleDay(wordleDay: number): number {
    if (Number.isNaN(wordleDay) || !Number.isFinite(wordleDay)) {
        throw new Error('Invalid Wordle day value')
    }
    return Math.max(1, Math.floor(wordleDay))
}

export function positiveGuesses(guesses: number): number {
    return guesses === -1 ? 6 : guesses
}

export function isSuccessful(guesses: number): boolean {
    return guesses !== -1
}

export function getSecondsFromGuessDistribution(result: WordleResult): number {
    return Math.min(result.secondsSinceMidnight, SECONDS_IN_DAY - 1)
}
