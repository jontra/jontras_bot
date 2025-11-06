import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { chatSettings, dailyDigestLog, submissions } from '../../db/schema'
import { secondsSinceMidnight } from './parser'
import type { WordleResult } from './types'

export class DatabaseNotConfiguredError extends Error {
    constructor() {
        super('DATABASE_URL is not configured. Wordle features are disabled.')
    }
}

export class DuplicateSubmissionError extends Error {
    constructor() {
        super('Submission already exists for this player and puzzle.')
    }
}

export async function saveSubmission(channelId: string, result: WordleResult): Promise<void> {
    const client = ensureDb()
    try {
        await client.insert(submissions).values({
            channelId,
            playerId: result.playerId,
            wordleDay: result.wordleDay,
            guesses: result.guesses,
            hardMode: result.hardMode,
            grid: result.grid,
            solvedAt: result.submittedAt,
        })
    } catch (error: unknown) {
        if (isUniqueViolation(error)) {
            throw new DuplicateSubmissionError()
        }
        throw error
    }
}

export async function getChannelSubmissions(channelId: string): Promise<WordleResult[]> {
    const client = ensureDb()
    const rows = await client
        .select()
        .from(submissions)
        .where(eq(submissions.channelId, channelId))
        .orderBy(submissions.wordleDay)

    return rows.map((row) => ({
        wordleDay: row.wordleDay,
        guesses: row.guesses,
        hardMode: row.hardMode,
        grid: row.grid,
        playerId: row.playerId,
        secondsSinceMidnight: row.solvedAt ? secondsSinceMidnight(new Date(row.solvedAt)) : 0,
        submittedAt: row.solvedAt ? new Date(row.solvedAt) : new Date(row.createdAt ?? Date.now()),
    }))
}

export async function upsertChatSettings(channelId: string) {
    const client = ensureDb()
    await client
        .insert(chatSettings)
        .values({ channelId })
        .onConflictDoNothing({ target: chatSettings.channelId })
}

export async function markPodiumSent(channelId: string, wordleDay: number) {
    const client = ensureDb()
    await client
        .insert(dailyDigestLog)
        .values({ channelId, wordleDay })
        .onConflictDoNothing({ target: [dailyDigestLog.channelId, dailyDigestLog.wordleDay] })
}

export async function hasPodiumBeenSent(channelId: string, wordleDay: number): Promise<boolean> {
    const client = ensureDb()
    const rows = await client
        .select()
        .from(dailyDigestLog)
        .where(and(eq(dailyDigestLog.channelId, channelId), eq(dailyDigestLog.wordleDay, wordleDay)))
        .limit(1)
    return rows.length > 0
}

function ensureDb() {
    if (!db) {
        throw new DatabaseNotConfiguredError()
    }
    return db
}

function isUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
        return false
    }
    const maybeError = error as { code?: string }
    return maybeError.code === '23505'
}
